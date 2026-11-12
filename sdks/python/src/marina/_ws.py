# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
"""A small WebSocket client (RFC 6455) on the standard library: text frames, ping/pong, close.

Marina speaks JSON text frames only, so this is all the SDK needs, and it keeps the package free
of dependencies.
"""

from __future__ import annotations

import base64
import hashlib
import os
import socket
import ssl
import struct
import threading
from urllib.parse import urlsplit

_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
_MAX_HEADER = 65536

OP_CONT, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA


class WebSocketError(Exception):
    """The connection could not be opened, or the peer broke the protocol."""


class WebSocketClosed(WebSocketError):
    """The connection is closed."""


def _mask(payload: bytes, key: bytes) -> bytes:
    if not payload:
        return payload
    n = len(payload)
    stream = (key * (n // 4 + 1))[:n]
    return (int.from_bytes(payload, "big") ^ int.from_bytes(stream, "big")).to_bytes(n, "big")


def encode_frame(opcode: int, payload: bytes, mask_key: bytes | None = None) -> bytes:
    """One final frame, masked as a client must."""
    key = mask_key if mask_key is not None else os.urandom(4)
    n = len(payload)
    head = bytes([0x80 | opcode])
    if n < 126:
        head += bytes([0x80 | n])
    elif n < 65536:
        head += bytes([0x80 | 126]) + struct.pack("!H", n)
    else:
        head += bytes([0x80 | 127]) + struct.pack("!Q", n)
    return head + key + _mask(payload, key)


def accept_key(key: str) -> str:
    return base64.b64encode(hashlib.sha1((key + _GUID).encode()).digest()).decode()


class WebSocket:
    """A connected client socket. `send` is thread-safe; read from one thread only."""

    def __init__(self, sock: socket.socket, buffered: bytes = b"") -> None:
        self._sock = sock
        self._buf = buffered
        self._send_lock = threading.Lock()
        self.closed = False

    @classmethod
    def connect(cls, url: str, timeout: float = 30.0) -> WebSocket:
        parts = urlsplit(url)
        if parts.scheme not in ("ws", "wss"):
            raise ValueError(f"Not a WebSocket URL: {url}")
        secure = parts.scheme == "wss"
        host = parts.hostname or ""
        port = parts.port or (443 if secure else 80)
        path = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
        try:
            sock: socket.socket = socket.create_connection((host, port), timeout=timeout)
            if secure:
                sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host)
        except OSError as error:
            raise WebSocketError(f"Could not reach {url}: {error}") from error
        shown = f"[{host}]" if ":" in host else host
        if parts.port:
            shown += f":{parts.port}"
        key = base64.b64encode(os.urandom(16)).decode()
        request = (
            f"GET {path} HTTP/1.1\r\nHost: {shown}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        try:
            sock.sendall(request.encode())
            data = b""
            while b"\r\n\r\n" not in data:
                chunk = sock.recv(4096)
                if not chunk:
                    raise WebSocketError(f"{url} closed the connection during the handshake")
                data += chunk
                if len(data) > _MAX_HEADER:
                    raise WebSocketError(f"{url} sent an oversized handshake reply")
        except OSError as error:
            sock.close()
            raise WebSocketError(f"Handshake with {url} failed: {error}") from error
        head, rest = data.split(b"\r\n\r\n", 1)
        lines = head.decode("latin-1").split("\r\n")
        status = lines[0].split(" ", 2)
        if len(status) < 2 or status[1] != "101":
            sock.close()
            raise WebSocketError(f"{url} refused the WebSocket upgrade: {lines[0]}")
        headers = {
            k.strip().lower(): v.strip() for k, v in (line.split(":", 1) for line in lines[1:] if ":" in line)
        }
        if headers.get("sec-websocket-accept") != accept_key(key):
            sock.close()
            raise WebSocketError(f"{url} answered the handshake with the wrong key")
        sock.settimeout(None)
        return cls(sock, rest)

    def _read(self, n: int) -> bytes:
        while len(self._buf) < n:
            try:
                chunk = self._sock.recv(max(65536, n - len(self._buf)))
            except OSError as error:
                self.closed = True
                raise WebSocketClosed(str(error)) from error
            if not chunk:
                self.closed = True
                raise WebSocketClosed("the server closed the connection")
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def _send(self, opcode: int, payload: bytes) -> None:
        if self.closed:
            raise WebSocketClosed("the connection is closed")
        frame = encode_frame(opcode, payload)
        with self._send_lock:
            try:
                self._sock.sendall(frame)
            except OSError as error:
                self.closed = True
                raise WebSocketClosed(str(error)) from error

    def send(self, text: str) -> None:
        self._send(OP_TEXT, text.encode())

    def ping(self) -> None:
        self._send(OP_PING, b"")

    def recv(self) -> str:
        """The next text message. Raises WebSocketClosed when the connection ends."""
        parts: list[bytes] = []
        while True:
            b0, b1 = self._read(2)
            fin, opcode = b0 & 0x80, b0 & 0x0F
            n = b1 & 0x7F
            if n == 126:
                (n,) = struct.unpack("!H", self._read(2))
            elif n == 127:
                (n,) = struct.unpack("!Q", self._read(8))
            key = self._read(4) if b1 & 0x80 else None
            payload = self._read(n) if n else b""
            if key:
                payload = _mask(payload, key)
            if opcode == OP_CLOSE:
                if not self.closed:
                    try:
                        self._send(OP_CLOSE, payload[:2])
                    except WebSocketClosed:
                        pass  # the peer may already be gone; closing either way
                self.closed = True
                raise WebSocketClosed("the server closed the connection")
            if opcode == OP_PING:
                self._send(OP_PONG, payload)
                continue
            if opcode == OP_PONG:
                continue
            if opcode not in (OP_TEXT, OP_BINARY, OP_CONT):
                raise WebSocketError(f"unknown frame opcode {opcode}")
            parts.append(payload)
            if fin:
                return b"".join(parts).decode("utf-8", errors="replace")

    def close(self) -> None:
        if not self.closed:
            try:
                self._send(OP_CLOSE, struct.pack("!H", 1000))
            except WebSocketClosed:
                pass  # already closed: nothing left to tell the server
        self.closed = True
        try:
            self._sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass  # not connected any more
        self._sock.close()
