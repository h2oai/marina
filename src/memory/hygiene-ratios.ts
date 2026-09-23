// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Continuous-hygiene ratios — the numbers the memory design says must be
 * "published beside any headline number": redundancy, contradiction and
 * unresolved-contradiction rate, provenance coverage, staleness, unsafe-served
 * rate, reflection repetition, storage against the admission budget,
 * write/read cost, consolidation ROI and repair success.
 *
 * Read model, plus one ledger: every figure is derived on demand from both
 * silos (legacy `notes` and the durable `memory_*` tables) plus the memory
 * receipts already on the event log; the only write is the hourly
 * `memory_hygiene_snapshots` row (`recordHygieneSnapshot`) that gives the
 * ratios a history. Nothing here awaits or calls a model. Scoping
 * follows the observer: an operator sees the whole instance, a resident only
 * its own spaces, notes and receipts. Each ratio carries its numerator and
 * denominator so a reader can check the arithmetic; a zero denominator yields
 * `value: null` ("n/a"), never a misleading 0 %.
 *
 * Cost: a handful of aggregate queries over indexed columns; the duplicate
 * scans group in SQL. The observability layer memoizes results for
 * `HYGIENE_RATIOS_TTL_MS` per scope, so a busy dashboard does not recompute
 * on every poll.
 */

import type { Database } from "bun:sqlite";
import type {
  MemoryHygieneHistory,
  MemoryHygieneRatios,
  MemoryHygieneSample,
  MemoryRatio,
  MemorySpaceHealth,
  MemoryStorageBudgetView,
} from "../net/memory-observability-types";
import { type MemoryReceipt, parseMemoryReceipt } from "../net/memory-receipt";
import { responseCacheCounters } from "../net/response-cache";
import { SYBIL_STANDING_FLOOR } from "../persistence/db-memory-resolve";
import { COMPETING_RECORD_PREDICATE } from "../persistence/db-memory-review";
import { memoryStorageUsage } from "../persistence/db-memory-storage";
import type { EngineEvent } from "../types";
import { LEGACY_SOURCE_SESSION } from "./legacy-bridge";

export const HYGIENE_RATIOS_WINDOW_MS = 24 * 60 * 60 * 1000;
export const HYGIENE_RATIOS_TTL_MS = 30_000;
/** Owners listed in the storage table (operator view), largest first. */
export const STORAGE_OWNERS_LIMIT = 20;
/** Shared spaces listed in `MemoryOverview.spaces.shared`. */
export const SPACE_HEALTH_LIMIT = 50;
/** Hygiene snapshots older than this are pruned on every write. */
export const HYGIENE_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const HYGIENE_HISTORY_DEFAULT_HOURS = 168;
export const HYGIENE_HISTORY_MAX_HOURS = 720;

/**
 * Cross-scope reads/cancels refused by the observability layer since process
 * start. Lives here (not in memory-observability.ts) so the hourly snapshot
 * can read it without an import cycle; memory-observability re-exports it.
 */
export const memoryLeakageCounters = { crossScopeAttempts: 0 };
export function resetMemoryLeakageCountersForTests(): void {
  memoryLeakageCounters.crossScopeAttempts = 0;
}

export interface HygieneRatiosScope {
  privileged: boolean;
  /** Durable principal id (`users.id`) — the resident's spaces. */
  principalId?: string;
  /** World entity name — the resident's legacy notes and receipts. */
  entityName?: string;
}

/** One injected response, as recorded on the `model_request_lifecycle` event. */
export interface ServedReceipt {
  receipt: MemoryReceipt;
  at: number;
  cacheHit: boolean;
}

export interface HygieneRatiosInput {
  now?: number;
  windowMs?: number;
  /** Receipts already filtered to the scope by the caller. */
  receipts: ServedReceipt[];
  cache: { hits: number; misses: number };
  leakage: { crossScopeAttempts: number };
}

export function ratio(numerator: number, denominator: number): MemoryRatio {
  return {
    numerator,
    denominator,
    value: denominator > 0 ? numerator / denominator : null,
  };
}

const count = (raw: Database, sql: string, ...params: (string | number | null)[]): number =>
  ((raw.query(sql).get(...params) as { n: number | null } | null)?.n ?? 0) as number;

/** Legacy tiers that count as knowledge (process/core notes are bookkeeping). */
const FACT_LIKE_TIERS = "('fact','reflection','skill')";
const LEGACY_NOTE_SCOPE = `n.entity_name NOT LIKE 'memory:%' AND n.pool_id IS NULL
  AND n.tier IN ${FACT_LIKE_TIERS} AND coalesce(n.verification_status,'') != 'superseded'
  AND (? IS NULL OR n.entity_name=? COLLATE NOCASE)`;
const RECORD_SCOPE = `r.status='active' AND s.status='active' AND (? IS NULL OR s.owner_id=?)`;
const TWIN_URL_PREFIX = "marina-memory://%";
/**
 * A durable source counts as EVIDENCE only when it is not memory mirroring
 * itself — the same exclusion `evidence_weighted` resolution applies: legacy
 * twin captures (session `legacy-notes`), assistance request envelopes, and
 * anything citing a `marina-memory://` identity. `src` must be the alias.
 */
const EVIDENCE_SOURCE = `coalesce(src.session_id,'') != '${LEGACY_SOURCE_SESSION}'
  AND src.body NOT LIKE '%marina-memory://%' AND src.body NOT LIKE '%marina.memory.assistance.request.v1%'`;

export function computeHygieneRatios(
  raw: Database,
  scope: HygieneRatiosScope,
  input: HygieneRatiosInput,
): MemoryHygieneRatios {
  const now = input.now ?? Date.now();
  const windowMs = input.windowMs ?? HYGIENE_RATIOS_WINDOW_MS;
  const since = now - windowMs;
  const self = scope.privileged ? null : (scope.principalId ?? "");
  const selfName = scope.privileged ? null : (scope.entityName ?? "");

  // ── Structural: records ─────────────────────────────────────────────────
  const activeRecords = count(
    raw,
    `SELECT count(*) AS n FROM memory_records r JOIN memory_spaces s ON s.id=r.space_id WHERE ${RECORD_SCOPE}`,
    self,
    self,
  );
  const staleRecords = count(
    raw,
    `SELECT count(*) AS n FROM memory_records r JOIN memory_spaces s ON s.id=r.space_id WHERE ${RECORD_SCOPE} AND r.stale=1`,
    self,
    self,
  );
  const claimedRecords = count(
    raw,
    `SELECT count(*) AS n FROM memory_records r JOIN memory_spaces s ON s.id=r.space_id
     WHERE ${RECORD_SCOPE} AND EXISTS(SELECT 1 FROM memory_claims c WHERE c.record_id=r.id)`,
    self,
    self,
  );
  const competingNow = count(
    raw,
    `SELECT count(*) AS n FROM memory_records r JOIN memory_spaces s ON s.id=r.space_id
     WHERE ${RECORD_SCOPE} AND ${COMPETING_RECORD_PREDICATE}`,
    self,
    self,
  );
  const settledInWindow = count(
    raw,
    `SELECT count(DISTINCT m.record_id) AS n FROM memory_resolution_members m
     JOIN memory_resolutions x ON x.id=m.resolution_id JOIN memory_spaces s ON s.id=x.space_id
     WHERE x.status='applied' AND x.created_at>=? AND m.role IN ('winner','superseded','peer')
       AND (? IS NULL OR s.owner_id=?)`,
    since,
    self,
    self,
  );

  // Provenance: a twin capture mirrors the note itself and an assistance
  // envelope is a request, not evidence — excluded on both sides, exactly as
  // the resolution and ranking terms exclude them.
  const recordsWithSource = count(
    raw,
    `SELECT count(*) AS n FROM memory_records r JOIN memory_spaces s ON s.id=r.space_id
     WHERE ${RECORD_SCOPE} AND EXISTS(
       SELECT 1 FROM memory_derivations d JOIN memory_sources src ON src.id=d.source_id
       WHERE d.record_id=r.id AND ${EVIDENCE_SOURCE})`,
    self,
    self,
  );
  const legacyNotes = count(
    raw,
    `SELECT count(*) AS n FROM notes n WHERE ${LEGACY_NOTE_SCOPE}`,
    selfName,
    selfName,
  );
  const legacyNotesWithSource = count(
    raw,
    `SELECT count(*) AS n FROM notes n WHERE ${LEGACY_NOTE_SCOPE}
       AND EXISTS(SELECT 1 FROM note_sources ns WHERE ns.note_id=n.id AND ns.url NOT LIKE ?)`,
    selfName,
    selfName,
    TWIN_URL_PREFIX,
  );

  // Redundancy: exact duplicates after case-fold + trim, per owner (legacy) or
  // per space (durable). `createNote` already dedups identical (entity, type,
  // content), so legacy duplicates are cross-type or whitespace/case variants.
  const legacyDuplicates = count(
    raw,
    `SELECT coalesce(sum(c-1),0) AS n FROM (
       SELECT count(*) AS c FROM notes n WHERE ${LEGACY_NOTE_SCOPE}
       GROUP BY n.entity_name, lower(trim(n.content)) HAVING c>1)`,
    selfName,
    selfName,
  );
  const recordDuplicates = count(
    raw,
    `SELECT coalesce(sum(c-1),0) AS n FROM (
       SELECT count(*) AS c FROM memory_records r JOIN memory_spaces s ON s.id=r.space_id
       JOIN notes n ON n.id=r.current_note_id
       WHERE ${RECORD_SCOPE} AND json_extract(r.metadata,'$.legacy_note_id') IS NULL
       GROUP BY r.space_id, lower(trim(n.content)) HAVING c>1)`,
    self,
    self,
  );

  // Reflection repetition (window): same entity, same case-folded content as
  // an EARLIER reflection.
  const reflectionsInWindow = count(
    raw,
    `SELECT count(*) AS n FROM notes n WHERE ${LEGACY_NOTE_SCOPE} AND n.tier='reflection' AND n.created_at>=?`,
    selfName,
    selfName,
    since,
  );
  const repeatedReflections = count(
    raw,
    `SELECT count(*) AS n FROM notes n WHERE ${LEGACY_NOTE_SCOPE} AND n.tier='reflection' AND n.created_at>=?
       AND EXISTS(SELECT 1 FROM notes p WHERE p.entity_name=n.entity_name AND p.tier='reflection'
                  AND p.id<n.id AND lower(trim(p.content))=lower(trim(n.content)))`,
    selfName,
    selfName,
    since,
  );

  // ── Unsafe-served (window) ──────────────────────────────────────────────
  const servedCheck = raw.query(
    `SELECT r.valid_until AS valid_until,
       EXISTS(SELECT 1 FROM memory_resolution_members m JOIN memory_resolutions x ON x.id=m.resolution_id
              WHERE m.record_id=r.id AND m.role='superseded' AND x.status='applied' AND x.created_at<=?
                AND (m.retired_at IS NULL OR m.retired_at>?)) AS superseded,
       EXISTS(SELECT 1 FROM memory_service_events e WHERE e.reference_id=r.id
              AND e.operation='memory.forgotten' AND e.created_at<=?) AS forgotten,
       (SELECT max(v.version) FROM memory_record_versions v JOIN notes n ON n.id=v.note_id
        WHERE v.record_id=r.id AND n.created_at<=?) AS version_at
     FROM memory_records r WHERE r.id=?`,
  );
  let citingReceipts = 0;
  let unsafeReceipts = 0;
  let injectedBytes = 0;
  let receiptsInWindow = 0;
  for (const served of input.receipts) {
    if (served.at < since) continue;
    receiptsInWindow++;
    injectedBytes += served.receipt.usedBytes;
    const refs = served.receipt.tiers.flatMap((tier) =>
      tier.ids.filter((ref) => typeof ref.version === "number"),
    );
    if (refs.length === 0) continue;
    citingReceipts++;
    const unsafe = refs.some((ref) => {
      const row = servedCheck.get(served.at, served.at, served.at, served.at, ref.id) as {
        valid_until: number | null;
        superseded: number;
        forgotten: number;
        version_at: number | null;
      } | null;
      if (!row) return false;
      if (row.superseded || row.forgotten) return true;
      if (row.valid_until !== null && row.valid_until <= served.at) return true;
      return row.version_at !== null && (ref.version as number) < row.version_at;
    });
    if (unsafe) unsafeReceipts++;
  }

  // ── Consolidation ROI (window): adopted reflector lessons ──────────────
  const adopted = raw
    .query(
      `SELECT r.id FROM memory_records r JOIN memory_spaces s ON s.id=r.space_id
       JOIN memory_assistance_jobs j ON j.id=json_extract(r.metadata,'$.adopted_from_job')
       WHERE ${RECORD_SCOPE} AND j.role='reflector' AND r.created_at>=?`,
    )
    .all(self, self, since) as { id: string }[];
  let consolidatedInputs = 0;
  for (const record of adopted) {
    consolidatedInputs += count(
      raw,
      `SELECT (SELECT count(*) FROM memory_dependencies d WHERE d.record_id=?)
            + (SELECT count(*) FROM memory_derivations d JOIN memory_sources src ON src.id=d.source_id
               WHERE d.record_id=? AND ${EVIDENCE_SOURCE}) AS n`,
      record.id,
      record.id,
    );
  }

  // ── Repair success (window): curator jobs that led somewhere ───────────
  const repairJobs = raw
    .query(
      `SELECT j.id,j.space_id,j.state,j.deadline,j.created_at FROM memory_assistance_jobs j
       JOIN memory_sources src ON src.id=j.input_source_id JOIN memory_spaces s ON s.id=j.space_id
       WHERE j.role='evaluator' AND j.created_at>=? AND (? IS NULL OR s.owner_id=?)
         AND (json_extract(src.body,'$.task') LIKE '[hygiene]%'
              OR json_extract(src.body,'$.task') LIKE '[shared-write-review]%')`,
    )
    .all(since, self, self) as {
    id: string;
    space_id: string;
    state: string;
    deadline: number;
    created_at: number;
  }[];
  let finalJobs = 0;
  let repairedJobs = 0;
  for (const job of repairJobs) {
    const final =
      job.state === "answered" ||
      job.state === "abstained" ||
      job.state === "cancelled" ||
      job.deadline <= now;
    if (!final) continue;
    finalJobs++;
    if (job.state !== "answered") continue;
    const followed = count(
      raw,
      `SELECT (EXISTS(SELECT 1 FROM memory_records r WHERE r.status='active'
                 AND json_extract(r.metadata,'$.adopted_from_job')=?)
            OR EXISTS(SELECT 1 FROM memory_resolutions x WHERE x.space_id=? AND x.created_at>=?)) AS n`,
      job.id,
      job.space_id,
      job.created_at,
    );
    if (followed) repairedJobs++;
  }

  // ── Storage vs admission budget ────────────────────────────────────────
  const owners = scope.privileged
    ? (
        raw
          .query(
            `SELECT s.owner_id AS owner FROM memory_spaces s LEFT JOIN memory_storage_usage u ON u.space_id=s.id
             WHERE s.status='active' GROUP BY s.owner_id
             ORDER BY coalesce(sum(u.logical_bytes),0) DESC, s.owner_id LIMIT ?`,
          )
          .all(STORAGE_OWNERS_LIMIT) as { owner: string }[]
      ).map((row) => row.owner)
    : scope.principalId
      ? [scope.principalId]
      : [];
  const storage: MemoryStorageBudgetView[] = owners.map((owner) => {
    const usage = memoryStorageUsage(raw, owner);
    const limit = (value: number) => (Number.isFinite(value) ? value : null);
    const name =
      (
        raw.query("SELECT display_name FROM principals WHERE principal_id=?").get(owner) as {
          display_name: string;
        } | null
      )?.display_name ?? owner.slice(0, 8);
    const maxBytes = limit(usage.limits.logical_bytes);
    return {
      ownerName: name,
      logicalBytes: usage.usage.logical_bytes,
      maxBytes,
      sources: usage.usage.sources,
      maxSources: limit(usage.limits.sources),
      revisions: usage.usage.revisions,
      maxRevisions: limit(usage.limits.revisions),
      spaces: usage.usage.spaces,
      maxSpaces: limit(usage.limits.spaces),
      utilization: maxBytes ? usage.usage.logical_bytes / maxBytes : null,
      overLimit: usage.over_limit,
    };
  });

  return {
    computedAt: now,
    windowMs,
    scope: scope.privileged ? "all" : "own",
    redundancy: ratio(legacyDuplicates + recordDuplicates, legacyNotes + activeRecords),
    contradictionRate: ratio(competingNow + settledInWindow, claimedRecords),
    unresolvedContradictionRate: ratio(competingNow, competingNow + settledInWindow),
    provenanceCoverage: ratio(
      recordsWithSource + legacyNotesWithSource,
      activeRecords + legacyNotes,
    ),
    stalenessRatio: ratio(staleRecords, activeRecords),
    unsafeServedRate: ratio(unsafeReceipts, citingReceipts),
    reflectionRepetitionRate: ratio(repeatedReflections, reflectionsInWindow),
    consolidationRoi: ratio(consolidatedInputs, adopted.length),
    repairSuccess: ratio(repairedJobs, finalJobs),
    leakage: { crossScopeAttempts: input.leakage.crossScopeAttempts, crossScopeCacheHits: 0 },
    storage,
    cost: {
      receipts: receiptsInWindow,
      avgInjectedBytes: receiptsInWindow > 0 ? Math.round(injectedBytes / receiptsInWindow) : null,
      cacheHitRate: ratio(input.cache.hits, input.cache.hits + input.cache.misses),
    },
  };
}

/** All-n/a ratios for an engine without a database (never a fake 0 %). */
export function emptyHygieneRatios(
  scope: HygieneRatiosScope,
  input: Pick<HygieneRatiosInput, "now" | "windowMs" | "cache" | "leakage">,
): MemoryHygieneRatios {
  const none = ratio(0, 0);
  return {
    computedAt: input.now ?? Date.now(),
    windowMs: input.windowMs ?? HYGIENE_RATIOS_WINDOW_MS,
    scope: scope.privileged ? "all" : "own",
    redundancy: none,
    contradictionRate: none,
    unresolvedContradictionRate: none,
    provenanceCoverage: none,
    stalenessRatio: none,
    unsafeServedRate: none,
    reflectionRepetitionRate: none,
    consolidationRoi: none,
    repairSuccess: none,
    leakage: { crossScopeAttempts: input.leakage.crossScopeAttempts, crossScopeCacheHits: 0 },
    storage: [],
    cost: {
      receipts: 0,
      avgInjectedBytes: null,
      cacheHitRate: ratio(input.cache.hits, input.cache.hits + input.cache.misses),
    },
  };
}

// ─── Served receipts (event log scan) ───────────────────────────────────────

export interface ServedReceiptEvent extends ServedReceipt {
  requestId: string;
  /** Protocol surface recorded on the lifecycle event; `unknown` for producers that predate the field. */
  surface: ReceiptSurface;
}

export type ReceiptSurface = "openai" | "anthropic" | "ollama-generate" | "responses" | "unknown";
const RECEIPT_SURFACES: ReadonlySet<string> = new Set([
  "openai",
  "anthropic",
  "ollama-generate",
  "responses",
]);

/** The PROTOCOL surface of a lifecycle event (never the route kind), `unknown` when absent/foreign. */
export function receiptSurfaceOf(event: { surface?: string }): ReceiptSurface {
  return event.surface && RECEIPT_SURFACES.has(event.surface)
    ? (event.surface as ReceiptSurface)
    : "unknown";
}

/**
 * Every injected response on the event log the observer may see, newest
 * first, one per request. Feeds the recent-receipts list, the hygiene ratios
 * (unsafe-served, cost) and the hourly snapshot.
 */
export function servedReceiptsFromEvents(
  events: readonly EngineEvent[],
  scope: Pick<HygieneRatiosScope, "privileged" | "entityName">,
  limit = Number.POSITIVE_INFINITY,
): ServedReceiptEvent[] {
  const byRequest = new Map<string, ServedReceiptEvent>();
  for (let i = events.length - 1; i >= 0 && byRequest.size < limit; i--) {
    const event = events[i]!;
    if (event.type !== "model_request_lifecycle" || !event.memoryReceipt) continue;
    if (byRequest.has(event.requestId)) continue;
    const receipt: MemoryReceipt | undefined = parseMemoryReceipt(event.memoryReceipt);
    if (!receipt) continue;
    if (!scope.privileged && receipt.entity !== scope.entityName) continue;
    byRequest.set(event.requestId, {
      receipt,
      at: event.timestamp,
      cacheHit: event.target === "response-cache",
      requestId: event.requestId,
      surface: receiptSurfaceOf(event),
    });
  }
  return [...byRequest.values()];
}

// ─── Per-space health ───────────────────────────────────────────────────────

/** Service-event operations that make their actor a WRITER of the space. */
const WRITE_OPERATIONS = "('memory.created','memory.revised')";

interface SpaceHealthRow {
  id: string;
  name: string;
  owner_id: string;
  institutional: number;
  writers: number;
  records: number;
  ratified: number;
  competing: number;
  last_write_at: number | null;
}

/**
 * Health of every SHARED durable space the observer may see: institutional
 * spaces plus any space with ≥ 2 distinct writers or ≥ 1 grant. A resident
 * sees only spaces it owns or is granted. Same predicates as the global
 * ratios: `COMPETING_RECORD_PREDICATE` for contradictions, and a writer is
 * "fresh" when its standing (durable key, `users ⋈ entity_standing_cache`)
 * is below `SYBIL_STANDING_FLOOR` — the same floor `evidence_weighted` pools
 * fresh writers under. Ordered by competing desc, records desc; max `limit`.
 */
export function computeSpaceHealth(
  raw: Database,
  scope: Pick<HygieneRatiosScope, "privileged" | "principalId">,
  opts: { now?: number; windowMs?: number; limit?: number } = {},
): MemorySpaceHealth[] {
  const now = opts.now ?? Date.now();
  const since = now - (opts.windowMs ?? HYGIENE_RATIOS_WINDOW_MS);
  const limit = opts.limit ?? SPACE_HEALTH_LIMIT;
  const self = scope.privileged ? null : (scope.principalId ?? "");
  const rows = raw
    .query(
      `SELECT * FROM (
         SELECT s.id, s.name, s.owner_id,
           coalesce(json_extract(s.metadata,'$.institutional'),0) AS institutional,
           (SELECT count(DISTINCT e.actor_id) FROM memory_service_events e
             WHERE e.space_id=s.id AND e.operation IN ${WRITE_OPERATIONS}) AS writers,
           (SELECT count(*) FROM memory_grants g WHERE g.space_id=s.id) AS grants,
           (SELECT count(*) FROM memory_records r WHERE r.space_id=s.id AND r.status='active') AS records,
           (SELECT count(*) FROM memory_records r WHERE r.space_id=s.id AND r.status='active'
             AND json_extract(r.metadata,'$.ratified_by') IS NOT NULL) AS ratified,
           (SELECT count(*) FROM memory_records r WHERE r.space_id=s.id AND r.status='active'
             AND ${COMPETING_RECORD_PREDICATE}) AS competing,
           (SELECT max(e.created_at) FROM memory_service_events e
             WHERE e.space_id=s.id AND e.operation IN ${WRITE_OPERATIONS}) AS last_write_at
         FROM memory_spaces s
         WHERE s.status='active'
           AND (? IS NULL OR s.owner_id=?
                OR EXISTS(SELECT 1 FROM memory_grants g WHERE g.space_id=s.id AND g.principal_id=?))
       ) WHERE institutional=1 OR writers>=2 OR grants>=1
       ORDER BY competing DESC, records DESC, name, id LIMIT ?`,
    )
    .all(self, self, self, limit) as SpaceHealthRow[];
  const freshWriters = raw.query(
    `SELECT count(*) AS n FROM (
       SELECT DISTINCT e.actor_id FROM memory_service_events e
       WHERE e.space_id=? AND e.operation IN ${WRITE_OPERATIONS}) w
     WHERE coalesce((SELECT sc.standing FROM users u JOIN entity_standing_cache sc ON sc.entity_id=u.id
                     WHERE u.id=w.actor_id),0) < ?`,
  );
  const settled = raw.query(
    `SELECT count(DISTINCT m.record_id) AS n FROM memory_resolution_members m
     JOIN memory_resolutions x ON x.id=m.resolution_id
     WHERE x.space_id=? AND x.status='applied' AND x.created_at>=?
       AND m.role IN ('winner','superseded','peer')`,
  );
  const resolutions = raw.query(
    "SELECT count(*) AS n FROM memory_resolutions WHERE space_id=? AND created_at>=?",
  );
  const ownerName = raw.query("SELECT display_name FROM principals WHERE principal_id=?");
  const n = (row: unknown): number => ((row as { n: number | null } | null)?.n ?? 0) as number;
  return rows.map((row): MemorySpaceHealth => {
    const fresh = n(freshWriters.get(row.id, SYBIL_STANDING_FLOOR));
    const settledInWindow = n(settled.get(row.id, since));
    return {
      id: row.id,
      name: row.name,
      institutional: row.institutional === 1,
      ownerName:
        (ownerName.get(row.owner_id) as { display_name: string } | null)?.display_name ??
        row.owner_id.slice(0, 8),
      records: row.records,
      ratified: row.ratified,
      writers: row.writers,
      freshWriters: fresh,
      freshWriterShare: ratio(fresh, row.writers),
      competing: row.competing,
      resolutions24h: n(resolutions.get(row.id, since)),
      unresolvedContradictionRate: ratio(row.competing, row.competing + settledInWindow),
      lastWriteAt: row.last_write_at,
    };
  });
}

// ─── Ratio history (memory_hygiene_snapshots, migration 115) ────────────────

/** Clamp a requested history window to [1, HYGIENE_HISTORY_MAX_HOURS]; default 168 h. */
export function clampHistoryHours(hours: number | undefined): number {
  if (hours === undefined || !Number.isFinite(hours) || hours <= 0)
    return HYGIENE_HISTORY_DEFAULT_HOURS;
  return Math.min(Math.floor(hours), HYGIENE_HISTORY_MAX_HOURS);
}

/** Append one snapshot row and prune everything past the retention window. */
export function recordHygieneSnapshot(
  raw: Database,
  ratios: MemoryHygieneRatios,
  at: number = ratios.computedAt,
): MemoryHygieneSample {
  raw
    .query("INSERT INTO memory_hygiene_snapshots (at, scope, ratios) VALUES (?, ?, ?)")
    .run(at, ratios.scope, JSON.stringify(ratios));
  raw
    .query("DELETE FROM memory_hygiene_snapshots WHERE at < ?")
    .run(at - HYGIENE_HISTORY_RETENTION_MS);
  return { at, ratios };
}

/** Snapshots for `scope` inside the last `hours`, oldest → newest. */
export function listHygieneSnapshots(
  raw: Database,
  opts: { hours?: number; now?: number } = {},
): MemoryHygieneHistory {
  const hours = clampHistoryHours(opts.hours);
  const now = opts.now ?? Date.now();
  const rows = raw
    .query(
      "SELECT at, ratios FROM memory_hygiene_snapshots WHERE scope='all' AND at >= ? ORDER BY at ASC, id ASC",
    )
    .all(now - hours * 60 * 60 * 1000) as { at: number; ratios: string }[];
  const samples: MemoryHygieneSample[] = [];
  for (const row of rows) {
    try {
      samples.push({ at: row.at, ratios: JSON.parse(row.ratios) as MemoryHygieneRatios });
    } catch {
      // A corrupt row is skipped, never fatal to the series.
    }
  }
  return { scope: "all", hours, samples };
}

/**
 * Compute the operator-scope (`all`) ratios from the live state and the given
 * event log, and persist them as one history sample. Sync SQL only — called
 * from the hourly hygiene tick and `POST /api/memory/hygiene/snapshot`.
 */
export function snapshotHygieneRatios(
  raw: Database,
  events: readonly EngineEvent[],
  now: number = Date.now(),
): MemoryHygieneSample {
  const scope: HygieneRatiosScope = { privileged: true };
  const ratios = computeHygieneRatios(raw, scope, {
    now,
    receipts: servedReceiptsFromEvents(events, scope),
    cache: responseCacheCounters,
    leakage: memoryLeakageCounters,
  });
  return recordHygieneSnapshot(raw, ratios, now);
}
