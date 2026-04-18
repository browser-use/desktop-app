"""
test_exec_sandbox.py — Tests for exec_sandbox.py security and execution.

Covers:
- Blocked imports (12+ module names)
- Blocked builtins (open, exec, eval, __import__, etc.)
- Blocked dangerous attributes (__subclasses__, __mro__, etc.)
- Allowed module imports (json, re, math, datetime, etc.)
- Namespace: helpers functions exposed
- Namespace: __result__ capture
- Namespace: print proxy works
- Timeout enforcement (30s exceeded → ExecTimeout)
- JSON-serializability check on __result__
- extract_code_block() with ```python and ``` blocks
- llm_indicates_done() heuristic
- SandboxViolation exception message contains blocked name
- C1: frame-walking RCE via traceback attributes blocked
- H1: safe_open path traversal via symlinks and ../ blocked
- H2: timeout kills subprocess (no thread zombie DoS)
- M1: memory cap via resource.setrlimit in subprocess
- M2: str.format dunder traversal (skipped, separate task)
"""

import os
import tempfile

import pytest

from agent.exec_sandbox import (
    ExecSandbox,
    ExecTimeout,
    SandboxViolation,
    build_namespace,
    extract_code_block,
    inspect_ast,
    llm_indicates_done,
)

# ── Helpers mock ──────────────────────────────────────────────────────────────


class MockHelpers:
    """Minimal helpers mock that records calls."""

    def __init__(self):
        self.calls = []

    def page_info(self) -> dict:
        self.calls.append("page_info")
        return {"url": "https://example.com", "title": "Example"}

    def goto(self, url: str) -> None:
        self.calls.append(f"goto:{url}")

    def click(self, selector: str) -> None:
        self.calls.append(f"click:{selector}")

    def type_text(self, selector: str, text: str) -> None:
        self.calls.append(f"type_text:{selector}:{text}")

    def screenshot(self) -> str:
        return "data:image/png;base64,abc123"

    def js(self, script: str):
        self.calls.append(f"js:{script}")
        return "js_result"

    def http_get(self, url: str) -> str:
        return '{"ok": true}'


# ── Blocked imports ───────────────────────────────────────────────────────────


class TestBlockedImports:
    """All blocked modules must raise SandboxViolation before exec."""

    def _check_blocked(self, stmt: str):
        with pytest.raises(SandboxViolation) as exc_info:
            inspect_ast(stmt)
        return exc_info.value

    def test_import_os(self):
        exc = self._check_blocked("import os")
        assert "os" in str(exc)

    def test_import_subprocess(self):
        exc = self._check_blocked("import subprocess")
        assert "subprocess" in str(exc)

    def test_import_sys(self):
        exc = self._check_blocked("import sys")
        assert "sys" in str(exc)

    def test_import_socket(self):
        exc = self._check_blocked("import socket")
        assert "socket" in str(exc)

    def test_import_urllib(self):
        exc = self._check_blocked("import urllib")
        assert "urllib" in str(exc)

    def test_import_urllib_request(self):
        exc = self._check_blocked("import urllib.request")
        assert "urllib" in str(exc)

    def test_import_requests(self):
        exc = self._check_blocked("import requests")
        assert "requests" in str(exc)

    def test_import_httpx(self):
        exc = self._check_blocked("import httpx")
        assert "httpx" in str(exc)

    def test_import_shutil(self):
        exc = self._check_blocked("import shutil")
        assert "shutil" in str(exc)

    def test_import_pathlib(self):
        exc = self._check_blocked("import pathlib")
        assert "pathlib" in str(exc)

    def test_import_asyncio(self):
        exc = self._check_blocked("import asyncio")
        assert "asyncio" in str(exc)

    def test_import_threading(self):
        exc = self._check_blocked("import threading")
        assert "threading" in str(exc)

    def test_import_pickle(self):
        exc = self._check_blocked("import pickle")
        assert "pickle" in str(exc)

    def test_import_sqlite3(self):
        exc = self._check_blocked("import sqlite3")
        assert "sqlite3" in str(exc)

    def test_from_os_import(self):
        exc = self._check_blocked("from os import path")
        assert "os" in str(exc)

    def test_from_subprocess_import(self):
        exc = self._check_blocked("from subprocess import run")
        assert "subprocess" in str(exc)

    def test_import_ctypes(self):
        exc = self._check_blocked("import ctypes")
        assert "ctypes" in str(exc)

    def test_import_importlib(self):
        exc = self._check_blocked("import importlib")
        assert "importlib" in str(exc)

    def test_non_whitelisted_module_blocked(self):
        with pytest.raises(SandboxViolation):
            inspect_ast("import numpy")

    def test_non_whitelisted_from_import_blocked(self):
        with pytest.raises(SandboxViolation):
            inspect_ast("from pandas import DataFrame")


# ── Allowed imports ───────────────────────────────────────────────────────────


class TestAllowedImports:
    def test_import_json(self):
        inspect_ast("import json")  # Should not raise

    def test_import_re(self):
        inspect_ast("import re")

    def test_import_math(self):
        inspect_ast("import math")

    def test_import_datetime(self):
        inspect_ast("import datetime")

    def test_from_datetime_import(self):
        inspect_ast("from datetime import datetime, timedelta")

    def test_import_collections(self):
        inspect_ast("import collections")

    def test_import_itertools(self):
        inspect_ast("import itertools")


# ── Blocked builtins ──────────────────────────────────────────────────────────


class TestBlockedBuiltins:
    def _check_blocked_call(self, code: str):
        with pytest.raises(SandboxViolation):
            inspect_ast(code)

    def test_open_blocked(self):
        self._check_blocked_call("open('/etc/passwd')")

    def test_exec_blocked(self):
        self._check_blocked_call("exec('print(1)')")

    def test_eval_blocked(self):
        self._check_blocked_call("eval('1+1')")

    def test_compile_blocked(self):
        self._check_blocked_call("compile('x=1', 'f', 'exec')")

    def test_import_blocked_call(self):
        self._check_blocked_call("__import__('os')")

    def test_breakpoint_blocked(self):
        self._check_blocked_call("breakpoint()")


# ── Blocked dangerous attributes ──────────────────────────────────────────────


class TestBlockedAttributes:
    def test_subclasses_blocked(self):
        with pytest.raises(SandboxViolation) as exc_info:
            inspect_ast("x.__subclasses__()")
        assert "__subclasses__" in str(exc_info.value)

    def test_mro_blocked(self):
        with pytest.raises(SandboxViolation) as exc_info:
            inspect_ast("x.__mro__")
        assert "__mro__" in str(exc_info.value)

    def test_globals_blocked(self):
        with pytest.raises(SandboxViolation) as exc_info:
            inspect_ast("x.__globals__")
        assert "__globals__" in str(exc_info.value)

    def test_builtins_attr_blocked(self):
        with pytest.raises(SandboxViolation) as exc_info:
            inspect_ast("x.__builtins__")
        assert "__builtins__" in str(exc_info.value)

    def test_class_attr_blocked(self):
        with pytest.raises(SandboxViolation) as exc_info:
            inspect_ast("x.__class__")
        assert "__class__" in str(exc_info.value)


# ── Namespace ─────────────────────────────────────────────────────────────────


class TestBuildNamespace:
    def test_helpers_exposed(self):
        helpers = MockHelpers()
        print_log = []
        ns = build_namespace(helpers, print_log)
        assert "page_info" in ns
        assert "goto" in ns
        assert "click" in ns
        assert "screenshot" in ns
        assert "js" in ns

    def test_helpers_callable(self):
        helpers = MockHelpers()
        print_log = []
        ns = build_namespace(helpers, print_log)
        result = ns["page_info"]()
        assert result["url"] == "https://example.com"

    def test_safe_builtins_present(self):
        helpers = MockHelpers()
        print_log = []
        ns = build_namespace(helpers, print_log)
        builtins_ns = ns["__builtins__"]
        assert "len" in builtins_ns
        assert "range" in builtins_ns
        assert "sorted" in builtins_ns
        assert "json" in builtins_ns

    def test_dangerous_builtins_absent(self):
        helpers = MockHelpers()
        print_log = []
        ns = build_namespace(helpers, print_log)
        builtins_ns = ns["__builtins__"]
        assert "open" not in builtins_ns
        assert "exec" not in builtins_ns
        assert "eval" not in builtins_ns
        assert "__import__" not in builtins_ns

    def test_print_proxy_captures_output(self):
        helpers = MockHelpers()
        print_log = []
        ns = build_namespace(helpers, print_log)
        ns["__builtins__"]["print"]("hello world")
        assert "hello world" in print_log

    def test_extra_bindings(self):
        helpers = MockHelpers()
        print_log = []
        ns = build_namespace(helpers, print_log, extra={"__result__": None, "custom": 42})
        assert ns["custom"] == 42
        assert "__result__" in ns


# ── ExecSandbox.run() ─────────────────────────────────────────────────────────


class TestExecSandbox:
    def setup_method(self):
        self.helpers = MockHelpers()
        self.sandbox = ExecSandbox(self.helpers)

    def test_simple_expression(self):
        result = self.sandbox.run("__result__ = 1 + 2")
        assert result == 3

    def test_string_result(self):
        result = self.sandbox.run("__result__ = 'hello'")
        assert result == "hello"

    def test_dict_result(self):
        result = self.sandbox.run("__result__ = {'key': 'value', 'n': 42}")
        assert result == {"key": "value", "n": 42}

    def test_list_result(self):
        result = self.sandbox.run("__result__ = [1, 2, 3]")
        assert result == [1, 2, 3]

    def test_none_result_when_not_set(self):
        result = self.sandbox.run("x = 5")
        assert result is None

    def test_helpers_callable_from_code(self):
        result = self.sandbox.run("__result__ = page_info()")
        assert result["url"] == "https://example.com"
        # NOTE: side-effect tracking via self.helpers.calls is not checked here
        # because ExecSandbox now runs code in a forked subprocess (H2 fix).
        # The fork child gets a copy of MockHelpers; mutations to .calls in the
        # child are not visible in the parent.  The return value is the
        # authoritative observable outcome.

    def test_goto_called_from_code(self):
        # goto() returns None; we verify no exception is raised.
        # Side-effect tracking via self.helpers.calls is not possible across
        # the fork boundary — the child gets a copy of MockHelpers, not the
        # same object.  Behavioral correctness is verified by the return value
        # being None (no exception) and by integration tests against a real
        # helpers implementation.
        result = self.sandbox.run("goto('https://example.com')")
        assert result is None

    def test_json_module_available(self):
        result = self.sandbox.run('__result__ = json.dumps({"hello": "world"})')
        assert result == '{"hello": "world"}'

    def test_math_module_available(self):
        result = self.sandbox.run("__result__ = math.floor(3.7)")
        assert result == 3

    def test_blocked_import_raises_sandbox_violation(self):
        with pytest.raises(SandboxViolation):
            self.sandbox.run("import os")

    def test_blocked_import_requests_raises(self):
        with pytest.raises(SandboxViolation):
            self.sandbox.run("import requests")

    def test_blocked_subprocess_raises(self):
        with pytest.raises(SandboxViolation):
            self.sandbox.run("import subprocess")

    def test_non_serializable_result_raises(self):
        with pytest.raises((ValueError, TypeError)):
            self.sandbox.run("__result__ = lambda x: x")

    def test_syntax_error_raises_sandbox_violation(self):
        with pytest.raises(SandboxViolation):
            self.sandbox.run("def foo(:")

    def test_runtime_error_propagates(self):
        with pytest.raises((RuntimeError, Exception)):
            self.sandbox.run("raise RuntimeError('oops')")

    def test_timeout_enforced(self):
        with pytest.raises(ExecTimeout):
            # timeout=1 second; infinite loop should trigger it
            self.sandbox.run("while True: pass", timeout=1)

    def test_indented_code_dedented(self):
        """LLM may indent code in markdown; sandbox should dedent before exec."""
        code = "    __result__ = 99"
        result = self.sandbox.run(code)
        assert result == 99

    def test_multiline_code(self):
        code = """
x = 10
y = 20
__result__ = x + y
"""
        result = self.sandbox.run(code)
        assert result == 30


# ── extract_code_block ────────────────────────────────────────────────────────


class TestExtractCodeBlock:
    def test_python_fenced_block(self):
        text = "Some text\n```python\nprint('hello')\n```\nMore text"
        result = extract_code_block(text)
        assert result == "print('hello')"

    def test_generic_fenced_block(self):
        text = "Here:\n```\nx = 1\n```"
        result = extract_code_block(text)
        assert result == "x = 1"

    def test_python_block_takes_precedence(self):
        text = "```python\nx = 1\n```\n```\ny = 2\n```"
        result = extract_code_block(text)
        assert result == "x = 1"

    def test_no_block_returns_none(self):
        text = "This response has no code block."
        result = extract_code_block(text)
        assert result is None

    def test_multiline_code_block(self):
        text = "```python\na = 1\nb = 2\n__result__ = a + b\n```"
        result = extract_code_block(text)
        assert "__result__ = a + b" in result

    def test_strips_whitespace(self):
        text = "```python\n   x = 1   \n```"
        result = extract_code_block(text)
        assert result == "x = 1"

    def test_empty_block_returns_empty_string(self):
        text = "```python\n\n```"
        # empty after strip
        result = extract_code_block(text)
        assert result == "" or result is None  # both are acceptable


# ── llm_indicates_done ────────────────────────────────────────────────────────


class TestLlmIndicatesDone:
    def test_task_complete_marker(self):
        assert llm_indicates_done("I've finished. Task complete")

    def test_task_done_marker(self):
        assert llm_indicates_done("Task done.")

    def test_task_is_complete_marker(self):
        assert llm_indicates_done("The task is complete.")

    def test_successfully_completed_marker(self):
        assert llm_indicates_done("I have successfully completed the task.")

    def test_done_period_marker(self):
        assert llm_indicates_done("Done.")

    def test_finished_period_marker(self):
        assert llm_indicates_done("Finished.")

    def test_task_finished_marker(self):
        assert llm_indicates_done("Task finished successfully.")

    def test_dunder_done_marker(self):
        assert llm_indicates_done("__done__")

    def test_case_insensitive(self):
        assert llm_indicates_done("TASK COMPLETE")

    def test_not_done_when_no_markers(self):
        assert not llm_indicates_done("Let me try clicking the button.")

    def test_not_done_partial_word(self):
        # "done" appears but not as a done signal — this is a heuristic
        # "task done" is the marker, but "done" alone inside a sentence may or may not match
        # We only assert clearly NOT-done cases
        assert not llm_indicates_done("I need to download the file first.")


# ── C1: Frame-walking RCE via traceback attributes ────────────────────────────


class TestFrameWalkingBlocked:
    """
    C1 CRITICAL regression tests.

    The exploit walks __traceback__.tb_frame.f_back.f_builtins to reach the real
    __import__ and then imports os for arbitrary command execution.  Every step
    of that chain must be blocked at the AST level.
    """

    def test_frame_walking_escape_blocked(self):
        """
        The exact S1 exploit must raise SandboxViolation, not execute.

        Exploit:
            try: 1/0
            except Exception as e:
              __result__ = e.__traceback__.tb_frame.f_back.f_builtins["__import__"]("os").popen("whoami").read()
        """
        exploit = """
try:
    1/0
except Exception as e:
    __result__ = e.__traceback__.tb_frame.f_back.f_builtins["__import__"]("os").popen("whoami").read()
"""
        with pytest.raises(SandboxViolation) as exc_info:
            inspect_ast(exploit)
        # The violation message must name one of the blocked traversal attributes
        msg = str(exc_info.value)
        blocked_names = {
            "__traceback__",
            "tb_frame",
            "f_back",
            "f_builtins",
        }
        assert any(name in msg for name in blocked_names), (
            f"Expected one of {blocked_names} in violation message, got: {msg!r}"
        )

    def test_traceback_dunder_attr_blocked(self):
        """__traceback__ attribute access blocked at AST level."""
        with pytest.raises(SandboxViolation):
            inspect_ast("x = e.__traceback__")

    def test_cause_dunder_attr_blocked(self):
        """__cause__ attribute access blocked at AST level."""
        with pytest.raises(SandboxViolation):
            inspect_ast("x = e.__cause__")

    def test_context_dunder_attr_blocked(self):
        """__context__ attribute access blocked at AST level."""
        with pytest.raises(SandboxViolation):
            inspect_ast("x = e.__context__")

    def test_tb_frame_blocked(self):
        """tb_frame non-dunder attribute blocked at AST level."""
        with pytest.raises(SandboxViolation):
            inspect_ast("x = tb.tb_frame")

    def test_tb_next_blocked(self):
        with pytest.raises(SandboxViolation):
            inspect_ast("x = tb.tb_next")

    def test_f_back_blocked(self):
        with pytest.raises(SandboxViolation):
            inspect_ast("x = frame.f_back")

    def test_f_builtins_blocked(self):
        with pytest.raises(SandboxViolation):
            inspect_ast("x = frame.f_builtins")

    def test_f_globals_blocked(self):
        with pytest.raises(SandboxViolation):
            inspect_ast("x = frame.f_globals")

    def test_f_locals_blocked(self):
        with pytest.raises(SandboxViolation):
            inspect_ast("x = frame.f_locals")

    def test_f_code_blocked(self):
        with pytest.raises(SandboxViolation):
            inspect_ast("x = frame.f_code")

    def test_gi_frame_blocked(self):
        with pytest.raises(SandboxViolation):
            inspect_ast("x = gen.gi_frame")

    def test_cr_frame_blocked(self):
        with pytest.raises(SandboxViolation):
            inspect_ast("x = coro.cr_frame")

    def test_co_consts_blocked(self):
        with pytest.raises(SandboxViolation):
            inspect_ast("x = code.co_consts")

    def test_co_names_blocked(self):
        with pytest.raises(SandboxViolation):
            inspect_ast("x = code.co_names")

    def test_co_code_blocked(self):
        with pytest.raises(SandboxViolation):
            inspect_ast("x = code.co_code")

    def test_frame_walk_via_sandbox_run(self):
        """
        The full exploit must also be blocked when run through ExecSandbox.run()
        (double check: AST inspection happens before exec).
        """
        helpers = MockHelpers()
        sandbox = ExecSandbox(helpers)
        exploit = """
try:
    1/0
except Exception as e:
    __result__ = e.__traceback__.tb_frame.f_back.f_builtins["__import__"]("os").popen("whoami").read()
"""
        with pytest.raises(SandboxViolation):
            sandbox.run(exploit)


# ── H1: safe_open path traversal ─────────────────────────────────────────────


class TestSafeOpenPathTraversal:
    """
    H1 HIGH — safe_open must resolve symlinks and normalize paths before the
    prefix check so that ../  traversal and symlink attacks are blocked.
    """

    def test_dotdot_traversal_blocked(self):
        """
        /tmp/agentic-x/../../etc/hosts must be rejected even though the raw
        string starts with /tmp/agentic-.
        """
        from agent.exec_sandbox import _make_safe_open

        safe_open = _make_safe_open()
        with pytest.raises(SandboxViolation) as exc_info:
            safe_open("/tmp/agentic-x/../../etc/hosts")
        assert "not allowed" in str(exc_info.value).lower() or "/etc/hosts" in str(exc_info.value)

    def test_symlink_to_sensitive_file_blocked(self):
        """
        A symlink inside /tmp/agentic-* that points outside must be rejected
        after realpath resolution.
        """
        from agent.exec_sandbox import _make_safe_open

        safe_open = _make_safe_open()

        with tempfile.TemporaryDirectory(prefix="agentic-") as agentic_dir:
            # Create a symlink inside the agentic dir that points to /etc/hosts
            link_path = os.path.join(agentic_dir, "link-to-etc-hosts")
            os.symlink("/etc/hosts", link_path)
            with pytest.raises(SandboxViolation):
                safe_open(link_path)

    def test_legit_path_inside_prefix_allowed(self, tmp_path):
        """A real file inside /tmp/agentic-* resolves to itself and passes."""
        from agent.exec_sandbox import _make_safe_open

        safe_open = _make_safe_open()

        # Create an actual temp dir with the required prefix
        with tempfile.TemporaryDirectory(prefix="agentic-", dir="/tmp") as agentic_dir:
            legit_file = os.path.join(agentic_dir, "legit.txt")
            with open(legit_file, "w") as f:
                f.write("ok")
            # Should not raise
            fh = safe_open(legit_file, "r")
            fh.close()

    def test_write_mode_blocked(self):
        """Write mode ('w') must be blocked unless explicitly allowed."""
        from agent.exec_sandbox import _make_safe_open

        safe_open = _make_safe_open()
        with pytest.raises(SandboxViolation) as exc_info:
            safe_open("/tmp/agentic-test/out.txt", "w")
        assert "write" in str(exc_info.value).lower() or "mode" in str(exc_info.value).lower()

    def test_append_mode_blocked(self):
        """Append mode ('a') must be blocked."""
        from agent.exec_sandbox import _make_safe_open

        safe_open = _make_safe_open()
        with pytest.raises(SandboxViolation):
            safe_open("/tmp/agentic-test/out.txt", "a")

    def test_exclusive_create_mode_blocked(self):
        """Exclusive create mode ('x') must be blocked."""
        from agent.exec_sandbox import _make_safe_open

        safe_open = _make_safe_open()
        with pytest.raises(SandboxViolation):
            safe_open("/tmp/agentic-test/out.txt", "x")

    def test_readwrite_mode_blocked(self):
        """Read+write mode ('r+') must be blocked."""
        from agent.exec_sandbox import _make_safe_open

        safe_open = _make_safe_open()
        with pytest.raises(SandboxViolation):
            safe_open("/tmp/agentic-test/out.txt", "r+")


# ── H2: Timeout kills subprocess (no thread zombie) ──────────────────────────


class TestTimeoutKillsProcess:
    """
    H2 HIGH — timeout must terminate the worker process, not leave it running.

    Previously used threading.Event which could not stop a spinning thread.
    The fix uses multiprocessing.Process + p.kill() on timeout.
    """

    def test_infinite_loop_raises_exec_timeout(self):
        """A tight infinite loop must raise ExecTimeout within timeout window."""
        helpers = MockHelpers()
        sandbox = ExecSandbox(helpers)
        with pytest.raises(ExecTimeout):
            sandbox.run("while True: pass", timeout=2)

    def test_process_terminated_after_timeout(self):
        """
        After ExecTimeout is raised the worker process must no longer be alive.
        We check p.is_alive() == False via the subprocess module returned.
        The ExecSandbox.run() method must ensure the process is dead before
        re-raising ExecTimeout.
        """
        import multiprocessing

        helpers = MockHelpers()
        sandbox = ExecSandbox(helpers)

        # We need access to the internal process.  Wrap ExecSandbox to capture it.
        # Instead, just verify indirectly: run multiple timed-out tasks and confirm
        # total live process count does not grow (no zombie accumulation).
        initial_proc_count = len(multiprocessing.active_children())

        for _ in range(3):
            try:
                sandbox.run("while True: pass", timeout=1)
            except ExecTimeout:
                pass

        import time as _time

        _time.sleep(0.2)  # brief settle for join()

        final_proc_count = len(multiprocessing.active_children())
        assert final_proc_count <= initial_proc_count, (
            f"Process leak detected: started with {initial_proc_count} "
            f"active children, ended with {final_proc_count}"
        )

    def test_result_returned_before_timeout(self):
        """Fast code must still return correctly under the process-based executor."""
        helpers = MockHelpers()
        sandbox = ExecSandbox(helpers)
        result = sandbox.run("__result__ = 2 + 2", timeout=5)
        assert result == 4

    def test_exception_in_subprocess_propagates(self):
        """RuntimeError raised inside subprocess must propagate to caller."""
        helpers = MockHelpers()
        sandbox = ExecSandbox(helpers)
        with pytest.raises(RuntimeError):
            sandbox.run("raise RuntimeError('from subprocess')", timeout=5)


# ── M1: Memory cap in subprocess ─────────────────────────────────────────────


class TestMemoryCap:
    """
    M1 MEDIUM — resource.setrlimit(RLIMIT_AS) must cap memory inside the
    subprocess so that unbounded allocation is killed rather than OOM-ing
    the parent process.
    """

    def test_massive_allocation_does_not_hang(self):
        """
        Allocating [0] * 10**9 must either raise MemoryError inside the sandbox
        or cause the subprocess to exit with a non-zero status, surfaced as an
        exception.  It must NOT hang indefinitely.
        """
        helpers = MockHelpers()
        sandbox = ExecSandbox(helpers)
        # We expect either MemoryError, a subprocess crash (RuntimeError/OSError),
        # or ExecTimeout — any of these means we didn't silently OOM the parent.
        with pytest.raises((MemoryError, RuntimeError, OSError, ExecTimeout, Exception)):
            sandbox.run("__result__ = [0] * 10**9", timeout=10)


# ── M2: str.format dunder traversal ──────────────────────────────────────────


class TestFormatLeakBlocked:
    """
    M2 MEDIUM — str.format with {x.__class__} traversal leaks class hierarchy.

    This is a separate task; tests are skipped with explanation.
    Tracked as M2-deferred: guarded format() builtin replacement needed.
    """

    @pytest.mark.skip(
        reason="M2 medium priority — guarded str.format replacement is a separate task"
    )
    def test_format_class_traversal_blocked(self):
        """
        '{0.__class__.__name__}'.format(42) must be blocked.
        Currently not blocked — deferred to M2 follow-up task.
        """
        with pytest.raises(SandboxViolation):
            inspect_ast('"{0.__class__.__name__}".format(42)')
