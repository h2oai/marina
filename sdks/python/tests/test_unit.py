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
from marina import Connection, ConnectionLost, MarinaError, compose_command, reconnect_delay, retry_memory  # noqa: E402
from marina._operations import OPERATIONS  # noqa: E402
from marina.agent import (  # noqa: E402
    TellTimeout,
    correlation_tag,
    has_correlation_tag,
    is_tell_notice,
    strip_correlation_tag,
    tell_and_await,
    wait_for_tell,
)
from marina.forms import find_form, forms_of, js_number  # noqa: E402
from marina.http import NetworkError  # noqa: E402
from marina.models import MemoryApi, RoutingApi  # noqa: E402
from marina.panels import dashboard_ws_url, watch_delay  # noqa: E402
from marina.retry import backoff_ms  # noqa: E402
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


class TellRules(unittest.TestCase):
    def test_notices_are_never_answers(self) -> None:
        for text in (
            "[notice] paused",
            "  [NOTICE] x",
            "I've spent my model-call budget for today",
            "I've hit a spend cap and paused",
            "I've hit 3 consecutive upstream errors",
        ):
            self.assertTrue(is_tell_notice(text), text)
        for text in ("pong", "I've hit the target", "notice: x"):
            self.assertFalse(is_tell_notice(text), text)

    def test_correlation_tags(self) -> None:
        self.assertEqual(correlation_tag("ab12cd"), " [re:ab12cd]")
        for text in ("pong [re:ab12cd]", "pong re:ab12cd", "[re:ab12cd] pong"):
            self.assertTrue(has_correlation_tag(text, "ab12cd"), text)
            self.assertEqual(strip_correlation_tag(text, "ab12cd"), "pong")
        self.assertFalse(has_correlation_tag("pong [re:zzzzzz]", "ab12cd"))
        self.assertEqual(strip_correlation_tag("a.b [re:a.b]", "a.b"), "a.b")


class FakeWorld:
    """A connection whose `command` delivers scripted frames to the SDK's waiters."""

    def __init__(self, script) -> None:  # noqa: ANN001 - script(command text) -> frames
        self.session = object()
        self.waiters: list = []
        self.script = script
        self.sent: list[str] = []

    def _add_waiter(self, waiter) -> None:  # noqa: ANN001
        self.waiters.append(waiter)

    def _remove_waiter(self, waiter) -> None:  # noqa: ANN001
        self.waiters.remove(waiter)

    def deliver(self, frame: dict) -> None:
        for waiter in list(self.waiters):
            waiter(frame)

    def command(self, text: str, **_kw):  # noqa: ANN003, ANN201
        self.sent.append(text)
        for frame in self.script(text):
            self.deliver(frame)
        return []


def tell(sender, text, stamp=None) -> dict:  # noqa: ANN001
    data = {"senderName": sender, "message": text} if sender else {"text": text}
    return {"kind": "message", "tag": "tell", "timestamp": stamp if stamp is not None else 0, "data": data}


class TellAndAwait(unittest.TestCase):
    def tag(self, text: str) -> str:
        return text[text.index("[re:") :]

    def test_a_tagged_reply_wins_over_stale_untagged_and_notices(self) -> None:
        def script(text: str) -> list:
            tag = self.tag(text)
            return [
                tell("Peer", "late answer to an old question"),  # before our echo, old timestamp
                tell(None, f"You tell Peer: {text[len('tell Peer '):]}"),
                tell("Other", f"pong {tag}"),
                tell("Peer", "I've spent my model-call budget"),
                tell("Peer", "untagged"),
                tell("Peer", f"pong {tag}"),
            ]

        world = FakeWorld(script)
        self.assertEqual(tell_and_await(world, "Peer", "ping", 2), "pong")  # type: ignore[arg-type]
        self.assertRegex(world.sent[0], r"^tell Peer ping \[re:[a-z0-9]{6}\]$")

    def test_an_untagged_reply_is_taken_after_the_grace(self) -> None:
        world = FakeWorld(lambda text: [tell("peer", "pong", stamp=time.time() * 1000 + 5)])
        started = time.monotonic()
        self.assertEqual(tell_and_await(world, "Peer", "ping", 2, grace=0.1), "pong")  # type: ignore[arg-type]
        self.assertLess(time.monotonic() - started, 1.5)
        strict = FakeWorld(lambda text: [tell("peer", "pong", stamp=time.time() * 1000 + 5)])
        with self.assertRaises(TellTimeout):
            tell_and_await(strict, "Peer", "ping", 0.3, strict_correlation=True)  # type: ignore[arg-type]

    def test_without_correlation_the_first_fresh_reply_wins(self) -> None:
        world = FakeWorld(lambda text: [tell(None, "You tell Peer: ping"), tell("Peer", "pong [re:other]")])
        self.assertEqual(tell_and_await(world, "Peer", "ping", 1, correlate=False), "pong [re:other]")  # type: ignore[arg-type]
        self.assertEqual(world.sent, ["tell Peer ping"])

    def test_times_out_without_a_reply(self) -> None:
        with self.assertRaises(TellTimeout):
            tell_and_await(FakeWorld(lambda text: []), "Peer", "ping", 0.2)  # type: ignore[arg-type]

    def test_wait_for_tell_hears_tells_to_you_only(self) -> None:
        world = FakeWorld(lambda text: [])
        threading.Timer(
            0.05,
            lambda: [
                world.deliver(tell(None, "You tell Peer: hi")),
                world.deliver(tell("Other", "not you")),
                world.deliver({"tag": "tell", "data": {"senderName": "PEER", "text": "question?"}}),
            ],
        ).start()
        self.assertEqual(wait_for_tell(world, "peer", 2), "question?")  # type: ignore[arg-type]
        with self.assertRaises(TellTimeout):
            wait_for_tell(world, None, 0.05)  # type: ignore[arg-type]


class ComposeCommand(unittest.TestCase):
    def test_matches_the_typescript_sdk_case_by_case(self) -> None:
        # Each case's `expected` is what the TypeScript SDK's composeCommand returned for it.
        with open(os.path.join(os.path.dirname(__file__), "compose_golden.json"), encoding="utf-8") as f:
            cases = json.load(f)
        self.assertGreater(len(cases), 15)
        for case in cases:
            got = compose_command(case["form"], case["values"], case["enabled"])
            self.assertEqual({"command": got.command, "errors": got.errors}, case["expected"], case["values"])

    def test_takes_a_field_label_as_the_key(self) -> None:
        with open(os.path.join(os.path.dirname(__file__), "compose_golden.json"), encoding="utf-8") as f:
            form = next(c["form"] for c in json.load(f) if c["form"]["syntax"] == "say <message>")
        self.assertEqual(compose_command(form, {"message": "hi"}), ("say hi", {}))
        caps = {"commands": [{"name": "say", "forms": [form]}, {"name": "look"}]}
        self.assertEqual(forms_of(caps, "say"), [form])
        self.assertEqual(forms_of(caps, "look"), [])
        self.assertIs(find_form(caps, "say", "say "), form)
        self.assertIsNone(find_form(caps, "say", "tell "))

    def test_numbers_read_as_javascript_reads_them(self) -> None:
        self.assertEqual([js_number(t) for t in ("0x10", " 12 ", "1e3", ".5", "", "Infinity")], [16, 12, 1000, 0.5, 0, float("inf")])
        for bad in ("abc", "1_0", "inf", "nan", "1,5"):
            self.assertNotEqual(js_number(bad), js_number(bad), bad)  # NaN


class MemoryRetry(unittest.TestCase):
    def run_with(self, failures: list, attempts: int = 5):  # noqa: ANN201
        sleeps: list[float] = []
        calls = [0]

        def operation() -> str:
            calls[0] += 1
            if failures:
                raise failures.pop(0)
            return "ok"

        result = retry_memory(operation, attempts=attempts, sleep=sleeps.append)
        return result, calls[0], [round(s * 1000) for s in sleeps]

    def test_transient_failures_back_off_250ms_doubling_to_2s(self) -> None:
        errors = [ApiError(503, "unavailable", "x"), ApiError(502, "bad", "x"), NetworkError("down"), ApiError(408, "t", "x")]
        self.assertEqual(self.run_with(errors, attempts=5), ("ok", 5, [250, 500, 1000, 2000]))
        self.assertEqual([backoff_ms(n) for n in range(1, 7)], [250, 500, 1000, 2000, 2000, 2000])
        self.assertEqual(backoff_ms(1, 900), 900)

    def test_gives_up_after_the_attempts(self) -> None:
        with self.assertRaises(ApiError):
            self.run_with([ApiError(503, "u", "x")] * 3, attempts=3)

    def test_named_rate_limits_are_waited_out_without_using_attempts(self) -> None:
        limited = [ApiError(429, "rate_limited", "slow", 100) for _ in range(6)]
        self.assertEqual(self.run_with(limited, attempts=1), ("ok", 7, [105] * 6))
        # Up to 30 s of such waits in all.
        with self.assertRaises(ApiError):
            self.run_with([ApiError(429, "rate_limited", "slow", 4000) for _ in range(8)])

    def test_never_retries_refusals_or_long_server_waits(self) -> None:
        for error in (ApiError(409, "conflict", "x"), ApiError(403, "denied", "x"), ApiError(503, "u", "x", 6000), MarinaError("x")):
            with self.assertRaises(type(error)):
                self.run_with([error])
        for bad in (0, 11, True, 2.5):
            with self.assertRaises(ValueError):
                retry_memory(lambda: None, attempts=bad)  # type: ignore[arg-type]

    def test_an_unnamed_429_backs_off_with_its_retry_after(self) -> None:
        self.assertEqual(self.run_with([ApiError(429, "too_many", "x", 1500)]), ("ok", 2, [1500]))


class TypedHttp(unittest.TestCase):
    setUpClass = classmethod(Http.setUpClass.__func__)  # type: ignore[attr-defined]
    tearDownClass = classmethod(Http.tearDownClass.__func__)  # type: ignore[attr-defined]
    setUp = Http.setUp

    def test_typed_methods_take_path_parameters_positionally(self) -> None:
        memory = MemoryApi(self.base, "cred")
        memory.remember("s1", {"content": "x"}, idempotency_key="k")
        memory.get("s1", "r1", version=2)
        RoutingApi(self.base, lambda: "tok").inbox("sess", limit=5)
        paths = [(r["method"], r["path"]) for r in Recorder.seen]
        self.assertEqual(
            paths,
            [
                ("POST", "/v1/memory/spaces/s1/records"),
                ("GET", "/v1/memory/spaces/s1/records/r1?version=2"),
                ("GET", "/api/routing/sessions/sess/inbox?limit=5"),
            ],
        )
        self.assertEqual(Recorder.seen[0]["headers"]["Idempotency-Key"], "k")
        self.assertEqual(memory.call("me"), {"ok": True})  # the generic call stays

    def test_panel_stream_url_and_backoff(self) -> None:
        self.assertEqual(dashboard_ws_url("http://h:1/w", "a b"), "ws://h:1/w/dashboard-ws?token=a%20b")
        self.assertEqual(dashboard_ws_url("https://h", None), "wss://h/dashboard-ws")
        self.assertEqual([watch_delay(n) for n in range(6)], [1, 2, 4, 8, 15, 15])


def _recv_exact(sock: socket.socket, n: int) -> bytes:
    data = b""
    while len(data) < n:
        chunk = sock.recv(n - len(data))
        if not chunk:
            raise ConnectionError("closed")
        data += chunk
    return data


class FakeMarina:
    """A WebSocket server speaking just enough marina.wire.v1: login, auth with rotating tokens, commands."""

    def __init__(self, refuse_resume: bool = False) -> None:
        self.server = socket.create_server(("127.0.0.1", 0))
        self.url = f"ws://127.0.0.1:{self.server.getsockname()[1]}"
        self.refuse_resume = refuse_resume
        self.token = 0
        self.connections: list[socket.socket] = []
        self.auths = 0
        self.lock = threading.Lock()
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self) -> None:
        while True:
            try:
                sock, _ = self.server.accept()
            except OSError:
                return
            with self.lock:
                self.connections.append(sock)
            threading.Thread(target=self._serve, args=(sock,), daemon=True).start()

    def _send(self, sock: socket.socket, frame: dict) -> None:
        sock.sendall(server_frame(0x1, json.dumps(frame).encode()))

    def _session(self, sock: socket.socket) -> None:
        self.token += 1
        self._send(sock, {"kind": "system", "data": {"entityId": "e_1", "name": "bob", "token": f"t{self.token}"}})

    def _serve(self, sock: socket.socket) -> None:
        try:
            head = b""
            while b"\r\n\r\n" not in head:
                head += sock.recv(1024)
            key = next(line.split(":", 1)[1].strip() for line in head.decode().split("\r\n") if line.lower().startswith("sec-websocket-key"))
            sock.sendall(
                f"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept_key(key)}\r\n\r\n".encode()
            )
            while True:
                b0, b1 = _recv_exact(sock, 2)
                n = b1 & 0x7F
                if n == 126:
                    (n,) = struct.unpack("!H", _recv_exact(sock, 2))
                mask = _recv_exact(sock, 4)
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(_recv_exact(sock, n)))
                if b0 & 0x0F == 0x8:
                    return
                frame = json.loads(payload)
                if frame["type"] == "login":
                    self._session(sock)
                elif frame["type"] == "auth":
                    self.auths += 1
                    if self.refuse_resume or frame["token"] != f"t{self.token}":
                        self._send(sock, {"kind": "auth_error", "data": {"text": "Invalid token"}})
                    else:
                        self._session(sock)
                elif frame["type"] == "command":
                    rid = frame["request_id"]
                    self._send(sock, {"kind": "room", "command_request_id": rid, "data": {"text": "A room"}})
                    self._send(sock, {"kind": "system", "data": {"command_result": {"request_id": rid, "ok": True}}})
        except (OSError, ConnectionError, ValueError):
            pass
        finally:
            sock.close()

    def drop(self) -> None:
        with self.lock:
            for sock in self.connections:
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

    def close(self) -> None:
        self.server.close()
        self.drop()


class Reconnect(unittest.TestCase):
    def test_the_backoff_schedule(self) -> None:
        self.assertEqual([reconnect_delay(n) for n in range(10)], [3, 6, 12, 24, 30, 30, 30, 30, 30, 30])

    def until(self, check, seconds: float = 5) -> bool:  # noqa: ANN001
        end = time.monotonic() + seconds
        while not check() and time.monotonic() < end:
            time.sleep(0.01)
        return check()

    def test_resumes_with_the_newest_token_and_fails_fast_meanwhile(self) -> None:
        server = FakeMarina()
        connection = Connection(server.url, reconnect_delay=0.3, max_reconnect_delay=0.3)
        try:
            connection.login("bob")
            self.assertEqual(connection.session.token, "t1")  # type: ignore[union-attr]
            back: list[str] = []
            closed: list[bool] = []
            connection.on_reconnect(lambda session: back.append(session.token))
            connection.on_close(lambda: closed.append(True))
            for expected in ("t2", "t3"):  # twice: the second resume needs the second token
                server.drop()
                self.assertTrue(self.until(lambda: not connection.connected))
                with self.assertRaises(ConnectionLost):
                    connection.command("look")
                self.assertTrue(self.until(lambda: connection.connected))
                self.assertEqual(back[-1], expected)
                self.assertEqual(connection.session.token, expected)  # type: ignore[union-attr]
                self.assertEqual(connection.command("look").text, "A room")
            self.assertEqual(closed, [])
            connection.close()
            self.assertEqual(closed, [True])
            auths = server.auths
            time.sleep(0.5)
            self.assertEqual(server.auths, auths, "close() never reconnects")
            with self.assertRaises(ConnectionLost):
                connection.command("look")
        finally:
            connection.close()
            server.close()

    def test_gives_up_after_the_attempts_and_closes(self) -> None:
        server = FakeMarina(refuse_resume=True)
        connection = Connection(server.url, reconnect_delay=0.01, max_reconnect_delay=0.02, max_reconnect_attempts=3)
        try:
            connection.login("bob")
            closed: list[bool] = []
            connection.on_close(lambda: closed.append(True))
            with self.assertLogs("marina", "WARNING"):
                server.drop()
                self.assertTrue(self.until(lambda: connection.closed))
            self.assertTrue(connection.reconnect_failed)
            self.assertEqual(server.auths, 3)
            self.assertEqual(closed, [True])
        finally:
            connection.close()
            server.close()

    def test_no_reconnect_when_turned_off(self) -> None:
        server = FakeMarina()
        connection = Connection(server.url, auto_reconnect=False)
        try:
            connection.login("bob")
            server.drop()
            self.assertTrue(self.until(lambda: connection.closed))
            self.assertEqual(server.auths, 0)
        finally:
            connection.close()
            server.close()


class Examples(unittest.TestCase):
    def test_the_tell_answering_agent_echoes_the_tag(self) -> None:
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "examples"))
        try:
            import answer_tells  # noqa: PLC0415
            import coding as coding_example  # noqa: PLC0415, F401 - it imports cleanly
        finally:
            sys.path.pop(0)
        self.assertEqual(answer_tells.reply_to("Peer", "ping [re:ab12cd]"), "tell Peer pong [re:ab12cd]")
        self.assertEqual(answer_tells.reply_to("Peer", "why?"), "tell Peer you asked: why?")

        class World:
            def __init__(self) -> None:
                self.listener = None
                self.sent: list[str] = []

            def on_event(self, listener):  # noqa: ANN001, ANN202
                self.listener = listener

            def on_reconnect(self, _callback) -> None:  # noqa: ANN001
                pass

            def command(self, text: str) -> None:
                self.sent.append(text)

        world = World()
        threading.Timer(0.05, lambda: world.listener({"tag": "tell", "data": {"senderName": "Ann", "message": "ping [re:zz11yy]"}})).start()  # type: ignore[misc]
        self.assertEqual(answer_tells.serve(world, rounds=1, idle=0.05), 1)  # type: ignore[arg-type]
        self.assertEqual(world.sent, ["tell Ann pong [re:zz11yy]"])


if __name__ == "__main__":
    unittest.main()
