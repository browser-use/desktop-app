"""
safe_exec_subprocess.py — Subprocess-based sandbox executor.

Replaces the threading.Event approach in ExecSandbox.run() to fix H2 (thread
zombie DoS).  The user code runs in a child multiprocessing.Process (fork
context) that can be hard-killed on timeout, guaranteeing no orphaned threads.

Why fork context:
    The 'spawn' default on macOS requires pickling all args.  Code objects,
    lambda functions, and module references in the exec namespace are not
    picklable.  fork() copies the parent's address space without serialisation,
    avoids this entirely, and is the correct approach for a short-lived
    sandboxed execution child.

Security additions:
- H2: p.kill() + p.join(1) on timeout — child process is fully terminated
- M1: resource.setrlimit(RLIMIT_AS, ...) applied inside child before exec()
      Default cap: 512 MB (configurable via SANDBOX_MEMORY_BYTES env var)

Usage (internal — called by ExecSandbox.run):
    from .safe_exec_subprocess import run_in_subprocess
    result = run_in_subprocess(source, namespace, timeout_s, max_bytes)
"""

from __future__ import annotations

import multiprocessing
import os
import resource
from typing import Any

from .logger import log

# ── Constants ──────────────────────────────────────────────────────────────────

# Default memory cap per sandboxed execution: 512 MB
_DEFAULT_MEMORY_BYTES = int(os.getenv("SANDBOX_MEMORY_BYTES", str(512 * 1024 * 1024)))

# Keys used in the result queue payload
_RESULT_KEY = "__result__"
_ERROR_KEY = "__error__"
_ERROR_TYPE_KEY = "__error_type__"


# ── Subprocess entry point ─────────────────────────────────────────────────────


def _subprocess_entry(
    source: str,
    namespace: dict,
    result_queue: Any,  # multiprocessing.Queue — inherited via fork
    max_bytes: int,
) -> None:
    """
    Entry point executed inside the forked child process.

    1. Apply memory limit via resource.setrlimit (M1).
    2. Compile and exec() the source in the provided namespace.
    3. Push result or exception into result_queue.

    NOTE: This is called after fork(), so all parent state is already
    available.  We only need to pass primitive types that survive fork
    (source string, max_bytes int).  The namespace and queue are
    inherited directly via the forked address space.
    """
    # M1: cap virtual address space so unbounded allocation is killed rather
    # than OOM-ing the parent.  RLIMIT_AS limits virtual memory (mmap + heap).
    try:
        resource.setrlimit(resource.RLIMIT_AS, (max_bytes, max_bytes))
        log.debug(
            "safe_exec_subprocess._subprocess_entry",
            note="memory_limit_set",
            max_bytes=max_bytes,
        )
    except (OSError, ValueError) as exc:
        # Non-fatal: log and continue — limit may already be lower
        log.warn(
            "safe_exec_subprocess._subprocess_entry",
            note="rlimit_set_failed",
            error=str(exc),
        )

    try:
        compiled = compile(source, "<agent_code>", "exec")
        exec(compiled, namespace)  # noqa: S102
        result = namespace.get(_RESULT_KEY)
        log.debug(
            "safe_exec_subprocess._subprocess_entry.complete",
            result_type=type(result).__name__,
        )
        # Validate JSON-serializability BEFORE trying to queue the result.
        # queue.put() uses pickle internally; a lambda or function object will
        # silently fail in the feeder thread and the parent would see an empty
        # queue.  We catch that here and convert it to an explicit error payload
        # (which is always picklable) so the parent always receives a payload.
        import json as _json  # noqa: PLC0415

        if result is not None:
            try:
                _json.dumps(result)
            except (TypeError, ValueError) as json_exc:
                log.debug(
                    "safe_exec_subprocess._subprocess_entry.non_serializable",
                    error=str(json_exc),
                    result_type=type(result).__name__,
                )
                serialization_err = ValueError(
                    f"Sandbox result is not JSON-serializable: {json_exc}"
                )
                result_queue.put(
                    {
                        _ERROR_KEY: str(serialization_err),
                        _ERROR_TYPE_KEY: "ValueError",
                        "__exc__": serialization_err,
                    }
                )
                result_queue.close()
                result_queue.join_thread()
                return
        result_queue.put({_RESULT_KEY: result})
        result_queue.close()
        result_queue.join_thread()
    except Exception as exc:  # noqa: BLE001
        log.debug(
            "safe_exec_subprocess._subprocess_entry.error",
            error_type=type(exc).__name__,
            error=str(exc),
        )
        # Try to put the original exception; if it too is unpicklable,
        # fall back to a plain RuntimeError with just the message.
        try:
            result_queue.put(
                {
                    _ERROR_KEY: str(exc),
                    _ERROR_TYPE_KEY: type(exc).__name__,
                    # Preserve the original exception object for re-raise in parent
                    "__exc__": exc,
                }
            )
        except Exception:  # noqa: BLE001
            result_queue.put(
                {
                    _ERROR_KEY: str(exc),
                    _ERROR_TYPE_KEY: type(exc).__name__,
                }
            )
        result_queue.close()
        result_queue.join_thread()


# ── Public entry point ────────────────────────────────────────────────────────


def run_in_subprocess(
    source: str,
    namespace: dict,
    timeout_s: int,
    max_bytes: int = _DEFAULT_MEMORY_BYTES,
) -> Any:
    """
    Execute source in a forked child process with timeout and memory cap.

    Uses the 'fork' multiprocessing context so that the namespace (containing
    lambda functions, module references, helper objects) does not need to be
    pickled — the child inherits the parent's address space directly.

    Args:
        source: Dedented, AST-validated Python source string.
        namespace: The restricted exec namespace (safe builtins + helpers).
        timeout_s: Wall-clock timeout in seconds. Child is killed if exceeded.
        max_bytes: Virtual memory cap for the child process (default 512 MB).

    Returns:
        The value bound to '__result__' in namespace after exec, or None.

    Raises:
        ExecTimeout: Child did not finish within timeout_s.
        Exception:   Any exception raised by the sandboxed code.
    """
    # Import here to avoid circular import; ExecTimeout lives in exec_sandbox
    from .exec_sandbox import ExecTimeout  # noqa: PLC0415

    # Use fork context: child inherits parent memory without pickling.
    # fork is available on Linux and macOS; safe for short-lived exec children.
    ctx = multiprocessing.get_context("fork")
    result_queue: Any = ctx.Queue()

    log.debug(
        "safe_exec_subprocess.run_in_subprocess",
        note="starting_child",
        timeout_s=timeout_s,
        max_bytes=max_bytes,
        source_chars=len(source),
    )

    p = ctx.Process(
        target=_subprocess_entry,
        args=(source, namespace, result_queue, max_bytes),
        daemon=True,
    )
    p.start()
    log.debug(
        "safe_exec_subprocess.run_in_subprocess",
        note="child_started",
        pid=p.pid,
    )

    p.join(timeout_s)

    if p.is_alive():
        # H2: Hard-kill the process — no thread zombie can survive a SIGKILL
        log.warn(
            "safe_exec_subprocess.run_in_subprocess",
            note="timeout_kill",
            pid=p.pid,
            timeout_s=timeout_s,
        )
        p.kill()
        p.join(1)  # Give OS 1s to reap the process
        log.debug(
            "safe_exec_subprocess.run_in_subprocess",
            note="child_killed",
            pid=p.pid,
            still_alive=p.is_alive(),
        )
        raise ExecTimeout(f"Code execution timed out after {timeout_s}s")

    log.debug(
        "safe_exec_subprocess.run_in_subprocess",
        note="child_finished",
        pid=p.pid,
        exitcode=p.exitcode,
    )

    # Child exited — retrieve result from the queue.
    # The child calls result_queue.close() + join_thread() before exiting to
    # guarantee the feeder thread has flushed all data.  Use a short get()
    # timeout (1s) as a safety net against unexpected child crashes that skip
    # the close/join_thread path (e.g. SIGKILL from OOM).
    import queue as _queue_mod  # noqa: PLC0415

    try:
        payload = result_queue.get(timeout=1)
    except _queue_mod.Empty as exc:
        # Child exited without sending any payload — crashed before queuing
        raise RuntimeError(
            f"Sandbox subprocess exited with code {p.exitcode} without returning a result"
        ) from exc

    if _ERROR_KEY in payload:
        # Re-raise the original exception from the subprocess
        original_exc = payload.get("__exc__")
        if original_exc is not None:
            raise original_exc
        raise RuntimeError(payload[_ERROR_KEY])

    return payload.get(_RESULT_KEY)
