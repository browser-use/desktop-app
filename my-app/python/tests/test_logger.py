"""
test_logger.py — Unit tests for agent/logger.py (D2 compliance).

Covers:
- DEV-mode toggle via NODE_ENV and AGENTIC_DEV env vars
- debug/info are no-ops when DEV=False
- warn/error always emit regardless of DEV flag
- JSONL format: ts (float), level, component, plus ctx fields
- Secret scrubbing: token, password, secret, api_key, authorization, cookie keys redacted
- All 4 levels emit correctly in DEV mode
- _stream parameter routes output away from stderr
"""

from __future__ import annotations

import io
import json
import os
import sys
import time

# ── Helpers ───────────────────────────────────────────────────────────────────


def _reload_logger(node_env: str | None, agentic_dev: str | None):
    """
    Reload agent.logger with patched environment to test the DEV flag.
    Returns the freshly-loaded module.
    """
    orig_node_env = os.environ.get("NODE_ENV")
    orig_agentic_dev = os.environ.get("AGENTIC_DEV")

    try:
        if node_env is None:
            os.environ.pop("NODE_ENV", None)
        else:
            os.environ["NODE_ENV"] = node_env

        if agentic_dev is None:
            os.environ.pop("AGENTIC_DEV", None)
        else:
            os.environ["AGENTIC_DEV"] = agentic_dev

        # Force reimport so module-level DEV is re-evaluated
        if "agent.logger" in sys.modules:
            del sys.modules["agent.logger"]
        import agent.logger as mod

        return mod
    finally:
        # Restore original env
        if orig_node_env is None:
            os.environ.pop("NODE_ENV", None)
        else:
            os.environ["NODE_ENV"] = orig_node_env
        if orig_agentic_dev is None:
            os.environ.pop("AGENTIC_DEV", None)
        else:
            os.environ["AGENTIC_DEV"] = orig_agentic_dev


def _capture(fn, *args, **kwargs) -> dict:
    """Call fn with an injected StringIO _stream and parse the JSONL output."""
    buf = io.StringIO()
    fn(*args, _stream=buf, **kwargs)
    buf.seek(0)
    line = buf.getvalue().strip()
    if not line:
        return {}
    return json.loads(line)


# ── DEV flag behavior ─────────────────────────────────────────────────────────


class TestDevFlag:
    def test_dev_true_when_node_env_missing(self):
        mod = _reload_logger(node_env=None, agentic_dev=None)
        assert mod.DEV is True  # no NODE_ENV set → not production → DEV

    def test_dev_true_when_node_env_development(self):
        mod = _reload_logger(node_env="development", agentic_dev=None)
        assert mod.DEV is True

    def test_dev_false_when_node_env_production_and_no_agentic_dev(self):
        mod = _reload_logger(node_env="production", agentic_dev=None)
        assert mod.DEV is False

    def test_dev_true_when_node_env_production_but_agentic_dev_1(self):
        mod = _reload_logger(node_env="production", agentic_dev="1")
        assert mod.DEV is True

    def test_dev_false_when_agentic_dev_is_0(self):
        mod = _reload_logger(node_env="production", agentic_dev="0")
        assert mod.DEV is False

    def test_dev_false_when_agentic_dev_is_true_string(self):
        """Only "1" activates the override; "true" does not."""
        mod = _reload_logger(node_env="production", agentic_dev="true")
        assert mod.DEV is False


# ── debug / info are no-ops in production ─────────────────────────────────────


class TestDebugInfoNoOpsInProduction:
    def setup_method(self):
        self._mod = _reload_logger(node_env="production", agentic_dev=None)

    def test_debug_no_output_in_prod(self):
        buf = io.StringIO()
        self._mod.log.debug("Test.component", _stream=buf, key="value")
        assert buf.getvalue() == ""

    def test_info_no_output_in_prod(self):
        buf = io.StringIO()
        self._mod.log.info("Test.component", _stream=buf, key="value")
        assert buf.getvalue() == ""

    def test_warn_emits_in_prod(self):
        buf = io.StringIO()
        self._mod.log.warn("Test.component", _stream=buf, key="value")
        assert buf.getvalue() != ""

    def test_error_emits_in_prod(self):
        buf = io.StringIO()
        self._mod.log.error("Test.component", _stream=buf, key="value")
        assert buf.getvalue() != ""


# ── All 4 levels emit in DEV mode ─────────────────────────────────────────────


class TestAllLevelsInDev:
    def setup_method(self):
        self._mod = _reload_logger(node_env="development", agentic_dev=None)

    def test_debug_emits_in_dev(self):
        buf = io.StringIO()
        self._mod.log.debug("Comp.method", _stream=buf, x=1)
        assert buf.getvalue() != ""

    def test_info_emits_in_dev(self):
        buf = io.StringIO()
        self._mod.log.info("Comp.method", _stream=buf, x=1)
        assert buf.getvalue() != ""

    def test_warn_emits_in_dev(self):
        buf = io.StringIO()
        self._mod.log.warn("Comp.method", _stream=buf, x=1)
        assert buf.getvalue() != ""

    def test_error_emits_in_dev(self):
        buf = io.StringIO()
        self._mod.log.error("Comp.method", _stream=buf, x=1)
        assert buf.getvalue() != ""


# ── JSONL format ──────────────────────────────────────────────────────────────


class TestJsonlFormat:
    def setup_method(self):
        self._mod = _reload_logger(node_env="development", agentic_dev=None)

    def test_output_is_valid_json(self):
        buf = io.StringIO()
        self._mod.log.warn("Test.warn", _stream=buf, reason="x")
        line = buf.getvalue().strip()
        assert json.loads(line)  # does not raise

    def test_newline_terminated(self):
        buf = io.StringIO()
        self._mod.log.warn("Test.warn", _stream=buf)
        assert buf.getvalue().endswith("\n")

    def test_ts_field_is_float(self):
        entry = _capture(self._mod.log.warn, "Test.warn", reason="x")
        assert isinstance(entry["ts"], float)
        assert entry["ts"] > 0

    def test_ts_is_recent(self):
        before = time.time()
        entry = _capture(self._mod.log.warn, "Test.warn")
        after = time.time()
        assert before <= entry["ts"] <= after

    def test_level_field_present(self):
        entry = _capture(self._mod.log.warn, "Test.warn")
        assert entry["level"] == "warn"

    def test_component_field_present(self):
        entry = _capture(self._mod.log.debug, "AgentLoop.run", task_id="t1")
        assert entry["component"] == "AgentLoop.run"

    def test_ctx_fields_merged_into_entry(self):
        entry = _capture(self._mod.log.error, "Budget.check", task_id="t1", step=3)
        assert entry["task_id"] == "t1"
        assert entry["step"] == 3

    def test_level_debug(self):
        entry = _capture(self._mod.log.debug, "X.y", val=1)
        assert entry["level"] == "debug"

    def test_level_info(self):
        entry = _capture(self._mod.log.info, "X.y", val=1)
        assert entry["level"] == "info"

    def test_level_warn(self):
        entry = _capture(self._mod.log.warn, "X.y", val=1)
        assert entry["level"] == "warn"

    def test_level_error(self):
        entry = _capture(self._mod.log.error, "X.y", val=1)
        assert entry["level"] == "error"

    def test_no_extra_fields_on_empty_ctx(self):
        entry = _capture(self._mod.log.warn, "X.y")
        assert set(entry.keys()) == {"ts", "level", "component"}

    def test_non_serializable_value_uses_str_fallback(self):
        """Objects that aren't JSON-serializable are converted via default=str."""

        class Weird:
            def __str__(self):
                return "weird_value"

        entry = _capture(self._mod.log.warn, "X.y", obj=Weird())
        assert entry["obj"] == "weird_value"


# ── Secret scrubbing ──────────────────────────────────────────────────────────


class TestSecretScrubbing:
    def setup_method(self):
        self._mod = _reload_logger(node_env="development", agentic_dev=None)

    def _emit(self, **kwargs) -> dict:
        return _capture(self._mod.log.warn, "Test.secrets", **kwargs)

    def test_token_key_redacted(self):
        entry = self._emit(token="abc123")
        assert entry["token"] == "[REDACTED]"

    def test_password_key_redacted(self):
        entry = self._emit(password="hunter2")
        assert entry["password"] == "[REDACTED]"

    def test_secret_key_redacted(self):
        entry = self._emit(secret="s3cr3t")
        assert entry["secret"] == "[REDACTED]"

    def test_api_key_redacted(self):
        entry = self._emit(api_key="sk-1234")
        assert entry["api_key"] == "[REDACTED]"

    def test_authorization_key_redacted(self):
        entry = self._emit(authorization="Bearer xyz")
        assert entry["authorization"] == "[REDACTED]"

    def test_cookie_key_redacted(self):
        entry = self._emit(cookie="session=abc")
        assert entry["cookie"] == "[REDACTED]"

    def test_safe_key_not_redacted(self):
        entry = self._emit(task_id="t1", step=3)
        assert entry["task_id"] == "t1"
        assert entry["step"] == 3

    def test_partial_match_redacted(self):
        """Keys containing secret words anywhere in the name are scrubbed."""
        entry = self._emit(access_token="tkn")
        assert entry["access_token"] == "[REDACTED]"

    def test_case_insensitive_scrubbing(self):
        entry = self._emit(TOKEN="abc")
        assert entry["TOKEN"] == "[REDACTED]"

    def test_multiple_safe_and_secret_keys(self):
        entry = self._emit(task_id="t1", password="x", step=2, api_key="y")
        assert entry["task_id"] == "t1"
        assert entry["step"] == 2
        assert entry["password"] == "[REDACTED]"
        assert entry["api_key"] == "[REDACTED]"

    def test_original_ctx_not_mutated(self):
        """_scrub must return a new dict; original kwargs must be untouched."""
        original = {"task_id": "t1", "token": "real_token"}
        buf = io.StringIO()
        self._mod.log.warn("X.y", _stream=buf, **original)
        # original dict passed in is not modified
        assert original["token"] == "real_token"


# ── AGENTIC_DEV override in production ───────────────────────────────────────


class TestAgenticDevOverride:
    def test_debug_emits_when_agentic_dev_1_in_prod(self):
        mod = _reload_logger(node_env="production", agentic_dev="1")
        buf = io.StringIO()
        mod.log.debug("Test.debug", _stream=buf, x=1)
        assert buf.getvalue() != ""

    def test_info_emits_when_agentic_dev_1_in_prod(self):
        mod = _reload_logger(node_env="production", agentic_dev="1")
        buf = io.StringIO()
        mod.log.info("Test.info", _stream=buf, x=1)
        assert buf.getvalue() != ""
