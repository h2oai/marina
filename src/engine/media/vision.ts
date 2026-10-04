// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Seeing images, documents and video — the understanding side of Marina's
 * media. A visual source (a canvas node, a stored asset, or an http(s) URL) is
 * loaded as untrusted bytes, prepared into model inputs (raster images as data
 * URLs; PDFs as extracted text plus a few page images; video as a few sampled
 * keyframes), and described by a vision-capable model through Marina's own
 * passthru — so spend, the daily cap and traces apply exactly as for any other
 * model call.
 *
 * Sizes to what the installation has: the model is the caller's choice, else
 * the agent's own model, falling through to `MARINA_VISION_MODEL` when that
 * one cannot read images, else Marina's default route. PDF and video preparation use `pdftotext`/`pdftoppm`/`ffmpeg` when
 * they are installed and say so plainly when they are not. A model that cannot
 * read images produces a labelled refusal, never a crash.
 *
 * Untrusted input: bytes are capped (`MARINA_VISION_MAX_BYTES`, default 20 MB),
 * raster images must pass the asset pipeline's magic-byte check, SVG is never
 * sent (it is markup, not pixels), URLs go through `guardedFetch` (SSRF), and
 * external tools run asynchronously with argument arrays (no shell), a private
 * temp directory, a hard timeout, capped output and a process-wide concurrency
 * limit, so a slow or crafted file never stalls the tick or other requests.
 * Each entity's looks are rate limited (the local profile lifts it).
 */

import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RateLimiter } from "../../auth/rate-limiter";
import { proxyToUpstream } from "../../net/model-api/upstream";
import { guardedFetch } from "../../net/url-guard";
import type { EntityId } from "../../types";
import { type CanvasReader, canvasReaderFor, mayReadAsset, readableNode } from "../canvas-access";
import type { Engine } from "../engine";

/** The kinds of visual input a source can be prepared into. */
export type VisualKind = "image" | "pdf" | "video" | "text";

/** A loaded visual source: untrusted bytes plus where they came from. */
export interface VisualSource {
  data: Uint8Array;
  mime: string;
  label: string;
  /** Set when the source is a canvas node (descriptions link back to it). */
  nodeId?: string;
  canvasId?: string;
  assetId?: string;
}

/** Model-ready input: image data URLs and/or extracted text, plus honest notes. */
export interface VisualInput {
  kind: VisualKind;
  images: string[];
  text?: string;
  notes: string[];
}

/** A description and how it was produced. */
export interface VisualDescription {
  ok: boolean;
  text: string;
  model: string;
  kind: VisualKind;
  notes: string[];
  cached?: boolean;
}

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_CHARS = 24_000;
const PDF_PAGES_AS_IMAGES = 3;
const PDF_TEXT_PAGES = 12;
const VIDEO_FRAMES = 4;
const TOOL_TIMEOUT_MS = 30_000;
/** Bytes read from one tool's stdout (pdftotext); the text is clamped far below this. */
const TOOL_STDOUT_MAX_BYTES = 4 * 1024 * 1024;
/** PDF/video preparations running at once, process-wide. */
export const VISION_TOOL_CONCURRENCY = 2;
/** Preparations allowed to wait for a slot; beyond this a look is refused at once. */
export const VISION_TOOL_QUEUE_MAX = 8;
const CACHE_LIMIT = 200;

const VISION_SYSTEM =
  "You describe visual inputs precisely for other agents. State what is shown: text (verbatim when legible), numbers, labels, structure, objects and relationships. Answer the question directly when one is asked. Say plainly when something is illegible or ambiguous; never guess at unreadable text.";

/** The per-installation cap on visual bytes. */
export function visionMaxBytes(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.MARINA_VISION_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 100 * 1024 * 1024) : DEFAULT_MAX_BYTES;
}

/**
 * The models to try, in order: an explicit choice alone; otherwise the agent's
 * own model, then `MARINA_VISION_MODEL`, then Marina's default route. A model
 * that cannot read images falls through to the next.
 */
export function visionModelCandidates(
  explicit: string | undefined,
  agentModel: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (explicit?.trim()) return [explicit.trim()];
  const list = [agentModel?.trim(), env.MARINA_VISION_MODEL?.trim()].filter(
    (m): m is string => !!m,
  );
  if (list.length === 0) list.push("marina");
  return [...new Set(list)];
}

/** The first model to see with (see `visionModelCandidates`). */
export function resolveVisionModel(
  explicit: string | undefined,
  agentModel: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  return visionModelCandidates(explicit, agentModel, env)[0] as string;
}

// ─── Loading ────────────────────────────────────────────────────────────────

/** Raster image types by magic bytes (mirrors the asset pipeline's check). */
export function sniffRaster(data: Uint8Array): string | null {
  const b = data;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38)
    return "image/gif";
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return "image/webp";
  return null;
}

function isPdf(data: Uint8Array): boolean {
  return data.length >= 5 && String.fromCharCode(...data.subarray(0, 5)) === "%PDF-";
}

/** What kind of visual input these bytes are, by content first and declared MIME second. */
export function classifyVisual(data: Uint8Array, mime: string): VisualKind | null {
  if (sniffRaster(data)) return "image";
  if (isPdf(data)) return "pdf";
  const m = mime.toLowerCase();
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("text/") || m === "application/json") return "text";
  return null;
}

/**
 * Load a stored asset's bytes (size-capped). A private asset the reader may
 * not read (`mayReadAsset`) is "not found", exactly like a missing one.
 */
export async function loadAsset(
  engine: Engine,
  assetId: string,
  reader: CanvasReader,
  env: Record<string, string | undefined> = process.env,
): Promise<VisualSource> {
  const db = engine.db;
  if (!db || !engine.storage) throw new Error("Asset storage is not configured.");
  const asset = db.getAsset(assetId);
  if (!asset || !mayReadAsset(engine, asset, reader, "look asset")) {
    throw new Error(`Asset "${assetId}" not found.`);
  }
  if (asset.size > visionMaxBytes(env))
    throw new Error("Asset is larger than the vision size cap.");
  const stored = await engine.storage.get(asset.storage_key);
  if (!stored) throw new Error("Asset bytes are unavailable.");
  return {
    data: stored.data,
    mime: asset.mime_type ?? stored.mime,
    label: asset.filename,
    assetId,
  };
}

/**
 * Load the asset behind a canvas node. A node on a private canvas the reader
 * may not read (no ownership, operator standing or live grant) is "not found",
 * exactly like a missing one (`src/engine/canvas-access.ts`).
 */
export async function loadCanvasNode(
  engine: Engine,
  nodeId: string,
  reader: CanvasReader,
  env: Record<string, string | undefined> = process.env,
): Promise<VisualSource> {
  const db = engine.db;
  if (!db) throw new Error("Persistence is not configured.");
  const node = readableNode(engine, nodeId, reader, "look node");
  if (!node) throw new Error(`Canvas node "${nodeId}" not found.`);
  if (!node.asset_id) {
    let text = "";
    try {
      const data = JSON.parse(node.data || "{}") as { text?: unknown; content?: unknown };
      text = String(data.text ?? data.content ?? "");
    } catch {
      // allow-empty-catch: a node without parseable data has no text to read
    }
    if (!text) throw new Error(`Canvas node "${node.id}" has no asset or text to look at.`);
    return {
      data: new TextEncoder().encode(text),
      mime: "text/plain",
      label: `node ${node.id}`,
      nodeId: node.id,
      canvasId: node.canvas_id,
    };
  }
  // Reading the node grants reading what it shows: the node check above is the
  // decision, so the asset is loaded without a second (asset-level) check.
  const src = await loadAsset(engine, node.asset_id, { isOperator: true }, env);
  return { ...src, nodeId: node.id, canvasId: node.canvas_id };
}

/** Fetch a URL through the SSRF guard, size-capped. */
export async function loadUrl(
  url: string,
  env: Record<string, string | undefined> = process.env,
): Promise<VisualSource> {
  if (!/^https?:\/\//i.test(url)) throw new Error("Only http(s) URLs can be looked at.");
  const resp = await guardedFetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) throw new Error(`Fetch failed: HTTP ${resp.status}.`);
  const cap = visionMaxBytes(env);
  const declared = Number(resp.headers.get("content-length") ?? 0);
  if (declared > cap) throw new Error("Remote file is larger than the vision size cap.");
  const buf = await readBodyCapped(resp, cap);
  return {
    data: buf,
    mime: (resp.headers.get("content-type") ?? "").split(";")[0]!.trim(),
    label: url,
  };
}

/** Read a response body, refusing as soon as it passes `cap` bytes (a missing
 *  or false `content-length` never buffers more than the cap). */
async function readBodyCapped(resp: Response, cap: number): Promise<Uint8Array> {
  if (!resp.body) return new Uint8Array(0);
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Remote file is larger than the vision size cap.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * Resolve `node:<id>`, `asset:<id>`, an http(s) URL, a canvas node id or an
 * asset id, as `reader`. A bare id the reader may not read as a node falls
 * through to the asset lookup, the same as an id that names no node, so the
 * reply never tells a private node apart from a missing one.
 */
export async function loadVisualSource(
  engine: Engine,
  ref: string,
  reader: CanvasReader,
  env: Record<string, string | undefined> = process.env,
): Promise<VisualSource> {
  if (/^https?:\/\//i.test(ref)) return loadUrl(ref, env);
  if (ref.startsWith("node:")) return loadCanvasNode(engine, ref.slice(5), reader, env);
  if (ref.startsWith("asset:")) return loadAsset(engine, ref.slice(6), reader, env);
  if (readableNode(engine, ref, reader, "look node")) {
    return loadCanvasNode(engine, ref, reader, env);
  }
  return loadAsset(engine, ref, reader, env);
}

// ─── Preparation ────────────────────────────────────────────────────────────

/** Is an executable on PATH? (cached per process) */
const toolCache = new Map<string, boolean>();
export function hasTool(name: string): boolean {
  const hit = toolCache.get(name);
  if (hit !== undefined) return hit;
  const found = Bun.which(name) !== null;
  toolCache.set(name, found);
  return found;
}

/** Read at most `cap` bytes of a stream; past it, `onOverflow` (kill) and stop. */
async function readStreamCapped(
  stream: ReadableStream<Uint8Array>,
  cap: number,
  onOverflow: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = cap - total;
    total += value.byteLength;
    out += decoder.decode(room < value.byteLength ? value.subarray(0, room) : value, {
      stream: true,
    });
    if (total >= cap) {
      onOverflow();
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return out + decoder.decode();
}

/**
 * Run a tool asynchronously with an argument array (never a shell), a hard
 * timeout and capped stdout. A timeout, an abort or an output overflow kills
 * the process and fails the run; the event loop is never held.
 */
export async function runTool(
  cmd: string[],
  opts: { timeoutMs?: number; signal?: AbortSignal; maxStdoutBytes?: number } = {},
): Promise<{ ok: boolean; stdout: string; timedOut?: boolean }> {
  if (opts.signal?.aborted) return { ok: false, stdout: "" };
  let proc: ReturnType<typeof Bun.spawn<"ignore", "pipe", "ignore">>;
  try {
    proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  } catch {
    return { ok: false, stdout: "" };
  }
  let killed = false;
  let timedOut = false;
  const kill = () => {
    if (killed) return;
    killed = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      // allow-empty-catch: the process already exited
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, opts.timeoutMs ?? TOOL_TIMEOUT_MS);
  opts.signal?.addEventListener("abort", kill, { once: true });
  try {
    const [stdout, code] = await Promise.all([
      readStreamCapped(proc.stdout, opts.maxStdoutBytes ?? TOOL_STDOUT_MAX_BYTES, kill),
      proc.exited,
    ]);
    return { ok: code === 0 && !killed, stdout, ...(timedOut ? { timedOut } : {}) };
  } catch {
    kill();
    return { ok: false, stdout: "" };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", kill);
  }
}

/** A process-wide slot limit for tool-backed preparations (PDF, video). */
let toolSlotsInUse = 0;
const toolSlotWaiters: Array<() => void> = [];

/** Take a preparation slot, or undefined when too many are already waiting. */
async function acquireToolSlot(): Promise<(() => void) | undefined> {
  if (toolSlotsInUse >= VISION_TOOL_CONCURRENCY) {
    if (toolSlotWaiters.length >= VISION_TOOL_QUEUE_MAX) return undefined;
    await new Promise<void>((resolve) => toolSlotWaiters.push(resolve));
  } else {
    toolSlotsInUse++;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = toolSlotWaiters.shift();
    // The slot passes straight to the next waiter; otherwise it is freed.
    if (next) next();
    else toolSlotsInUse--;
  };
}

/** For tests: the slots in use and the waiters. */
export function visionToolLoad(): { inUse: number; waiting: number } {
  return { inUse: toolSlotsInUse, waiting: toolSlotWaiters.length };
}

function toDataUrl(mime: string, data: Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(data).toString("base64")}`;
}

function clampText(s: string): string {
  return s.length <= MAX_TEXT_CHARS ? s : `${s.slice(0, MAX_TEXT_CHARS)}\n[…truncated]`;
}

/**
 * Turn a loaded source into model input. Never throws for missing tools — it
 * notes them. PDF and video preparation run external tools asynchronously
 * under the process-wide slot limit; when every slot and the queue are full
 * the preparation is refused at once with a note (nothing waits unbounded).
 */
export async function prepareVisual(
  src: VisualSource,
  opts: { signal?: AbortSignal } = {},
): Promise<VisualInput> {
  const kind = classifyVisual(src.data, src.mime);
  if (!kind) {
    if (src.mime.toLowerCase() === "image/svg+xml") {
      return {
        kind: "text",
        images: [],
        notes: ["SVG is markup, not pixels; it is not sent to a vision model."],
      };
    }
    throw new Error(
      `Unsupported content (${src.mime || "unknown type"}); images, PDFs, video and text can be looked at.`,
    );
  }
  if (kind === "image") {
    return { kind, images: [toDataUrl(sniffRaster(src.data)!, src.data)], notes: [] };
  }
  if (kind === "text") {
    return { kind, images: [], text: clampText(new TextDecoder().decode(src.data)), notes: [] };
  }
  if (kind === "video" && !hasTool("ffmpeg")) {
    return {
      kind,
      images: [],
      notes: ["ffmpeg is not installed; video frames could not be sampled."],
    };
  }
  const release = await acquireToolSlot();
  if (!release) {
    return {
      kind,
      images: [],
      notes: ["Vision is busy preparing other documents; try again shortly."],
    };
  }
  const run = (cmd: string[]) => runTool(cmd, { signal: opts.signal });
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "marina-vision-"));
    if (kind === "pdf") {
      const notes: string[] = [];
      const file = join(dir, "doc.pdf");
      await writeFile(file, src.data);
      let text: string | undefined;
      if (hasTool("pdftotext")) {
        const r = await run(["pdftotext", "-l", String(PDF_TEXT_PAGES), "-layout", file, "-"]);
        if (r.ok && r.stdout.trim()) text = clampText(r.stdout);
      } else notes.push("pdftotext is not installed; no text was extracted.");
      const images: string[] = [];
      if (hasTool("pdftoppm")) {
        const r = await run([
          "pdftoppm",
          "-png",
          "-r",
          "80",
          "-l",
          String(PDF_PAGES_AS_IMAGES),
          file,
          join(dir, "page"),
        ]);
        if (r.ok) {
          for (const f of (await readdir(dir))
            .filter((n) => n.startsWith("page") && n.endsWith(".png"))
            .sort()) {
            images.push(toDataUrl("image/png", await readFile(join(dir, f))));
          }
        }
      } else notes.push("pdftoppm is not installed; pages were not rendered as images.");
      if (!text && images.length === 0)
        notes.push("Nothing could be extracted from this PDF here.");
      return { kind, images, ...(text ? { text } : {}), notes };
    }
    // video
    const file = join(dir, "clip");
    await writeFile(file, src.data);
    const r = await run([
      "ffmpeg",
      "-nostdin",
      "-loglevel",
      "error",
      "-i",
      file,
      "-vf",
      "thumbnail=60,scale=768:-2",
      "-frames:v",
      String(VIDEO_FRAMES),
      "-vsync",
      "vfr",
      join(dir, "frame-%02d.png"),
    ]);
    const images: string[] = [];
    if (r.ok) {
      const frames = (await readdir(dir)).filter((n) => n.startsWith("frame-")).sort();
      for (const f of frames) images.push(toDataUrl("image/png", await readFile(join(dir, f))));
    }
    return {
      kind,
      images,
      notes: images.length
        ? [`${images.length} keyframes sampled.`]
        : ["No frames could be sampled from this video."],
    };
  } finally {
    release();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ─── Describing ─────────────────────────────────────────────────────────────

const cache = new Map<string, VisualDescription>();

/** Cache key: content hash + question + model. */
function cacheKey(src: VisualSource, question: string, model: string): string {
  return createHash("sha256")
    .update(src.data)
    .update("\0")
    .update(question)
    .update("\0")
    .update(model)
    .digest("hex");
}

/** For tests. */
export function clearVisionCache(): void {
  cache.clear();
}

/** The chat body sent to the vision model (exported for tests). */
export function visionRequest(
  model: string,
  question: string,
  input: VisualInput,
  label: string,
): Record<string, unknown> {
  const intro = [
    `Source: ${label} (${input.kind}).`,
    question ? `Question: ${question}` : "Describe it.",
    input.text ? `Extracted text:\n${input.text}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const content: Array<Record<string, unknown>> = [{ type: "text", text: intro }];
  for (const url of input.images) content.push({ type: "image_url", image_url: { url } });
  return {
    model,
    stream: false,
    max_tokens: 1500,
    messages: [
      { role: "system", content: VISION_SYSTEM },
      { role: "user", content },
    ],
  };
}

/** Describe a loaded source. Degrades to a labelled message; never throws for model limits. */
export async function describeVisual(
  engine: Engine,
  src: VisualSource,
  opts: {
    question?: string;
    model?: string;
    agentModel?: string;
    entityId?: EntityId;
    signal?: AbortSignal;
  } = {},
): Promise<VisualDescription> {
  const question = (opts.question ?? "").trim();
  const candidates = visionModelCandidates(opts.model, opts.agentModel);
  for (const model of candidates) {
    const hit = cache.get(cacheKey(src, question, model));
    if (hit) return { ...hit, cached: true };
  }
  const input = await prepareVisual(src, opts.signal ? { signal: opts.signal } : {});
  if (input.images.length === 0 && !input.text) {
    return {
      ok: false,
      text: input.notes.join(" ") || "Nothing to look at.",
      model: candidates[0] ?? "marina",
      kind: input.kind,
      notes: input.notes,
    };
  }
  // The agent's own model first; a model that cannot read images falls through
  // to the next candidate, and the last failure is the labelled answer.
  let last: VisualDescription | undefined;
  for (const model of candidates) {
    const desc = await describeWith(engine, src, input, question, model, opts.entityId);
    if (desc.ok) {
      if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
      cache.set(cacheKey(src, question, model), desc);
      return last ? { ...desc, notes: [...desc.notes, `${last.model} could not see it.`] } : desc;
    }
    last = desc;
  }
  return last as VisualDescription;
}

async function describeWith(
  engine: Engine,
  src: VisualSource,
  input: VisualInput,
  question: string,
  model: string,
  entityId: EntityId | undefined,
): Promise<VisualDescription> {
  let resp: Response;
  try {
    resp = await proxyToUpstream(
      engine,
      visionRequest(model, question, input, src.label),
      undefined,
      {
        routeKind: "passthru",
        routeReason: "vision",
        ...(entityId ? { entityId } : {}),
      },
    );
  } catch (e) {
    return {
      ok: false,
      text: `Vision call failed: ${e instanceof Error ? e.message : String(e)}`,
      model,
      kind: input.kind,
      notes: input.notes,
    };
  }
  const body = (await resp.json().catch(() => ({}))) as {
    choices?: { message?: { content?: unknown } }[];
    error?: { message?: string };
  };
  const text = body.choices?.[0]?.message?.content;
  if (!resp.ok || typeof text !== "string" || !text.trim()) {
    const why = body.error?.message ?? `HTTP ${resp.status}`;
    return {
      ok: false,
      text: `No vision-capable answer from "${model}" (${why}). Set MARINA_VISION_MODEL to a model that accepts images.`,
      model,
      kind: input.kind,
      notes: input.notes,
    };
  }
  return { ok: true, text: text.trim(), model, kind: input.kind, notes: input.notes };
}

// ─── Canvas write-back ──────────────────────────────────────────────────────

/**
 * Write a description back to the canvas as a text node beside its source,
 * linked by a `derived_from` edge, so it is visible in the dashboard and
 * reusable by every agent. Returns the new node id, or undefined when the
 * source is not a canvas node.
 */
export function writeDescriptionToCanvas(
  engine: Engine,
  src: VisualSource,
  desc: VisualDescription,
  question: string,
  author: { entityId: EntityId; name: string },
): string | undefined {
  const db = engine.db;
  if (!db || !src.nodeId || !src.canvasId || !desc.ok) return undefined;
  const source = db.getNode(src.nodeId);
  if (!source) return undefined;
  const nodeId = crypto.randomUUID();
  db.createNode({
    id: nodeId,
    canvasId: src.canvasId,
    type: "text",
    x: source.x + source.width + 40,
    y: source.y,
    data: {
      text: desc.text,
      title: question ? `Look: ${question.slice(0, 80)}` : "Look",
      author: author.name,
      look: { source: src.nodeId, question, model: desc.model, kind: desc.kind },
    },
    creatorName: author.name,
  });
  const edgeId = crypto.randomUUID();
  db.createCanvasEdge({
    id: edgeId,
    canvasId: src.canvasId,
    sourceId: nodeId,
    targetId: src.nodeId,
    relationship: "derived_from",
    creatorName: author.name,
  });
  const now = Date.now();
  engine.logEvent({
    type: "canvas_publish",
    entity: author.entityId,
    canvasId: src.canvasId,
    nodeId,
    timestamp: now,
  });
  engine.logEvent({
    type: "canvas_edge_created",
    entity: author.entityId,
    canvasId: src.canvasId,
    edgeId,
    sourceId: nodeId,
    targetId: src.nodeId,
    relationship: "derived_from",
    timestamp: now,
  });
  return nodeId;
}

// ─── Command entry point ────────────────────────────────────────────────────

/** Parse `<source> [question…] [model:<id>]` for the look/describe commands. */
export function parseLookArgs(
  tokens: string[],
): { ref: string; question: string; model?: string } | { error: string } {
  const ref = tokens[0];
  if (!ref) return { error: "Missing source: a canvas node id, an asset id, or an http(s) URL." };
  let model: string | undefined;
  const words: string[] = [];
  for (const t of tokens.slice(1)) {
    const m = /^(?:--)?model[:=](.+)$/i.exec(t);
    if (m) model = m[1];
    else words.push(t);
  }
  return { ref, question: words.join(" ").trim(), ...(model ? { model } : {}) };
}

/** Looks per entity: a burst of 6, refilling one every 10 s (lifted under the local profile). */
const newLookLimiter = () =>
  new RateLimiter({ maxTokens: 6, refillRate: 1, refillInterval: 10_000 });
let lookLimiter = newLookLimiter();

/** For tests: forget every entity's look budget. */
export function resetVisionRateLimits(): void {
  lookLimiter = newLookLimiter();
}

/**
 * Load, describe and (for canvas sources) write back — the shared body of
 * `canvas look`, `image describe` and `video describe`. Returns the reply text.
 * Each look costs a model call and may run external tools, so looks are rate
 * limited per entity.
 */
export async function lookAndReply(
  engine: Engine,
  who: { entityId: EntityId; name: string },
  tokens: string[],
  expect?: VisualKind,
): Promise<string> {
  const args = parseLookArgs(tokens);
  if ("error" in args) return args.error;
  if (!lookLimiter.consume(who.entityId)) {
    return "Vision rate limit reached (6 looks, then one every 10 s); try again shortly.";
  }
  let src: VisualSource;
  try {
    src = await loadVisualSource(engine, args.ref, canvasReaderFor(engine, who.entityId));
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  const kind = classifyVisual(src.data, src.mime);
  if (expect && kind && kind !== expect) {
    return `That source is ${kind}, not ${expect}. Use \`canvas look\` for any kind.`;
  }
  const agentModel = engine.db?.getAgentConfig(who.name)?.model ?? undefined;
  let desc: VisualDescription;
  try {
    desc = await describeVisual(engine, src, {
      question: args.question,
      ...(args.model ? { model: args.model } : {}),
      ...(agentModel ? { agentModel } : {}),
      entityId: who.entityId,
    });
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  const nodeId = writeDescriptionToCanvas(engine, src, desc, args.question, who);
  const tail = [
    desc.notes.length ? `notes: ${desc.notes.join(" ")}` : "",
    nodeId ? `written to canvas node ${nodeId} (derived_from ${src.nodeId})` : "",
    `model: ${desc.model}${desc.cached ? " (cached)" : ""}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return `${desc.ok ? "" : "[no vision] "}${desc.text}\n${tail}`;
}

// ─── Request images onto the canvas ────────────────────────────────────────

/** At most this many images from one request are staged on the canvas. */
const STAGE_MAX_IMAGES = 8;

/** Decode a base64 `data:` URL; undefined when it is not one. */
export function decodeDataUrl(url: string): { mime: string; data: Uint8Array } | undefined {
  const m = /^data:([^;,]*)(;base64)?,/i.exec(url);
  if (!m?.[2]) return undefined;
  const data = new Uint8Array(Buffer.from(url.slice(m[0].length), "base64"));
  return { mime: (m[1] || "application/octet-stream").toLowerCase(), data };
}

function partImageUrl(part: unknown): string | undefined {
  if (!part || typeof part !== "object") return undefined;
  const p = part as { type?: unknown; image_url?: unknown };
  if (p.type !== "image_url" && p.type !== "input_image") return undefined;
  const iu = p.image_url;
  if (typeof iu === "string") return iu;
  if (iu && typeof iu === "object" && typeof (iu as { url?: unknown }).url === "string")
    return (iu as { url: string }).url;
  return undefined;
}

/** Who sent a staged request image: the owner of its private inbox canvas. */
export interface RequestImagePrincipal {
  /** Owner id: the caller's entity id, or a stable id derived from its API key. */
  ownerId: string;
  /** Attribution (asset `entity_name`, node creator). */
  name: string;
}

/** Marks staged request images (asset metadata, node data) for retention. */
export const REQUEST_IMAGE_ORIGIN = "request";

/** The fixed inbox canvas name for a principal — never a client-chosen string. */
export function requestInboxName(ownerId: string): string {
  const safe = ownerId.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 80) || "anonymous";
  return `inbox:${safe}`;
}

/**
 * Put a request's images where crew agents can see them. A crew hears a
 * request as a clamped text perception, so images cannot ride along inline:
 * each inline image is stored through the asset pipeline (magic-byte checked,
 * size-capped per image and per request) and published as an image node on
 * the requesting principal's PRIVATE inbox canvas (`scope: "entity"`, owned by
 * the principal — operators and the owner see it on the dashboard, the world
 * does not). The returned lines name each node. Knowing the id is not enough
 * to read it: `grant` names the principals serving the request (the endpoint
 * channel's members and its crew), and each gets an expiring read grant on
 * exactly these nodes (`src/engine/canvas-access.ts`), so they can `canvas look`
 * them for the request's lifetime and nobody else can. Staged images age out with the `assets` / `canvas_nodes`
 * request-image retention policies (`src/engine/retention.ts`). Without a
 * principal (an open-API caller outside the local profile) nothing is stored
 * and each image is labelled as not staged. Remote URLs are not fetched here —
 * the line names the URL, which `canvas look` reads through the SSRF guard if
 * an agent chooses to.
 */
export async function stageRequestImages(
  engine: Engine,
  content: unknown,
  principal: RequestImagePrincipal | undefined,
  grant?: { principals: readonly string[]; ttlMs: number; reason: string },
): Promise<string[]> {
  if (!Array.isArray(content)) return [];
  const stagedNodeIds: string[] = [];
  const urls = content.map(partImageUrl).filter((u): u is string => !!u);
  if (urls.length === 0) return [];
  const lines: string[] = [];
  const db = engine.db;
  const max = visionMaxBytes();
  let budget = max;
  let canvasId: string | undefined;
  const canvasName = principal ? requestInboxName(principal.ownerId) : "";
  for (const [i, url] of urls.slice(0, STAGE_MAX_IMAGES).entries()) {
    const k = i + 1;
    if (/^https?:\/\/\S+$/i.test(url)) {
      lines.push(`[image ${k}: ${url} — read with: canvas look ${url} <question>]`);
      continue;
    }
    if (!principal) {
      lines.push(`[image ${k}: not staged — this caller has no identity to own it]`);
      continue;
    }
    const decoded = decodeDataUrl(url);
    const mime = decoded ? sniffRaster(decoded.data) : null;
    if (!decoded || !mime) {
      lines.push(`[image ${k}: not a PNG, JPEG, GIF or WebP data URL — not staged]`);
      continue;
    }
    if (decoded.data.byteLength > max) {
      lines.push(`[image ${k}: ${decoded.data.byteLength} bytes exceeds ${max} — not staged]`);
      continue;
    }
    if (decoded.data.byteLength > budget) {
      lines.push(`[image ${k}: the request's images exceed ${max} bytes in total — not staged]`);
      continue;
    }
    if (!db || !engine.storage) {
      lines.push(`[image ${k}: no asset storage on this server — not staged]`);
      continue;
    }
    budget -= decoded.data.byteLength;
    if (!canvasId) {
      const existing = db.getCanvasByName(canvasName);
      canvasId = existing?.id ?? crypto.randomUUID();
      if (!existing) {
        db.createCanvas({
          id: canvasId,
          name: canvasName,
          description:
            "Images sent with this caller's model-API requests, staged for the agents answering them.",
          scope: "entity",
          scopeId: principal.ownerId,
          creatorName: principal.name,
        });
      }
    }
    const assetId = crypto.randomUUID();
    const sub = mime.slice("image/".length);
    const ext = sub === "jpeg" ? "jpg" : sub;
    const storageKey = `${assetId}.${ext}`;
    const filename = `request-image-${k}.${ext}`;
    await engine.storage.put(storageKey, decoded.data, mime);
    db.createAsset({
      id: assetId,
      entityName: principal.name,
      filename,
      mimeType: mime,
      size: decoded.data.byteLength,
      storageKey,
      metadata: { origin: REQUEST_IMAGE_ORIGIN, canvas: canvasName, owner: principal.ownerId },
    });
    const maxY = db.getNodesByCanvas(canvasId).reduce((acc, n) => Math.max(acc, n.y + n.height), 0);
    const nodeId = crypto.randomUUID();
    db.createNode({
      id: nodeId,
      canvasId,
      type: "image",
      x: 0,
      y: maxY + 20,
      assetId,
      data: {
        filename,
        mime,
        url: engine.storage.resolve(storageKey),
        title: `Request image ${k}`,
        author: principal.name,
        origin: REQUEST_IMAGE_ORIGIN,
      },
      creatorName: principal.name,
    });
    engine.logEvent({
      type: "canvas_publish",
      entity: principal.ownerId as EntityId,
      canvasId,
      nodeId,
      timestamp: Date.now(),
    });
    stagedNodeIds.push(nodeId);
    lines.push(`[image ${k} → canvas node ${nodeId}; read with: canvas look ${nodeId} <question>]`);
  }
  if (urls.length > STAGE_MAX_IMAGES) {
    lines.push(`[${urls.length - STAGE_MAX_IMAGES} more image(s) not staged]`);
  }
  if (grant && stagedNodeIds.length > 0) {
    engine.canvasGrants.grant({
      nodeIds: stagedNodeIds,
      principals: grant.principals,
      ttlMs: grant.ttlMs,
      reason: grant.reason,
    });
  }
  return lines;
}
