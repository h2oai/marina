// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Ingest-time memory notes: when a long source is written into canonical memory
 * (a conversation, a trajectory, a document, a tool session), optionally write a
 * few concise DERIVED notes next to it, so retrieval can match a compact,
 * self-contained statement instead of only the raw text.
 *
 *   MARINA_MEMORY_INGEST_NOTES=off|on          (default off)
 *   MARINA_MEMORY_INGEST_NOTES_MODEL=<model>   (default `marina/default`; `none` = mechanical)
 *
 * Per call, `ingest_notes: true|false` on a record write overrides the switch
 * (`true` also lifts the minimum source size); importers and adapters call
 * `writeIngestNotes` directly.
 *
 * What a note is: one canonical record (`type: inference`, `tier: reflection`
 * when a model wrote it; `type: observation`, `tier: fact` for a mechanical
 * extract) in the SAME space as its source, written by the SAME actor under the
 * live credential, so the source's owner, grants and ACL govern it. Each note
 * `depends_on` the source records of its chunk (captured sources: `source_ids`),
 * so:
 *   - provenance is a link, and `metadata.derived = "ingest-note"` labels it;
 *   - `forget` of a source erases its notes (the dependency / derivation cascade);
 *   - revising a source stales its notes (excluded from retrieval by default).
 * The source is never altered.
 *
 * Writer: ONE model call per chunk (no decision layer) through an
 * OpenAI-compatible `/chat/completions` — on the server, this Marina's own `/v1`
 * with the internal token, so the passthru hop records the spend. With no model
 * (`none`), or when the model fails, a mechanical extractor runs instead
 * (headed sections, final-state lines, numbered steps, the last line), labelled.
 *
 * Guards:
 *   - grounded: every key token of a note (numbers, dates, identifiers,
 *     capitalised names, quoted strings) must appear in the chunk's source
 *     records, and a third of its content words must; other lines are dropped
 *     (the spirit of the `groundedIn` repair rule);
 *   - exact duplicates are skipped (within the batch and against active records
 *     of the same writer in the space); a source set already noted at the same
 *     versions is not re-noted (`derived_key`);
 *   - spend: `dailyCapRefusal` is checked before every call; at the cap notes are
 *     skipped (labelled `spend_cap`), never the source write;
 *   - failure isolation: `writeIngestNotes` never throws, and a failed note
 *     write never touches the source write (it already committed).
 *
 * Reports carry counts, ids and labels — never note or source content.
 */

import { createHash } from "node:crypto";
import { dailyCapRefusal } from "../engine/spend-ledger";
import type { MemoryRepository } from "../persistence/db-memory-service";
import type { MemoryActor } from "../persistence/db-principals";
import type { MemoryRecord } from "../sdk/memory-types";
import { queryTerms, termMatcher } from "./term-match";

// ─── Settings ───────────────────────────────────────────────────────────────

/** `metadata.derived` on every ingest note. */
export const INGEST_NOTE_KIND = "ingest-note";
/** The single-LLM default: the operator's own model through this Marina's `/v1`. */
export const DEFAULT_INGEST_NOTES_MODEL = "marina/default";
/** A source shorter than this gets no notes from the environment switch alone. */
export const INGEST_NOTES_MIN_BYTES = 2048;
/** Bytes of source text per model call. */
export const INGEST_NOTES_CHUNK_BYTES = 12_000;
/** Total source bytes noted per call of `writeIngestNotes` (the rest is labelled `truncated`). */
export const INGEST_NOTES_MAX_BYTES = 96_000;
/** Notes asked for per chunk. */
export const INGEST_NOTES_PER_CHUNK = 8;
/** Bytes of one note (longer lines are cut). */
export const INGEST_NOTE_MAX_BYTES = 480;
/** Source links per note (the record API's `depends_on` limit). */
export const INGEST_NOTE_MAX_LINKS = 32;
/** Mechanical notes per call. */
export const MECHANICAL_MAX_NOTES = 12;

const MODEL_TYPES = { type: "inference", tier: "reflection" } as const;
const MECHANICAL_TYPES = { type: "observation", tier: "fact" } as const;
const NOTE_TYPES = [MODEL_TYPES.type, MECHANICAL_TYPES.type] as const;

/** `MARINA_MEMORY_INGEST_NOTES` (default off; anything unrecognised is off). */
export function ingestNotesMode(env: NodeJS.ProcessEnv = process.env): "off" | "on" {
  const v = env.MARINA_MEMORY_INGEST_NOTES?.trim().toLowerCase();
  return v === "on" || v === "true" ? "on" : "off";
}

/** `MARINA_MEMORY_INGEST_NOTES_MODEL`; undefined when `none` / `off` (mechanical). */
export function ingestNotesModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env.MARINA_MEMORY_INGEST_NOTES_MODEL?.trim();
  if (!v) return DEFAULT_INGEST_NOTES_MODEL;
  if (v.toLowerCase() === "none" || v.toLowerCase() === "off") return undefined;
  return v;
}

/**
 * Whether a record write of `content` gets notes: an explicit per-call
 * `true`/`false` wins; otherwise the environment switch, for long sources only.
 */
export function ingestNotesWanted(
  perCall: boolean | undefined,
  content: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (perCall !== undefined) return perCall && content.trim().length > 0;
  return ingestNotesMode(env) === "on" && Buffer.byteLength(content) >= INGEST_NOTES_MIN_BYTES;
}

// ─── Writer ─────────────────────────────────────────────────────────────────

/** One chat model that turns a source chunk into note lines. */
export interface NoteWriter {
  /** Label for reports (`model:<id>`). */
  readonly id: string;
  write(prompt: { system: string; user: string }, signal?: AbortSignal): Promise<string>;
}

export interface ChatNoteWriterOptions {
  /** An OpenAI-compatible base URL ending in `/v1`. */
  baseUrl: string;
  model: string;
  /** Bearer key, or a lazy getter (the server's internal token). */
  apiKey?: string | (() => Promise<string> | string);
  timeoutMs?: number;
  maxTokens?: number;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

/**
 * A writer over `/chat/completions`. Spend is recorded where the call leaves
 * Marina: point `baseUrl` at a Marina `/v1` (the server uses its own), whose
 * passthru hop records it against the daily cap. The caller checks the cap.
 */
export function chatNoteWriter(opts: ChatNoteWriterOptions): NoteWriter {
  const doFetch = opts.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  return {
    id: `model:${opts.model}`,
    async write(prompt, signal) {
      const key = typeof opts.apiKey === "function" ? await opts.apiKey() : opts.apiKey;
      const response = await doFetch(`${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({
          model: opts.model,
          temperature: 0,
          max_tokens: opts.maxTokens ?? 1200,
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
        }),
        signal: AbortSignal.any([
          AbortSignal.timeout(opts.timeoutMs ?? 90_000),
          ...(signal ? [signal] : []),
        ]),
      });
      if (!response.ok) throw new Error(`note writer HTTP ${response.status}`);
      const body = (await response.json()) as {
        choices?: { message?: { content?: unknown } }[];
      };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content))
        return content
          .map((part) =>
            part &&
            typeof part === "object" &&
            typeof (part as { text?: unknown }).text === "string"
              ? (part as { text: string }).text
              : "",
          )
          .join("");
      throw new Error("note writer returned no text");
    },
  };
}

async function internalToken(): Promise<string> {
  // Lazy: the agent runtime is heavy, and only a model writer needs it.
  const { getInternalModelToken } = await import("../agent/agent-runtime");
  return getInternalModelToken();
}

/** The server's writer: `MARINA_MEMORY_INGEST_NOTES_MODEL` through this Marina's `/v1`; null = mechanical. */
export function ingestNoteWriter(
  env: NodeJS.ProcessEnv = process.env,
  deps: {
    selfBaseUrl?: string;
    token?: () => Promise<string>;
    fetch?: ChatNoteWriterOptions["fetch"];
  } = {},
): NoteWriter | null {
  const model = ingestNotesModel(env);
  if (!model) return null;
  return chatNoteWriter({
    baseUrl: deps.selfBaseUrl ?? `http://localhost:${Number(env.WS_PORT) || 3300}/v1`,
    model,
    apiKey: deps.token ?? internalToken,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}

export const NOTE_SYSTEM_PROMPT = [
  "You write memory notes from a source text so it can be found and used later.",
  "Write at most {n} notes, one per line, each starting with '- '.",
  "Each note is ONE self-contained fact or procedure summary that makes sense without the source:",
  "who did what, when, which state changed, and the outcome.",
  "Copy names, numbers, dates, prices, URLs and identifiers exactly as they appear in the source.",
  "Use only what the source states. Never guess or add outside knowledge.",
  "No preamble, no headings, no commentary.",
].join("\n");

// ─── Pure helpers ───────────────────────────────────────────────────────────

/** Cut to at most `maxBytes` UTF-8 bytes at a code-point boundary, marking the cut with `…`. */
export function cutBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const b = Buffer.byteLength(ch);
    if (used + b > maxBytes - 3) break;
    out += ch;
    used += b;
  }
  return `${out.trimEnd()}…`;
}

/** One unit of source text and the canonical object it came from. */
export interface NotePart {
  kind: "record" | "source";
  id: string;
  text: string;
}

export interface NoteChunk {
  text: string;
  records: string[];
  sources: string[];
}

/**
 * Pack parts, in order, into chunks of at most `chunkBytes` (line boundaries; a
 * longer line is cut) and at most `maxLinks` distinct sources per chunk, up to
 * `maxBytes` in total. `truncated` says whether text was left out.
 */
export function chunkParts(
  parts: readonly NotePart[],
  opts: { chunkBytes?: number; maxBytes?: number; maxLinks?: number } = {},
): { chunks: NoteChunk[]; truncated: boolean } {
  const chunkBytes = Math.max(256, opts.chunkBytes ?? INGEST_NOTES_CHUNK_BYTES);
  const maxBytes = Math.max(chunkBytes, opts.maxBytes ?? INGEST_NOTES_MAX_BYTES);
  const maxLinks = Math.max(
    1,
    Math.min(INGEST_NOTE_MAX_LINKS, opts.maxLinks ?? INGEST_NOTE_MAX_LINKS),
  );
  const chunks: NoteChunk[] = [];
  let current: { lines: string[]; bytes: number; records: Set<string>; sources: Set<string> } = {
    lines: [],
    bytes: 0,
    records: new Set(),
    sources: new Set(),
  };
  let total = 0;
  let truncated = false;
  const flush = () => {
    if (current.lines.length)
      chunks.push({
        text: current.lines.join("\n"),
        records: [...current.records],
        sources: [...current.sources],
      });
    current = { lines: [], bytes: 0, records: new Set(), sources: new Set() };
  };
  outer: for (const part of parts) {
    const links = current.records.size + current.sources.size;
    const linked = (part.kind === "record" ? current.records : current.sources).has(part.id);
    if (!linked && links >= maxLinks) flush();
    for (const raw of part.text.split("\n")) {
      const line = cutBytes(raw, chunkBytes - 1);
      const size = Buffer.byteLength(line) + 1;
      if (total + size > maxBytes) {
        truncated = true;
        break outer;
      }
      if (current.bytes + size > chunkBytes) flush();
      current.lines.push(line);
      current.bytes += size;
      total += size;
      (part.kind === "record" ? current.records : current.sources).add(part.id);
    }
  }
  flush();
  return { chunks, truncated };
}

/** Note lines out of a model reply: bullets or numbered lines, else non-empty lines. */
export function parseNoteLines(output: string, max = INGEST_NOTES_PER_CHUNK): string[] {
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const bullet = /^(?:[-*•]|\d{1,2}[.)])\s+/;
  const marked = lines.filter((l) => bullet.test(l));
  const picked = (marked.length ? marked : lines)
    .map((l) => l.replace(bullet, "").trim())
    .filter((l) => l.length >= 12 && !/^(?:notes?|here (?:are|is))\b.*:$/i.test(l));
  return picked.slice(0, max).map((l) => cutBytes(l, INGEST_NOTE_MAX_BYTES));
}

const STOP_CAPS = new Set([
  "i",
  "a",
  "an",
  "the",
  "user",
  "users",
  "agent",
  "assistant",
  "source",
  "note",
  "notes",
]);

/**
 * Key tokens a note must not invent: anything with a digit (numbers, dates,
 * prices, ids), capitalised words that do not start a sentence, ALL-CAPS words,
 * quoted strings, and URL / email / path-like tokens.
 */
export function noteKeyTokens(note: string): string[] {
  const keys = new Set<string>();
  for (const m of note.matchAll(/["“']([^"”']{3,80})["”']/g)) keys.add(m[1]!.trim());
  const tokens = [...note.matchAll(/[\p{L}\p{N}][\p{L}\p{N}_@/:#.%$-]*/gu)];
  for (const [i, m] of tokens.entries()) {
    let token = m[0].replace(/[.:,%-]+$/u, "").replace(/['’]s$/u, "");
    if (!token) continue;
    const start = m.index ?? 0;
    const before = note.slice(0, start).trimEnd();
    const sentenceStart = i === 0 || /[.!?:;]$/.test(before) || before.endsWith("—");
    if (/\p{N}/u.test(token)) {
      // A pure number keeps its digits only (`$649.99` → `649.99`).
      if (/^[\d.,/$-]+$/u.test(token)) token = token.replace(/^[^\d]+|[^\d]+$/g, "");
      if (token) keys.add(token);
      continue;
    }
    if (/[@/]|:\/\/|\.[a-z]{2,4}$/i.test(token) && token.length > 3) {
      keys.add(token);
      continue;
    }
    const caps = /^\p{Lu}/u.test(token);
    if (!caps || STOP_CAPS.has(token.toLowerCase())) continue;
    if (/^\p{Lu}{2,}$/u.test(token) || !sentenceStart) keys.add(token);
  }
  return [...keys];
}

/** A source text prepared once for many `noteGrounded` checks. */
export interface GroundingSource {
  squashed: string;
  exact: string;
  matches: (term: string) => boolean;
}

const squash = (text: string) => text.replace(/\s+/g, "").toLowerCase();

export function groundingSource(text: string): GroundingSource {
  return { squashed: squash(text), exact: text.replace(/\s+/g, " "), matches: termMatcher(text) };
}

/**
 * Same presence rule as `groundedIn` (`src/repair/output-repair.ts`): short
 * tokens and numbers must stand alone with their case; longer strings match as
 * substrings up to whitespace and case.
 */
function present(token: string, source: GroundingSource): boolean {
  const trimmed = token.replace(/\s+/g, " ").trim();
  if (trimmed.length > 3 && !/^-?[\d.,]+$/.test(trimmed))
    return source.squashed.includes(squash(trimmed));
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u").test(source.exact);
}

/** Share of a note's content words the source must contain. */
export const NOTE_MIN_TERM_SHARE = 1 / 3;

/** A note is grounded when every key token is in the source and enough of its words are. */
export function noteGrounded(note: string, source: GroundingSource | string): boolean {
  const src = typeof source === "string" ? groundingSource(source) : source;
  for (const token of noteKeyTokens(note)) if (!present(token, src)) return false;
  const terms = queryTerms(note).filter((t) => t.length > 2);
  if (terms.length === 0) return false;
  let hits = 0;
  for (const term of terms) if (src.matches(term)) hits++;
  return hits / terms.length >= NOTE_MIN_TERM_SHARE;
}

/** Normalised form for exact-duplicate detection inside one batch. */
export function normalizeNote(note: string): string {
  return note
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const FINAL_STATE =
  /^\s*(?:outcome|result|status|final(?:\s+\w+)?|state|answer|conclusion|decision|resolution|total|goal|summary)\s*[:=]\s*\S/i;
const STEP = /^\s*\d{1,3}[.)]\s+\S/;
const HEADING = /^\s*#{1,6}\s+(\S.*)$/;

/**
 * The model-free floor: verbatim extracts that read as notes — each heading
 * with its first line, final-state lines (`outcome:`, `status:`, `result:` …),
 * each run of numbered steps as one procedure, and the last line. Grounded by
 * construction (every byte is copied from the source).
 */
export function mechanicalNotes(text: string, max = MECHANICAL_MAX_NOTES): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  const push = (note: string) => {
    const cut = cutBytes(note.replace(/\s+/g, " ").trim(), INGEST_NOTE_MAX_BYTES);
    if (cut.length >= 12) out.push(cut);
  };
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const line = lines[i]!;
    const heading = line.match(HEADING);
    if (heading) {
      const next = lines.slice(i + 1).find((l) => l.trim() && !HEADING.test(l));
      push(next ? `${heading[1]!.trim()}: ${next.trim()}` : heading[1]!);
      continue;
    }
    if (FINAL_STATE.test(line)) {
      push(line);
      continue;
    }
    if (STEP.test(line) && !STEP.test(lines[i - 1] ?? "")) {
      const steps: string[] = [];
      for (let j = i; j < lines.length && STEP.test(lines[j]!); j++) steps.push(lines[j]!.trim());
      let note = "";
      for (const step of steps) {
        const next = note ? `${note} ${step}` : step;
        if (Buffer.byteLength(next) > INGEST_NOTE_MAX_BYTES - 4) {
          note = `${note} …`;
          break;
        }
        note = next;
      }
      push(note);
    }
  }
  const last = [...lines].reverse().find((l) => l.trim().length >= 12);
  if (last && out.length < max) push(last);
  const seen = new Set<string>();
  return out.filter((note) => {
    const key = normalizeNote(note);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Orchestration ──────────────────────────────────────────────────────────

export interface IngestNotesInput {
  /** Source record ids in this space (their current content is the text). */
  records?: readonly string[];
  /** Captured source ids in this space. */
  sources?: readonly string[];
  /**
   * Optional compact VIEW of a source to send the writer instead of its full
   * content (e.g. an importer's de-duplicated page text). Grounding is always
   * checked against the stored source itself.
   */
  views?: Readonly<Record<string, string>>;
  /** undefined ⇒ the environment's writer (`ingestNoteWriter`); null ⇒ mechanical. */
  writer?: NoteWriter | null;
  chunkBytes?: number;
  maxBytes?: number;
  notesPerChunk?: number;
  /** Embedding model to queue index jobs for (the service's provider id). */
  embeddingModel?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface IngestNotesReport {
  outcome: "written" | "none" | "skipped" | "failed";
  /** Why nothing (or less) was written: `spend_cap`, `already_noted`, `no_text`, `<error code>`. */
  reason?: string;
  writer: string;
  /** The model failed (or hit the cap) part-way; the rest was noted mechanically / not at all. */
  fallback?: "writer_failed" | "spend_cap";
  chunks: number;
  calls: number;
  truncated: boolean;
  candidates: number;
  ungrounded: number;
  duplicates: number;
  written: number;
  failedWrites: number;
  ids: string[];
  ms: number;
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceText(body: unknown): string {
  if (typeof body === "string") return body;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    for (const key of ["content", "text", "body"])
      if (typeof b[key] === "string") return b[key] as string;
  }
  return JSON.stringify(body ?? "");
}

function errorCode(error: unknown): string {
  if ((error as { name?: unknown })?.name === "AbortError") return "aborted";
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" ? code : "error";
}

/**
 * Write derived notes for already-committed sources. Never throws: every
 * outcome, including a failure, comes back as a report (counts, ids, labels).
 */
export async function writeIngestNotes(
  repository: MemoryRepository,
  actor: MemoryActor,
  space: string,
  input: IngestNotesInput,
): Promise<IngestNotesReport> {
  const started = performance.now();
  const env = input.env ?? process.env;
  const writer = input.writer === undefined ? ingestNoteWriter(env) : input.writer;
  const report: IngestNotesReport = {
    outcome: "none",
    writer: writer?.id ?? "mechanical",
    chunks: 0,
    calls: 0,
    truncated: false,
    candidates: 0,
    ungrounded: 0,
    duplicates: 0,
    written: 0,
    failedWrites: 0,
    ids: [],
    ms: 0,
  };
  const done = (patch: Partial<IngestNotesReport> = {}) => {
    Object.assign(report, patch);
    report.ms = performance.now() - started;
    if (report.outcome === "none" && report.written > 0) report.outcome = "written";
    return report;
  };
  try {
    const recordIds = [...new Set(input.records ?? [])];
    const sourceIds = [...new Set(input.sources ?? [])];
    // The caller must be able to WRITE here (notes live beside their source) and
    // read the sources back under its live credential: a reader, a revoked grant
    // or a forgotten source ends here, before any model call.
    repository.authorize(actor, space, "memory:write");
    const records = recordIds.length ? repository.readCurrent(actor, space, recordIds) : [];
    const byId = new Map<string, MemoryRecord>(records.map((r) => [r.id, r]));
    const bodies = new Map(
      (sourceIds.length ? repository.derived.sourceBodies(actor, space, sourceIds) : []).map(
        (s) => [s.id, sourceText(s.body)] as const,
      ),
    );
    const full = new Map<string, string>();
    const parts: NotePart[] = [];
    for (const id of recordIds) {
      const record = byId.get(id);
      if (!record) continue;
      full.set(`record:${id}`, record.content);
      parts.push({ kind: "record", id, text: input.views?.[id] ?? record.content });
    }
    for (const id of sourceIds) {
      const text = bodies.get(id);
      if (text === undefined) continue;
      full.set(`source:${id}`, text);
      parts.push({ kind: "source", id, text: input.views?.[id] ?? text });
    }
    if (!parts.length || parts.every((p) => !p.text.trim()))
      return done({ outcome: "skipped", reason: "no_text" });
    // One derivation key per source set at its versions: a replayed write or a
    // re-run importer does not pay for the same notes twice.
    const derivedKey = sha(
      JSON.stringify([
        recordIds.filter((id) => byId.has(id)).map((id) => `${id}@${byId.get(id)!.version}`),
        sourceIds.filter((id) => bodies.has(id)),
        Object.keys(input.views ?? {}).length ? sha(JSON.stringify(input.views)) : null,
      ]),
    ).slice(0, 40);
    if (repository.derived.count(actor, space, derivedKey) > 0)
      return done({ outcome: "skipped", reason: "already_noted" });

    const { chunks, truncated } = chunkParts(parts, {
      ...(input.chunkBytes ? { chunkBytes: input.chunkBytes } : {}),
      ...(input.maxBytes ? { maxBytes: input.maxBytes } : {}),
    });
    report.chunks = chunks.length;
    report.truncated = truncated;
    const perChunk = Math.max(1, Math.min(20, input.notesPerChunk ?? INGEST_NOTES_PER_CHUNK));
    const seen = new Set<string>();
    let modelFailed = false;
    let capped = false;

    for (const [index, chunk] of chunks.entries()) {
      input.signal?.throwIfAborted();
      // Ground against the STORED sources of this chunk, not the view sent.
      const grounding = groundingSource(
        [
          ...chunk.records.map((id) => full.get(`record:${id}`) ?? ""),
          ...chunk.sources.map((id) => full.get(`source:${id}`) ?? ""),
        ].join("\n"),
      );
      let lines: string[] = [];
      let types: { type: "inference" | "observation"; tier: "fact" | "reflection" } =
        MECHANICAL_TYPES;
      let by = "mechanical";
      if (writer && !modelFailed && !capped) {
        const refusal = dailyCapRefusal(env);
        if (refusal) {
          capped = true;
          if (report.calls === 0) return done({ outcome: "skipped", reason: "spend_cap" });
          report.fallback = "spend_cap";
          break;
        }
        try {
          report.calls++;
          const reply = await writer.write(
            {
              system: NOTE_SYSTEM_PROMPT.replace("{n}", String(perChunk)),
              user: `Source (part ${index + 1} of ${chunks.length}):\n${chunk.text}`,
            },
            input.signal,
          );
          lines = parseNoteLines(reply, perChunk);
          types = MODEL_TYPES;
          by = writer.id;
        } catch (error) {
          if (input.signal?.aborted) throw error;
          // The reply or error may quote the source: keep only the label.
          modelFailed = true;
          report.fallback = "writer_failed";
        }
      }
      if (!writer || modelFailed) lines = mechanicalNotes(chunk.text, perChunk);
      report.candidates += lines.length;
      // Shared subject when every record of the chunk agrees on one.
      const subjects = new Set(chunk.records.map((id) => byId.get(id)?.subject ?? null));
      const subject = subjects.size === 1 ? [...subjects][0] : null;
      for (const note of lines) {
        if (!noteGrounded(note, grounding)) {
          report.ungrounded++;
          continue;
        }
        const norm = normalizeNote(note);
        if (seen.has(norm) || repository.derived.contentExists(actor, space, note, NOTE_TYPES)) {
          report.duplicates++;
          continue;
        }
        seen.add(norm);
        try {
          const receipt = repository.remember(
            actor,
            space,
            {
              content: note,
              type: types.type,
              tier: types.tier,
              ...(subject ? { subject } : {}),
              metadata: {
                derived: INGEST_NOTE_KIND,
                derived_key: derivedKey,
                derived_from: [...chunk.records, ...chunk.sources],
                writer: by,
                chunk: index,
              },
              ...(chunk.records.length ? { depends_on: chunk.records } : {}),
              ...(chunk.sources.length ? { source_ids: chunk.sources } : {}),
            },
            `inote:${sha(`${derivedKey}|${note}`).slice(0, 40)}`,
            input.embeddingModel,
          );
          report.written++;
          report.ids.push(receipt.id);
        } catch (error) {
          report.failedWrites++;
          report.reason ??= errorCode(error);
        }
      }
    }
    if (report.written === 0 && report.failedWrites > 0) report.outcome = "failed";
    if (report.written === 0 && report.calls > 0 && report.candidates === 0 && !report.reason)
      report.reason = "no_notes";
    return done();
  } catch (error) {
    return done({ outcome: "failed", reason: errorCode(error) });
  }
}
