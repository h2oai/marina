# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Code Mode: run a coding task, follow its steps, get its result, review its change."""

from __future__ import annotations

import queue
import re
import threading
from typing import Callable, Iterator, Optional, Union

from .client import CommandError, Connection, MarinaError
from .wire import (
    CodeEvent,
    CodingActivity,
    ExecApprovalRequest,
    Frame,
    RunResult,
    code_event_of,
    exec_approval_of,
)

DEFAULT_RUN_TIMEOUT = 30 * 60.0
_END = object()


class CodingTimeout(MarinaError):
    """The run did not finish in time; it was stopped."""


def budget_argument(budget: Union[str, int, float]) -> str:
    """`budget:` for `code do`: a number of seconds, or a duration like "90s", "10m", "2h"."""
    if isinstance(budget, bool):
        raise ValueError("budget is seconds or a duration like 10m")
    if isinstance(budget, (int, float)):
        if budget <= 0:
            raise ValueError("budget must be positive")
        return f"{max(1, int(-(-budget // 1)))}s"
    text = budget.strip()
    if not re.fullmatch(r"\d+(s|m|h)", text):
        raise ValueError(f'budget "{budget}" is not like 90s, 10m or 2h')
    return text


class CodingRun:
    """One coding task, from dispatch to its Run result.

    >>> run = marina.code.run("Fix the off-by-one in paginate()")
    >>> for step in run.steps():
    ...     print(step.label)
    >>> result = run.result()
    """

    def __init__(self, coding: Coding, session_id: Optional[str]) -> None:
        self._coding = coding
        self._session_id = session_id
        self._queue: queue.Queue[object] = queue.Queue()
        self._done = threading.Event()
        self._result: Optional[RunResult] = None
        self._error: Optional[BaseException] = None
        self._read = False
        self.run_id: Optional[str] = None
        """The run's id once the server has accepted it (`task_run_...`)."""

    def events(self) -> Iterator[CodeEvent]:
        """Every coding event of this run's session while it runs, in order. Read once."""
        if self._read:
            raise MarinaError("A run's events can be read once.")
        self._read = True
        while True:
            item = self._queue.get()
            if item is _END:
                return
            yield item  # type: ignore[misc]

    def steps(self) -> Iterator[CodingActivity]:
        """Only the coder's steps (reads, edits with their diffs, checks). Read once."""
        for event in self.events():
            if event.activity:
                yield event.activity

    def result(self, timeout: Optional[float] = None) -> RunResult:
        """Wait for the Run result (completed or failed). Raises on timeout or a lost connection."""
        if not self._done.wait(timeout):
            raise CodingTimeout("The coding run has not finished yet.")
        if self._error:
            raise self._error
        assert self._result is not None
        return self._result

    @property
    def done(self) -> bool:
        return self._done.is_set()

    def steer(self, direction: str) -> None:
        """Redirect the coder while it works."""
        self._coding.steer(direction)

    def stop(self) -> None:
        """Stop the coder. The result still arrives, as `failed`."""
        self._coding.stop()

    # Called by Coding on the SDK's reader thread: quick, never blocking.
    def _receive(self, frame: Frame) -> bool:
        event = code_event_of(frame)
        if not event:
            return False
        if self._session_id and event.session_id and event.session_id != self._session_id:
            return False
        if not self.run_id and event.event == "code_lifecycle" and event.run_id and not event.result:
            self.run_id = event.run_id
        if event.result and self.run_id and event.result.run_id != self.run_id:
            return False  # another run's late end
        self._queue.put(event)
        if not event.result or not self.run_id:
            return False
        self._finish(event.result, None)
        return True

    def _finish(self, result: Optional[RunResult], error: Optional[BaseException]) -> None:
        if self._done.is_set():
            return
        self._result, self._error = result, error
        self._done.set()
        self._queue.put(_END)


class Coding:
    """Code Mode for one connection: run tasks in the server's workspace and follow them."""

    def __init__(self, connection: Connection) -> None:
        self._connection = connection
        self._session: Optional[str] = None
        self._opened = False
        self._approver: Optional[Callable[[ExecApprovalRequest], bool]] = None
        self._watching = False
        self._active: set[CodingRun] = set()
        connection.on_close(self._closed)

    def open(self) -> Optional[str]:
        """Enter Code Mode (once per connection). Returns the coding session id, if it has one yet.

        The server picks the workspace: a local folder server codes in its folder.
        """
        if not self._opened:
            for frame in self._connection.command("code"):
                code = (frame.get("data") or {}).get("code") or {}
                if isinstance(code, dict) and code.get("event") == "code_mode_entered":
                    session = code.get("sessionId")
                    self._session = session if isinstance(session, str) else None
            self._opened = True
        return self._session

    def run(
        self,
        task: str,
        *,
        verification: str = "checks",
        budget: Union[str, int, float, None] = None,
        timeout: float = DEFAULT_RUN_TIMEOUT,
    ) -> CodingRun:
        """Dispatch a coding task; returns once the server accepts it.

        verification: what counts as done. `checks` runs the project's checks on the change,
            `candidate` lets the coder's own checks stand, `delivery` asks for the delivery
            checklist.
        budget: wall-clock budget for the coder, seconds or "10m". At the deadline it hands in
            what it has, labelled `budget_forced`.
        timeout: give up waiting after this many seconds: the run is stopped and `result()`
            raises CodingTimeout.
        """
        text = task.strip()
        if not text:
            raise ValueError("Empty task: nothing to do.")
        if verification not in ("checks", "candidate", "delivery"):
            raise ValueError("verification is checks, candidate or delivery")
        session_id = self.open()
        run = CodingRun(self, session_id)
        stop_listening = self._listen(run)

        def expire() -> None:
            if run.done:
                return
            stop_listening()
            try:
                self.stop()
            except MarinaError:
                pass  # the timeout below already reports the run
            run._finish(None, CodingTimeout(f"The coding run did not finish within {timeout:g} s; it was stopped."))

        timer = threading.Timer(timeout, expire)
        timer.daemon = True
        timer.start()
        spend = f"budget:{budget_argument(budget)} " if budget is not None else ""
        try:
            # A program drives this run: nobody is at a keyboard to answer questions.
            self._connection.command(f"code do verification:{verification} owner:unattended {spend}-- {text}")
        except BaseException as error:
            timer.cancel()
            stop_listening()
            run._finish(None, error)
            raise
        threading.Thread(target=lambda: (run._done.wait(), timer.cancel()), daemon=True).start()
        return run

    def _listen(self, run: CodingRun) -> Callable[[], None]:
        def waiter(frame: Frame) -> None:
            if run._receive(frame):
                remove()

        def remove() -> None:
            self._connection._remove_waiter(waiter)
            self._active.discard(run)

        self._active.add(run)
        # On the reader thread: frames reach the run in order, before any listener.
        self._connection._add_waiter(waiter)
        return remove

    def _closed(self) -> None:
        for run in list(self._active):
            run._finish(None, MarinaError("The connection closed before the coding run ended."))
        self._active.clear()

    def on_exec_approval(self, handler: Callable[[ExecApprovalRequest], bool]) -> None:
        """Answer the coder's requests to run commands outside its allowlist.

        `handler` returns True to run the command; anything else, or an exception, denies it.
        Without a handler the requests wait for someone else to answer. The server honours
        approvals only where it allows them.
        """
        self._approver = handler
        if self._watching:
            return
        self._watching = True

        def answer(frame: Frame) -> None:
            request = exec_approval_of(frame)
            approver = self._approver
            if not request or not approver:
                return
            try:
                yes = approver(request) is True
            except Exception:  # noqa: BLE001 - a failing handler denies: never run what nobody approved
                yes = False
            verb = "exec-approve" if yes else "exec-deny"
            try:
                self._connection.command(f"code {verb} {request.token}")
            except MarinaError:
                pass  # not delivered: the request stays open to answer again

        self._connection.on_frame(answer)

    def diff(self, path: Optional[str] = None) -> str:
        """The session's whole change as a unified diff ("" when nothing changed)."""
        self.open()
        for frame in self._connection.command(f"code diff {path}" if path else "code diff"):
            code = (frame.get("data") or {}).get("code") or {}
            if isinstance(code, dict) and code.get("type") == "diff" and isinstance(code.get("content"), str):
                return code["content"]
        return ""

    def review(self, run_id: str, verdict: str) -> None:
        """Record your verdict on a run's change: `approve` or `reject`."""
        if verdict not in ("approve", "reject"):
            raise ValueError("verdict is approve or reject")
        if not re.fullmatch(r"[\w-]{1,128}", run_id):
            raise ValueError(f"Not a run id: {run_id}")
        self._connection.command(f"code review {verdict} {run_id}")

    def steer(self, direction: str) -> None:
        """Redirect the coder while it works."""
        self._connection.command(f"code steer {direction}")

    def stop(self) -> None:
        """Stop the coder."""
        self._connection.command("code stop")


__all__ = ["Coding", "CodingRun", "CodingTimeout", "CommandError", "budget_argument"]
