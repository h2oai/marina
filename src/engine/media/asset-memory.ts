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
 * silent orphan and never an erasure. Deletion through any path is queued by
 * the `assets_memory_deleted` trigger (migration 169) and retired on the next
 * pass; until then the read path already refuses to serve a record whose
 * asset is gone or unreadable (`assetReadableBy`).
 *
 * Incremental: each pass walks only assets changed since a durable watermark
 * (`(updated_at, id)` over `idx_assets_updated`, kept per mode in the
 * `core_memory` state of `media:memory`), so a world of unchanged assets costs
 * one indexed range read per pass. Any `updated_at` bump (a caption, tag or
 * `setAssetText` edit, or any other writer that bumps it) re-indexes the asset.
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
import { type AssetCursor, type AssetRow, assetTypeOf } from "../../persistence/db-assets";
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

/** Assets indexed per pass at most ({@link MEMORY_OPS_PER_PASS} usually binds first). */
export const ASSET_MEMORY_BATCH = 16;
/** Vision calls per pass (vision mode). */
export const VISION_CALLS_PER_PASS = 1;
/** Vision calls per rolling hour in this process (vision mode). */
export const VISION_CALLS_PER_HOUR = 60;
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
  /** Assets indexed per pass (default {@link ASSET_MEMORY_BATCH}). */
  limit?: number;
  /** Memory requests per pass before no new asset starts (default {@link MEMORY_OPS_PER_PASS}). */
  maxMemoryOps?: number;
  /** The vision call; without one, vision mode records `unavailable` (the server passes `engineAssetDescriber`). */
  describe?: (src: VisualSource) => Promise<VisualDescription>;
}

export interface AssetMemoryReport {
  /** Asset rows read from the change walk (unchanged assets are never re-read). */
  examined: number;
  /** Assets that ended `indexed` or `empty`. */
  indexed: number;
  /** Assets handed to the per-asset indexer (the per-asset work done). */
  indexedAssets: number;
  /** Records of deleted assets retired. */
  orphansRetired: number;
  /** The memory store asked the pass to back off; it resumes next pass. */
  busy?: boolean;
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

/** For tests. */
export function resetAssetMemoryForTests(): void {
  hourStart = 0;
  hourCalls = 0;
}

function isRasterImage(row: Pick<AssetRow, "mime_type">): boolean {
  return assetTypeOf(row.mime_type) === "image" && row.mime_type !== "image/svg+xml";
}

interface PassBudget {
  visionCalls: number;
  /** Memory requests made on owners' credentials this pass. */
  memoryOps: number;
}

/**
 * Memory requests one pass makes at most before it stops starting new assets.
 * The indexer spends the OWNER's memory request budget (100 burst, 25/s per
 * principal), so a pass leaves most of it to the owner's own work.
 */
export const MEMORY_OPS_PER_PASS = 40;

/** The memory store asked the pass to back off (429/503); the asset is retried next pass. */
export class AssetMemoryBusy extends Error {}

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
  budget: PassBudget = { visionCalls: 0, memoryOps: 0 },
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
  const run: Run = (request) => {
    budget.memoryOps++;
    return residentMemoryOperation(db, row!.entity_name, request);
  };
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
    // Nothing changed since the last index (a facts-only or tag-neutral update),
    // or a never-indexed asset with no text (no records can exist): no memory call.
    if ((prior?.hash === hash && prior.state === "indexed") || (!prior && chunks.length === 0)) {
      if (!prior)
        return stamp({
          state: "empty",
          records: 0,
          hash,
          ...visionFields(vision),
          ...(notes.length ? { note: notes.join("; ").slice(0, 300) } : {}),
        });
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
    // The owner's memory request budget (or a busy store): not a failure of
    // this asset — leave it unstamped and stop the pass; writes are keyed, so
    // the retry continues where this one stopped.
    const status = error instanceof MemoryClientError ? error.status : undefined;
    if (status === 429 || status === 503) throw new AssetMemoryBusy(getErrorMessage(error));
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

// ─── Deleted assets ────────────────────────────────────────────────────────

/**
 * Retire the records of deleted assets (all modes). Every delete path queues
 * the asset through the `assets_memory_deleted` trigger (migration 169) as a
 * `deleted:<id>` state entry naming its owner; this reads at most `limit` of
 * them (a primary-key range read, never a memory scan), retires the asset's
 * records in the owner's resident space (an indexed subject query) and clears
 * the entry. Returns records retired.
 */
export async function retireDeletedAssetMemory(
  db: MarinaDB,
  now = Date.now(),
  limit = DELETED_PER_PASS,
): Promise<number> {
  let retired = 0;
  for (const entry of db.listAssetMemoryState(DELETED_PREFIX, limit)) {
    const assetId = entry.key.slice(DELETED_PREFIX.length);
    // Re-created under the same id (an import): nothing to retire.
    if (db.getAsset(assetId)) {
      db.deleteAssetMemoryState(entry.key);
      continue;
    }
    try {
      if (canHoldMemory(db, entry.value))
        retired += await retireAssetRecords(
          (request) => residentMemoryOperation(db, entry.value, request),
          assetId,
          "asset deleted",
          now,
        );
      db.deleteAssetMemoryState(entry.key);
    } catch (error) {
      // Kept for the next pass.
      logger.warn("media", "Retiring a deleted asset's memory failed", {
        id: assetId,
        error: getErrorMessage(error),
      });
    }
  }
  return retired;
}

/** An owner the resident binding accepts (no account ⇒ it never had records). */
function canHoldMemory(db: MarinaDB, name: string): boolean {
  const user = db.getUserByName(name);
  const principal = db.getPrincipal("human", name);
  return !!user && !!principal && user.id === principal.principal_id;
}

// ─── The pass ──────────────────────────────────────────────────────────────

const DELETED_PREFIX = "deleted:";
const PENDING_PREFIX = "vision-pending:";
/** Deleted assets retired per pass. */
export const DELETED_PER_PASS = 20;
/** Rows read from the change walk per pass (only changed rows are ever read). */
export const WALK_PER_PASS = 200;
/**
 * The watermark never passes a row changed this recently: a row bumped to the
 * same millisecond as the watermark (with a smaller id) is still read next pass.
 */
export const WATERMARK_SETTLE_MS = 2_000;

function watermarkKey(mode: MediaMemoryMode): string {
  return `watermark:${mode}`;
}

function readWatermark(db: MarinaDB, mode: MediaMemoryMode): AssetCursor | undefined {
  const raw = db.getAssetMemoryState(watermarkKey(mode));
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as { updatedAt?: unknown; id?: unknown };
    return typeof v.updatedAt === "number" && typeof v.id === "string"
      ? { updatedAt: v.updatedAt, id: v.id }
      : undefined;
  } catch {
    return undefined;
  }
}

/** `vision-pending:<retry ms, 15 digits>:<asset>` — key order is due order. */
function pendingKey(retryAt: number, assetId: string): string {
  return `${PENDING_PREFIX}${String(Math.max(0, Math.floor(retryAt))).padStart(15, "0")}:${assetId}`;
}

/** Does this row need the indexer (or, in vision mode, its vision pass)? Row-local, no I/O. */
function needsIndexing(row: AssetRow, mode: MediaMemoryMode): boolean {
  if (row.derived_from || row.origin === "request") return false;
  const stamp = readMemoryStamp(row);
  if (!stamp || stamp.updated_at < row.updated_at) return true;
  return mode === "vision" && isRasterImage(row) && stamp.vision === undefined;
}

async function indexAndQueue(
  host: AssetMemoryHost,
  db: MarinaDB,
  assetId: string,
  opts: AssetMemoryOptions,
  budget: PassBudget,
  report: AssetMemoryReport,
): Promise<void> {
  report.indexedAssets++;
  const s = await indexAssetMemory(host, assetId, opts, budget);
  if (s?.state === "indexed" || s?.state === "empty") report.indexed++;
  if (s?.vision === "pending")
    db.setAssetMemoryState(pendingKey(s.retry_at ?? Date.now(), assetId), "1");
}

/**
 * One bounded, incremental pass (the `asset-backfill` tick job):
 *  1. retire the records of deleted assets queued by the delete trigger;
 *  2. in vision mode, retry images whose vision pass is due (`vision-pending:`);
 *  3. walk assets changed since this mode's durable watermark
 *     (`idx_assets_updated`), indexing at most `limit` of them; unchanged
 *     assets are never read again once the watermark has passed them.
 */
export async function runAssetMemoryPass(
  host: AssetMemoryHost,
  opts: AssetMemoryOptions = {},
): Promise<AssetMemoryReport> {
  const report: AssetMemoryReport = {
    examined: 0,
    indexed: 0,
    indexedAssets: 0,
    orphansRetired: 0,
    visionCalls: 0,
  };
  const db = host.db;
  if (!db) return report;
  const now = opts.now ?? Date.now();
  report.orphansRetired = await retireDeletedAssetMemory(db, now);
  const mode = mediaMemoryMode(opts.env ?? process.env);
  if (mode === "off") return report;
  const budget: PassBudget = { visionCalls: 0, memoryOps: 0 };
  const limit = opts.limit ?? ASSET_MEMORY_BATCH;

  const maxOps = opts.maxMemoryOps ?? MEMORY_OPS_PER_PASS;
  const room = () => report.indexedAssets < limit && budget.memoryOps < maxOps;

  let watermark = readWatermark(db, mode);
  const start = watermark;
  try {
    if (mode === "vision") {
      for (const entry of db.listAssetMemoryState(PENDING_PREFIX, limit)) {
        const due = Number(entry.key.slice(PENDING_PREFIX.length, PENDING_PREFIX.length + 15));
        if (due > now || !room()) break;
        const assetId = entry.key.slice(PENDING_PREFIX.length + 16);
        await indexAndQueue(host, db, assetId, opts, budget, report);
        // Cleared only once handled (a busy store leaves it for the next pass).
        db.deleteAssetMemoryState(entry.key);
      }
    }

    let cursor = watermark;
    let frozen = false;
    const settled = now - WATERMARK_SETTLE_MS;
    walk: for (;;) {
      const rows = db.listAssetsChangedSince(cursor, WALK_PER_PASS);
      for (const row of rows) {
        report.examined++;
        if (needsIndexing(row, mode)) {
          if (!room()) break walk; // the watermark stays before it
          await indexAndQueue(host, db, row.id, opts, budget, report);
        }
        cursor = { updatedAt: row.updated_at, id: row.id };
        // Advance only past settled rows; a fresh one (and every later one) is
        // read again next pass, where its stamp makes it a no-op.
        if (row.updated_at >= settled) frozen = true;
        if (!frozen) watermark = cursor;
      }
      if (rows.length < WALK_PER_PASS || report.examined >= WALK_PER_PASS) break;
    }
  } catch (error) {
    if (!(error instanceof AssetMemoryBusy)) throw error;
    report.busy = true;
  }
  if (watermark && (watermark.updatedAt !== start?.updatedAt || watermark.id !== start?.id))
    db.setAssetMemoryState(watermarkKey(mode), JSON.stringify(watermark));
  report.visionCalls = budget.visionCalls;
  return report;
}
