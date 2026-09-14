// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Memory observability — read models for the dashboard's memory surface.
 *
 * Three consumers share this module:
 *   - REST (`dashboard-api.ts`): `/api/memory/overview`, `/api/memory/jobs`,
 *     `/api/memory/jobs/:id[/cancel]`, `/api/memory/graph`.
 *   - WebSocket: `pollMemoryEvents(engine)` runs on the engine tick (~2 s),
 *     reads `memory_service_events WHERE seq > lastSeq` (O(new rows)) and
 *     emits `memory_job` / `memory_service_event` engine events carrying
 *     ids, names and states only — never note/record content.
 *   - Tests (`test/memory-observability.test.ts`).
 *
 * Scoping is decided SERVER-side from the dashboard auth gate
 * (`memoryObserver`): operators / sovereigns / the desktop token / the
 * `MARINA_OPEN_API` sentinel see everything; an ordinary resident sees only
 * jobs it requested or works, resolutions in spaces it owns or is granted,
 * its own standing credits, hygiene line and receipts, and legacy notes the
 * existing `memoryAccess` predicate lets it read. Institutional spaces are
 * public-read, so ratified-record previews are visible to every principal.
 *
 * Nothing here runs on a command hot path: every REST builder is synchronous
 * SQL over the raw handle (`db.memoryRepository().raw`), except `cancel`,
 * which is a POST that deliberately awaits the resident memory client.
 */

import type { Database } from "bun:sqlite";
import type { Engine } from "../engine/engine";
import { ACCUMULATION_TASK_MARKER, SHARED_WRITE_REVIEW_MARKER } from "../engine/memory-dispatch";
import { HYGIENE_NOTE_PREFIX, HYGIENE_TASK_MARKER } from "../engine/memory-hygiene";
import { computeTrustProfile } from "../engine/readiness";
import { DURABLE_TWIN_URL_PREFIX, parseDurableTwinUrl } from "../memory/legacy-bridge";
import { residentMemoryOperation } from "../memory/resident-service";
import type { MarinaDB, NoteRow } from "../persistence/database";
import type { MemoryAnswer } from "../sdk/memory-answer";
import type { EngineEvent } from "../types";
import type {
  MemoryCreditView,
  MemoryGraph,
  MemoryGraphEdge,
  MemoryGraphNode,
  MemoryJobView,
  MemoryOverview,
  MemoryRatificationView,
  MemoryReceiptView,
  MemoryResolutionView,
} from "./memory-observability-types";
import { type MemoryReceipt, parseMemoryReceipt } from "./memory-receipt";
import { memoryObserver } from "./memory-visibility";
import { responseCacheCounters } from "./response-cache";

// ─── Scope ──────────────────────────────────────────────────────────────────

export interface MemoryObserverScope {
  /** Operator / sovereign / desktop token / dev-open sentinel: sees everything. */
  privileged: boolean;
  /** Durable principal id (`users.id`) of an ordinary resident, when it has one. */
  principalId?: string;
  entityName?: string;
  /** Legacy-note read predicate from the dashboard auth gate. */
  readNote: (note: NoteRow | undefined) => note is NoteRow;
}

/** Derive the observer scope for a dashboard principal (entity id or sentinel). */
export function memoryObserverScope(engine: Engine, principal?: string): MemoryObserverScope {
  const observer = memoryObserver(engine, principal);
  const entity = observer.entity;
  const user = entity && engine.db ? engine.db.getUserByName(entity.name) : undefined;
  return {
    privileged: observer.privilegedRead,
    principalId: user?.id,
    entityName: entity?.name,
    readNote: observer.read,
  };
}

// ─── Shared row shapes + helpers ────────────────────────────────────────────

interface JobRow {
  id: string;
  space_id: string;
  requester_id: string;
  worker_id: string;
  role: MemoryJobView["role"];
  parent_id: string | null;
  root_id: string;
  depth: number;
  state: MemoryJobView["state"];
  deadline: number;
  remaining_operations: number;
  input_source_id: string;
  result_record_id: string | null;
  created_at: number;
}

interface SpaceRow {
  id: string;
  name: string;
  owner_id: string;
  metadata: string | null;
}

const JOB_COLUMNS =
  "id,space_id,requester_id,worker_id,role,parent_id,root_id,depth,state,deadline,remaining_operations,input_source_id,result_record_id,created_at";
const OPEN_STATES = ["pending", "running"] as const;
const CREDIT_KINDS = [
  "assistance_adopted",
  "assistance_abstained_confirmed",
  "assistance_superseded",
] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_ANSWER_BYTES = 2048;
export const MAX_PREVIEW_CHARS = 160;
const NOTE_LABEL_CHARS = 120;
const GRAPH_RELATIONSHIPS = new Set<MemoryGraphEdge["relationship"]>([
  "twin",
  "cites",
  "derived_from",
  "resolves",
  "superseded_by",
  "in_space",
  "worker",
  "requester",
  "adopted_as",
  "related_to",
  "part_of",
  "supersedes",
  "contradicts",
]);

const rawDb = (db: MarinaDB): Database => db.memoryRepository().raw;

function parseJson<T>(value: string | null | undefined): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function clipBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let out = text;
  while (Buffer.byteLength(out) > maxBytes - 1) out = out.slice(0, -1);
  return `${out}…`;
}

/** Per-request lookup context: memoized names + spaces over one raw handle. */
class Lookup {
  private names = new Map<string, string>();
  private spaces = new Map<string, SpaceRow | null>();
  constructor(readonly raw: Database) {}

  name(principalId: string): string {
    let name = this.names.get(principalId);
    if (name === undefined) {
      const row = this.raw
        .query("SELECT display_name FROM principals WHERE principal_id=?")
        .get(principalId) as { display_name: string } | null;
      name = row?.display_name ?? principalId.slice(0, 8);
      this.names.set(principalId, name);
    }
    return name;
  }

  space(id: string): SpaceRow | undefined {
    if (!this.spaces.has(id)) {
      this.spaces.set(
        id,
        (this.raw
          .query("SELECT id,name,owner_id,metadata FROM memory_spaces WHERE id=?")
          .get(id) as SpaceRow | null) ?? null,
      );
    }
    return this.spaces.get(id) ?? undefined;
  }

  institutional(id: string): boolean {
    const meta = parseJson<Record<string, unknown>>(this.space(id)?.metadata);
    return meta?.institutional === true;
  }

  /** Durable principal id for a world entity name (undefined without an account). */
  principalOf(name: string): string | undefined {
    const row = this.raw
      .query(
        "SELECT principal_id FROM principals WHERE principal_type='human' AND display_name=? COLLATE NOCASE LIMIT 1",
      )
      .get(name) as { principal_id: string } | null;
    return row?.principal_id;
  }
}

export function markerOf(task: string | undefined | null): MemoryJobView["marker"] {
  if (!task) return null;
  if (task.startsWith(HYGIENE_TASK_MARKER)) return "hygiene";
  if (task.startsWith(ACCUMULATION_TASK_MARKER)) return "accumulation";
  if (task.startsWith(SHARED_WRITE_REVIEW_MARKER)) return "shared-write-review";
  return null;
}

function jobTask(raw: Database, job: JobRow): string | undefined {
  const row = raw
    .query("SELECT json_extract(body,'$.task') AS task FROM memory_sources WHERE id=?")
    .get(job.input_source_id) as { task: string | null } | null;
  return row?.task ?? undefined;
}

function jobRow(raw: Database, id: string): JobRow | undefined {
  return (
    (raw
      .query(`SELECT ${JOB_COLUMNS} FROM memory_assistance_jobs WHERE id=?`)
      .get(id) as JobRow | null) ?? undefined
  );
}

/** Live "may still be worked" projection: open state, live deadline, no cancelled/finished ancestor. */
function workOpen(raw: Database, job: JobRow, now: number): boolean {
  if (!(OPEN_STATES as readonly string[]).includes(job.state) || job.deadline <= now) return false;
  let parentId = job.parent_id;
  let guard = 0;
  while (parentId && guard++ < 8) {
    const parent = jobRow(raw, parentId);
    if (!parent || !(OPEN_STATES as readonly string[]).includes(parent.state)) return false;
    parentId = parent.parent_id;
  }
  if (job.root_id !== job.id) {
    const root = jobRow(raw, job.root_id);
    if (root?.state === "cancelled") return false;
  }
  return true;
}

function jobAnswer(
  raw: Database,
  recordId: string,
): { answer: string; citations: number } | undefined {
  const row = raw
    .query(
      "SELECT n.content AS content FROM memory_records r JOIN notes n ON n.id=r.current_note_id WHERE r.id=?",
    )
    .get(recordId) as { content: string } | null;
  const answer = parseJson<MemoryAnswer>(row?.content);
  if (!answer) return undefined;
  if (answer.status === "abstained")
    return { answer: clipBytes(String(answer.reason ?? ""), MAX_ANSWER_BYTES), citations: 0 };
  const text = typeof answer.answer === "string" ? answer.answer : JSON.stringify(answer.answer);
  return {
    answer: clipBytes(text ?? "", MAX_ANSWER_BYTES),
    citations: Array.isArray(answer.citations) ? answer.citations.length : 0,
  };
}

function adoptedRecord(raw: Database, jobId: string): MemoryJobView["adopted"] {
  const row = raw
    .query(
      "SELECT id,space_id,created_at FROM memory_records WHERE status='active' AND json_extract(metadata,'$.adopted_from_job')=? ORDER BY created_at,id LIMIT 1",
    )
    .get(jobId) as { id: string; space_id: string; created_at: number } | null;
  return row ? { recordId: row.id, spaceId: row.space_id, at: row.created_at } : null;
}

function canSeeJob(scope: MemoryObserverScope, job: JobRow): boolean {
  return (
    scope.privileged ||
    (!!scope.principalId &&
      (scope.principalId === job.requester_id || scope.principalId === job.worker_id))
  );
}

/** Project one job row. `content` adds task/answer — callers pass `canSeeJob`. */
function jobView(
  lookup: Lookup,
  job: JobRow,
  opts: { content: boolean; now?: number; task?: string },
): MemoryJobView {
  const now = opts.now ?? Date.now();
  const task = opts.task ?? jobTask(lookup.raw, job);
  const root = job.root_id === job.id ? job : (jobRow(lookup.raw, job.root_id) ?? job);
  const view: MemoryJobView = {
    id: job.id,
    state: job.state,
    workOpen: workOpen(lookup.raw, job, now),
    role: job.role,
    workerName: lookup.name(job.worker_id),
    requesterName: lookup.name(job.requester_id),
    spaceId: job.space_id,
    spaceName: lookup.space(job.space_id)?.name,
    rootId: job.root_id,
    parentId: job.parent_id,
    depth: job.depth,
    remainingOperations: root.remaining_operations,
    deadline: job.deadline,
    createdAt: job.created_at,
    marker: markerOf(task),
    adopted: job.result_record_id ? adoptedRecord(lookup.raw, job.id) : null,
  };
  if (opts.content) {
    if (task !== undefined) view.task = task;
    if (job.result_record_id) {
      const answer = jobAnswer(lookup.raw, job.result_record_id);
      if (answer) {
        view.answer = answer.answer;
        view.citations = answer.citations;
      }
    }
  }
  return view;
}

// ─── Jobs ───────────────────────────────────────────────────────────────────

export interface MemoryJobsQuery {
  state?: "open" | "all";
  role?: string;
  /** World entity name: only jobs it requested or works. */
  entity?: string;
  limit?: number;
  cursor?: string | null;
}

function decodeCursor(cursor: string | null | undefined): { t: number; id: string } {
  if (!cursor) return { t: Number.MAX_SAFE_INTEGER, id: "" };
  const parsed = parseJson<{ t?: unknown; id?: unknown }>(
    Buffer.from(cursor, "base64url").toString(),
  );
  const t = typeof parsed?.t === "number" && Number.isFinite(parsed.t) ? parsed.t : undefined;
  const id = typeof parsed?.id === "string" ? parsed.id : undefined;
  if (t === undefined || id === undefined) throw new Error("invalid cursor");
  return { t, id };
}

function encodeCursor(job: JobRow): string {
  return Buffer.from(JSON.stringify({ t: job.created_at, id: job.id })).toString("base64url");
}

/** Keyset-paged, observer-scoped job list. Never includes task/answer. */
export function listMemoryJobs(
  db: MarinaDB,
  scope: MemoryObserverScope,
  query: MemoryJobsQuery = {},
  now = Date.now(),
): { jobs: MemoryJobView[]; nextCursor: string | null } {
  const raw = rawDb(db);
  const lookup = new Lookup(raw);
  const limit = Math.min(Math.max(1, query.limit ?? 50), 200);
  const open = (query.state ?? "open") === "open";
  const self = scope.privileged ? null : (scope.principalId ?? "");
  const filterPrincipal = query.entity ? (lookup.principalOf(query.entity) ?? "") : null;
  const role = query.role?.trim() || null;
  const { t, id } = decodeCursor(query.cursor);
  const rows = raw
    .query(
      `SELECT ${JOB_COLUMNS} FROM memory_assistance_jobs
       WHERE (? IS NULL OR worker_id=? OR requester_id=?)
         AND (?=0 OR (state IN ('pending','running') AND deadline>?))
         AND (? IS NULL OR role=?)
         AND (? IS NULL OR worker_id=? OR requester_id=?)
         AND (created_at<? OR (created_at=? AND id>?))
       ORDER BY created_at DESC,id LIMIT ?`,
    )
    .all(
      self,
      self,
      self,
      open ? 1 : 0,
      now,
      role,
      role,
      filterPrincipal,
      filterPrincipal,
      filterPrincipal,
      t,
      t,
      id,
      limit + 1,
    ) as JobRow[];
  const page = rows.slice(0, limit);
  const jobs = page
    .filter((job) => canSeeJob(scope, job))
    .map((job) => jobView(lookup, job, { content: false, now }))
    .filter((job) => !open || job.workOpen);
  const last = page.at(-1);
  return { jobs, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
}

/** One job with task/answer when the principal may read them; undefined when out of scope. */
export function getMemoryJob(
  db: MarinaDB,
  scope: MemoryObserverScope,
  id: string,
  now = Date.now(),
): MemoryJobView | undefined {
  const raw = rawDb(db);
  const job = jobRow(raw, id);
  if (!job || !canSeeJob(scope, job)) return undefined;
  return jobView(new Lookup(raw), job, { content: true, now });
}

export type MemoryJobCancelResult =
  | { ok: true; job: MemoryJobView }
  | { ok: false; status: 403 | 404 | 409; error: string };

/**
 * Cancel a job as its requester. Allowed for the requester (delegated jobs
 * keep the root requester as `requester_id`) or an operator; the operation
 * itself runs through the requester's resident binding so the assistance
 * repository's own owner check and audit event apply unchanged.
 */
export async function cancelMemoryJob(
  db: MarinaDB,
  scope: MemoryObserverScope,
  id: string,
): Promise<MemoryJobCancelResult> {
  const raw = rawDb(db);
  const job = jobRow(raw, id);
  if (!job || !canSeeJob(scope, job)) return { ok: false, status: 404, error: "Job not found" };
  if (!scope.privileged && scope.principalId !== job.requester_id)
    return { ok: false, status: 403, error: "Only the requester or an operator may cancel" };
  const requester = db.getUser(job.requester_id);
  if (!requester)
    return { ok: false, status: 409, error: "The requester has no active world account" };
  try {
    await residentMemoryOperation(db, requester.name, { operation: "assist_cancel", id });
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "cancel_failed";
    return { ok: false, status: 409, error: code };
  }
  const fresh = jobRow(raw, id) ?? job;
  return { ok: true, job: jobView(new Lookup(raw), fresh, { content: true }) };
}

// ─── Overview ───────────────────────────────────────────────────────────────

interface ResolutionRow {
  id: string;
  space_id: string;
  space_name: string;
  owner_id: string;
  policy: string;
  status: string;
  actor_id: string;
  rationale: string;
  created_at: number;
}

function resolutionRows(raw: Database, scope: MemoryObserverScope, limit: number): ResolutionRow[] {
  const self = scope.privileged ? null : (scope.principalId ?? "");
  return raw
    .query(
      `SELECT x.id,x.space_id,s.name AS space_name,s.owner_id,x.policy,x.status,x.actor_id,x.rationale,x.created_at
       FROM memory_resolutions x JOIN memory_spaces s ON s.id=x.space_id
       WHERE (? IS NULL OR s.owner_id=? OR x.actor_id=?
              OR EXISTS (SELECT 1 FROM memory_grants g WHERE g.space_id=x.space_id AND g.principal_id=?))
       ORDER BY x.created_at DESC,x.id LIMIT ?`,
    )
    .all(self, self, self, self, limit) as ResolutionRow[];
}

function resolutionMembers(
  raw: Database,
  id: string,
): { record_id: string; role: "winner" | "superseded" | "peer" | "pending" }[] {
  return raw
    .query(
      "SELECT record_id,role FROM memory_resolution_members WHERE resolution_id=? ORDER BY role,record_id",
    )
    .all(id) as { record_id: string; role: "winner" | "superseded" | "peer" | "pending" }[];
}

function resolutionView(lookup: Lookup, row: ResolutionRow): MemoryResolutionView {
  const members = resolutionMembers(lookup.raw, row.id);
  return {
    id: row.id,
    policy: row.policy,
    spaceId: row.space_id,
    spaceName: row.space_name,
    actorName: lookup.name(row.actor_id),
    at: row.created_at,
    winnerId: members.find((m) => m.role === "winner")?.record_id ?? null,
    loserIds: members.filter((m) => m.role === "superseded").map((m) => m.record_id),
    // In-scope rows are the caller's own spaces (or an operator's view), so
    // the rationale is readable whenever the row itself is.
    rationale: row.rationale,
  };
}

interface RatifiedRow {
  id: string;
  space_id: string;
  space_name: string;
  metadata: string;
  created_at: number;
  content: string | null;
}

function ratifiedRows(raw: Database, limit: number, byName?: string): RatifiedRow[] {
  return raw
    .query(
      `SELECT r.id,r.space_id,s.name AS space_name,r.metadata,r.created_at,n.content
       FROM memory_records r JOIN memory_spaces s ON s.id=r.space_id
       LEFT JOIN notes n ON n.id=r.current_note_id
       WHERE r.status='active' AND s.status='active'
         AND json_extract(s.metadata,'$.institutional')=1
         AND json_extract(r.metadata,'$.ratified_by') IS NOT NULL
         AND (? IS NULL OR json_extract(r.metadata,'$.ratified_by.name')=? COLLATE NOCASE)
       ORDER BY r.created_at DESC,r.id LIMIT ?`,
    )
    .all(byName ?? null, byName ?? null, limit) as RatifiedRow[];
}

function ratificationView(row: RatifiedRow): MemoryRatificationView {
  const meta = parseJson<{ ratified_by?: { name?: string; standing?: number; basis?: string } }>(
    row.metadata,
  );
  const by = meta?.ratified_by ?? {};
  return {
    recordId: row.id,
    spaceId: row.space_id,
    spaceName: row.space_name,
    ratifiedBy: {
      name: String(by.name ?? ""),
      standing: typeof by.standing === "number" ? by.standing : 0,
      basis: String(by.basis ?? ""),
    },
    at: row.created_at,
    ...(row.content ? { preview: clip(row.content, MAX_PREVIEW_CHARS) } : {}),
  };
}

function receiptViews(
  engine: Engine,
  scope: MemoryObserverScope,
  limit: number,
): MemoryReceiptView[] {
  const byRequest = new Map<string, MemoryReceiptView>();
  const events = engine.getEventLog();
  for (let i = events.length - 1; i >= 0 && byRequest.size < limit; i--) {
    const event = events[i]!;
    if (event.type !== "model_request_lifecycle" || !event.memoryReceipt) continue;
    if (byRequest.has(event.requestId)) continue;
    const receipt: MemoryReceipt | undefined = parseMemoryReceipt(event.memoryReceipt);
    if (!receipt) continue;
    if (!scope.privileged && receipt.entity !== scope.entityName) continue;
    byRequest.set(event.requestId, {
      requestId: receipt.requestId,
      entity: receipt.entity,
      surface: event.routeKind ?? "passthru",
      tiers: receipt.tiers.map((tier) => ({
        tier: tier.tier,
        count: tier.ids.length,
        bytes: tier.bytes,
      })),
      usedBytes: receipt.usedBytes,
      budgetBytes: receipt.budgetBytes,
      truncated: receipt.truncated,
      cacheHit: event.target === "response-cache",
      at: event.timestamp,
    });
  }
  return [...byRequest.values()];
}

export function buildMemoryOverview(
  engine: Engine,
  scope: MemoryObserverScope,
  now = Date.now(),
): MemoryOverview {
  const db = engine.db;
  const trust = computeTrustProfile();
  const overview: MemoryOverview = {
    trust: { profile: trust.profile, ungated: trust.ungated, autonomy: trust.autonomy },
    hygiene: [],
    jobs: { open: 0, answered24h: 0, abstained24h: 0, cancelled24h: 0, byMarker: {} },
    resolutions: [],
    ratifications: [],
    credits: [],
    receipts: { recent: receiptViews(engine, scope, 20), cache: { ...responseCacheCounters } },
    dispatch: { accumulationJobs24h: 0, sharedWriteJobs24h: 0, hygieneJobs24h: 0 },
    spaces: { institutional: [] },
  };
  if (!db) return overview;
  const raw = rawDb(db);
  const lookup = new Lookup(raw);
  const self = scope.privileged ? null : (scope.principalId ?? "");
  const selfName = scope.privileged ? null : (scope.entityName ?? "");

  // Hygiene: latest `[hygiene]` process line per entity (own line for a resident).
  const seenHygiene = new Set<string>();
  const hygieneRows = raw
    .query(
      `SELECT entity_name,content,created_at FROM notes
       WHERE tier='process' AND pool_id IS NULL AND content LIKE ? AND (? IS NULL OR entity_name=?)
       ORDER BY created_at DESC,id DESC LIMIT 400`,
    )
    .all(`${HYGIENE_NOTE_PREFIX}%`, selfName, selfName) as {
    entity_name: string;
    content: string;
    created_at: number;
  }[];
  for (const row of hygieneRows) {
    if (seenHygiene.has(row.entity_name) || seenHygiene.size >= 50) continue;
    seenHygiene.add(row.entity_name);
    overview.hygiene.push({ entityName: row.entity_name, line: row.content, at: row.created_at });
  }

  // Jobs: open (live) by marker, plus final states for jobs created in the last 24 h.
  const openRows = raw
    .query(
      `SELECT ${JOB_COLUMNS} FROM memory_assistance_jobs
       WHERE (? IS NULL OR worker_id=? OR requester_id=?)
         AND state IN ('pending','running') AND deadline>?
       ORDER BY created_at DESC LIMIT 500`,
    )
    .all(self, self, self, now) as JobRow[];
  for (const job of openRows) {
    if (!workOpen(raw, job, now)) continue;
    overview.jobs.open++;
    const marker = markerOf(jobTask(raw, job)) ?? "manual";
    overview.jobs.byMarker[marker] = (overview.jobs.byMarker[marker] ?? 0) + 1;
  }
  const since = now - DAY_MS;
  const recentRows = raw
    .query(
      `SELECT j.state,json_extract(s.body,'$.task') AS task
       FROM memory_assistance_jobs j JOIN memory_sources s ON s.id=j.input_source_id
       WHERE (? IS NULL OR j.worker_id=? OR j.requester_id=?) AND j.created_at>=?`,
    )
    .all(self, self, self, since) as { state: string; task: string | null }[];
  for (const row of recentRows) {
    if (row.state === "answered") overview.jobs.answered24h++;
    else if (row.state === "abstained") overview.jobs.abstained24h++;
    else if (row.state === "cancelled") overview.jobs.cancelled24h++;
    const marker = markerOf(row.task);
    if (marker === "accumulation") overview.dispatch.accumulationJobs24h++;
    else if (marker === "shared-write-review") overview.dispatch.sharedWriteJobs24h++;
    else if (marker === "hygiene") overview.dispatch.hygieneJobs24h++;
  }

  overview.resolutions = resolutionRows(raw, scope, 20).map((row) => resolutionView(lookup, row));
  overview.ratifications = ratifiedRows(raw, 20).map(ratificationView);

  overview.credits = (
    raw
      .query(
        `SELECT entity_name,kind,ref,amount,earned_at FROM entity_standing
         WHERE kind IN (${CREDIT_KINDS.map(() => "?").join(",")}) AND (? IS NULL OR entity_id=?)
         ORDER BY earned_at DESC,id DESC LIMIT 20`,
      )
      .all(...CREDIT_KINDS, self, self) as {
      entity_name: string;
      kind: string;
      ref: string;
      amount: number;
      earned_at: number;
    }[]
  ).map(
    (row): MemoryCreditView => ({
      kind: row.kind,
      entityName: row.entity_name,
      amount: row.amount,
      ref: row.ref,
      at: row.earned_at,
    }),
  );

  overview.spaces.institutional = raw
    .query(
      `SELECT s.id,s.name,
         (SELECT count(*) FROM memory_records r WHERE r.space_id=s.id AND r.status='active') AS records,
         (SELECT count(*) FROM memory_records r WHERE r.space_id=s.id AND r.status='active'
            AND json_extract(r.metadata,'$.ratified_by') IS NOT NULL) AS ratified
       FROM memory_spaces s
       WHERE s.status='active' AND json_extract(s.metadata,'$.institutional')=1
       ORDER BY s.name,s.id`,
    )
    .all() as { id: string; name: string; records: number; ratified: number }[];
  return overview;
}

// ─── Graph (memory MAP) ─────────────────────────────────────────────────────

export interface MemoryGraphQuery {
  entity?: string;
  limit?: number;
}

class GraphBuilder {
  readonly nodes = new Map<string, MemoryGraphNode>();
  readonly edges = new Map<string, MemoryGraphEdge>();
  truncated = false;

  node(node: MemoryGraphNode): MemoryGraphNode {
    const existing = this.nodes.get(node.id);
    if (existing) {
      // Later, richer projections fill blanks but never overwrite a set field.
      for (const [key, value] of Object.entries(node)) {
        if (value !== undefined && (existing as Record<string, unknown>)[key] === undefined)
          (existing as Record<string, unknown>)[key] = value;
      }
      if (node.meta) existing.meta = { ...node.meta, ...existing.meta };
      return existing;
    }
    this.nodes.set(node.id, node);
    return node;
  }

  edge(source: string, target: string, relationship: MemoryGraphEdge["relationship"]): void {
    if (source === target) return;
    const id = `${relationship}:${source}->${target}`;
    if (!this.edges.has(id)) this.edges.set(id, { id, source, target, relationship });
  }

  build(): MemoryGraph {
    return {
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
      truncated: this.truncated,
    };
  }
}

const noteNodeId = (id: number) => `note:${id}`;
const recordNodeId = (id: string) => `record:${id}`;
const jobNodeId = (id: string) => `job:${id}`;
const proposalNodeId = (id: string) => `proposal:${id}`;
const resolutionNodeId = (id: string) => `resolution:${id}`;
const spaceNodeId = (id: string) => `space:${id}`;
const helperNodeId = (name: string) => `helper:${name}`;

function chunked<T>(items: T[], size = 400): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Record ids → (space, version, status) in bulk. */
function recordRows(
  raw: Database,
  ids: string[],
): Map<string, { space_id: string; version: number; status: string; created_at: number }> {
  const out = new Map<
    string,
    { space_id: string; version: number; status: string; created_at: number }
  >();
  for (const chunk of chunked(ids)) {
    const rows = raw
      .query(
        `SELECT id,space_id,version,status,created_at FROM memory_records WHERE id IN (${chunk.map(() => "?").join(",")})`,
      )
      .all(...chunk) as {
      id: string;
      space_id: string;
      version: number;
      status: string;
      created_at: number;
    }[];
    for (const row of rows) out.set(row.id, row);
  }
  return out;
}

interface NoteLinkRow {
  source_id: number;
  target_id: number;
  relationship: string;
}

/** Most-recent legacy notes (never `memory:*` service notes) + the links among them. */
function legacyNoteSnapshot(
  raw: Database,
  limit: number,
  entity?: string,
): { notes: NoteRow[]; links: NoteLinkRow[] } {
  const notes = raw
    .query(
      `SELECT * FROM notes
       WHERE entity_name NOT LIKE 'memory:%' AND (? IS NULL OR entity_name=? COLLATE NOCASE)
       ORDER BY COALESCE(last_accessed, created_at) DESC, id DESC LIMIT ?`,
    )
    .all(entity ?? null, entity ?? null, limit) as NoteRow[];
  if (notes.length === 0) return { notes, links: [] };
  const links: NoteLinkRow[] = [];
  for (const chunk of chunked(notes.map((n) => n.id))) {
    const marks = chunk.map(() => "?").join(",");
    links.push(
      ...(raw
        .query(
          `SELECT source_id,target_id,relationship FROM note_links WHERE source_id IN (${marks}) OR target_id IN (${marks})`,
        )
        .all(...chunk, ...chunk) as NoteLinkRow[]),
    );
  }
  return { notes, links };
}

export function buildMemoryGraph(
  engine: Engine,
  scope: MemoryObserverScope,
  query: MemoryGraphQuery = {},
  now = Date.now(),
): MemoryGraph {
  const graph = new GraphBuilder();
  const db = engine.db;
  if (!db) return graph.build();
  const raw = rawDb(db);
  const lookup = new Lookup(raw);
  const limit = Math.min(Math.max(1, query.limit ?? 400), 2000);
  const entity = query.entity?.trim() || undefined;
  const entityLower = entity?.toLowerCase();
  const entityPrincipal = entity ? (lookup.principalOf(entity) ?? "") : undefined;
  const pendingRecords = new Set<string>();
  const recordNode = (id: string, extra: Partial<MemoryGraphNode> = {}) => {
    pendingRecords.add(id);
    return graph.node({
      id: recordNodeId(id),
      kind: "record",
      label: `record ${id.slice(0, 8)}`,
      ...extra,
    });
  };
  const runningHelpers = new Map<string, string>();
  for (const agent of engine.agentRuntime.list()) {
    if (agent.role?.startsWith("memory-")) runningHelpers.set(agent.name, agent.role);
  }
  const personNode = (name: string) =>
    graph.node({
      id: helperNodeId(name),
      kind: "helper",
      label: name,
      entityName: name,
      role: runningHelpers.get(name),
      meta: { helper: runningHelpers.has(name) },
    });

  // 1. Legacy notes (existing /api/graph semantics: recent notes + links,
  //    observer-read). Durable service notes (`memory:<principal>`) are
  //    excluded here — they appear as `record:` nodes via twins/citations.
  const snapshot = legacyNoteSnapshot(raw, limit + 1, entity);
  const notes: NoteRow[] = [];
  for (const note of snapshot.notes) {
    if (!scope.readNote(note)) continue;
    if (notes.length >= limit) {
      graph.truncated = true;
      break;
    }
    notes.push(note);
  }
  const noteIds = new Set(notes.map((n) => n.id));
  for (const note of notes) {
    graph.node({
      id: noteNodeId(note.id),
      kind: "note",
      label: clip(note.content, NOTE_LABEL_CHARS),
      entityName: note.entity_name,
      tier: note.tier,
      at: note.created_at,
      meta: {
        importance: note.importance,
        noteType: note.note_type,
        poolId: note.pool_id,
        verification: note.verification_status ?? null,
      },
    });
    if (note.supersedes_id && noteIds.has(note.supersedes_id))
      graph.edge(noteNodeId(note.id), noteNodeId(note.supersedes_id), "supersedes");
  }
  for (const link of snapshot.links) {
    if (!noteIds.has(link.source_id) || !noteIds.has(link.target_id)) continue;
    const relationship = GRAPH_RELATIONSHIPS.has(
      link.relationship as MemoryGraphEdge["relationship"],
    )
      ? (link.relationship as MemoryGraphEdge["relationship"])
      : "related_to";
    graph.edge(noteNodeId(link.source_id), noteNodeId(link.target_id), relationship);
  }
  // Twins: note_sources rows with the durable url scheme.
  const twinOfRecord = new Map<string, number>();
  for (const chunk of chunked([...noteIds])) {
    const rows = raw
      .query(
        `SELECT note_id,url FROM note_sources WHERE url LIKE ? AND note_id IN (${chunk.map(() => "?").join(",")})`,
      )
      .all(`${DURABLE_TWIN_URL_PREFIX}%`, ...chunk) as { note_id: number; url: string }[];
    for (const row of rows) {
      const recordId = parseDurableTwinUrl(row.url);
      if (!recordId) continue;
      recordNode(recordId, { meta: { twin: true } });
      twinOfRecord.set(recordId, row.note_id);
      graph.edge(noteNodeId(row.note_id), recordNodeId(recordId), "twin");
    }
  }

  // 2. Jobs (scoped; entity filter = requester or worker), proposals, citations, adoption.
  const self = scope.privileged ? null : (scope.principalId ?? "");
  const jobCap = Math.min(limit, 200);
  const jobRows = raw
    .query(
      `SELECT ${JOB_COLUMNS} FROM memory_assistance_jobs
       WHERE (? IS NULL OR worker_id=? OR requester_id=?)
         AND (? IS NULL OR worker_id=? OR requester_id=?)
       ORDER BY created_at DESC,id LIMIT ?`,
    )
    .all(
      self,
      self,
      self,
      entityPrincipal ?? null,
      entityPrincipal ?? null,
      entityPrincipal ?? null,
      jobCap + 1,
    ) as JobRow[];
  if (jobRows.length > jobCap) graph.truncated = true;
  for (const job of jobRows.slice(0, jobCap)) {
    if (!canSeeJob(scope, job)) continue;
    const view = jobView(lookup, job, { content: false, now });
    graph.node({
      id: jobNodeId(job.id),
      kind: "job",
      label: `${view.role} · ${view.state}`,
      state: view.state,
      role: view.role,
      spaceId: view.spaceId,
      entityName: view.requesterName,
      at: view.createdAt,
      meta: {
        marker: view.marker ?? null,
        depth: view.depth,
        workOpen: view.workOpen,
        rootId: view.rootId,
        parentId: view.parentId,
      },
    });
    personNode(view.workerName);
    personNode(view.requesterName);
    graph.edge(jobNodeId(job.id), helperNodeId(view.workerName), "worker");
    graph.edge(jobNodeId(job.id), helperNodeId(view.requesterName), "requester");
    if (job.parent_id) graph.edge(jobNodeId(job.id), jobNodeId(job.parent_id), "part_of");
    if (!job.result_record_id) continue;
    const proposalId = proposalNodeId(job.result_record_id);
    graph.node({
      id: proposalId,
      kind: "proposal",
      label: `${view.role} proposal · ${view.state}`,
      state: view.state,
      role: view.role,
      spaceId: job.space_id,
      entityName: view.workerName,
      meta: { jobId: job.id, recordId: job.result_record_id },
    });
    graph.edge(proposalId, jobNodeId(job.id), "derived_from");
    const cited = raw
      .query(
        "SELECT depends_on_id FROM memory_dependencies WHERE record_id=? ORDER BY depends_on_id",
      )
      .all(job.result_record_id) as { depends_on_id: string }[];
    for (const { depends_on_id } of cited) {
      recordNode(depends_on_id, { meta: { cited: true } });
      graph.edge(proposalId, recordNodeId(depends_on_id), "cites");
      // Cited record's legacy twin, when readable and not already on the map.
      if (!twinOfRecord.has(depends_on_id)) {
        const twinRows = raw
          .query("SELECT note_id FROM note_sources WHERE url=? ORDER BY note_id DESC LIMIT 1")
          .all(`${DURABLE_TWIN_URL_PREFIX}${depends_on_id}`) as { note_id: number }[];
        const twin = twinRows[0] ? db.getNote(twinRows[0].note_id) : undefined;
        if (twin && scope.readNote(twin) && !twin.entity_name.startsWith("memory:")) {
          graph.node({
            id: noteNodeId(twin.id),
            kind: "note",
            label: clip(twin.content, NOTE_LABEL_CHARS),
            entityName: twin.entity_name,
            tier: twin.tier,
            at: twin.created_at,
          });
          twinOfRecord.set(depends_on_id, twin.id);
          graph.edge(noteNodeId(twin.id), recordNodeId(depends_on_id), "twin");
        }
      }
    }
    if (view.adopted) {
      recordNode(view.adopted.recordId, {
        spaceId: view.adopted.spaceId,
        at: view.adopted.at,
        meta: { adopted: true },
      });
      graph.edge(proposalId, recordNodeId(view.adopted.recordId), "adopted_as");
      if (lookup.institutional(view.adopted.spaceId))
        graph.edge(
          recordNodeId(view.adopted.recordId),
          spaceNodeId(view.adopted.spaceId),
          "in_space",
        );
    }
  }

  // 3. Resolutions (scoped; entity filter = actor or space owner).
  const resolutionCap = Math.min(limit, 100);
  const resolutions = resolutionRows(raw, scope, resolutionCap + 1).filter(
    (row) =>
      entityPrincipal === undefined ||
      row.actor_id === entityPrincipal ||
      row.owner_id === entityPrincipal,
  );
  if (resolutions.length > resolutionCap) graph.truncated = true;
  for (const row of resolutions.slice(0, resolutionCap)) {
    const id = resolutionNodeId(row.id);
    graph.node({
      id,
      kind: "resolution",
      label: row.policy,
      policy: row.policy,
      state: row.status,
      spaceId: row.space_id,
      entityName: lookup.name(row.actor_id),
      at: row.created_at,
    });
    const members = resolutionMembers(raw, row.id);
    const winner = members.find((m) => m.role === "winner")?.record_id;
    if (winner) {
      recordNode(winner, { meta: { winner: true } });
      graph.edge(id, recordNodeId(winner), "resolves");
    }
    for (const member of members) {
      if (member.role === "winner") continue;
      recordNode(member.record_id);
      if (member.role === "superseded")
        graph.edge(
          recordNodeId(member.record_id),
          winner ? recordNodeId(winner) : id,
          "superseded_by",
        );
      else graph.edge(id, recordNodeId(member.record_id), "related_to");
    }
  }

  // 4. Institutional spaces + ratified records (public-read ⇒ preview allowed).
  const spaces = raw
    .query(
      "SELECT id,name,owner_id,metadata FROM memory_spaces WHERE status='active' AND json_extract(metadata,'$.institutional')=1 ORDER BY name,id",
    )
    .all() as SpaceRow[];
  const ratifiedCap = Math.min(limit, 200);
  const ratified = ratifiedRows(raw, ratifiedCap + 1, entity);
  if (ratified.length > ratifiedCap) graph.truncated = true;
  const spacesInUse = new Set(ratified.slice(0, ratifiedCap).map((r) => r.space_id));
  for (const space of spaces) {
    if (
      entity &&
      !spacesInUse.has(space.id) &&
      ![...graph.nodes.values()].some((n) => n.spaceId === space.id)
    )
      continue;
    graph.node({
      id: spaceNodeId(space.id),
      kind: "space",
      label: space.name,
      spaceId: space.id,
      institutional: true,
      entityName: lookup.name(space.owner_id),
    });
  }
  for (const row of ratified.slice(0, ratifiedCap)) {
    const view = ratificationView(row);
    recordNode(row.id, {
      spaceId: row.space_id,
      at: row.created_at,
      institutional: true,
      label: view.preview ? clip(view.preview, NOTE_LABEL_CHARS) : undefined,
      meta: {
        ratified: true,
        ratifiedBy: view.ratifiedBy.name,
        basis: view.ratifiedBy.basis,
        ...(view.preview ? { preview: view.preview } : {}),
      },
    });
    graph.node({
      id: spaceNodeId(row.space_id),
      kind: "space",
      label: row.space_name,
      spaceId: row.space_id,
      institutional: true,
    });
    graph.edge(recordNodeId(row.id), spaceNodeId(row.space_id), "in_space");
  }

  // 5. Running helper agents (unfiltered unless an entity filter names them).
  for (const [name] of runningHelpers) {
    if (entityLower && name.toLowerCase() !== entityLower) continue;
    personNode(name);
  }

  // Fill record metadata in bulk (space, version, status) — no content unless institutional.
  const records = recordRows(raw, [...pendingRecords]);
  for (const id of pendingRecords) {
    const node = graph.nodes.get(recordNodeId(id));
    const row = records.get(id);
    if (!node || !row) continue;
    node.spaceId ??= row.space_id;
    node.at ??= row.created_at;
    node.state ??= row.status;
    node.institutional ??= lookup.institutional(row.space_id);
    node.meta = { ...node.meta, version: row.version };
  }
  return graph.build();
}

// ─── Poller (engine tick → WebSocket) ───────────────────────────────────────

/** Poll cadence target; the engine converts it to ticks via `memoryObservabilityPollTicks`. */
export const MEMORY_OBSERVABILITY_POLL_MS = 2000;
/** Rows consumed per poll — keeps one tick bounded even after a burst. */
export const MEMORY_OBSERVABILITY_POLL_ROWS = 200;

/** Durable service operations broadcast as `memory_service_event` (ids/names only). */
export const MEMORY_SERVICE_EVENT_KINDS: ReadonlySet<string> = new Set([
  "memory.resolved",
  "assistance.adopted",
  "assistance.abstention_confirmed",
  "memory.forgotten",
  "space.forgotten",
  "space.created",
  "grant.set",
  "grant.revoked",
]);

export function memoryObservabilityPollTicks(tickIntervalMs: number): number {
  return Math.max(1, Math.round(MEMORY_OBSERVABILITY_POLL_MS / Math.max(1, tickIntervalMs)));
}

interface PollerState {
  lastSeq: number;
}
const pollers = new WeakMap<Engine, PollerState>();

interface ServiceEventRow {
  seq: number;
  space_id: string;
  operation: string;
  reference_id: string | null;
  version: number | null;
  actor_id: string;
  created_at: number;
}

/**
 * Emit `memory_job` / `memory_service_event` engine events for every durable
 * service event since the previous poll. The first call only primes the
 * cursor at the current head (no replay of history on boot). Synchronous;
 * O(new rows) with a per-call cap.
 */
export function pollMemoryEvents(
  engine: Engine,
  opts: { maxRows?: number; now?: number } = {},
): number {
  const db = engine.db;
  if (!db) return 0;
  const raw = rawDb(db);
  let state = pollers.get(engine);
  if (!state) {
    const head = raw
      .query("SELECT COALESCE(MAX(seq),0) AS seq FROM memory_service_events")
      .get() as {
      seq: number;
    };
    state = { lastSeq: head.seq };
    pollers.set(engine, state);
    return 0;
  }
  const rows = raw
    .query(
      "SELECT seq,space_id,operation,reference_id,version,actor_id,created_at FROM memory_service_events WHERE seq>? ORDER BY seq LIMIT ?",
    )
    .all(state.lastSeq, opts.maxRows ?? MEMORY_OBSERVABILITY_POLL_ROWS) as ServiceEventRow[];
  if (rows.length === 0) return 0;
  const lookup = new Lookup(raw);
  const now = opts.now ?? Date.now();
  let emitted = 0;
  const serviceEvent = (row: ServiceEventRow): EngineEvent => {
    const space = lookup.space(row.space_id);
    return {
      type: "memory_service_event",
      kind: row.operation,
      spaceId: row.space_id,
      spaceName: space?.name,
      ownerName: space ? lookup.name(space.owner_id) : undefined,
      referenceId: row.reference_id ?? undefined,
      version: row.version ?? undefined,
      actorName: lookup.name(row.actor_id),
      seq: row.seq,
      timestamp: row.created_at,
    };
  };
  for (const row of rows) {
    state.lastSeq = row.seq;
    if (row.operation.startsWith("assistance.") && row.reference_id) {
      const job = jobRow(raw, row.reference_id);
      if (job) {
        const {
          task: _task,
          answer: _answer,
          citations: _citations,
          ...view
        } = jobView(lookup, job, { content: false, now });
        engine.logEvent({ type: "memory_job", job: view, timestamp: row.created_at });
        emitted++;
      }
    }
    if (MEMORY_SERVICE_EVENT_KINDS.has(row.operation)) {
      engine.logEvent(serviceEvent(row));
      emitted++;
    }
  }
  return emitted;
}

/** Test seam: forget the poller cursor so the next call re-primes at the head. */
export function resetMemoryObservabilityPoller(engine: Engine): void {
  pollers.delete(engine);
}
