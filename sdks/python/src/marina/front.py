# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
"""The front door: `Marina.local(folder)` and `Marina.connect(url, name=...)`."""

from __future__ import annotations

import collections
import json
import os
import shutil
import subprocess
import threading
from dataclasses import dataclass
from typing import Any, Callable, Optional, Sequence

from . import agent
from .client import CommandResult, Connection, MarinaError, Session
from .coding import Coding
from .forms import CommandForm, forms_of
from .models import InvestigationsApi, MemoryApi, RoutingApi
from .panels import Panels
from .wire import Frame

LOCAL_PROTOCOL = "marina.local.v1"


@dataclass
class LocalServer:
    """A `marina serve <folder> --json` child and what it announced."""

    url: str
    http: str
    name: str
    pid: int
    folder: str
    process: subprocess.Popen

    def stop(self, grace: float = 45.0) -> None:
        """Stop the server and wait until it has released the folder's database."""
        if self.process.poll() is not None:
            return
        self.process.terminate()
        try:
            self.process.wait(grace)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()


def start_local_server(
    folder: str,
    *,
    fresh: bool = False,
    command: Optional[Sequence[str]] = None,
    env: Optional[dict[str, str]] = None,
    start_timeout: float = 90.0,
) -> LocalServer:
    """Run `marina serve <folder> --json` and wait for its `marina.local.v1` announcement."""
    argv = list(command) if command else ["marina"]
    if not command and shutil.which("marina") is None:
        raise MarinaError(
            "The marina CLI is not on PATH. Install Marina, or pass command=[...] to say how to run it."
        )
    argv += ["serve", os.fspath(folder), "--json"] + (["--fresh"] if fresh else [])
    try:
        process = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,  # when we go away, it closes, and the server stops with us
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={**os.environ, **(env or {})},
            text=True,
        )
    except OSError as error:
        raise MarinaError(f"Could not run {argv[0]}: {error}. Install Marina, or pass command=[...].") from error
    tail: collections.deque[str] = collections.deque(maxlen=40)

    def drain() -> None:
        assert process.stderr is not None
        for line in process.stderr:
            tail.append(line.rstrip())

    threading.Thread(target=drain, daemon=True).start()
    announced: dict[str, Any] = {}

    def read() -> None:
        assert process.stdout is not None
        line = process.stdout.readline()
        if line.strip():
            try:
                announced.update(json.loads(line))
            except ValueError:
                announced["bad"] = line

    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    reader.join(start_timeout)
    why = lambda: ("\n" + "\n".join(list(tail)[-8:])) if tail else ""  # noqa: E731

    def fail(message: str) -> MarinaError:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(45)
            except subprocess.TimeoutExpired:
                process.kill()
        return MarinaError(message + why())

    if reader.is_alive():
        raise fail(f"The Marina server for {folder} was not ready in time.")
    if not announced:
        process.wait(5)
        raise fail(f"The Marina server for {folder} exited ({process.returncode}) before it was ready.")
    if announced.get("protocol") != LOCAL_PROTOCOL:
        raise fail(f"marina serve said something unexpected: {announced!r}")
    return LocalServer(
        url=announced["url"],
        http=announced["http"],
        name=announced["name"],
        pid=int(announced["pid"]),
        folder=announced["folder"],
        process=process,
    )


class Marina:
    """One session with a Marina server, and everything it can reach.

    >>> with Marina.local("./my-project") as marina:
    ...     run = marina.code.run("Fix the failing test", budget="10m")
    ...     for step in run.steps():
    ...         print(step.label)
    ...     print(run.result())
    """

    def __init__(self, connection: Connection, server: Optional[LocalServer] = None) -> None:
        self.connection = connection
        """The WebSocket session underneath, for anything the front door does not wrap."""
        self.code = Coding(connection)
        """Code Mode: run coding tasks, follow them, review their changes."""
        self._server = server
        self._routing: Optional[RoutingApi] = None
        self._investigations: Optional[InvestigationsApi] = None
        self._panels: Optional[Panels] = None

    @classmethod
    def connect(
        cls,
        url: str,
        *,
        name: Optional[str] = None,
        token: Optional[str] = None,
        principal: str = "agent",
        model: Optional[str] = None,
        command_timeout: float = 120.0,
        auto_reconnect: bool = True,
    ) -> Marina:
        """Connect to a running Marina: log in with `name`, or resume a dropped session with `token`.

        With `auto_reconnect` (the default) a dropped socket resumes the session on its own.
        """
        if (name is None) == (token is None):
            raise ValueError("Pass name= to log in, or token= to resume a session (one of them).")
        connection = Connection(
            url, principal=principal, model=model, command_timeout=command_timeout, auto_reconnect=auto_reconnect
        )
        try:
            if token is not None:
                connection.resume(token)
            else:
                connection.login(name)  # type: ignore[arg-type]
        except BaseException:
            connection.close()
            raise
        return cls(connection)

    @classmethod
    def local(
        cls,
        folder: str,
        *,
        fresh: bool = False,
        command: Optional[Sequence[str]] = None,
        env: Optional[dict[str, str]] = None,
        start_timeout: float = 90.0,
    ) -> Marina:
        """Start a Marina for a folder and connect as its owner.

        It codes in that folder and keeps its sessions and memory in ~/.marina/projects/ (the same
        home `marina <folder>` uses). `close()` stops it. Needs the `marina` CLI; `command` says how
        to run it, e.g. ["bun", "run", "/path/to/marina/scripts/marina.ts"].
        """
        server = start_local_server(folder, fresh=fresh, command=command, env=env, start_timeout=start_timeout)
        try:
            marina = cls.connect(server.url, name=server.name)
        except BaseException:
            server.stop()
            raise
        marina._server = server
        return marina

    # ─── The session ──────────────────────────────────────────────────────

    @property
    def session(self) -> Session:
        if not self.connection.session:
            raise MarinaError("Not connected.")
        return self.connection.session

    @property
    def token(self) -> str:
        """The newest session token: it signs the HTTP calls and resumes a dropped session."""
        return self.session.token

    @property
    def url(self) -> str:
        return self.connection.ws_url

    @property
    def http_url(self) -> str:
        return self.connection.http_url

    def command(self, text: str, *, timeout: Optional[float] = None) -> CommandResult:
        """Run one world command (`look`, `task list`, ...). Raises CommandError when refused.

        Coding tasks go through `code.run`: in Code Mode a command is still a command.
        """
        return self.connection.command(text, timeout=timeout)

    def capabilities(self) -> dict[str, Any]:
        """Every command this session may run, with typed forms and JSON Schemas."""
        return self.connection.capabilities()

    def on_event(self, listener: Callable[[Frame], None]) -> Callable[[], None]:
        """Everything the server sends this session. Returns a function that stops listening."""
        return self.connection.on_frame(listener)

    def on_reconnect(self, callback: Callable[[Session], None]) -> Callable[[], None]:
        """Call `callback(session)` each time a dropped session is back. Returns a function that stops it."""
        return self.connection.on_reconnect(callback)

    def forms(self, command: str) -> list[CommandForm]:
        """The typed forms of one command (from `capabilities()`), for `compose_command`."""
        return forms_of(self.capabilities(), command)

    # ─── Talking to others ────────────────────────────────────────────────

    def tell(self, target: str, message: str) -> CommandResult:
        """Send `target` a private message."""
        return self.command(f"tell {target} {message}")

    def say(self, message: str) -> CommandResult:
        """Say something to the room."""
        return self.command(f"say {message}")

    def tell_and_await(
        self,
        target: str,
        message: str,
        timeout: float = 30.0,
        *,
        correlate: bool = True,
        grace: float = agent.TELL_AWAIT_GRACE,
        ignore_notices: bool = True,
        strict_correlation: bool = False,
    ) -> str:
        """Tell `target` something and wait for its reply; returns the reply's text.

        The message gets a ` [re:<id>]` tag; a reply echoing it wins at once, an untagged one is
        taken after `grace` seconds. Notices ("I've spent my model-call budget") and tells sent
        before yours are never the reply. Raises TellTimeout when nothing arrives in time.
        """
        return agent.tell_and_await(
            self.connection,
            target,
            message,
            timeout,
            correlate=correlate,
            grace=grace,
            ignore_notices=ignore_notices,
            strict_correlation=strict_correlation,
        )

    def wait_for_tell(self, from_: Optional[str] = None, timeout: float = 30.0) -> str:
        """Wait for a tell to you (from anyone, or from `from_`); returns its text."""
        return agent.wait_for_tell(self.connection, from_, timeout)

    # ─── Shortcuts: each one world command ────────────────────────────────

    def look(self, target: Optional[str] = None) -> CommandResult:
        """`look`: the room, or one thing in it."""
        return self.command(f"look {target}" if target else "look")

    def who(self) -> CommandResult:
        """`who`: who is here."""
        return self.command("who")

    def note(self, text: str) -> CommandResult:
        """`note <text>`: write a note to your memory."""
        return self.command(f"note {text}")

    def recall(self, query: str, mode: Optional[str] = None) -> CommandResult:
        """`recall <query> [mode]`: search your memory (`mode`: recent, important, ...)."""
        return self.command(f"recall {query} {mode}" if mode else f"recall {query}")

    def task(self, sub: str, *args: str) -> CommandResult:
        """`task <sub> ...`: the task board (`task("list")`, `task("claim", "12")`)."""
        return self.command(" ".join(["task", sub, *args]))

    # ─── HTTP ─────────────────────────────────────────────────────────────

    @property
    def routing(self) -> RoutingApi:
        """Participant routing (`/api/routing`), signed in as this session."""
        self._routing = self._routing or RoutingApi(self.http_url, lambda: self.token)
        return self._routing

    @property
    def investigations(self) -> InvestigationsApi:
        """Investigations (`/api/investigations`), signed in as this session."""
        self._investigations = self._investigations or InvestigationsApi(self.http_url, lambda: self.token)
        return self._investigations

    @property
    def panels(self) -> Panels:
        """Published panels (`/api/canvases`), signed in as this session, and `watch_changes`."""
        self._panels = self._panels or Panels(self.http_url, lambda: self.token)
        return self._panels

    def memory(self, credential: str) -> MemoryApi:
        """Memory (`/v1/memory`), with a memory credential of its own (never the session token)."""
        return MemoryApi(self.http_url, credential)

    # ─── Closing ──────────────────────────────────────────────────────────

    def close(self) -> None:
        """Disconnect, and stop the server if `Marina.local` started it."""
        self.connection.close()
        if self._server:
            self._server.stop()
            self._server = None

    def __enter__(self) -> Marina:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
