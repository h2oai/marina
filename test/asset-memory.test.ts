// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Memory over media (src/engine/media/asset-memory.ts, MARINA_MEDIA_MEMORY):
 * asset text → canonical records in the owner's resident space citing
 * `asset:<id>`; versioning on edit, retirement on removal/deletion, the asset
 * read rule on every read, `asset:` evidence refs, PDF text, the vision pass
 * (mocked) with spend recorded once, switch modes, and the same tiers on the
 * direct builder and the `recall … all` command.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASSET_EVIDENCE_PREFIX, resolveEvidence } from "../src/decisions/evidence";
import {
  editAsset,
  ingestAsset,
  removeAsset,
  setAssetText,
} from "../src/engine/media/asset-library";
import {
  ASSET_MEMORY_KIND,
  desiredAssetChunks,
  findAssetMemoryOrphans,
  indexAssetMemory,
  mediaMemoryMode,
  parseVisionIndexReply,
  readMemoryStamp,
  resetAssetMemoryForTests,
  runAssetMemoryPass,
} from "../src/engine/media/asset-memory";
import { chunkAssetText, parseAssetRefs } from "../src/engine/media/asset-text";
import type { VisualDescription, VisualSource } from "../src/engine/media/vision";
import { hasTool } from "../src/engine/media/vision";
import { recordSpend, resetSpendLedgerForTests, spentTodayUsd } from "../src/engine/spend-ledger";
import { residentMemoryOperation } from "../src/memory/resident-service";
import {
  ASSET_CONTENT_MARKER,
  buildUnifiedContext,
  renderUnifiedContext,
  type UnifiedContextResult,
} from "../src/memory/unified-context";
import { LocalStorageProvider } from "../src/storage/local-provider";
import type { EntityId, Perception } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { FIXTURE_QUERY, seedUnifiedFixture, tierIds } from "./fixtures/unified-memory-fixture";
import { MockConnection, stripAnsi } from "./helpers";

const TEXT = { MARINA_MEDIA_MEMORY: "text" };
const VISION = { MARINA_MEDIA_MEMORY: "vision" };

/** A tiny valid PDF with one text line per page (Helvetica, uncompressed). */
function pdf(pages: string[][]): Uint8Array {
  const objs: string[] = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((lines, i) => {
    const page = 4 + i * 2;
    const stream = `BT /F1 12 Tf 72 720 Td ${lines
      .map((l, j) => `${j ? "0 -16 Td " : ""}(${l.replace(/[()\\]/g, "")}) Tj`)
      .join(" ")} ET`;
    objs[page] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${page + 1} 0 R >>`;
    objs[page + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** A 1×1 PNG (enough for a raster image row; derivatives are off). */
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

describe("asset text helpers", () => {
  it("parses the switch, asset refs, stable chunks and the vision reply", () => {
    expect(mediaMemoryMode({})).toBe("text");
    expect(mediaMemoryMode({ MARINA_MEDIA_MEMORY: "OFF" })).toBe("off");
    expect(mediaMemoryMode({ MARINA_MEDIA_MEMORY: "vision" })).toBe("vision");
    expect(mediaMemoryMode({ MARINA_MEDIA_MEMORY: "bogus" })).toBe("text");
    const id = "6f1c2b9e-1111-4222-8333-944445555666";
    expect(parseAssetRefs(`see asset:${id}, asset:${id} and asset:short`)).toEqual([id]);
    expect(parseAssetRefs(`asset:${id}`, 0)).toEqual([]);

    const long = Array.from({ length: 300 }, (_, i) => `Sentence number ${i} here.`).join(" ");
    const a = chunkAssetText(long, 500);
    expect(a.length).toBeGreaterThan(5);
    expect(a.every((c) => c.length <= 500)).toBe(true);
    expect(chunkAssetText(long, 500)).toEqual(a);
    expect(a.join(" ").replace(/\s+/g, " ")).toBe(long);
    // A page break is preferred as the cut.
    expect(chunkAssetText(`${"a ".repeat(200)}\f${"b ".repeat(200)}`, 500)[0]).not.toContain("b");

    expect(parseVisionIndexReply("CAPTION: A red fox.\nTEXT: STOP\nNO ENTRY")).toEqual({
      caption: "A red fox.",
      ocr: "STOP\nNO ENTRY",
    });
    expect(parseVisionIndexReply("**CAPTION:** Fog.\n**TEXT:** NONE")).toEqual({
      caption: "Fog.",
      ocr: "",
    });
    expect(parseVisionIndexReply("Just a picture of a cat")).toEqual({
      caption: "Just a picture of a cat",
      ocr: "",
    });
  });

  it("desired records carry the asset ref, stable keys and per-part labels", () => {
    const row = {
      id: "asset-0001-abcd",
      filename: "light.png",
      caption: "A lighthouse at dawn",
      alt: null,
      metadata: JSON.stringify({ transcript: { text: "hello ".repeat(800), model: "w" } }),
      provenance: "{}",
    };
    const { chunks } = desiredAssetChunks(row, ["coast"]);
    expect(chunks[0]!.key).toBe("label");
    expect(chunks[0]!.content).toContain("From asset:asset-0001-abcd");
    expect(chunks[0]!.content).toContain("Tags: coast");
    const keys = chunks.map((c) => c.key);
    expect(keys.filter((k) => k.startsWith("transcript:")).length).toBeGreaterThan(1);
    expect(desiredAssetChunks(row, ["coast"]).chunks.map((c) => c.hash)).toEqual(
      chunks.map((c) => c.hash),
    );
  });
});

describe("memory over media", () => {
  let dir: string;
  let fixture: ReturnType<typeof createTestEngine>;
  let storage: LocalStorageProvider;
  type Who = { id: EntityId; name: string; conn: MockConnection };
  let owner: Who;
  let stranger: Who;
  let admin: Who;

  function enter(name: string, rank: number): Who {
    const conn = new MockConnection(`c-${name}`);
    fixture.engine.addConnection(conn);
    const login = fixture.engine.login(conn.id, name);
    if (!("entityId" in login)) throw new Error(login.error);
    fixture.engine.entities.get(login.entityId)!.properties.rank = rank;
    return { id: login.entityId, name, conn };
  }

  async function run(who: Who, raw: string): Promise<string> {
    const before = who.conn.messages.length;
    await fixture.engine.processCommand(who.id, raw);
    return stripAnsi(who.conn.allText().slice(before).join("\n"));
  }

  const upload = async (who: Who, filename: string, data: Uint8Array, mime: string) =>
    (
      await ingestAsset(fixture.engine, {
        owner: who.name,
        filename,
        mime,
        data,
        origin: "upload",
        actor: who.id,
      })
    ).asset;

  async function assetRecords(name: string, assetId: string, includeEnded = false) {
    const reply = await residentMemoryOperation(fixture.db, name, {
      operation: "query",
      input: {
        subject: `asset:${assetId}`,
        ...(includeEnded ? {} : { valid_at: Date.now() }),
        limit: 100,
      },
    });
    return (
      reply.result as {
        results: {
          id: string;
          version: number;
          content: string;
          metadata: Record<string, unknown>;
          valid_time?: { until: number | null } | null;
        }[];
      }
    ).results;
  }

  const evidenceIds = (r: UnifiedContextResult) =>
    r.tiers.find((t) => t.tier === "evidence")?.items ?? [];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "asset-memory-"));
    storage = new LocalStorageProvider(dir);
    await storage.init();
    fixture = createTestEngine({ assetStorage: storage });
    resetAssetMemoryForTests();
    resetSpendLedgerForTests();
    owner = enter("Owner", 1);
    stranger = enter("Stranger", 1);
    admin = enter("Admin", 9);
  });

  afterEach(async () => {
    await fixture.dispose();
    rmSync(dir, { recursive: true, force: true });
    resetSpendLedgerForTests();
  });

  it("text mode: caption and tags become an untrusted record in the owner's resident space, cited as asset:<id>", async () => {
    const asset = await upload(owner, "light.png", PNG, "image/png");
    editAsset(fixture.engine, asset, {
      caption: "Saltmarsh lighthouse at dawn",
      addTags: ["coast"],
    });
    const report = await runAssetMemoryPass(fixture.engine, { env: TEXT });
    expect(report.indexed).toBe(1);
    const stamp = readMemoryStamp(fixture.db.getAsset(asset.id)!)!;
    expect(stamp).toMatchObject({ state: "indexed", records: 1, mode: "text" });
    expect(stamp.vision).toBeUndefined();

    const records = await assetRecords("Owner", asset.id);
    expect(records).toHaveLength(1);
    expect(records[0]!.metadata).toMatchObject({
      kind: ASSET_MEMORY_KIND,
      asset_id: asset.id,
      ref: `asset:${asset.id}`,
      part: "label",
      trust: "untrusted",
    });

    const ctx = await buildUnifiedContext(fixture.db, "Owner", "saltmarsh lighthouse");
    const item = evidenceIds(ctx).find((i) => i.meta?.asset === asset.id);
    expect(item?.provenance.startsWith(`asset:${asset.id} label`)).toBe(true);
    expect(item?.meta?.trust).toBe("untrusted");
    const text = renderUnifiedContext(ctx);
    expect(text).toContain(`asset:${asset.id}`);
    expect(text).toContain(ASSET_CONTENT_MARKER);
    // Never `[trusted]`: asset text is not a verified fact.
    expect(ctx.tiers.find((t) => t.tier === "trusted")?.items ?? []).toHaveLength(0);

    // Every record lives in the owner's own resident space — no shared pool.
    const spaces = fixture.db
      .memoryRepository()
      .raw.query(
        `SELECT DISTINCT s.name AS name, s.owner_id AS owner FROM memory_records r
           JOIN memory_spaces s ON s.id = r.space_id WHERE r.subject = ?`,
      )
      .all(`asset:${asset.id}`) as { name: string; owner: string }[];
    expect(spaces).toEqual([{ name: "resident", owner: fixture.db.getUserByName("Owner")!.id }]);

    // A second pass with nothing changed makes no memory write.
    expect((await runAssetMemoryPass(fixture.engine, { env: TEXT })).examined).toBe(0);
  });

  it("an edit supersedes (new version, old readable as history); removed text and deletion retire", async () => {
    const asset = await upload(owner, "light.png", PNG, "image/png");
    editAsset(fixture.engine, asset, { caption: "Saltmarsh lighthouse at dawn" });
    await runAssetMemoryPass(fixture.engine, { env: TEXT });
    const [first] = await assetRecords("Owner", asset.id);

    editAsset(fixture.engine, fixture.db.getAsset(asset.id)!, {
      caption: "Saltmarsh lighthouse in winter fog",
    });
    expect((await runAssetMemoryPass(fixture.engine, { env: TEXT })).indexed).toBe(1);
    const [second] = await assetRecords("Owner", asset.id);
    expect(second!.id).toBe(first!.id);
    expect(second!.version).toBe(first!.version + 1);
    expect(second!.content).toContain("winter fog");
    const old = await residentMemoryOperation(fixture.db, "Owner", {
      operation: "get",
      id: first!.id,
      input: { version: first!.version },
    });
    expect((old.result as { content: string }).content).toContain("at dawn");
    const ctx = await buildUnifiedContext(fixture.db, "Owner", "saltmarsh lighthouse dawn fog");
    const served = evidenceIds(ctx).filter((i) => i.meta?.asset === asset.id);
    expect(served).toHaveLength(1);
    expect(served[0]!.content).toContain("winter fog");

    // Clearing the caption retires the record (closed validity, still readable).
    editAsset(fixture.engine, fixture.db.getAsset(asset.id)!, { caption: null });
    await runAssetMemoryPass(fixture.engine, { env: TEXT });
    expect(await assetRecords("Owner", asset.id)).toHaveLength(0);
    const ended = await assetRecords("Owner", asset.id, true);
    expect(ended[0]!.valid_time?.until).toBeGreaterThan(0);
    expect(ended[0]!.metadata.retired_reason).toBe("text removed from the asset");

    // Deletion: never served from the moment the row is gone, retired by the sweep.
    editAsset(fixture.engine, fixture.db.getAsset(asset.id)!, { caption: "Back again lighthouse" });
    await runAssetMemoryPass(fixture.engine, { env: TEXT });
    expect(await assetRecords("Owner", asset.id)).toHaveLength(1);
    await removeAsset(fixture.engine, fixture.db.getAsset(asset.id)!);
    const after = await buildUnifiedContext(fixture.db, "Owner", "back again lighthouse");
    expect(evidenceIds(after).some((i) => i.meta?.asset === asset.id)).toBe(false);
    expect(findAssetMemoryOrphans(fixture.db, Date.now()).map((o) => o.assetId)).toEqual([
      asset.id,
    ]);
    const swept = await runAssetMemoryPass(fixture.engine, {
      env: { MARINA_MEDIA_MEMORY: "off" },
      sweep: true,
    });
    expect(swept.orphansRetired).toBe(1);
    expect(await assetRecords("Owner", asset.id)).toHaveLength(0);
    expect(findAssetMemoryOrphans(fixture.db, Date.now())).toEqual([]);
  });

  it("ACL: a stranger never recalls it; a private canvas the owner cannot read is not indexed; evidence follows the asset read rule", async () => {
    const asset = await upload(owner, "plan.png", PNG, "image/png");
    editAsset(fixture.engine, asset, { caption: "Quartermaster vault floor plan" });
    await runAssetMemoryPass(fixture.engine, { env: TEXT });
    const mine = await buildUnifiedContext(fixture.db, "Owner", "quartermaster vault plan");
    expect(evidenceIds(mine).some((i) => i.meta?.asset === asset.id)).toBe(true);
    const theirs = await buildUnifiedContext(fixture.db, "Stranger", "quartermaster vault plan");
    expect(evidenceIds(theirs).some((i) => i.meta?.asset === asset.id)).toBe(false);

    // Public asset (on no private canvas): a stranger may cite it, framed as untrusted.
    const cited = resolveEvidence(
      fixture.db,
      { name: "Stranger", id: stranger.id },
      `per asset:${asset.id} the vault is north`,
    );
    expect(cited).toHaveLength(1);
    expect(cited[0]!.ref).toBe(`asset:${asset.id}`);
    expect(cited[0]!.text.startsWith(ASSET_EVIDENCE_PREFIX)).toBe(true);
    expect(cited[0]!.text).toContain("Quartermaster vault floor plan");

    // On the owner's private canvas: the stranger can no longer cite it.
    fixture.db.createCanvas({
      id: "own-priv",
      name: "mine",
      scope: "entity",
      scopeId: owner.id,
      creatorName: "Owner",
    });
    fixture.db.createNode({
      id: "n-own",
      canvasId: "own-priv",
      type: "image",
      assetId: asset.id,
      creatorName: "Owner",
    });
    expect(
      resolveEvidence(fixture.db, { name: "Stranger", id: stranger.id }, `asset:${asset.id}`),
    ).toEqual([]);
    expect(
      resolveEvidence(fixture.db, { name: "Owner", id: owner.id }, `asset:${asset.id}`),
    ).toHaveLength(1);

    // An upload shown only on SOMEONE ELSE's private canvas: the owner cannot read
    // it, so its memory is retired and the read path refuses it at once.
    const other = await upload(owner, "theirs.png", PNG, "image/png");
    editAsset(fixture.engine, other, { caption: "Harbourmaster ledger photo" });
    await runAssetMemoryPass(fixture.engine, { env: TEXT });
    expect(await assetRecords("Owner", other.id)).toHaveLength(1);
    fixture.db.createCanvas({
      id: "admin-priv",
      name: "adm",
      scope: "entity",
      scopeId: admin.id,
      creatorName: "Admin",
    });
    fixture.db.createNode({
      id: "n-adm",
      canvasId: "admin-priv",
      type: "image",
      assetId: other.id,
      creatorName: "Admin",
    });
    const refused = await buildUnifiedContext(fixture.db, "Owner", "harbourmaster ledger photo");
    expect(evidenceIds(refused).some((i) => i.meta?.asset === other.id)).toBe(false);
    editAsset(fixture.engine, fixture.db.getAsset(other.id)!, { addTags: ["moved"] });
    await runAssetMemoryPass(fixture.engine, { env: TEXT });
    expect(readMemoryStamp(fixture.db.getAsset(other.id)!)?.state).toBe("skipped");
    expect(await assetRecords("Owner", other.id)).toHaveLength(0);

    // `note source <id> asset:<id>` cites a readable asset only.
    const note = fixture.db.createNote("Stranger", "The vault is north", undefined, {});
    expect(await run(stranger, `note source ${note} asset:${other.id}`)).toContain("not found");
    const third = await upload(owner, "map.png", PNG, "image/png");
    expect(await run(stranger, `note source ${note} asset:${third.id}`)).toContain(
      "Source attached",
    );
  });

  it("request-staged images and derivatives are never indexed; off indexes nothing", async () => {
    const req = await ingestAsset(fixture.engine, {
      owner: "Owner",
      filename: "req.png",
      mime: "image/png",
      data: PNG,
      origin: "request",
      metadata: { origin: "request", owner: owner.id },
    });
    fixture.db.updateAssetText(req.asset.id, { caption: "Secret request diagram" });
    const plain = await upload(owner, "x.png", PNG, "image/png");
    editAsset(fixture.engine, plain, { caption: "Visible caption words" });
    expect(
      (await runAssetMemoryPass(fixture.engine, { env: { MARINA_MEDIA_MEMORY: "off" } })).examined,
    ).toBe(0);
    expect(readMemoryStamp(fixture.db.getAsset(plain.id)!)).toBeUndefined();
    await runAssetMemoryPass(fixture.engine, { env: TEXT, limit: 10 });
    expect(readMemoryStamp(fixture.db.getAsset(req.asset.id)!)).toBeUndefined();
    expect(await assetRecords("Owner", req.asset.id)).toHaveLength(0);
    expect(await assetRecords("Owner", plain.id)).toHaveLength(1);
  });

  it("transcripts written through setAssetText are chunked into stable records (the audio contract)", async () => {
    const audio = await upload(owner, "call.mp3", new Uint8Array([1, 2, 3]), "audio/mpeg");
    const text = Array.from(
      { length: 120 },
      (_, i) => `Speaker ${i % 2 ? "B" : "A"} said the zebra budget item ${i} is approved.`,
    ).join(" ");
    const updated = setAssetText(fixture.engine, audio.id, "transcript", text, {
      model: "whisper-x",
      language: "en",
    });
    expect(updated).toBeDefined();
    const stored = JSON.parse(updated!.metadata).transcript;
    expect(stored).toMatchObject({ model: "whisper-x", language: "en" });
    expect(typeof stored.createdAt).toBe("number");
    expect(updated!.caption).toBeNull();

    await runAssetMemoryPass(fixture.engine, { env: TEXT });
    const records = await assetRecords("Owner", audio.id);
    expect(records.length).toBeGreaterThan(2);
    expect(records.every((r) => String(r.metadata.key).startsWith("transcript:"))).toBe(true);
    const ctx = await buildUnifiedContext(fixture.db, "Owner", "zebra budget approved");
    expect(evidenceIds(ctx).some((i) => i.meta?.asset === audio.id)).toBe(true);

    // The same transcript again: same chunks, no new versions.
    const versions = records.map((r) => r.version).sort();
    setAssetText(fixture.db, audio.id, "transcript", text, { model: "whisper-x" });
    await runAssetMemoryPass(fixture.engine, { env: TEXT });
    expect((await assetRecords("Owner", audio.id)).map((r) => r.version).sort()).toEqual(versions);
    // Clearing it retires every chunk.
    setAssetText(fixture.db, audio.id, "transcript", null);
    await runAssetMemoryPass(fixture.engine, { env: TEXT });
    expect(await assetRecords("Owner", audio.id)).toHaveLength(0);
  });

  it.skipIf(!hasTool("pdftotext"))(
    "PDF text from every page (pdftotext) is chunked and recalled; tools off is a recorded note",
    async () => {
      const prior = process.env.MARINA_ASSET_DERIVATIVES;
      const doc = await upload(
        owner,
        "report.pdf",
        pdf([["Quarterly report"], ["The obsidian turbine failed twice in March"]]),
        "application/pdf",
      );
      try {
        process.env.MARINA_ASSET_DERIVATIVES = "off";
        await indexAssetMemory(fixture.engine, doc.id, { env: TEXT });
        expect(readMemoryStamp(fixture.db.getAsset(doc.id)!)?.note).toContain(
          "MARINA_ASSET_DERIVATIVES=off",
        );
        process.env.MARINA_ASSET_DERIVATIVES = "sync";
        editAsset(fixture.engine, fixture.db.getAsset(doc.id)!, { addTags: ["ops"] });
        await runAssetMemoryPass(fixture.engine, { env: TEXT });
      } finally {
        if (prior === undefined) delete process.env.MARINA_ASSET_DERIVATIVES;
        else process.env.MARINA_ASSET_DERIVATIVES = prior;
      }
      const records = await assetRecords("Owner", doc.id);
      const pdfRecord = records.find((r) => r.metadata.part === "pdf");
      expect(pdfRecord?.content).toContain("obsidian turbine");
      expect(pdfRecord?.metadata.by).toBe("pdftotext");
      const ctx = await buildUnifiedContext(fixture.db, "Owner", "obsidian turbine failed");
      const hit = evidenceIds(ctx).find((i) => i.meta?.asset === doc.id);
      expect(hit?.provenance).toContain(`asset:${doc.id} pdf`);
      // `asset search` reports the memory hit beyond the filename/caption index.
      const out = await run(owner, "asset search obsidian turbine");
      expect(out).toContain("Text inside your files");
      expect(out).toContain("report.pdf");
    },
  );

  it("vision mode: one model call per image, suggestions stored separately, never over a person's caption; spend recorded once; cap respected", async () => {
    const calls: VisualSource[] = [];
    const describe = async (src: VisualSource): Promise<VisualDescription> => {
      calls.push(src);
      // Stands in for the model proxy, which records the spend of a real call.
      recordSpend("model_api", 0.01);
      return {
        ok: true,
        text: "CAPTION: A red lighthouse on a granite cliff.\nTEXT: KEEP OUT\nPrivate Pier",
        model: "test/vision",
        kind: "image",
        notes: [],
      };
    };
    const env = { ...VISION, MARINA_DAILY_SPEND_CAP_USD: "5" };
    const a = await upload(owner, "a.png", PNG, "image/png");
    const b = await upload(owner, "b.png", PNG, "image/png");
    editAsset(fixture.engine, b, { caption: "My own words for b" });

    // One call per pass (VISION_CALLS_PER_PASS); the other image waits.
    const p1 = await runAssetMemoryPass(fixture.engine, { env, describe });
    expect(p1.visionCalls).toBe(1);
    await runAssetMemoryPass(fixture.engine, { env, describe });
    expect(calls).toHaveLength(2);
    expect(spentTodayUsd()).toBeCloseTo(0.02, 10);

    const rowA = fixture.db.getAsset(a.id)!;
    expect(rowA.caption).toBeNull();
    expect(JSON.parse(rowA.metadata).caption_suggestion).toMatchObject({
      text: "A red lighthouse on a granite cliff.",
      model: "test/vision",
    });
    expect(JSON.parse(rowA.metadata).ocr.text).toBe("KEEP OUT\nPrivate Pier");
    expect(fixture.db.getAsset(b.id)!.caption).toBe("My own words for b");
    expect(readMemoryStamp(rowA)?.vision).toBe("done");
    const parts = (await assetRecords("Owner", a.id)).map((r) => r.metadata.part).sort();
    expect(parts).toEqual(["description", "ocr"]);
    const ctx = await buildUnifiedContext(fixture.db, "Owner", "granite cliff lighthouse");
    expect(evidenceIds(ctx).some((i) => i.meta?.asset === a.id)).toBe(true);

    // A caption edit re-indexes the text but never looks at the pixels again.
    editAsset(fixture.engine, fixture.db.getAsset(a.id)!, { addTags: ["cliff"] });
    await runAssetMemoryPass(fixture.engine, { env, describe });
    await runAssetMemoryPass(fixture.engine, { env, describe });
    expect(calls).toHaveLength(2);
    expect(spentTodayUsd()).toBeCloseTo(0.02, 10);

    // `asset caption <id> accept` takes the suggestion.
    expect(await run(owner, `asset caption ${a.id} accept`)).toContain(
      "A red lighthouse on a granite cliff.",
    );
    expect(fixture.db.getAsset(a.id)!.caption).toBe("A red lighthouse on a granite cliff.");
    expect(await run(owner, `asset show ${a.id}`)).toContain("Memory:");

    // At the daily cap: no call; the image waits (pending, retried later).
    const c = await upload(owner, "c.png", PNG, "image/png");
    await runAssetMemoryPass(fixture.engine, {
      env: { ...VISION, MARINA_DAILY_SPEND_CAP_USD: "0.01" },
      describe,
      limit: 10,
    });
    expect(calls).toHaveLength(2);
    const stampC = readMemoryStamp(fixture.db.getAsset(c.id)!)!;
    expect(stampC.vision).toBe("pending");
    expect(stampC.note).toContain("spend_cap");
    expect(stampC.retry_at).toBeGreaterThan(Date.now());

    // Text mode never calls the model.
    const d = await upload(owner, "d.png", PNG, "image/png");
    await runAssetMemoryPass(fixture.engine, { env: TEXT, describe, limit: 10 });
    expect(calls).toHaveLength(2);
    expect(readMemoryStamp(fixture.db.getAsset(d.id)!)?.vision).toBeUndefined();
  });

  it("same fixture ⇒ same tiers on the direct builder and `recall <q> all`, with the asset record in [evidence]", async () => {
    const fx = await seedUnifiedFixture(fixture.engine, fixture.db);
    const asset = await ingestAsset(fixture.engine, {
      owner: fx.owner,
      filename: "amber.png",
      mime: "image/png",
      data: PNG,
      origin: "upload",
    });
    editAsset(fixture.engine, asset.asset, {
      caption: "Amber deployment port diagram for the production cluster",
    });
    await runAssetMemoryPass(fixture.engine, { env: TEXT });
    const direct = await buildUnifiedContext(fixture.db, fx.owner, FIXTURE_QUERY, {
      budgetBytes: 4096,
    });
    const assetItem = evidenceIds(direct).find((i) => i.meta?.asset === asset.asset.id);
    expect(assetItem).toBeDefined();

    fx.ownerConn.clear();
    await fixture.engine.processCommand(fx.ownerEntityId, `recall ${FIXTURE_QUERY} all`);
    const payload = fx.ownerConn.messages
      .map((p: Perception) => p.data?.memory as Record<string, unknown> | undefined)
      .findLast(Boolean);
    const context = payload?.context as UnifiedContextResult;
    const sorted = (m: Record<string, string[]>) =>
      Object.fromEntries(
        Object.entries(m)
          .sort(([x], [y]) => x.localeCompare(y))
          .map(([t, ids]) => [t, [...ids].sort()]),
      );
    expect(sorted(tierIds(context))).toEqual(sorted(tierIds(direct)));
    expect(stripAnsi(fx.ownerConn.allTextJoined())).toContain(`asset:${asset.asset.id}`);
  });
});
