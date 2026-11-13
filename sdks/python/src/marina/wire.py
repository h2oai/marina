# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
"""`marina.wire.v1`: what the server sends, read into Python.

The protocol is protocol/README.md and protocol/marina.wire.v1.schema.json in the Marina
repository. The coding types here name exactly the schema's fields; the repository's tests hold
them to it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Optional

WIRE_PROTOCOL = "marina.wire.v1"

Frame = dict[str, Any]
"""One server frame: `{"kind": ..., "timestamp": ..., "tag"?: ..., "data": {...}}`."""

#: What kind of step a coding activity is.
CODING_ACTIVITY_KINDS = (
    "read",
    "search",
    "edit",
    "write",
    "patch",
    "run",
    "verify",
    "plan",
    "summary",
    "other",
)
#: What the checks said. Only `passed` means checks ran on the change and passed;
#: `not_applicable`: the task changed no files, so there was nothing to verify.
VERIFICATIONS = (
    "passed",
    "not_applicable",
    "failed",
    "not_run",
    "error",
    "missing",
    "stale",
    "unbound",
    "unavailable",
)
#: How a run ended. `submitted`: the coder finished and handed the change in for review.
RUN_OUTCOMES = ("submitted", "failed", "cancelled", "interrupted")

KnownFrame = Literal[
    "Welcome",
    "Session",
    "AuthError",
    "CommandResult",
    "Error",
    "CapabilitiesReply",
    "ContextPreviewReply",
    "MemoryService",
    "ExecApproval",
    "Code",
    "Tell",
    "Onboarding",
    "Output",
]


def classify_frame(frame: Frame) -> KnownFrame:
    """Which well-known frame this is, by the protocol's dispatch rule ("Telling frames apart").

    `Output` is ordinary world output. Every Marina SDK checks in this order.
    """
    data = frame.get("data") or {}
    if not isinstance(data, dict):
        data = {}
    kind, tag = frame.get("kind"), frame.get("tag")
    if kind == "auth_error":
        return "AuthError"
    if kind == "error":
        return "Error"
    if data.get("command_result"):
        return "CommandResult"
    if kind == "system" and isinstance(data.get("entityId"), str):
        return "Session"
    if kind == "system" and data.get("protocol") and data.get("schema"):
        return "Welcome"
    if tag == "capabilities":
        return "CapabilitiesReply"
    if tag == "context_preview":
        return "ContextPreviewReply"
    if data.get("memory_service"):
        return "MemoryService"
    if data.get("execApproval"):
        return "ExecApproval"
    if data.get("code"):
        return "Code"
    if tag == "tell":
        return "Tell"
    if tag == "onboarding":
        return "Onboarding"
    return "Output"


def frame_text(frame: Frame) -> str:
    """The frame's text for people (may carry ANSI colour codes), or ""."""
    data = frame.get("data") or {}
    text = data.get("text") if isinstance(data, dict) else None
    return text if isinstance(text, str) else ""


# ─── Coding ───────────────────────────────────────────────────────────────


@dataclass
class CodingActivity:
    """One step the coder took."""

    kind: str
    """One of CODING_ACTIVITY_KINDS."""
    label: str
    """One line in plain words: "Edit paginate.js"."""
    path: Optional[str] = None
    diff: Optional[list[str]] = None
    """The change, as unified-diff body lines (`-old`, `+new`, ` context`), capped."""
    more: Optional[int] = None
    """Diff lines left out past the cap."""
    quiet: Optional[bool] = None
    """Bookkeeping; a UI may hide it."""


@dataclass
class BudgetForced:
    reason: str
    used: Optional[float] = None
    cap: Optional[float] = None


@dataclass
class RunResult:
    """How a coding run ended. Review it with `marina.code.review(result.run_id, "approve")`.

    The fields are the protocol's Run result, in snake_case (`runId` is `run_id`).
    """

    run_id: str
    terminal: bool
    phase: str
    """`completed` or `failed`."""
    task_id: Optional[int] = None
    agent: Optional[str] = None
    outcome: Optional[str] = None
    """One of RUN_OUTCOMES. `submitted`: handed in for review."""
    reason: Optional[str] = None
    """`blocked`, `agent_died`, or free text."""
    detail: Optional[str] = None
    summary: Optional[str] = None
    summary_id: Optional[str] = None
    verification: Optional[str] = None
    """One of VERIFICATIONS. Only `passed` means checks ran on the change and passed."""
    verification_reason: Optional[str] = None
    budget_forced: Optional[BudgetForced] = None
    """Present when a budget forced the answer; never a free answer."""
    raw: dict[str, Any] = field(default_factory=dict, repr=False)
    """Everything the server sent, as sent, including fields newer than this SDK."""

    @property
    def submitted(self) -> bool:
        """The coder finished and handed the change in for review."""
        return self.outcome == "submitted"

    @property
    def verified(self) -> bool:
        """Checks ran on the change and passed."""
        return self.verification == "passed"


@dataclass
class CodeEvent:
    """One coding event, as the server sent it (`data.code` of a `code` frame)."""

    event: str
    """`agent_output`, `code_lifecycle`, `verification_finished`, ..."""
    type: str
    """Payload shape: `stream`, `lifecycle`, `diff`, `file`, `verification`, ..."""
    text: str
    """For people: print it as is (it may carry ANSI colour codes)."""
    session_id: Optional[str] = None
    run_id: Optional[str] = None
    phase: Optional[str] = None
    kind: Optional[str] = None
    """On `agent_output`: a step (`tool`), the coder's words (`prose`), or a failure."""
    activity: Optional[CodingActivity] = None
    result: Optional[RunResult] = None
    """On the end of a run."""
    raw: Frame = field(default_factory=dict, repr=False)


@dataclass
class ExecApprovalRequest:
    """The coder asks to run a command outside its allowlist."""

    token: str
    argv: list[str]
    cwd: str
    rendered: str
    """The command as one line, for people."""


def _dict(value: Any) -> Optional[dict[str, Any]]:
    return value if isinstance(value, dict) else None


def _str(value: Any) -> Optional[str]:
    return value if isinstance(value, str) else None


def _activity(value: Any) -> Optional[CodingActivity]:
    a = _dict(value)
    if not a or not isinstance(a.get("label"), str) or not isinstance(a.get("kind"), str):
        return None
    diff = a.get("diff")
    return CodingActivity(
        kind=a["kind"],
        label=a["label"],
        path=_str(a.get("path")),
        diff=[line for line in diff if isinstance(line, str)] if isinstance(diff, list) else None,
        more=a.get("more") if isinstance(a.get("more"), int) else None,
        quiet=a.get("quiet") if isinstance(a.get("quiet"), bool) else None,
    )


def _run_result(code: dict[str, Any]) -> Optional[RunResult]:
    """A run's end: a `code_lifecycle` event whose metadata says `terminal: true`."""
    meta = _dict(code.get("metadata"))
    if code.get("event") != "code_lifecycle" or not meta or meta.get("terminal") is not True:
        return None
    run_id = _str(meta.get("runId"))
    if not run_id:
        return None
    phase = meta.get("phase", code.get("phase"))
    forced = _dict(meta.get("budgetForced"))
    task_id = meta.get("taskId")
    return RunResult(
        run_id=run_id,
        terminal=True,
        phase="completed" if phase == "completed" else "failed",
        task_id=task_id if isinstance(task_id, int) else None,
        agent=_str(meta.get("agent")),
        outcome=_str(meta.get("outcome")),
        reason=_str(meta.get("reason")),
        detail=_str(meta.get("detail")),
        summary=_str(meta.get("summary")),
        summary_id=_str(meta.get("summaryId")),
        verification=_str(meta.get("verification")),
        verification_reason=_str(meta.get("verificationReason")),
        budget_forced=(
            BudgetForced(reason=str(forced.get("reason", "")), used=forced.get("used"), cap=forced.get("cap"))
            if forced
            else None
        ),
        raw={**meta, "phase": "completed" if phase == "completed" else "failed"},
    )


def code_event_of(frame: Frame) -> Optional[CodeEvent]:
    """The coding event a frame carries, or None."""
    data = _dict(frame.get("data")) or {}
    code = _dict(data.get("code"))
    if not code or not isinstance(code.get("event"), str):
        return None
    meta = _dict(code.get("metadata")) or {}
    return CodeEvent(
        event=code["event"],
        type=_str(code.get("type")) or "",
        text=frame_text(frame),
        session_id=_str(code.get("sessionId")),
        run_id=_str(meta.get("runId")),
        phase=_str(code.get("phase")),
        kind=_str(meta.get("kind")),
        activity=_activity(meta.get("activity")),
        result=_run_result(code),
        raw=frame,
    )


def exec_approval_of(frame: Frame) -> Optional[ExecApprovalRequest]:
    """The exec approval request a frame carries, or None."""
    data = _dict(frame.get("data")) or {}
    request = _dict(data.get("execApproval"))
    if not request:
        return None
    token, cwd, rendered, argv = (
        _str(request.get("token")),
        _str(request.get("cwd")),
        _str(request.get("rendered")),
        request.get("argv"),
    )
    if not token or cwd is None or rendered is None or not isinstance(argv, list):
        return None
    return ExecApprovalRequest(
        token=token, cwd=cwd, rendered=rendered, argv=[a for a in argv if isinstance(a, str)]
    )
