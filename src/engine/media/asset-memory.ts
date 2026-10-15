// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Memory over media: text that describes or is contained in an asset becomes
 * canonical memory records citing `asset:<id>`, so `recall … all`, the
 * continuation prompt and every other `buildUnifiedContext` surface find
 * images, PDFs, audio and video by what they say.
 *
 *   MARINA_MEDIA_MEMORY=off|text|vision   (default text)
 *     text    index the text an asset already has — caption, alt text, tags,
 *             generation prompt, PDF text (`pdftotext`), a transcript or OCR
 *             text stored on it — with no model call
 *     vision  also ask a vision model ONCE per raster image for a caption
 *             suggestion and the text in it (OCR), stored on the asset
 *             (`metadata.caption_suggestion` / `metadata.ocr`) and indexed
 *     off     index nothing (records of deleted assets are still retired)
 *
 * Where the records live: the asset OWNER's private resident space, written
 * through `residentMemoryOperation` (the canonical write path; same ACLs,
 * versions and receipts as `/v1/memory`). Never a shared pool. One record per
 * text part (`label`, `description`, `ocr`) and one per chunk of a long text
 * (`pdf:<n>`, `transcript:<n>`, ≤ 2 000 characters, cut at page/paragraph
 * boundaries so chunk numbers are stable): `type: observation`, `tier: fact`,
 * `subject: asset:<id>`, `metadata: { kind: "asset-text", asset_id, ref,
 * part, key, chunk, chunks, by, trust: "untrusted", text_sha256 }`.
 *
 * Lifecycle: an edit that changes a part REVISES its record (a new version;
 * the old one stays readable as history); a part that disappears, an asset
 * its owner can no longer read, and a deleted asset RETIRE their records (a
 * tombstone revision closing `valid_time`, as `note delete` does) — never a
 * silent orphan and never an erasure. Deletion through any path is caught by
 * the orphan sweep (every {@link ORPHAN_SWEEP_EVERY} passes); until then the
 * read path already refuses to serve a record whose asset is gone or
 * unreadable (`assetReadableBy`).
 *
 * Access: a record is served only while its reader may read the asset
 * (`asset-memory-access.ts`). Request-staged images and derivatives are never
 * indexed. Asset text is UNTRUSTED content — labelled so wherever it is served.
 *
 * Cost and scheduling: the pass runs off the request path in the
 * `asset-backfill` tick job, {@link ASSET_MEMORY_BATCH} assets at a time.
 * Vision calls go through `describeVisual` → the model proxy, which checks the
 * daily spend cap and records the spend once; this module also checks the
 * cap before calling, makes at most {@link VISION_CALLS_PER_PASS} call per pass
 * and {@link VISION_CALLS_PER_HOUR} per hour, and never calls twice for one
 * image (a caption edit re-indexes text, not pixels). External tools follow
 * `MARINA_ASSET_DERIVATIVES` (`off` starts none). A missing tool or model is a
 * recorded note on the asset (`metadata.memory_index`), never an error.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { residentMemoryOperation } from "../../memory/resident-service";
import type { MarinaDB } from "../../persistence/database";
import { type AssetRow, assetTypeOf } from "../../persistence/db-assets";
import { MemoryClientError } from "../../sdk/memory-client";
import type { MemoryOperationRequest } from "../../sdk/memory-operations";
import type { StorageProvider } from "../../storage/provider";
import type { EngineEvent } from "../../types";
import { getErrorMessage } from "../errors";
import { Logger } from "../logger";
import { dailyCapRefusal } from "../spend-ledger";
import { derivativeMode, MAX_DERIVE_BYTES, setAssetText, sha256Hex } from "./asset-library";
import {
  ASSET_MEMORY_KIND,
  assetMemorySubject,
  assetReadableBy,
  dbCanvasHost,
} from "./asset-memory-access";
import {
  type AssetTextPartKind,
  assetRef,
  assetTextParts,
  capAssetText,
  chunkAssetText,
  storedAssetText,
} from "./asset-text";
import {
  describeVisual,
  hasTool,
  runTool,
  type VisualDescription,
  type VisualSource,
  visionMaxBytes,
} from "./vision";

const logger = new Logger();

export { ASSET_MEMORY_KIND } from "./asset-memory-access";

// ─── Settings ───────────────────────────────────────────────────────────────

export type MediaMemoryMode = "off" | "text" | "vision";

/** `MARINA_MEDIA_MEMORY` (read per call; unknown values mean the default `text`). */
export function mediaMemoryMode(
  env: Record<string, string | undefined> = process.env,
): MediaMemoryMode {
  const raw = env.MARINA_MEDIA_MEMORY?.trim().toLowerCase();
  if (raw === "off" || raw === "false" || raw === "0" || raw === "none") return "off";
  if (raw === "vision") return "vision";
  return "text";
}

/** Assets indexed per pass. */
export const ASSET_MEMORY_BATCH = 4;
/** Vision calls per pass (vision mode). */
export const VISION_CALLS_PER_PASS = 1;
/** Vision calls per rolling hour in this process (vision mode). */
export const VISION_CALLS_PER_HOUR = 60;
/** Passes between sweeps for records whose asset was deleted. */
export const ORPHAN_SWEEP_EVERY = 4;
/** Orphaned assets retired per sweep. */
export const ORPHAN_SWEEP_LIMIT = 20;
/** Records made from one asset at most (later chunks are dropped and the stamp says so). */
export const MAX_RECORDS_PER_ASSET = 120;
/** PDF pages read by `pdftotext`. */
export const PDF_TEXT_MAX_PAGES = 500;
const PDF_TEXT_TIMEOUT_MS = 60_000;
/** Retry delay for a vision pass held by the spend cap. */
const SPEND_RETRY_MS = 60 * 60_000;

/** The one question a vision pass asks: a caption and the legible text. */
export const VISION_INDEX_QUESTION =
  "Reply in exactly two sections.\nCAPTION: one plain sentence describing the image, for a caption.\nTEXT: every legible piece of text in the image, verbatim, one item per line; write NONE when there is no legible text.";

/** Split a vision reply into a caption and OCR text (lenient: an unsectioned reply is the caption). */
export function parseVisionIndexReply(reply: string): { caption: string; ocr: string } {
  const text = reply.replace(/\r\n?/g, "\n").trim();
  // Tolerates markdown around the labels (`**CAPTION:**`, `## TEXT:`).
  const capM = /^[\s*_#]*CAPTION[\s*_]*:[\s*_]*/im.exec(text);
  const txtM = /^[\s*_#]*TEXT[\s*_]*:[\s*_]*/im.exec(text);
  if (!capM && !txtM) return { caption: text.split("\n")[0]!.trim(), ocr: "" };
  const capStart = capM ? capM.index + capM[0].length : -1;
  const txtStart = txtM ? txtM.index + txtM[0].length : -1;
  const caption =
    capM === null
      ? ""
      : text.slice(capStart, txtM && txtM.index > capM.index ? txtM.index : undefined).trim();
  let ocr =
    txtM === null
      ? ""
      : text.slice(txtStart, capM && capM.index > txtM.index ? capM.index : undefined).trim();
  if (/^none\.?$/i.test(ocr)) ocr = "";
  return { caption: caption.split("\n")[0]!.trim(), ocr };
}

// ─── Host ───────────────────────────────────────────────────────────────────

/** What the indexer needs (the Engine satisfies it). */
export interface AssetMemoryHost {
  readonly db?: MarinaDB;
  readonly storage?: StorageProvider;
  logEvent?(event: EngineEvent): void;
}

export interface AssetMemoryOptions {
  env?: Record<string, string | undefined>;
  now?: number;
  /** Assets examined (default {@link ASSET_MEMORY_BATCH}). */
  limit?: number;
  /** The vision call (default: `describeVisual` through the engine's model proxy). */
  describe?: (src: VisualSource) => Promise<VisualDescription>;
  /** Run the orphan sweep this pass regardless of the counter. */
  sweep?: boolean;
}

export interface AssetMemoryReport {
  examined: number;
  indexed: number;
  orphansRetired: number;
  visionCalls: number;
}

/** The bookkeeping stamp on `metadata.memory_index` (no text). */
export interface AssetMemoryStamp {
  /** The asset's `updated_at` this index reflects. */
  updated_at: number;
  at: number;
  mode: MediaMemoryMode;
  state: "indexed" | "empty" | "skipped" | "failed";
  records: number;
  note?: string;
  vision?: "done" | "failed" | "pending" | "unavailable";
  retry_at?: number;
  hash?: string;
}

export function readMemoryStamp(row: Pick<AssetRow, "metadata">): AssetMemoryStamp | undefined {
  try {
    const m = JSON.parse(row.metadata || "{}") as { memory_index?: unknown };
    return m.memory_index && typeof m.memory_index === "object"
      ? (m.memory_index as AssetMemoryStamp)
      : undefined;
  } catch {
    return undefined;
  }
}

// ─── Desired records ───────────────────────────────────────────────────────

export interface AssetMemoryChunk {
  /** Stable id within the asset: `label`, `description`, `ocr`, `pdf:<n>`, `transcript:<n>`. */
  key: string;
  part: AssetTextPartKind;
  chunk: number;
  chunks: number;
  content: string;
  hash: string;
  by: string;
}

const PART_LABELS: Record<AssetTextPartKind, string> = {
  label: "caption, alt text, tags",
  description: "model description (suggested caption)",
  ocr: "text read in the image",
  pdf: "PDF text",
  transcript: "transcript",
};

/** The records an asset's text should be, in a stable order. */
export function desiredAssetChunks(
  row: Pick<AssetRow, "id" | "filename" | "caption" | "alt" | "metadata" | "provenance">,
  tags: readonly string[],
  extra: { pdfText?: { text: string; by: string } } = {},
): { chunks: AssetMemoryChunk[]; dropped: number } {
  const out: AssetMemoryChunk[] = [];
  let dropped = 0;
  for (const part of assetTextParts(row, tags, extra)) {
    const pieces =
      part.kind === "label" || part.kind === "description" || part.kind === "ocr"
        ? [part.text.slice(0, 4_000)]
        : chunkAssetText(part.text);
    pieces.forEach((piece, i) => {
      if (out.length >= MAX_RECORDS_PER_ASSET) {
        dropped++;
        return;
      }
      const multi = pieces.length > 1 || part.kind === "pdf" || part.kind === "transcript";
      const heading = `From ${assetRef(row.id)} ("${row.filename}", ${PART_LABELS[part.kind]}${
        pieces.length > 1 ? `, part ${i + 1} of ${pieces.length}` : ""
      }):`;
      const content = `${heading}\n${piece}`;
      out.push({
        key: multi ? `${part.kind}:${i + 1}` : part.kind,
        part: part.kind,
        chunk: i + 1,
        chunks: pieces.length,
        content,
        hash: sha256Hex(new TextEncoder().encode(content)).slice(0, 32),
        by: part.by,
      });
    });
  }
  return { chunks: out, dropped };
}

// ─── Record sync ───────────────────────────────────────────────────────────

type Run = (request: MemoryOperationRequest) => Promise<{ result: unknown }>;

interface RecordLike {
  id: string;
  version: number;
  content: string;
  metadata: Record<string, unknown>;
  valid_time?: { from: number | null; until: number | null } | null;
}

function current(r: RecordLike, now: number): boolean {
  const until = r.valid_time?.until;
  return until === null || until === undefined || until > now;
}

/** The asset's current records in the run's space (default: the resident space). */
async function assetRecords(
  run: Run,
  assetId: string,
  now: number,
  spaceId?: string,
): Promise<RecordLike[]> {
  const out: RecordLike[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const reply = await run({
      operation: "query",
      ...(spaceId ? { space_id: spaceId } : {}),
      input: {
        subject: assetMemorySubject(assetId),
        valid_at: now,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      },
    });
    const r = (reply.result ?? {}) as { results?: RecordLike[]; next_cursor?: string | null };
    for (const rec of r.results ?? [])
      if (rec.metadata?.kind === ASSET_MEMORY_KIND && current(rec, now)) out.push(rec);
    if (!r.next_cursor) break;
    cursor = r.next_cursor;
  }
  return out;
}

async function retireRecord(
  run: Run,
  r: RecordLike,
  reason: string,
  now: number,
  spaceId?: string,
): Promise<void> {
  await run({
    operation: "revise",
    ...(spaceId ? { space_id: spaceId } : {}),
    id: r.id,
    // Deterministic: a retried retirement of the same version is one revision.
    key: `asset-memory-retire:${r.id}:${r.version}`,
    input: {
      expected_version: r.version,
      content: r.content,
      metadata: { ...r.metadata, retired_reason: reason, retired_at: new Date(now).toISOString() },
      valid_time: { from: r.valid_time?.from ?? null, until: now },
    },
  });
}

/** Retire every current record of `assetId` in the run's space. Returns how many. */
export async function retireAssetRecords(
  run: Run,
  assetId: string,
  reason: string,
  now = Date.now(),
  spaceId?: string,
): Promise<number> {
  const records = await assetRecords(run, assetId, now, spaceId);
  for (const r of records) await retireRecord(run, r, reason, now, spaceId);
  return records.length;
}

/** Make the asset's records match `desired`: remember new, revise changed, retire gone. */
export async function syncAssetRecords(
  run: Run,
  row: Pick<AssetRow, "id" | "filename" | "mime_type" | "origin">,
  desired: readonly AssetMemoryChunk[],
  now = Date.now(),
): Promise<{ written: number; revised: number; retired: number; unchanged: number }> {
  const stats = { written: 0, revised: 0, retired: 0, unchanged: 0 };
  const existing = await assetRecords(run, row.id, now);
  const byKey = new Map<string, RecordLike>();
  for (const r of existing) {
    const key = typeof r.metadata.key === "string" ? r.metadata.key : "";
    if (!key || byKey.has(key)) {
      await retireRecord(run, r, "duplicate", now);
      stats.retired++;
    } else byKey.set(key, r);
  }
  for (const d of desired) {
    const metadata = {
      kind: ASSET_MEMORY_KIND,
      asset_id: row.id,
      ref: assetRef(row.id),
      part: d.part,
      key: d.key,
      chunk: d.chunk,
      chunks: d.chunks,
      by: d.by,
      trust: "untrusted",
      text_sha256: d.hash,
      filename: row.filename,
      mime: row.mime_type,
      origin: row.origin,
    };
    const have = byKey.get(d.key);
    byKey.delete(d.key);
    if (have) {
      if (have.metadata.text_sha256 === d.hash && have.content === d.content) {
        stats.unchanged++;
        continue;
      }
      await run({
        operation: "revise",
        id: have.id,
        key: `asset-memory-revise:${have.id}:${have.version}:${d.hash.slice(0, 16)}`,
        input: { expected_version: have.version, content: d.content, metadata },
      });
      stats.revised++;
      continue;
    }
    await run({
      operation: "remember",
      key: `asset-memory:${row.id}:${d.key}:${d.hash.slice(0, 16)}`,
      input: {
        content: d.content,
        type: "observation",
        tier: "fact",
        subject: assetMemorySubject(row.id),
        metadata,
      },
    });
    stats.written++;
  }
  for (const r of byKey.values()) {
    await retireRecord(run, r, "text removed from the asset", now);
    stats.retired++;
  }
  return stats;
}

// ─── Extraction ────────────────────────────────────────────────────────────

/** PDF text through `pdftotext` (all pages up to {@link PDF_TEXT_MAX_PAGES}, size-capped). */
export async function extractPdfText(
  storage: StorageProvider | undefined,
  row: Pick<AssetRow, "storage_key" | "size">,
): Promise<{ text?: string; note?: string; truncated?: boolean }> {
  if (derivativeMode() === "off")
    return { note: "external tools off (MARINA_ASSET_DERIVATIVES=off)" };
  if (!hasTool("pdftotext")) return { note: "pdftotext not installed" };
  if (row.size > MAX_DERIVE_BYTES) return { note: `larger than ${MAX_DERIVE_BYTES} bytes` };
  const stored = await storage?.get(row.storage_key).catch(() => null);
  if (!stored) return { note: "stored bytes missing" };
  const dir = await mkdtemp(join(tmpdir(), "marina-asset-text-"));
  try {
    const file = join(dir, "doc.pdf");
    await writeFile(file, stored.data);
    const r = await runTool(
      ["pdftotext", "-enc", "UTF-8", "-l", String(PDF_TEXT_MAX_PAGES), file, "-"],
      { timeoutMs: PDF_TEXT_TIMEOUT_MS },
    );
    if (!r.ok) return { note: r.timedOut ? "pdftotext timed out" : "pdftotext failed" };
    const capped = capAssetText(r.stdout.trim());
    if (!capped.text) return { note: "no text in the PDF (scanned pages are not OCR'd)" };
    return { text: capped.text, ...(capped.truncated ? { truncated: true } : {}) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ─── Vision ────────────────────────────────────────────────────────────────

let hourStart = 0;
let hourCalls = 0;
let passes = 0;

/** For tests. */
export function resetAssetMemoryForTests(): void {
  hourStart = 0;
  hourCalls = 0;
  passes = 0;
}

function isRasterImage(row: Pick<AssetRow, "mime_type">): boolean {
  return assetTypeOf(row.mime_type) === "image" && row.mime_type !== "image/svg+xml";
}

interface PassBudget {
  visionCalls: number;
}

async function visionStep(
  host: AssetMemoryHost,
  row: AssetRow,
  prior: AssetMemoryStamp | undefined,
  budget: PassBudget,
  opts: AssetMemoryOptions,
  now: number,
): Promise<Pick<AssetMemoryStamp, "vision" | "retry_at" | "note">> {
  if (prior?.vision && prior.vision !== "pending") return { vision: prior.vision };
  if (storedAssetText(row, "caption_suggestion") || storedAssetText(row, "ocr"))
    return { vision: "done" };
  if (budget.visionCalls >= VISION_CALLS_PER_PASS) return { vision: "pending", retry_at: now };
  if (now - hourStart >= 60 * 60_000) {
    hourStart = now;
    hourCalls = 0;
  }
  if (hourCalls >= VISION_CALLS_PER_HOUR)
    return { vision: "pending", retry_at: hourStart + 60 * 60_000, note: "vision rate limit" };
  const capped = dailyCapRefusal(opts.env as NodeJS.ProcessEnv | undefined);
  if (capped) return { vision: "pending", retry_at: now + SPEND_RETRY_MS, note: "spend_cap" };
  if (row.size > visionMaxBytes(opts.env))
    return { vision: "unavailable", note: "image larger than MARINA_VISION_MAX_BYTES" };
  const stored = await host.storage?.get(row.storage_key).catch(() => null);
  if (!stored) return { vision: "unavailable", note: "stored bytes missing" };
  const describe = opts.describe;
  if (!describe) return { vision: "unavailable", note: "no vision model route" };
  budget.visionCalls++;
  hourCalls++;
  let desc: VisualDescription;
  try {
    desc = await describe({
      data: stored.data,
      mime: row.mime_type,
      label: row.filename,
      assetId: row.id,
    });
  } catch (error) {
    return { vision: "failed", note: getErrorMessage(error).slice(0, 200) };
  }
  if (!desc.ok) return { vision: "failed", note: desc.text.slice(0, 200) };
  const { caption, ocr } = parseVisionIndexReply(desc.text);
  const meta = { model: desc.model };
  if (caption) setAssetText(host, row.id, "caption_suggestion", caption, meta);
  if (ocr) setAssetText(host, row.id, "ocr", ocr, meta);
  return { vision: "done" };
}

/**
 * The vision call the server uses: `describeVisual` through the engine's model
 * proxy (`MARINA_VISION_MODEL`, else the default route), which checks the
 * daily spend cap and records the spend once.
 */
export function engineAssetDescriber(
  engine: Parameters<typeof describeVisual>[0],
): (src: VisualSource) => Promise<VisualDescription> {
  return (src) => describeVisual(engine, src, { question: VISION_INDEX_QUESTION });
}

// ─── One asset ─────────────────────────────────────────────────────────────

/**
 * Index one asset now (the pass calls this; tests call it directly). Stamps
 * `metadata.memory_index` with what was done. Never throws.
 */
export async function indexAssetMemory(
  host: AssetMemoryHost,
  assetId: string,
  opts: AssetMemoryOptions = {},
  budget: PassBudget = { visionCalls: 0 },
): Promise<AssetMemoryStamp | undefined> {
  const db = host.db;
  if (!db) return undefined;
  const env = opts.env ?? process.env;
  const mode = mediaMemoryMode(env);
  const now = opts.now ?? Date.now();
  let row = db.getAsset(assetId);
  if (!row || row.derived_from || row.origin === "request") return undefined;
  const prior = readMemoryStamp(row);
  const stamp = (s: Omit<AssetMemoryStamp, "at" | "mode" | "updated_at">, at = row!) => {
    const full: AssetMemoryStamp = { updated_at: at.updated_at, at: now, mode, ...s };
    db.setAssetMetadataKey(assetId, "memory_index", full);
    return full;
  };
  if (mode === "off") return undefined;
  const run: Run = (request) => residentMemoryOperation(db, row!.entity_name, request);
  try {
    // The owner reads its own asset's memory, so it must be able to read the asset.
    if (!assetReadableBy(db, { name: row.entity_name }, row, dbCanvasHost(db))) {
      const retired = await retireAssetRecords(run, row.id, "owner cannot read the asset", now);
      return stamp({
        state: "skipped",
        records: 0,
        note: `owner cannot read the asset${retired ? ` (${retired} retired)` : ""}`,
      });
    }
    const notes: string[] = [];
    let vision: Pick<AssetMemoryStamp, "vision" | "retry_at" | "note"> = {};
    if (mode === "vision" && isRasterImage(row)) {
      vision = await visionStep(host, row, prior, budget, { ...opts, env }, now);
      if (vision.note) notes.push(vision.note);
      row = db.getAsset(assetId) ?? row;
    } else if (prior?.vision) vision = { vision: prior.vision };
    let pdfText: { text: string; by: string } | undefined;
    if (assetTypeOf(row.mime_type) === "pdf" && !storedAssetText(row, "pdf_text")) {
      const extracted = await extractPdfText(host.storage, row);
      if (extracted.text) pdfText = { text: extracted.text, by: "pdftotext" };
      if (extracted.note) notes.push(extracted.note);
      if (extracted.truncated) notes.push("PDF text cut at the size cap");
    }
    const { chunks, dropped } = desiredAssetChunks(
      row,
      db.getAssetTags(row.id),
      pdfText ? { pdfText } : {},
    );
    if (dropped) notes.push(`${dropped} chunks over the per-asset cap not indexed`);
    const hash = sha256Hex(new TextEncoder().encode(chunks.map((c) => c.hash).join(","))).slice(
      0,
      32,
    );
    // Nothing changed since the last index (a facts-only or tag-neutral update): no memory call.
    if (prior?.hash === hash && prior.state === "indexed") {
      return stamp({
        state: "indexed",
        records: prior.records,
        hash,
        ...visionFields(vision),
        ...(notes.length ? { note: notes.join("; ").slice(0, 300) } : {}),
      });
    }
    await syncAssetRecords(run, row, chunks, now);
    return stamp({
      state: chunks.length ? "indexed" : "empty",
      records: chunks.length,
      hash,
      ...visionFields(vision),
      ...(notes.length ? { note: notes.join("; ").slice(0, 300) } : {}),
    });
  } catch (error) {
    const code = error instanceof MemoryClientError ? error.code : undefined;
    if (code === "world_identity_required")
      return stamp({ state: "skipped", records: 0, note: "owner has no world account" });
    logger.warn("media", "Asset memory indexing failed", {
      id: assetId,
      error: getErrorMessage(error),
    });
    return stamp({
      state: "failed",
      records: prior?.records ?? 0,
      note: getErrorMessage(error).slice(0, 300),
    });
  }
}

function visionFields(
  v: Pick<AssetMemoryStamp, "vision" | "retry_at">,
): Pick<AssetMemoryStamp, "vision" | "retry_at"> {
  return {
    ...(v.vision ? { vision: v.vision } : {}),
    ...(v.vision === "pending" && v.retry_at !== undefined ? { retry_at: v.retry_at } : {}),
  };
}

// ─── Orphans (deleted assets) ──────────────────────────────────────────────

/** Spaces holding current asset-text records whose asset no longer exists. */
export function findAssetMemoryOrphans(
  db: MarinaDB,
  now: number,
  limit = ORPHAN_SWEEP_LIMIT,
): { spaceId: string; ownerId: string; assetId: string }[] {
  try {
    const rows = db
      .memoryRepository()
      .raw.query(
        `SELECT r.space_id AS space_id, s.owner_id AS owner_id, substr(r.subject, 7) AS asset_id
           FROM memory_records r JOIN memory_spaces s ON s.id = r.space_id
          WHERE r.status = 'active' AND r.subject GLOB 'asset:*'
            AND (r.valid_until IS NULL OR r.valid_until > ?)
            AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.id = substr(r.subject, 7))
          GROUP BY r.space_id, r.subject
          LIMIT ?`,
      )
      .all(now, limit) as { space_id: string; owner_id: string; asset_id: string }[];
    return rows.map((r) => ({ spaceId: r.space_id, ownerId: r.owner_id, assetId: r.asset_id }));
  } catch (error) {
    logger.warn("media", "Asset memory orphan query failed", { error: getErrorMessage(error) });
    return [];
  }
}

/** Retire the records of deleted assets (all modes). Returns records retired. */
export async function sweepAssetMemoryOrphans(db: MarinaDB, now = Date.now()): Promise<number> {
  let retired = 0;
  for (const o of findAssetMemoryOrphans(db, now)) {
    const owner = db.getUser(o.ownerId)?.name;
    if (!owner) continue;
    try {
      retired += await retireAssetRecords(
        (request) => residentMemoryOperation(db, owner, request),
        o.assetId,
        "asset deleted",
        now,
        o.spaceId,
      );
    } catch (error) {
      logger.warn("media", "Retiring a deleted asset's memory failed", {
        id: o.assetId,
        error: getErrorMessage(error),
      });
    }
  }
  return retired;
}

// ─── The pass ──────────────────────────────────────────────────────────────

/**
 * One bounded indexing pass (the `asset-backfill` tick job): the orphan sweep
 * every {@link ORPHAN_SWEEP_EVERY} passes, then up to `limit` assets whose
 * text changed since they were indexed (or, in vision mode, whose image has
 * not been looked at yet).
 */
export async function runAssetMemoryPass(
  host: AssetMemoryHost,
  opts: AssetMemoryOptions = {},
): Promise<AssetMemoryReport> {
  const report: AssetMemoryReport = {
    examined: 0,
    indexed: 0,
    orphansRetired: 0,
    visionCalls: 0,
  };
  const db = host.db;
  if (!db) return report;
  const now = opts.now ?? Date.now();
  if (opts.sweep || passes++ % ORPHAN_SWEEP_EVERY === 0)
    report.orphansRetired = await sweepAssetMemoryOrphans(db, now);
  const mode = mediaMemoryMode(opts.env ?? process.env);
  if (mode === "off") return report;
  const budget: PassBudget = { visionCalls: 0 };
  const rows = db.listAssetsForMemoryIndex({
    limit: opts.limit ?? ASSET_MEMORY_BATCH,
    vision: mode === "vision",
    now,
  });
  for (const row of rows) {
    report.examined++;
    const s = await indexAssetMemory(host, row.id, opts, budget);
    if (s?.state === "indexed" || s?.state === "empty") report.indexed++;
  }
  report.visionCalls = budget.visionCalls;
  return report;
}
