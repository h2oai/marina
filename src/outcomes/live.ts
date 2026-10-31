// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live work on the outcome path: a task creator's verdict on a submission and
 * a Code Mode verification run are resolved results like any forecast. Each is
 * recorded once (`recordResolved`) with who did the work and on what model and
 * role, so lessons (scoped to whose work it was) and selection evidence learn
 * from what agents actually get done, not only from benchmarks.
 *
 * Only labels and numbers are recorded; the task text and command output stay
 * on their own rows and are read back as private context when a lesson is
 * judged.
 */

import { effectiveThinkingLevel } from "../agent/effective-thinking";
import { recordVerified, type VerifiedCredit } from "../agent/standing";
import { recordJudgeOpinion } from "../decisions/judges";
import { canonicalFormationName } from "../orchestration/formations/catalogue";
import type { MarinaDB } from "../persistence/database";
import type { JudgeObservationInput } from "../persistence/db-decisions";
import type { EngineEvent, EntityId } from "../types";
import { recordResolved } from "./record";
import { canScope, type WorkKind, workRefs } from "./work-refs";

/** `family:` / `method:` / `scope:` refs for `actor`'s work of `kind` (see `./work-refs.ts`). */
export function workRefsFor(
  db: MarinaDB,
  kind: WorkKind,
  actor: string,
  approach: readonly string[] = [],
): string[] {
  const p = participantOf(db, actor);
  return workRefs(canScope(db) ? db : undefined, {
    kind,
    actor,
    ...(p.model ? { model: p.model, thinking: thinkingOf(db, actor) } : {}),
    ...(p.role ? { role: p.role } : {}),
    approach,
  });
}

/** Where the way a task is being worked is kept between claim and verdict (core memory, labels only). */
export const TASK_APPROACH_OWNER = "work:approach";

/** A task's crew binding: the crew `crew dispatch` handed it to (labels only). */
export interface TaskCrewBinding {
  crew: string;
  name: string;
  formation: string;
}

const crewBindingKey = (taskId: number) => `crew-task:${taskId}`;

/**
 * Bind a task to the crew it was dispatched to (`crew dispatch`), kept beside
 * the claim-time approach notes. The binding outlives a one-off crew, so the
 * verdict is still tagged with the formation that did the work.
 */
export function bindTaskToCrew(
  db: Pick<MarinaDB, "setCoreMemory">,
  taskId: number,
  binding: TaskCrewBinding,
): void {
  db.setCoreMemory(TASK_APPROACH_OWNER, crewBindingKey(taskId), JSON.stringify(binding));
}

/** The crew a task was dispatched to, if any. */
export function taskCrewBinding(
  db: Partial<Pick<MarinaDB, "getCoreMemory">>,
  taskId: number,
): TaskCrewBinding | undefined {
  if (!db.getCoreMemory) return undefined;
  try {
    const raw = db.getCoreMemory(TASK_APPROACH_OWNER, crewBindingKey(taskId))?.value;
    const parsed = raw ? (JSON.parse(raw) as Partial<TaskCrewBinding>) : undefined;
    if (parsed && typeof parsed.formation === "string" && parsed.formation)
      return {
        crew: String(parsed.crew ?? ""),
        name: String(parsed.name ?? ""),
        formation: parsed.formation,
      };
  } catch {
    // allow-empty-catch: an unreadable binding reads as no binding
  }
  return undefined;
}

/**
 * Record, at claim time, how a task is being worked: `crew:<formation>` of
 * the crew the task was dispatched to (`bindTaskToCrew`); with no binding,
 * `crew:<formation>` for each live crew the claimant is in, else `solo`.
 * Taken at claim because a one-off crew is never persisted and dissolves when
 * it completes — long before the creator's verdict.
 */
export function noteTaskApproach(
  db: Pick<MarinaDB, "setCoreMemory"> & Partial<Pick<MarinaDB, "getCoreMemory">>,
  input: { taskId: number; claimant: string; formations: readonly string[] },
): void {
  const bound = taskCrewBinding(db, input.taskId);
  const formations = bound ? [bound.formation] : [...new Set(input.formations.filter(Boolean))];
  db.setCoreMemory(
    TASK_APPROACH_OWNER,
    `task:${input.taskId}:${input.claimant}`,
    JSON.stringify(
      formations.length ? formations.map((f) => `crew:${canonicalFormationName(f)}`) : ["solo"],
    ),
  );
}

/**
 * How a task was worked: what was recorded when it was claimed
 * (`noteTaskApproach`), else the crew the task was dispatched to, else
 * `crew:<formation>` for each persisted crew the claimant belongs to, else
 * `solo`.
 */
export function taskApproach(
  db: Pick<MarinaDB, "getCrewsForAgent"> & Partial<Pick<MarinaDB, "getCoreMemory">>,
  claimant: string,
  taskId?: number,
): string[] {
  if (taskId !== undefined && db.getCoreMemory) {
    try {
      const noted = db.getCoreMemory(TASK_APPROACH_OWNER, `task:${taskId}:${claimant}`)?.value;
      const parsed = noted ? (JSON.parse(noted) as unknown) : undefined;
      if (Array.isArray(parsed) && parsed.length && parsed.every((x) => typeof x === "string"))
        return parsed as string[];
    } catch {
      // allow-empty-catch: an unreadable note falls back to the crews on record
    }
    const bound = taskCrewBinding(db, taskId);
    if (bound) return [`crew:${canonicalFormationName(bound.formation)}`];
  }
  let crews: { formation: string }[] = [];
  try {
    crews = db.getCrewsForAgent(claimant);
  } catch {
    // allow-empty-catch: no crew store (older test doubles) reads as solo work
  }
  const formations = [...new Set(crews.map((c) => c.formation).filter(Boolean))];
  return formations.length ? formations.map((f) => `crew:${canonicalFormationName(f)}`) : ["solo"];
}

/** Who did the work, and on what (an agent's model and role; a person's name only). */
export function participantOf(
  db: Pick<MarinaDB, "getAgentConfig"> &
    Partial<Pick<MarinaDB, "findEntityIdByName" | "loadEntity">>,
  name: string,
): { agent: string; model?: string; role?: string } {
  const config = db.getAgentConfig(name);
  // An external participant has no config: its model is what it declared at
  // login (`KnownProperties.declared_model`), kept with its persisted entity.
  const model = config?.model ?? declaredModelOf(db, name);
  return {
    agent: name,
    ...(model ? { model } : {}),
    ...(config?.role ? { role: config.role } : {}),
  };
}

function declaredModelOf(
  db: Partial<Pick<MarinaDB, "findEntityIdByName" | "loadEntity">>,
  name: string,
): string | undefined {
  const id = db.findEntityIdByName?.(name);
  const declared = id ? db.loadEntity?.(id as EntityId)?.properties.declared_model : undefined;
  return typeof declared === "string" && declared ? declared : undefined;
}

/**
 * The thinking level an agent works with (`effectiveThinkingLevel`): what its
 * running process sends, else its saved level, else the instance default,
 * else `off`. Tagged `method:thinking:<level>` beside its model.
 */
export function thinkingOf(db: Pick<MarinaDB, "getAgentConfig">, name: string): string {
  return effectiveThinkingLevel(name, db.getAgentConfig(name)?.thinking_level);
}

/** The subject a task attempt's outcomes share: `task:<id>:<claimant>`. */
export const taskBase = (taskId: number, claimant: string) => `task:${taskId}:${claimant}`;

/** Both judges settle the same submission, regardless of when their calls finish. */
export const taskOpinionSubject = (taskId: number, claimant: string, submittedAt: number) =>
  `judged:${taskBase(taskId, claimant)}:submission:${submittedAt}`;

export function hasTaskOpinion(
  db: MarinaDB,
  taskId: number,
  claimant: string,
  submittedAt: number,
): boolean {
  if (db.getOutcomeBySubject(taskOpinionSubject(taskId, claimant, submittedAt))) return true;
  const prefix = `judged:${taskBase(taskId, claimant)}:`;
  // Preserve opinions written before submission identities were introduced.
  // A prose review's opinion (`prose:<t>`) is its own judge, never this one.
  return db.listOutcomes({ subjectPrefix: prefix, limit: 20 }).some((o) => {
    const rest = o.subject.slice(prefix.length);
    return (
      !rest.startsWith("submission:") && !rest.startsWith("prose:") && o.resolved_at >= submittedAt
    );
  });
}

/**
 * A fresh prose review's verdict on a task attempt as a JUDGED outcome: a
 * contradiction found is `fail`, no finding over readable sources is `pass`, a
 * review that left something unchecked (`unverified`) is no opinion. Recorded,
 * never delivered — `prose-review:<model>` teaches only once it has earned
 * agreement with creators' verdicts (the attempt's next verdict settles it,
 * `truthKeyOfJudged`). The task must have a live attempt; the reviewer's own
 * identity is not the attempt's.
 */
export function recordProseReviewOpinion(
  db: MarinaDB,
  input: {
    taskId: number;
    model: string;
    outcome: string;
    findings: ReadonlyArray<{ status: string }>;
    at: number;
  },
): void {
  const claim = db
    .getTaskClaims(input.taskId)
    .find((row) => row.status === "claimed" || row.status === "submitted");
  if (!claim) return;
  const opinion = input.findings.some((f) => f.status === "contradicted")
    ? "fail"
    : input.outcome === "no-findings"
      ? "pass"
      : "none";
  if (opinion === "none") return;
  const claimant = claim.entity_name;
  recordResolved(db, {
    subject: `judged:${taskBase(input.taskId, claimant)}:prose:${input.at}`,
    kind: "task",
    source: "task:prose-review",
    domain: "tools",
    owner: claimant,
    succeeded: opinion === "pass",
    metric: "prose-review",
    basis: "judged",
    judge: `prose-review:${input.model}`,
    participants: [participantOf(db, claimant)],
    refs: [
      `task:${input.taskId}`,
      ...workRefsFor(db, "task", claimant, taskApproach(db, claimant, input.taskId)),
    ],
    resolvedAt: input.at,
  });
}

/**
 * A creator's verdict on a task submission as one outcome. Each verdict is its
 * own subject (a resubmission after a rejection is a new attempt).
 */
export function recordTaskVerdict(
  db: MarinaDB,
  input: { taskId: number; claimant: string; approved: boolean; at: number; detail?: string },
): void {
  const submittedAt = db
    .getTaskClaims(input.taskId)
    .find((row) => row.entity_name === input.claimant)?.submitted_at;
  recordResolved(db, {
    subject:
      submittedAt == null
        ? `${taskBase(input.taskId, input.claimant)}:${input.at}`
        : taskOpinionSubject(input.taskId, input.claimant, submittedAt).slice("judged:".length),
    kind: "task",
    source: "task:verdict",
    domain: "tools",
    owner: input.claimant,
    succeeded: input.approved,
    quality: input.approved ? 1 : 0,
    metric: "creator-verdict",
    detail:
      input.detail ??
      (input.approved
        ? "submission approved by the task's creator"
        : "submission rejected by the task's creator"),
    basis: "mechanical",
    participants: [participantOf(db, input.claimant)],
    refs: [
      `task:${input.taskId}`,
      ...(submittedAt == null ? [] : [`task-submission:${submittedAt}`]),
      ...workRefsFor(db, "task", input.claimant, taskApproach(db, input.claimant, input.taskId)),
    ],
    resolvedAt: input.at,
  });
}

/** `task_approved` / `task_rejected` as a verdict outcome; no-op for any other event. */
export function observeOutcomeEvent(db: MarinaDB | undefined, event: EngineEvent): void {
  if (!db || (event.type !== "task_approved" && event.type !== "task_rejected")) return;
  if (!event.claimantName) return;
  recordTaskVerdict(db, {
    taskId: event.taskId,
    claimant: event.claimantName,
    approved: event.type === "task_approved",
    at: event.timestamp,
  });
}

/**
 * A judge's opinion of a task submission (the submission verifier, any
 * decision backend) as a JUDGED outcome: recorded, never delivered — an
 * opinion teaches nothing until its judge has earned agreement with creators'
 * verdicts (`judgeAgreement`). `none` (outage, missing signals) is no outcome.
 */
export function recordTaskOpinion(
  db: MarinaDB,
  input: {
    taskId: number;
    claimant: string;
    judge: string;
    opinion: "pass" | "fail" | "none";
    at?: number;
    /** Captured before the asynchronous verifier starts; never use a later submission. */
    submittedAt?: number;
  },
): void {
  if (input.opinion === "none") return;
  const at = input.at ?? Date.now();
  const claim = db.getTaskClaims(input.taskId).find((row) => row.entity_name === input.claimant);
  if (input.submittedAt !== undefined && claim?.submitted_at !== input.submittedAt) return;
  const submittedAt = input.submittedAt ?? claim?.submitted_at;
  const prefix = `judged:${taskBase(input.taskId, input.claimant)}:`;
  if (submittedAt != null && hasTaskOpinion(db, input.taskId, input.claimant, submittedAt)) return;
  recordResolved(db, {
    subject:
      submittedAt == null
        ? `${prefix}${at}`
        : taskOpinionSubject(input.taskId, input.claimant, submittedAt),
    kind: "task",
    source: "task:verdict",
    domain: "tools",
    owner: input.claimant,
    succeeded: input.opinion === "pass",
    metric: "judge-opinion",
    basis: "judged",
    judge: input.judge,
    participants: [participantOf(db, input.claimant)],
    refs: [
      `task:${input.taskId}`,
      ...workRefsFor(db, "task", input.claimant, taskApproach(db, input.claimant, input.taskId)),
    ],
    resolvedAt: at,
  });
}

/**
 * The submission verifier's opinion, recorded once for every reader: the
 * verifier's own table (`judge_observations`), the one judge ledger (`verify`
 * surface, settled by the creator's next verdict on the attempt) and the
 * outcome path (`recordTaskOpinion`). Each write is best-effort.
 */
export function recordVerifierOpinion(
  db: MarinaDB,
  row: JudgeObservationInput & { submittedAt?: number },
  at: number = Date.now(),
): void {
  const attempt = taskBase(row.taskId, row.claimantName);
  const submission =
    row.submittedAt === undefined
      ? undefined
      : taskOpinionSubject(row.taskId, row.claimantName, row.submittedAt).slice("judged:".length);
  if (
    row.submittedAt !== undefined &&
    db.getTaskClaims(row.taskId).find((claim) => claim.entity_name === row.claimantName)
      ?.submitted_at !== row.submittedAt
  )
    return;
  db.recordJudgeObservation(row);
  recordJudgeOpinion(db, {
    surface: "verify",
    judge: row.evaluator,
    subject: submission ?? attempt,
    truthKey: submission ?? `${attempt}:`,
    opinion: row.opinion,
    calibrated: row.calibrated,
    opinedAt: at,
  });
  recordTaskOpinion(db, {
    taskId: row.taskId,
    claimant: row.claimantName,
    judge: row.evaluator,
    opinion: row.opinion,
    at,
    ...(row.submittedAt === undefined ? {} : { submittedAt: row.submittedAt }),
  });
}

/**
 * Standing for verified code: a Code Mode task attempt whose recorded
 * verification PASSED and whose submission another account approved (`code
 * review approve`; the only caller passes passed attempts). Once per attempt
 * (`code:<runId>`). The passing checks GROUND the verdict, so an agent
 * reviewer inside the worker's spawn lineage (a sibling) credits it too
 * (`standingVerifierRefusal`); the worker's own account never does. A
 * verification run alone earns nothing — the worker chooses its checks — and
 * neither does any measurement run (those never reach review).
 */
export function creditVerifiedCode(
  db: MarinaDB,
  input: { runId: string; worker: { name: string; entityId?: string }; reviewer: string },
): VerifiedCredit {
  return recordVerified(db, {
    kind: "code_verified",
    ref: `code:${input.runId}`,
    worker: input.worker,
    verifier: input.reviewer,
    grounded: true,
  });
}

/**
 * A Code Mode verification that ran (passed or failed) as one outcome. Its
 * subject is the verification artifact, whose steps' output is the private
 * context a lesson is judged with.
 */
export function recordVerification(
  db: MarinaDB,
  input: {
    artifactId: string;
    actor: string;
    passed: boolean;
    commands: string[][];
    detail: string;
    sessionId?: string;
    at?: number;
    /** How the checks ran: `driver:<harness>`, `runner:<kind>`, `verify:<mode>`. */
    approach?: readonly string[];
  },
): void {
  recordResolved(db, {
    subject: `artifact:${input.artifactId}`,
    kind: "task",
    source: "code:verify",
    domain: "code",
    owner: input.actor,
    succeeded: input.passed,
    quality: input.passed ? 1 : 0,
    metric: "checks",
    detail: input.detail,
    basis: "mechanical",
    participants: [participantOf(db, input.actor)],
    truth: { commands: input.commands.map((c) => c[0] ?? "") },
    refs: [
      `artifact:${input.artifactId}`,
      ...(input.sessionId ? [`coding:${input.sessionId}`] : []),
      ...workRefsFor(db, "code", input.actor, input.approach ?? []),
    ],
    resolvedAt: input.at ?? Date.now(),
  });
}

/**
 * A research ask as one outcome, scored on its citation audit: the share of
 * the sources the answer cites that the agent actually opened and read. That
 * measures grounding, not correctness — the metric says so — and it is
 * mechanical (no judge). Only agent-mode asks carry an audit; an ask that
 * cites nothing is no evidence. A budget-forced answer never counts as a
 * success. Tagged `research:<mode>` (and the retriever when one was named).
 */
export function recordResearchAsk(
  db: MarinaDB,
  input: {
    actor: string;
    mode: string;
    audit?: { cited: number; read: number; unread: number; failed: number };
    retriever?: string;
    budgetForced?: boolean;
    at?: number;
  },
): void {
  const a = input.audit;
  if (!a || a.cited <= 0) return;
  const at = input.at ?? Date.now();
  const grounded = Math.min(1, a.read / a.cited);
  recordResolved(db, {
    subject: `research:${input.actor}:${at}`,
    kind: "task",
    source: "research:ask",
    domain: "research",
    owner: input.actor,
    succeeded: grounded >= 0.8 && !input.budgetForced,
    quality: grounded,
    metric: "citation-grounding",
    detail: `${a.read} of ${a.cited} cited sources read (${a.unread} never opened, ${a.failed} failed)${input.budgetForced ? "; budget-forced answer" : ""}`,
    basis: "mechanical",
    participants: [participantOf(db, input.actor)],
    refs: workRefsFor(db, "research", input.actor, [
      `research:${input.mode}`,
      ...(input.retriever ? [`retriever:${input.retriever}`] : []),
    ]),
    resolvedAt: at,
  });
}
