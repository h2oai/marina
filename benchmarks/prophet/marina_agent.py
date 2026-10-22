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

Identity: none ships. The agent registers under the name the operator gives,
from ``arena.toml`` (``[agent] name`` / ``display_name`` / ``description``,
shipped as placeholders) or the environment, which wins:
  PROPHET_AGENT_NAME          the entrant slug (required; permanent once registered)
  PROPHET_AGENT_DISPLAY_NAME  the name shown on the board (default: the slug)
  PROPHET_AGENT_DESCRIPTION   optional
Loading the agent with the SDK installed refuses (``MissingIdentity``) while the
name is unset or still a placeholder (``your-entrant``, ``Your Org …``).

Environment (operator-set, never sent anywhere but the Marina server):
  MARINA_URL      the Marina server (default http://localhost:3300)
  MARINA_API_KEY  one of that server's MODEL_API_KEYS
  ARENA_API_KEY   the Prophet Arena key (read by the SDK itself)
  PROPHET_ANSWER_JOURNAL  where each answer is appended for write-back
                  (default data/answers.jsonl under the working directory;
                  "off" disables). `bun run benchmarks/prophet/writeback.ts
                  file` files them on Marina's outcome path, `… resolve`
                  scores them when their events resolve, so they teach.

Run:  prophet eval marina_agent.py --dataset prophet-arena-subset-100
      prophet run marina_agent.py --dry-run --once
"""

from __future__ import annotations

import json
import os
import re
import string
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

FORECAST_TIMEOUT_S = 900
_P_MIN, _P_MAX = 0.001, 0.999
# Marina's typed answers take at most this many options per question.
MAX_OPTIONS = 64


MANIFEST = Path(__file__).with_name("arena.toml")
_PLACEHOLDER = re.compile(r"^(<[^>]*>|your\b[\w .-]*|example\b[\w .-]*|changeme|todo)$", re.I)
_DEFAULT_DESCRIPTION = (
    "Built on Marina: open-source multi-model forecasting with research, verification and lessons."
)


class MissingIdentity(RuntimeError):
    """No operator identity: the agent refuses to register or forecast under a default."""


def is_placeholder(value: str) -> bool:
    return bool(_PLACEHOLDER.match(value.strip()))


def agent_identity(
    env: dict[str, str] | None = None, manifest: Path | None = MANIFEST
) -> dict[str, str]:
    """{name, display_name, description} the operator chose (env over arena.toml).

    Raises MissingIdentity when the name is unset or any part is a placeholder.
    """
    env = dict(os.environ) if env is None else env
    table: dict[str, Any] = {}
    if manifest is not None and manifest.is_file():
        import tomllib

        table = tomllib.loads(manifest.read_text(encoding="utf-8")).get("agent", {}) or {}

    def pick(key: str, field: str) -> str:
        return (env.get(key) or str(table.get(field) or "")).strip()

    name = pick("PROPHET_AGENT_NAME", "name")
    display = pick("PROPHET_AGENT_DISPLAY_NAME", "display_name")
    if not display or (is_placeholder(display) and not env.get("PROPHET_AGENT_DISPLAY_NAME")):
        # The shipped placeholder display name yields to the operator's slug.
        display = name
    description = pick("PROPHET_AGENT_DESCRIPTION", "description") or _DEFAULT_DESCRIPTION
    problems = []
    if not name:
        problems.append("PROPHET_AGENT_NAME (or [agent] name in arena.toml)")
    elif is_placeholder(name):
        problems.append(f'PROPHET_AGENT_NAME: "{name}" is a placeholder, not an entrant name')
    if not problems and is_placeholder(display):
        problems.append(f'PROPHET_AGENT_DISPLAY_NAME: "{display}" is a placeholder')
    if problems:
        raise MissingIdentity(
            "prophet: no agent identity — set "
            + " and ".join(problems)
            + ". Marina ships no default identity; the agent registers under the name you give."
        )
    return {"name": name, "display_name": display, "description": description}


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
    # The crowd's prices are the market prior the forecaster may shrink toward
    # (used only when the server's operator turns MARINA_FORECAST_PRIOR on).
    prior = {
        i: float(crowd[n])
        for i, n in by_id.items()
        if n in crowd and 0.0 <= float(crowd[n]) <= 1.0
    }
    if prior:
        body["priors"] = [
            {
                "source": "market",
                "distribution": prior,
                "at": body.get("asOf") or _iso(datetime.now(timezone.utc)),
                "label": "Prophet Arena market",
            }
        ]
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
    config = f"Marina · {formation} of {', '.join(models) or 'operator models'}"
    if checked:
        config += f" · checked by {', '.join(checked)}"
    text = " ".join(dict.fromkeys(reasons))
    return f"{text[:1800]}\n\n{config}".strip()


def call_marina(body: dict[str, Any]) -> dict[str, Any]:
    url = os.environ.get("MARINA_URL", "http://localhost:3300").rstrip("/") + "/v1/forecast"
    # A past window is a dataset replay — a measurement, so Marina never recalls
    # lessons learned from this board; a live window may use every lesson.
    mode = "measure" if body.get("asOf") else "live"
    headers = {
        "Content-Type": "application/json",
        "x-marina-eval": f"benchmark=prophet-arena; mode={mode}",
    }
    key = os.environ.get("MARINA_API_KEY", "").strip()
    if key:
        headers["Authorization"] = f"Bearer {key}"
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), headers=headers, method="POST"
    )
    with urllib.request.urlopen(req, timeout=FORECAST_TIMEOUT_S) as res:
        return json.loads(res.read())


def event_key(event: Any) -> str:
    """The event's stable id for write-back (its id, else its slug), as a safe token."""
    raw = str(getattr(event, "id", None) or getattr(event, "slug", None) or "event")
    key = re.sub(r"[^A-Za-z0-9._:/@+-]", "-", raw).strip("-") or "event"
    return key[:160]


def journal_answers(
    event: Any, asked: list[tuple[dict[str, Any], dict[str, str]]], answers: list[dict[str, Any]]
) -> None:
    """Append each answer for write-back (best-effort: a forecast never fails on it)."""
    path = os.environ.get("PROPHET_ANSWER_JOURNAL", "data/answers.jsonl").strip()
    if not path or path.lower() == "off":
        return
    key = event_key(event)
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            for i, ((body, _), answer) in enumerate(zip(asked, answers)):
                line: dict[str, Any] = {
                    "event": key,
                    "mode": "measure" if body.get("asOf") else "live",
                    "answer": answer,
                }
                if len(asked) > 1:
                    line["part"] = i
                f.write(json.dumps(line) + "\n")
    except OSError:
        pass


def forecast_event(event: Any) -> dict[str, Any]:
    """{probabilities, rationale} for one event (the SDK-independent core)."""
    asked = requests_for(event)
    if len(asked) == 1:
        answers = [call_marina(asked[0][0])]
    else:
        with ThreadPoolExecutor(max_workers=len(asked)) as pool:
            answers = list(pool.map(call_marina, [body for body, _ in asked]))
    journal_answers(event, asked, answers)
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
except ImportError:  # pragma: no cover
    Agent = None

if Agent is not None:  # pragma: no cover
    # Refuses (MissingIdentity) until the operator names the agent.
    _identity = agent_identity()

    class MarinaAgent(Agent):
        name = _identity["name"]
        display_name = _identity["display_name"]
        # Marina does its own research (search, lookups, verification).
        track = "agentic"
        description = _identity["description"]
        card = {
            "methodology": "plan -> date-bounded research -> independent runs -> formation (ensemble/delphi/tournament) -> critique",
            "tools": ["web research", "market and official-series lookups"],
        }

        def forecast(self, event: Event) -> Forecast:
            out = forecast_event(event)
            return Forecast(probabilities=out["probabilities"], rationale=out["rationale"])

    agent = MarinaAgent()
else:
    agent = None
