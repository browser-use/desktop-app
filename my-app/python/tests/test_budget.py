"""
test_budget.py — Tests for budget.py step and token budget enforcement.

Covers:
- Default values
- increment_step() counting
- record_tokens() accumulation
- is_step_exhausted() / is_token_exhausted() boolean checks
- check_step_budget() / check_token_budget() raising BudgetExhausted
- snapshot() shape
- Custom budget limits
"""

import pytest

from agent.budget import (
    MAX_STEPS_DEFAULT,
    MAX_TOKENS_INPUT_DEFAULT,
    MAX_TOKENS_OUTPUT_DEFAULT,
    Budget,
    BudgetExhausted,
)


class TestBudgetDefaults:
    def test_default_max_steps(self):
        b = Budget()
        assert b.max_steps == MAX_STEPS_DEFAULT
        assert MAX_STEPS_DEFAULT == 20

    def test_default_max_tokens_input(self):
        b = Budget()
        assert b.max_tokens_input == MAX_TOKENS_INPUT_DEFAULT
        assert MAX_TOKENS_INPUT_DEFAULT == 100_000

    def test_default_max_tokens_output(self):
        b = Budget()
        assert b.max_tokens_output == MAX_TOKENS_OUTPUT_DEFAULT
        assert MAX_TOKENS_OUTPUT_DEFAULT == 16_000

    def test_starts_at_zero(self):
        b = Budget()
        assert b.steps_used == 0
        assert b.tokens_input_used == 0
        assert b.tokens_output_used == 0
        assert b.tokens_used == 0


class TestStepBudget:
    def test_increment_returns_step_index(self):
        b = Budget()
        assert b.increment_step() == 0
        assert b.increment_step() == 1
        assert b.increment_step() == 2

    def test_steps_used_increments(self):
        b = Budget()
        b.increment_step()
        b.increment_step()
        assert b.steps_used == 2

    def test_not_exhausted_initially(self):
        b = Budget(max_steps=5)
        assert not b.is_step_exhausted()

    def test_exhausted_at_limit(self):
        b = Budget(max_steps=3)
        for _ in range(3):
            b.increment_step()
        assert b.is_step_exhausted()

    def test_not_exhausted_before_limit(self):
        b = Budget(max_steps=3)
        b.increment_step()
        b.increment_step()
        assert not b.is_step_exhausted()

    def test_check_step_budget_raises_when_exhausted(self):
        b = Budget(max_steps=2)
        b.increment_step()
        b.increment_step()
        with pytest.raises(BudgetExhausted) as exc_info:
            b.check_step_budget()
        assert exc_info.value.reason == "step_budget_exhausted"

    def test_check_step_budget_no_raise_when_ok(self):
        b = Budget(max_steps=5)
        b.increment_step()
        b.check_step_budget()  # should not raise

    def test_single_step_budget(self):
        b = Budget(max_steps=1)
        b.increment_step()
        assert b.is_step_exhausted()
        with pytest.raises(BudgetExhausted):
            b.check_step_budget()

    def test_exhausted_from_for_loop(self):
        """Simulates the agent loop using range(max_steps)."""
        b = Budget(max_steps=3)
        steps_run = 0
        for _i in range(b.max_steps):
            if b.is_step_exhausted():
                break
            b.increment_step()
            steps_run += 1
        assert steps_run == 3


class TestTokenBudget:
    def test_record_tokens_input(self):
        b = Budget()
        b.record_tokens(input_tokens=500)
        assert b.tokens_input_used == 500
        assert b.tokens_output_used == 0

    def test_record_tokens_output(self):
        b = Budget()
        b.record_tokens(output_tokens=200)
        assert b.tokens_output_used == 200

    def test_record_tokens_both(self):
        b = Budget()
        b.record_tokens(input_tokens=1000, output_tokens=300)
        assert b.tokens_input_used == 1000
        assert b.tokens_output_used == 300
        assert b.tokens_used == 1300

    def test_record_tokens_accumulates(self):
        b = Budget()
        b.record_tokens(input_tokens=100, output_tokens=50)
        b.record_tokens(input_tokens=200, output_tokens=100)
        assert b.tokens_input_used == 300
        assert b.tokens_output_used == 150
        assert b.tokens_used == 450

    def test_not_token_exhausted_initially(self):
        b = Budget(max_tokens_input=1000)
        assert not b.is_token_exhausted()

    def test_token_exhausted_at_limit(self):
        b = Budget(max_tokens_input=500)
        b.record_tokens(input_tokens=500)
        assert b.is_token_exhausted()

    def test_token_exhausted_over_limit(self):
        b = Budget(max_tokens_input=500)
        b.record_tokens(input_tokens=600)
        assert b.is_token_exhausted()

    def test_check_token_budget_raises_when_exhausted(self):
        b = Budget(max_tokens_input=100)
        b.record_tokens(input_tokens=100)
        with pytest.raises(BudgetExhausted) as exc_info:
            b.check_token_budget()
        assert exc_info.value.reason == "token_budget_exhausted"

    def test_check_token_budget_no_raise_when_ok(self):
        b = Budget(max_tokens_input=1000)
        b.record_tokens(input_tokens=500)
        b.check_token_budget()  # should not raise

    def test_output_tokens_do_not_trigger_input_exhaustion(self):
        b = Budget(max_tokens_input=100)
        b.record_tokens(output_tokens=200)  # only output exceeds, not input
        assert not b.is_token_exhausted()


class TestBudgetSnapshot:
    def test_snapshot_shape(self):
        b = Budget(max_steps=10, max_tokens_input=5000, max_tokens_output=2000)
        b.increment_step()
        b.record_tokens(input_tokens=100, output_tokens=50)
        snap = b.snapshot()

        assert snap["steps_used"] == 1
        assert snap["max_steps"] == 10
        assert snap["tokens_input_used"] == 100
        assert snap["tokens_output_used"] == 50
        assert snap["max_tokens_input"] == 5000
        assert snap["max_tokens_output"] == 2000

    def test_snapshot_initial_values(self):
        b = Budget()
        snap = b.snapshot()
        assert snap["steps_used"] == 0
        assert snap["tokens_input_used"] == 0
        assert snap["tokens_output_used"] == 0


class TestBudgetCustomLimits:
    def test_custom_limits_honored(self):
        b = Budget(max_steps=5, max_tokens_input=1000, max_tokens_output=500)
        assert b.max_steps == 5
        assert b.max_tokens_input == 1000
        assert b.max_tokens_output == 500

    def test_zero_steps_immediately_exhausted(self):
        b = Budget(max_steps=0)
        assert b.is_step_exhausted()

    def test_budget_exhausted_exception_has_reason(self):
        exc = BudgetExhausted("step_budget_exhausted")
        assert exc.reason == "step_budget_exhausted"
        assert "step_budget_exhausted" in str(exc)
