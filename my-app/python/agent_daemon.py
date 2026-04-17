"""
agent_daemon.py — Agent daemon extending harnessless.

Extends the harnessless Unix socket relay with an `agent_task` meta-operation.
The daemon listens on a Unix socket, dispatches CDP browser operations, and
also handles agent task requests by running the AgentLoop in a thread pool.

Socket path: $DAEMON_SOCKET_PATH env var (default /tmp/agent-daemon.sock)
Protocol: JSON-line messages, one per line

Handled meta operations:
    {meta: "ping"}                                  → {ok: true, result: {pong: true}}
    {meta: "shutdown"}                              → {ok: true} then closes
    {meta: "set_active_target", per_target_cdp_url} → {ok: true}
    {meta: "agent_task", prompt, per_target_cdp_url, task_id} → {ok: true, result: {task_id}}
    {meta: "cancel_task", task_id}                  → {ok: true} or {ok: false, error}

Events are pushed async over the same socket connection as JSON lines.
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Optional

from agent.protocol import (
    PROTOCOL_VERSION,
    ERR_PARSE_ERROR,
    ERR_UNKNOWN_META,
    ERR_TASK_RUNNING,
    ERR_TASK_NOT_FOUND,
    ERR_INTERNAL,
    ok_response,
    error_response,
    parse_request,
    encode_message,
)
from agent.events import EventEmitter
from agent.loop import run_task
from agent.llm import LLMClient
from agent.budget import Budget
from agent.telemetry import record_daemon_startup

import time as _time

# ── Constants ─────────────────────────────────────────────────────────────────

DEFAULT_SOCKET_PATH = "/tmp/agent-daemon.sock"
SOCKET_ENV_VAR = "DAEMON_SOCKET_PATH"
MAX_WORKER_THREADS = 4
RECV_BUFFER_SIZE = 65536

logger = logging.getLogger("agent_daemon")


# ── Task registry ─────────────────────────────────────────────────────────────

class TaskRegistry:
    """Thread-safe registry of active agent tasks and their cancel flags."""

    def __init__(self):
        self._lock = threading.Lock()
        self._tasks: dict[str, threading.Event] = {}  # task_id → cancel_flag

    def register(self, task_id: str) -> threading.Event:
        """Register a new task and return its cancel flag."""
        cancel_flag = threading.Event()
        with self._lock:
            self._tasks[task_id] = cancel_flag
        logger.info("[registry] registered task_id=%s", task_id)
        return cancel_flag

    def cancel(self, task_id: str) -> bool:
        """Set the cancel flag for a task. Returns True if task was found."""
        with self._lock:
            flag = self._tasks.get(task_id)
        if flag is None:
            logger.warning("[registry] cancel: task_id=%s not found", task_id)
            return False
        flag.set()
        logger.info("[registry] cancelled task_id=%s", task_id)
        return True

    def unregister(self, task_id: str) -> None:
        """Remove a completed task from the registry."""
        with self._lock:
            self._tasks.pop(task_id, None)
        logger.debug("[registry] unregistered task_id=%s", task_id)

    def is_active(self, task_id: str) -> bool:
        with self._lock:
            return task_id in self._tasks

    @property
    def active_count(self) -> int:
        with self._lock:
            return len(self._tasks)


# ── Agent Daemon ──────────────────────────────────────────────────────────────

class AgentDaemon:
    """
    Async Unix socket daemon that dispatches agent tasks to worker threads.

    Architecture:
    - asyncio event loop handles socket I/O (one coroutine per connection)
    - Agent tasks run in a ThreadPoolExecutor (blocking LLM + sandbox calls)
    - Events are pushed back to the socket via loop.call_soon_threadsafe
    """

    def __init__(
        self,
        socket_path: Optional[str] = None,
        max_workers: int = MAX_WORKER_THREADS,
    ):
        self.socket_path = socket_path or os.environ.get(SOCKET_ENV_VAR, DEFAULT_SOCKET_PATH)
        self._executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="agent-task")
        self._registry = TaskRegistry()
        self._active_target_url: Optional[str] = None
        # NOTE: _shutdown_event is created inside start() (inside the running
        # asyncio loop) to avoid the "Future attached to a different loop" error
        # that occurs in Python 3.9 when asyncio.Event() is called before
        # asyncio.run() creates its event loop.
        self._shutdown_event: Optional[asyncio.Event] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._emitter = EventEmitter()  # shared for tests; per-connection in production

    async def start(self) -> None:
        """Start the daemon and serve until shutdown."""
        _startup_start = _time.monotonic()
        self._loop = asyncio.get_running_loop()
        # Create shutdown event here, inside the running loop, to avoid the
        # Python 3.9 "Future attached to a different loop" error.
        self._shutdown_event = asyncio.Event()

        # Remove stale socket file
        if os.path.exists(self.socket_path):
            os.unlink(self.socket_path)
            logger.debug("[daemon] removed stale socket at %s", self.socket_path)

        server = await asyncio.start_unix_server(
            self._handle_connection,
            path=self.socket_path,
        )

        startup_ms = int((_time.monotonic() - _startup_start) * 1000)
        record_daemon_startup(startup_ms)
        logger.info(
            "[daemon] listening on %s (protocol=%s startup_ms=%d)",
            self.socket_path,
            PROTOCOL_VERSION,
            startup_ms,
        )

        async with server:
            await self._shutdown_event.wait()

        logger.info("[daemon] shutdown complete")
        self._executor.shutdown(wait=False)

        if os.path.exists(self.socket_path):
            os.unlink(self.socket_path)

    async def _handle_connection(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        """Handle one client connection (Electron main process)."""
        peer = writer.get_extra_info("peername", "<unknown>")
        logger.info("[daemon] new connection from %s", peer)

        # Per-connection emitter
        conn_emitter = EventEmitter(writer)

        try:
            while True:
                try:
                    line = await reader.readline()
                except (ConnectionResetError, asyncio.IncompleteReadError):
                    logger.info("[daemon] connection closed by client")
                    break

                if not line:
                    logger.info("[daemon] EOF from client")
                    break

                line = line.strip()
                if not line:
                    continue

                response = await self._dispatch(line, conn_emitter, writer)
                if response is not None:
                    data = encode_message(response)
                    writer.write(data)
                    await writer.drain()

        except Exception as exc:
            logger.exception("[daemon] connection error: %s", exc)
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass
            logger.info("[daemon] connection closed")

    async def _dispatch(
        self,
        raw: bytes,
        emitter: EventEmitter,
        writer: asyncio.StreamWriter,
    ) -> Optional[dict]:
        """
        Dispatch a raw request line and return the response dict.

        Returns None only for shutdown (connection will close).
        """
        # Extract _seq before parse_request so we can echo it back for
        # request/response correlation in the Electron DaemonClient.
        seq: Optional[int] = None
        try:
            import json as _json
            _raw_str = raw.decode("utf-8") if isinstance(raw, bytes) else raw
            _raw_parsed = _json.loads(_raw_str.strip())
            if isinstance(_raw_parsed, dict):
                _seq_val = _raw_parsed.get("_seq")
                if isinstance(_seq_val, int):
                    seq = _seq_val
        except Exception:
            pass

        def _with_seq(resp: dict) -> dict:
            """Attach _seq to response so DaemonClient can correlate it."""
            if seq is not None:
                resp = {**resp, "_seq": seq}
            return resp

        try:
            msg = parse_request(raw)
        except Exception as exc:
            logger.warning("[daemon] parse error: %s", exc)
            return _with_seq(error_response(ERR_PARSE_ERROR, str(exc)))

        meta = msg.get("meta", "")
        logger.debug("[daemon] dispatch meta=%s", meta)

        if meta == "ping":
            return _with_seq(ok_response({"pong": True, "version": PROTOCOL_VERSION}))

        elif meta == "shutdown":
            logger.info("[daemon] shutdown requested")
            self._shutdown_event.set()
            return _with_seq(ok_response())

        elif meta == "set_active_target":
            url = msg.get("per_target_cdp_url", "")
            if not url:
                return _with_seq(error_response(ERR_PARSE_ERROR, "per_target_cdp_url is required"))
            self._active_target_url = url
            logger.info("[daemon] active target set to %s", url)
            return _with_seq(ok_response())

        elif meta == "agent_task":
            result = await self._handle_agent_task(msg, emitter)
            return _with_seq(result)

        elif meta == "cancel_task":
            result = self._handle_cancel_task(msg)
            return _with_seq(result)

        else:
            return _with_seq(error_response(ERR_UNKNOWN_META, f"Unknown meta operation: {meta!r}"))

    async def _handle_agent_task(
        self,
        msg: dict,
        emitter: EventEmitter,
    ) -> dict:
        """Start an agent task in the thread pool."""
        task_id = msg.get("task_id", "")
        prompt = msg.get("prompt", "")
        per_target_cdp_url = msg.get("per_target_cdp_url", "") or self._active_target_url or ""

        if not task_id:
            return error_response(ERR_PARSE_ERROR, "task_id is required")
        if not prompt:
            return error_response(ERR_PARSE_ERROR, "prompt is required")
        if not per_target_cdp_url:
            return error_response(ERR_PARSE_ERROR, "per_target_cdp_url is required (or set_active_target first)")

        if self._registry.is_active(task_id):
            return error_response(ERR_TASK_RUNNING, f"Task {task_id!r} is already running", retryable=False)

        cancel_flag = self._registry.register(task_id)
        loop = asyncio.get_running_loop()

        # Thread-safe emit: schedule emit() coroutine from the worker thread
        def emit_threadsafe(event: dict) -> None:
            asyncio.run_coroutine_threadsafe(emitter.emit(event), loop)

        logger.info(
            "[daemon] starting agent_task task_id=%s prompt=%r cdp_url=%s",
            task_id,
            prompt[:80],
            per_target_cdp_url,
        )

        # Lazily import harnessless helpers
        helpers_module = self._get_helpers_module(per_target_cdp_url)
        llm_client = LLMClient()
        budget = Budget()

        def _task_wrapper():
            try:
                run_task(
                    prompt=prompt,
                    per_target_cdp_url=per_target_cdp_url,
                    task_id=task_id,
                    emit_event=emit_threadsafe,
                    helpers_module=helpers_module,
                    llm_client=llm_client,
                    budget=budget,
                    cancel_flag=cancel_flag,
                )
            finally:
                self._registry.unregister(task_id)
                logger.info("[daemon] task_id=%s finished, unregistered", task_id)

        self._executor.submit(_task_wrapper)
        return ok_response({"task_id": task_id, "status": "started"})

    def _handle_cancel_task(self, msg: dict) -> dict:
        """Cancel a running task."""
        task_id = msg.get("task_id", "")
        if not task_id:
            return error_response(ERR_PARSE_ERROR, "task_id is required")

        if not self._registry.is_active(task_id):
            return error_response(ERR_TASK_NOT_FOUND, f"Task {task_id!r} not found", retryable=False)

        self._registry.cancel(task_id)
        return ok_response({"task_id": task_id, "status": "cancelling"})

    def _get_helpers_module(self, per_target_cdp_url: str) -> Any:
        """
        Return the harnessless helpers module configured for the given target.

        The per-target CDP URL is injected via environment variable so helpers.py
        connects to exactly the right page — active-tab enforcement at transport.
        """
        try:
            # Set the CDP URL env var that harnessless helpers reads
            os.environ["CDP_WS_URL"] = per_target_cdp_url
            import harnessless.helpers as _helpers  # noqa: PLC0415
            logger.debug("[daemon] loaded harnessless.helpers for %s", per_target_cdp_url)
            return _helpers
        except ImportError:
            logger.warning(
                "[daemon] harnessless.helpers not available, using stub for task. "
                "Install harnessless or check PYTHONPATH."
            )
            return _StubHelpers(per_target_cdp_url)


# ── Stub helpers (fallback when harnessless not installed) ────────────────────

class _StubHelpers:
    """
    Minimal stub for the helpers module when harnessless is not installed.
    Used in testing and when the full CDP stack is unavailable.
    """

    def __init__(self, cdp_url: str = ""):
        self._cdp_url = cdp_url

    def page_info(self) -> dict:
        return {"url": self._cdp_url, "title": "stub", "stub": True}

    def goto(self, url: str) -> None:
        logger.debug("[stub] goto: %s", url)

    def click(self, selector: str) -> None:
        logger.debug("[stub] click: %s", selector)

    def type_text(self, selector: str, text: str) -> None:
        logger.debug("[stub] type_text: %s %r", selector, text)

    def screenshot(self) -> str:
        return ""

    def js(self, script: str) -> Any:
        logger.debug("[stub] js: %s", script[:80])
        return None


# ── Entry point ───────────────────────────────────────────────────────────────

def _setup_logging() -> None:
    """Configure structured logging."""
    log_level = os.environ.get("LOG_LEVEL", "INFO").upper()
    logging.basicConfig(
        level=getattr(logging, log_level, logging.INFO),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        stream=sys.stderr,
    )


def main() -> None:
    _setup_logging()
    logger.info(
        "[daemon] starting agent_daemon (protocol=%s pid=%d)",
        PROTOCOL_VERSION,
        os.getpid(),
    )

    daemon = AgentDaemon()

    # Graceful shutdown on SIGTERM/SIGINT
    def _handle_signal(sig, _frame):
        logger.info("[daemon] received signal %s, initiating shutdown", sig)
        if daemon._loop and daemon._shutdown_event:
            daemon._loop.call_soon_threadsafe(daemon._shutdown_event.set)

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    try:
        asyncio.run(daemon.start())
    except KeyboardInterrupt:
        logger.info("[daemon] KeyboardInterrupt — exiting")


if __name__ == "__main__":
    main()
