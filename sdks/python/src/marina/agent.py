# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Talking to other participants: ask and wait for the answer, wait for a question.

The rules are the TypeScript SDK's (`tellAndAwait`, `waitForTell`), so a Python agent and a
TypeScript one behave the same in a conversation.
"""

from __future__ import annotations

import re
import secrets
import threading
import time
from typing import Any, Optional

from .client import Connection, MarinaError
from .wire import Frame

TELL_NOTICE_PREFIX = "[notice]"
"""A tell starting with this is a lifecycle notice ("I paused"), never an answer."""

TELL_NOTICE_PATTERNS = (
    re.compile(r"^\[notice\]", re.IGNORECASE),
    re.compile(r"^I've spent my model-call budget\b"),
    re.compile(r"^I've hit a .+ and paused\b"),
    re.compile(r"^I've hit \d+ consecutive upstream errors\b"),
)
"""Stable prefixes of the notices agents send today. Kept narrow: a false match swallows a reply."""

TELL_AWAIT_GRACE = 1.5
"""Seconds an untagged reply is held in case a reply echoing the correlation tag follows."""

_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"


class TellTimeout(MarinaError):
    """No reply arrived in time."""


def is_tell_notice(text: str) -> bool:
    """True when `text` is a known system notice rather than a reply."""
    trimmed = text.lstrip()
    return any(pattern.search(trimmed) for pattern in TELL_NOTICE_PATTERNS)


def new_correlation_id() -> str:
    """Six base-36 characters for a `[re:<id>]` tag."""
    return "".join(_ALPHABET[b % len(_ALPHABET)] for b in secrets.token_bytes(6))


def correlation_tag(correlation_id: str) -> str:
    """The tag appended to an outgoing correlated tell: ` [re:<id>]`."""
    return f" [re:{correlation_id}]"


def _tag_pattern(correlation_id: str) -> re.Pattern[str]:
    return re.compile(r"\s*\[?re:" + re.escape(correlation_id) + r"\]?")


def has_correlation_tag(text: str, correlation_id: str) -> bool:
    """True when `text` carries `re:<id>`, bracketed or bare."""
    return bool(_tag_pattern(correlation_id).search(text))


def strip_correlation_tag(text: str, correlation_id: str) -> str:
    """`text` without any `[re:<id>]` / `re:<id>`, trimmed."""
    return _tag_pattern(correlation_id).sub("", text).strip()


def tell_of(frame: Frame) -> Optional[tuple[str, str]]:
    """(sender name, text) when `frame` is a tell to you; None otherwise (your own echo included)."""
    data = frame.get("data")
    if frame.get("tag") != "tell" or not isinstance(data, dict):
        return None
    sender = data.get("senderName")
    if not isinstance(sender, str):
        return None
    text = data.get("message")
    if text is None:
        text = data.get("text")
    return sender, "" if text is None else str(text)


def _tell_text(data: dict[str, Any]) -> str:
    for key in ("message", "text"):
        value = data.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


def tell_and_await(
    connection: Connection,
    target: str,
    message: str,
    timeout: float = 30.0,
    *,
    correlate: bool = True,
    grace: float = TELL_AWAIT_GRACE,
    ignore_notices: bool = True,
    strict_correlation: bool = False,
) -> str:
    """Tell `target` something and wait for its reply; returns the reply's text.

    Which tell is the reply: one from `target` that arrives after your own tell's echo (or carries
    a server time after you sent), is not a notice (`is_tell_notice`), and, with `correlate`,
    echoes the ` [re:<id>]` tag appended to your message. An untagged reply is accepted after
    `grace` seconds if no tagged one follows (never with `strict_correlation`). The tag is
    stripped from the text. Raises TellTimeout when nothing arrives in time.
    """
    if not connection.session:
        raise MarinaError("Not connected.")
    correlate = strict_correlation or correlate
    correlation_id = new_correlation_id() if correlate else None
    outgoing = f"{message}{correlation_tag(correlation_id)}" if correlation_id else message
    key = target.lower()
    sent_at = time.time() * 1000
    deadline = time.monotonic() + timeout
    lock = threading.Lock()
    done = threading.Event()
    state: dict[str, Any] = {"armed": False, "candidate": None, "reply": None, "timer": None}

    def finish(text: str) -> None:
        with lock:
            if done.is_set():
                return
            state["reply"] = strip_correlation_tag(text, correlation_id) if correlation_id else text
            done.set()

    def waiter(frame: Frame) -> None:
        if done.is_set() or frame.get("kind") != "message" or frame.get("tag") != "tell":
            return
        data = frame.get("data")
        data = data if isinstance(data, dict) else {}
        text = _tell_text(data)
        sender = data.get("senderName")
        if not isinstance(sender, str):
            # Our own echo (`You tell <target>: <outgoing>`): everything after it is fresh.
            if not state["armed"] and outgoing in text:
                state["armed"] = True
            return
        if sender.lower() != key:
            return
        stamp = frame.get("timestamp")
        fresh = isinstance(stamp, (int, float)) and not isinstance(stamp, bool) and stamp >= sent_at
        if not state["armed"] and not fresh:
            return  # a queued tell that predates the question
        if ignore_notices and is_tell_notice(text):
            return
        if not correlation_id or has_correlation_tag(text, correlation_id):
            finish(text)
            return
        if strict_correlation or state["candidate"] is not None:
            return
        state["candidate"] = text
        timer = threading.Timer(max(0.0, min(grace, deadline - time.monotonic())), finish, (text,))
        timer.daemon = True
        state["timer"] = timer
        timer.start()

    connection._add_waiter(waiter)
    try:
        connection.command(f"tell {target} {outgoing}", timeout=max(0.001, deadline - time.monotonic()))
        done.wait(max(0.0, deadline - time.monotonic()))
        if not done.is_set() and state["candidate"] is not None:
            finish(state["candidate"])
    finally:
        connection._remove_waiter(waiter)
        if state["timer"]:
            state["timer"].cancel()
    if not done.is_set():
        raise TellTimeout(f'No reply from "{target}" within {timeout:g} s.')
    return state["reply"]


def wait_for_tell(connection: Connection, from_: Optional[str] = None, timeout: float = 30.0) -> str:
    """Wait for a tell to you (from anyone, or from `from_`); returns its text.

    Raises TellTimeout when none arrives in time.
    """
    key = from_.lower() if from_ is not None else None
    done = threading.Event()
    heard: list[str] = []

    def waiter(frame: Frame) -> None:
        tell = tell_of(frame)
        if done.is_set() or not tell or (key is not None and tell[0].lower() != key):
            return
        heard.append(tell[1])
        done.set()

    connection._add_waiter(waiter)
    try:
        done.wait(timeout)
    finally:
        connection._remove_waiter(waiter)
    if not heard:
        raise TellTimeout(f"No tell{f' from {from_}' if from_ else ''} within {timeout:g} s.")
    return heard[0]


__all__ = [
    "TELL_AWAIT_GRACE",
    "TELL_NOTICE_PATTERNS",
    "TELL_NOTICE_PREFIX",
    "TellTimeout",
    "correlation_tag",
    "has_correlation_tag",
    "is_tell_notice",
    "new_correlation_id",
    "strip_correlation_tag",
    "tell_and_await",
    "tell_of",
    "wait_for_tell",
]
