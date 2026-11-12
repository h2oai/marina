# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
"""The WebSocket conversation: log in, run commands, hear what the server sends.

One thread reads the socket; another calls your listeners, so a listener may run commands.
"""

from __future__ import annotations

import json
import logging
import queue
import threading
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Optional

from ._ws import WebSocket, WebSocketClosed, WebSocketError
from .wire import Frame, classify_frame, frame_text

log = logging.getLogger("marina")

PING_INTERVAL = 30.0
"""Seconds between keepalive pings (the server drops a socket silent for 255 s)."""


class MarinaError(Exception):
    """Base class of every error the SDK raises."""


class ConnectionLost(MarinaError):
    """The connection closed (or could not be opened)."""


class LoginRefused(MarinaError):
    """The server refused a login or a session token."""


class CommandError(MarinaError):
    """The server refused or failed a command. `frames` holds what it sent first."""

    def __init__(self, message: str, frames: Optional[list[Frame]] = None) -> None:
        self.frames = frames or []
        head = message.strip()
        texts = [t for t in (frame_text(f) for f in self.frames) if t]
        echo = next((t for t in texts if head and t.strip().startswith(head)), None)
        rest = [t for t in texts if t is not echo and t.strip() != head]
        headline = echo.strip() if echo else message
        super().__init__(
            f"{headline}\n\nPartial command output (completed actions are not rolled back):\n"
            + "\n\n".join(rest)
            if rest
            else headline
        )
        self.reason = message


@dataclass
class Session:
    """Who you are on this connection. `token` is the newest; each token works once."""

    entity_id: str
    name: str
    token: str
    world_command_grammar: bool = False
    """The server takes `/command` as a world command even in Code Mode (`slash-v1`)."""


class CommandResult(list):
    """A command's output frames, in order (a list), once the server says it is done."""

    @property
    def text(self) -> str:
        """Everything it said for people, one frame per line (may carry ANSI colour codes)."""
        return "\n".join(t for t in (frame_text(f) for f in self) if t)


def endpoints(url: str) -> tuple[str, str]:
    """(WebSocket URL, HTTP base URL) of one server, from either form."""
    from urllib.parse import urlsplit

    parts = urlsplit(url.rstrip("/"))
    if parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError("A server URL carries no credentials, query or fragment.")
    if parts.scheme not in ("ws", "wss", "http", "https"):
        raise ValueError(f"Not a Marina server URL: {url}")
    secure = parts.scheme in ("wss", "https")
    path = parts.path[:-3] if parts.path.endswith("/ws") else parts.path
    base = f"{parts.netloc}{path}"
    return f"{'wss' if secure else 'ws'}://{base}/ws", f"{'https' if secure else 'http'}://{base}"


Listener = Callable[[Frame], None]


class Connection:
    """One WebSocket session with a Marina server."""

    def __init__(
        self,
        url: str,
        *,
        principal: str = "agent",
        model: Optional[str] = None,
        internal_token: Optional[str] = None,
        command_timeout: float = 120.0,
        connect_timeout: float = 30.0,
    ) -> None:
        self.ws_url, self.http_url = endpoints(url)
        self.principal = principal
        self.model = model
        self.internal_token = internal_token
        self.command_timeout = command_timeout
        self.connect_timeout = connect_timeout
        self.session: Optional[Session] = None
        self._ws: Optional[WebSocket] = None
        self._lock = threading.Lock()
        self._waiters: list[Listener] = []
        self._listeners: list[Listener] = []
        self._on_close: list[Callable[[], None]] = []
        self._events: queue.Queue[Optional[Frame]] = queue.Queue()
        self._closed = threading.Event()

    # ─── Opening ──────────────────────────────────────────────────────────

    def _open(self) -> None:
        if self._ws and not self._ws.closed:
            return
        try:
            self._ws = WebSocket.connect(self.ws_url, timeout=self.connect_timeout)
        except WebSocketError as error:
            raise ConnectionLost(str(error)) from error
        self._closed.clear()
        threading.Thread(target=self._read_loop, name="marina-read", daemon=True).start()
        threading.Thread(target=self._dispatch_loop, name="marina-events", daemon=True).start()
        threading.Thread(target=self._ping_loop, name="marina-ping", daemon=True).start()

    def login(self, name: str) -> Session:
        """Enter the world under a name (2-20 letters or digits)."""
        self._open()
        return self._authenticate({"type": "login", "name": name})

    def resume(self, token: str) -> Session:
        """Resume a dropped session with its token, within 60 s of the drop."""
        self._open()
        return self._authenticate({"type": "auth", "token": token})

    def _authenticate(self, frame: dict[str, Any]) -> Session:
        frame["principal"] = self.principal
        if self.model:
            frame["model"] = self.model
        if self.internal_token:
            frame["internalToken"] = self.internal_token
        done = threading.Event()
        outcome: dict[str, Any] = {}

        def waiter(f: Frame) -> None:
            kind = classify_frame(f)
            if kind == "Session" and "session" not in outcome:
                outcome["session"] = f
                done.set()
            elif kind in ("AuthError", "Error") and "session" not in outcome:
                outcome["error"] = frame_text(f) or "Login refused"
                done.set()

        self._add_waiter(waiter)
        try:
            self._send(frame)
            if not done.wait(self.connect_timeout):
                raise ConnectionLost("The server did not answer the login in time.")
        finally:
            self._remove_waiter(waiter)
        if "error" in outcome:
            raise LoginRefused(outcome["error"])
        if "session" not in outcome:
            raise ConnectionLost("The connection closed during login.")
        return self.session  # type: ignore[return-value]  # set by the reader

    # ─── Commands ─────────────────────────────────────────────────────────

    def command(self, text: str, *, timeout: Optional[float] = None, world: bool = True) -> CommandResult:
        """Run one command and wait until the server says it is done.

        Raises CommandError when the server refuses or fails it. With `world` (the default) the
        command is always a world command, never a task for a coder in Code Mode.
        """
        session = self.session
        if not session:
            raise ConnectionLost("Not logged in.")
        line = text.strip()
        if world and session.world_command_grammar and not line.startswith("/"):
            line = "/" + line
        request_id = str(uuid.uuid4())
        frames: list[Frame] = []
        done = threading.Event()
        outcome: dict[str, Any] = {}

        def waiter(f: Frame) -> None:
            if f.get("command_request_id") == request_id:
                frames.append(f)
            result = (f.get("data") or {}).get("command_result")
            if isinstance(result, dict) and result.get("request_id") == request_id:
                outcome["result"] = result
                done.set()

        def lost() -> None:
            done.set()

        self._add_waiter(waiter)
        self._on_close.append(lost)
        try:
            self._send({"type": "command", "command": line, "request_id": request_id})
            finished = done.wait(self.command_timeout if timeout is None else timeout)
        finally:
            self._remove_waiter(waiter)
            if lost in self._on_close:
                self._on_close.remove(lost)
        result = outcome.get("result")
        if not result:
            raise CommandError(
                "Command completion timed out; execution outcome is unknown. Inspect state before retrying."
                if not finished
                else "Disconnected before command completion; execution outcome is unknown.",
                frames,
            )
        if not result.get("ok"):
            raise CommandError(str(result.get("error") or "Command failed"), frames)
        return CommandResult(frames)

    def capabilities(self, timeout: float = 10.0) -> dict[str, Any]:
        """Every command this session may run, with typed forms (`marina.capabilities.v1`)."""
        request_id = str(uuid.uuid4())
        done = threading.Event()
        outcome: dict[str, Any] = {}

        def waiter(f: Frame) -> None:
            reply = (f.get("data") or {}).get("capabilities")
            if isinstance(reply, dict) and reply.get("request_id") == request_id:
                outcome["reply"] = reply
                done.set()

        self._add_waiter(waiter)
        try:
            self._send({"type": "capabilities", "request_id": request_id})
            done.wait(timeout)
        finally:
            self._remove_waiter(waiter)
        reply = outcome.get("reply")
        if not reply:
            raise MarinaError("Capability discovery timed out.")
        if reply.get("error"):
            raise MarinaError(str(reply["error"]))
        return reply

    # ─── Listening ────────────────────────────────────────────────────────

    def on_frame(self, listener: Listener) -> Callable[[], None]:
        """Call `listener` with every frame the server sends you (command replies excepted).

        Listeners run on one SDK thread, in order; they may run commands. Returns a function that
        stops listening.
        """
        self._listeners.append(listener)
        return lambda: self._listeners.remove(listener) if listener in self._listeners else None

    def on_close(self, callback: Callable[[], None]) -> None:
        self._on_close.append(callback)

    @property
    def closed(self) -> bool:
        return self._closed.is_set()

    def close(self) -> None:
        if self._ws:
            self._ws.close()
        self._closed.set()

    # ─── Internals ────────────────────────────────────────────────────────

    def _add_waiter(self, waiter: Listener) -> None:
        with self._lock:
            self._waiters.append(waiter)

    def _remove_waiter(self, waiter: Listener) -> None:
        with self._lock:
            if waiter in self._waiters:
                self._waiters.remove(waiter)

    def _send(self, frame: dict[str, Any]) -> None:
        if not self._ws or self._ws.closed:
            raise ConnectionLost("The connection is closed.")
        try:
            self._ws.send(json.dumps(frame))
        except WebSocketClosed as error:
            raise ConnectionLost(str(error)) from error

    def _read_loop(self) -> None:
        ws = self._ws
        assert ws is not None
        try:
            while True:
                try:
                    frame = json.loads(ws.recv())
                except ValueError:
                    continue  # not JSON: not part of the protocol
                if not isinstance(frame, dict):
                    continue
                if classify_frame(frame) == "Session":
                    data = frame["data"]
                    self.session = Session(
                        entity_id=data["entityId"],
                        name=str(data.get("name") or (self.session.name if self.session else "")),
                        token=str(data.get("token") or ""),
                        world_command_grammar=data.get("worldCommandProtocol") == "slash-v1",
                    )
                with self._lock:
                    waiters = list(self._waiters)
                for waiter in waiters:
                    waiter(frame)
                data = frame.get("data") or {}
                if not (data.get("command_result") or data.get("capabilities")):
                    self._events.put(frame)
        except WebSocketError:
            pass  # closed: reported below
        finally:
            self._closed.set()
            self._events.put(None)
            for callback in list(self._on_close):
                try:
                    callback()
                except Exception:  # noqa: BLE001 - one failing callback must not stop the others
                    log.exception("A close callback failed")

    def _dispatch_loop(self) -> None:
        while True:
            frame = self._events.get()
            if frame is None:
                return
            for listener in list(self._listeners):
                try:
                    listener(frame)
                except Exception:  # noqa: BLE001 - a listener's bug must not stop delivery
                    log.exception("A frame listener failed")

    def _ping_loop(self) -> None:
        while not self._closed.wait(PING_INTERVAL):
            try:
                self._send({"type": "ping"})
            except ConnectionLost:
                return
