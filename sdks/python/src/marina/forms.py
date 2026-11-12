# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Typed command forms: fill in a command's fields and get the command line, checked.

`capabilities()` lists every command with its `forms`, each a grammar (`say <message>`) broken
into fields. `compose_command` turns values into the command, with the TypeScript SDK's checks
(`composeCommand`), so a form filled in Python is refused or accepted exactly as anywhere else.

>>> form = find_form(marina.capabilities(), "say", "say ")
>>> compose_command(form, {"message": "hello"})
ComposedCommand(command='say hello', errors={})
"""

from __future__ import annotations

import json
import math
import re
from decimal import Decimal
from typing import Any, Literal, NamedTuple, Optional, TypedDict

try:  # Python 3.11+
    from typing import NotRequired
except ImportError:  # pragma: no cover - Python 3.10: read by type checkers only
    NotRequired = Optional  # type: ignore[assignment,misc]


class CommandField(TypedDict):
    """One value a form asks for."""

    id: str
    label: str
    placeholder: str
    kind: Literal["text", "number", "json", "choice"]
    multiline: bool
    allowNewlines: bool
    optionalGroup: NotRequired[str]
    choices: NotRequired[list[str]]
    min: NotRequired[float]
    max: NotRequired[float]
    integer: NotRequired[bool]
    default: NotRequired[str]


class CommandForm(TypedDict):
    """One usage form of a command, as the capabilities reply carries it."""

    syntax: str
    label: str
    fields: list[CommandField]
    groups: list[dict[str, Any]]
    parts: list[dict[str, Any]]
    encoding: NotRequired[Literal["command", "named"]]
    effect: NotRequired[str]
    description: NotRequired[str]
    examples: NotRequired[list[str]]
    inputSchema: NotRequired[dict[str, Any]]


class ComposedCommand(NamedTuple):
    """The command line, and an error per field id that is missing or wrong (empty when none)."""

    command: str
    errors: dict[str, str]


def forms_of(capabilities: dict[str, Any], command: str) -> list[CommandForm]:
    """The forms of one command in a `capabilities()` reply ([] when it has none)."""
    for entry in capabilities.get("commands") or []:
        if isinstance(entry, dict) and entry.get("name") == command:
            return list(entry.get("forms") or [])
    return []


def find_form(capabilities: dict[str, Any], command: str, syntax_prefix: str = "") -> Optional[CommandForm]:
    """The first form of `command` whose syntax starts with `syntax_prefix`, if any."""
    return next((f for f in forms_of(capabilities, command) if f.get("syntax", "").startswith(syntax_prefix)), None)


_DECIMAL = re.compile(r"[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?")
_RADIX = re.compile(r"0([xXoObB])([0-9a-fA-F]+)")
_JS_SPACE = " \t\n\v\f\r                 　﻿"


_JS_SPACE_RE = re.compile(f"[{_JS_SPACE}]")


def _js_trim(text: str) -> str:
    return text.strip(_JS_SPACE)


def js_number(text: str) -> float:
    """JavaScript's `Number(text)`: NaN when it is not a number."""
    value = _js_trim(text)
    if not value:
        return 0.0
    if _DECIMAL.fullmatch(value):
        return float(value)
    if value in ("Infinity", "+Infinity"):
        return math.inf
    if value == "-Infinity":
        return -math.inf
    radix = _RADIX.fullmatch(value)
    if radix:
        base = {"x": 16, "o": 8, "b": 2}[radix.group(1).lower()]
        try:
            return float(int(radix.group(2), base))
        except ValueError:
            return math.nan
    return math.nan


def _js_number_text(value: float) -> str:
    """JavaScript's `String(number)` for a finite number."""
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    _, digit_tuple, exponent = Decimal(repr(abs(value))).as_tuple()
    digits = "".join(map(str, digit_tuple))
    stripped = digits.rstrip("0")
    exponent = int(exponent) + len(digits) - len(stripped)
    digits = stripped
    point = len(digits) + exponent
    k, n = len(digits), point
    if k <= n <= 21:
        out = digits + "0" * (n - k)
    elif 0 < n <= 21:
        out = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * -n + digits
    else:
        e = n - 1
        out = digits[0] + ("." + digits[1:] if k > 1 else "") + "e" + ("+" if e >= 0 else "-") + str(abs(e))
    return sign + out


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not JSON")


def _js_json_parse(text: str) -> Any:
    """`JSON.parse`: every number a double, no NaN or Infinity."""
    return json.loads(text, parse_int=float, parse_constant=_reject_constant)


_LONE_SURROGATE = re.compile("[\ud800-\udfff]")
_INDEX_KEY = re.compile(r"0|[1-9]\d*")


def _js_json_stringify(value: Any) -> str:
    """`JSON.stringify` of what `_js_json_parse` returned, byte for byte."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, float):
        return _js_number_text(value) if math.isfinite(value) else "null"
    if isinstance(value, str):
        text = json.dumps(value, ensure_ascii=False)
        return _LONE_SURROGATE.sub(lambda m: f"\\u{ord(m.group()):04x}", text)
    if isinstance(value, list):
        return "[" + ",".join(_js_json_stringify(v) for v in value) + "]"
    # Integer-like keys come first, in numeric order, as in a JavaScript object.
    keys = list(value)
    index = sorted((k for k in keys if _INDEX_KEY.fullmatch(k) and int(k) < 2**32 - 1), key=int)
    ordered = index + [k for k in keys if k not in set(index)]
    return "{" + ",".join(f"{_js_json_stringify(k)}:{_js_json_stringify(value[k])}" for k in ordered) + "}"


def _bound(value: Optional[float], fallback: str) -> str:
    return fallback if value is None else _js_number_text(float(value))


def compose_command(
    form: CommandForm,
    values: dict[str, str],
    enabled: Optional[dict[str, bool]] = None,
) -> ComposedCommand:
    """The command line for `form` filled in with `values`, and what is missing or wrong.

    `values` are keyed by field id (`field-0`) or by field label (`message`). `enabled` turns
    optional groups (`option-0`) on; a group left off is left out of the command. A field left
    empty falls back to its default. The command is only meaningful when `errors` is empty.
    """
    enabled = enabled or {}
    if form.get("encoding") == "named":
        return ComposedCommand("", {"form": "Use this form's named tool, or choose a command form"})
    errors: dict[str, str] = {}
    fields = form.get("fields") or []
    syntax = form.get("syntax", "")

    def emit(parts: list[dict[str, Any]]) -> list[tuple[str, bool]]:
        out: list[tuple[str, bool]] = []
        for part in parts:
            if part.get("group"):
                if enabled.get(part["group"]):
                    out += emit(part.get("children") or [])
                continue
            if "literal" in part and part["literal"] is not None:
                literal = str(part["literal"])
                out.append((literal, literal.endswith((":", "="))))
                continue
            f = next(field for field in fields if field.get("id") == part.get("field"))
            out.append((_field_value(f, values, errors, syntax), False))
        return out

    command = ""
    join = True
    for text, joins in emit(form.get("parts") or []):
        command += ("" if join or text in ("\n", ":", "=") else " ") + text
        join = joins or text == "\n"
    return ComposedCommand(command, errors)


def _field_value(f: CommandField, values: dict[str, str], errors: dict[str, str], syntax: str) -> str:
    fid = f["id"]
    raw = values.get(fid)
    if raw is None:
        raw = values.get(f.get("label", ""))
    if raw is None:
        raw = f.get("default")
    raw = "" if raw is None else str(raw)
    value = raw if f.get("allowNewlines") else _js_trim(raw)
    kind = f.get("kind")
    number = js_number(value) if kind == "number" else math.nan
    if not value:
        errors[fid] = "Required"
    elif re.search(r"[\r\n]", value) and kind != "json" and not f.get("allowNewlines"):
        errors[fid] = "Use a single line"
    elif " | " in syntax and "|" in value and kind != "json":
        errors[fid] = "This field cannot contain a pipe separator"
    elif not f.get("multiline") and kind != "choice" and _JS_SPACE_RE.search(value):
        errors[fid] = "Use one value without spaces"
    elif kind == "number" and not math.isfinite(number):
        errors[fid] = "Enter a number"
    elif kind == "number" and f.get("integer") and not (number.is_integer() and abs(number) <= 2**53 - 1):
        errors[fid] = "Enter an integer"
    elif kind == "number" and (
        (f.get("min") is not None and number < f["min"]) or (f.get("max") is not None and number > f["max"])
    ):
        errors[fid] = f"Enter a number between {_bound(f.get('min'), '−∞')} and {_bound(f.get('max'), '∞')}"
    elif kind == "choice" and value not in (f.get("choices") or []):
        errors[fid] = "Choose one of the available values"
    elif kind == "json":
        try:
            parsed = _js_json_parse(value)
            if re.search("scalar", f.get("placeholder", ""), re.IGNORECASE) and isinstance(parsed, (dict, list)):
                errors[fid] = "Enter a JSON string, number, boolean, or null"
        except ValueError:
            errors[fid] = "Enter valid JSON"
    if kind == "json" and value and fid not in errors:
        return _js_json_stringify(_js_json_parse(value))
    return value


__all__ = [
    "CommandField",
    "CommandForm",
    "ComposedCommand",
    "compose_command",
    "find_form",
    "forms_of",
    "js_number",
]
