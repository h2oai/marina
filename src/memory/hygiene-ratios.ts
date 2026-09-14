// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Continuous-hygiene ratios — the numbers the memory design says must be
 * "published beside any headline number": redundancy, contradiction and
 * unresolved-contradiction rate, provenance coverage, staleness, unsafe-served
 * rate, reflection repetition, storage against the admission budget,
 * write/read cost, consolidation ROI and repair success.
 *
 * Read model only: every figure is derived on demand from both silos (legacy
 * `notes` and the durable `memory_*` tables) plus the memory receipts already
 * on the event log. Nothing here writes, awaits, or calls a model. Scoping
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
  MemoryHygieneRatios,
  MemoryRatio,
  MemoryStorageBudgetView,
} from "../net/memory-observability-types";
import type { MemoryReceipt } from "../net/memory-receipt";
import { COMPETING_RECORD_PREDICATE } from "../persistence/db-memory-review";
import { memoryStorageUsage } from "../persistence/db-memory-storage";
import { LEGACY_SOURCE_SESSION } from "./legacy-bridge";

export const HYGIENE_RATIOS_WINDOW_MS = 24 * 60 * 60 * 1000;
export const HYGIENE_RATIOS_TTL_MS = 30_000;
/** Owners listed in the storage table (operator view), largest first. */
export const STORAGE_OWNERS_LIMIT = 20;

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
