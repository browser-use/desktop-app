"""
test_protocol.py — Tests for protocol.py message schemas and encoding.

Covers:
- ok_response / error_response builders
- All event builder functions
- encode_message / parse_request round-trip
- ProtocolError on malformed input
- Version field present on all messages
"""

import json

import pytest

from agent.protocol import (
    ERR_INTERNAL,
    ERR_PARSE_ERROR,
    ERR_UNKNOWN_META,
    PROTOCOL_VERSION,
    REASON_INTERNAL_ERROR,
    REASON_SANDBOX_VIOLATION,
    REASON_STEP_BUDGET_EXHAUSTED,
    REASON_TARGET_LOST,
    REASON_TOKEN_BUDGET_EXHAUSTED,
    ProtocolError,
    encode_message,
    error_response,
    event_step_error,
    event_step_result,
    event_step_start,
    event_target_lost,
    event_task_cancelled,
    event_task_done,
    event_task_failed,
    event_task_started,
    ok_response,
    parse_request,
)

# ── ok_response ───────────────────────────────────────────────────────────────


class TestOkResponse:
    def test_ok_true(self):
        resp = ok_response()
        assert resp["ok"] is True

    def test_version_present(self):
        resp = ok_response()
        assert resp["version"] == PROTOCOL_VERSION

    def test_no_result_by_default(self):
        resp = ok_response()
        assert "result" not in resp

    def test_result_included(self):
        resp = ok_response({"pong": True})
        assert resp["result"] == {"pong": True}


# ── error_response ────────────────────────────────────────────────────────────


class TestErrorResponse:
    def test_ok_false(self):
        resp = error_response(ERR_PARSE_ERROR, "bad json")
        assert resp["ok"] is False

    def test_version_present(self):
        resp = error_response(ERR_PARSE_ERROR, "bad json")
        assert resp["version"] == PROTOCOL_VERSION

    def test_error_shape(self):
        resp = error_response(ERR_INTERNAL, "boom", retryable=True)
        assert resp["error"]["code"] == ERR_INTERNAL
        assert resp["error"]["message"] == "boom"
        assert resp["error"]["retryable"] is True

    def test_not_retryable_by_default(self):
        resp = error_response(ERR_UNKNOWN_META, "nope")
        assert resp["error"]["retryable"] is False


# ── Event builders ────────────────────────────────────────────────────────────


class TestEventBuilders:
    TASK_ID = "test-task-001"

    def _assert_base(self, evt: dict, expected_event: str):
        assert evt["event"] == expected_event
        assert evt["version"] == PROTOCOL_VERSION
        assert evt["task_id"] == self.TASK_ID

    def test_task_started(self):
        evt = event_task_started(self.TASK_ID)
        self._assert_base(evt, "task_started")
        assert "started_at" in evt
        assert isinstance(evt["started_at"], str)

    def test_step_start(self):
        evt = event_step_start(self.TASK_ID, step=3, plan="clicking button")
        self._assert_base(evt, "step_start")
        assert evt["step"] == 3
        assert evt["plan"] == "clicking button"

    def test_step_start_empty_plan(self):
        evt = event_step_start(self.TASK_ID, step=0)
        assert evt["plan"] == ""

    def test_step_result(self):
        evt = event_step_result(
            self.TASK_ID, step=1, result={"url": "https://x.com"}, duration_ms=250
        )
        self._assert_base(evt, "step_result")
        assert evt["step"] == 1
        assert evt["result"] == {"url": "https://x.com"}
        assert evt["duration_ms"] == 250

    def test_step_error_string(self):
        evt = event_step_error(self.TASK_ID, step=2, error="import blocked")
        self._assert_base(evt, "step_error")
        assert evt["step"] == 2
        assert evt["error"] == "import blocked"

    def test_step_error_dict(self):
        evt = event_step_error(self.TASK_ID, step=2, error={"type": "timeout", "message": "30s"})
        assert isinstance(evt["error"], dict)
        assert evt["error"]["type"] == "timeout"

    def test_task_done(self):
        evt = event_task_done(self.TASK_ID, result="finished", steps_used=5, tokens_used=1200)
        self._assert_base(evt, "task_done")
        assert evt["result"] == "finished"
        assert evt["steps_used"] == 5
        assert evt["tokens_used"] == 1200

    def test_task_done_none_result(self):
        evt = event_task_done(self.TASK_ID, result=None, steps_used=1, tokens_used=100)
        assert evt["result"] is None

    def test_task_failed_with_reason(self):
        evt = event_task_failed(self.TASK_ID, reason=REASON_STEP_BUDGET_EXHAUSTED)
        self._assert_base(evt, "task_failed")
        assert evt["reason"] == REASON_STEP_BUDGET_EXHAUSTED
        assert "partial_result" not in evt

    def test_task_failed_with_partial_result(self):
        evt = event_task_failed(
            self.TASK_ID, reason=REASON_TOKEN_BUDGET_EXHAUSTED, partial_result="some data"
        )
        assert evt["partial_result"] == "some data"

    def test_task_cancelled(self):
        evt = event_task_cancelled(self.TASK_ID)
        self._assert_base(evt, "task_cancelled")

    def test_target_lost(self):
        evt = event_target_lost(self.TASK_ID, target_id="page/abc123")
        self._assert_base(evt, "target_lost")
        assert evt["target_id"] == "page/abc123"


# ── encode_message ────────────────────────────────────────────────────────────


class TestEncodeMessage:
    def test_produces_bytes(self):
        data = encode_message({"hello": "world"})
        assert isinstance(data, bytes)

    def test_newline_terminated(self):
        data = encode_message({"x": 1})
        assert data.endswith(b"\n")

    def test_valid_json(self):
        obj = {"event": "task_started", "task_id": "t1"}
        data = encode_message(obj)
        decoded = json.loads(data.decode("utf-8").strip())
        assert decoded == obj

    def test_non_serializable_uses_str_fallback(self):
        # encode_message uses default=str so custom objects become their repr
        class Custom:
            def __str__(self):
                return "custom_obj"

        data = encode_message({"val": Custom()})
        decoded = json.loads(data.decode("utf-8").strip())
        assert decoded["val"] == "custom_obj"

    def test_round_trip_event(self):
        evt = event_task_done("t1", result=42, steps_used=3, tokens_used=500)
        data = encode_message(evt)
        recovered = json.loads(data.decode("utf-8").strip())
        assert recovered["event"] == "task_done"
        assert recovered["result"] == 42


# ── parse_request ─────────────────────────────────────────────────────────────


class TestParseRequest:
    def test_valid_bytes(self):
        raw = b'{"meta": "ping"}'
        msg = parse_request(raw)
        assert msg["meta"] == "ping"

    def test_valid_str(self):
        raw = '{"meta": "shutdown"}'
        msg = parse_request(raw)
        assert msg["meta"] == "shutdown"

    def test_whitespace_stripped(self):
        raw = b'  {"meta": "ping"}  \n'
        msg = parse_request(raw)
        assert msg["meta"] == "ping"

    def test_parse_error_on_bad_json(self):
        with pytest.raises(ProtocolError) as exc_info:
            parse_request(b"not json {{{")
        assert exc_info.value.code == ERR_PARSE_ERROR

    def test_parse_error_on_non_object(self):
        with pytest.raises(ProtocolError) as exc_info:
            parse_request(b"[1, 2, 3]")
        assert exc_info.value.code == ERR_PARSE_ERROR

    def test_parse_error_on_missing_meta(self):
        with pytest.raises(ProtocolError) as exc_info:
            parse_request(b'{"prompt": "do thing"}')
        assert exc_info.value.code == ERR_UNKNOWN_META

    def test_agent_task_shape_preserved(self):
        raw = json.dumps(
            {
                "meta": "agent_task",
                "task_id": "t1",
                "prompt": "click login",
                "per_target_cdp_url": "ws://localhost:9222/devtools/page/abc",
            }
        ).encode()
        msg = parse_request(raw)
        assert msg["meta"] == "agent_task"
        assert msg["task_id"] == "t1"
        assert msg["prompt"] == "click login"

    def test_unicode_decode_error(self):
        with pytest.raises(ProtocolError) as exc_info:
            parse_request(b"\xff\xfe{bad utf8}")
        assert exc_info.value.code == ERR_PARSE_ERROR


# ── Reason string constants ───────────────────────────────────────────────────


class TestReasonConstants:
    def test_all_reasons_are_strings(self):
        reasons = [
            REASON_STEP_BUDGET_EXHAUSTED,
            REASON_TOKEN_BUDGET_EXHAUSTED,
            REASON_SANDBOX_VIOLATION,
            REASON_INTERNAL_ERROR,
            REASON_TARGET_LOST,
        ]
        for r in reasons:
            assert isinstance(r, str)
            assert len(r) > 0

    def test_reason_values_are_snake_case(self):
        reasons = [
            REASON_STEP_BUDGET_EXHAUSTED,
            REASON_TOKEN_BUDGET_EXHAUSTED,
            REASON_SANDBOX_VIOLATION,
            REASON_INTERNAL_ERROR,
            REASON_TARGET_LOST,
        ]
        for r in reasons:
            assert r == r.lower()
            assert " " not in r
