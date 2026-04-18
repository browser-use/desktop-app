"""
exec_sandbox.py — Sandboxed Python execution for agent-generated code.

Security model:
- AST inspection: blocked imports rejected before exec
- Locked namespace: only helpers.* functions + safe builtins + print proxy
- 30-second wall-clock timeout enforced via threading.Timer
- Return value must be JSON-serializable (raises if not)
- File access blocked outside /tmp/agentic-* paths
- All blocked categories raise SandboxViolation

Blocked imports:
    os, subprocess, sys (except stdout/stderr via helpers),
    socket (except via helpers), urllib, requests, httpx,
    builtins.__import__ (except whitelisted modules)

Safe builtins exposed:
    print (proxied to event stream), len, range, int, float, str, bool,
    list, dict, tuple, set, sorted, enumerate, zip, map, filter,
    min, max, abs, round, sum, any, all, isinstance, type, repr,
    json (module), re (module), math (module), datetime (module),
    collections (module), itertools (module)
"""

from __future__ import annotations

import ast
import builtins
import collections
import datetime
import itertools
import json
import math
import os
import re
import textwrap
from collections.abc import Callable
from typing import Any

from .logger import log

# ── Security constants ────────────────────────────────────────────────────────

BLOCKED_MODULES = frozenset(
    {
        "os",
        "subprocess",
        "sys",
        "socket",
        "urllib",
        "urllib.request",
        "urllib.parse",
        "requests",
        "httpx",
        "shutil",
        "pathlib",
        "glob",
        "fnmatch",
        "importlib",
        "importlib.util",
        "importlib.machinery",
        "ctypes",
        "multiprocessing",
        "threading",
        "concurrent",
        "concurrent.futures",
        "asyncio",
        "signal",
        "pty",
        "pdb",
        "code",
        "codeop",
        "pickle",
        "shelve",
        "dbm",
        "sqlite3",
        "ftplib",
        "smtplib",
        "imaplib",
        "poplib",
        "telnetlib",
        "xmlrpc",
        "http",
        "email",
        "html",
        "xml",
    }
)

ALLOWED_MODULES = frozenset(
    {
        "json",
        "re",
        "math",
        "datetime",
        "collections",
        "itertools",
        "functools",
        "operator",
        "string",
        "textwrap",
        "unicodedata",
        "struct",
        "codecs",
        "base64",
        "hashlib",
        "hmac",
        "uuid",
        "decimal",
        "fractions",
        "statistics",
        "random",
        "copy",
        "pprint",
        "traceback",
        "warnings",
        "abc",
        "dataclasses",
        "typing",
        "enum",
    }
)

BLOCKED_BUILTINS = frozenset(
    {
        "open",
        "exec",
        "eval",
        "compile",
        "__import__",
        "breakpoint",
        "input",
        "vars",
        "dir",
        "globals",
        "locals",
        "delattr",
        "setattr",
        "getattr",
        "hasattr",
        "object",
        "type",
        "super",
    }
)

SANDBOX_EXEC_TIMEOUT = 30  # seconds


class SandboxViolation(Exception):
    """Raised when sandboxed code attempts a blocked operation."""

    def __init__(self, message: str, code_snippet: str = ""):
        super().__init__(message)
        self.code_snippet = code_snippet


class ExecTimeout(Exception):
    """Raised when sandboxed code exceeds the wall-clock timeout."""


# ── AST Inspection ────────────────────────────────────────────────────────────


class _ASTInspector(ast.NodeVisitor):
    """Walk the AST and raise SandboxViolation on any blocked construct."""

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            top = alias.name.split(".")[0]
            if top in BLOCKED_MODULES:
                raise SandboxViolation(
                    f"Import of blocked module '{alias.name}' is not allowed",
                    ast.unparse(node),
                )
            if alias.name not in ALLOWED_MODULES and top not in ALLOWED_MODULES:
                raise SandboxViolation(
                    f"Import of module '{alias.name}' is not whitelisted",
                    ast.unparse(node),
                )
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        module = node.module or ""
        top = module.split(".")[0]
        if top in BLOCKED_MODULES:
            raise SandboxViolation(
                f"Import from blocked module '{module}' is not allowed",
                ast.unparse(node),
            )
        if module not in ALLOWED_MODULES and top not in ALLOWED_MODULES:
            raise SandboxViolation(
                f"Import from module '{module}' is not whitelisted",
                ast.unparse(node),
            )
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        """Block calls to dangerous builtins by name."""
        if isinstance(node.func, ast.Name) and node.func.id in BLOCKED_BUILTINS:
            raise SandboxViolation(
                f"Call to blocked builtin '{node.func.id}' is not allowed",
                ast.unparse(node),
            )
        # Block attribute access to __class__, __bases__, etc. (MRO escape)
        if (
            isinstance(node.func, ast.Attribute)
            and node.func.attr.startswith("__")
            and node.func.attr.endswith("__")
            and node.func.attr not in ("__str__", "__repr__", "__len__", "__iter__")
        ):
            raise SandboxViolation(
                f"Attribute access to dunder method '{node.func.attr}' is not allowed",
                ast.unparse(node),
            )
        self.generic_visit(node)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        """Block dangerous attribute patterns."""
        # Block __subclasses__, __mro__, __globals__, etc. (dunder escape routes)
        # C1 fix: also block __traceback__, __cause__, __context__ used in
        # the frame-walking RCE exploit.
        dangerous_dunder_attrs = {
            "__subclasses__",
            "__mro__",
            "__bases__",
            "__globals__",
            "__builtins__",
            "__loader__",
            "__spec__",
            "__import__",
            "__class__",
            "__dict__",
            "__code__",
            "__func__",
            # C1: traceback/exception chain dunders that enable frame walking
            "__traceback__",
            "__cause__",
            "__context__",
        }
        if node.attr in dangerous_dunder_attrs:
            raise SandboxViolation(
                f"Access to restricted attribute '{node.attr}' is not allowed",
                ast.unparse(node),
            )

        # C1 fix: block non-dunder frame/code/coroutine object attributes that
        # are the second step of the frame-walking exploit chain.
        dangerous_nondunder_attrs = {
            # traceback object attributes
            "tb_frame",
            "tb_next",
            "tb_lineno",
            # frame object attributes
            "f_back",
            "f_builtins",
            "f_globals",
            "f_locals",
            "f_code",
            "f_lineno",
            "f_lasti",
            # generator/coroutine/async-generator frame attributes
            "gi_frame",
            "gi_code",
            "cr_frame",
            "cr_code",
            "ag_frame",
            "ag_code",
            # code object attributes
            "co_consts",
            "co_names",
            "co_code",
            "co_varnames",
            "co_cellvars",
            "co_freevars",
            "co_nlocals",
        }
        if node.attr in dangerous_nondunder_attrs:
            raise SandboxViolation(
                f"Access to restricted frame/code attribute '{node.attr}' is not allowed",
                ast.unparse(node),
            )

        self.generic_visit(node)


def inspect_ast(source: str) -> None:
    """Parse and inspect source code AST. Raises SandboxViolation if blocked."""
    try:
        tree = ast.parse(source, mode="exec")
    except SyntaxError as exc:
        raise SandboxViolation(f"Syntax error in generated code: {exc}", source) from exc
    _ASTInspector().visit(tree)


# ── Namespace construction ────────────────────────────────────────────────────


def _make_safe_open():
    """
    Return a restricted open() that only allows /tmp/agentic-* paths.

    Security fixes applied:
    - H1a: os.path.realpath() resolves symlinks and normalizes ../ before
      the prefix check, defeating both symlink attacks and path traversal.
    - H1b: Write/append/create/read-write modes are blocked (r is default).
      Future callers that need write access must opt in via a dedicated API.
    """
    _real_open = builtins.open

    # Modes that imply writing; blocked unless explicitly opted in.
    _WRITE_MODE_CHARS = frozenset("wax+")

    def safe_open(file, mode="r", *args, **kwargs):
        raw_path = str(file)

        # H1b: reject write-capable modes before any path resolution
        if any(c in mode for c in _WRITE_MODE_CHARS):
            raise SandboxViolation(
                f"Write mode '{mode}' is not allowed in the sandbox. "
                "Only read-only ('r') access is permitted.",
                f"open({file!r}, {mode!r}, ...)",
            )

        # H1a: resolve symlinks and normalize ../ components so that a path
        # like /tmp/agentic-x/../../etc/hosts becomes /etc/hosts before check.
        # On macOS /tmp is a symlink to /private/tmp, so we check both canonical
        # prefixes after realpath expansion.
        resolved = os.path.realpath(raw_path)

        _ALLOWED_PREFIXES = ("/tmp/agentic-", "/private/tmp/agentic-")
        if not any(resolved.startswith(p) for p in _ALLOWED_PREFIXES):
            raise SandboxViolation(
                f"File access outside /tmp/agentic-* is not allowed: {raw_path!r} "
                f"(resolved to {resolved!r})",
                f"open({file!r}, ...)",
            )

        log.debug("ExecSandbox.safe_open", path=resolved, mode=mode)
        return _real_open(resolved, mode, *args, **kwargs)

    return safe_open


def _make_print_proxy(print_log: list[str]) -> Callable:
    """Return a print() replacement that logs to the event stream list."""

    def proxy_print(*args, **kwargs):
        sep = kwargs.get("sep", " ")
        text = sep.join(str(a) for a in args)
        print_log.append(text)
        log.info("ExecSandbox.print_proxy", text=text)

    return proxy_print


def build_namespace(
    helpers_module: Any,
    print_log: list[str],
    extra: dict | None = None,
) -> dict:
    """
    Build the restricted exec namespace.

    Args:
        helpers_module: The harnessless helpers module (or a mock in tests).
        print_log: Mutable list that the print proxy appends to.
        extra: Optional extra bindings (e.g. {"result": None}).

    Returns:
        A dict suitable for exec(..., namespace).
    """
    # Extract all public helpers functions
    helpers_ns = {
        name: getattr(helpers_module, name)
        for name in dir(helpers_module)
        if not name.startswith("_")
    }

    safe_builtins = {
        # I/O proxy
        "print": _make_print_proxy(print_log),
        # Core types
        "len": len,
        "range": range,
        "int": int,
        "float": float,
        "str": str,
        "bool": bool,
        "bytes": bytes,
        # Containers
        "list": list,
        "dict": dict,
        "tuple": tuple,
        "set": set,
        "frozenset": frozenset,
        # Iteration
        "sorted": sorted,
        "enumerate": enumerate,
        "zip": zip,
        "map": map,
        "filter": filter,
        "reversed": reversed,
        # Numeric
        "min": min,
        "max": max,
        "abs": abs,
        "round": round,
        "sum": sum,
        "pow": pow,
        "divmod": divmod,
        "hex": hex,
        "oct": oct,
        "bin": bin,
        "ord": ord,
        "chr": chr,
        # Logic
        "any": any,
        "all": all,
        # Inspection (read-only safe ones)
        "isinstance": isinstance,
        "repr": repr,
        "hash": hash,
        "id": id,
        "callable": callable,
        # String
        "format": format,
        # Exceptions
        "Exception": Exception,
        "ValueError": ValueError,
        "TypeError": TypeError,
        "KeyError": KeyError,
        "IndexError": IndexError,
        "RuntimeError": RuntimeError,
        "StopIteration": StopIteration,
        "NotImplementedError": NotImplementedError,
        # Constants
        "True": True,
        "False": False,
        "None": None,
        # Allowed modules
        "json": json,
        "re": re,
        "math": math,
        "datetime": datetime,
        "collections": collections,
        "itertools": itertools,
        "textwrap": textwrap,
    }

    ns: dict[str, Any] = {
        "__builtins__": safe_builtins,
        **helpers_ns,
    }

    if extra:
        ns.update(extra)

    return ns


# ── Sandbox runner ────────────────────────────────────────────────────────────


class ExecSandbox:
    """
    Executes agent-generated Python code in a locked namespace.

    Usage:
        sandbox = ExecSandbox(helpers_module)
        result = sandbox.run(python_code)
    """

    def __init__(self, helpers_module: Any):
        self._helpers = helpers_module

    def run(
        self,
        source: str,
        timeout: int = SANDBOX_EXEC_TIMEOUT,
    ) -> Any:
        """
        Execute `source` in the sandbox.

        - AST-inspects first (raises SandboxViolation on blocked constructs)
        - Executes in a child multiprocessing.Process (H2 fix: no thread zombie)
        - Child process has a virtual memory cap (M1 fix: 512 MB default)
        - Enforces wall-clock timeout; child is hard-killed on timeout
        - Serializes return value to JSON (raises if not serializable)

        Returns the value bound to `__result__` in the namespace, or None.
        Raises:
            SandboxViolation: blocked import/builtin/attribute
            ExecTimeout: code ran longer than `timeout` seconds
            Exception: any other runtime exception from the code
        """
        from .safe_exec_subprocess import run_in_subprocess  # noqa: PLC0415

        # 1. Dedent to handle indented code blocks from LLM
        source = textwrap.dedent(source).strip()
        log.debug("ExecSandbox.run", code_chars=len(source))

        # 2. AST inspection — runs in the parent process before spawning child
        inspect_ast(source)

        # 3. Build namespace
        print_log: list[str] = []
        ns = build_namespace(self._helpers, print_log, extra={"__result__": None})

        log.debug("ExecSandbox.run", note="delegating_to_subprocess", timeout_s=timeout)

        # 4. Execute in subprocess with timeout + memory cap (H2, M1)
        # Pass source string (not compiled code object) — fork context inherits
        # parent memory so no pickling is needed; source string is primitive.
        result = run_in_subprocess(source, ns, timeout_s=timeout)

        # 6. Validate JSON-serializability
        if result is not None:
            try:
                json.dumps(result)
            except (TypeError, ValueError) as exc:
                raise ValueError(f"Sandbox result is not JSON-serializable: {exc}") from exc

        log.debug("ExecSandbox.run.complete", result_type=type(result).__name__)
        return result


# ── Code block extraction ─────────────────────────────────────────────────────


def extract_code_block(llm_response: str) -> str | None:
    """
    Extract the first Python code block from an LLM markdown response.

    Looks for ```python ... ``` or ``` ... ``` blocks.
    Returns the code content, or None if no code block found.
    """
    # Try ```python ... ``` first
    pattern_python = re.compile(r"```python\s*\n(.*?)```", re.DOTALL)
    match = pattern_python.search(llm_response)
    if match:
        return match.group(1).strip()

    # Fallback: generic ``` ... ```
    pattern_generic = re.compile(r"```\s*\n(.*?)```", re.DOTALL)
    match = pattern_generic.search(llm_response)
    if match:
        return match.group(1).strip()

    return None


def llm_indicates_done(llm_response: str) -> bool:
    """
    Heuristic: check if the LLM response indicates task completion.

    Looks for explicit done markers in the response text.
    """
    lower = llm_response.lower()
    done_markers = [
        "task complete",
        "task is complete",
        "task done",
        "task finished",
        "task accomplished",
        "successfully completed",
        "i have completed",
        "i've completed",
        "the task is done",
        "done.",
        "finished.",
        "complete.",
        "__done__",
        "task_done",
    ]
    return any(marker in lower for marker in done_markers)
