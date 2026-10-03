# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Offline checks of the Prophet Arena adapter (stdlib only; no SDK, no network):

    python3 -m unittest benchmarks/prophet/test_marina_agent.py
"""

from __future__ import annotations

import json
import os
import threading
import unittest
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from types import SimpleNamespace as NS

import marina_agent as m  # noqa: E402  (run from this directory or with it on sys.path)


def event(exclusive: bool, window: datetime | None = None) -> NS:
    return NS(
        slug="synthetic-event",
        title="Which synthetic outcome happens?",
        criteria="Resolves to the outcome reported by the synthetic source.",
        close_at=datetime(2026, 12, 1, tzinfo=timezone.utc),
        window_closes_at=window,
        outcomes=[NS(name="Red", criteria=None), NS(name="Green", criteria=None)],
        crowd={"Red": 0.6, "Green": 0.4},
        context=[NS(title="A source", summary="Something happened.", url="https://example.org")],
        mutually_exclusive=exclusive,
    )


class Mapping(unittest.TestCase):
    def test_exclusive_is_a_probabilistic_choice(self):
        body, by_id = m.request_for(event(True))
        self.assertEqual(body["answer"]["type"], "choice")
        self.assertTrue(body["answer"]["probabilities"])
        self.assertEqual(by_id, {"A": "Red", "B": "Green"})
        self.assertIn("Market prices: Red 0.60, Green 0.40", body["context"])
        self.assertNotIn("asOf", body)

    def test_non_exclusive_is_marginals(self):
        body, _ = m.request_for(event(False))
        self.assertEqual(body["answer"]["type"], "multi")
        self.assertEqual(body["answer"]["minPicks"], 0)

    def test_a_past_window_freezes_the_evidence(self):
        past = datetime.now(timezone.utc) - timedelta(days=30)
        body, _ = m.request_for(event(True, past))
        self.assertTrue(body["asOf"].endswith("Z"))

    def test_probabilities_and_rationale(self):
        answer = {
            "distribution": {"A": 1.0, "B": 0.0},
            "runs": [{"model": "x/model", "reason": "Because."}],
            "formation": {"pattern": "delphi"},
        }
        probs = m.probabilities_from(answer, {"A": "Red", "B": "Green"})
        self.assertEqual(probs, {"Red": 0.999, "Green": 0.001})
        self.assertIn("delphi of x/model", m.rationale_from(answer))
        with self.assertRaises(RuntimeError):
            m.probabilities_from({"caveat": "no run"}, {"A": "Red"})


class Server(unittest.TestCase):
    def test_calls_v1_forecast_with_the_key(self):
        seen: dict = {}

        class H(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                seen["path"] = self.path
                seen["auth"] = self.headers.get("Authorization")
                seen["body"] = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                out = json.dumps({"distribution": {"A": 0.7, "B": 0.3}, "runs": []}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(out)

            def log_message(self, *a):
                pass

        srv = HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        os.environ["MARINA_URL"] = f"http://127.0.0.1:{srv.server_port}"
        os.environ["MARINA_API_KEY"] = "test-key"
        try:
            out = m.forecast_event(event(True))
        finally:
            srv.shutdown()
        self.assertEqual(seen["path"], "/v1/forecast")
        self.assertEqual(seen["auth"], "Bearer test-key")
        self.assertEqual(out["probabilities"], {"Red": 0.7, "Green": 0.3})


if __name__ == "__main__":
    unittest.main()
