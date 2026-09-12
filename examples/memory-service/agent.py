# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
"""A deterministic protocol agent: its cross-process state lives only in Marina.

This proves memory-service behavior, not LLM intelligence or general task quality.
The harness supplies credentials; this client never reads server files or SQLite.
"""
import hashlib
import json
import os
import secrets
import sys
import time

from marina_memory import MarinaMemory, MemoryError

memory = MarinaMemory(os.environ["MARINA_MEMORY_URL"], os.environ["MARINA_MEMORY_TOKEN"],
                      os.environ["MARINA_MEMORY_SPACE"])
phase = sys.argv[1]

if phase == "learn":
    fingerprint = secrets.token_hex(20)
    source = memory.capture({"role": "tool", "artifact_fingerprint": fingerprint,
                             "requirement": "Retain the original artifact proof across restarts."},
                            session_id="qualification", key="evidence")
    facts = [
        ("I avoid all animal products.", "vegan diet", "animal products"),
        ("Travel from London to Paris on the Eurostar.", "cross-channel rail journey", "Eurostar"),
        ("The release may proceed only after the security review is approved.",
         "conditions before shipping software", "security review"),
    ]
    tasks, receipts = [], []
    for content, query, lexical_query in facts:
        receipt = memory.remember(content, type="fact")
        receipts.append(receipt)
        tasks.append({"id": receipt["id"], "query": query, "lexical_query": lexical_query})
    for content in ["The telescope observes distant galaxies.", "Water boils at sea level.",
                    "The gardener planted roses in spring.", "The orchestra rehearses on Mondays.",
                    "The database backup uses encrypted storage.", "My bicycle has a broken chain."]:
        receipts.append(memory.remember(content))
    artifact = memory.remember("The recovery artifact fingerprint is " + fingerprint,
                               source_ids=[source["id"]])
    receipts.append(artifact)
    location = memory.remember("My office is in Berlin.", subject="office")
    receipts.append(location)
    for receipt in receipts:
        memory.wait_for_index(receipt)
    memory.save_checkpoint({"phase": "resume", "tasks": tasks, "artifact_id": artifact["id"],
                            "artifact_hash": hashlib.sha256(fingerprint.encode()).hexdigest(),
                            "source_id": source["id"], "location_id": location["id"]},
                           source_cursor=source["seq"], key="checkpoint")
    print(json.dumps({"phase": "learn", "stored": len(receipts), "checkpoint_acknowledged": True}))
elif phase == "resume":
    checkpoint = memory.checkpoint()
    state = checkpoint["data"]
    semantic = os.environ.get("MARINA_MEMORY_SEMANTIC") == "1"
    timings, hits, lexical_hits = [], 0, 0
    for task in state["tasks"]:
        lexical = memory.search(task["query"], mode="lexical", limit=3)
        lexical_hits += any(r["id"] == task["id"] for r in lexical["results"])
        start = time.monotonic()
        result = memory.search(task["query"] if semantic else task["lexical_query"],
                               mode="hybrid" if semantic else "lexical", limit=3)
        timings.append(round((time.monotonic() - start) * 1000, 2))
        assert not result["degraded"], result["degraded"]
        assert any(r["id"] == task["id"] for r in result["results"]), task["query"]
        hits += 1
    artifact = memory.search("recovery artifact fingerprint", mode="lexical", limit=1)["results"][0]
    assert artifact["id"] == state["artifact_id"]
    assert hashlib.sha256(artifact["content"].split()[-1].encode()).hexdigest() == state["artifact_hash"]
    assert memory.sources()["sources"][0]["seq"] == checkpoint["source_cursor"]
    revised = memory.revise(state["location_id"], 1, "My office is in Paris.", key="correct-office")
    memory.wait_for_index(revised)
    assert memory.revise(state["location_id"], 1, "My office is in Paris.", key="correct-office") == revised
    try:
        memory.revise(state["location_id"], 1, "Stale office location.", key="stale-office")
        raise AssertionError("stale revision accepted")
    except MemoryError as error:
        assert error.status == 409
    current = memory.search("office", mode="lexical", subject="office")["results"]
    assert len(current) == 1 and current[0]["version"] == 2 and "Paris" in current[0]["content"]
    assert "Berlin" in memory.get(state["location_id"], version=1)["content"]
    context = memory.context("office", budget_tokens=384, mode="lexical")
    assert len(context["text"].encode()) <= 384 and context["citations"][0]["version"] == 2
    exported = memory.export()
    assert exported["schema"] == "marina.memory.bundle.v1" and len(exported["records"]) >= 10
    memory.forget(source_ids=[state["source_id"]], key="forget-evidence")
    assert not memory.search("recovery artifact fingerprint", mode="lexical")["results"]
    try:
        memory.checkpoint()
        raise AssertionError("checkpoint copy survived forgetting")
    except MemoryError as error:
        assert error.status == 404
    print(json.dumps({"phase": "resume", "retrieval_hits_at_3": hits, "retrieval_cases": len(state["tasks"]),
                      "semantic_required": semantic, "lexical_paraphrase_hits_at_3": lexical_hits,
                      "search_ms": timings, "artifact_integrity": True, "revision_conflict": True,
                      "bounded_context": True, "source_forgetting": True, "export": True}))
else:
    raise SystemExit("Expected learn or resume")
