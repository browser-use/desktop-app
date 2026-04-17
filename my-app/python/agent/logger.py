"""
logger.py — D2-compliant structured logger for the agent package.

DEV mode: NODE_ENV != "production" OR AGENTIC_DEV == "1"

- debug() and info() are no-ops unless DEV is True
- warn() and error() always emit (production-safe)
- Emits JSONL to stderr (or a configurable stream)
- Auto-scrubs keys matching the SECRET_KEYS pattern before emitting

Usage:
    from agent.logger import log

    log.debug("AgentLoop.run", task_id=task_id, step=step)
    log.info("LLMClient.chat", model=model, messages=len(messages))
    log.warn("Budget.check", reason="token_budget_exhausted", tokens_used=n)
    log.error("ExecSandbox.run", error=str(e), task_id=task_id, step=step)
"""
from __future__ import annotations

import io
import json
import os
import re
import sys
import time
from typing import Any, IO

# ── DEV flag ──────────────────────────────────────────────────────────────────

DEV: bool = (
    os.getenv("NODE_ENV") != "production"
    or os.getenv("AGENTIC_DEV") == "1"
)

# ── Secret scrubbing ──────────────────────────────────────────────────────────

_SECRET_PATTERN = re.compile(
    r"(token|password|secret|api_key|authorization|cookie)",
    re.IGNORECASE,
)

_REDACTED = "[REDACTED]"


def _scrub(ctx: dict) -> dict:
    """Return a shallow copy of ctx with secret keys redacted."""
    result: dict[str, Any] = {}
    for k, v in ctx.items():
        if _SECRET_PATTERN.search(str(k)):
            result[k] = _REDACTED
        else:
            result[k] = v
    return result


# ── Core emit ─────────────────────────────────────────────────────────────────

def _emit(level: str, component: str, ctx: dict, stream: IO[str] | None = None) -> None:
    """Serialize and write a single JSONL log entry."""
    scrubbed = _scrub(ctx)
    entry = {
        "ts": time.time(),
        "level": level,
        "component": component,
        **scrubbed,
    }
    out = stream if stream is not None else sys.stderr
    out.write(json.dumps(entry, default=str) + "\n")


# ── Public API ────────────────────────────────────────────────────────────────

class _Logger:
    """
    Structured logger matching D2 spec.

    debug/info: no-ops unless DEV is True.
    warn/error: always emit.

    The optional `_stream` parameter on each call exists for testability;
    pass an io.StringIO to capture output in tests without monkey-patching.
    """

    def debug(self, component: str, _stream: IO[str] | None = None, **ctx: Any) -> None:
        if DEV:
            _emit("debug", component, ctx, _stream)

    def info(self, component: str, _stream: IO[str] | None = None, **ctx: Any) -> None:
        if DEV:
            _emit("info", component, ctx, _stream)

    def warn(self, component: str, _stream: IO[str] | None = None, **ctx: Any) -> None:
        _emit("warn", component, ctx, _stream)

    def error(self, component: str, _stream: IO[str] | None = None, **ctx: Any) -> None:
        _emit("error", component, ctx, _stream)


log = _Logger()
