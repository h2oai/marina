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
        # The crowd's prices go in as the market prior, observed at the frozen window.
        self.assertEqual(body["priors"][0]["source"], "market")
        self.assertEqual(body["priors"][0]["distribution"], {"A": 0.6, "B": 0.4})
        self.assertEqual(body["priors"][0]["at"], body["asOf"])

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


def wide(n: int, exclusive: bool = False) -> NS:
    e = event(exclusive)
    e.outcomes = [NS(name=f"Outcome {i}", criteria=None) for i in range(n)]
    e.crowd = {f"Outcome {i}": 0.01 for i in range(n)}
    return e


class Shapes(unittest.TestCase):
    def test_a_single_outcome_is_yes_or_no(self):
        e = event(False)
        e.outcomes = [NS(name="Before 2026", criteria=None)]
        body, by_id = m.request_for(e)
        self.assertEqual(body["answer"]["type"], "choice")
        self.assertEqual([o["id"] for o in body["answer"]["options"]], ["A", "B"])
        self.assertEqual(by_id, {"A": "Before 2026"})
        probs = m.probabilities_from({"distribution": {"A": 0.8, "B": 0.2}}, by_id)
        self.assertEqual(probs, {"Before 2026": 0.8})
        # Its crowd price is the yes side of the market prior (the server fills the no side).
        e.crowd = {"Before 2026": 0.3}
        body, _ = m.request_for(e)
        self.assertEqual(body["priors"][0]["distribution"], {"A": 0.3})

    def test_wide_events_are_asked_in_balanced_parts(self):
        self.assertEqual([len(p) for p in m.parts_of(64)], [64])
        self.assertEqual([len(p) for p in m.parts_of(75)], [38, 37])
        self.assertEqual([len(p) for p in m.parts_of(156)], [52, 52, 52])
        asked = m.requests_for(wide(75))
        self.assertEqual(len(asked), 2)
        names = [n for _, by_id in asked for n in by_id.values()]
        self.assertEqual(names, [f"Outcome {i}" for i in range(75)])
        for body, _ in asked:
            self.assertEqual(body["answer"]["type"], "multi")
            self.assertLessEqual(len(body["answer"]["options"]), m.MAX_OPTIONS)
            self.assertIn("of the event's 75 outcomes", body["context"])
        # Each part shows only its own outcomes' prices.
        self.assertIn("Outcome 0 0.01", asked[0][0]["context"])
        self.assertNotIn("Outcome 74 0.01", asked[0][0]["context"])
        self.assertIn("Outcome 74 0.01", asked[1][0]["context"])
        # ... and its market prior prices only its own options.
        for body, by_id in asked:
            self.assertEqual(set(body["priors"][0]["distribution"]), set(by_id))

    def test_a_wide_exclusive_event_is_normalized(self):
        calls = []

        def fake(body):
            calls.append(body)
            return {"distribution": {o["id"]: 0.02 for o in body["answer"]["options"]}, "runs": []}

        real, m.call_marina = m.call_marina, fake
        try:
            out = m.forecast_event(wide(100, exclusive=True))
        finally:
            m.call_marina = real
        self.assertEqual(len(calls), 2)
        self.assertAlmostEqual(sum(out["probabilities"].values()), 1.0)
        self.assertIn("Asked in 2 parts", out["rationale"])

    def test_rationale_names_the_checkers(self):
        answer = {
            "runs": [{"model": "a/x", "reason": "R.", "verified": {"model": "b/y"}}],
            "critique": {"model": "b/y"},
        }
        self.assertIn("ensemble of a/x · checked by b/y", m.rationale_from(answer))


class Manifest(unittest.TestCase):
    def test_arena_toml_has_the_agent_table_the_cli_reads(self):
        import tomllib
        from pathlib import Path

        data = tomllib.loads((Path(__file__).parent / "arena.toml").read_text())
        self.assertEqual(data["agent"]["name"], "h2oai-marina")
        self.assertEqual(data["agent"]["track"], "agentic")
        self.assertEqual(data["agent"]["display_name"], "H2O.ai Marina")


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
