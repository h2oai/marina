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
 * This module never writes. Touching recalled notes / crediting reflection
 * authors stays with the `recall` command so REST and passthru reads stay
 * side-effect free.
 */

import { getErrorMessage } from "../engine/errors";
import type { MarinaDB, ScoredNoteRow } from "../persistence/database";
import type { MemoryAssistanceJob, MemoryAssistancePage } from "../sdk/memory-assistance";
import { MemoryClientError } from "../sdk/memory-client";
import type { MemorySearchResult, MemorySourceSearchResult } from "../sdk/memory-types";
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

export const UNIFIED_CONTEXT_HEADER = "[Relevant Memory — evidence, preserve provenance]";

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
      importance: note.importance,
      verification: note.verification_status ?? "unverified",
      confidence: note.confidence ?? 0.5,
      age: ageDays(note.created_at),
    },
  };
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

function proposalItem(job: MemoryAssistanceJob): UnifiedContextItem | null {
  const result = job.result;
  if (result?.status !== "answered") return null;
  const answer = typeof result.answer === "string" ? result.answer : JSON.stringify(result.answer);
  const citations = result.citations.length;
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
    },
  };
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
  try {
    const skills = db.recallNotesWithType(entityName, query, "skill", {
      weightImportance: 0.4,
      weightRecency: 0.2,
      weightRelevance: 0.4,
    });
    out.items.skill = skills.map((n) => noteItem("skill", n));
  } catch (error) {
    out.degraded.push({ tier: "skill", ...errorCode(error) });
  }
  try {
    const seeds = opts.noteType
      ? db.recallNotesWithType(entityName, query, opts.noteType, opts.weights)
      : db.recallNotes(entityName, query, opts.weights);
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
    out.items.evidence!.push(
      ...result.results
        .filter((record) => !jobArtifacts.has(record.id))
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
    out.items.evidence!.push(
      ...result.results
        .filter((hit) => !jobArtifacts.has(hit.id) && !hit.session_id?.startsWith("assistance:"))
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
        const item = proposalItem(full.result as MemoryAssistanceJob);
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
  return {
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
export function renderUnifiedContext(
  result: UnifiedContextResult,
  opts: { header?: boolean; degraded?: boolean } = {},
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
      for (const item of tier.items) lines.push(`- [${item.provenance}] ${item.content}`);
    }
    if (tier.omitted > 0) lines.push(`  (+${tier.omitted} more omitted for budget)`);
    blocks.push(lines.join("\n"));
  }
  if (opts.degraded !== false && result.degraded.length > 0) {
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
