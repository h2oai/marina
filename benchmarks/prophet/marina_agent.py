# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Marina as a Prophet Arena agent (the `prophet-arena` SDK, MIT).

A thin adapter: each event becomes one typed question for Marina's general
forecaster over ``POST /v1/forecast`` on a Marina server, and the answer's
per-option probabilities become the forecast.

  - mutually exclusive outcomes -> a choice with probabilities (they sum to 1)
  - otherwise                   -> a multi-select with each outcome's own
                                   probability (marginals, never renormalized)
  - a single outcome            -> a yes/no choice; its probability is P(yes)
  - more than 64 outcomes       -> asked in balanced parts of at most 64 (an
                                   exclusive event's parts are normalized after)

The event's rules, crowd prices and frozen context go in as context; the
evidence cutoff is the forecast window's close. The rationale carries the
answer's reasons and the configuration that produced it (formation, models,
checkers).

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
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any

FORECAST_TIMEOUT_S = 900
_P_MIN, _P_MAX = 0.001, 0.999
# Marina's typed answers take at most this many options per question.
MAX_OPTIONS = 64


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


def parts_of(n: int) -> list[range]:
    """Index ranges of at most MAX_OPTIONS outcomes, balanced in size."""
    if n <= MAX_OPTIONS:
        return [range(n)]
    k = -(-n // MAX_OPTIONS)
    size = -(-n // k)
    return [range(i, min(n, i + size)) for i in range(0, n, size)]


def request_for(
    event: Any, part: range | None = None
) -> tuple[dict[str, Any], dict[str, str]]:
    """The /v1/forecast body for an event (or for one part of a wide event's
    outcomes), and option id -> outcome name."""
    total = len(event.outcomes)
    outcomes = [event.outcomes[i] for i in part] if part is not None else list(event.outcomes)
    names = [o.name for o in outcomes]
    exclusive = bool(getattr(event, "mutually_exclusive", False))
    single = total == 1
    answer: dict[str, Any]
    if single:
        # One outcome: the question is whether it happens.
        by_id = {"A": names[0]}
        options = [{"id": "A", "label": f"Yes: {names[0]}"}, {"id": "B", "label": "No"}]
        answer = {"type": "choice", "options": options, "probabilities": True}
    else:
        ids = option_ids(len(names))
        by_id = dict(zip(ids, names))
        options = [{"id": i, "label": n} for i, n in by_id.items()]
        # A part of an exclusive event is asked as marginals and normalized after.
        answer = (
            {"type": "choice", "options": options, "probabilities": True}
            if exclusive and part is None
            else {"type": "multi", "options": options, "minPicks": 0, "probabilities": True}
        )
    lines: list[str] = []
    if getattr(event, "criteria", None):
        lines.append(f"Rules: {event.criteria}")
    for o in outcomes:
        if getattr(o, "criteria", None) and o.criteria != getattr(event, "criteria", None):
            lines.append(f"Rules for {o.name}: {o.criteria}")
    crowd = getattr(event, "crowd", None) or {}
    if part is not None:
        crowd = {k: v for k, v in crowd.items() if k in set(names)}
    if crowd:
        lines.append(
            "Market prices: " + ", ".join(f"{k} {float(v):.2f}" for k, v in crowd.items())
        )
    if part is not None:
        lines.append(
            f"These are {len(names)} of the event's {total} outcomes"
            f" ({names[0]} to {names[-1]}); the others are asked separately."
        )
    for s in (getattr(event, "context", None) or [])[:8]:
        parts = [p for p in (s.title, s.summary, s.url) if p]
        if parts:
            lines.append("Source: " + " — ".join(parts))
    if single:
        lines.append(f"Give the probability that {names[0]} happens.")
    elif exclusive and part is None:
        lines.append("Give each outcome's probability (exactly one happens).")
    else:
        lines.append("Give each outcome's probability of being true, each on its own.")
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


def requests_for(event: Any) -> list[tuple[dict[str, Any], dict[str, str]]]:
    """One request, or one per part when the event has more outcomes than a
    typed answer takes."""
    parts = parts_of(len(event.outcomes))
    if len(parts) == 1:
        return [request_for(event)]
    return [request_for(event, part) for part in parts]


def probabilities_from(answer: dict[str, Any], by_id: dict[str, str]) -> dict[str, float]:
    """Every outcome's probability from Marina's answer (raises when it has none)."""
    dist = answer.get("distribution") or {}
    if not all(i in dist for i in by_id):
        raise RuntimeError(answer.get("caveat") or "Marina returned no probabilities")
    return {
        name: min(_P_MAX, max(_P_MIN, float(dist[i]))) for i, name in by_id.items()
    }


def rationale_from(answer: dict[str, Any]) -> str:
    runs = answer.get("runs", [])
    reasons = [r.get("reason") for r in runs if r.get("reason")]
    models = sorted({r.get("model") for r in runs if r.get("model")})
    checkers = {(r.get("verified") or {}).get("model") for r in runs}
    checkers.add((answer.get("critique") or {}).get("model"))
    checked = sorted(c for c in checkers if c)
    formation = (answer.get("formation") or {}).get("pattern", "ensemble")
    config = f"H2O.ai Marina · {formation} of {', '.join(models) or 'operator models'}"
    if checked:
        config += f" · checked by {', '.join(checked)}"
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
    asked = requests_for(event)
    if len(asked) == 1:
        answers = [call_marina(asked[0][0])]
    else:
        with ThreadPoolExecutor(max_workers=len(asked)) as pool:
            answers = list(pool.map(call_marina, [body for body, _ in asked]))
    probabilities: dict[str, float] = {}
    for (_, by_id), answer in zip(asked, answers):
        probabilities.update(probabilities_from(answer, by_id))
    if len(asked) > 1 and getattr(event, "mutually_exclusive", False):
        # The parts were asked as marginals; exactly one outcome happens.
        total = sum(probabilities.values())
        probabilities = {
            k: min(_P_MAX, max(_P_MIN, v / total)) for k, v in probabilities.items()
        }
    rationale = rationale_from(answers[0])
    if len(asked) > 1:
        rationale = f"(Asked in {len(asked)} parts of at most {MAX_OPTIONS} outcomes.) {rationale}"
    return {"probabilities": probabilities, "rationale": rationale}


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
