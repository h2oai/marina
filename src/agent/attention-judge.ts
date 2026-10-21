// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Attention judges (`MARINA_ATTENTION_JUDGE=off|observe|on`, default
 * `observe`): cheap judgement calls through `src/decisions` on how residents
 * spend each other's attention, each checked later against a mechanical
 * result on the outcome path, so a judge's trust is measured, never assumed.
 *
 * - `attention-wake`: did a borderline wake (a tell that was not a request or
 *   a person's steer) need the resident now? Truth: the woken turn did work —
 *   the agent ran a tool or a world command of its own (reported by its
 *   supervisor, `src/routing/attention-bridge.ts`).
 * - `attention-converge`: does a message deep in a reply chain (depth ≥ 3)
 *   add new information? Truth: no person stepped in on the sender within
 *   15 minutes.
 * - `review-sycophancy`: does an approval rest on specific checking rather
 *   than agreement? Truth: the approval held (the review merged at that round).
 * - `review-value`: how useful is a verdict to the person deciding? Truth: the
 *   person's close agreed with it (an approval merged; a rework led to another
 *   round or a rejection).
 *
 * Each opinion is a judged outcome `judged:<subject>` and each truth the
 * mechanical outcome `<subject>` (kind `request`: evidence only, never a
 * lesson), so `judgeAgreement` and `earnedJudge` — the one earned rule —
 * measure every judge per `<kind>:<model>`. `observe` records only. `on`
 * lets an EARNED judge act, and only advisorily: wake and converge opinions
 * feed the same `attention_useful`/`attention_noise` counters people set
 * with `attention-feedback`; review opinions show as a line in
 * `code review <id>`. Nothing is ever blocked, closed or approved by a judge.
 * `off` is byte-identical: no calls, no rows.
 *
 * Questions carry the message text masked (`maskSensitiveText`), framed as
 * untrusted; answers are numbers; rows hold numbers and refs, never text.
 */

import { harnessDecisionProvider } from "../decisions/engines";
import { maskSensitiveText } from "../decisions/gate";
import { noul, score } from "../decisions/questions";
import type { DecisionProvider, DecisionQuestions } from "../decisions/types";
import { getErrorMessage } from "../engine/errors";
import { Logger } from "../engine/logger";
import { judgeAgreement } from "../outcomes/agreement";
import { recordResolved } from "../outcomes/record";
import type { MarinaDB } from "../persistence/database";
import type { EngineEvent } from "../types";

const logger = new Logger();

export type AttentionJudgeMode = "off" | "observe" | "on";

export type AttentionJudgeKind =
  | "attention-wake"
  | "attention-converge"
  | "review-sycophancy"
  | "review-value";

export function attentionJudgeMode(env: NodeJS.ProcessEnv = process.env): AttentionJudgeMode {
  const v = env.MARINA_ATTENTION_JUDGE?.trim().toLowerCase();
  return v === "off" || v === "on" ? v : "observe";
}

/** A converge question is asked from this reply depth on. */
export const CONVERGE_MIN_DEPTH = 3;
/** How long a person has to step in before a deep reply counts as converging. */
export const CONVERGE_WINDOW_MS = 15 * 60_000;
/** Wake reasons judged: not a request it must answer, not a person's steer. */
const BORDERLINE_WAKE_REASONS = new Set(["information", "ambient", "reply", "addressed"]);
/** Judgements in flight at once, and waiting; beyond that a call is skipped (counted). */
const MAX_IN_FLIGHT = 2;
const MAX_QUEUED = 100;
const MAX_TEXT = 1_500;
const SOURCE = "attention-judge";

const WAKE_QUESTIONS: DecisionQuestions = {
  needed: noul(
    "A message reached an agent while it might be working. Did the message need the agent's attention NOW (not later, not at all)?",
    {
      true: "It asks for or enables action the agent should take now, or changes what it is doing.",
      false:
        "It is chatter, a status note, an acknowledgement or information that can wait for the agent's next turn.",
    },
  ),
};

const CONVERGE_QUESTIONS: DecisionQuestions = {
  adds: noul(
    "This message is a reply deep in a conversation between agents. Does it add new information or move the work forward, beyond the message it answers?",
    {
      true: "New facts, a decision, a result, a concrete question or a correction.",
      false: "Restates, agrees, thanks, or repeats what was already said.",
    },
  ),
};

const SYCOPHANCY_QUESTIONS: DecisionQuestions = {
  checked: noul(
    "A reviewer approved another agent's code change. Does the approval rest on specific checking (concrete evidence: tests run, lines read, cases considered) rather than only agreeing with the author?",
    {
      true: "It names what was checked or found.",
      false: "It only agrees, praises or repeats the author's claims.",
    },
  ),
};

const VALUE_QUESTIONS: DecisionQuestions = {
  value: score("How useful is this review verdict to the person who decides whether to merge?", [
    "useless: no reasoning",
    "thin: generic remarks",
    "some: one concrete point",
    "useful: concrete findings or checks",
    "decisive: specific, verifiable findings a person can act on",
  ]),
};

interface Job {
  kind: AttentionJudgeKind;
  /** The mechanical outcome's subject; the opinion is `judged:<subject>`. */
  subject: string;
  owner: string;
  state: Record<string, unknown>;
  questions: DecisionQuestions;
  /** The answer as a pass (true = the good case) and a 0–1 quality. */
  read(answers: Record<string, unknown>): { passed: boolean; quality: number } | undefined;
  /** Under `on`, once earned: act on the opinion (advisory). */
  act?(passed: boolean): void;
}

interface State {
  inFlight: number;
  queue: Job[];
  skipped: number;
  lastSweep: number;
}

const states = new WeakMap<MarinaDB, State>();
let providerOverride: (() => DecisionProvider | undefined) | undefined;

function stateOf(db: MarinaDB): State {
  let s = states.get(db);
  if (!s) {
    s = { inFlight: 0, queue: [], skipped: 0, lastSweep: 0 };
    states.set(db, s);
  }
  return s;
}

const provider = () => (providerOverride ? providerOverride() : harnessDecisionProvider());

const fence = (text: string) => `<untrusted>\n${maskSensitiveText(text, MAX_TEXT)}\n</untrusted>`;

const noulOf = (answers: Record<string, unknown>, key: string): number | undefined => {
  const a = answers[key] as { type?: string; noul?: number } | undefined;
  return a?.type === "noul" && typeof a.noul === "number" ? a.noul : undefined;
};

function enqueue(db: MarinaDB, job: Job): void {
  const s = stateOf(db);
  if (s.queue.length >= MAX_QUEUED) {
    s.skipped++;
    return;
  }
  // One opinion per subject (settle once).
  if (db.getOutcomeBySubject(`judged:${job.subject}`)) return;
  s.queue.push(job);
  pump(db);
}

function pump(db: MarinaDB): void {
  const s = stateOf(db);
  while (s.inFlight < MAX_IN_FLIGHT && s.queue.length) {
    const job = s.queue.shift()!;
    const p = provider();
    if (!p) {
      s.queue.length = 0;
      return;
    }
    s.inFlight++;
    void run(db, p, job).finally(() => {
      s.inFlight--;
      pump(db);
    });
  }
}

async function run(db: MarinaDB, p: DecisionProvider, job: Job): Promise<void> {
  try {
    const result = await p.ask({ state: job.state, questions: job.questions });
    const read = job.read(result.answers as Record<string, unknown>);
    if (!read) return;
    const judge = `${job.kind}:${result.model || p.model}`;
    recordResolved(db, {
      subject: `judged:${job.subject}`,
      kind: "request",
      source: `${SOURCE}:${job.kind}`,
      domain: "attention",
      owner: job.owner,
      succeeded: read.passed,
      quality: read.quality,
      basis: "judged",
      judge,
      resolvedAt: Date.now(),
    });
    if (job.act && attentionJudgeMode() === "on" && judgeEarned(db, judge)) job.act(read.passed);
  } catch (error) {
    logger.debug("decisions", "attention judge call failed", {
      kind: job.kind,
      error: getErrorMessage(error),
    });
  }
}

/** Whether `judge` (`<kind>:<model>`) has earned acting on its own. */
export function judgeEarned(db: MarinaDB, judge: string): boolean {
  return judgeAgreement(db, { judge }).some((a) => a.judge === judge && a.earned);
}

function truth(
  db: MarinaDB,
  kind: AttentionJudgeKind,
  subject: string,
  owner: string,
  ok: boolean,
) {
  recordResolved(db, {
    subject,
    kind: "request",
    source: `${SOURCE}:${kind}`,
    domain: "attention",
    owner,
    succeeded: ok,
    basis: "mechanical",
    resolvedAt: Date.now(),
  });
}

const isPerson = (db: MarinaDB, name: string) => !db.getAgentConfig(name);

// ─── Wakes (reported by a resident's supervisor) ────────────────────────────

export interface ReportedWake {
  perceptionRef?: string;
  decision: string;
  reason: string;
}

export interface ReportedWakeOutcome {
  ref: string;
  /** The woken turn ran a tool or a world command of the agent's own. */
  worked: boolean;
}

const wakeSubject = (name: string, ref: string) => `attention:wake:${name}:${ref}`;

/** Judge the borderline wakes a supervisor reported for resident `name`. */
export function judgeReportedWakes(db: MarinaDB, name: string, wakes: readonly ReportedWake[]) {
  if (attentionJudgeMode() === "off") return;
  for (const wake of wakes) {
    if (wake.decision !== "now" || !BORDERLINE_WAKE_REASONS.has(wake.reason)) continue;
    const id = wake.perceptionRef?.match(/^tell:(\d+)$/)?.[1];
    if (!id) continue;
    const message = db.getDirectMessage(Number(id));
    if (!message) continue;
    enqueue(db, {
      kind: "attention-wake",
      subject: wakeSubject(name, wake.perceptionRef!),
      owner: name,
      state: { message: fence(message.content), wake_reason: wake.reason },
      questions: WAKE_QUESTIONS,
      read: (answers) => {
        const p = noulOf(answers, "needed");
        return p === undefined ? undefined : { passed: p >= 0.5, quality: p };
      },
      act: (needed) => db.recordAttentionFeedback(name, needed ? "useful" : "noise"),
    });
  }
}

/** Record what woken turns of resident `name` did (the wake judge's truth). */
export function recordWakeOutcomes(
  db: MarinaDB,
  name: string,
  outcomes: readonly ReportedWakeOutcome[],
) {
  if (attentionJudgeMode() === "off") return;
  for (const o of outcomes) truth(db, "attention-wake", wakeSubject(name, o.ref), name, o.worked);
}

// ─── Engine events: deep replies and reviews ────────────────────────────────

/** The engine's event listener (wired in `Engine`). A cheap no-op when off. */
export function observeAttentionJudgeEvent(db: MarinaDB | undefined, event: EngineEvent): void {
  if (!db) return;
  if (
    event.type !== "tell_sent" &&
    event.type !== "review_verdict" &&
    event.type !== "review_closed"
  )
    return;
  if (attentionJudgeMode() === "off") return;
  try {
    if (event.type === "tell_sent") {
      sweepConverge(db);
      if (event.depth >= CONVERGE_MIN_DEPTH) judgeConverge(db, event);
    } else if (event.type === "review_verdict") judgeVerdict(db, event);
    else settleReview(db, event.reviewId);
  } catch (error) {
    logger.debug("decisions", "attention judge skipped an event", {
      type: event.type,
      error: getErrorMessage(error),
    });
  }
}

type TellSent = Extract<EngineEvent, { type: "tell_sent" }>;
type ReviewVerdict = Extract<EngineEvent, { type: "review_verdict" }>;

function judgeConverge(db: MarinaDB, event: TellSent): void {
  const id = event.messageRef.match(/^tell:(\d+)$/)?.[1];
  const message = id ? db.getDirectMessage(Number(id)) : undefined;
  if (!message) return;
  const causeId = event.cause?.match(/^tell:(\d+)$/)?.[1];
  const answered = causeId ? db.getDirectMessage(Number(causeId)) : undefined;
  enqueue(db, {
    kind: "attention-converge",
    subject: `attention:converge:${event.messageRef}`,
    owner: event.from,
    state: {
      ...(answered ? { answers: fence(answered.content) } : {}),
      reply: fence(message.content),
      depth: event.depth,
    },
    questions: CONVERGE_QUESTIONS,
    read: (answers) => {
      const p = noulOf(answers, "adds");
      return p === undefined ? undefined : { passed: p >= 0.5, quality: p };
    },
    // Repetition is noise for whoever it was sent to.
    act: (adds) => db.recordAttentionFeedback(event.to, adds ? "useful" : "noise"),
  });
}

/**
 * Settle deep-reply opinions whose window has passed: the reply converged
 * (passed) unless a person told its sender something within the window.
 * At most once a minute, a bounded batch.
 */
export function sweepConverge(db: MarinaDB, now = Date.now()): void {
  const s = stateOf(db);
  if (now - s.lastSweep < 60_000) return;
  s.lastSweep = now;
  const prefix = "judged:attention:converge:";
  for (const opinion of db.listOutcomes({ subjectPrefix: prefix, basis: "judged", limit: 200 })) {
    if (now - opinion.resolved_at < CONVERGE_WINDOW_MS) continue;
    const subject = opinion.subject.slice("judged:".length);
    if (db.getOutcomeBySubject(subject)) continue;
    const ref = subject.slice("attention:converge:".length);
    const message = db.getDirectMessage(Number(ref.slice("tell:".length)));
    if (!message) continue;
    const until = message.created_at + CONVERGE_WINDOW_MS;
    const steered = db
      .listDirectMessageInbox(message.sender_id, 50)
      .some(
        (m) =>
          m.created_at > message.created_at && m.created_at <= until && isPerson(db, m.sender_name),
      );
    truth(db, "attention-converge", subject, opinion.owner ?? message.sender_name, !steered);
  }
}

interface ReviewMetaLite {
  round?: number;
  verdicts?: { round: number; verdict: "approve" | "rework"; by: string; findingsId?: string }[];
  snapshots?: string[];
  closed?: { outcome: "merged" | "rejected" };
}

function reviewMetaOf(db: MarinaDB, reviewId: string): ReviewMetaLite | undefined {
  const row = db.getCodingArtifact(reviewId);
  if (!row) return undefined;
  try {
    return JSON.parse(row.metadata_json) as ReviewMetaLite;
  } catch {
    return undefined;
  }
}

function judgeVerdict(db: MarinaDB, event: ReviewVerdict): void {
  const meta = reviewMetaOf(db, event.reviewId);
  const record = meta?.verdicts?.find((v) => v.round === event.round);
  if (!meta || !record) return;
  const findings = record.findingsId ? db.getCodingArtifact(record.findingsId)?.content_text : "";
  const snapshot = meta.snapshots?.at(-1) ? db.getCodingArtifact(meta.snapshots.at(-1)!) : null;
  let claims = "";
  try {
    claims = snapshot
      ? ((JSON.parse(snapshot.metadata_json) as { claims?: string }).claims ?? "")
      : "";
  } catch {
    claims = "";
  }
  const state = {
    verdict: event.verdict,
    ...(claims ? { author_claims: fence(claims) } : {}),
    findings: findings ? fence(findings) : "(none given)",
  };
  const base = `review:${event.reviewId}:${event.round}`;
  if (event.verdict === "approve")
    enqueue(db, {
      kind: "review-sycophancy",
      subject: `${base}:sycophancy`,
      owner: event.reviewer,
      state,
      questions: SYCOPHANCY_QUESTIONS,
      read: (answers) => {
        const p = noulOf(answers, "checked");
        return p === undefined ? undefined : { passed: p >= 0.5, quality: p };
      },
    });
  enqueue(db, {
    kind: "review-value",
    subject: `${base}:value`,
    owner: event.reviewer,
    state,
    questions: VALUE_QUESTIONS,
    read: (answers) => {
      const a = answers.value as { type?: string; score?: number } | undefined;
      if (a?.type !== "score" || typeof a.score !== "number") return undefined;
      const quality = Math.max(0, Math.min(1, a.score / 4));
      return { passed: quality >= 0.5, quality };
    },
  });
}

/**
 * A person closed a review: every round's verdict gets its truth. An approval
 * held when the review merged at that round; any verdict agreed with the close
 * when it was an approval that merged, or a rework that led to another round
 * or to a rejection.
 */
function settleReview(db: MarinaDB, reviewId: string): void {
  const meta = reviewMetaOf(db, reviewId);
  const outcome = meta?.closed?.outcome;
  if (!meta || !outcome) return;
  const last = Math.max(0, ...(meta.verdicts ?? []).map((v) => v.round));
  for (const v of meta.verdicts ?? []) {
    const base = `review:${reviewId}:${v.round}`;
    const held = v.verdict === "approve" && outcome === "merged" && v.round === last;
    const agreed = v.verdict === "approve" ? held : v.round < last || outcome === "rejected";
    if (v.verdict === "approve") truth(db, "review-sycophancy", `${base}:sycophancy`, v.by, held);
    truth(db, "review-value", `${base}:value`, v.by, agreed);
  }
}

/**
 * Advisory lines for `code review <id>` under `on`: opinions of EARNED
 * review judges only. Empty otherwise.
 */
export function reviewJudgeLines(db: MarinaDB, reviewId: string): string[] {
  if (attentionJudgeMode() !== "on") return [];
  const lines: string[] = [];
  const opinions = db.listOutcomes({
    subjectPrefix: `judged:review:${reviewId}:`,
    basis: "judged",
    limit: 50,
  });
  for (const o of opinions.reverse()) {
    if (!o.judge || !judgeEarned(db, o.judge)) continue;
    const [, , , round, what] = o.subject.split(":");
    if (what === "sycophancy" && !o.succeeded)
      lines.push(`judge: the round ${round} approval names no specific checking`);
    if (what === "value")
      lines.push(`judge: round ${round} verdict usefulness ${(o.quality ?? 0).toFixed(2)}`);
  }
  return lines;
}

/** Judgements skipped because the queue was full (readout, tests). */
export function skippedAttentionJudgements(db: MarinaDB): number {
  return states.get(db)?.skipped ?? 0;
}

/** Wait until no judgement is queued or in flight (tests). */
export async function settleAttentionJudges(db: MarinaDB): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const s = states.get(db);
    if (!s || (!s.inFlight && !s.queue.length)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Test seam: the decision provider judges use (undefined ⇒ the harness's). */
export function setAttentionJudgeProviderForTests(
  fn: (() => DecisionProvider | undefined) | undefined,
): void {
  providerOverride = fn;
}
