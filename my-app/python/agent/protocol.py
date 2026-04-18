"""
protocol.py — Message schemas for the agent daemon Unix socket protocol.

Aligns with Track E tentative shapes from plan §5 Track E "Exposes".
Protocol version: "1.0"

All messages are JSON objects, one per line (JSON-line protocol).

Request shapes (main → daemon):
    {meta: "agent_task",        prompt: str, per_target_cdp_url: str, task_id: str}
    {meta: "cancel_task",       task_id: str}
    {meta: "set_active_target", per_target_cdp_url: str}
    {meta: "ping"}
    {meta: "shutdown"}

Response envelopes (daemon → main, reply to request):
    {ok: true, result?: {...}}
    {ok: false, error: {code: str, message: str, retryable: bool}}

Event shapes (daemon → main, pushed async, one JSON per line):
    {event: "task_started",   task_id, started_at}
    {event: "step_start",     task_id, step, plan}
    {event: "step_result",    task_id, step, result, duration_ms}
    {event: "step_error",     task_id, step, error}
    {event: "task_done",      task_id, result, steps_used, tokens_used}
    {event: "task_failed",    task_id, reason, partial_result?}
    {event: "task_cancelled", task_id}
    {event: "target_lost",    task_id, target_id}
"""

from __future__ import annotations

import json
import time
from typing import Any

PROTOCOL_VERSION = "1.0"

# ── Error codes ──────────────────────────────────────────────────────────────
ERR_PARSE_ERROR = "parse_error"
ERR_UNKNOWN_META = "unknown_meta"
ERR_TASK_RUNNING = "task_running"
ERR_TASK_NOT_FOUND = "task_not_found"
ERR_INTERNAL = "internal_error"

# ── Reason strings for task_failed ───────────────────────────────────────────
REASON_STEP_BUDGET_EXHAUSTED = "step_budget_exhausted"
REASON_TOKEN_BUDGET_EXHAUSTED = "token_budget_exhausted"
REASON_SANDBOX_VIOLATION = "sandbox_violation"
REASON_INTERNAL_ERROR = "internal_error"
REASON_TARGET_LOST = "target_lost"


def _now_iso() -> str:
    """Return current UTC time as ISO 8601 string."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# ── Response builders ─────────────────────────────────────────────────────────


def ok_response(result: dict | None = None) -> dict:
    """Build a successful response envelope."""
    resp: dict[str, Any] = {"ok": True, "version": PROTOCOL_VERSION}
    if result is not None:
        resp["result"] = result
    return resp


def error_response(code: str, message: str, retryable: bool = False) -> dict:
    """Build an error response envelope."""
    return {
        "ok": False,
        "version": PROTOCOL_VERSION,
        "error": {"code": code, "message": message, "retryable": retryable},
    }


# ── Event builders ────────────────────────────────────────────────────────────


def event_task_started(task_id: str) -> dict:
    return {
        "event": "task_started",
        "version": PROTOCOL_VERSION,
        "task_id": task_id,
        "started_at": _now_iso(),
    }


def event_step_start(task_id: str, step: int, plan: str = "") -> dict:
    return {
        "event": "step_start",
        "version": PROTOCOL_VERSION,
        "task_id": task_id,
        "step": step,
        "plan": plan,
    }


def event_step_result(task_id: str, step: int, result: Any, duration_ms: int) -> dict:
    return {
        "event": "step_result",
        "version": PROTOCOL_VERSION,
        "task_id": task_id,
        "step": step,
        "result": result,
        "duration_ms": duration_ms,
    }


def event_step_error(task_id: str, step: int, error: Any) -> dict:
    return {
        "event": "step_error",
        "version": PROTOCOL_VERSION,
        "task_id": task_id,
        "step": step,
        "error": str(error) if not isinstance(error, dict) else error,
    }


def event_task_done(
    task_id: str,
    result: Any,
    steps_used: int,
    tokens_used: int,
) -> dict:
    return {
        "event": "task_done",
        "version": PROTOCOL_VERSION,
        "task_id": task_id,
        "result": result,
        "steps_used": steps_used,
        "tokens_used": tokens_used,
    }


def event_task_failed(
    task_id: str,
    reason: str,
    partial_result: Any = None,
) -> dict:
    evt: dict[str, Any] = {
        "event": "task_failed",
        "version": PROTOCOL_VERSION,
        "task_id": task_id,
        "reason": reason,
    }
    if partial_result is not None:
        evt["partial_result"] = partial_result
    return evt


def event_task_cancelled(task_id: str) -> dict:
    return {
        "event": "task_cancelled",
        "version": PROTOCOL_VERSION,
        "task_id": task_id,
    }


def event_target_lost(task_id: str, target_id: str) -> dict:
    return {
        "event": "target_lost",
        "version": PROTOCOL_VERSION,
        "task_id": task_id,
        "target_id": target_id,
    }


# ── Message parsing ───────────────────────────────────────────────────────────


class ProtocolError(Exception):
    """Raised when an incoming message cannot be parsed or has invalid shape."""

    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def parse_request(raw: bytes | str) -> dict:
    """Parse a raw JSON-line request. Raises ProtocolError on failure."""
    try:
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        msg = json.loads(raw.strip())
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ProtocolError(ERR_PARSE_ERROR, f"JSON parse error: {exc}") from exc

    if not isinstance(msg, dict):
        raise ProtocolError(ERR_PARSE_ERROR, "Message must be a JSON object")

    meta = msg.get("meta")
    if meta is None:
        raise ProtocolError(ERR_UNKNOWN_META, "Missing 'meta' field")

    return msg


def encode_message(obj: dict) -> bytes:
    """Serialize a message dict to a JSON line (newline-terminated bytes)."""
    return (json.dumps(obj, default=str) + "\n").encode("utf-8")
