// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unified memory context — ONE retrieval surface shared by every consumer.
 *
 * Marina keeps two memory silos: the legacy notes/pools/skills store and the
 * principal-bound durable service (resident spaces, captured sources,
 * assistance proposals). Before this module, only the legacy silo reached the
 * continuation prompt, passthru injection, `/mem/recall`, and the MCP `think`
 * tool. `buildUnifiedContext` pulls both silos into ordered, labeled tiers
 * within a byte budget so the adapter, the `recall` command, REST, MCP, and
 * passthru all render the same evidence with the same provenance labels.
 *
 * Tier order (fixed): skills → [trusted] → [evidence] → [proposal] →
 * [unverified]. Trusted-first is deliberate: a wall of unverified own notes
 * must never crowd out sourced evidence. Durable tiers degrade silently
 * (reported in `degraded`) when the entity has no world account or the
 * service errors — a missing account is a deployment posture, not a failure.
 *
 * This module does not touch notes (last_accessed / recall_count stay with
 * the `recall` command so REST and passthru reads do not mutate memory). Its
 * ONE side effect is generational credit (Phase 3.7): a cross-author
 * reflection-tier note surfacing under `[trusted]` / `[unverified]` pays its
 * author through `creditRecalledReflections` — idempotent per reflection id,
 * never self, never a failure of the read. Legacy tiers are owner-scoped
 * today, so this fires only when a shared reflection reaches those tiers.
 *
 * `[proposal]` items carry INHERITED authority (TMA-NM non-laundering, Phase
 * 3.7): a helper's summary can be no more trustworthy than the least
 * trustworthy note it cites, so the item reports `confidence = min(cited)` and
 * is `verified` only when every cited legacy twin is verified.
 */

import { creditRecalledReflections } from "../agent/standing";
import { getErrorMessage } from "../engine/errors";
import type { MarinaDB, NoteRow, ScoredNoteRow } from "../persistence/database";
import { ftsTerms } from "../persistence/fts";
import type { MemoryAssistanceJob, MemoryAssistancePage } from "../sdk/memory-assistance";
import { MemoryClientError } from "../sdk/memory-client";
import type { MemorySearchResult, MemorySourceSearchResult } from "../sdk/memory-types";
import { findLegacyNotesForRecord } from "./legacy-bridge";
import { residentMemoryOperation } from "./resident-service";
import { expandMemoryRecall } from "./retrieval";

// ─── Types ──────────────────────────────────────────────────────────────────

export const UNIFIED_CONTEXT_SCHEMA = "marina.memory.context.v1" as const;

export type UnifiedTier = "skill" | "trusted" | "evidence" | "proposal" | "unverified";

/** Fixed render order — trusted and durable evidence before own unverified notes. */
export const UNIFIED_TIER_ORDER: readonly UnifiedTier[] = [
  "skill",
  "trusted",
  "evidence",
  "proposal",
  "unverified",
];

/** Labels the agent reads verbatim; other modules import these rather than re-typing. */
export const UNIFIED_TIER_LABELS: Readonly<Record<UnifiedTier, string>> = {
  skill: "[skills]",
  trusted: "[trusted]",
  evidence: "[evidence]",
  proposal: "[proposal]",
  unverified: "[unverified — own notes, verify before relying]",
};

/**
 * Prompt header. Deliberately NOT "Relevant Memory": retrieval is a keyword
 * match, and HISTORY §7/§8 measured that a header asserting relevance made a
 * strong model prefer an unrelated note's value over its own knowledge
 * (simple-qa: warm −9 net items vs bare). Say what the block is and how to use it.
 */
export const UNIFIED_CONTEXT_HEADER =
  "[Memory — retrieved by keyword match; use only items that answer the question, preserve provenance]";

/**
 * Relevance gate. Legacy recall runs FTS in OR mode, so one shared common
 * word ("first", "year", "river") is enough to surface a note about something
 * else; injected into a prompt, such notes measurably mislead (recall
 * pollution). A candidate must share at least `minOverlap(terms)` distinct
 * query terms with the content: 1 for queries of ≤ 2 content terms, else
 * max(2, ⌈25 % of terms⌉). Matching is case-insensitive on word prefixes so
 * porter-stemmed forms ("deploys" / "deploy") still count. Graph-expanded
 * neighbours are NOT gated — only the seeds that pull them in.
 */
export const MIN_OVERLAP_SHARE = 0.25;

export function minOverlap(termCount: number): number {
  if (termCount <= 2) return Math.min(1, termCount);
  return Math.max(2, Math.ceil(termCount * MIN_OVERLAP_SHARE));
}

const stem = (word: string) =>
  word.length > 5 ? word.slice(0, Math.max(4, word.length - 2)) : word;

export function queryTerms(query: string): string[] {
  return [...new Set(ftsTerms(query).map((t) => t.toLowerCase()))];
}

/**
 * Distinctiveness: which query terms are RARE in the entity's own fact-like
 * notes. A note that shares only common words with the question ("first",
 * "university", "year") is almost never about the question; HISTORY §8
 * measured that the plain overlap gate left such notes in the prompt (78 %
 * hit rate on simple-qa, still a net loss). A term is distinctive when it
 * appears in ≤ `DISTINCT_TERM_MAX_SHARE` of the entity's notes (and at most
 * `DISTINCT_TERM_MAX_NOTES` when the corpus is small). One indexed LIKE count
 * per query term, once per context build — never per candidate.
 */
export const DISTINCT_TERM_MAX_SHARE = 0.2;
export const DISTINCT_TERM_MAX_NOTES = 3;

export function distinctiveTerms(
  db: MarinaDB,
  entityName: string,
  terms: readonly string[],
): Set<string> {
  const out = new Set<string>();
  if (terms.length === 0) return out;
  try {
    const raw = db.memoryRepository().raw;
    const total = (
      raw
        .query(
          `SELECT count(*) AS n FROM notes WHERE entity_name=? COLLATE NOCASE AND pool_id IS NULL
           AND tier IN ('fact','reflection','skill')`,
        )
        .get(entityName) as { n: number }
    ).n;
    if (total === 0) return new Set(terms);
    const cap = Math.max(DISTINCT_TERM_MAX_NOTES, Math.floor(total * DISTINCT_TERM_MAX_SHARE));
    const count = raw.query(
      `SELECT count(*) AS n FROM notes WHERE entity_name=? COLLATE NOCASE AND pool_id IS NULL
       AND tier IN ('fact','reflection','skill') AND lower(content) LIKE ? ESCAPE '\\'`,
    );
    for (const term of terms) {
      const pattern = `%${term.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      const n = (count.get(entityName, pattern) as { n: number }).n;
      if (n <= cap) out.add(term);
    }
  } catch {
    // Distinctiveness is an optimisation over the overlap gate — on any
    // failure every term counts as distinctive (the pre-§8 behaviour).
    return new Set(terms);
  }
  return out;
}

export function relevantToQuery(
  content: string,
  query: string | readonly string[],
  distinctive?: ReadonlySet<string>,
): boolean {
  const terms = typeof query === "string" ? queryTerms(query) : query;
  if (terms.length === 0) return true;
  const words = new Set(
    content
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter(Boolean),
  );
  const prefixes = [...words].map(stem);
  const matches = (term: string) => {
    const st = stem(term);
    return words.has(term) || prefixes.some((w) => w.startsWith(st) || st.startsWith(w));
  };
  let overlap = 0;
  let distinct = distinctive === undefined || distinctive.size === 0;
  for (const term of terms) {
    if (!matches(term)) continue;
    overlap++;
    if (distinctive?.has(term)) distinct = true;
  }
  return overlap >= minOverlap(terms.length) && distinct;
}

/** Durable-only tiers — `scope: "evidence"` renders just these. */
const DURABLE_TIERS: readonly UnifiedTier[] = ["evidence", "proposal"];
const LEGACY_TIERS: readonly UnifiedTier[] = ["skill", "trusted", "unverified"];

export interface UnifiedContextItem {
  tier: UnifiedTier;
  /** Legacy note id (`"12"`), durable record/source id, or assistance job id. */
  id: string;
  /** Rendered content — already truncated (with a visible marker) when `truncated`. */
  content: string;
  /** Human-readable origin: `#12 imp=6 verified`, `record r_1 v1`, `source s_1 sha256:…`. */
  provenance: string;
  /** UTF-8 bytes of `content` after truncation — what counted against the budget. */
  bytes: number;
  /** Ranking key within the tier (score desc, then id asc). */
  score: number;
  truncated?: boolean;
  /** Structured origin details for machine consumers (record version, hash, citations…). */
  meta?: Record<string, unknown>;
}

export interface UnifiedTierResult {
  tier: UnifiedTier;
  label: string;
  items: UnifiedContextItem[];
  /** Items that matched but were dropped for budget — the header still renders. */
  omitted: number;
}

export interface UnifiedDegraded {
  tier: UnifiedTier;
  code: string;
  message: string;
}

export interface UnifiedContextResult {
  schema: typeof UNIFIED_CONTEXT_SCHEMA;
  entity: string;
  query: string;
  scope: UnifiedScope;
  budgetBytes: number;
  usedBytes: number;
  /** True when any item was cut or dropped for budget. Headers are never dropped silently. */
  truncated: boolean;
  /** All five tiers, in render order; empty tiers have `items: []`. */
  tiers: UnifiedTierResult[];
  degraded: UnifiedDegraded[];
}

export type UnifiedScope = "all" | "evidence" | "legacy";

export interface UnifiedContextOptions {
  /** Total content-byte budget across tiers. Default 2048 (prompt use). */
  budgetBytes?: number;
  /** Per-item cap before the global budget applies. Default 600. */
  itemMaxBytes?: number;
  /** `all` (default) · `evidence` (durable tiers only) · `legacy` (notes only). */
  scope?: UnifiedScope;
  /** Max items fetched per tier before budgeting. */
  perTier?: Partial<Record<UnifiedTier, number>>;
  /** Legacy recall weights (the `recall` command passes its intent-detected weights). */
  weights?: { weightImportance: number; weightRecency: number; weightRelevance: number };
  /** Restrict legacy note tiers to one note_type (mirrors `recall … type <t>`). */
  noteType?: string;
  /** Pay authors of cross-author reflection hits in the legacy tiers (default true). */
  creditReflections?: boolean;
}

export const DEFAULT_UNIFIED_BUDGET_BYTES = 2048;
const DEFAULT_ITEM_MAX_BYTES = 600;
/** Below this many remaining bytes we drop an item rather than emit a useless stub. */
const MIN_ITEM_BYTES = 48;
const DEFAULT_PER_TIER: Readonly<Record<UnifiedTier, number>> = {
  skill: 2,
  trusted: 5,
  evidence: 4,
  proposal: 3,
  unverified: 5,
};
/** How many answered jobs to scan (most recent first) before capping proposals. */
const PROPOSAL_SCAN_LIMIT = 50;

// ─── Byte helpers ───────────────────────────────────────────────────────────

const encoder = new TextEncoder();

export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/**
 * Cut `text` to at most `maxBytes` UTF-8 bytes at a code-point boundary and
 * append a visible marker (` […+N chars]`) so a reader always knows content
 * was elided. Returns the input unchanged when it already fits.
 */
export function truncateToBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const total = text.length;
  // Upper-bound marker width (the real remainder is never longer than `total`).
  const limit = Math.max(0, maxBytes - byteLength(` […+${total} chars]`));
  let out = "";
  let used = 0;
  for (const ch of text) {
    const b = byteLength(ch);
    if (used + b > limit) break;
    out += ch;
    used += b;
  }
  out = out.trimEnd();
  return `${out} […+${total - out.length} chars]`;
}

// ─── Item builders ──────────────────────────────────────────────────────────

function ageDays(createdAt: number): string {
  return `${Math.max(0, Math.floor((Date.now() - createdAt) / 86_400_000))}d`;
}

function noteItem(tier: UnifiedTier, note: ScoredNoteRow): UnifiedContextItem {
  const bits = [`#${note.id}`, `imp=${note.importance}`];
  if (tier === "trusted") {
    bits.push(
      note.verification_status === "verified"
        ? "verified"
        : `confidence=${(note.confidence ?? 0.5).toFixed(2)} sourced`,
    );
  }
  return {
    tier,
    id: String(note.id),
    content: note.content,
    provenance: bits.join(" "),
    bytes: 0,
    score: note.score,
    meta: {
      noteType: note.note_type,
      noteTier: note.tier,
      author: note.entity_name,
      importance: note.importance,
      verification: note.verification_status ?? "unverified",
      confidence: note.confidence ?? 0.5,
      age: ageDays(note.created_at),
    },
  };
}

/** Authority a summary inherits from its inputs — the lowest, never the highest. */
export interface InheritedAuthority {
  /** min(confidence) over the inputs; null when nothing citable was found. */
  confidence: number | null;
  /** `verified` only when every input is verified; otherwise `unverified`. */
  verification: "verified" | "unverified";
  /** How many inputs were considered. */
  inputs: number;
}

/**
 * TMA-NM non-laundering rule: summarising N notes must not produce a note
 * more authoritative than the weakest of them. Shared by `reflect adopt`,
 * the template reflection and the `[proposal]` tier.
 */
export function inheritedAuthority(
  inputs: readonly Pick<NoteRow, "confidence" | "verification_status">[],
): InheritedAuthority {
  if (inputs.length === 0) return { confidence: null, verification: "unverified", inputs: 0 };
  let confidence = 1;
  let allVerified = true;
  for (const input of inputs) {
    confidence = Math.min(confidence, input.confidence ?? 0.5);
    if (input.verification_status !== "verified") allVerified = false;
  }
  return {
    confidence,
    verification: allVerified ? "verified" : "unverified",
    inputs: inputs.length,
  };
}

/** Current version, valid now: not superseded by a resolution and not a historical read. */
export function servableRecord(
  record: { freshness?: string; valid_time?: { from: number | null; until: number | null } | null },
  now = Date.now(),
): boolean {
  if (record.freshness === "historical") return false;
  const until = record.valid_time?.until;
  return until === null || until === undefined || until > now;
}

/**
 * Which of `sourceIds` may still be served as evidence: a source with no
 * deriving record (a raw capture) always may; one referenced only by records
 * that fail `servableRecord` — a retired twin (`valid_time.until` closed by a
 * tombstone `revise` or a `resolve` loser) or a superseded / non-active record
 * — may not, or the retired claim's captured excerpt resurfaces as
 * `[evidence]` after the record itself was filtered. Mirrors the durable
 * `search` visibility predicate (active, current note not superseded) plus
 * the validity interval `servableRecord` checks. On a query failure every id
 * is kept: this is a guard on already-authorized hits, not an access check.
 */
export function servableSourceIds(
  db: MarinaDB,
  spaceId: string | undefined,
  sourceIds: readonly string[],
  now = Date.now(),
): Set<string> {
  const out = new Set(sourceIds);
  if (!spaceId || sourceIds.length === 0) return out;
  try {
    const rows = db
      .memoryRepository()
      .raw.query(
        `SELECT d.source_id AS source_id,
                MAX(CASE WHEN r.status = 'active'
                          AND COALESCE(n.verification_status, '') != 'superseded'
                          AND (r.valid_until IS NULL OR r.valid_until > ?) THEN 1 ELSE 0 END) AS servable
           FROM memory_derivations d
           JOIN memory_records r ON r.id = d.record_id AND r.space_id = ?
           LEFT JOIN notes n ON n.id = r.current_note_id
          WHERE d.source_id IN (SELECT value FROM json_each(?))
          GROUP BY d.source_id`,
      )
      .all(now, spaceId, JSON.stringify(sourceIds)) as { source_id: string; servable: number }[];
    for (const row of rows) if (!row.servable) out.delete(row.source_id);
  } catch {
    // Keep the hits — see the doc comment.
  }
  return out;
}

function recordItem(record: MemorySearchResult["results"][number]): UnifiedContextItem {
  const freshness =
    record.freshness && record.freshness !== "current" ? ` ${record.freshness}` : "";
  return {
    tier: "evidence",
    id: record.id,
    content: record.content,
    provenance: `record ${record.id} v${record.version}${freshness}`,
    bytes: 0,
    score: record.score,
    meta: {
      kind: "record",
      space_id: record.space_id,
      version: record.version,
      type: record.type,
      tier: record.tier,
      source_ids: record.source_ids,
      freshness: record.freshness ?? "current",
    },
  };
}

function sourceItem(
  spaceId: string | undefined,
  hit: MemorySourceSearchResult["results"][number],
): UnifiedContextItem {
  return {
    tier: "evidence",
    id: hit.id,
    content: hit.excerpt,
    provenance: `source ${hit.id} sha256:${hit.content_hash.slice(0, 12)} seq=${hit.seq} excerpt`,
    bytes: 0,
    score: hit.score ?? 0,
    meta: {
      kind: "source",
      space_id: spaceId,
      content_hash: hit.content_hash,
      seq: hit.seq,
      session_id: hit.session_id,
      // source_search returns an excerpt, not offsets — read the full text via source_range.
      range: "excerpt",
    },
  };
}

/** Legacy twins (owned by `entityName`) of the records a proposal cites — its citable inputs. */
function citedLegacyInputs(db: MarinaDB, entityName: string, job: MemoryAssistanceJob): NoteRow[] {
  const inputs: NoteRow[] = [];
  const seen = new Set<string>();
  for (const citation of job.result?.status === "answered" ? job.result.citations : []) {
    if (citation.kind !== "record" || citation.space_id !== job.space_id) continue;
    if (seen.has(citation.id)) continue;
    seen.add(citation.id);
    inputs.push(...findLegacyNotesForRecord(db, entityName, citation.id, { currentOnly: true }));
  }
  return inputs;
}

function proposalItem(
  job: MemoryAssistanceJob,
  inherited: InheritedAuthority,
): UnifiedContextItem | null {
  const result = job.result;
  if (result?.status !== "answered") return null;
  const answer = typeof result.answer === "string" ? result.answer : JSON.stringify(result.answer);
  const citations = result.citations.length;
  // Provenance stays byte-identical to Phase 1 (surfaces assert it verbatim);
  // the inherited authority rides in `meta` and is rendered as a marker after
  // the bracket by `renderUnifiedContext`.
  return {
    tier: "proposal",
    id: job.id,
    content: answer,
    provenance: `proposal ${job.id} ${job.role} ${citations} citation${citations === 1 ? "" : "s"}`,
    bytes: 0,
    score: job.created_at,
    meta: {
      kind: "assistance",
      role: job.role,
      state: job.state,
      task: job.task,
      worker_id: job.worker_id,
      result_record_id: job.result_record_id,
      citations: result.citations,
      created_at: job.created_at,
      // Inherited, not asserted: the summary is only as trustworthy as its inputs.
      inherited,
    },
  };
}

/** `(unverified · inherited confidence 0.30)` for a proposal — the non-laundering marker the agent reads. */
function authorityMarker(item: UnifiedContextItem): string {
  const inherited = item.meta?.inherited as InheritedAuthority | undefined;
  if (item.tier !== "proposal" || !inherited) return "";
  const confidence =
    inherited.confidence === null
      ? "no citable inputs"
      : `inherited confidence ${inherited.confidence.toFixed(2)}`;
  return ` (${inherited.verification} · ${confidence})`;
}

function sortItems(items: UnifiedContextItem[]): UnifiedContextItem[] {
  return items.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ─── Fetchers ───────────────────────────────────────────────────────────────

interface Fetched {
  items: Partial<Record<UnifiedTier, UnifiedContextItem[]>>;
  degraded: UnifiedDegraded[];
}

function errorCode(error: unknown): { code: string; message: string } {
  if (error instanceof MemoryClientError) return { code: error.code, message: error.message };
  return { code: "error", message: getErrorMessage(error) };
}

function fetchLegacy(
  db: MarinaDB,
  entityName: string,
  query: string,
  opts: Required<Pick<UnifiedContextOptions, "weights">> & Pick<UnifiedContextOptions, "noteType">,
): Fetched {
  const out: Fetched = { items: {}, degraded: [] };
  const terms = queryTerms(query);
  const distinctive = distinctiveTerms(db, entityName, terms);
  const relevant = (n: { content: string }) => relevantToQuery(n.content, terms, distinctive);
  try {
    const skills = db
      .recallNotesWithType(entityName, query, "skill", {
        weightImportance: 0.4,
        weightRecency: 0.2,
        weightRelevance: 0.4,
      })
      .filter(relevant);
    out.items.skill = skills.map((n) => noteItem("skill", n));
  } catch (error) {
    out.degraded.push({ tier: "skill", ...errorCode(error) });
  }
  try {
    const seeds = (
      opts.noteType
        ? db.recallNotesWithType(entityName, query, opts.noteType, opts.weights)
        : db.recallNotes(entityName, query, opts.weights)
    ).filter(relevant);
    const trusted = expandMemoryRecall(db, seeds, entityName, {
      noteType: opts.noteType,
      trusted: true,
    });
    const ordinary = expandMemoryRecall(db, seeds, entityName, { noteType: opts.noteType });
    out.items.trusted = trusted.map((n) => noteItem("trusted", n));
    out.items.unverified = ordinary.map((n) => noteItem("unverified", n));
  } catch (error) {
    out.degraded.push({ tier: "trusted", ...errorCode(error) });
    out.degraded.push({ tier: "unverified", ...errorCode(error) });
  }
  return out;
}

async function fetchDurable(
  db: MarinaDB,
  entityName: string,
  query: string,
  limits: { records: number; sources: number; proposals: number },
): Promise<Fetched> {
  const out: Fetched = { items: { evidence: [], proposal: [] }, degraded: [] };
  let spaceId: string | undefined;

  // Assistance jobs first: their request source (task text) and result record
  // (raw completion JSON) live in the same space and match lexically, but they
  // ARE the proposal — surfacing them under [evidence] would double-count the
  // helper's answer as independent evidence. Collect their ids to exclude.
  let jobs: MemoryAssistanceJob[] = [];
  const jobArtifacts = new Set<string>();
  let jobsError: UnifiedDegraded | undefined;
  try {
    const page = await residentMemoryOperation(db, entityName, {
      operation: "assist_jobs",
      input: { limit: PROPOSAL_SCAN_LIMIT },
    });
    jobs = (page.result as MemoryAssistancePage).jobs;
    for (const job of jobs) {
      jobArtifacts.add(job.input_source_id);
      if (job.result_record_id) jobArtifacts.add(job.result_record_id);
    }
  } catch (error) {
    const { code, message } = errorCode(error);
    if (code === "world_identity_required") {
      // No durable account: every durable tier is unavailable for the same reason.
      out.degraded.push({ tier: "evidence", code, message }, { tier: "proposal", code, message });
      return out;
    }
    jobsError = { tier: "proposal", code, message };
  }

  try {
    const search = await residentMemoryOperation(db, entityName, {
      operation: "search",
      input: { query, limit: limits.records + jobArtifacts.size },
    });
    spaceId = search.space_id;
    const result = search.result as MemorySearchResult;
    const now = Date.now();
    const terms = queryTerms(query);
    const distinctive = distinctiveTerms(db, entityName, terms);
    out.items.evidence!.push(
      ...result.results
        .filter((record) => !jobArtifacts.has(record.id))
        // Lexical `search` is not validity-filtered: a record whose interval a
        // `resolve` closed (a superseded loser) or a historical version is
        // still reachable by keyword. Never serve it as evidence.
        .filter((record) => servableRecord(record, now))
        .filter((record) => relevantToQuery(record.content, terms, distinctive))
        .slice(0, limits.records)
        .map(recordItem),
    );
  } catch (error) {
    const { code, message } = errorCode(error);
    out.degraded.push({ tier: "evidence", code, message });
    if (code === "world_identity_required") {
      out.degraded.push({ tier: "proposal", code, message });
      return out;
    }
  }

  try {
    const sources = await residentMemoryOperation(db, entityName, {
      operation: "source_search",
      input: { query, limit: limits.sources + jobArtifacts.size },
    });
    spaceId ??= sources.space_id;
    const result = sources.result as MemorySourceSearchResult;
    const hits = result.results.filter(
      (hit) => !jobArtifacts.has(hit.id) && !hit.session_id?.startsWith("assistance:"),
    );
    // `source_search` is not validity-filtered either: a retired twin's
    // captured excerpt is still a lexical hit after its record was dropped
    // above. Serve a source only while some deriving record is servable.
    const servable = servableSourceIds(
      db,
      spaceId,
      hits.map((hit) => hit.id),
      Date.now(),
    );
    out.items.evidence!.push(
      ...hits
        .filter((hit) => servable.has(hit.id))
        .slice(0, limits.sources)
        .map((hit) => sourceItem(spaceId, hit)),
    );
  } catch (error) {
    out.degraded.push({ tier: "evidence", ...errorCode(error) });
  }

  if (jobsError) {
    out.degraded.push(jobsError);
    return out;
  }
  {
    const answered = jobs
      .filter((job) => job.state === "answered" && (!spaceId || job.space_id === spaceId))
      .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1));
    for (const job of answered) {
      if (out.items.proposal!.length >= limits.proposals) break;
      try {
        // The list projection omits task/result; `assist_get` returns the
        // proposal and refuses (assistance_stale) when its evidence moved on.
        const full = await residentMemoryOperation(db, entityName, {
          operation: "assist_get",
          id: job.id,
        });
        const fullJob = full.result as MemoryAssistanceJob;
        const item = proposalItem(
          fullJob,
          inheritedAuthority(citedLegacyInputs(db, entityName, fullJob)),
        );
        if (item) out.items.proposal!.push(item);
      } catch (error) {
        const { code } = errorCode(error);
        if (code !== "assistance_stale" && code !== "assistance_not_found")
          out.degraded.push({ tier: "proposal", ...errorCode(error) });
      }
    }
  }
  return out;
}

// ─── Budgeting ──────────────────────────────────────────────────────────────

function applyBudget(
  fetched: Partial<Record<UnifiedTier, UnifiedContextItem[]>>,
  perTier: Record<UnifiedTier, number>,
  budgetBytes: number,
  itemMaxBytes: number,
): { tiers: UnifiedTierResult[]; usedBytes: number; truncated: boolean } {
  let used = 0;
  let truncated = false;
  const seenNotes = new Set<string>();
  const tiers: UnifiedTierResult[] = [];
  for (const tier of UNIFIED_TIER_ORDER) {
    const candidates = sortItems([...(fetched[tier] ?? [])]);
    const result: UnifiedTierResult = {
      tier,
      label: UNIFIED_TIER_LABELS[tier],
      items: [],
      omitted: 0,
    };
    let admitted = 0;
    for (const item of candidates) {
      // Legacy tiers share one id space — a note shown as a skill or trusted
      // hit must not reappear under [unverified].
      if (LEGACY_TIERS.includes(tier)) {
        if (seenNotes.has(item.id)) continue;
      }
      if (admitted >= perTier[tier]) break;
      admitted++;
      if (LEGACY_TIERS.includes(tier)) seenNotes.add(item.id);

      let content = item.content;
      let cut = false;
      if (byteLength(content) > itemMaxBytes) {
        content = truncateToBytes(content, itemMaxBytes);
        cut = true;
      }
      const remaining = budgetBytes - used;
      const size = byteLength(content);
      if (size > remaining) {
        if (remaining < MIN_ITEM_BYTES) {
          result.omitted++;
          truncated = true;
          continue;
        }
        content = truncateToBytes(content, remaining);
        cut = true;
      }
      const bytes = byteLength(content);
      used += bytes;
      if (cut) truncated = true;
      result.items.push({ ...item, content, bytes, ...(cut ? { truncated: true } : {}) });
    }
    tiers.push(result);
  }
  return { tiers, usedBytes: used, truncated };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Build the unified, budgeted memory context for `entityName` and `query`.
 * Legacy tiers are read straight from the DB (owner-scoped, pool-less, no
 * service-memory rows); durable tiers go through `residentMemoryOperation`
 * so identity binding is the server's, never the caller's claim.
 */
export async function buildUnifiedContext(
  db: MarinaDB,
  entityName: string,
  query: string,
  opts: UnifiedContextOptions = {},
): Promise<UnifiedContextResult> {
  const scope = opts.scope ?? "all";
  const budgetBytes = Math.max(0, Math.floor(opts.budgetBytes ?? DEFAULT_UNIFIED_BUDGET_BYTES));
  const itemMaxBytes = Math.max(MIN_ITEM_BYTES, opts.itemMaxBytes ?? DEFAULT_ITEM_MAX_BYTES);
  const perTier = { ...DEFAULT_PER_TIER, ...opts.perTier } as Record<UnifiedTier, number>;
  const weights = opts.weights ?? {
    weightImportance: 0.33,
    weightRecency: 0.33,
    weightRelevance: 0.34,
  };
  const trimmed = query.trim();

  const fetched: Partial<Record<UnifiedTier, UnifiedContextItem[]>> = {};
  const degraded: UnifiedDegraded[] = [];
  if (trimmed) {
    if (scope !== "evidence") {
      const legacy = fetchLegacy(db, entityName, trimmed, { weights, noteType: opts.noteType });
      Object.assign(fetched, legacy.items);
      degraded.push(...legacy.degraded);
    }
    if (scope !== "legacy") {
      const durable = await fetchDurable(db, entityName, trimmed, {
        records: perTier.evidence,
        sources: Math.max(1, Math.ceil(perTier.evidence / 2)),
        proposals: perTier.proposal,
      });
      Object.assign(fetched, durable.items);
      degraded.push(...durable.degraded);
    }
  }

  const budgeted = applyBudget(fetched, perTier, budgetBytes, itemMaxBytes);
  const result: UnifiedContextResult = {
    schema: UNIFIED_CONTEXT_SCHEMA,
    entity: entityName,
    query: trimmed,
    scope,
    budgetBytes,
    usedBytes: budgeted.usedBytes,
    truncated: budgeted.truncated,
    tiers: budgeted.tiers,
    degraded,
  };
  if (opts.creditReflections !== false) creditUnifiedReflections(db, result);
  return result;
}

/** Legacy tiers whose hits are recalled wisdom (skills are worked examples, not lessons). */
const CREDITED_TIERS: readonly UnifiedTier[] = ["trusted", "unverified"];

/**
 * Generational credit for the rendered `[trusted]` / `[unverified]` items:
 * every reflection-tier note by ANOTHER author pays that author (durable key
 * via `users.id`). Idempotent per reflection id; self-hits and other tiers
 * are skipped; a failed ledger write never fails the read. Returns the number
 * of cross-author reflections considered.
 */
export function creditUnifiedReflections(db: MarinaDB, result: UnifiedContextResult): number {
  const hits: { id: number; tier: string; entity_name: string }[] = [];
  for (const tier of result.tiers) {
    if (!CREDITED_TIERS.includes(tier.tier)) continue;
    for (const item of tier.items) {
      const author = item.meta?.author;
      const noteTier = item.meta?.noteTier;
      const id = Number(item.id);
      if (typeof author !== "string" || author === result.entity) continue;
      if (noteTier !== "reflection" || !Number.isInteger(id)) continue;
      hits.push({ id, tier: "reflection", entity_name: author });
    }
  }
  if (hits.length === 0) return 0;
  try {
    creditRecalledReflections(db, result.entity, hits, (name) => db.durableKeyForName(name));
  } catch {
    // Standing is a side ledger; reads never fail on it.
  }
  return hits.length;
}

/** Tiers that carry something to show (items or budget-omitted matches). */
export function nonEmptyTiers(result: UnifiedContextResult): UnifiedTierResult[] {
  return result.tiers.filter((tier) => tier.items.length > 0 || tier.omitted > 0);
}

/** Legacy note ids surfaced by the result (skill / trusted / unverified tiers). */
export function unifiedLegacyNoteIds(result: UnifiedContextResult): number[] {
  const ids: number[] = [];
  for (const tier of result.tiers) {
    if (!LEGACY_TIERS.includes(tier.tier)) continue;
    for (const item of tier.items) {
      const id = Number(item.id);
      if (Number.isInteger(id)) ids.push(id);
    }
  }
  return ids;
}

export function isDurableTier(tier: UnifiedTier): boolean {
  return DURABLE_TIERS.includes(tier);
}

/**
 * Render a result as prompt text. Skills render as `<example>` blocks (the
 * few-shot convention the adapter already used); every other tier is a
 * labeled bullet list of `- [provenance] content`. Tiers with nothing to show
 * are omitted, but a tier whose matches were all dropped for budget keeps its
 * header with an explicit `(+N omitted for budget)` line — never silent.
 */
/**
 * Render the tiers as prompt text. `degraded` controls the diagnostics for
 * tiers that could not be fetched: `true` (default) appends a full `[degraded]`
 * block, one line per tier and code — for surfaces a person or an agent reads
 * deliberately (`recall … all`, REST, MCP); `"compact"` appends ONE line
 * grouping tiers by code — for model-facing paths (continuation prompt §4, the
 * benchmark harness) where the agent still needs to know a tier is missing but
 * the full block was ~25 % of the injected bytes on a one-fact corpus
 * (HISTORY §7); `false` omits it.
 */
export function renderUnifiedContext(
  result: UnifiedContextResult,
  opts: { header?: boolean; degraded?: boolean | "compact" } = {},
): string {
  const blocks: string[] = [];
  for (const tier of nonEmptyTiers(result)) {
    const lines: string[] = [tier.label];
    if (tier.tier === "skill") {
      for (const item of tier.items)
        lines.push(
          `<example skill="${item.provenance.split(" ")[0]}" imp="${item.meta?.importance ?? ""}">\n${item.content}\n</example>`,
        );
    } else {
      for (const item of tier.items)
        lines.push(`- [${item.provenance}]${authorityMarker(item)} ${item.content}`);
    }
    if (tier.omitted > 0) lines.push(`  (+${tier.omitted} more omitted for budget)`);
    blocks.push(lines.join("\n"));
  }
  if (opts.degraded === "compact" && result.degraded.length > 0) {
    const byCode = new Map<string, Set<string>>();
    for (const d of result.degraded) {
      const tiers = byCode.get(d.code) ?? new Set<string>();
      tiers.add(d.tier);
      byCode.set(d.code, tiers);
    }
    blocks.push(
      `[degraded] ${[...byCode.entries()]
        .map(([code, tiers]) => `${[...tiers].join(", ")}: ${code}`)
        .join(" · ")}`,
    );
  } else if (opts.degraded !== false && result.degraded.length > 0) {
    const seen = new Set<string>();
    const lines = ["[degraded]"];
    for (const d of result.degraded) {
      const key = `${d.tier}:${d.code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`- ${d.tier}: ${d.code} — ${d.message}`);
    }
    blocks.push(lines.join("\n"));
  }
  const body = blocks.join("\n\n");
  if (opts.header === false) return body;
  return body ? `${UNIFIED_CONTEXT_HEADER}\n${body}` : "";
}

/** Structural guard for payloads that crossed a transport (command data, MCP, REST). */
export function isUnifiedContextResult(value: unknown): value is UnifiedContextResult {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<UnifiedContextResult>;
  return (
    v.schema === UNIFIED_CONTEXT_SCHEMA &&
    typeof v.query === "string" &&
    typeof v.entity === "string" &&
    typeof v.budgetBytes === "number" &&
    typeof v.truncated === "boolean" &&
    Array.isArray(v.tiers) &&
    v.tiers.every(
      (tier) =>
        tier &&
        typeof tier.tier === "string" &&
        typeof tier.label === "string" &&
        Array.isArray(tier.items) &&
        tier.items.every(
          (item) =>
            item &&
            typeof item.id === "string" &&
            typeof item.content === "string" &&
            typeof item.provenance === "string",
        ),
    ) &&
    Array.isArray(v.degraded)
  );
}
