"""
loop.py — Outer agent loop.

Implements the agent loop:
    attach to CDP → emit task_started → for each step:
        check budgets → emit step_start → call LLM → extract code →
        exec in sandbox → emit step_result/step_error → check done →
    emit task_done / task_failed / task_cancelled

The loop runs synchronously in a thread (called via asyncio's thread pool
from agent_daemon.py). The `emit_event` callback is thread-safe.

Per plan §4 (active-tab enforcement at transport):
    The caller passes the per-target CDP WS URL. The daemon attaches
    ONLY to that URL — not the browser-level endpoint. This makes multi-tab
    contamination impossible at the protocol level.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from typing import Any

from .budget import Budget
from .exec_sandbox import (
    ExecSandbox,
    ExecTimeout,
    SandboxViolation,
    extract_code_block,
    llm_indicates_done,
)
from .llm import LLMClient
from .logger import log
from .protocol import (
    REASON_INTERNAL_ERROR,
    REASON_STEP_BUDGET_EXHAUSTED,
    REASON_TOKEN_BUDGET_EXHAUSTED,
    event_step_error,
    event_step_result,
    event_step_start,
    event_task_cancelled,
    event_task_done,
    event_task_failed,
    event_task_started,
)
from .telemetry import TaskTimer, record_sandbox_violation, record_step_duration


class AgentLoop:
    """
    Manages a single agent task execution.

    Args:
        task_id: Unique identifier for this task.
        prompt: User's task description.
        per_target_cdp_url: Per-target CDP WebSocket URL for the active tab.
        emit_event: Callable that takes an event dict and sends it to the socket.
        helpers_module: The harnessless helpers module (real or mock).
        llm_client: An LLMClient instance (can be mocked in tests).
        budget: A Budget instance controlling step/token limits.
        cancel_flag: threading.Event — set this to cancel the task.
    """

    def __init__(
        self,
        task_id: str,
        prompt: str,
        per_target_cdp_url: str,
        emit_event: Callable[[dict], None],
        helpers_module: Any,
        llm_client: LLMClient,
        budget: Budget | None = None,
        cancel_flag: threading.Event | None = None,
    ):
        self.task_id = task_id
        self.prompt = prompt
        self.per_target_cdp_url = per_target_cdp_url
        self.emit_event = emit_event
        self.helpers_module = helpers_module
        self.llm_client = llm_client
        self.budget = budget or Budget()
        self.cancel_flag = cancel_flag or threading.Event()

        self._sandbox = ExecSandbox(helpers_module)
        self._timer = TaskTimer(task_id)
        self._observation_history: list[dict] = []
        self._last_result: Any = None

    def run(self) -> None:
        """
        Execute the agent loop. Blocking — run in a thread.

        Emits events via self.emit_event throughout execution.
        """
        log.info(
            "AgentLoop.run",
            task_id=self.task_id,
            cdp_url=self.per_target_cdp_url,
        )

        self._timer.start()
        self.emit_event(event_task_started(self.task_id))

        # Initial observation: prompt + page info
        page_info = self._safe_page_info()
        initial_obs = {
            "prompt": self.prompt,
            "page_info": page_info,
        }
        self._observation_history.append({"role": "system_context", "data": initial_obs})

        try:
            self._run_loop()
        except Exception as exc:
            log.error(
                "AgentLoop.run", task_id=self.task_id, error=str(exc), note="unhandled exception"
            )
            self.emit_event(
                event_task_failed(
                    self.task_id,
                    REASON_INTERNAL_ERROR,
                    partial_result=str(exc),
                )
            )
            self._timer.done(
                success=False,
                steps_used=self.budget.steps_used,
                tokens_used=self.budget.tokens_used,
            )

    def _run_loop(self) -> None:
        """Inner loop — separated for cleaner exception handling."""
        messages: list[dict] = [
            {
                "role": "user",
                "content": self._build_initial_user_message(),
            }
        ]

        for _iteration in range(self.budget.max_steps):
            # ── Cancel check ─────────────────────────────────────────────────
            if self.cancel_flag.is_set():
                log.info(
                    "AgentLoop._run_loop",
                    task_id=self.task_id,
                    step=self.budget.steps_used,
                    note="cancel_flag set",
                )
                self.emit_event(event_task_cancelled(self.task_id))
                self._timer.done(
                    success=False,
                    steps_used=self.budget.steps_used,
                    tokens_used=self.budget.tokens_used,
                )
                return

            # ── Token budget check ────────────────────────────────────────────
            if self.budget.is_token_exhausted():
                log.warn(
                    "AgentLoop._run_loop",
                    task_id=self.task_id,
                    note="token budget exhausted",
                    tokens_used=self.budget.tokens_used,
                )
                self.emit_event(
                    event_task_failed(
                        self.task_id,
                        REASON_TOKEN_BUDGET_EXHAUSTED,
                        partial_result=self._last_result,
                    )
                )
                self._timer.done(
                    success=False,
                    steps_used=self.budget.steps_used,
                    tokens_used=self.budget.tokens_used,
                )
                return

            # ── Step budget check ─────────────────────────────────────────────
            if self.budget.is_step_exhausted():
                log.warn(
                    "AgentLoop._run_loop",
                    task_id=self.task_id,
                    note="step budget exhausted",
                    steps_used=self.budget.steps_used,
                )
                self.emit_event(
                    event_task_failed(
                        self.task_id,
                        REASON_STEP_BUDGET_EXHAUSTED,
                        partial_result=self._last_result,
                    )
                )
                self._timer.done(
                    success=False,
                    steps_used=self.budget.steps_used,
                    tokens_used=self.budget.tokens_used,
                )
                return

            step = self.budget.increment_step()
            step_start_time = time.monotonic()

            # First step telemetry
            if step == 0:
                self._timer.record_first_step()

            # ── Emit step_start ───────────────────────────────────────────────
            plan = self._extract_plan_from_messages(messages)
            self.emit_event(event_step_start(self.task_id, step, plan))
            log.info("AgentLoop.step_start", task_id=self.task_id, step=step)

            # ── LLM call ──────────────────────────────────────────────────────
            try:
                page_context = self._safe_page_info_str()
                llm_response = self.llm_client.chat(
                    messages=messages,
                    page_context=page_context,
                )
            except Exception as exc:
                log.warn("AgentLoop.llm_call", task_id=self.task_id, step=step, error=str(exc))
                obs_entry = {
                    "role": "assistant",
                    "content": f"[LLM error at step {step}]: {exc}",
                }
                messages.append(obs_entry)
                messages.append(
                    {
                        "role": "user",
                        "content": f"The LLM call failed: {exc}. Please continue or indicate task_done.",
                    }
                )
                self.emit_event(event_step_error(self.task_id, step, str(exc)))
                duration_ms = int((time.monotonic() - step_start_time) * 1000)
                record_step_duration(self.task_id, step, duration_ms)
                continue

            # Record tokens from this LLM call
            self.llm_client.get_usage_snapshot()
            # Approximate: use the latest delta by tracking cumulative
            self.budget.record_tokens(
                input_tokens=getattr(self.llm_client.usage, "input_tokens", 0),
                output_tokens=getattr(self.llm_client.usage, "output_tokens", 0),
            )

            # Append LLM response to conversation
            messages.append({"role": "assistant", "content": llm_response})

            # ── Extract and execute code ──────────────────────────────────────
            python_code = extract_code_block(llm_response)

            if python_code is None:
                log.debug(
                    "AgentLoop.extract_code",
                    task_id=self.task_id,
                    step=step,
                    note="no code block in LLM response",
                )
                # No code — check if LLM said done
                if llm_indicates_done(llm_response):
                    log.info(
                        "AgentLoop.task_done",
                        task_id=self.task_id,
                        step=step,
                        note="no code block, LLM said done",
                    )
                    self.emit_event(
                        event_task_done(
                            self.task_id,
                            result=self._last_result,
                            steps_used=self.budget.steps_used,
                            tokens_used=self.budget.tokens_used,
                        )
                    )
                    self._timer.done(
                        success=True,
                        steps_used=self.budget.steps_used,
                        tokens_used=self.budget.tokens_used,
                    )
                    return

                messages.append(
                    {
                        "role": "user",
                        "content": "Please provide a Python code block or indicate the task is complete.",
                    }
                )
                duration_ms = int((time.monotonic() - step_start_time) * 1000)
                record_step_duration(self.task_id, step, duration_ms)
                continue

            # Execute in sandbox
            exec_result = None
            step_error = None

            try:
                exec_result = self._sandbox.run(python_code)
                self._last_result = exec_result
                duration_ms = int((time.monotonic() - step_start_time) * 1000)
                record_step_duration(self.task_id, step, duration_ms)
                self.emit_event(event_step_result(self.task_id, step, exec_result, duration_ms))

                # Feed result back into conversation
                result_summary = repr(exec_result) if exec_result is not None else "None"
                messages.append(
                    {
                        "role": "user",
                        "content": f"Step {step} result: {result_summary}\nContinue with the next step or indicate task_done.",
                    }
                )

            except SandboxViolation as exc:
                step_error = str(exc)
                log.warn("AgentLoop.exec", task_id=self.task_id, step=step, violation=str(exc))
                record_sandbox_violation(self.task_id, str(exc))
                duration_ms = int((time.monotonic() - step_start_time) * 1000)
                record_step_duration(self.task_id, step, duration_ms)
                self.emit_event(
                    event_step_error(
                        self.task_id, step, {"type": "sandbox_violation", "message": step_error}
                    )
                )
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            f"Step {step} failed with a security violation: {step_error}\n"
                            "You must not use blocked modules or operations. "
                            "Please try a different approach using only the available helpers."
                        ),
                    }
                )

            except ExecTimeout as exc:
                step_error = str(exc)
                log.warn("AgentLoop.exec.timeout", task_id=self.task_id, step=step, error=str(exc))
                duration_ms = int((time.monotonic() - step_start_time) * 1000)
                record_step_duration(self.task_id, step, duration_ms)
                self.emit_event(
                    event_step_error(self.task_id, step, {"type": "timeout", "message": step_error})
                )
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            f"Step {step} timed out after 30 seconds: {step_error}\n"
                            "Please use a simpler approach or break into smaller steps."
                        ),
                    }
                )

            except Exception as exc:
                step_error = str(exc)
                log.warn("AgentLoop.exec.error", task_id=self.task_id, step=step, error=str(exc))
                duration_ms = int((time.monotonic() - step_start_time) * 1000)
                record_step_duration(self.task_id, step, duration_ms)
                self.emit_event(
                    event_step_error(
                        self.task_id, step, {"type": "runtime_error", "message": step_error}
                    )
                )
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            f"Step {step} raised an exception: {step_error}\n"
                            "Please adjust your code and try again."
                        ),
                    }
                )

            # ── Check done ────────────────────────────────────────────────────
            if step_error is None and llm_indicates_done(llm_response):
                log.info(
                    "AgentLoop.task_done",
                    task_id=self.task_id,
                    step=step,
                    steps_used=self.budget.steps_used,
                )
                self.emit_event(
                    event_task_done(
                        self.task_id,
                        result=self._last_result,
                        steps_used=self.budget.steps_used,
                        tokens_used=self.budget.tokens_used,
                    )
                )
                self._timer.done(
                    success=True,
                    steps_used=self.budget.steps_used,
                    tokens_used=self.budget.tokens_used,
                )
                return

        # Loop exhausted — emit step_budget_exhausted
        log.warn(
            "AgentLoop._run_loop.exhausted", task_id=self.task_id, steps_used=self.budget.steps_used
        )
        self.emit_event(
            event_task_failed(
                self.task_id,
                REASON_STEP_BUDGET_EXHAUSTED,
                partial_result=self._last_result,
            )
        )
        self._timer.done(
            success=False, steps_used=self.budget.steps_used, tokens_used=self.budget.tokens_used
        )

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _build_initial_user_message(self) -> str:
        page_info = self._safe_page_info()
        return (
            f"Task: {self.prompt}\n\n"
            f"Current page: {page_info}\n\n"
            "Please start executing the task. Output a Python code block for your first action."
        )

    def _safe_page_info(self) -> dict:
        """Get page info, returning empty dict on failure."""
        try:
            return self.helpers_module.page_info()
        except Exception as exc:
            log.debug("AgentLoop.page_info", task_id=self.task_id, error=str(exc))
            return {}

    def _safe_page_info_str(self) -> str:
        """Get page info as a string."""
        info = self._safe_page_info()
        if not info:
            return "Page info unavailable"
        return str(info)

    def _extract_plan_from_messages(self, messages: list[dict]) -> str:
        """Extract a brief plan description from the last assistant message."""
        for msg in reversed(messages):
            if msg.get("role") == "assistant":
                content = msg.get("content", "")
                # Return first non-empty line as plan summary
                for line in content.split("\n"):
                    line = line.strip()
                    if line and not line.startswith("```"):
                        return line[:200]
        return ""


def run_task(
    prompt: str,
    per_target_cdp_url: str,
    task_id: str,
    emit_event: Callable[[dict], None],
    helpers_module: Any,
    llm_client: LLMClient | None = None,
    budget: Budget | None = None,
    cancel_flag: threading.Event | None = None,
) -> None:
    """
    Top-level entry point for running an agent task.

    This is the function called by agent_daemon.py.
    Runs synchronously — invoke in a thread.
    """
    if llm_client is None:
        llm_client = LLMClient()

    loop = AgentLoop(
        task_id=task_id,
        prompt=prompt,
        per_target_cdp_url=per_target_cdp_url,
        emit_event=emit_event,
        helpers_module=helpers_module,
        llm_client=llm_client,
        budget=budget,
        cancel_flag=cancel_flag,
    )
    loop.run()
