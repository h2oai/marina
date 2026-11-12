# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Live: a coding run through the Python SDK. Driven by test/python-sdk.test.ts.

argv: <server url> <task> <memory credential>. Prints {"entity": ...}, waits for a line on stdin
(the test grants code.exec), then prints one JSON report.
"""

import dataclasses
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src"))

from marina import CodeEvent, CommandError, Marina, classify_frame  # noqa: E402

url, task, credential = sys.argv[1:4]
marina = Marina.connect(url, name="pybuilder")
print(json.dumps({"entity": marina.session.entity_id}), flush=True)
sys.stdin.readline()

frames = []
marina.on_event(lambda f: frames.append(f) if classify_frame(f) == "Code" else None)
report = {}
try:
    try:
        marina.code.run("   ")
    except ValueError as error:
        report["empty"] = str(error)
    run = marina.code.run(task, verification="candidate", timeout=120)
    events: list[CodeEvent] = list(run.events())
    result = run.result()
    report["run_id"] = run.run_id
    report["result"] = result.raw
    report["result_fields"] = {
        "run_id": result.run_id,
        "submitted": result.submitted,
        "verified": result.verified,
        "summary": result.summary,
    }
    report["steps"] = [dataclasses.asdict(e.activity) for e in events if e.activity]
    report["last_event_run"] = events[-1].result.run_id if events and events[-1].result else None
    report["diff"] = marina.code.diff()
    marina.code.review(result.run_id, "approve")
    report["look"] = marina.command("look").text
    try:
        marina.command("frobnicate the moon")
    except CommandError as error:
        report["refused"] = str(error)
    report["discover"] = marina.routing.discover()
    report["capability_count"] = len(marina.capabilities().get("commands", []))

    memory = marina.memory(credential)
    space = memory.create_space(body={"name": "pyspace"})["id"]
    first = memory.remember(space=space, body={"content": "Deploys run from main"}, idempotency_key="py-1")
    again = memory.remember(space=space, body={"content": "Deploys run from main"}, idempotency_key="py-1")
    found = memory.search(space=space, body={"query": "deploy"})
    report["memory"] = {"replayed": first == again, "found": json.dumps(found).count("Deploys run from main") > 0}

    entity, token = marina.session.entity_id, marina.token
    marina.close()
    resumed = Marina.connect(url, token=token)
    report["resumed"] = {"same": resumed.session.entity_id == entity, "new_token": resumed.token != token}
    resumed.close()
finally:
    marina.close()
report["frames"] = frames
print(json.dumps(report), flush=True)
