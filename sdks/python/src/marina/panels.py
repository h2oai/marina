# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Published panels: the typed HTTP calls, and the live stream of what changed."""

from __future__ import annotations

import json
import logging
import threading
from typing import Any, Callable, Optional, TypedDict
from urllib.parse import quote, urlsplit

from ._ws import WebSocket, WebSocketError
from .http import TokenSource
from .models import PanelsApi

try:  # Python 3.11+
    from typing import NotRequired
except ImportError:  # pragma: no cover - Python 3.10: read by type checkers only
    from typing import Optional as NotRequired  # type: ignore[assignment]

log = logging.getLogger("marina")


class PanelChangeEvent(TypedDict):
    """A hint that something changed: read it again. Never content, never authority."""

    type: str
    resource: NotRequired[str]
    id: NotRequired[str]
    taskId: NotRequired[int]
    noteId: NotRequired[int]
    canvasId: NotRequired[str]
    nodeId: NotRequired[str]
    spaceId: NotRequired[str]


def watch_delay(attempt: int) -> float:
    """Seconds before reopening the stream after `attempt` failures in a row: 1, 2, 4, 8, 15, 15..."""
    return min(1.0 * 2**attempt, 15.0)


def dashboard_ws_url(http_url: str, token: Optional[str]) -> str:
    """The `/dashboard-ws` URL of the server at `http_url`, signed with `token`."""
    parts = urlsplit(http_url.rstrip("/"))
    scheme = "wss" if parts.scheme in ("https", "wss") else "ws"
    url = f"{scheme}://{parts.netloc}{parts.path}/dashboard-ws"
    return f"{url}?token={quote(token, safe='')}" if token else url


class Panels(PanelsApi):
    """Published panels (`/api/canvases`), signed in as a session, and their live changes."""

    def __init__(self, base_url: str, token: TokenSource, timeout: float = 35.0) -> None:
        super().__init__(base_url, token, timeout)

    def watch_changes(
        self,
        on_event: Callable[[PanelChangeEvent], None],
        on_snapshot: Callable[[], None] = lambda: None,
    ) -> Callable[[], None]:
        """Follow what changes, on `/dashboard-ws`; returns a function that stops it.

        `on_snapshot()` runs each time the stream (re)opens: read what you show again. Each change
        calls `on_event(event)`; it names what changed (`type`, `canvasId`, ...) and carries no
        content: read the resource again with your own credential. A dropped stream reopens
        after 1 s, doubling to 15 s. Both run on the watcher's own thread.
        """
        stopped = threading.Event()
        current: list[Optional[WebSocket]] = [None]

        def call(callback: Callable[..., None], *args: Any) -> None:
            try:
                callback(*args)
            except Exception:  # noqa: BLE001 - a listener's bug must not stop the stream
                log.exception("A panel change listener failed")

        def run() -> None:
            attempts = 0
            while not stopped.is_set():
                token = self._token() if callable(self._token) else self._token
                try:
                    ws = WebSocket.connect(dashboard_ws_url(self.base_url, token), timeout=self.timeout)
                except WebSocketError as error:
                    log.info("Panel stream: %s", error)
                else:
                    current[0] = ws
                    if stopped.is_set():
                        ws.close()
                        return
                    try:
                        while True:
                            try:
                                message = json.loads(ws.recv())
                            except ValueError:
                                continue  # a malformed frame changes nothing
                            if not isinstance(message, dict):
                                continue
                            if message.get("type") == "snapshot":
                                attempts = 0
                                call(on_snapshot)
                            data = message.get("data")
                            if message.get("type") == "event" and isinstance(data, dict) and isinstance(data.get("type"), str):
                                call(on_event, data)
                    except WebSocketError:
                        pass  # dropped: reopened below
                    finally:
                        ws.close()
                if stopped.wait(watch_delay(attempts)):
                    return
                attempts += 1

        thread = threading.Thread(target=run, name="marina-panels", daemon=True)
        thread.start()

        def stop() -> None:
            stopped.set()
            ws = current[0]
            if ws:
                ws.close()
            if threading.current_thread() is not thread:
                thread.join(5)

        return stop


__all__ = ["PanelChangeEvent", "Panels", "dashboard_ws_url", "watch_delay"]
