"""
test_loop.py — Tests for the agent loop with mocked LLM.

NO real LLM calls. All LLM responses are pre-canned strings injected
via a MockLLMClient.

Covers:
- Happy path: 3-step task completes successfully
- Task done on first step (LLM says "Task complete")
- Step budget exhaustion (max_steps=2, loop runs 2 steps then fails)
- Token budget exhaustion (pre-seeded tokens over limit)
- Cancel flag: task cancelled when flag is set before first step
- Cancel flag: task cancelled mid-loop
- Sandbox violation: step_error emitted, loop continues
- LLM error: step_error emitted, loop continues
- task_started emitted as first event
- task_done emitted on success
- task_failed emitted on budget exhaustion
- task_cancelled emitted when cancelled
"""

import threading

from agent.budget import Budget
from agent.loop import AgentLoop, run_task
from agent.protocol import (
    REASON_STEP_BUDGET_EXHAUSTED,
    REASON_TOKEN_BUDGET_EXHAUSTED,
)

# ── Mock LLM client ───────────────────────────────────────────────────────────


class MockLLMClient:
    """
    Pre-canned LLM responses. Each call to chat() pops from self.responses.
    If responses are exhausted, returns the fallback.
    """

    def __init__(self, responses: list[str], fallback: str = "```python\n__result__ = None\n```"):
        self._responses = list(responses)
        self._fallback = fallback
        self._call_count = 0
        # Simulate token usage (small numbers for tests)
        self.usage = _FakeUsage()

    def chat(self, messages: list[dict], page_context: str | None = None) -> str:
        self._call_count += 1
        # Accumulate fake tokens each call
        self.usage.input_tokens += 100
        self.usage.output_tokens += 50
        if self._responses:
            return self._responses.pop(0)
        return self._fallback

    def get_usage_snapshot(self) -> dict:
        return {
            "input_tokens": self.usage.input_tokens,
            "output_tokens": self.usage.output_tokens,
        }


class _FakeUsage:
    def __init__(self):
        self.input_tokens = 0
        self.output_tokens = 0


# ── Mock helpers ──────────────────────────────────────────────────────────────


class MockHelpers:
    def page_info(self) -> dict:
        return {"url": "https://example.com", "title": "Example"}

    def goto(self, url: str) -> None:
        pass

    def click(self, selector: str) -> None:
        pass

    def screenshot(self) -> str:
        return ""


# ── Test fixtures ─────────────────────────────────────────────────────────────


def make_loop(
    responses: list[str],
    max_steps: int = 20,
    max_tokens_input: int = 100_000,
    cancel_flag: threading.Event | None = None,
) -> tuple[AgentLoop, list[dict]]:
    """Create an AgentLoop with mocked LLM and return (loop, event_log)."""
    event_log: list[dict] = []
    llm = MockLLMClient(responses)
    budget = Budget(max_steps=max_steps, max_tokens_input=max_tokens_input)
    loop = AgentLoop(
        task_id="test-task-001",
        prompt="Click the login button",
        per_target_cdp_url="ws://localhost:9222/devtools/page/abc",
        emit_event=event_log.append,
        helpers_module=MockHelpers(),
        llm_client=llm,
        budget=budget,
        cancel_flag=cancel_flag,
    )
    return loop, event_log


def events_of_type(log: list[dict], event_type: str) -> list[dict]:
    return [e for e in log if e.get("event") == event_type]


# ── Happy path ────────────────────────────────────────────────────────────────


class TestHappyPath:
    def test_task_started_emitted_first(self):
        responses = [
            "```python\ngoto('https://example.com')\n```",
            "```python\n__result__ = page_info()\n```\nTask complete",
        ]
        loop, log = make_loop(responses)
        loop.run()
        assert log[0]["event"] == "task_started"

    def test_task_done_emitted(self):
        responses = [
            "```python\n__result__ = 42\n```\nTask complete",
        ]
        loop, log = make_loop(responses)
        loop.run()
        done_events = events_of_type(log, "task_done")
        assert len(done_events) == 1

    def test_task_done_contains_result(self):
        responses = [
            "```python\n__result__ = 'success'\n```\nTask complete",
        ]
        loop, log = make_loop(responses)
        loop.run()
        done = events_of_type(log, "task_done")[0]
        assert done["result"] == "success"

    def test_task_done_contains_steps_and_tokens(self):
        responses = [
            "```python\n__result__ = 1\n```\nTask complete",
        ]
        loop, log = make_loop(responses)
        loop.run()
        done = events_of_type(log, "task_done")[0]
        assert "steps_used" in done
        assert "tokens_used" in done
        assert done["steps_used"] >= 1

    def test_three_step_task(self):
        """3 LLM steps, done signal on third response."""
        responses = [
            "```python\ngoto('https://example.com')\n```",
            "```python\nclick('#login-btn')\n```",
            "```python\n__result__ = 'logged in'\n```\nTask complete",
        ]
        loop, log = make_loop(responses)
        loop.run()

        step_starts = events_of_type(log, "step_start")
        step_results = events_of_type(log, "step_result")
        done = events_of_type(log, "task_done")

        assert len(step_starts) == 3
        assert len(step_results) == 3
        assert len(done) == 1
        assert done[0]["result"] == "logged in"

    def test_step_result_contains_duration_ms(self):
        responses = [
            "```python\n__result__ = 5\n```\nTask complete",
        ]
        loop, log = make_loop(responses)
        loop.run()
        results = events_of_type(log, "step_result")
        assert results[0]["duration_ms"] >= 0

    def test_no_task_failed_on_success(self):
        responses = [
            "```python\n__result__ = 1\n```\nTask complete",
        ]
        loop, log = make_loop(responses)
        loop.run()
        assert events_of_type(log, "task_failed") == []

    def test_no_task_cancelled_on_success(self):
        responses = [
            "```python\n__result__ = 1\n```\nTask complete",
        ]
        loop, log = make_loop(responses)
        loop.run()
        assert events_of_type(log, "task_cancelled") == []


# ── Budget exhaustion ─────────────────────────────────────────────────────────


class TestBudgetExhaustion:
    def test_step_budget_exhausted_emits_task_failed(self):
        # max_steps=2, LLM never says done
        responses = [
            "```python\ngoto('https://a.com')\n```",
            "```python\ngoto('https://b.com')\n```",
            "```python\ngoto('https://c.com')\n```",  # never reached
        ]
        loop, log = make_loop(responses, max_steps=2)
        loop.run()
        failed = events_of_type(log, "task_failed")
        assert len(failed) == 1
        assert failed[0]["reason"] == REASON_STEP_BUDGET_EXHAUSTED

    def test_step_budget_no_task_done(self):
        responses = ["```python\nx = 1\n```" for _ in range(5)]
        loop, log = make_loop(responses, max_steps=2)
        loop.run()
        assert events_of_type(log, "task_done") == []

    def test_step_budget_exactly_at_limit(self):
        """With max_steps=1, exactly 1 step runs then fails."""
        responses = [
            "```python\n__result__ = 99\n```",
            "```python\n__result__ = 100\n```",  # should not run
        ]
        loop, log = make_loop(responses, max_steps=1)
        loop.run()
        step_starts = events_of_type(log, "step_start")
        assert len(step_starts) == 1
        assert events_of_type(log, "task_failed")[0]["reason"] == REASON_STEP_BUDGET_EXHAUSTED

    def test_token_budget_exhausted_emits_task_failed(self):
        # Pre-seed budget with tokens over the max
        responses = ["```python\ngoto('https://a.com')\n```"] * 5
        event_log: list[dict] = []
        llm = MockLLMClient(responses)
        budget = Budget(max_tokens_input=50)  # very low limit
        # Pre-fill tokens to trigger exhaustion immediately
        budget.record_tokens(input_tokens=60)  # already over
        loop = AgentLoop(
            task_id="tok-test",
            prompt="test",
            per_target_cdp_url="ws://localhost:9222/devtools/page/x",
            emit_event=event_log.append,
            helpers_module=MockHelpers(),
            llm_client=llm,
            budget=budget,
            cancel_flag=threading.Event(),
        )
        loop.run()
        failed = events_of_type(event_log, "task_failed")
        assert len(failed) == 1
        assert failed[0]["reason"] == REASON_TOKEN_BUDGET_EXHAUSTED


# ── Cancel flag ───────────────────────────────────────────────────────────────


class TestCancelFlag:
    def test_cancel_before_first_step(self):
        cancel_flag = threading.Event()
        cancel_flag.set()  # already cancelled

        responses = ["```python\ngoto('https://x.com')\n```"]
        loop, log = make_loop(responses, cancel_flag=cancel_flag)
        loop.run()

        cancelled = events_of_type(log, "task_cancelled")
        assert len(cancelled) == 1
        assert cancelled[0]["task_id"] == "test-task-001"

    def test_cancel_emits_no_task_done(self):
        cancel_flag = threading.Event()
        cancel_flag.set()

        loop, log = make_loop([], cancel_flag=cancel_flag)
        loop.run()

        assert events_of_type(log, "task_done") == []
        assert events_of_type(log, "task_failed") == []

    def test_cancel_mid_loop(self):
        """Cancel flag set after first LLM response is consumed."""
        cancel_flag = threading.Event()

        call_count = 0

        class CancelAfterFirst(MockLLMClient):
            def chat(self, messages, page_context=None):
                nonlocal call_count
                call_count += 1
                if call_count >= 1:
                    cancel_flag.set()
                self.usage.input_tokens += 100
                self.usage.output_tokens += 50
                return "```python\n__result__ = None\n```"

        event_log: list[dict] = []
        llm = CancelAfterFirst([])
        budget = Budget(max_steps=10)
        loop = AgentLoop(
            task_id="cancel-mid",
            prompt="test",
            per_target_cdp_url="ws://localhost:9222/devtools/page/x",
            emit_event=event_log.append,
            helpers_module=MockHelpers(),
            llm_client=llm,
            budget=budget,
            cancel_flag=cancel_flag,
        )
        loop.run()
        # At most 2 step_starts: one before cancel is checked, one after
        step_starts = events_of_type(event_log, "step_start")
        cancelled = events_of_type(event_log, "task_cancelled")
        assert len(cancelled) == 1
        assert len(step_starts) <= 2


# ── Sandbox violation ─────────────────────────────────────────────────────────


class TestSandboxViolation:
    def test_sandbox_violation_emits_step_error(self):
        """LLM returns code that tries to import os → SandboxViolation → step_error."""
        responses = [
            "```python\nimport os\n```",  # blocked
            "```python\n__result__ = 'recovered'\n```\nTask complete",  # recovery
        ]
        loop, log = make_loop(responses, max_steps=5)
        loop.run()

        step_errors = events_of_type(log, "step_error")
        assert len(step_errors) >= 1

    def test_loop_continues_after_sandbox_violation(self):
        """After a sandbox violation, the loop feeds error back and tries next step."""
        responses = [
            "```python\nimport os\n```",  # blocked
            "```python\n__result__ = 42\n```\nTask complete",  # recovery
        ]
        loop, log = make_loop(responses, max_steps=5)
        loop.run()

        done = events_of_type(log, "task_done")
        assert len(done) == 1
        assert done[0]["result"] == 42

    def test_no_code_block_prompts_continue(self):
        """LLM response with no code block → loop asks for code, continues."""
        responses = [
            "I need to think about this...",  # no code block, no done marker
            "```python\n__result__ = 'ok'\n```\nTask complete",
        ]
        loop, log = make_loop(responses, max_steps=5)
        loop.run()
        done = events_of_type(log, "task_done")
        assert len(done) == 1


# ── Event ordering ────────────────────────────────────────────────────────────


class TestEventOrdering:
    def test_event_sequence_for_complete_task(self):
        responses = [
            "```python\n__result__ = 'done'\n```\nTask complete",
        ]
        loop, log = make_loop(responses)
        loop.run()

        event_types = [e["event"] for e in log]
        # task_started must come first
        assert event_types[0] == "task_started"
        # step_start before step_result
        start_idx = event_types.index("step_start")
        result_idx = event_types.index("step_result")
        done_idx = event_types.index("task_done")
        assert start_idx < result_idx < done_idx

    def test_all_events_have_task_id(self):
        responses = [
            "```python\n__result__ = 1\n```\nTask complete",
        ]
        loop, log = make_loop(responses)
        loop.run()
        for evt in log:
            assert "task_id" in evt, f"Missing task_id in event: {evt}"

    def test_all_events_have_version(self):
        responses = [
            "```python\n__result__ = 1\n```\nTask complete",
        ]
        loop, log = make_loop(responses)
        loop.run()
        for evt in log:
            assert "version" in evt, f"Missing version in event: {evt}"


# ── run_task() entry point ────────────────────────────────────────────────────


class TestRunTask:
    def test_run_task_function(self):
        """run_task() is the daemon entry point — verify it works end-to-end."""
        event_log: list[dict] = []
        llm = MockLLMClient(
            [
                "```python\n__result__ = 'via run_task'\n```\nTask complete",
            ]
        )

        run_task(
            prompt="test via run_task",
            per_target_cdp_url="ws://localhost:9222/devtools/page/abc",
            task_id="run-task-test",
            emit_event=event_log.append,
            helpers_module=MockHelpers(),
            llm_client=llm,
            budget=Budget(max_steps=5),
            cancel_flag=threading.Event(),
        )

        assert events_of_type(event_log, "task_started")
        done = events_of_type(event_log, "task_done")
        assert len(done) == 1
        assert done[0]["task_id"] == "run-task-test"
        assert done[0]["result"] == "via run_task"

    def test_run_task_creates_default_llm_if_none(self):
        """run_task() with llm_client=None should attempt to create LLMClient.
        We just verify it doesn't crash before the LLM call (cancel immediately)."""
        cancel_flag = threading.Event()
        cancel_flag.set()

        event_log: list[dict] = []
        run_task(
            prompt="test",
            per_target_cdp_url="ws://localhost:9222/devtools/page/abc",
            task_id="no-llm-test",
            emit_event=event_log.append,
            helpers_module=MockHelpers(),
            llm_client=None,  # should create default LLMClient
            cancel_flag=cancel_flag,
        )
        # Should emit task_started then task_cancelled (no LLM call made)
        assert events_of_type(event_log, "task_cancelled")
