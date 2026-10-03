# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Marina as a Prophet Arena agent (the `prophet-arena` SDK, MIT).

A thin adapter: each event becomes one typed question for Marina's general
forecaster over ``POST /v1/forecast`` on a Marina server, and the answer's
per-option probabilities become the forecast.

  - mutually exclusive outcomes -> a choice with probabilities (they sum to 1)
  - otherwise                   -> a multi-select with each outcome's own
                                   probability (marginals, never renormalized)

The event's rules, crowd prices and frozen context go in as context; the
evidence cutoff is the forecast window's close. The rationale carries the
answer's reasons and the configuration that produced it (formation, models).

Environment (operator-set, never sent anywhere but the Marina server):
  MARINA_URL      the Marina server (default http://localhost:3300)
  MARINA_API_KEY  one of that server's MODEL_API_KEYS
  ARENA_API_KEY   the Prophet Arena key (read by the SDK itself)

Run:  prophet eval marina_agent.py --dataset prophet-arena-subset-100
      prophet run marina_agent.py --dry-run --once
"""

from __future__ import annotations

import json
import os
import string
import urllib.request
from datetime import datetime, timezone
from typing import Any

FORECAST_TIMEOUT_S = 900
_P_MIN, _P_MAX = 0.001, 0.999


def option_ids(n: int) -> list[str]:
    """A, B, C, ... (O1, O2, ... past 26): short ids the models answer with."""
    if n <= 26:
        return list(string.ascii_uppercase[:n])
    return [f"O{i + 1}" for i in range(n)]


def _iso(t: Any) -> str | None:
    if t is None:
        return None
    if isinstance(t, datetime):
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
        return t.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return str(t)


def request_for(event: Any) -> tuple[dict[str, Any], dict[str, str]]:
    """The /v1/forecast body for an event, and option id -> outcome name."""
    names = [o.name for o in event.outcomes]
    ids = option_ids(len(names))
    by_id = dict(zip(ids, names))
    options = [{"id": i, "label": n} for i, n in by_id.items()]
    exclusive = bool(getattr(event, "mutually_exclusive", False))
    answer: dict[str, Any] = (
        {"type": "choice", "options": options, "probabilities": True}
        if exclusive
        else {"type": "multi", "options": options, "minPicks": 0, "probabilities": True}
    )
    lines: list[str] = []
    if getattr(event, "criteria", None):
        lines.append(f"Rules: {event.criteria}")
    for o in event.outcomes:
        if getattr(o, "criteria", None) and o.criteria != getattr(event, "criteria", None):
            lines.append(f"Rules for {o.name}: {o.criteria}")
    crowd = getattr(event, "crowd", None) or {}
    if crowd:
        lines.append(
            "Market prices: " + ", ".join(f"{k} {float(v):.2f}" for k, v in crowd.items())
        )
    for s in (getattr(event, "context", None) or [])[:8]:
        parts = [p for p in (s.title, s.summary, s.url) if p]
        if parts:
            lines.append("Source: " + " — ".join(parts))
    lines.append(
        "Give each outcome's probability"
        + (" (exactly one happens)." if exclusive else " of being true, each on its own.")
    )
    body: dict[str, Any] = {
        "question": (event.title or event.slug)[:1000],
        "answer": answer,
        "context": "\n".join(lines)[:4000],
    }
    close = _iso(getattr(event, "close_at", None))
    if close:
        body["endTime"] = close
    # A past window (a dataset replay) freezes the evidence there; a live one is now.
    window = getattr(event, "window_closes_at", None)
    if isinstance(window, datetime):
        w = window if window.tzinfo else window.replace(tzinfo=timezone.utc)
        if w < datetime.now(timezone.utc):
            body["asOf"] = _iso(w)
    return body, by_id


def probabilities_from(answer: dict[str, Any], by_id: dict[str, str]) -> dict[str, float]:
    """Every outcome's probability from Marina's answer (raises when it has none)."""
    dist = answer.get("distribution") or {}
    if not all(i in dist for i in by_id):
        raise RuntimeError(answer.get("caveat") or "Marina returned no probabilities")
    return {
        name: min(_P_MAX, max(_P_MIN, float(dist[i]))) for i, name in by_id.items()
    }


def rationale_from(answer: dict[str, Any]) -> str:
    reasons = [r.get("reason") for r in answer.get("runs", []) if r.get("reason")]
    models = sorted({r.get("model") for r in answer.get("runs", []) if r.get("model")})
    formation = (answer.get("formation") or {}).get("pattern", "ensemble")
    config = f"H2O.ai Marina · {formation} of {', '.join(models) or 'operator models'}"
    text = " ".join(dict.fromkeys(reasons))
    return f"{text[:1800]}\n\n{config}".strip()


def call_marina(body: dict[str, Any]) -> dict[str, Any]:
    url = os.environ.get("MARINA_URL", "http://localhost:3300").rstrip("/") + "/v1/forecast"
    headers = {"Content-Type": "application/json"}
    key = os.environ.get("MARINA_API_KEY", "").strip()
    if key:
        headers["Authorization"] = f"Bearer {key}"
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), headers=headers, method="POST"
    )
    with urllib.request.urlopen(req, timeout=FORECAST_TIMEOUT_S) as res:
        return json.loads(res.read())


def forecast_event(event: Any) -> dict[str, Any]:
    """{probabilities, rationale} for one event (the SDK-independent core)."""
    body, by_id = request_for(event)
    answer = call_marina(body)
    return {"probabilities": probabilities_from(answer, by_id), "rationale": rationale_from(answer)}


try:  # The SDK is needed only to run the agent, not to test the mapping.
    from arena import Agent, Event, Forecast

    class MarinaAgent(Agent):
        name = "h2oai-marina"
        display_name = "H2O.ai Marina"
        # Marina does its own research (search, lookups, verification).
        track = "agentic"
        description = "H2O.ai Marina: open-source multi-model forecasting with research, verification and lessons."
        card = {
            "methodology": "plan -> date-bounded research -> independent runs -> formation (ensemble/delphi/tournament) -> critique",
            "tools": ["web research", "market and official-series lookups"],
        }

        def forecast(self, event: Event) -> Forecast:
            out = forecast_event(event)
            return Forecast(probabilities=out["probabilities"], rationale=out["rationale"])

    agent = MarinaAgent()
except ImportError:  # pragma: no cover
    agent = None
