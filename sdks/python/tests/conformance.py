# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
"""The Python SDK's conformance driver: the scenarios of protocol/conformance.md, through the
SDK's public API only.

    python3 sdks/python/tests/conformance.py <scenario> <server url> '<args JSON>'

Prints {"ready": {...}} and waits for a {"go": {...}} line when it needs the test to act; ends
with {"report": {...}} (or {"error": "..."} and a non-zero exit). Logs go to stderr.
"""

from __future__ import annotations

import dataclasses
import json
import os
import re
import sys
import time
import traceback
import urllib.request
from typing import Any, Callable

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from marina import (  # noqa: E402
    CommandError,
    Marina,
    MarinaError,
    compose_command,
    retry_memory,
)

_argv = sys.argv[1:4] + ["", "", "{}"][len(sys.argv[1:4]) :]
scenario, url = _argv[0], _argv[1]
args: dict[str, Any] = json.loads(_argv[2] or "{}")
name = str(args.get("name") or "pydriver")


def say(line: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(line) + "\n")
    sys.stdout.flush()


def ready(info: dict[str, Any]) -> dict[str, Any]:
    """Tell the test we are waiting, then wait for its "go" line."""
    say({"ready": info})
    line = sys.stdin.readline()
    return (json.loads(line).get("go") or {}) if line.strip() else {}


def until(check: Callable[[], bool], seconds: float) -> bool:
    end = time.monotonic() + seconds
    while not check() and time.monotonic() < end:
        time.sleep(0.02)
    return check()


def _camel(key: str) -> str:
    return re.sub(r"_([a-z])", lambda m: m.group(1).upper(), key)


def wire(value: Any) -> Any:
    """A typed SDK value with the protocol's field names, without empty fields."""
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        value = {f.name: getattr(value, f.name) for f in dataclasses.fields(value) if f.name != "raw"}
    if isinstance(value, dict):
        return {_camel(k): wire(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [wire(v) for v in value]
    return value


def coding() -> dict[str, Any]:
    marina = Marina.connect(url, name=name)
    ready({"entity": marina.session.entity_id})
    frames: list[dict[str, Any]] = []
    marina.on_event(lambda f: frames.append(f) if (f.get("data") or {}).get("code") else None)
    run = marina.code.run(str(args["task"]), verification="candidate", timeout=120)
    events = list(run.events())
    result = run.result()
    report = {
        "run_id": run.run_id,
        "result": result.raw,
        "typed_result": wire(result),
        "submitted": result.submitted,
        "summary": result.summary,
        "steps": [wire(e.activity) for e in events if e.activity],
        "last_event_run": events[-1].result.run_id if events and events[-1].result else None,
        "diff": marina.code.diff(),
    }
    marina.code.review(result.run_id, "approve")
    time.sleep(0.2)  # the listener thread hands over the last frames
    report["frames"] = list(frames)
    marina.close()
    return report


def commands() -> dict[str, Any]:
    marina = Marina.connect(url, name=name)
    look = marina.command("look").text
    refused = ""
    try:
        marina.command("frobnicate the moon")
    except CommandError as error:
        refused = str(error)
    manifest = marina.capabilities()
    form = next((f for f in marina.forms("say") if f["syntax"].startswith("say ")), None)
    if not form:
        raise MarinaError("no say form")
    field = next((f for f in form["fields"] if f["label"] == "message"), form["fields"][0])
    missing = compose_command(form, {}, {})
    composed = compose_command(form, {field["id"]: f"hello from {name}"}, {})
    said = marina.command(composed.command).text
    marina.close()
    return {
        "look": look,
        "refused": refused,
        "capability_count": len(manifest.get("commands", [])),
        "composed": composed.command,
        "missing_errors": len(missing.errors),
        "said": said,
    }


def reconnect() -> dict[str, Any]:
    marina = Marina.connect(url, name=name)
    entity, token = marina.session.entity_id, marina.session.token
    reconnects: list[str] = []
    marina.on_reconnect(lambda session: reconnects.append(session.token))
    ready({"entity": entity})
    back = until(lambda: bool(reconnects) and marina.connection.connected, 30)
    look = len(marina.command("look")) > 0 if back else False
    report = {
        "reconnected": back,
        "same_entity": marina.session.entity_id == entity,
        "token_changed": marina.session.token != token,
        "look_ok": look,
    }
    marina.close()
    return report


def agent() -> dict[str, Any]:
    marina = Marina.connect(url, name=name)
    peer = str(args["peer"])
    reply = marina.tell_and_await(peer, "ping", timeout=15)
    ready({"listening": True})
    heard = marina.wait_for_tell(peer, timeout=15)
    marina.tell(peer, f"answer: {heard}")
    marina.close()
    return {"reply": reply, "heard": heard}


def memory() -> dict[str, Any]:
    marina = Marina.connect(url, name=name)
    mem = marina.memory(str(args["credential"]))
    space = mem.create_space({"name": f"{name}-space"})["id"]
    first = mem.remember(space, {"content": "Deploys run from main"}, idempotency_key="conf-1")
    again = mem.remember(space, {"content": "Deploys run from main"}, idempotency_key="conf-1")
    record = mem.get(space, first["id"])
    found = mem.search(space, {"query": "deploy"})
    waits = 0

    def sleep(seconds: float) -> None:
        nonlocal waits
        waits += 1
        time.sleep(seconds)

    count = int(args.get("burst") or 140)
    for i in range(count):
        key = f"conf-burst-{i}"  # the same key on every retry of one write
        retry_memory(lambda i=i, key=key: mem.remember(space, {"content": f"note {i}"}, idempotency_key=key), sleep=sleep)
    marina.close()
    return {
        "space": space,
        "receipt_id": first["id"],
        "replayed": first["id"] == again["id"] and first.get("version") == again.get("version"),
        "content": record["content"],
        "found": "Deploys run from main" in json.dumps(found),
        "written": count,
        "rate_limit_waits": waits,
    }


def panels() -> dict[str, Any]:
    marina = Marina.connect(url, name=name)
    seen: list[dict[str, Any]] = []
    snapshots: list[bool] = []
    stop = marina.panels.watch_changes(seen.append, lambda: snapshots.append(True))
    until(lambda: bool(snapshots), 10)
    marina.command(f"canvas create {name}board")
    marina.command(f"canvas post on:{name}board hello from {name}")
    got = until(lambda: any(e.get("canvasId") for e in seen), 10)
    stop()
    marina.close()
    return {
        "snapshot": bool(snapshots),
        "got_canvas_event": got,
        "event_types": sorted({e["type"] for e in seen}),
    }


def routing() -> dict[str, Any]:
    marina = Marina.connect(url, name=name)
    r = marina.routing
    a = r.join_session({"clientKey": f"{name}-a", "label": "A", "kind": "service"})
    b = r.join_session({"clientKey": f"{name}-b", "label": "B", "kind": "service"})
    r.publish(a["id"], {"events": [{"id": "e1", "kind": "output", "payload": {"text": "hello"}}]})
    sent = r.send(a["id"], {"clientMessageId": "m1", "targetId": b["id"], "kind": "note", "payload": "hi"})
    inbox = r.inbox(b["id"])
    r.acknowledge_message(b["id"], sent["id"], {})
    events = r.events(a["id"])
    marina.close()
    return {
        "session_a": a["id"],
        "inbox_has_message": sent["id"] in json.dumps(inbox),
        "published": "hello" in json.dumps(events),
    }


def local() -> dict[str, Any]:
    folder, command = str(args["folder"]), list(args["command"])
    marina = Marina.local(folder, fresh=True, command=command)
    with urllib.request.urlopen(f"{marina.http_url}/api/setup-status", timeout=10) as response:
        pid = int(json.loads(response.read())["pid"])
    refused = ""
    try:
        marina.code.run("Add a README")
    except MarinaError as error:
        refused = str(error)
    look = len(marina.look()) > 0
    session_name = marina.session.name
    marina.close()
    try:
        os.kill(pid, 0)
        stopped = False
    except OSError:
        stopped = True
    missing = ""
    try:
        Marina.local(os.path.join(folder, "missing"), command=command).close()
    except MarinaError as error:
        missing = str(error)
    return {"name": session_name, "refused": refused, "look": look, "stopped": stopped, "missing": missing}


SCENARIOS: dict[str, Callable[[], dict[str, Any]]] = {
    "coding": coding,
    "commands": commands,
    "reconnect": reconnect,
    "agent": agent,
    "memory": memory,
    "panels": panels,
    "routing": routing,
    "local": local,
}

if __name__ == "__main__":
    run = SCENARIOS.get(scenario)
    if not run:
        say({"error": f"unknown scenario {scenario}"})
        sys.exit(1)
    try:
        say({"report": run()})
    except BaseException:  # noqa: BLE001 - every failure is reported to the test
        say({"error": traceback.format_exc()})
        sys.exit(1)
    sys.exit(0)
