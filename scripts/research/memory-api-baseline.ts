// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Research probe, not a conformance test: records observed memory API behavior.
 * Run: bun run scripts/research/memory-api-baseline.ts
 * Uses synthetic identities and a disposable DB; no network, models, or real keys.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleMemApi } from "../../src/net/mem-api";
import { MarinaDB } from "../../src/persistence/database";

// This process exits after the probe. Never use the caller's configured API keys.
process.env.MEM_API_KEYS = "research-alice-key:alice,research-bob-key:bob";
process.env.MARINA_OPEN_API = "false";

const researchDirectory = mkdtempSync(join(tmpdir(), "marina-memory-research-"));
const db = new MarinaDB(join(researchDirectory, "probe.db"));
const observations: Record<string, unknown> = {};

async function request(agent: "alice" | "bob", path: string, body?: unknown) {
  const url = new URL(`http://research.invalid/mem${path}`);
  const method = body === undefined ? "GET" : "POST";
  const response = await handleMemApi(
    url,
    method,
    new Request(url, {
      method,
      headers: {
        Authorization: `Bearer research-${agent}-key`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    db,
  );
  if (!response) throw new Error(`Unhandled research route: ${path}`);
  return { status: response.status, data: await response.json() };
}

try {
  const preference = db.createNote("alice", "I avoid all animal products", undefined, {
    noteType: "fact",
  });
  const literal = await request("alice", "/recall?q=animal%20products");
  const paraphrase = await request("alice", "/recall?q=vegan%20diet");
  observations.semantic_recall = {
    literal_found: literal.data.results.some((n: { id: number }) => n.id === preference),
    paraphrase_found: paraphrase.data.results.some((n: { id: number }) => n.id === preference),
  };

  const keeper = db.createNote("alice", "deployment runbook current", undefined, {
    noteType: "fact",
  });
  const older = db.createNote("alice", "deployment runbook obsolete", undefined, {
    noteType: "fact",
  });
  db.consolidateNotes("alice", keeper, [older]);
  const recall = await request("alice", "/recall?q=deployment%20runbook");
  observations.supersession = {
    db_recall_excludes_superseded: !db
      .recallNotes("alice", "deployment runbook")
      .some((n) => n.id === older),
    api_recall_returns_superseded: recall.data.results.some((n: { id: number }) => n.id === older),
  };

  const processNote = db.createNote("alice", "[compaction] scratchpad progress");
  db.createNoteLink(keeper, processNote, "related_to");
  const withProcess = await request("alice", "/recall?q=deployment%20runbook");
  observations.tier_filter = {
    api_expansion_returns_process: withProcess.data.results.some(
      (n: { id: number }) => n.id === processNote,
    ),
  };

  const zero = await request("alice", "/recall?q=deployment&wi=0&wr=0&wrel=1");
  observations.zero_weight_override = zero.data.weights;

  const alicePrivate = db.createNote("alice", "synthetic private record");
  const foreignRead = await request("bob", `/notes/${alicePrivate}`);
  const inlineLink = await request("bob", "/notes", {
    content: "synthetic cross namespace link",
    links: [{ target: alicePrivate, relationship: "related_to" }],
  });
  // A fixed server rejects the inline write. Use an independent owned source
  // so the explicit-link probe still tests authorization in either version.
  const explicitSource = db.createNote("bob", "synthetic explicit link source");
  const explicitLink = await request("bob", `/notes/${explicitSource}/link`, {
    target: alicePrivate,
    relationship: "supports",
  });
  observations.link_authorization = {
    foreign_note_read_status: foreignRead.status,
    explicit_foreign_link_status: explicitLink.status,
    inline_foreign_link_status: inlineLink.status,
    inline_foreign_link_created:
      inlineLink.data.id !== undefined &&
      db.getNoteLinks(inlineLink.data.id).some((l) => l.target_id === alicePrivate),
    rejected_inline_write_persisted:
      inlineLink.status >= 400 &&
      db.getNotesByEntity("bob").some((note) => note.content === "synthetic cross namespace link"),
  };

  db.createGroup({ id: "private-team", name: "private-team", leaderId: "alice" });
  db.createMemoryPool("restricted", "restricted", "alice", "private-team");
  db.addPoolNote("restricted", "alice", "synthetic restricted pool content");
  const poolRead = await request("bob", "/pools/restricted/notes");
  const poolWrite = await request("bob", "/pools/restricted/notes", {
    content: "synthetic outsider contribution",
  });
  observations.group_pool_authorization = {
    outsider_read_status: poolRead.status,
    outsider_reads_content: !!poolRead.data.notes?.some(
      (n: { content: string }) => n.content === "synthetic restricted pool content",
    ),
    outsider_write_status: poolWrite.status,
  };

  console.log(
    JSON.stringify(
      {
        purpose: "Synthetic behavioral observations; not a performance benchmark",
        observed_at: new Date().toISOString(),
        observations,
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
  rmSync(researchDirectory, { recursive: true });
}
