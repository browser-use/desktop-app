"""
events.py — Push-to-socket event emission for the agent daemon.

The daemon holds an open asyncio writer to the connected Electron main process.
`EventEmitter` wraps that writer and serializes protocol events as JSON lines.

Thread safety: emit() is synchronous and uses loop.call_soon_threadsafe so it
can be called from background threads (e.g. the agent loop running in a thread
pool executor).
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable

from .logger import log
from .protocol import encode_message

# Type alias for the low-level write callable
WriteCallable = Callable[[bytes], None]


class EventEmitter:
    """
    Serializes and pushes event dicts to the connected socket writer.

    In async contexts, call `emit()` directly.
    In sync/thread contexts, call `emit_threadsafe()` with the running loop.
    """

    def __init__(self, writer: asyncio.StreamWriter | None = None):
        self._writer = writer
        self._history: list[dict] = []  # ordered event log for tests/debugging

    def set_writer(self, writer: asyncio.StreamWriter) -> None:
        self._writer = writer

    # ── Core emission ─────────────────────────────────────────────────────────

    async def emit(self, event: dict) -> None:
        """Serialize `event` and write to the socket. No-op if no writer."""
        self._history.append(event)
        event_type = event.get("event", "unknown")
        task_id = event.get("task_id", "")
        log.info("EventEmitter.emit", event_type=event_type, task_id=task_id)

        if self._writer is None:
            log.debug(
                "EventEmitter.emit",
                note="no writer — event buffered in history only",
                event_type=event_type,
            )
            return

        data = encode_message(event)
        try:
            self._writer.write(data)
            await self._writer.drain()
        except (ConnectionResetError, BrokenPipeError, OSError) as exc:
            log.warn(
                "EventEmitter.emit",
                note="write failed — event dropped",
                error=str(exc),
                event_type=event_type,
            )

    def emit_threadsafe(self, event: dict, loop: asyncio.AbstractEventLoop) -> None:
        """Schedule emit() from a non-async thread."""
        asyncio.run_coroutine_threadsafe(self.emit(event), loop)

    # ── History access (for tests) ────────────────────────────────────────────

    @property
    def history(self) -> list[dict]:
        """Ordered list of all events emitted so far."""
        return list(self._history)

    def clear_history(self) -> None:
        self._history.clear()

    def events_of_type(self, event_type: str) -> list[dict]:
        return [e for e in self._history if e.get("event") == event_type]


class SyncEventEmitter:
    """
    Synchronous wrapper used by the agent loop when running in a thread.

    Accepts a thread-safe emit function injected at construction.
    The loop.py passes a lambda that calls emit_threadsafe() on the async emitter.
    """

    def __init__(self, emit_fn: Callable[[dict], None]):
        self._emit_fn = emit_fn
        self._history: list[dict] = []
        self._emit_times: list[float] = []

    def emit(self, event: dict) -> None:
        """Emit an event synchronously (from a worker thread)."""
        self._history.append(event)
        self._emit_times.append(time.monotonic())
        self._emit_fn(event)

    @property
    def history(self) -> list[dict]:
        return list(self._history)

    def events_of_type(self, event_type: str) -> list[dict]:
        return [e for e in self._history if e.get("event") == event_type]

    def get_emit_times(self) -> list[float]:
        return list(self._emit_times)
