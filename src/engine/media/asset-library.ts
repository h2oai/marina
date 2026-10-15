// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The asset record v2 (migration 168): one write path for stored assets, their
 * cheap facts, derivatives, reader text, tags and deletion.
 *
 *  - `ingestAsset` stores bytes and the row with sha256 + image dimensions
 *    computed synchronously (both cheap), optionally returning the owner's
 *    existing asset of the same content instead (upload dedupe), emits
 *    `asset_created` and schedules derivatives.
 *  - Derivatives (`generateDerivatives`) run OFF the request path, one at a
 *    time per process: WebP thumbnails (256, 1024) and a 16 px placeholder for
 *    raster images through the optional `sharp` (image-ops.ts), a video poster
 *    through `ffmpeg`, a PDF first-page preview through `pdftoppm`, duration
 *    and page counts through `ffprobe` / `pdfinfo`. Each is an asset with
 *    origin `derived`, `derived_from` = the parent, linked by kind; it inherits
 *    the parent's read check (canvas-access.ts) and is deleted with it. A
 *    missing tool means no derivative and a recorded note, never an error.
 *  - `backfillAssets` (tick job `asset-backfill`) fills facts and derivatives
 *    for rows written before migration 168 or by a writer that skipped them,
 *    a bounded batch per pass — boot never waits for it.
 *
 * Events carry ids, owner and MIME only — never captions, prompts or bytes;
 * the dashboard rereads under the viewer's own credential.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MarinaDB } from "../../persistence/database";
import {
  type AssetOrigin,
  type AssetProvenance,
  type AssetRow,
  assetTypeOf,
} from "../../persistence/db-assets";
import type { StorageProvider } from "../../storage/provider";
import type { EngineEvent, EntityId } from "../../types";
import { getErrorMessage } from "../errors";
import { Logger } from "../logger";
import { imageProcessingAvailable, probeImage, thumbnail, toDataUrl } from "./image-ops";
import { hasTool, runTool } from "./vision";

const logger = new Logger();

/** What the library needs from the engine (the Engine satisfies it). */
export interface AssetLibraryHost {
  readonly db?: MarinaDB;
  readonly storage?: StorageProvider;
  logEvent?(event: EngineEvent): void;
  trackBackground?<T>(work: Promise<T>): Promise<T>;
}

/** Thumbnail sizes (long side, px) and the link kind each is stored under. */
export const THUMBNAIL_SIZES = [
  { size: 256, kind: "thumbnail-256" },
  { size: 1024, kind: "thumbnail-1024" },
] as const;
/** Link kinds of generated derivatives. */
export const DERIVATIVE_KINDS = ["thumbnail-256", "thumbnail-1024", "poster", "preview"] as const;
/** Long side of the inline placeholder (`assets.placeholder`). */
export const PLACEHOLDER_SIZE = 16;
/** Larger sources are not decoded for derivatives (recorded as `skipped`). */
export const MAX_DERIVE_BYTES = 100 * 1024 * 1024;
/** Derivative jobs that may wait in this process; past it the backfill job picks them up. */
export const DERIVATIVE_QUEUE_MAX = 64;
/** Assets examined per backfill pass. */
export const BACKFILL_BATCH = 8;

export const MAX_TAG_LENGTH = 40;
export const MAX_TAGS_PER_ASSET = 32;
export const MAX_CAPTION_CHARS = 2000;
export const MAX_ALT_CHARS = 1000;

// ─── Small helpers ───────────────────────────────────────────────────────────

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * A tag as stored: lower-case, no leading `#`, letters/digits and `-_.:`
 * only (other characters become `-`), at most {@link MAX_TAG_LENGTH}.
 * Undefined when nothing usable remains.
 */
export function normalizeTag(raw: string): string | undefined {
  const tag = raw
    .trim()
    .replace(/^#+/, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_.:-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_TAG_LENGTH);
  return tag || undefined;
}

/** `+a -b c` → add [a, c], remove [b] (normalized, deduplicated). */
export function parseTagEdits(tokens: readonly string[]): { add: string[]; remove: string[] } {
  const add = new Set<string>();
  const remove = new Set<string>();
  for (const token of tokens) {
    for (const part of token.split(",")) {
      const removing = part.startsWith("-");
      const tag = normalizeTag(removing || part.startsWith("+") ? part.slice(1) : part);
      if (!tag) continue;
      if (removing) {
        remove.add(tag);
        add.delete(tag);
      } else {
        add.add(tag);
        remove.delete(tag);
      }
    }
  }
  return { add: [...add], remove: [...remove] };
}

export function parseProvenance(row: Pick<AssetRow, "provenance">): AssetProvenance {
  try {
    const parsed = JSON.parse(row.provenance || "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as AssetProvenance) : {};
  } catch {
    return {};
  }
}

function emit(
  host: AssetLibraryHost,
  type: "asset_created" | "asset_updated" | "asset_deleted",
  row: Pick<AssetRow, "id" | "entity_name" | "mime_type">,
  actor?: EntityId,
): void {
  host.logEvent?.({
    type,
    ...(actor ? { entity: actor } : {}),
    assetId: row.id,
    owner: row.entity_name,
    mime: row.mime_type,
    timestamp: Date.now(),
  });
}

function extOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return "";
  const ext = filename.slice(dot);
  return /^\.[A-Za-z0-9]{1,10}$/.test(ext) ? ext : "";
}

// ─── Ingest ──────────────────────────────────────────────────────────────────

export interface IngestAssetInput {
  owner: string;
  filename: string;
  /** The STORED type, already normalized by the caller's MIME policy. */
  mime: string;
  data: Uint8Array;
  origin: AssetOrigin;
  provenance?: AssetProvenance;
  metadata?: Record<string, unknown>;
  /** Who wrote it (event attribution). */
  actor?: EntityId;
  /** Return the owner's existing asset of the same origin and content instead of storing again. */
  dedupe?: boolean;
  id?: string;
  /** Storage-key extension; defaults to the filename's. */
  ext?: string;
}

export interface IngestResult {
  asset: AssetRow;
  /** True when an existing asset was returned instead of a new one. */
  deduplicated: boolean;
}

/** Store bytes + row with cheap facts; schedule derivatives. Throws without db/storage. */
export async function ingestAsset(
  host: AssetLibraryHost,
  input: IngestAssetInput,
): Promise<IngestResult> {
  const db = host.db;
  const storage = host.storage;
  if (!db) throw new Error("Database not configured — cannot store an asset.");
  if (!storage) throw new Error("Storage not configured — cannot store an asset.");
  const sha256 = sha256Hex(input.data);
  if (input.dedupe) {
    const found = db.findAssetByHash(input.owner, sha256, input.origin);
    // Same bytes stored under another type (a different extension hint) stay separate.
    const existing = found?.mime_type === input.mime ? found : undefined;
    if (existing) return { asset: existing, deduplicated: true };
  }
  const id = input.id ?? crypto.randomUUID();
  const storageKey = `${id}${input.ext ?? extOf(input.filename)}`;
  const probed = input.mime.startsWith("image/") ? probeImage(input.data) : undefined;
  await storage.put(storageKey, input.data, input.mime);
  db.createAsset({
    id,
    entityName: input.owner,
    filename: input.filename,
    mimeType: input.mime,
    size: input.data.byteLength,
    storageKey,
    ...(input.metadata ? { metadata: input.metadata } : {}),
    origin: input.origin,
    ...(input.provenance ? { provenance: input.provenance } : {}),
    sha256,
    ...(probed ? { width: probed.width, height: probed.height } : {}),
  });
  const asset = db.getAsset(id) as AssetRow;
  emit(host, "asset_created", asset, input.actor);
  // `sync` waits here; `on` queues and returns; `off` makes none.
  await scheduleDerivatives(host, id, input.data);
  return { asset, deduplicated: false };
}

/**
 * For writers that store the row themselves: record sha256 + dimensions now
 * and schedule derivatives. Never rejects (a failure leaves it to the
 * backfill); settles at once unless `MARINA_ASSET_DERIVATIVES=sync`.
 */
export async function recordAssetWrite(
  host: AssetLibraryHost,
  id: string,
  data: Uint8Array,
  actor?: EntityId,
): Promise<void> {
  const db = host.db;
  if (!db) return;
  try {
    const row = db.getAsset(id);
    if (!row) return;
    const probed = row.mime_type.startsWith("image/") ? probeImage(data) : undefined;
    db.updateAssetFacts(id, {
      sha256: sha256Hex(data),
      ...(probed ? { width: probed.width, height: probed.height } : {}),
    });
    emit(host, "asset_created", row, actor);
    await scheduleDerivatives(host, id, data);
  } catch (error) {
    logger.warn("media", "Recording asset facts failed", { id, error: getErrorMessage(error) });
  }
}

// ─── Derivatives ─────────────────────────────────────────────────────────────

/**
 * `MARINA_ASSET_DERIVATIVES`: `on` (default) queues derivative work off the
 * request path; `sync` makes it inline before the write returns (tests,
 * scripts that exit right after); `off` makes none — no `sharp`, `ffmpeg` or
 * `pdftoppm` is ever started (facts are still recorded). Read per call.
 */
export type DerivativeMode = "on" | "off" | "sync";
export function derivativeMode(
  env: Record<string, string | undefined> = process.env,
): DerivativeMode {
  const raw = env.MARINA_ASSET_DERIVATIVES?.trim().toLowerCase();
  if (raw === "off" || raw === "false" || raw === "0") return "off";
  if (raw === "sync") return "sync";
  return "on";
}

let chain: Promise<void> = Promise.resolve();
let queued = 0;
/** Set while `drainAssetDerivatives` runs: queued jobs that have not started are skipped. */
let closing = false;

/**
 * Queue derivative generation for an asset (one job at a time per process).
 * Every job is part of `chain`, which `drainAssetDerivatives` (engine
 * shutdown) awaits, so derivative work never outlives the database it writes.
 * The returned promise settles when the job does in `sync` mode, at once
 * otherwise; it never rejects.
 */
export function scheduleDerivatives(
  host: AssetLibraryHost,
  id: string,
  data?: Uint8Array,
): Promise<void> {
  const mode = derivativeMode();
  if (mode === "off" || closing) return Promise.resolve();
  if (mode === "on" && queued >= DERIVATIVE_QUEUE_MAX) return Promise.resolve(); // backfill later
  queued++;
  const job = chain.then(async () => {
    try {
      if (!closing) await generateDerivatives(host, id, data);
    } catch (error) {
      logger.warn("media", "Asset derivatives failed", { id, error: getErrorMessage(error) });
    } finally {
      queued--;
    }
  });
  chain = job;
  if (host.trackBackground) void host.trackBackground(job);
  return mode === "sync" ? job : Promise.resolve();
}

/** Derivative jobs queued or running in this process. */
export function assetDerivativesPending(): number {
  return queued;
}

/** Settles when every queued derivative job has finished. */
export function derivativesIdle(): Promise<void> {
  return chain;
}

/**
 * Stop starting derivative jobs and wait for the one in flight (engine
 * shutdown, before the database closes). Later writes queue again.
 */
export async function drainAssetDerivatives(): Promise<void> {
  closing = true;
  try {
    let tail: Promise<void>;
    do {
      tail = chain;
      await tail;
    } while (tail !== chain);
  } finally {
    closing = false;
  }
}

export type DerivativeState = "done" | "partial" | "unavailable" | "failed" | "none" | "skipped";

export interface DerivativeOutcome {
  state: DerivativeState;
  /** Kinds stored. */
  made: string[];
  /** Why something could not be made (missing tool, oversize, decode failure). */
  notes: string[];
}

async function storeDerivative(
  host: AssetLibraryHost,
  parent: AssetRow,
  kind: string,
  out: { bytes: Uint8Array; mime: string; width?: number; height?: number },
): Promise<void> {
  const db = host.db as MarinaDB;
  const storage = host.storage as StorageProvider;
  const id = crypto.randomUUID();
  const ext = out.mime === "image/webp" ? ".webp" : out.mime === "image/png" ? ".png" : ".jpg";
  const storageKey = `${id}${ext}`;
  await storage.put(storageKey, out.bytes, out.mime);
  const base = parent.filename.replace(/\.[^.]*$/, "") || "asset";
  db.createAsset({
    id,
    entityName: parent.entity_name,
    filename: `${base}.${kind}${ext}`,
    mimeType: out.mime,
    size: out.bytes.byteLength,
    storageKey,
    derivedFrom: parent.id,
    sha256: sha256Hex(out.bytes),
    ...(out.width ? { width: out.width } : {}),
    ...(out.height ? { height: out.height } : {}),
  });
  db.linkAssets(id, parent.id, kind);
}

/** Thumbnails + placeholder from raster bytes (the image itself, a poster or a page). */
async function rasterDerivatives(
  host: AssetLibraryHost,
  parent: AssetRow,
  raster: Uint8Array,
  have: Set<string>,
  outcome: DerivativeOutcome,
): Promise<void> {
  const info = probeImage(raster);
  const long = info ? Math.max(info.width, info.height) : 0;
  for (const { size, kind } of THUMBNAIL_SIZES) {
    if (have.has(kind)) continue;
    // A source no larger than a smaller thumbnail needs no bigger one.
    if (size > THUMBNAIL_SIZES[0].size && long > 0 && long <= THUMBNAIL_SIZES[0].size) continue;
    const thumb = await thumbnail(raster, size);
    if (!thumb) {
      outcome.notes.push(`${kind}: could not be made`);
      continue;
    }
    await storeDerivative(host, parent, kind, thumb);
    outcome.made.push(kind);
  }
  if (!parent.placeholder) {
    const tiny = await thumbnail(raster, PLACEHOLDER_SIZE);
    if (tiny)
      host.db?.updateAssetFacts(parent.id, { placeholder: toDataUrl(tiny.bytes, tiny.mime) });
  }
}

async function withTempFile<T>(
  data: Uint8Array,
  name: string,
  fn: (dir: string, file: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "marina-asset-"));
  try {
    const file = join(dir, name);
    await writeFile(file, data);
    return await fn(dir, file);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Duration (ms) and first video stream size from ffprobe, when installed. */
async function ffprobe(
  file: string,
): Promise<{ durationMs?: number; width?: number; height?: number } | undefined> {
  if (!hasTool("ffprobe")) return undefined;
  const r = await runTool([
    "ffprobe",
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=width,height,codec_type",
    "-of",
    "json",
    file,
  ]);
  if (!r.ok) return undefined;
  try {
    const parsed = JSON.parse(r.stdout) as {
      format?: { duration?: string };
      streams?: { codec_type?: string; width?: number; height?: number }[];
    };
    const seconds = Number(parsed.format?.duration);
    const video = parsed.streams?.find((s) => s.codec_type === "video" && s.width && s.height);
    return {
      ...(Number.isFinite(seconds) && seconds > 0
        ? { durationMs: Math.round(seconds * 1000) }
        : {}),
      ...(video ? { width: video.width, height: video.height } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Make what is missing for one asset and record the outcome on the row
 * (`derivative_state` / `derivative_note`). Emits `asset_updated` when
 * anything new was stored. Safe to re-run: existing kinds are skipped.
 */
export async function generateDerivatives(
  host: AssetLibraryHost,
  id: string,
  data?: Uint8Array,
): Promise<DerivativeOutcome | undefined> {
  const db = host.db;
  const storage = host.storage;
  if (!db || !storage) return undefined;
  const parent = db.getAsset(id);
  if (!parent || parent.derived_from) return undefined;
  const outcome: DerivativeOutcome = { state: "none", made: [], notes: [] };
  const have = new Set(db.listDerivatives([id]).map((d) => d.kind));
  const type = assetTypeOf(parent.mime_type);
  const derivable =
    (type === "image" && parent.mime_type !== "image/svg+xml") ||
    type === "video" ||
    type === "audio" ||
    type === "pdf";
  if (!derivable) {
    db.updateAssetFacts(id, { derivativeState: "none", derivativeNote: null });
    return outcome;
  }
  if (parent.size > MAX_DERIVE_BYTES) {
    db.updateAssetFacts(id, {
      derivativeState: "skipped",
      derivativeNote: `larger than ${MAX_DERIVE_BYTES} bytes`,
    });
    return { ...outcome, state: "skipped" };
  }
  const bytes = data ?? (await storage.get(parent.storage_key))?.data;
  if (!bytes) {
    db.updateAssetFacts(id, { derivativeState: "failed", derivativeNote: "stored bytes missing" });
    return { ...outcome, state: "failed" };
  }
  const missingTools: string[] = [];
  try {
    if (type === "image") {
      if (!(await imageProcessingAvailable())) missingTools.push("sharp");
      else await rasterDerivatives(host, parent, bytes, have, outcome);
    } else if (type === "video" || type === "audio") {
      await withTempFile(bytes, "media", async (dir, file) => {
        const probe = await ffprobe(file);
        if (!probe) missingTools.push("ffprobe");
        else
          db.updateAssetFacts(id, {
            ...(probe.durationMs ? { durationMs: probe.durationMs } : {}),
            ...(type === "video" && probe.width
              ? { width: probe.width, height: probe.height }
              : {}),
          });
        if (type !== "video") return;
        if (!hasTool("ffmpeg")) {
          missingTools.push("ffmpeg");
          return;
        }
        if (have.has("poster") && have.has("thumbnail-256")) return;
        const out = join(dir, "poster.png");
        const r = await runTool([
          "ffmpeg",
          "-nostdin",
          "-loglevel",
          "error",
          "-i",
          file,
          "-vf",
          "thumbnail=30,scale='min(1280,iw)':-2",
          "-frames:v",
          "1",
          out,
        ]);
        if (!r.ok) {
          outcome.notes.push("poster: ffmpeg could not read a frame");
          return;
        }
        const poster = new Uint8Array(await readFile(out));
        await posterAndThumbs(host, parent, poster, "poster", have, outcome, missingTools);
      });
    } else if (type === "pdf") {
      await withTempFile(bytes, "doc.pdf", async (dir, file) => {
        if (hasTool("pdfinfo")) {
          const info = await runTool(["pdfinfo", file]);
          const pages = info.ok ? Number(/^Pages:\s+(\d+)/m.exec(info.stdout)?.[1]) : Number.NaN;
          if (Number.isFinite(pages) && pages > 0) db.updateAssetFacts(id, { pages });
        }
        if (!hasTool("pdftoppm")) {
          missingTools.push("pdftoppm");
          return;
        }
        if (have.has("preview") && have.has("thumbnail-256")) return;
        const r = await runTool([
          "pdftoppm",
          "-png",
          "-r",
          "72",
          "-f",
          "1",
          "-l",
          "1",
          "-singlefile",
          file,
          join(dir, "page"),
        ]);
        const page = (await readdir(dir)).find((n) => n.startsWith("page") && n.endsWith(".png"));
        if (!r.ok || !page) {
          outcome.notes.push("preview: pdftoppm could not render page 1");
          return;
        }
        const raster = new Uint8Array(await readFile(join(dir, page)));
        await posterAndThumbs(host, parent, raster, "preview", have, outcome, missingTools);
      });
    }
  } catch (error) {
    outcome.notes.push(getErrorMessage(error));
  }
  if (missingTools.length) outcome.notes.unshift(`not installed: ${missingTools.join(", ")}`);
  outcome.state =
    outcome.made.length > 0
      ? outcome.notes.length > 0
        ? "partial"
        : "done"
      : missingTools.length > 0
        ? "unavailable"
        : outcome.notes.length > 0
          ? "failed"
          : have.size > 0 || type === "image" || type === "audio"
            ? "done"
            : "none";
  db.updateAssetFacts(id, {
    derivativeState: outcome.state,
    derivativeNote: outcome.notes.length ? outcome.notes.join("; ").slice(0, 500) : null,
  });
  if (outcome.made.length > 0) emit(host, "asset_updated", parent);
  return outcome;
}

/** Store a poster/preview frame, then thumbnails of it (when `sharp` is present). */
async function posterAndThumbs(
  host: AssetLibraryHost,
  parent: AssetRow,
  frame: Uint8Array,
  kind: "poster" | "preview",
  have: Set<string>,
  outcome: DerivativeOutcome,
  missingTools: string[],
): Promise<void> {
  const info = probeImage(frame);
  if (!have.has(kind)) {
    await storeDerivative(host, parent, kind, {
      bytes: frame,
      mime: info?.mime ?? "image/png",
      ...(info ? { width: info.width, height: info.height } : {}),
    });
    outcome.made.push(kind);
  }
  if (await imageProcessingAvailable()) await rasterDerivatives(host, parent, frame, have, outcome);
  else missingTools.push("sharp");
}

// ─── Backfill ────────────────────────────────────────────────────────────────

/**
 * Fill sha256/dimensions and derivatives for up to `limit` rows that lack
 * them (oldest first). Returns how many rows were examined.
 */
export async function backfillAssets(
  host: AssetLibraryHost,
  limit = BACKFILL_BATCH,
): Promise<number> {
  const db = host.db;
  const storage = host.storage;
  if (!db || !storage) return 0;
  const rows = db.listAssetsNeedingFacts(limit);
  for (const row of rows) {
    const stored = await storage.get(row.storage_key).catch(() => null);
    if (!stored) {
      db.updateAssetFacts(row.id, {
        sha256: "",
        derivativeState: "failed",
        derivativeNote: "stored bytes missing",
      });
      continue;
    }
    if (row.sha256 === null) {
      const probed = row.mime_type.startsWith("image/") ? probeImage(stored.data) : undefined;
      db.updateAssetFacts(row.id, {
        sha256: sha256Hex(stored.data),
        ...(probed ? { width: probed.width, height: probed.height } : {}),
      });
    }
    // `off` leaves the state null so a later pass (once enabled) makes them.
    if (row.derivative_state === null && derivativeMode() !== "off")
      await generateDerivatives(host, row.id, stored.data);
  }
  return rows.length;
}

// ─── Edits and deletion ──────────────────────────────────────────────────────

export interface AssetEdit {
  caption?: string | null;
  alt?: string | null;
  addTags?: readonly string[];
  removeTags?: readonly string[];
}

/** Validate an edit; a string is the reason it is refused. */
export function checkAssetEdit(
  edit: AssetEdit,
  currentTags: readonly string[],
): string | undefined {
  if (typeof edit.caption === "string" && edit.caption.length > MAX_CAPTION_CHARS)
    return `Caption is longer than ${MAX_CAPTION_CHARS} characters.`;
  if (typeof edit.alt === "string" && edit.alt.length > MAX_ALT_CHARS)
    return `Alt text is longer than ${MAX_ALT_CHARS} characters.`;
  const after = new Set(currentTags);
  for (const t of edit.removeTags ?? []) after.delete(t);
  for (const t of edit.addTags ?? []) after.add(t);
  if (after.size > MAX_TAGS_PER_ASSET) return `At most ${MAX_TAGS_PER_ASSET} tags per asset.`;
  return undefined;
}

/** Apply caption/alt/tag changes (already authorized + checked); emits `asset_updated`. */
export function editAsset(
  host: AssetLibraryHost,
  row: AssetRow,
  edit: AssetEdit,
  actor?: EntityId,
): { asset: AssetRow; tags: string[] } {
  const db = host.db as MarinaDB;
  const text: { caption?: string | null; alt?: string | null } = {};
  if (edit.caption !== undefined) text.caption = edit.caption?.trim() || null;
  if (edit.alt !== undefined) text.alt = edit.alt?.trim() || null;
  if (Object.keys(text).length > 0) db.updateAssetText(row.id, text);
  const tags =
    edit.addTags?.length || edit.removeTags?.length
      ? db.setAssetTags(row.id, edit.addTags ?? [], edit.removeTags ?? [])
      : db.getAssetTags(row.id);
  const asset = db.getAsset(row.id) as AssetRow;
  emit(host, "asset_updated", asset, actor);
  return { asset, tags };
}

/**
 * Delete an asset's bytes and its derivatives' bytes, then the row (derivative
 * rows, tags and links cascade; canvas nodes keep their SET NULL). Emits
 * `asset_deleted`. Returns whether the row existed.
 */
export async function removeAsset(
  host: AssetLibraryHost,
  row: AssetRow,
  actor?: EntityId,
): Promise<boolean> {
  const db = host.db;
  if (!db) return false;
  const derived = db.listDerivatives([row.id]);
  if (host.storage) {
    for (const d of derived) await host.storage.delete(d.storage_key).catch(() => false);
    await host.storage.delete(row.storage_key).catch(() => false);
  }
  const removed = db.deleteAsset(row.id);
  if (removed) emit(host, "asset_deleted", row, actor);
  return removed;
}
