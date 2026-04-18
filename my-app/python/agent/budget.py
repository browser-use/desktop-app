"""
budget.py — Step and token budget enforcement for agent tasks.

Defaults:
    max_steps = 20
    max_tokens_input = 100_000
    max_tokens_output = 16_000
"""

from __future__ import annotations

from .logger import log

MAX_STEPS_DEFAULT = 20
MAX_TOKENS_INPUT_DEFAULT = 100_000
MAX_TOKENS_OUTPUT_DEFAULT = 16_000


class BudgetExhausted(Exception):
    """Raised when a budget limit is exceeded."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class Budget:
    """Tracks step and token usage for a single agent task."""

    def __init__(
        self,
        max_steps: int = MAX_STEPS_DEFAULT,
        max_tokens_input: int = MAX_TOKENS_INPUT_DEFAULT,
        max_tokens_output: int = MAX_TOKENS_OUTPUT_DEFAULT,
    ):
        self.max_steps = max_steps
        self.max_tokens_input = max_tokens_input
        self.max_tokens_output = max_tokens_output

        self._steps_used: int = 0
        self._tokens_input_used: int = 0
        self._tokens_output_used: int = 0

    # ── Accessors ────────────────────────────────────────────────────────────

    @property
    def steps_used(self) -> int:
        return self._steps_used

    @property
    def tokens_input_used(self) -> int:
        return self._tokens_input_used

    @property
    def tokens_output_used(self) -> int:
        return self._tokens_output_used

    @property
    def tokens_used(self) -> int:
        """Total tokens used (input + output)."""
        return self._tokens_input_used + self._tokens_output_used

    # ── Checks ────────────────────────────────────────────────────────────────

    def check_step_budget(self) -> None:
        """Raise BudgetExhausted if step budget is exceeded."""
        if self._steps_used >= self.max_steps:
            log.warn(
                "Budget.check_step_budget",
                reason="step_budget_exhausted",
                steps_used=self._steps_used,
                max_steps=self.max_steps,
            )
            raise BudgetExhausted("step_budget_exhausted")

    def check_token_budget(self) -> None:
        """Raise BudgetExhausted if input token budget is exceeded."""
        if self._tokens_input_used >= self.max_tokens_input:
            log.warn(
                "Budget.check_token_budget",
                reason="token_budget_exhausted",
                tokens_input_used=self._tokens_input_used,
                max_tokens_input=self.max_tokens_input,
            )
            raise BudgetExhausted("token_budget_exhausted")

    def is_step_exhausted(self) -> bool:
        return self._steps_used >= self.max_steps

    def is_token_exhausted(self) -> bool:
        return self._tokens_input_used >= self.max_tokens_input

    # ── Mutations ─────────────────────────────────────────────────────────────

    def increment_step(self) -> int:
        """Increment step counter and return new step index (0-based)."""
        step = self._steps_used
        self._steps_used += 1
        log.debug("Budget.increment_step", steps_used=self._steps_used, max_steps=self.max_steps)
        return step

    def record_tokens(self, input_tokens: int = 0, output_tokens: int = 0) -> None:
        """Record token usage from an LLM response."""
        self._tokens_input_used += input_tokens
        self._tokens_output_used += output_tokens
        log.debug(
            "Budget.record_tokens",
            tokens_input_used=self._tokens_input_used,
            tokens_output_used=self._tokens_output_used,
            max_tokens_input=self.max_tokens_input,
        )

    # ── Snapshot ──────────────────────────────────────────────────────────────

    def snapshot(self) -> dict:
        """Return a dict snapshot suitable for telemetry or logging."""
        return {
            "steps_used": self._steps_used,
            "max_steps": self.max_steps,
            "tokens_input_used": self._tokens_input_used,
            "tokens_output_used": self._tokens_output_used,
            "max_tokens_input": self.max_tokens_input,
            "max_tokens_output": self.max_tokens_output,
        }
