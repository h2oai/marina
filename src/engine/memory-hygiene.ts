// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Scheduled memory hygiene — the first automatic consumer of the durable
 * review queue and the first automatic dispatch of the assistance substrate.
 *
 * Once an hour, for every ONLINE entity that owns a durable world account:
 *  (a) count the durable `review` queue (kind `stale`, kind `competing`),
 *  (b) audit the entity's legacy notes with the shared knowledge auditor
 *      (duplicate groups, overlong notes, unsupported empirical claims),
 *  (c) write ONE process-tier `[hygiene] stale=N competing=M duplicates=D
 *      overlong=O unsupported=U` note (deduped against the last hygiene note),
 *  (d) when stale+competing reaches `HYGIENE_DISPATCH_THRESHOLD`: on a LOCAL
 *      profile file an evaluator job automatically (worker = the running
 *      `memory-evaluator` helper's durable principal) and record its id in the
 *      hygiene note; on SHARED/PUBLIC never file work on the owner's behalf —
 *      `tell` them the counts and the exact `memory assist evaluator …`
 *      command. With no evaluator running, the notification carries the spawn
 *      command instead. At most one open hygiene job per entity, ever.
 *
 * Nothing here certifies a claim, edits a record, or prunes a note — the
 * evaluator's proposal is attributed opinion the owner adopts (or not) with
 * ordinary versioned operations. Pure observation plus one bounded dispatch.
 */

import { residentMemoryOperation } from "../memory/resident-service";
import type { MarinaDB, NoteRow } from "../persistence/database";
import type { MemoryAssistanceJob, MemoryAssistancePage } from "../sdk/memory-assistance";
import type { MemoryOperationRequest } from "../sdk/memory-operations";
import type { MemoryReviewResult } from "../sdk/memory-types";
import type { EntityId } from "../types";
import { auditKnowledgeNotes } from "./commands/knowledge-hygiene";
import { NOTE_IMPORTANCE_INTERVAL } from "./constants";
import type { Engine } from "./engine";
import { isLocalProfile } from "./trust-profile";

/** stale + competing at or above this files (local) or recommends (shared) an evaluator review. */
export const HYGIENE_DISPATCH_THRESHOLD = 5;

/** Prefix of the process-tier note; `orient` reads the latest one. */
export const HYGIENE_NOTE_PREFIX = "[hygiene]";

/** Marker every hygiene-filed assistance task starts with — the open-job
 *  check keys on it so no entity ever carries two open hygiene reviews. */
export const HYGIENE_TASK_MARKER = "[hygiene]";

export const HYGIENE_TASK = `${HYGIENE_TASK_MARKER} Review the stale and competing assertions in this space; for each, say which the evidence supports and what is missing`;

/** Helper role the hygiene pass dispatches to / recommends. */
export const HYGIENE_HELPER_ROLE = "memory-evaluator";

/** Phase within the shared hourly interval (distinct from every other hourly job in engine.ts). */
export const MEMORY_HYGIENE_PHASE = 2700;

const REVIEW_PAGE = 100;
const JOBS_PAGE = 100;
const NOTE_SCAN = 500;
const JOB_MAX_OPERATIONS = 32;
const JOB_TIMEOUT_MS = 10 * 60 * 1000;

export interface HygieneHelper {
  name: string;
  principalId: string;
}

export interface MemoryHygieneDeps {
  /** Entities currently connected that may own a durable world account. */
  onlineEntities: () => { id: EntityId; name: string }[];
  /** World-account-bound durable memory operation (see resident-service). */
  residentMemoryOperation: (
    name: string,
    request: MemoryOperationRequest,
  ) => Promise<{ ok: true; result: unknown; space_id?: string }>;
  /** Direct notification to the owner (a `tell`). */
  tell: (entityId: EntityId, text: string) => void;
  /** A running resident helper with the given role, if any. */
  findRunningHelper: (role: string) => HygieneHelper | undefined;
  /** Optional warning sink for per-entity soft failures. */
  warn?: (message: string, detail?: Record<string, unknown>) => void;
}

export interface MemoryHygieneReport {
  entity: EntityId;
  name: string;
  stale: number;
  competing: number;
  duplicates: number;
  overlong: number;
  unsupported: number;
  /** Assistance job id when one was filed this run or already open. */
  jobId?: string;
  /** True when this run filed the job (vs. found it already open). */
  dispatched: boolean;
  /** True when the owner was told (shared profile, or no helper running). */
  notified: boolean;
  /** Id of the hygiene note written, or undefined when identical to the last one. */
  noteId?: number;
}

/** Render the canonical hygiene line — one source for the writer and `orient`. */
export function formatHygieneLine(counts: {
  stale: number;
  competing: number;
  pending?: number;
  duplicates: number;
  overlong: number;
  unsupported: number;
  jobId?: string;
}): string {
  const pending = counts.pending ? ` pending=${counts.pending}` : "";
  const base = `${HYGIENE_NOTE_PREFIX} stale=${counts.stale} competing=${counts.competing}${pending} duplicates=${counts.duplicates} overlong=${counts.overlong} unsupported=${counts.unsupported}`;
  return counts.jobId ? `${base} job=${counts.jobId}` : base;
}

/** The exact command a shared-profile owner runs to get the same review. */
export function hygieneAssistCommand(helperName: string): string {
  return `memory assist evaluator ${helperName} ${HYGIENE_TASK}`;
}

/** The exact command that brings an evaluator online (docs/guides/memory-assistance.md). */
export const HYGIENE_SPAWN_COMMAND = `agent spawn Evaluator model marina/default role ${HYGIENE_HELPER_ROLE} budget 40`;

export async function runMemoryHygiene(
  db: MarinaDB,
  deps: MemoryHygieneDeps,
  now: number = Date.now(),
): Promise<MemoryHygieneReport[]> {
  const reports: MemoryHygieneReport[] = [];
  for (const entity of deps.onlineEntities()) {
    const user = db.getUserByName(entity.name);
    if (!user) continue; // no durable world account → nothing to review
    try {
      reports.push(await hygieneForEntity(db, deps, entity, user.id, now));
    } catch (error) {
      deps.warn?.("Memory hygiene failed for entity", {
        entity: entity.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return reports;
}

async function hygieneForEntity(
  db: MarinaDB,
  deps: MemoryHygieneDeps,
  entity: { id: EntityId; name: string },
  principalId: string,
  now: number,
): Promise<MemoryHygieneReport> {
  const op = (request: MemoryOperationRequest) =>
    deps.residentMemoryOperation(entity.name, request);

  // (a) durable review queue — one bounded page per kind. `+` overflow is
  // folded into the count as the page size; the threshold is what matters.
  const stale = await reviewCount(op, "stale", deps, entity.name);
  const competing = await reviewCount(op, "competing", deps, entity.name);
  // Contradictions parked under `resolve … await_confirmation` (Phase 2.5).
  const pending = await reviewCount(op, "pending", deps, entity.name);

  // (b) legacy notes — skip process-tier (compaction/hygiene lines are noisy
  // by design) and superseded notes so the auditor sees live knowledge only.
  const notes = db.getNotesByEntity(entity.name, NOTE_SCAN);
  const live = notes.filter(
    (n) => n.tier !== "process" && n.verification_status !== "superseded" && !isHygieneNote(n),
  );
  const audit = auditKnowledgeNotes(live);
  const counts = {
    stale,
    competing,
    pending,
    duplicates: audit.duplicateGroups.length,
    overlong: audit.overlong.length,
    unsupported: audit.unsupportedClaims.length,
  };

  // (d) dispatch decision.
  let jobId: string | undefined;
  let dispatched = false;
  let notified = false;
  let notice: string | undefined;
  if (stale + competing >= HYGIENE_DISPATCH_THRESHOLD) {
    jobId = await findOpenHygieneJob(op, principalId);
    if (!jobId) {
      const helper = deps.findRunningHelper(HYGIENE_HELPER_ROLE);
      const summary = `${stale} stale and ${competing} competing durable assertions need review`;
      if (!helper) {
        notice = `Memory hygiene: ${summary}. No ${HYGIENE_HELPER_ROLE} is running — start one with: ${HYGIENE_SPAWN_COMMAND}`;
      } else if (isLocalProfile()) {
        const created = (await op({
          operation: "assist_create",
          key: `hygiene:${principalId}:${now}`,
          input: {
            role: "evaluator",
            worker_id: helper.principalId,
            task: HYGIENE_TASK,
            max_operations: JOB_MAX_OPERATIONS,
            timeout_ms: JOB_TIMEOUT_MS,
          },
        })) as { result: { id: string } };
        jobId = created.result.id;
        dispatched = true;
      } else {
        notice = `Memory hygiene: ${summary}. Ask the evaluator: ${hygieneAssistCommand(helper.name)}`;
      }
    }
  }

  // (c) one process-tier line, deduped against the last hygiene note. The
  // owner notification rides the same dedup: an unchanged state is not
  // re-announced every hour.
  const line = formatHygieneLine({ ...counts, jobId });
  const last = notes.find(isHygieneNote);
  let noteId: number | undefined;
  if (last?.content !== line) {
    noteId = db.createNote(entity.name, line, undefined, {
      tier: "process",
      noteType: "observation",
      importance: 3,
    });
    if (notice) {
      deps.tell(entity.id, notice);
      notified = true;
    }
  }

  return { entity: entity.id, name: entity.name, ...counts, jobId, dispatched, notified, noteId };
}

function isHygieneNote(note: NoteRow): boolean {
  return note.pool_id == null && note.content.startsWith(HYGIENE_NOTE_PREFIX);
}

async function reviewCount(
  op: (request: MemoryOperationRequest) => Promise<{ result: unknown }>,
  kind: "stale" | "competing" | "pending",
  deps: MemoryHygieneDeps,
  name: string,
): Promise<number> {
  try {
    const page = (await op({ operation: "review", input: { kind, limit: REVIEW_PAGE } }))
      .result as MemoryReviewResult;
    return page.items.length;
  } catch (error) {
    deps.warn?.("Memory hygiene review failed", {
      entity: name,
      kind,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

/** Open assistance jobs omit `task` (it lives in the request source), so the
 *  marker check reads each open evaluator job the owner filed — bounded page. */
async function findOpenHygieneJob(
  op: (request: MemoryOperationRequest) => Promise<{ result: unknown }>,
  principalId: string,
): Promise<string | undefined> {
  const page = (await op({ operation: "assist_jobs", input: { open: true, limit: JOBS_PAGE } }))
    .result as MemoryAssistancePage;
  for (const job of page.jobs) {
    if (job.role !== "evaluator" || job.requester_id !== principalId || !job.work_open) continue;
    try {
      const full = (await op({ operation: "assist_get", id: job.id }))
        .result as MemoryAssistanceJob;
      if (full.task?.startsWith(HYGIENE_TASK_MARKER)) return job.id;
    } catch {
      // A forgotten request source or revoked access is not a hygiene job.
    }
  }
  return undefined;
}

/** True on the tick the hourly hygiene job should run. */
export function isMemoryHygieneTick(tickCount: number): boolean {
  return tickCount % NOTE_IMPORTANCE_INTERVAL === MEMORY_HYGIENE_PHASE;
}

/** Engine adapter — builds the deps from the live engine and runs one pass. */
export async function runEngineMemoryHygiene(engine: Engine): Promise<MemoryHygieneReport[]> {
  const db = engine.db;
  if (!db) return [];
  return runMemoryHygiene(db, {
    onlineEntities: () =>
      engine.entities
        .all()
        .filter((e) => engine.getConnectionForEntity(e.id) !== undefined)
        .map((e) => ({ id: e.id, name: e.name })),
    residentMemoryOperation: (name, request) => residentMemoryOperation(db, name, request),
    tell: (entityId, text) =>
      engine.sendToEntity(entityId, text, "tell", {
        from: "Marina memory",
        message: text,
        memory_hygiene: true,
      }),
    findRunningHelper: (role) => {
      for (const agent of engine.agentRuntime.list()) {
        if (agent.role !== role || !agent.entityId) continue;
        if (!["connected", "autonomous", "idle"].includes(agent.state)) continue;
        const user = db.getUserByName(agent.name);
        if (user) return { name: agent.name, principalId: user.id };
      }
      return undefined;
    },
    warn: (message, detail) => engine.logger.warn("hygiene", message, detail),
  });
}
