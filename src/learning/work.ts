// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Lessons from work: Marina's own non-benchmark tool use becomes judged
 * `tools` / `code` lessons through the ONE outcome loop (`recordOutcome`).
 *
 *   MARINA_LESSONS_FROM_WORK=off|observe|on   (default off)
 *     off      nothing is collected
 *     observe  signals are collected and aggregated; each flush logs the
 *              candidate outcomes per source (counts only) — no model call
 *     on       each aggregated pattern becomes ONE outcome through
 *              `recordOutcome` (writer + judge from `lessonWriterFromEnv` /
 *              `lessonJudgeFromEnv`, admission ranking, leak guard unchanged)
 *
 * A signal is one observed outcome of tool work — a tool error followed by a
 * corrected call, a call that kept failing, a run's tool budget reached, a
 * decision-gate hold, a challenge answer, a task verdict or verifier bounce, an
 * exec-approver denial, an opted-in passthru conversation's recovery or
 * argument-check correction. A signal carries GENERAL fields only: the tool or
 * command NAME, a mechanical error class (`classifyToolError`), the scope, a
 * ref; the case text it may carry (`privateText`) is shown to the writer as
 * `privateContext` and never stored. Signals are never learned one by one:
 * they aggregate per (source, tool, error class, result, scope) and an hourly
 * tick job (`flushWorkLessons`) turns each pattern seen often enough into one
 * outcome, at most `MAX_PER_FLUSH` per flush, deduplicated against the
 * pattern's existing (or retired) lesson, behind the daily spend cap.
 *
 * Privacy: work done for a principal is learned into THAT principal's own
 * lesson spaces (`ownerLessonSink`), served only to its own requests and
 * agents. Only shared/world agents (no human owner up their spawn chain) feed
 * the shared `lessons:<domain>` pool. An actor whose scope cannot be resolved
 * is never learned from. Measurement work is never learned from: request-
 * driven agent turns are skipped (they serve a caller; their own opt-in is
 * the passthru path), and a passthru request carrying `x-marina-eval` never
 * contributes.
 */

import type { DecisionProvider } from "../decisions/types";
import { getErrorMessage } from "../engine/errors";
import { Logger } from "../engine/logger";
import { dailyCapRefusal } from "../engine/spend-ledger";
import type { MarinaDB } from "../persistence/database";
import type { EngineEvent } from "../types";
import { lessonsMetaMode, lessonsMode } from "./modes";
import type {
  LessonAdmission,
  LessonSink,
  LessonWriter,
  Outcome,
  OutcomeDomain,
  OutcomeRecord,
} from "./outcomes";
import { recordOutcome } from "./outcomes";
import { generalToolName } from "./tool-errors";

export { classifyToolError, generalToolName, softFailureClass } from "./tool-errors";

const logger = new Logger();

export type WorkLearnMode = "off" | "observe" | "on";

/** `MARINA_LESSONS_FROM_WORK` (default off). `MARINA_LESSONS=off` turns it off too. */
export function lessonsFromWorkMode(env: NodeJS.ProcessEnv = process.env): WorkLearnMode {
  if (lessonsMode(env) === "off") return "off";
  const v = env.MARINA_LESSONS_FROM_WORK?.trim().toLowerCase();
  if (v === "on" || v === "true" || v === "1") return "on";
  if (v === "observe") return "observe";
  return "off";
}

/** Where an outcome of work came from. */
export type WorkSource =
  | "tool-recovery"
  | "tool-repeat-failure"
  | "tool-budget"
  | "gate-hold"
  | "challenge"
  | "task-verdict"
  | "task-bounce"
  | "code-exec-denied"
  | "passthru-recovery"
  | "argcheck-correction";

export const WORK_SOURCES: readonly WorkSource[] = [
  "tool-recovery",
  "tool-repeat-failure",
  "tool-budget",
  "gate-hold",
  "challenge",
  "task-verdict",
  "task-bounce",
  "code-exec-denied",
  "passthru-recovery",
  "argcheck-correction",
];

/** Shared pool (world agents), or one principal's own lesson spaces. */
export type WorkScope = { kind: "shared" } | { kind: "owner"; owner: string };

export interface WorkSignal {
  source: WorkSource;
  /** A tool or command NAME (`marina_command`, `task`, `rm`) — never its arguments. */
  tool: string;
  /** A mechanical class (`classifyToolError`) or a fixed label (`deny`, `rejected`). */
  errorClass: string;
  /** The work ended well (a recovery, an approval) or not. */
  succeeded: boolean;
  scope: WorkScope;
  /** ms epoch the outcome was observed. */
  at: number;
  /** Pointer to the evidence (`trace:…`, `task:N`, `challenge:…`, `artifact:…`). */
  ref?: string;
  /** Case text the writer may read (never stored, never logged). */
  privateText?: string;
}

// ─── Scope ──────────────────────────────────────────────────────────────────

/** The principal-table reads scope resolution needs (a `MarinaDB` slice). */
export interface ScopeReader {
  getPrincipal(
    type: "human" | "agent" | "service" | "system",
    displayName: string,
  ):
    | { principal_id: string; principal_type: string; owner_principal_id: string | null }
    | undefined;
  listPrincipals(): Array<{
    principal_id: string;
    principal_type: string;
    display_name: string;
    owner_principal_id: string | null;
    status: string;
  }>;
  getUserByName(name: string): { id: string } | undefined;
}

const MAX_OWNER_DEPTH = 8;

/**
 * Whose work this actor's work is. An agent with no owner up its spawn chain
 * (a world, room or system agent) works for the world: `shared`. An agent
 * spawned (directly or through other agents) by a person works for that
 * person: `owner`. A person acting directly owns its own work. Undefined when
 * it cannot be resolved — such work is never learned from.
 */
export function workScopeFor(db: ScopeReader, actor: string): WorkScope | undefined {
  const agent = db.getPrincipal("agent", actor);
  if (!agent) {
    const human = db.getPrincipal("human", actor);
    return human && db.getUserByName(actor) ? { kind: "owner", owner: actor } : undefined;
  }
  const byId = new Map(db.listPrincipals().map((p) => [p.principal_id, p]));
  let ownerId = agent.owner_principal_id;
  for (let depth = 0; depth < MAX_OWNER_DEPTH; depth++) {
    if (!ownerId) return { kind: "shared" };
    const owner = byId.get(ownerId);
    if (!owner) return undefined;
    if (owner.principal_type === "system" || owner.principal_type === "service")
      return { kind: "shared" };
    // An agent, or an agent's own world account: keep walking up its chain.
    const asAgent =
      owner.principal_type === "agent" ? owner : db.getPrincipal("agent", owner.display_name);
    if (asAgent) {
      ownerId = asAgent.owner_principal_id;
      continue;
    }
    if (owner.principal_type === "human" && owner.status === "active")
      return db.getUserByName(owner.display_name)
        ? { kind: "owner", owner: owner.display_name }
        : undefined;
    return undefined;
  }
  return undefined;
}

const scopeKey = (s: WorkScope) => (s.kind === "shared" ? "shared" : `owner:${s.owner}`);

// ─── Aggregation ────────────────────────────────────────────────────────────

/** One aggregated pattern: the same source, tool, class, result and scope. */
export interface WorkPattern {
  source: WorkSource;
  tool: string;
  errorClass: string;
  succeeded: boolean;
  scope: WorkScope;
  count: number;
  firstAt: number;
  lastAt: number;
  refs: string[];
  /** Up to three case excerpts for the writer (never stored). */
  samples: string[];
}

/** Occurrences before a pattern teaches (verdicts teach on one; tool noise needs repeats). */
export const MIN_OCCURRENCES: Record<WorkSource, number> = {
  "tool-recovery": 2,
  "tool-repeat-failure": 2,
  "tool-budget": 2,
  "gate-hold": 2,
  challenge: 1,
  "task-verdict": 1,
  "task-bounce": 1,
  "code-exec-denied": 2,
  "passthru-recovery": 2,
  "argcheck-correction": 2,
};

const MAX_PATTERNS = 2_000;
const MAX_REFS = 8;
const MAX_SAMPLES = 3;
const SAMPLE_BYTES = 400;

export class WorkAggregator {
  private patterns = new Map<string, WorkPattern>();
  dropped = 0;

  add(s: WorkSignal): void {
    const tool = generalToolName(s.tool);
    const key = [s.source, tool, s.errorClass, s.succeeded ? 1 : 0, scopeKey(s.scope)].join("|");
    let p = this.patterns.get(key);
    if (!p) {
      if (this.patterns.size >= MAX_PATTERNS) {
        this.dropped++;
        return;
      }
      p = {
        source: s.source,
        tool,
        errorClass: s.errorClass,
        succeeded: s.succeeded,
        scope: s.scope,
        count: 0,
        firstAt: s.at,
        lastAt: s.at,
        refs: [],
        samples: [],
      };
      this.patterns.set(key, p);
    }
    p.count++;
    p.firstAt = Math.min(p.firstAt, s.at);
    p.lastAt = Math.max(p.lastAt, s.at);
    if (s.ref && p.refs.length < MAX_REFS && !p.refs.includes(s.ref)) p.refs.push(s.ref);
    if (s.privateText && p.samples.length < MAX_SAMPLES)
      p.samples.push(s.privateText.slice(0, SAMPLE_BYTES));
  }

  /** Put patterns back (below their floor): merged with anything collected since. */
  restore(patterns: readonly WorkPattern[]): void {
    for (const p of patterns) {
      const key = [p.source, p.tool, p.errorClass, p.succeeded ? 1 : 0, scopeKey(p.scope)].join(
        "|",
      );
      const now = this.patterns.get(key);
      if (!now) {
        if (this.patterns.size < MAX_PATTERNS) this.patterns.set(key, { ...p });
        continue;
      }
      now.count += p.count;
      now.firstAt = Math.min(now.firstAt, p.firstAt);
      for (const r of p.refs)
        if (now.refs.length < MAX_REFS && !now.refs.includes(r)) now.refs.push(r);
      for (const s of p.samples) if (now.samples.length < MAX_SAMPLES) now.samples.push(s);
    }
  }

  /** Every pattern collected so far; the aggregator is emptied. */
  take(): WorkPattern[] {
    const out = [...this.patterns.values()];
    this.patterns.clear();
    return out;
  }

  get size(): number {
    return this.patterns.size;
  }
}

/** Candidate outcomes per source: one per pattern (never content). */
export function candidateCounts(patterns: readonly WorkPattern[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of patterns) out[p.source] = (out[p.source] ?? 0) + 1;
  return out;
}

/** Occurrences per source (what observe logs — never content). */
export function countsBySource(patterns: readonly WorkPattern[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of patterns) out[p.source] = (out[p.source] ?? 0) + p.count;
  return out;
}

// ─── Outcomes ───────────────────────────────────────────────────────────────

/** A draft rule per error class (the writer improves it; it stands when no writer answers). */
const CLASS_RULES: Record<string, string> = {
  "unknown-command":
    "When a command or tool name is unknown, list or read the available commands before retrying with a corrected name.",
  "invalid-args":
    "When a call fails on its arguments, read the tool's usage and retry with every required argument in the documented form.",
  "not-found":
    "Before acting on an id or name, confirm it exists with a lookup; retry with the confirmed value.",
  permission:
    "When a call is refused for permission, do not repeat it; ask for approval or choose an action within your authority.",
  "rate-limit": "When rate limited, wait or batch the work instead of retrying at once.",
  timeout: "When a call times out, retry once with a smaller request, then change approach.",
  network: "On a network failure, retry once, then report the outage instead of looping.",
  conflict:
    "When a write conflicts with existing state, read the current state before writing again.",
  budget:
    "Plan tool calls to converge before the per-run budget: gather what is needed, then act or answer.",
  "output-limit":
    "Keep tool calls small and complete; split large edits so output limits never cut a call.",
  other:
    "After a tool error, read the error, change the call, and verify the result before moving on.",
};

const SOURCE_TEXT: Record<
  WorkSource,
  (p: WorkPattern) => { attempted: string; detail: string; rule?: string }
> = {
  "tool-recovery": (p) => ({
    attempted: `use the ${p.tool} tool`,
    detail: `${p.count} times a ${p.errorClass} error was followed by a corrected call that succeeded in the same run`,
    rule: CLASS_RULES[p.errorClass] ?? CLASS_RULES.other,
  }),
  "passthru-recovery": (p) => ({
    attempted: `use the ${p.tool} tool in a caller's conversation`,
    detail: `${p.count} times a ${p.errorClass} tool error was followed by a corrected call that succeeded`,
    rule: CLASS_RULES[p.errorClass] ?? CLASS_RULES.other,
  }),
  "tool-repeat-failure": (p) => ({
    attempted: `use the ${p.tool} tool`,
    detail: `${p.count} runs repeated a failing call (${p.errorClass}) three or more times without a success`,
    rule: `After two failures of the same call with the same error, stop repeating it: inspect state or usage and change the approach. ${CLASS_RULES[p.errorClass] ?? ""}`.trim(),
  }),
  "tool-budget": (p) => ({
    attempted: "finish a run within its tool budget",
    detail: `${p.count} runs reached the per-run tool budget`,
    rule: CLASS_RULES.budget,
  }),
  "gate-hold": (p) => ({
    attempted: `call ${p.tool} past the decision gate`,
    detail: `${p.count} calls held by the gate (${p.errorClass})`,
    rule: "Before a consequential call, state the intent and authority for it and prefer a reversible step; a held call is not retried unchanged.",
  }),
  challenge: (p) => ({
    attempted: `request approval for a ${p.tool} action`,
    detail: `${p.count} approval requests answered ${p.errorClass}`,
    rule:
      p.errorClass === "deny"
        ? "When an approver denies an action, do not request it again unchanged; choose a smaller or different action."
        : p.errorClass === "expired"
          ? "Approval requests can go unanswered: keep working on what needs no approval instead of waiting."
          : "An approval request with a clear, specific reason was granted; state what and why when asking.",
  }),
  "task-verdict": (p) => ({
    attempted: "complete a world task and submit it",
    detail: `${p.count} submissions ${p.succeeded ? "approved" : "rejected"} by the task's creator`,
    rule: p.succeeded
      ? "A submission that reports the work done with evidence is approved; cite artifacts or notes."
      : "Before submitting a task, check the result against what the task asked and include evidence.",
  }),
  "task-bounce": (p) => ({
    attempted: "submit a world task",
    detail: `${p.count} submissions bounced by the verifier before recording`,
    rule: "Report the work actually done with checkable evidence (note:N, task:N, chronicle:N) before submitting.",
  }),
  "code-exec-denied": (p) => ({
    attempted: `run the ${p.tool} program in a code workspace`,
    detail: `${p.count} exec requests denied (${p.errorClass})`,
    rule: "Use the workspace's allowed commands (code test, code verify) before asking to run another program.",
  }),
  "argcheck-correction": (p) => ({
    attempted: `call the ${p.tool} write tool`,
    detail: p.succeeded
      ? `${p.count} write calls carried values the conversation did not support and were corrected after a check`
      : `${p.count} write calls carried values the conversation did not support (flagged by the argument check)`,
    rule: "Before a write call, take each argument value from the user's words or a tool result; look up what you do not have.",
  }),
};

/** The general outcome label of a pattern (also its dedupe key in the lesson store). */
export function patternSource(
  p: Pick<WorkPattern, "source" | "tool" | "errorClass" | "succeeded">,
) {
  return `work:${p.source}:${p.tool}:${p.errorClass}:${p.succeeded ? "ok" : "fail"}`;
}

/** The domain a pattern teaches. */
export function patternDomain(p: Pick<WorkPattern, "source">): OutcomeDomain {
  return p.source === "code-exec-denied" ? "code" : "tools";
}

/**
 * ONE outcome for a pattern: general fields only (tool name, error class,
 * counts). The case excerpts ride as `privateContext` — read by the writer,
 * checked by the leak guard, never stored.
 */
export function outcomeFromPattern(p: WorkPattern, now = Date.now()): Outcome {
  const t = SOURCE_TEXT[p.source](p);
  const domain = patternDomain(p);
  return {
    domain,
    source: patternSource(p),
    succeeded: p.succeeded,
    resolvedAt: new Date(Math.min(now, p.lastAt)).toISOString(),
    attempted: t.attempted,
    detail: t.detail,
    signals: [`tool:${p.tool}`, `class:${p.errorClass}`, `occurrences:${p.count}`],
    ...(t.rule ? { rule: t.rule } : {}),
    scope: "method",
    families: domain === "code" ? ["code.patch"] : ["tool-agent.policy"],
    ...(p.refs.length ? { refs: p.refs.slice(0, MAX_REFS) } : {}),
    ...(p.samples.length ? { privateContext: p.samples.join("\n---\n") } : {}),
    provenance: {
      learner: "work-v1",
      scope: p.scope.kind,
      source_kind: p.source,
    },
  };
}

// ─── The live collector ─────────────────────────────────────────────────────

interface ToolStreak {
  /** Consecutive failures of one agent's tool, the last failure's class and time. */
  n: number;
  cls: string;
  repeated: boolean;
  at: number;
}

/**
 * How long a failure waits for the agent's next call of the same tool: a lean
 * agent often retries in its next cycle (a new run), so a streak spans runs.
 */
export const RECOVERY_WINDOW_MS = 15 * 60_000;
const MAX_STREAKS = 2_000;

/**
 * Turns engine events into work signals: a tool error then a success of the
 * same tool by the same agent within `RECOVERY_WINDOW_MS` (recovery), three
 * failures of one tool in a row (repeat failure), a run's tool budget, a
 * decision-gate hold, an argument-check flag, a verifier bounce, a task
 * verdict. Only AUTONOMOUS agent work counts (a request-driven turn serves a
 * caller — measurement runs included).
 */
export class WorkEventTracker {
  private streaks = new Map<string, ToolStreak>();

  constructor(
    private readonly scopeOf: (actor: string) => WorkScope | undefined,
    private readonly emit: (s: WorkSignal) => void,
  ) {}

  onEvent(event: EngineEvent): void {
    switch (event.type) {
      case "agent_tool_result":
        if (!autonomous(event)) return;
        this.onToolResult(event);
        return;
      case "agent_decision": {
        const e = event as unknown as {
          name: string;
          stage?: string;
          verdict?: string;
          subject?: string;
          reason?: string;
          signals?: Record<string, number | string>;
          timestamp: number;
          traceId?: string;
          origin?: string;
        };
        if (!e.verdict || !e.subject) return;
        // A verifier bounce of a task submission (`MARINA_DECISION_VERIFY=on`).
        if (e.stage === "verify") {
          if (e.verdict !== "retry") return;
          const scope = this.scopeOf(e.name);
          if (!scope) return;
          const task = e.subject.match(/#(\d+)/)?.[1];
          this.emit({
            source: "task-bounce",
            tool: "task",
            errorClass: "bounce",
            succeeded: false,
            scope,
            at: e.timestamp,
            ...(task ? { ref: `task:${task}` } : {}),
          });
          return;
        }
        // An argument check that flagged a write call's values (MARINA_ARGCHECK).
        if (e.stage === "argcheck") {
          if (e.verdict !== "nudge" && e.verdict !== "unsupported") return;
          const scope = this.scopeOf(e.name);
          if (!scope) return;
          this.emit({
            source: "argcheck-correction",
            tool: e.subject,
            errorClass: "unsupported-value",
            succeeded: false,
            scope,
            at: e.timestamp,
          });
          return;
        }
        if (e.stage !== "gate" || e.verdict === "allow") return;
        // The follow-up event of an `ask` (its challenge opened) is the same hold.
        if (/^(?:no )?challenge\b/i.test(e.reason ?? "")) return;
        const scope = this.scopeOf(e.name);
        if (!scope) return;
        const top = Object.entries(e.signals ?? {})
          .filter((x): x is [string, number] => typeof x[1] === "number")
          .sort((a, b) => b[1] - a[1])[0]?.[0];
        this.emit({
          source: "gate-hold",
          tool: e.subject,
          errorClass: `${e.verdict}${top ? `:${top}` : ""}`,
          succeeded: false,
          scope,
          at: e.timestamp,
        });
        return;
      }
      case "task_approved":
      case "task_rejected": {
        const claimant = (event as { claimantName?: string }).claimantName;
        if (!claimant) return;
        const scope = this.scopeOf(claimant);
        if (!scope) return;
        this.emit({
          source: "task-verdict",
          tool: "task",
          errorClass: event.type === "task_approved" ? "approved" : "rejected",
          succeeded: event.type === "task_approved",
          scope,
          at: event.timestamp,
          ref: `task:${event.taskId}`,
        });
        return;
      }
      default:
        return;
    }
  }

  private onToolResult(event: Extract<EngineEvent, { type: "agent_tool_result" }>): void {
    const key = `${event.name}|${event.toolName}`;
    const cls = event.errorClass ?? (event.isError ? "other" : undefined);
    const ref = event.traceId ? `trace:${event.traceId}` : undefined;
    const signal = (s: Omit<WorkSignal, "scope" | "at" | "ref">) => {
      const scope = this.scopeOf(event.name);
      if (scope) this.emit({ ...s, scope, at: event.timestamp, ...(ref ? { ref } : {}) });
    };
    if (cls === "budget") {
      signal({ source: "tool-budget", tool: "run", errorClass: "budget", succeeded: false });
      return;
    }
    const prior = this.streaks.get(key);
    const f = prior && event.timestamp - prior.at <= RECOVERY_WINDOW_MS ? prior : undefined;
    if (cls) {
      const next = { n: (f?.n ?? 0) + 1, cls, repeated: f?.repeated ?? false, at: event.timestamp };
      if (!prior && this.streaks.size >= MAX_STREAKS) {
        const oldest = [...this.streaks.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) this.streaks.delete(oldest[0]);
      }
      this.streaks.set(key, next);
      if (next.n >= 3 && !next.repeated) {
        next.repeated = true;
        signal({
          source: "tool-repeat-failure",
          tool: event.toolName,
          errorClass: cls,
          succeeded: false,
        });
      }
      return;
    }
    if (prior) this.streaks.delete(key);
    if (f && f.n > 0) {
      signal({ source: "tool-recovery", tool: event.toolName, errorClass: f.cls, succeeded: true });
    }
  }
}

/** Only a turn the agent took on its own: never one serving a request (incl. measurement). */
function autonomous(event: { origin?: string; traceId?: string }): boolean {
  if (event.origin) return event.origin === "autonomous";
  return typeof event.traceId === "string" && event.traceId.startsWith("agent-trace-");
}

// ─── The armed learner (one per database) ───────────────────────────────────

interface WorkLearnerState {
  aggregator: WorkAggregator;
  tracker: WorkEventTracker;
  flushing?: Promise<FlushReport>;
}

const learners = new WeakMap<object, WorkLearnerState>();

/** The collector for `db`, created on first use (cheap; nothing runs until a flush). */
function learnerFor(db: MarinaDB): WorkLearnerState {
  let s = learners.get(db);
  if (!s) {
    const aggregator = new WorkAggregator();
    const scopes = new Map<string, { scope: WorkScope | undefined; at: number }>();
    const scopeOf = (actor: string) => {
      const hit = scopes.get(actor);
      if (hit && Date.now() - hit.at < 600_000) return hit.scope;
      let scope: WorkScope | undefined;
      try {
        scope = workScopeFor(db, actor);
      } catch {
        scope = undefined;
      }
      if (scopes.size > 1_000) scopes.clear();
      scopes.set(actor, { scope, at: Date.now() });
      return scope;
    };
    s = { aggregator, tracker: new WorkEventTracker(scopeOf, (sig) => aggregator.add(sig)) };
    learners.set(db, s);
  }
  return s;
}

/**
 * Hand a work signal to the collector. Synchronous, O(1), never throws, a
 * no-op when `MARINA_LESSONS_FROM_WORK` is off. Never fails the source action.
 */
export function noteWork(
  db: MarinaDB | undefined,
  signal: WorkSignal,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!db || lessonsFromWorkMode(env) === "off") return;
  try {
    learnerFor(db).aggregator.add(signal);
  } catch {
    // allow-empty-catch: collection is best effort; the source action never fails
  }
}

/** Resolve an actor's scope and note a signal for it (skipped when unresolvable). */
export function noteWorkFor(
  db: MarinaDB | undefined,
  actor: string,
  signal: Omit<WorkSignal, "scope">,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!db || lessonsFromWorkMode(env) === "off") return;
  try {
    const scope = workScopeFor(db, actor);
    if (scope) learnerFor(db).aggregator.add({ ...signal, scope });
  } catch {
    // allow-empty-catch: collection is best effort; the source action never fails
  }
}

/** Feed one engine event to `db`'s tracker (the engine's event listener). */
export function observeWorkEvent(
  db: MarinaDB | undefined,
  event: EngineEvent,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!db) return;
  if (
    event.type !== "agent_tool_result" &&
    event.type !== "agent_decision" &&
    event.type !== "task_approved" &&
    event.type !== "task_rejected"
  )
    return;
  if (lessonsFromWorkMode(env) === "off") return;
  try {
    learnerFor(db).tracker.onEvent(event);
  } catch {
    // allow-empty-catch: collection is best effort
  }
}

/** Patterns collected for `db` and not yet flushed (tests, the dry run). */
export function pendingWorkPatterns(db: MarinaDB): number {
  return learners.get(db)?.aggregator.size ?? 0;
}

/** Forget everything collected for `db` (tests). */
export function resetWorkLearner(db: MarinaDB): void {
  learners.delete(db);
}

// ─── Flush: patterns → judged lessons ───────────────────────────────────────

export const MAX_PER_FLUSH = 20;
/** A pattern below its floor waits at most this long for more occurrences. */
const CARRY_MS = 24 * 3_600_000;

export interface FlushDeps {
  /** The sink for shared work (default: the shared lesson pool). */
  sharedSink?: LessonSink;
  /** The sink for one owner's work (default: the owner's own lesson spaces). */
  ownerSink?: (owner: string) => LessonSink | undefined;
  writer?: LessonWriter;
  judge?: DecisionProvider;
  admit?: LessonAdmission;
  env?: NodeJS.ProcessEnv;
  now?: number;
  maxPerFlush?: number;
  /** Why the next model call must not start (spend); default `dailyCapRefusal`. */
  stopReason?: () => string | undefined;
}

export interface FlushReport {
  mode: WorkLearnMode;
  patterns: number;
  /** Patterns below their occurrence floor (kept for the next flush). */
  belowFloor: number;
  /** Candidate outcomes (one per pattern at or above its floor), per source. */
  candidates: Record<string, number>;
  /** Occurrences behind those candidates, per source. */
  occurrences: Record<string, number>;
  learned: number;
  duplicates: number;
  /** No judge verdict (no model reachable): nothing written, retried next flush. */
  deferred: number;
  skipped: { spend: number; cap: number; noScope: number };
  failed: number;
  records: Array<Pick<OutcomeRecord, "trust" | "reason" | "lessonId"> & { source: string }>;
}

/** Learn (on) or count (observe) the patterns that reached their floor. Never throws. */
export async function learnPatterns(
  patterns: WorkPattern[],
  deps: FlushDeps & { mode: WorkLearnMode },
): Promise<FlushReport & { carry: WorkPattern[] }> {
  const ready = patterns.filter((p) => p.count >= MIN_OCCURRENCES[p.source]);
  const carry = patterns.filter((p) => p.count < MIN_OCCURRENCES[p.source]);
  const report: FlushReport & { carry: WorkPattern[] } = {
    mode: deps.mode,
    patterns: patterns.length,
    belowFloor: carry.length,
    candidates: candidateCounts(ready),
    occurrences: countsBySource(ready),
    learned: 0,
    duplicates: 0,
    deferred: 0,
    skipped: { spend: 0, cap: 0, noScope: 0 },
    failed: 0,
    records: [],
    carry,
  };
  if (deps.mode !== "on") return report;
  const max = deps.maxPerFlush ?? MAX_PER_FLUSH;
  const env = deps.env ?? process.env;
  const stop = deps.stopReason ?? (() => dailyCapRefusal(env));
  // Most-seen patterns first: the budget goes to what recurs.
  const ordered = [...ready].sort((a, b) => b.count - a.count);
  for (let i = 0; i < ordered.length; i++) {
    const p = ordered[i]!;
    // Patterns not reached this time wait for the next flush (within a day).
    if (report.learned >= max) {
      report.skipped.cap += ordered.length - i;
      carry.push(...ordered.slice(i));
      break;
    }
    if (stop()) {
      report.skipped.spend += ordered.length - i;
      carry.push(...ordered.slice(i));
      break;
    }
    const sink = p.scope.kind === "shared" ? deps.sharedSink : deps.ownerSink?.(p.scope.owner);
    if (!sink) {
      report.skipped.noScope++;
      continue;
    }
    const outcome = outcomeFromPattern(p, deps.now);
    try {
      if (await alreadyLearned(sink, outcome)) {
        report.duplicates++;
        continue;
      }
      const record = await recordOutcome(
        {
          sink,
          ...(deps.writer ? { writer: deps.writer } : {}),
          ...(deps.judge ? { judge: deps.judge } : {}),
          ...(deps.admit ? { admit: deps.admit } : {}),
          // Only shared lessons may be mirrored into the shared meta pool.
          meta: p.scope.kind === "shared" && lessonsMetaMode(env) !== "off",
          // No verdict (no model reachable, an outage) ⇒ nothing is written.
          deferUnjudged: true,
        },
        outcome,
      );
      if (record.deferred) {
        report.deferred++;
        carry.push(p);
        continue;
      }
      report.learned++;
      report.records.push({
        source: outcome.source,
        trust: record.trust,
        reason: record.reason,
        ...(record.lessonId ? { lessonId: record.lessonId } : {}),
      });
    } catch (err) {
      report.failed++;
      logger.warn("main", "work lesson failed", {
        source: outcome.source,
        error: getErrorMessage(err).slice(0, 200),
      });
    }
  }
  return report;
}

/** The pattern already has a lesson (current or retired — a retirement is a decision). */
async function alreadyLearned(sink: LessonSink, o: Outcome): Promise<boolean> {
  if (sink.find && (await sink.find(o.domain, { source: o.source }, 1)).length) return true;
  if (sink.findRetired && (await sink.findRetired(o.domain, { source: o.source }, 1)).length)
    return true;
  return false;
}

/**
 * The hourly flush for `db`: take the aggregated patterns, learn (on) or log
 * counts (observe), keep those below their floor for the next window. Never
 * overlaps itself; never throws.
 */
export async function flushWorkLessons(
  db: MarinaDB,
  deps: FlushDeps = {},
): Promise<FlushReport | undefined> {
  const env = deps.env ?? process.env;
  const mode = lessonsFromWorkMode(env);
  const state = learners.get(db);
  if (mode === "off") {
    learners.delete(db);
    return undefined;
  }
  if (!state || state.flushing) return state?.flushing;
  const run = (async () => {
    const patterns = state.aggregator.take();
    const filled = await withDefaults(db, deps, mode);
    const report = await learnPatterns(patterns, { ...filled, mode });
    // Below-floor patterns wait for more occurrences, within a day.
    const now = deps.now ?? Date.now();
    state.aggregator.restore(report.carry.filter((p) => now - p.lastAt < CARRY_MS));
    const { carry: _carry, records: _records, ...counts } = report;
    if (patterns.length)
      logger.info(
        "main",
        `lessons from work (${mode})`,
        counts as unknown as Record<string, unknown>,
      );
    return report;
  })();
  state.flushing = run;
  try {
    return await run;
  } catch {
    return undefined;
  } finally {
    state.flushing = undefined;
  }
}

async function withDefaults(
  db: MarinaDB,
  deps: FlushDeps,
  mode: WorkLearnMode,
): Promise<FlushDeps> {
  if (mode !== "on") return deps;
  const env = deps.env ?? process.env;
  const svc = await import("./service");
  const { harnessDecisionProvider } = await import("../decisions/engines");
  const { lessonAdmission } = await import("./admission");
  const judge = deps.judge ?? svc.lessonJudgeFromEnv(env);
  const writer = deps.writer ?? svc.lessonWriterFromEnv(env);
  const admit =
    deps.admit ?? lessonAdmission({ env, db, judge: harnessDecisionProvider(env) ?? undefined });
  return {
    ...deps,
    sharedSink: deps.sharedSink ?? svc.lessonSinkFor(db),
    ownerSink:
      deps.ownerSink ??
      ((owner) => (svc.canHoldOwnLessons(db, owner) ? svc.ownerLessonSink(db, owner) : undefined)),
    judge,
    ...(writer ? { writer } : {}),
    ...(admit ? { admit } : {}),
  };
}
