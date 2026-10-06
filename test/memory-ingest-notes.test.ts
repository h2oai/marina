// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordSpend, resetSpendLedgerForTests } from "../src/engine/spend-ledger";
import {
  chatNoteWriter,
  chunkParts,
  INGEST_NOTE_KIND,
  ingestNotesModel,
  ingestNotesWanted,
  ingestNoteWriter,
  mechanicalNotes,
  type NoteWriter,
  noteGrounded,
  noteKeyTokens,
  parseNoteLines,
  writeIngestNotes,
} from "../src/memory/ingest-notes";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { buildUnifiedContext } from "../src/memory/unified-context";
import { closeWorldMemoryService, worldMemoryService } from "../src/memory/world-service";
import { MarinaDB } from "../src/persistence/database";
import type { MemoryActor } from "../src/persistence/db-principals";

const DOC = [
  "# Order history",
  'Emma Lopez searched One Stop Market for "Canon photo printer" on 2024-03-05.',
  "Results listed Canon PIXMA MG2120 at $2.56 and Canon PIXMA iP4920 at $649.99.",
  "## Checkout",
  "1. Added Canon PIXMA iP4920 to the cart.",
  "2. Applied coupon SAVE10.",
  "3. Paid with the saved Visa card.",
  "outcome: success, order #000187 placed.",
].join("\n");

const REPLY = [
  "Here are the notes:",
  "- Emma Lopez searched One Stop Market for Canon photo printers on 2024-03-05.",
  "- Canon PIXMA iP4920 cost $649.99 and order #000187 was placed.",
  "- The order total was $812.40 on 2024-03-06.",
  "- Emma Lopez paid with a Mastercard card.",
  "- Emma Lopez searched One Stop Market for Canon photo printers on 2024-03-05.",
].join("\n");

function fakeWriter(reply = REPLY): NoteWriter & { calls: number } {
  const writer = {
    id: "model:test/notes",
    calls: 0,
    async write() {
      writer.calls++;
      return reply;
    },
  };
  return writer;
}

describe("ingest notes: pure guards", () => {
  it("grounding keeps notes whose names, numbers and dates are in the source", () => {
    expect(noteGrounded("Canon PIXMA iP4920 cost $649.99 at One Stop Market.", DOC)).toBe(true);
    expect(noteGrounded("The order total was $812.40.", DOC)).toBe(false); // invented number
    expect(noteGrounded("Emma Lopez paid with a Mastercard card.", DOC)).toBe(false); // invented name
    expect(noteGrounded("The order #000187 was placed on 2024-03-06.", DOC)).toBe(false); // date
    expect(noteGrounded("Unrelated sentence about weather patterns today.", DOC)).toBe(false);
    expect(noteKeyTokens("Canon PIXMA iP4920 cost $649.99 on 2024-03-05.")).toEqual(
      expect.arrayContaining(["PIXMA", "iP4920", "649.99", "2024-03-05"]),
    );
    // Short numbers must stand alone: 7 is not grounded by 17.
    expect(noteGrounded("The cart held 7 printers.", "the cart held 17 printers")).toBe(false);
  });

  it("parses bullet lines, skipping preambles and capping the count", () => {
    expect(parseNoteLines(REPLY)).toHaveLength(5);
    expect(parseNoteLines(REPLY, 2)).toHaveLength(2);
    expect(parseNoteLines("1) First numbered note line here\n2) Second one is here too")).toEqual([
      "First numbered note line here",
      "Second one is here too",
    ]);
  });

  it("the mechanical extractor keeps headed sections, final states and step runs verbatim", () => {
    const notes = mechanicalNotes(DOC);
    expect(notes[0]).toBe(
      'Order history: Emma Lopez searched One Stop Market for "Canon photo printer" on 2024-03-05.',
    );
    expect(notes).toContain(
      "1. Added Canon PIXMA iP4920 to the cart. 2. Applied coupon SAVE10. 3. Paid with the saved Visa card.",
    );
    expect(notes).toContain("outcome: success, order #000187 placed.");
    // The last line repeats the outcome: kept once.
    expect(notes.filter((n) => n.startsWith("outcome:"))).toHaveLength(1);
    for (const note of notes) expect(noteGrounded(note, DOC)).toBe(true);
  });

  it("chunks keep each chunk's sources (≤ 32) and label truncation", () => {
    const parts = Array.from({ length: 40 }, (_, i) => ({
      kind: "record" as const,
      id: `r${i}`,
      text: `line ${i}`,
    }));
    const { chunks, truncated } = chunkParts(parts, { chunkBytes: 100_000 });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.records).toHaveLength(32);
    expect(truncated).toBe(false);
    const big = chunkParts([{ kind: "record", id: "a", text: "x\n".repeat(5000) }], {
      chunkBytes: 1000,
      maxBytes: 3000,
    });
    expect(big.truncated).toBe(true);
    expect(big.chunks).toHaveLength(3);
    for (const chunk of big.chunks) expect(chunk.records).toEqual(["a"]);
  });

  it("switches: env off by default, per call wins, `none` model is mechanical", () => {
    expect(ingestNotesWanted(undefined, "x".repeat(5000), {})).toBe(false);
    expect(
      ingestNotesWanted(undefined, "x".repeat(5000), { MARINA_MEMORY_INGEST_NOTES: "on" }),
    ).toBe(true);
    expect(ingestNotesWanted(undefined, "short", { MARINA_MEMORY_INGEST_NOTES: "on" })).toBe(false);
    expect(ingestNotesWanted(true, "short", {})).toBe(true);
    expect(ingestNotesWanted(false, "x".repeat(5000), { MARINA_MEMORY_INGEST_NOTES: "on" })).toBe(
      false,
    );
    expect(ingestNotesModel({})).toBe("marina/default");
    expect(ingestNotesModel({ MARINA_MEMORY_INGEST_NOTES_MODEL: "none" })).toBeUndefined();
    expect(ingestNoteWriter({ MARINA_MEMORY_INGEST_NOTES_MODEL: "none" })).toBeNull();
    expect(ingestNoteWriter({})?.id).toBe("model:marina/default");
  });

  it("the chat writer posts one completion and reads its text", async () => {
    const seen: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
    const writer = chatNoteWriter({
      baseUrl: "http://marina.test/v1/",
      model: "m/cheap",
      apiKey: async () => "tok",
      fetch: async (url, init) => {
        seen.push({
          url,
          body: JSON.parse(String(init.body)),
          auth: new Headers(init.headers).get("authorization"),
        });
        return Response.json({ choices: [{ message: { content: "- a note line here" } }] });
      },
    });
    expect(await writer.write({ system: "s", user: "u" })).toBe("- a note line here");
    expect(seen[0]!.url).toBe("http://marina.test/v1/chat/completions");
    expect(seen[0]!.body.model).toBe("m/cheap");
    expect(seen[0]!.auth).toBe("Bearer tok");
  });
});

describe("ingest notes: canonical records", () => {
  let dir: string;
  let db: MarinaDB;
  let ana: MemoryActor;
  let space: string;

  const account = (name: string) => {
    const id = crypto.randomUUID();
    db.createUser({ id, name });
    const actor = db.verifyMemoryCredential(db.issueMemoryCredential(id).token);
    if (!actor) throw new Error("no actor");
    return actor;
  };
  const repo = () => worldMemoryService(db).repository;
  const source = (content = DOC, key = "src-1") =>
    repo().remember(ana, space, { content, type: "episode", subject: "orders" }, key).id;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "marina-ingest-notes-"));
    db = new MarinaDB(join(dir, "m.db"));
    ana = account("Ana");
    space = repo().createSpace(ana, "resident", `resident:${ana.principalId}`).id;
  });
  afterEach(async () => {
    await closeWorldMemoryService(db);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes grounded, labelled, linked notes and drops the rest", async () => {
    const src = source();
    const writer = fakeWriter();
    const report = await writeIngestNotes(repo(), ana, space, { records: [src], writer });
    expect(report).toMatchObject({
      outcome: "written",
      writer: "model:test/notes",
      chunks: 1,
      calls: 1,
      written: 2,
      ungrounded: 2,
      duplicates: 1,
    });
    const notes = repo().readCurrent(ana, space, report.ids);
    expect(notes).toHaveLength(2);
    for (const note of notes) {
      expect(note.depends_on).toEqual([src]);
      expect(note.metadata).toMatchObject({
        derived: INGEST_NOTE_KIND,
        derived_from: [src],
        writer: "model:test/notes",
      });
      expect(note.type).toBe("inference");
      expect(note.tier).toBe("reflection");
      expect(note.subject).toBe("orders");
    }
    // The source is untouched.
    expect(repo().read(ana, space, src).content).toBe(DOC);
    expect(repo().read(ana, space, src).version).toBe(1);
    // The same source at the same version is not noted (or paid for) twice.
    const again = await writeIngestNotes(repo(), ana, space, { records: [src], writer });
    expect(again).toMatchObject({ outcome: "skipped", reason: "already_noted", calls: 0 });
    expect(writer.calls).toBe(1);
  });

  it("falls back to the mechanical extractor without a model, and when the model fails", async () => {
    const src = source();
    const mechanical = await writeIngestNotes(repo(), ana, space, { records: [src], writer: null });
    expect(mechanical).toMatchObject({ outcome: "written", writer: "mechanical", calls: 0 });
    expect(mechanical.written).toBeGreaterThanOrEqual(3);
    const notes = repo().readCurrent(ana, space, mechanical.ids);
    expect(notes.every((n) => n.type === "observation" && n.tier === "fact")).toBe(true);

    const other = source(`${DOC}\nA second document line about SAVE10.`, "src-2");
    const failing: NoteWriter = {
      id: "model:down",
      write: async () => {
        throw new Error("upstream 503");
      },
    };
    const fallback = await writeIngestNotes(repo(), ana, space, {
      records: [other],
      writer: failing,
    });
    expect(fallback).toMatchObject({ fallback: "writer_failed", calls: 1 });
    // Mechanical lines already stored for the first source count as duplicates.
    expect(fallback.duplicates).toBeGreaterThan(0);
    expect(fallback.outcome).not.toBe("failed");
  });

  it("revising a source stales its notes; the new version is noted afresh", async () => {
    const src = source();
    const first = await writeIngestNotes(repo(), ana, space, {
      records: [src],
      writer: fakeWriter(),
    });
    repo().revise(ana, space, src, 1, { content: `${DOC}\nA later line.` }, "rev-1");
    const stale = repo().readCurrent(ana, space, first.ids);
    expect(stale.every((n) => n.freshness === "stale")).toBe(true);
    const second = await writeIngestNotes(repo(), ana, space, {
      records: [src],
      writer: fakeWriter(),
    });
    expect(second).toMatchObject({ outcome: "written", written: 2, duplicates: 1 });
  });

  it("forgetting a source erases its notes (records and captured sources)", async () => {
    const src = source();
    const report = await writeIngestNotes(repo(), ana, space, {
      records: [src],
      writer: fakeWriter(),
    });
    expect(report.written).toBe(2);
    repo().forget(ana, space, { record_ids: [src] }, "forget-1");
    expect(repo().readCurrent(ana, space, report.ids)).toHaveLength(0);

    const captured = repo().capture(ana, space, DOC, "session-1", "cap-1").id;
    const fromSource = await writeIngestNotes(repo(), ana, space, {
      sources: [captured],
      writer: fakeWriter(),
    });
    expect(fromSource.written).toBe(2);
    const notes = repo().readCurrent(ana, space, fromSource.ids);
    expect(notes.every((n) => n.source_ids.includes(captured))).toBe(true);
    repo().forget(ana, space, { source_ids: [captured] }, "forget-2");
    expect(repo().readCurrent(ana, space, fromSource.ids)).toHaveLength(0);
  });

  it("access follows the source space: strangers cannot note, grantees inherit the ACL", async () => {
    const src = source();
    const bob = account("Bob");
    const carol = account("Carol");
    const refused = await writeIngestNotes(repo(), bob, space, {
      records: [src],
      writer: fakeWriter(),
    });
    expect(refused).toMatchObject({ outcome: "failed", reason: "space_not_found", written: 0 });

    repo().grant(ana, space, carol.principalId, "reader", "grant-carol");
    const asReader = await writeIngestNotes(repo(), carol, space, {
      records: [src],
      writer: fakeWriter(),
    });
    expect(asReader.outcome).toBe("failed"); // a reader may read, not write

    const report = await writeIngestNotes(repo(), ana, space, {
      records: [src],
      writer: fakeWriter(),
    });
    // The notes live in the source's space: its reader sees them, a stranger does not.
    expect(repo().readCurrent(carol, space, report.ids)).toHaveLength(2);
    expect(() => repo().readCurrent(bob, space, report.ids)).toThrow();
  });

  it("shutdown aborts a note call in flight instead of waiting on it", async () => {
    const src = source();
    const service = worldMemoryService(db);
    let started = false;
    service.ingestNoteWriter = {
      id: "model:slow",
      write: (_prompt, signal) =>
        new Promise<string>((_resolve, reject) => {
          started = true;
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    };
    expect(service.scheduleIngestNotes(ana, space, { records: [src] })).toBe(true);
    expect(service.scheduleIngestNotes(ana, space, { records: [src] })).toBe(false); // in flight
    for (let i = 0; i < 50 && !started; i++) await Bun.sleep(5);
    expect(started).toBe(true);
    const idle = service.ingestNotesIdle();
    await closeWorldMemoryService(db);
    const [report] = await idle;
    expect(report).toMatchObject({ outcome: "failed", reason: "aborted", written: 0 });
    expect(service.scheduleIngestNotes(ana, space, { records: [src] })).toBe(false);
  });

  it("at the daily spend cap notes are skipped (labelled), never the source", async () => {
    const src = source();
    const env = { MARINA_DAILY_SPEND_CAP_USD: "0.01" };
    try {
      recordSpend("model_api", 1, Date.now(), env);
      const writer = fakeWriter();
      const report = await writeIngestNotes(repo(), ana, space, { records: [src], writer, env });
      expect(report).toMatchObject({ outcome: "skipped", reason: "spend_cap", calls: 0 });
      expect(writer.calls).toBe(0);
      expect(repo().read(ana, space, src).content).toBe(DOC);
    } finally {
      resetSpendLedgerForTests();
    }
  });

  it("the record write path schedules notes per call; serving labels and expands them", async () => {
    const service = worldMemoryService(db);
    service.ingestNoteWriter = fakeWriter();
    const plain = await residentMemoryOperation(db, "Ana", {
      operation: "remember",
      input: { content: DOC },
      key: "plain-1",
    });
    expect((plain.result as Record<string, unknown>).ingest_notes).toBeUndefined();
    await expect(
      residentMemoryOperation(db, "Ana", {
        operation: "remember",
        input: { content: DOC, ingest_notes: "yes" },
        key: "bad-1",
      }),
    ).rejects.toThrow(/ingest_notes/);

    const written = await residentMemoryOperation(db, "Ana", {
      operation: "remember",
      input: {
        content: `${DOC}\n${"Filler line about the shop layout and aisles.\n".repeat(40)}`,
        ingest_notes: true,
      },
      key: "noted-1",
    });
    const receipt = written.result as { id: string; ingest_notes?: string };
    expect(receipt.ingest_notes).toBe("scheduled");
    await service.ingestNotesIdle();
    const derived = repo()
      .candidates(ana, space)
      .filter((c) => c.record.metadata.derived === INGEST_NOTE_KIND);
    expect(derived).toHaveLength(2);
    expect(derived.every((c) => c.record.depends_on[0] === receipt.id)).toBe(true);

    const context = await buildUnifiedContext(
      db,
      "Ana",
      "How much did the Canon PIXMA iP4920 cost?",
      { scope: "evidence", perTier: { evidence: 1 }, budgetBytes: 4096, creditReflections: false },
    );
    const items = context.tiers.find((t) => t.tier === "evidence")!.items;
    const note = items.find((i) => Array.isArray(i.meta?.derived_from));
    expect(note).toBeDefined();
    expect(note!.provenance).toContain("derived note of record");
    expect(note!.content).toContain("source excerpt (record");
    expect(note!.content).toContain("649.99");
  });
});
