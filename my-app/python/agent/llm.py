"""
llm.py — Anthropic SDK LLM client with prompt caching.

Default model: claude-sonnet-4-6
Override with env var: AGENT_MODEL=claude-opus-4-7

Prompt caching strategy (mandatory per spec):
- The system prompt containing harnessless helpers.py source is placed in a
  cache_control block. This is the largest stable prefix.
- The current page state context (second system block) is also cached as it
  changes per-task not per-step.
- Messages history is sent as-is; only the system blocks are cached.

Streaming is used to avoid timeout on long generations.
"""

from __future__ import annotations

import os
from typing import Any

from .logger import log

# ── Model constants ───────────────────────────────────────────────────────────

MODEL_DEFAULT = "claude-sonnet-4-6"
MODEL_ENV_VAR = "AGENT_MODEL"

MAX_TOKENS_DEFAULT = 16_000

# ── System prompt components ──────────────────────────────────────────────────

SYSTEM_PROMPT_PREFIX = """\
You are an AI agent controlling a web browser via Python code.
You have access to a helpers module with browser control functions.
Each step, you must output a Python code block to perform one action.
The code will be executed in a sandboxed environment with only the helpers
functions available.

IMPORTANT RULES:
1. Output EXACTLY ONE Python code block per response using ```python ... ``` markers.
2. To signal task completion, include the text "Task complete" in your response
   after the code block.
3. The variable `__result__` can be set to capture output for the next step.
4. You can see the current page state in the observation.
5. If an error occurred in the previous step, it will be shown in the observation.
   Adapt your approach based on errors.

Available helpers (from harnessless helpers.py):
"""


def _read_helpers_source() -> str:
    """Read the helpers.py source for inclusion in the system prompt."""
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(here, "..", "harnessless", "helpers.py"),
        os.path.join(here, "..", "helpers.py"),
        "/tmp/harnessless/helpers.py",
    ]
    for path in candidates:
        try:
            with open(os.path.normpath(path)) as f:
                return f.read()
        except FileNotFoundError:
            continue
    log.warn("LLMClient.read_helpers_source", note="helpers.py not found, using placeholder")
    return "# helpers.py not found"


# Build the full helpers doc once at import time
_HELPERS_SOURCE = _read_helpers_source()
HELPERS_DOC = SYSTEM_PROMPT_PREFIX + "```python\n" + _HELPERS_SOURCE + "\n```"


# ── Token usage tracking ──────────────────────────────────────────────────────


class TokenUsage:
    """Accumulates token usage across LLM calls."""

    def __init__(self):
        self.input_tokens = 0
        self.output_tokens = 0
        self.cache_creation_tokens = 0
        self.cache_read_tokens = 0

    def record(self, usage: Any) -> None:
        """Record usage from an Anthropic response usage object."""
        self.input_tokens += getattr(usage, "input_tokens", 0) or 0
        self.output_tokens += getattr(usage, "output_tokens", 0) or 0
        self.cache_creation_tokens += getattr(usage, "cache_creation_input_tokens", 0) or 0
        self.cache_read_tokens += getattr(usage, "cache_read_input_tokens", 0) or 0

    @property
    def total_input(self) -> int:
        return self.input_tokens

    @property
    def total_output(self) -> int:
        return self.output_tokens

    def to_dict(self) -> dict:
        return {
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cache_creation_tokens": self.cache_creation_tokens,
            "cache_read_tokens": self.cache_read_tokens,
        }


# ── LLM Client ────────────────────────────────────────────────────────────────


class LLMClient:
    """
    Anthropic SDK client with prompt caching.

    The helpers.py source and system prompt are placed in cache_control blocks
    so they are only processed once per cache TTL (5 minutes default).
    """

    def __init__(
        self,
        model: str | None = None,
        max_tokens: int = MAX_TOKENS_DEFAULT,
        api_key: str | None = None,
    ):
        self.model = model or os.environ.get(MODEL_ENV_VAR, MODEL_DEFAULT)
        self.max_tokens = max_tokens
        self._api_key = api_key or os.environ.get("ANTHROPIC_API_KEY")
        self._client = None  # lazy-initialized
        self.usage = TokenUsage()

    def _get_client(self):
        """Lazy-initialize the Anthropic client."""
        if self._client is None:
            try:
                import anthropic  # noqa: PLC0415

                self._client = anthropic.Anthropic(
                    api_key=self._api_key,
                )
                log.info("LLMClient.init", model=self.model)
            except ImportError as exc:
                raise RuntimeError(
                    "anthropic package not installed. Run: pip install anthropic"
                ) from exc
        return self._client

    def chat(
        self,
        messages: list[dict],
        page_context: str | None = None,
    ) -> str:
        """
        Send messages to the LLM with prompt caching on the system prompt.

        Args:
            messages: List of {role, content} dicts (the conversation history).
            page_context: Optional current page state to include in a second
                          cached system block.

        Returns:
            The text content of the LLM response.
        """
        client = self._get_client()

        # Build system blocks with cache_control
        # Block 1: helpers doc (large, stable) — always cached
        system_blocks: list[dict] = [
            {
                "type": "text",
                "text": HELPERS_DOC,
                "cache_control": {"type": "ephemeral"},
            }
        ]

        # Block 2: page context (per-task, cached across steps of same task)
        if page_context:
            system_blocks.append(
                {
                    "type": "text",
                    "text": f"Current page context:\n{page_context}",
                    "cache_control": {"type": "ephemeral"},
                }
            )

        log.debug(
            "LLMClient.chat",
            model=self.model,
            message_count=len(messages),
            system_block_count=len(system_blocks),
        )

        # Use streaming to avoid timeout on long generations
        full_text = ""
        with client.messages.stream(
            model=self.model,
            max_tokens=self.max_tokens,
            system=system_blocks,
            messages=messages,
        ) as stream:
            for text_chunk in stream.text_stream:
                full_text += text_chunk

            # Record token usage from the final message
            final = stream.get_final_message()
            self.usage.record(final.usage)
            log.info(
                "LLMClient.chat.response",
                input_tokens=getattr(final.usage, "input_tokens", 0),
                output_tokens=getattr(final.usage, "output_tokens", 0),
                cache_creation_tokens=getattr(final.usage, "cache_creation_input_tokens", 0),
                cache_read_tokens=getattr(final.usage, "cache_read_input_tokens", 0),
            )

        return full_text

    def get_usage_snapshot(self) -> dict:
        """Return accumulated token usage."""
        return self.usage.to_dict()
