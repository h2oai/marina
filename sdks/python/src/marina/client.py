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




RECONNECT_DELAY = 3.0
"""Seconds before the first attempt to resume a dropped session; each further attempt doubles it."""
MAX_RECONNECT_DELAY = 30.0
"""The longest wait between two attempts."""
MAX_RECONNECT_ATTEMPTS = 10
"""Attempts before the SDK gives up and closes the connection."""


def reconnect_delay(attempt: int, base: float = RECONNECT_DELAY, cap: float = MAX_RECONNECT_DELAY) -> float:
    """Seconds to wait before reconnect attempt `attempt` (0 for the first): 3, 6, 12, 24, 30, 30..."""
    return min(base * 2**attempt, cap)


Listener = Callable[[Frame], None]


class Connection:
    """One WebSocket session with a Marina server.

    When the socket drops, the session resumes on its own with its newest token (an `auth`
    frame): after 3 s, then 6, 12, 24 and 30 s, at most 10 attempts. Commands sent meanwhile fail
    at once with ConnectionLost; retry them once `on_reconnect` fires. `close()` never reconnects.
    """

    def __init__(
        self,
        url: str,
        *,
        principal: str = "agent",
        model: Optional[str] = None,
        internal_token: Optional[str] = None,
        command_timeout: float = 120.0,
        connect_timeout: float = 30.0,
        auto_reconnect: bool = True,
        reconnect_delay: float = RECONNECT_DELAY,
        max_reconnect_delay: float = MAX_RECONNECT_DELAY,
        max_reconnect_attempts: int = MAX_RECONNECT_ATTEMPTS,
    ) -> None:
        self.ws_url, self.http_url = endpoints(url)
        self.principal = principal
        self.model = model
        self.internal_token = internal_token
        self.command_timeout = command_timeout
        self.connect_timeout = connect_timeout
        self.auto_reconnect = auto_reconnect
        self.reconnect_delay = reconnect_delay
        self.max_reconnect_delay = max_reconnect_delay
        self.max_reconnect_attempts = max_reconnect_attempts
        self.session: Optional[Session] = None
        self.reconnect_failed = False
        """True once the SDK gave up resuming a dropped session."""
        self._ws: Optional[WebSocket] = None
        self._lock = threading.Lock()
        self._state = threading.Lock()
        self._waiters: list[Listener] = []
        self._listeners: list[Listener] = []
        self._drop_hooks: list[Callable[[], None]] = []
        self._on_reconnect: list[Callable[[Session], None]] = []
        self._on_close: list[Callable[[], None]] = []
        self._events: queue.Queue[Optional[Frame]] = queue.Queue()
        self._up = threading.Event()  # logged in on an open socket
        self._closing = threading.Event()  # close() was called
        self._closed = threading.Event()  # closed for good
        self._finished = False
        self._started = False
        self._reconnecting = False

    # ─── Opening ──────────────────────────────────────────────────────────

    def _open(self) -> None:
        if self._closing.is_set():
            raise ConnectionLost("The connection is closed.")
        if self._ws and not self._ws.closed:
            return
        try:
            ws = WebSocket.connect(self.ws_url, timeout=self.connect_timeout)
        except WebSocketError as error:
            raise ConnectionLost(str(error)) from error
        self._ws = ws
        threading.Thread(target=self._read_loop, args=(ws,), name="marina-read", daemon=True).start()
        if not self._started:
            self._started = True
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
        self._drop_hooks.append(done.set)
        try:
            self._send(frame)
            if not done.wait(self.connect_timeout):
                raise ConnectionLost("The server did not answer the login in time.")
        finally:
            self._remove_waiter(waiter)
            if done.set in self._drop_hooks:
                self._drop_hooks.remove(done.set)
        if "error" in outcome:
            raise LoginRefused(outcome["error"])
        if "session" not in outcome or not self._ws or self._ws.closed:
            raise ConnectionLost("The connection closed during login.")
        self._up.set()
        return self.session  # type: ignore[return-value]  # set by the reader

    # ─── Commands ─────────────────────────────────────────────────────────

    def _require_up(self) -> Session:
        session = self.session
        if self._closing.is_set() or self._closed.is_set():
            raise ConnectionLost("The connection is closed.")
        if not session:
            raise ConnectionLost("Not logged in.")
        if not self._up.is_set():
            raise ConnectionLost("Connection lost; the session is resuming. Retry once it is back.")
        return session

    def command(self, text: str, *, timeout: Optional[float] = None, world: bool = True) -> CommandResult:
        """Run one command and wait until the server says it is done.

        Raises CommandError when the server refuses or fails it, ConnectionLost at once while the
        connection is down. With `world` (the default) the command is always a world command,
        never a task for a coder in Code Mode.
        """
        session = self._require_up()
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

        self._add_waiter(waiter)
        self._drop_hooks.append(done.set)
        try:
            self._send({"type": "command", "command": line, "request_id": request_id})
            finished = done.wait(self.command_timeout if timeout is None else timeout)
        finally:
            self._remove_waiter(waiter)
            if done.set in self._drop_hooks:
                self._drop_hooks.remove(done.set)
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
        self._require_up()
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

    def on_reconnect(self, callback: Callable[[Session], None]) -> Callable[[], None]:
        """Call `callback(session)` each time a dropped session is back (with its new token).

        It runs on the SDK's reconnect thread. Returns a function that stops listening.
        """
        self._on_reconnect.append(callback)
        return lambda: self._on_reconnect.remove(callback) if callback in self._on_reconnect else None

    def on_close(self, callback: Callable[[], None]) -> None:
        """Call `callback()` once the connection is closed for good: `close()`, or reconnecting gave up."""
        self._on_close.append(callback)

    @property
    def connected(self) -> bool:
        """Logged in on an open socket (False while a dropped session is resuming)."""
        return self._up.is_set()

    @property
    def closed(self) -> bool:
        """Closed for good: no more reconnecting."""
        return self._closed.is_set()

    def close(self) -> None:
        """Close the connection. It never reconnects after this."""
        self._closing.set()
        ws = self._ws
        if ws:
            ws.close()
        self._finish_close()

    # ─── Internals ────────────────────────────────────────────────────────

    def _add_waiter(self, waiter: Listener) -> None:
        with self._lock:
            self._waiters.append(waiter)

    def _remove_waiter(self, waiter: Listener) -> None:
        with self._lock:
            if waiter in self._waiters:
                self._waiters.remove(waiter)

    def _send(self, frame: dict[str, Any]) -> None:
        ws = self._ws
        if not ws or ws.closed:
            raise ConnectionLost("The connection is closed.")
        try:
            ws.send(json.dumps(frame))
        except WebSocketClosed as error:
            raise ConnectionLost(str(error)) from error

    def _read_loop(self, ws: WebSocket) -> None:
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
                        token=str(data.get("token") or (self.session.token if self.session else "")),
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
            pass  # closed: handled below
        finally:
            ws.close()
            self._dropped(ws)

    def _dropped(self, ws: WebSocket) -> None:
        """The socket `ws` ended: fail what waits on it, then resume the session or close."""
        with self._state:
            if ws is not self._ws:
                return  # an older socket
            self._up.clear()
            reconnecting = self._reconnecting
            resume = (
                not reconnecting
                and self.auto_reconnect
                and not self._closing.is_set()
                and bool(self.session and self.session.token)
            )
            if resume:
                self._reconnecting = True
        self._run_hooks(self._drop_hooks)
        if resume:
            threading.Thread(target=self._reconnect_loop, name="marina-reconnect", daemon=True).start()
        elif not reconnecting:
            self._finish_close()

    def _reconnect_loop(self) -> None:
        attempt = 0
        while attempt < self.max_reconnect_attempts:
            delay = reconnect_delay(attempt, self.reconnect_delay, self.max_reconnect_delay)
            attempt += 1
            if self._closing.wait(delay):
                return  # close() finishes the connection
            session = self.session
            assert session is not None
            try:
                self._open()
                self._authenticate({"type": "auth", "token": session.token})
            except (ConnectionLost, LoginRefused) as error:
                log.info("Reconnect attempt %d failed: %s", attempt, error)
                ws = self._ws
                if ws and not ws.closed:
                    ws.close()  # its reader ends; the next attempt opens another
                continue
            with self._state:
                ws = self._ws
                if not ws or ws.closed:
                    continue  # dropped again at once
                self._reconnecting = False
            log.info("Reconnected as %s", self.session.name if self.session else "?")
            for callback in list(self._on_reconnect):
                try:
                    callback(self.session)  # type: ignore[arg-type]
                except Exception:  # noqa: BLE001 - one failing callback must not stop the others
                    log.exception("A reconnect callback failed")
            return
        log.warning("Gave up resuming the session after %d attempts.", attempt)
        self.reconnect_failed = True
        with self._state:
            self._reconnecting = False
        self._finish_close()

    def _finish_close(self) -> None:
        with self._state:
            if self._finished:
                return
            self._finished = True
        self._up.clear()
        self._closed.set()
        self._events.put(None)
        self._run_hooks(self._drop_hooks)
        self._run_hooks(self._on_close)

    @staticmethod
    def _run_hooks(hooks: list[Callable[[], None]]) -> None:
        for callback in list(hooks):
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
            if not self._up.is_set():
                continue
            try:
                self._send({"type": "ping"})
            except ConnectionLost:
                continue  # the reader sees the drop
