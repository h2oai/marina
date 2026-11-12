# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Unit tests: no server needed. Run: python3 -m unittest discover -s sdks/python/tests"""

from __future__ import annotations

import json
import os
import socket
import struct
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from marina import (  # noqa: E402
    ApiError,
    Coding,
    HttpApi,
    budget_argument,
    classify_frame,
    code_event_of,
    exec_approval_of,
)
from marina._operations import OPERATIONS  # noqa: E402
from marina._ws import OP_PING, OP_PONG, WebSocket, WebSocketClosed, accept_key, encode_frame  # noqa: E402
from marina.client import CommandError, endpoints  # noqa: E402


def server_frame(opcode: int, payload: bytes, fin: bool = True) -> bytes:
    """A frame as a server sends it: unmasked."""
    n = len(payload)
    head = bytes([(0x80 if fin else 0) | opcode])
    if n < 126:
        head += bytes([n])
    elif n < 65536:
        head += bytes([126]) + struct.pack("!H", n)
    else:
        head += bytes([127]) + struct.pack("!Q", n)
    return head + payload


def read_client_frame(sock: socket.socket) -> tuple[int, bytes]:
    b0, b1 = sock.recv(2)
    n = b1 & 0x7F
    if n == 126:
        (n,) = struct.unpack("!H", sock.recv(2))
    key = sock.recv(4)
    data = b""
    while len(data) < n:
        data += sock.recv(n - len(data))
    return b0 & 0x0F, bytes(b ^ key[i % 4] for i, b in enumerate(data))


class WebSocketCodec(unittest.TestCase):
    def test_handshake_accept_key_is_rfc6455(self) -> None:
        self.assertEqual(accept_key("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")

    def test_client_frames_are_masked_and_sized(self) -> None:
        for size in (0, 5, 125, 126, 70000):
            payload = os.urandom(size)
            frame = encode_frame(0x1, payload, b"\x01\x02\x03\x04")
            self.assertEqual(frame[0], 0x81)
            self.assertTrue(frame[1] & 0x80, "client frames are masked")
            offset = 2 + (2 if 126 <= size < 65536 else 8 if size >= 65536 else 0)
            masked = frame[offset + 4 :]
            key = frame[offset : offset + 4]
            self.assertEqual(bytes(b ^ key[i % 4] for i, b in enumerate(masked)), payload)

    def test_reads_fragments_answers_pings_and_sees_close(self) -> None:
        mine, theirs = socket.socketpair()
        ws = WebSocket(mine)
        theirs.sendall(
            server_frame(0x1, b'{"a":', fin=False)
            + server_frame(OP_PING, b"hi")
            + server_frame(0x0, b"1}")
            + server_frame(0x1, "é".encode())
            + server_frame(0x8, struct.pack("!H", 1000))
        )
        self.assertEqual(json.loads(ws.recv()), {"a": 1})
        self.assertEqual(read_client_frame(theirs), (OP_PONG, b"hi"))
        self.assertEqual(ws.recv(), "é")
        with self.assertRaises(WebSocketClosed):
            ws.recv()
        self.assertEqual(read_client_frame(theirs)[0], 0x8)
        ws.close()
        theirs.close()


class Frames(unittest.TestCase):
    def test_classifies_frames_in_the_protocol_order(self) -> None:
        cases = [
            ({"kind": "auth_error", "data": {"text": "x"}}, "AuthError"),
            ({"kind": "error", "data": {"text": "x", "command_result": {}}}, "Error"),
            ({"kind": "system", "data": {"command_result": {"request_id": "1", "ok": True}}}, "CommandResult"),
            ({"kind": "system", "data": {"entityId": "e_1", "token": "t"}}, "Session"),
            ({"kind": "system", "data": {"protocol": "marina.wire.v1", "schema": "/api/protocol"}}, "Welcome"),
            ({"kind": "system", "tag": "capabilities", "data": {}}, "CapabilitiesReply"),
            ({"kind": "message", "data": {"execApproval": {"token": "t"}, "code": {}}}, "ExecApproval"),
            ({"kind": "message", "tag": "code", "data": {"code": {"event": "x"}}}, "Code"),
            ({"kind": "message", "tag": "tell", "data": {}}, "Tell"),
            ({"kind": "room", "data": {"text": "A room"}}, "Output"),
        ]
        for frame, expected in cases:
            self.assertEqual(classify_frame(frame), expected, frame)

    def test_reads_a_step_and_a_run_end(self) -> None:
        step = code_event_of(
            {
                "kind": "message",
                "tag": "code",
                "data": {
                    "text": "  ▸ Edit a.ts",
                    "code": {
                        "event": "agent_output",
                        "type": "stream",
                        "sessionId": "s",
                        "metadata": {
                            "kind": "tool",
                            "activity": {"kind": "edit", "label": "Edit a.ts", "path": "a.ts", "diff": ["-a", "+b"]},
                        },
                    },
                },
            }
        )
        assert step is not None and step.activity is not None
        self.assertEqual((step.kind, step.activity.label, step.activity.diff), ("tool", "Edit a.ts", ["-a", "+b"]))
        # A blocked run carries its phase on the event, not in the metadata.
        end = code_event_of(
            {
                "kind": "message",
                "data": {
                    "text": "t",
                    "code": {
                        "event": "code_lifecycle",
                        "type": "lifecycle",
                        "phase": "failed",
                        "metadata": {"runId": "task_run_1", "reason": "blocked", "terminal": True, "outcome": "interrupted"},
                    },
                },
            }
        )
        assert end is not None and end.result is not None
        self.assertEqual((end.result.run_id, end.result.phase, end.result.outcome), ("task_run_1", "failed", "interrupted"))
        self.assertFalse(end.result.submitted)
        not_end = code_event_of({"data": {"code": {"event": "code_lifecycle", "metadata": {"runId": "r"}}}})
        assert not_end is not None
        self.assertIsNone(not_end.result)

    def test_exec_approval_needs_every_field(self) -> None:
        request = {"token": "t", "argv": ["make"], "cwd": "/w", "rendered": "make"}
        self.assertEqual(exec_approval_of({"data": {"execApproval": request}}).token, "t")  # type: ignore[union-attr]
        self.assertIsNone(exec_approval_of({"data": {"execApproval": {"token": "t"}}}))

    def test_budget_and_endpoints(self) -> None:
        self.assertEqual(budget_argument(90), "90s")
        self.assertEqual(budget_argument(0.2), "1s")
        self.assertEqual(budget_argument("10m"), "10m")
        for bad in ("ten", 0, -1, True):
            with self.assertRaises(ValueError):
                budget_argument(bad)  # type: ignore[arg-type]
        self.assertEqual(endpoints("http://127.0.0.1:3300/"), ("ws://127.0.0.1:3300/ws", "http://127.0.0.1:3300"))
        self.assertEqual(endpoints("ws://localhost:3300/ws"), ("ws://localhost:3300/ws", "http://localhost:3300"))
        self.assertEqual(endpoints("wss://m.example/world"), ("wss://m.example/world/ws", "https://m.example/world"))
        with self.assertRaises(ValueError):
            endpoints("ws://u:p@host")

    def test_command_error_states_the_refusal_once(self) -> None:
        error = CommandError("No such room.", [{"data": {"text": "No such room. Try look."}}, {"data": {"text": "x"}}])
        self.assertTrue(str(error).startswith("No such room. Try look."))
        self.assertIn("x", str(error))


class Recorder(BaseHTTPRequestHandler):
    seen: list[dict] = []

    def _answer(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        Recorder.seen.append(
            {"method": self.command, "path": self.path, "headers": dict(self.headers), "body": body.decode()}
        )
        status, reply, extra = 200, {"ok": True}, {}
        if "memfail" in self.path:
            status, reply, extra = 429, {"error": {"code": "rate_limited", "message": "slow", "retry_after_ms": 1500}}, {"Retry-After": "2"}
        elif "/api/routing" in self.path and "gone" in self.path:
            status, reply = 404, {"error": "No session", "code": "not_found"}
        elif "redirect" in self.path:
            status, reply, extra = 302, {}, {"Location": "http://elsewhere.invalid/"}
        data = json.dumps(reply).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        for k, v in extra.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = do_PATCH = do_DELETE = do_PUT = _answer

    def log_message(self, *args) -> None:  # noqa: ANN002
        pass  # quiet test output


class Http(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = HTTPServer(("127.0.0.1", 0), Recorder)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self) -> None:
        Recorder.seen.clear()

    def test_every_operation_has_a_unique_python_name(self) -> None:
        self.assertEqual(len(OPERATIONS), 117)
        self.assertEqual(len({op.id for op in OPERATIONS.values()}), 117)
        self.assertEqual({op.tag for op in OPERATIONS.values()}, {"memory", "routing", "investigations", "panels"})

    def test_fills_path_query_body_and_idempotency_key(self) -> None:
        memory = HttpApi(self.base, "cred", "memory")
        memory.remember(space="a b/c", body={"content": "x"}, idempotency_key="k1")
        memory.get(space="s", id="r1", version=3)
        sent = Recorder.seen
        self.assertEqual(sent[0]["method"], "POST")
        self.assertEqual(sent[0]["path"], "/v1/memory/spaces/a%20b%2Fc/records")
        self.assertEqual(sent[0]["headers"]["Authorization"], "Bearer cred")
        self.assertEqual(sent[0]["headers"]["Idempotency-Key"], "k1")
        self.assertEqual(json.loads(sent[0]["body"]), {"content": "x"})
        self.assertEqual(sent[1]["path"], "/v1/memory/spaces/s/records/r1?version=3")
        self.assertNotIn("Idempotency-Key", sent[1]["headers"])
        # A write without a key gets a fresh one.
        memory.create_space(body={"name": "n"})
        self.assertTrue(Recorder.seen[-1]["headers"]["Idempotency-Key"])

    def test_refuses_wrong_arguments_and_other_groups(self) -> None:
        memory = HttpApi(self.base, "cred", "memory")
        with self.assertRaises(TypeError):
            memory.get(id="r1")  # no space
        with self.assertRaises(TypeError):
            memory.remember(space="s")  # no body
        with self.assertRaises(TypeError):
            memory.me(bogus=1)
        with self.assertRaises(AttributeError):
            memory.discover  # a routing operation  # noqa: B018
        self.assertIn("discover", HttpApi(self.base, "t", "routing").operations())
        self.assertEqual(Recorder.seen, [])

    def test_errors_carry_code_and_retry(self) -> None:
        memory = HttpApi(self.base, "cred", "memory")
        with self.assertRaises(ApiError) as caught:
            memory.space(space="memfail")
        self.assertEqual((caught.exception.status, caught.exception.code, caught.exception.retry_after_ms), (429, "rate_limited", 1500))
        routing = HttpApi(self.base, lambda: "session-token", "routing")
        with self.assertRaises(ApiError) as caught:
            routing.leave(session="gone", body={})
        self.assertEqual((caught.exception.status, caught.exception.code), (404, "not_found"))
        self.assertEqual(Recorder.seen[-1]["headers"]["Authorization"], "Bearer session-token")

    def test_never_follows_a_redirect_with_the_token(self) -> None:
        memory = HttpApi(self.base, "cred", "memory")
        with self.assertRaises(ApiError) as caught:
            memory.space(space="redirect")
        self.assertEqual(caught.exception.status, 302)


class FakeConnection:
    def __init__(self) -> None:
        self.listeners: list = []
        self.sent: list[str] = []

    def on_close(self, _callback) -> None:  # noqa: ANN001
        pass

    def on_frame(self, listener):  # noqa: ANN001, ANN201
        self.listeners.append(listener)

    def command(self, text: str, **_kw):  # noqa: ANN003, ANN201
        self.sent.append(text)
        return []


class ExecApprovals(unittest.TestCase):
    def test_true_approves_anything_else_or_a_failure_denies(self) -> None:
        connection = FakeConnection()
        coding = Coding(connection)  # type: ignore[arg-type]
        answers = {"a": lambda: True, "b": lambda: False, "c": lambda: 1 / 0, "d": lambda: "yes"}
        coding.on_exec_approval(lambda request: answers[request.token]())
        for token in answers:
            for listener in connection.listeners:
                listener({"data": {"execApproval": {"token": token, "argv": ["make"], "cwd": "/w", "rendered": "make"}}})
        deadline = time.time() + 2
        while len(connection.sent) < 4 and time.time() < deadline:
            time.sleep(0.01)
        self.assertEqual(
            sorted(connection.sent),
            ["code exec-approve a", "code exec-deny b", "code exec-deny c", "code exec-deny d"],
        )


if __name__ == "__main__":
    unittest.main()
