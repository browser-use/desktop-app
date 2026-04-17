"""
telemetry.py — Metric emission for the agent daemon.

Emits structured log lines that can be scraped by Track H's log pipeline.
All metrics are logged as JSON to make them machine-parseable.

Metric names (from plan §8.4):
    agent_task_duration_ms
    agent_first_step_latency_ms
    sandbox_violations_per_day (incremented)
    agent_task_success_rate (via task_done/task_failed counts)
"""
from __future__ import annotations

import json
import time
from typing import Any, Optional

from .logger import log

# ── Metric names (constants for typo safety) ──────────────────────────────────

METRIC_TASK_STARTED = "agent_task_started"
METRIC_TASK_DONE = "agent_task_done"
METRIC_TASK_FAILED = "agent_task_failed"
METRIC_TASK_CANCELLED = "agent_task_cancelled"
METRIC_TASK_DURATION_MS = "agent_task_duration_ms"
METRIC_FIRST_STEP_LATENCY_MS = "agent_first_step_latency_ms"
METRIC_STEP_DURATION_MS = "agent_step_duration_ms"
METRIC_SANDBOX_VIOLATION = "sandbox_violation"
METRIC_DAEMON_STARTUP = "daemon_startup"
METRIC_TOKEN_USAGE = "agent_token_usage"


def _emit(metric: str, value: Any, tags: Optional[dict] = None) -> None:
    """Emit a structured metric log line."""
    record = {
        "metric": metric,
        "value": value,
        "ts": time.time(),
    }
    if tags:
        record["tags"] = tags
    log.info("telemetry.emit", **record)


# ── Telemetry helpers ─────────────────────────────────────────────────────────

class TaskTimer:
    """Context-manager-style timer for a single agent task."""

    def __init__(self, task_id: str):
        self.task_id = task_id
        self._start: Optional[float] = None
        self._first_step_time: Optional[float] = None

    def start(self) -> None:
        self._start = time.monotonic()
        _emit(METRIC_TASK_STARTED, 1, {"task_id": self.task_id})

    def record_first_step(self) -> None:
        if self._start is not None and self._first_step_time is None:
            self._first_step_time = time.monotonic()
            latency_ms = int((self._first_step_time - self._start) * 1000)
            _emit(
                METRIC_FIRST_STEP_LATENCY_MS,
                latency_ms,
                {"task_id": self.task_id},
            )

    def done(self, success: bool, steps_used: int, tokens_used: int) -> None:
        if self._start is not None:
            duration_ms = int((time.monotonic() - self._start) * 1000)
            _emit(
                METRIC_TASK_DURATION_MS,
                duration_ms,
                {
                    "task_id": self.task_id,
                    "success": success,
                    "steps_used": steps_used,
                },
            )
        metric = METRIC_TASK_DONE if success else METRIC_TASK_FAILED
        _emit(metric, 1, {"task_id": self.task_id, "tokens_used": tokens_used})
        _emit(METRIC_TOKEN_USAGE, tokens_used, {"task_id": self.task_id})


def record_sandbox_violation(task_id: str, violation_type: str) -> None:
    _emit(
        METRIC_SANDBOX_VIOLATION,
        1,
        {"task_id": task_id, "type": violation_type},
    )


def record_step_duration(task_id: str, step: int, duration_ms: int) -> None:
    _emit(
        METRIC_STEP_DURATION_MS,
        duration_ms,
        {"task_id": task_id, "step": step},
    )


def record_daemon_startup(duration_ms: int) -> None:
    _emit(METRIC_DAEMON_STARTUP, duration_ms)
