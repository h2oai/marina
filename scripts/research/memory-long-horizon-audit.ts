// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Functional research audit, not a quality benchmark or a conformance suite.
 * Run: bun run scripts/research/memory-long-horizon-audit.ts
 * Real DB, command handlers, platform adapter and compactor; synthetic residents,
 * disposable databases, simulated time. No network, model calls or live data.
 * Exit success means the observations were collected, not that invariants passed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
  createContextManager,
  estimateMessageTokens,
  truncateOversizedToolResults,
} from "../../src/agent/context-manager";
import { PlatformMemoryBackend } from "../../src/agent/memory-platform";
import { Engine } from "../../src/engine/engine";
import { MarinaDB } from "../../src/persistence/database";
import type { MarinaClient } from "../../src/sdk/client";
import { roomId } from "../../src/types";
import { MockConnection, makeTestRoom, stripAnsi } from "../../test/helpers";

const directory = mkdtempSync(join(tmpdir(), "marina-memory-horizon-"));
const realNow = Date.now;
let clock = Date.parse("2026-01-01T00:00:00Z");
Date.now = () => clock;
const day = 86_400_000;
const observations: {
  id: string;
  desired_invariant: string;
  satisfied_in_fixture: boolean;
  observed: Record<string, unknown>;
}[] = [];
let fixtureNumber = 0;

function record(
  id: string,
  desired: string,
  satisfied: boolean,
  observed: Record<string, unknown>,
) {
  observations.push({ id, desired_invariant: desired, satisfied_in_fixture: satisfied, observed });
}

async function fixture(run: (f: ReturnType<typeof setup>) => void | Promise<void>) {
  const f = setup();
  try {
    await run(f);
  } finally {
    f.db.close();
  }
}

function setup() {
  clock = Date.parse("2026-01-01T00:00:00Z");
  const path = join(directory, `fixture-${++fixtureNumber}.db`);
  const db = new MarinaDB(path);
  const engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
  engine.registerRoom(roomId("test/start"), makeTestRoom());
  const alice = new MockConnection("audit-alice");
  const bob = new MockConnection("audit-bob");
  for (const [connection, name] of [
    [alice, "Alice"],
    [bob, "Bob"],
  ] as const) {
    engine.addConnection(connection);
    engine.spawnEntity(connection.id, name);
    if (!connection.entity) throw new Error(`Fixture failed to spawn ${name}`);
    connection.clear();
  }
  const commands: string[] = [];
  function command(text: string, connection = alice) {
    commands.push(text);
    connection.clear();
    engine.processCommand(connection.entity!, text);
    clock += 1;
    return [...connection.messages];
  }
  // Only the transport is replaced. Perceptions are real, unmodified engine output.
  const backend = new PlatformMemoryBackend({
    command: async (text: string) => command(text),
  } as unknown as MarinaClient);
  const plainBackend = new PlatformMemoryBackend({
    command: async (text: string) =>
      command(text).map((p) => ({
        ...p,
        data: { ...p.data, text: stripAnsi(String(p.data?.text ?? "")) },
      })),
  } as unknown as MarinaClient);
  return { db, path, command, backend, plainBackend, commands, alice, bob };
}

try {
  await fixture(async ({ db, backend, plainBackend, commands }) => {
    const note = db.createNote("Alice", "continuity marker reliable landmark", undefined, {
      importance: 8,
    });
    const found = await backend.search("continuity marker");
    const plain = await plainBackend.search("continuity marker");
    const before = commands.length;
    const trusted = await backend.search("continuity marker", { trusted: true });
    record(
      "H01",
      "Automatic recall receives structured hits from real command output",
      !!found.results?.length,
      {
        db_hits: db.recallNotes("Alice", "continuity marker").length,
        raw_output_contains_note: found.text.includes("continuity marker reliable landmark"),
        adapter_hits: found.results?.length,
        ansi_stripped_adapter_hits: plain.results?.length,
        trusted_commands: commands.slice(before),
        trusted_response_includes_unverified: trusted.text.includes(db.getNote(note)!.content),
        rendered_text: stripAnsi(found.text),
      },
    );
    await backend.saveFocus({ description: "Finish continuity task", startedAt: clock });
    await backend.saveCheckpoint({ lastIntent: "Finish continuity task", timestamp: clock });
    const focus = await backend.getFocus();
    const checkpoint = await backend.getCheckpoint();
    record(
      "H02",
      "Saved focus and checkpoint round-trip through the resident adapter",
      !!focus && !!checkpoint,
      {
        raw_focus: focus,
        raw_checkpoint: checkpoint,
        plain_focus: await plainBackend.getFocus(),
        plain_checkpoint: await plainBackend.getCheckpoint(),
        persisted_focus: db.getCoreMemory("Alice", "focus")?.value,
      },
    );
  });

  await fixture(({ db, command }) => {
    let current = db.createNote("Alice", "atlas office is Berlin", undefined, { importance: 8 });
    const versions = [current];
    for (let i = 1; i <= 30; i++) {
      clock += day;
      command(`note correct ${current} atlas office is City${i}`);
      current = db.getNotesByEntity("Alice", 1)[0]!.id;
      versions.push(current);
    }
    const active = versions.filter((id) => db.getNote(id)?.verification_status !== "superseded");
    record(
      "H03",
      "Thirty corrections leave only the latest version eligible for ordinary recall",
      active.length === 1,
      {
        versions_written: versions.length,
        active_versions: active.length,
        db_recall_version_ids: db.recallNotes("Alice", "atlas office").map((n) => n.id),
        current_id: current,
      },
    );
  });

  await fixture(({ db, command, bob }) => {
    const privateId = db.createNote("Alice", "synthetic private launchphrase lantern", undefined, {
      importance: 8,
    });
    command(`note evolve ${privateId}`, bob);
    const copied = db.getNotesByEntity("Bob", 10);
    record(
      "H04",
      "A resident cannot evolve another resident's private note into its own memory",
      !copied.some((n) => n.content.includes("launchphrase lantern")),
      {
        bob_notes: copied.map((n) => ({ id: n.id, content: n.content })),
        command_response: stripAnsi(bob.lastText()),
      },
    );
  });

  await fixture(({ db, command }) => {
    db.createNote("Alice", "orchard deployment requires the copper key", undefined, {
      importance: 8,
    });
    db.createNote("Alice", "orchard deployment needs offline validation", undefined, {
      importance: 8,
    });
    const created: number[] = [];
    for (let i = 0; i < 50; i++) {
      clock += day;
      command("reflect");
      const latest = db.getNotesByEntity("Alice", 1)[0]!;
      if (latest.note_type === "episode" && !created.includes(latest.id)) created.push(latest.id);
    }
    const last = db.getNotesByEntity("Alice", 1)[0]!;
    const latestWindow = db.getNotesByEntity("Alice", 10);
    record(
      "H05",
      "Repeated reflection keeps grounded evidence and the reflection tier",
      last.tier === "reflection" && last.content.includes("copper key"),
      {
        invocations: 50,
        distinct_reflections: created.length,
        final_tier: last.tier,
        final_importance: last.importance,
        final_contains_original_key: last.content.includes("copper key"),
        latest_ten_episode_count: latestWindow.filter((n) => n.note_type === "episode").length,
        final_content: last.content,
        original_evidence_still_stored: db
          .recallNotes("Alice", "copper key")
          .some((n) => n.id === 1),
      },
    );
  });

  await fixture(async ({ db, command, backend }) => {
    const skill = await backend.storeSkill(
      "carefuldeploy",
      "A careful repeatable deployment procedure with extensive checks and context before execution",
      "run validation; deploy approved artifact; verify health",
    );
    if (!skill.noteId) throw new Error("Fixture skill store failed");
    const found = await backend.searchSkills("carefuldeploy");
    record(
      "H06",
      "Automatically retrieved skills include their procedure",
      !!found.results?.[0]?.content.includes("run validation"),
      {
        stored_actions_present: db.getNote(skill.noteId)!.content.includes("run validation"),
        retrieved: found.results,
      },
    );
    const verificationResponse = command(`skill verify ${skill.noteId}`);
    record(
      "H07",
      "A skill called verified carries a tested outcome or explicit attestation semantics",
      db.getNote(skill.noteId)!.verification_status === "verified",
      {
        response: stripAnsi(verificationResponse.map((p) => p.data.text ?? "").join("\n")),
        verification_status_after_verify: db.getNote(skill.noteId)!.verification_status,
        importance_after_verify: db.getNote(skill.noteId)!.importance,
        supports_self_link: db
          .getNoteLinks(skill.noteId)
          .some((l) => l.source_id === l.target_id && l.relationship === "supports"),
        note: "Source inspection: skill verify executes no procedure or outcome validator",
      },
    );
    for (let i = 0; i < 110; i++) db.createNote("Alice", `later journal entry ${i}`);
    const list = command("skill list")
      .map((p) => String(p.data.text ?? ""))
      .join("\n");
    record(
      "H08",
      "Stored skills remain discoverable by list after 110 ordinary note writes",
      list.includes("carefuldeploy"),
      {
        list_response: stripAnsi(list),
        indexed_search_still_finds_skill: (await backend.searchSkills("carefuldeploy")).results
          ?.length,
      },
    );
  });

  await fixture(({ db }) => {
    const untouched = db.createNote("Alice", "untouched operational fact", undefined, {
      importance: 8,
    });
    const once = db.createNote("Alice", "once consulted operational fact", undefined, {
      importance: 8,
    });
    db.touchNote(once);
    clock += 90 * day;
    const trajectory: number[] = [];
    for (let i = 0; i < 10; i++) {
      db.adjustNoteImportance();
      trajectory.push(db.getNote(untouched)!.importance);
    }
    const onceAfter = db.getNote(once)!;
    record(
      "H09",
      "Aging reflects elapsed time consistently and does not make one recall permanent protection",
      db.getNote(once)!.importance < 8,
      {
        simulated_days_elapsed: 90,
        maintenance_calls_at_same_time: 10,
        untouched_importance_trajectory: trajectory,
        once_recalled_importance: db.getNote(once)!.importance,
        once_recalled_count: "recall_count" in onceAfter ? onceAfter.recall_count : null,
      },
    );
    const noisy = db.createNote("Alice", "unsupported frequently retrieved claim", undefined, {
      importance: 3,
    });
    for (let i = 0; i < 7; i++) {
      for (let j = 0; j < 3; j++) db.touchNote(noisy);
      db.adjustNoteImportance();
    }
    record(
      "H10",
      "Importance and confidence remain distinguishable from repeated access",
      db.getNote(noisy)!.confidence === 0.5 &&
        db.getNote(noisy)!.verification_status === "unverified",
      {
        touches: 21,
        initial_importance: 3,
        final_importance: db.getNote(noisy)!.importance,
        confidence: db.getNote(noisy)!.confidence,
        verification_status: db.getNote(noisy)!.verification_status,
        interpretation: "Importance promotion is access-based, not proof of usefulness or truth",
      },
    );
  });

  await fixture(({ db }) => {
    db.createNote("Alice", "reactor is operational");
    db.createNote("Alice", "reactor is not operational");
    db.createNote("Alice", "headquarters is in Berlin");
    db.createNote("Alice", "headquarters is in Paris");
    const before = db.findMemoryContradictions("Alice");
    for (let i = 0; i < 501; i++) db.createNote("Alice", `unrelated observation ${i}`);
    const after = db.findMemoryContradictions("Alice");
    record(
      "H11",
      "Unresolved contradictions remain discoverable as the journal grows",
      after.length > 0,
      {
        detectable_polarity_pairs_before: before.length,
        changed_city_detected: before.some((p) => p.left.content.includes("headquarters")),
        pairs_after_501_unrelated_writes: after.length,
      },
    );
    const claim = db.createNote("Alice", "corroboration example", undefined, { confidence: 0.2 });
    for (const url of [
      "https://example.invalid/article?a=1",
      "https://example.invalid/article?a=2",
    ]) {
      db.addNoteSource(claim, {
        url,
        contentHash: "same-content",
        publisher: "same-publisher",
        credibility: 0,
      });
    }
    db.calibrateMemoryConfidence();
    record(
      "H12",
      "Confidence promotion distinguishes independent evidence from duplicated low-credibility sources",
      db.getNote(claim)!.confidence === 0.2,
      {
        initial_confidence: 0.2,
        final_confidence: db.getNote(claim)!.confidence,
        sources_same_hash_and_publisher: true,
        source_credibility: 0,
      },
    );
  });

  await fixture(({ db }) => {
    const keeper = db.createNote("Alice", "current retained fact");
    const retired = db.createNote("Alice", "retired exact assertion");
    db.consolidateNotes("Alice", keeper, [retired]);
    const rewritten = db.createNote("Alice", "retired exact assertion");
    record(
      "H13",
      "Writing a retired assertion reports its status or produces an active assertion",
      db.getNote(rewritten)!.verification_status !== "superseded",
      {
        returned_same_retired_id: rewritten === retired,
        returned_status: db.getNote(rewritten)!.verification_status,
        rewritten_visible_in_db_recall: db
          .recallNotes("Alice", "retired exact assertion")
          .some((n) => n.id === rewritten),
      },
    );
    db.setCoreMemory("Alice", "private", "synthetic obsolete value");
    db.setCoreMemory("Alice", "private", "synthetic replacement value");
    db.deleteCoreMemory("Alice", "private");
    record(
      "H14",
      "A complete forgetting operation removes content from retained history too",
      db.getCoreMemoryHistory("Alice", "private").length === 0,
      {
        current_value_deleted: !db.getCoreMemory("Alice", "private"),
        retained_history: db.getCoreMemoryHistory("Alice", "private"),
        interpretation:
          "Existing delete is current-entry deletion; no complete-forget contract is implemented here",
      },
    );
  });

  const user = (content: string): AgentMessage => ({ role: "user", content, timestamp: clock });
  const toolResult = (content: string): AgentMessage => ({
    role: "toolResult",
    toolCallId: "audit-call",
    toolName: "read",
    content: [{ type: "text", text: content }],
    isError: false,
    timestamp: clock,
  });
  const model = { contextWindow: 4096, maxTokens: 512 } as Model<string>;
  const toolCall = {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "audit-call",
        name: "read",
        arguments: { path: "synthetic-evidence.txt" },
      },
    ],
    api: "openai-completions",
    provider: "audit",
    model: "synthetic",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: clock,
  } as AgentMessage;
  const messages = [
    user("Original objective"),
    toolCall,
    toolResult("RARE_TOOL_EVIDENCE_973"),
    ...Array.from({ length: 18 }, (_, i) => user(`Turn ${i} ${"x".repeat(600)}`)),
  ];
  let archived = "";
  let archivedMessages = 0;
  const compact = createContextManager({
    getModel: () => model,
    getSystemPrompt: () => "",
    onBeforeCompact: (dropped, summary) => {
      archived = summary;
      archivedMessages += dropped.length;
    },
  });
  const compacted = await compact(messages);
  record(
    "H15",
    "Compaction preserves unique tool evidence in durable summary or retained context",
    JSON.stringify(compacted).includes("RARE_TOOL_EVIDENCE_973") ||
      archived.includes("RARE_TOOL_EVIDENCE_973"),
    {
      dropped_message_count: archivedMessages,
      summary_contains_tool_evidence: archived.includes("RARE_TOOL_EVIDENCE_973"),
      retained_contains_tool_evidence: JSON.stringify(compacted).includes("RARE_TOOL_EVIDENCE_973"),
      scope:
        "Real compactor archival summary; resident callback persists this summary, not the dropped tool transcript",
    },
  );
  let archiveCalls = 0;
  const overloaded = createContextManager({
    getModel: () => model,
    getSystemPrompt: () => "s".repeat(6000),
    onBeforeCompact: () => {
      archiveCalls++;
    },
  });
  const afterOverload = await overloaded(messages);
  record("H16", "Every compaction drop invokes the archival hook", archiveCalls > 0, {
    input_messages: messages.length,
    output_messages: afterOverload.length,
    archival_calls: archiveCalls,
  });
  const oversized = truncateOversizedToolResults([toolResult("x".repeat(12000))], 2000);
  record(
    "H17",
    "Tool-result truncation respects its own configured token estimator budget",
    estimateMessageTokens(oversized[0]!) <= 2000,
    {
      budget_tokens: 2000,
      estimated_tokens_after_truncation: estimateMessageTokens(oversized[0]!),
      note: "Uses Marina's estimator, not a model tokenizer",
    },
  );

  const reopenPath = join(directory, "reopen.db");
  let persistent = new MarinaDB(reopenPath);
  const durableId = persistent.createNote("Alice", "persistent original evidence", undefined, {
    importance: 9,
  });
  persistent.setCoreMemory("Alice", "goal", "finish persistent work");
  for (let i = 0; i < 520; i++) persistent.createNote("Alice", `[compaction] window ${i}`);
  persistent.close();
  persistent = new MarinaDB(reopenPath);
  try {
    const notes = persistent.getNotesByEntity("Alice", 1000);
    record(
      "H18",
      "SQLite reopen preserves evidence/core memory while bounding private process notes",
      !!persistent.getNote(durableId) &&
        !!persistent.getCoreMemory("Alice", "goal") &&
        notes.filter((n) => n.tier === "process").length === 500,
      {
        original_evidence_survives: !!persistent.getNote(durableId),
        core_value_survives: persistent.getCoreMemory("Alice", "goal")?.value,
        process_notes_retained: notes.filter((n) => n.tier === "process").length,
        default_recall_excludes_process: persistent.recallNotes("Alice", "window").length === 0,
        scope: "Clean DB close/reopen; not an abrupt process-kill durability test",
      },
    );
  } finally {
    persistent.close();
  }

  await fixture(async ({ db, backend }) => {
    db.createMemoryPool("guide", "guide", "Alice");
    db.addPoolNote("guide", "Alice", "inherited landmark guidance", 8);
    const imported = await backend.importShared("guide", "landmark");
    record(
      "H19",
      "Shared-pool recall reaches the resident's inherited-wisdom adapter",
      !!imported.results?.length,
      {
        rendered_text: stripAnsi(imported.text),
        adapter_hits: imported.results?.length,
        db_hits: db.recallPoolNotes("guide", "landmark").length,
      },
    );
  });

  await fixture(({ db, command }) => {
    const source = db.createNote("Alice", "deleteprobe original sensitive marker", undefined, {
      importance: 8,
    });
    db.createNote("Alice", "deleteprobe corroborating context", undefined, { importance: 8 });
    command("reflect deleteprobe");
    const derived = db.getNotesByEntity("Alice", 1)[0]!;
    db.deleteNote(source, "Alice");
    record(
      "H20",
      "Complete forgetting accounts for text copied into derived memories",
      !db.getNote(derived.id)?.content.includes("sensitive marker"),
      {
        source_deleted: !db.getNote(source),
        derived_content_retains_marker: !!db
          .getNote(derived.id)
          ?.content.includes("sensitive marker"),
        remaining_links_to_source: db
          .getNoteLinks(derived.id)
          .filter((l) => l.source_id === source || l.target_id === source).length,
        interpretation:
          "Ordinary delete is narrow; content dependency tracking is needed for a separate forget contract",
      },
    );
  });

  console.log(
    JSON.stringify(
      {
        purpose:
          "Source-connected functional observations, not a model-quality or elapsed-time benchmark",
        observed_at: new Date(realNow()).toISOString(),
        simulated_start: "2026-01-01T00:00:00Z",
        transport:
          "In-process Engine -> real Perceptions -> PlatformMemoryBackend; no WebSocket server",
        observations,
      },
      null,
      2,
    ),
  );
} finally {
  Date.now = realNow;
  rmSync(directory, { recursive: true });
}
