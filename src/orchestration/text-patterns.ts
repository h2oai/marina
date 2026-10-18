// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Free-text protocols for ONE task under a named orchestration pattern
 * (`POST /v1/patterns/run`, `src/net/api/patterns-api.ts`).
 *
 * These protocols share their NAMES with the orchestration catalogue
 * (`src/world/templates/orchestration.ts`) and with the numeric arena and
 * forecast formations (`src/arena/formations.ts`, `src/forecast/formations.ts`),
 * but they are NOT those formations: the formations combine numbers, these
 * pass text between models. Each protocol is a small, bounded sequence of
 * stages; a checker model picks ONE whole answer where a protocol needs a
 * choice (answers are never merged), with the ensemble's JSON pick contract
 * (`parsePick`).
 *
 * Patterns that need a persistent crew (roles, memory pools, tasks spread
 * over time) are refused here — they run as `marina:<crew>`.
 *
 * Pure: every model call goes through the injected `complete`, every dollar
 * is counted on the injected `SpendGuard`, so the protocols are testable
 * without an engine.
 */

import { getErrorMessage } from "../engine/errors";
import type { SpendGuard } from "../engine/spend-guard";
import { parsePick } from "../net/model-api/ensemble";

/** One model call: a system prompt and a user message in, text and its cost out. Throws on failure. */
export type TextComplete = (
  model: string,
  system: string,
  user: string,
) => Promise<{ text: string; costUsd: number }>;

/** The patterns this endpoint runs as one free-text task. */
export const TEXT_PATTERNS = [
  "ensemble",
  "debate",
  "delphi",
  "tournament",
  "verification",
  "deliberation",
  "chorus",
  "pipeline",
] as const;

export type TextPattern = (typeof TEXT_PATTERNS)[number];

/** Catalogue patterns that need a persistent crew, each with why. */
export const CREW_ONLY_PATTERNS: Readonly<Record<string, string>> = {
  foundry: "an overseer assigns work to a crew and merges it through a gate over time",
  swarm: "crew members self-select subtasks by expertise across many turns",
  mapreduce: "fans a decomposed goal out to crew members as separate tasks",
  blackboard: "crew members refine one shared workspace incrementally",
  symbiosis: "an ongoing exchange between crews scanning a frontier",
  research: "a hypothesis → act → measure → record loop that runs over days",
  auction: "tasks are awarded to crew members by bid",
  ledger: "a running account of commitments kept by a crew",
  sharding: "work is partitioned across crew members holding their own state",
  custom: "a crew-defined protocol with no fixed shape",
};

export function isTextPattern(name: string): name is TextPattern {
  return (TEXT_PATTERNS as readonly string[]).includes(name);
}

export interface PatternStep {
  stage: string;
  /** The model that ran the stage (the checker for picks and reviews). */
  member: string;
  status: "ok" | "failed" | "skipped";
  /** The stage's output (clipped), the checker's reason, or the failure. */
  text?: string;
  costUsd?: number;
}

export interface PatternTrace {
  steps: PatternStep[];
  costUsd: number;
  /** Why the run stopped early and returned its best answer so far. */
  fallback?: string;
}

export interface PatternRunResult {
  message: string;
  success: boolean;
  pattern: TextPattern;
  trace: PatternTrace;
}

export interface RunTextPatternOptions {
  complete: TextComplete;
  /** The model that picks between answers, reviews and summarises. */
  checker: string;
  /** Checked before every stage; every call's cost is recorded on it. */
  budget: SpendGuard;
  /** The caller's disconnect or the run's overall deadline. */
  signal?: AbortSignal;
}

/** Longest stage text kept in the trace. */
const TRACE_TEXT_MAX = 2_000;

const clip = (s: string) => (s.length > TRACE_TEXT_MAX ? `${s.slice(0, TRACE_TEXT_MAX)}…` : s);

// ─── Prompts ────────────────────────────────────────────────────────────────

const ANSWER_SYSTEM =
  "You are one member of a panel working on a task. Answer the task directly and completely; state assumptions briefly.";

/** The free-text counterpart of `ENSEMBLE_PICK_SYSTEM`, with the same JSON reply `parsePick` reads. */
export const TEXT_PICK_SYSTEM = [
  "You choose the best of several CANDIDATE answers to the same task, written independently.",
  "Judge each on correctness, completeness and how directly it answers the task; prefer a specific, well-supported answer over a confident vague one.",
  "You pick ONE whole candidate, never a combination.",
  'Reply with JSON only: {"pick":<candidate number>,"reason":"<≤ 40 words>"}.',
].join(" ");

const ADVOCATE_SYSTEM =
  "You are an advocate in a debate over the best answer to a task. Give your answer and argue for it concisely.";

const REBUTTAL_SYSTEM =
  "You are an advocate in a debate. You see your opening answer and your opponent's. Rebut the opponent's weaknesses, concede what they got right, and give your final answer in full.";

const FACILITATOR_SYSTEM =
  "You facilitate a Delphi panel. Summarise the anonymous answers below: where they agree, where they disagree, and the strongest reason on each side. Do not identify or number respondents and do not add an answer of your own.";

const DELPHI_REVISE_SYSTEM =
  "You are a Delphi panelist. You see your earlier answer and an anonymous summary of the whole panel. Revise your answer once in light of the summary (keep it if you still think it is right) and give it in full.";

const REVIEW_SYSTEM =
  'You review a DRAFT answer to a task for errors, omissions and unsupported claims. Reply with JSON only: {"verdict":"approve"|"revise","issues":"<what to fix, ≤ 80 words>"}.';

const REVISE_SYSTEM =
  "You revise your DRAFT answer to a task once, fixing the reviewer's issues. Give the revised answer in full.";

const PEER_REVISE_SYSTEM =
  "You see your proposal and your peers' anonymous proposals for the same task. Revise yours once, adopting what is better in theirs, and give it in full.";

const CRITIC_SYSTEM =
  "You critique a peer's proposal for a task: name its most important errors and gaps, concretely and briefly. Do not write your own answer.";

const CRITIQUE_REVISE_SYSTEM =
  "You revise your proposal for a task once, addressing a peer's critique (reject points you can show are wrong). Give the revised proposal in full.";

const PIPELINE_FIRST_SYSTEM =
  "You are the first stage of a pipeline. Produce a complete first answer to the task; later stages will refine it.";

const PIPELINE_NEXT_SYSTEM =
  "You are a stage in a pipeline. Improve the previous stage's handoff: fix errors, fill gaps, tighten it. Return the full improved answer, not a commentary.";

const taskBlock = (task: string) => `TASK:\n${task}`;

// ─── The run ────────────────────────────────────────────────────────────────

interface Answer {
  /** A stable label for the trace (`draft-2`). */
  label: string;
  member: string;
  text: string;
}

class Run {
  readonly steps: PatternStep[] = [];
  cost = 0;
  best: string | undefined;
  stopped: string | undefined;

  constructor(
    readonly task: string,
    private readonly o: RunTextPatternOptions,
  ) {}

  get checkerModel(): string {
    return this.o.checker;
  }

  /** True when the next stage must not start (budget, daily cap, deadline or disconnect). */
  halt(): boolean {
    if (this.stopped) return true;
    if (this.o.signal?.aborted) {
      const reason = this.o.signal.reason;
      this.stopped =
        reason instanceof DOMException && reason.name === "TimeoutError"
          ? "deadline: the run's time limit was reached"
          : "aborted: the caller went away";
      return true;
    }
    const why = this.o.budget.stopReason();
    if (why) this.stopped = `budget: ${why}`;
    return !!this.stopped;
  }

  /** One model call, traced and counted; undefined when it failed or came back empty. */
  async call(
    stage: string,
    member: string,
    system: string,
    user: string,
  ): Promise<string | undefined> {
    return (await this.traced(stage, member, system, user)).text;
  }

  /** `call`, also returning its own trace step (stages may run concurrently). */
  async traced(
    stage: string,
    member: string,
    system: string,
    user: string,
  ): Promise<{ text: string | undefined; step: PatternStep }> {
    const step: PatternStep = { stage, member, status: "ok" };
    this.steps.push(step);
    try {
      const r = await this.o.complete(member, system, user);
      const cost = Number.isFinite(r.costUsd) && r.costUsd > 0 ? r.costUsd : 0;
      this.cost += cost;
      this.o.budget.record(cost);
      if (cost > 0) step.costUsd = cost;
      const text = r.text.trim();
      if (!text) {
        step.status = "failed";
        step.text = "empty reply";
        return { text: undefined, step };
      }
      step.text = clip(text);
      return { text, step };
    } catch (e) {
      step.status = "failed";
      step.text = clip(getErrorMessage(e));
      return { text: undefined, step };
    }
  }

  /** The same stage for several members at once; the answers that came back, in member order. */
  async all(
    stage: string,
    jobs: Array<{ label: string; member: string; system: string; user: string }>,
  ): Promise<Answer[]> {
    const texts = await Promise.all(
      jobs.map((j) => this.call(`${stage}:${j.label}`, j.member, j.system, j.user)),
    );
    return jobs.flatMap((j, i) => {
      const text = texts[i];
      return text === undefined ? [] : [{ label: j.label, member: j.member, text }];
    });
  }

  /** Every member answers the task independently. */
  drafts(members: string[], stage = "draft"): Promise<Answer[]> {
    return this.all(
      stage,
      members.map((member, i) => ({
        label: `${stage}-${i + 1}`,
        member,
        system: ANSWER_SYSTEM,
        user: taskBlock(this.task),
      })),
    );
  }

  /**
   * The checker picks ONE answer (0-based). No call for a single candidate or
   * identical ones; an unreadable or failed pick fails open to the first.
   */
  async pick(stage: string, candidates: Answer[]): Promise<number> {
    if (candidates.length <= 1) return 0;
    if (new Set(candidates.map((c) => c.text)).size === 1) {
      this.steps.push({ stage, member: this.o.checker, status: "skipped", text: "unanimous" });
      return 0;
    }
    const user = [
      taskBlock(this.task),
      "CANDIDATE ANSWERS:",
      ...candidates.map((c, i) => `CANDIDATE ${i + 1}:\n${c.text}`),
    ].join("\n\n");
    const { text: raw, step } = await this.traced(stage, this.o.checker, TEXT_PICK_SYSTEM, user);
    const verdict = raw === undefined ? undefined : parsePick(raw, candidates.length);
    if (!verdict) {
      if (step.status === "ok") {
        step.status = "failed";
        step.text = `unreadable pick: ${step.text ?? ""}`;
      }
      return 0;
    }
    const won = candidates[verdict.index]!;
    step.text = `picked ${won.label}${verdict.reason ? `: ${verdict.reason}` : ""}`;
    return verdict.index;
  }

  finish(pattern: TextPattern): PatternRunResult {
    const fallback =
      this.stopped ?? (this.best === undefined ? "no member produced an answer" : undefined);
    return {
      message: this.best ?? "",
      success: fallback === undefined,
      pattern,
      trace: {
        steps: this.steps,
        costUsd: Number(this.cost.toFixed(8)),
        ...(fallback ? { fallback } : {}),
      },
    };
  }
}

// ─── Protocols ──────────────────────────────────────────────────────────────

type Protocol = (r: Run, members: string[]) => Promise<void>;

/** Parallel independent drafts → the checker picks one. */
const ensemble: Protocol = async (r, members) => {
  if (r.halt()) return;
  const drafts = await r.drafts(members);
  r.best = drafts[0]?.text;
  if (drafts.length < 2 || r.halt()) return;
  r.best = drafts[await r.pick("pick", drafts)]!.text;
};

/**
 * Two advocates (the first two members) answer and argue; each then sees the
 * other's opening and rebuts it with a final answer; the checker judges.
 */
const debate: Protocol = async (r, members) => {
  const sides = [members[0]!, members[1] ?? members[0]!];
  if (r.halt()) return;
  const openings = await r.all(
    "opening",
    sides.map((member, i) => ({
      label: `advocate-${i + 1}`,
      member,
      system: ADVOCATE_SYSTEM,
      user: taskBlock(r.task),
    })),
  );
  r.best = openings[0]?.text;
  if (openings.length < 2 || r.halt()) return;
  const rebuttals = await r.all(
    "rebuttal",
    openings.map((own, i) => ({
      label: own.label,
      member: own.member,
      system: REBUTTAL_SYSTEM,
      user: [
        taskBlock(r.task),
        `YOUR OPENING:\n${own.text}`,
        `YOUR OPPONENT'S OPENING:\n${openings[1 - i]!.text}`,
      ].join("\n\n"),
    })),
  );
  // An advocate whose rebuttal failed stands on its opening.
  const finals = openings.map((o) => rebuttals.find((b) => b.label === o.label) ?? o);
  r.best = finals[0]!.text;
  if (r.halt()) return;
  r.best = finals[await r.pick("judge", finals)]!.text;
};

/**
 * Independent drafts → the checker writes an anonymised summary → every
 * panelist revises once against it → the checker picks.
 */
const delphi: Protocol = async (r, members) => {
  if (r.halt()) return;
  const round1 = await r.drafts(members, "round-1");
  r.best = round1[0]?.text;
  if (round1.length < 2 || r.halt()) return;
  const anonymous = round1.map((a) => `ANSWER:\n${a.text}`).join("\n\n---\n\n");
  // Facilitator outage: the panel sees the anonymous answers themselves.
  const summary =
    (await r.call(
      "summary",
      r.checkerModel,
      FACILITATOR_SYSTEM,
      `${taskBlock(r.task)}\n\n${anonymous}`,
    )) ?? anonymous;
  if (r.halt()) return;
  const round2 = await r.all(
    "round-2",
    round1.map((a) => ({
      label: a.label,
      member: a.member,
      system: DELPHI_REVISE_SYSTEM,
      user: [
        taskBlock(r.task),
        `YOUR EARLIER ANSWER:\n${a.text}`,
        `PANEL SUMMARY:\n${summary}`,
      ].join("\n\n"),
    })),
  );
  const finals = round1.map((a) => round2.find((b) => b.label === a.label) ?? a);
  r.best = finals[0]!.text;
  if (r.halt()) return;
  r.best = finals[await r.pick("pick", finals)]!.text;
};

/**
 * Independent drafts → single-elimination bracket of pairwise picks (an odd
 * entrant gets a bye); each match is a trace step `round-N:<a>-vs-<b>`.
 */
const tournament: Protocol = async (r, members) => {
  if (r.halt()) return;
  let entrants = await r.drafts(members);
  r.best = entrants[0]?.text;
  for (let round = 1; entrants.length > 1; round++) {
    if (r.halt()) return;
    const matches: Array<Promise<Answer>> = [];
    for (let i = 0; i < entrants.length; i += 2) {
      const a = entrants[i]!;
      const b = entrants[i + 1];
      if (!b) {
        r.steps.push({
          stage: `round-${round}:${a.label}`,
          member: a.member,
          status: "skipped",
          text: "bye",
        });
        matches.push(Promise.resolve(a));
        continue;
      }
      matches.push(
        r.pick(`round-${round}:${a.label}-vs-${b.label}`, [a, b]).then((k) => (k ? b : a)),
      );
    }
    entrants = await Promise.all(matches);
    r.best = entrants[0]!.text;
  }
};

/** The first member drafts → the checker reviews → one revision when the review asks for it. */
const verification: Protocol = async (r, members) => {
  const author = members[0]!;
  if (r.halt()) return;
  const draft = await r.call("draft", author, ANSWER_SYSTEM, taskBlock(r.task));
  r.best = draft;
  if (draft === undefined || r.halt()) return;
  const raw = await r.call(
    "review",
    r.checkerModel,
    REVIEW_SYSTEM,
    `${taskBlock(r.task)}\n\nDRAFT:\n${draft}`,
  );
  const review = raw === undefined ? undefined : parseReview(raw);
  // A failed or unreadable review keeps the draft (fail open, as the ensemble's pick does).
  if (!review || review.verdict === "approve" || r.halt()) return;
  const revised = await r.call(
    "revise",
    author,
    REVISE_SYSTEM,
    [taskBlock(r.task), `DRAFT:\n${draft}`, `REVIEWER'S ISSUES:\n${review.issues}`].join("\n\n"),
  );
  if (revised !== undefined) r.best = revised;
};

/**
 * Every member proposes → each sees its peers' proposals anonymised and
 * revises once → the checker picks.
 */
const deliberation: Protocol = async (r, members) => {
  if (r.halt()) return;
  const proposals = await r.drafts(members, "propose");
  r.best = proposals[0]?.text;
  if (proposals.length < 2 || r.halt()) return;
  const revised = await r.all(
    "revise",
    proposals.map((own) => ({
      label: own.label,
      member: own.member,
      system: PEER_REVISE_SYSTEM,
      user: [
        taskBlock(r.task),
        `YOUR PROPOSAL:\n${own.text}`,
        "PEER PROPOSALS:",
        ...proposals.filter((p) => p !== own).map((p) => `PROPOSAL:\n${p.text}`),
      ].join("\n\n"),
    })),
  );
  const finals = proposals.map((p) => revised.find((v) => v.label === p.label) ?? p);
  r.best = finals[0]!.text;
  if (r.halt()) return;
  r.best = finals[await r.pick("pick", finals)]!.text;
};

/**
 * Every member proposes → each critiques ONE peer (the next in a ring) →
 * each revises against the critique it received → the checker picks.
 */
const chorus: Protocol = async (r, members) => {
  if (r.halt()) return;
  const proposals = await r.drafts(members, "propose");
  r.best = proposals[0]?.text;
  if (proposals.length < 2 || r.halt()) return;
  const n = proposals.length;
  const critiques = await r.all(
    "critique",
    proposals.map((target, i) => ({
      label: target.label,
      member: proposals[(i + 1) % n]!.member,
      system: CRITIC_SYSTEM,
      user: `${taskBlock(r.task)}\n\nPEER PROPOSAL:\n${target.text}`,
    })),
  );
  if (r.halt()) return;
  const criticised = proposals.flatMap((p) => {
    const c = critiques.find((x) => x.label === p.label);
    return c ? [{ p, critique: c.text }] : [];
  });
  const revised = await r.all(
    "revise",
    criticised.map(({ p, critique }) => ({
      label: p.label,
      member: p.member,
      system: CRITIQUE_REVISE_SYSTEM,
      user: [taskBlock(r.task), `YOUR PROPOSAL:\n${p.text}`, `PEER CRITIQUE:\n${critique}`].join(
        "\n\n",
      ),
    })),
  );
  const finals = proposals.map((p) => revised.find((v) => v.label === p.label) ?? p);
  r.best = finals[0]!.text;
  if (r.halt()) return;
  r.best = finals[await r.pick("pick", finals)]!.text;
};

/** Each member in order refines the previous handoff; the last output wins. */
const pipeline: Protocol = async (r, members) => {
  for (const [i, member] of members.entries()) {
    if (r.halt()) return;
    const user =
      r.best === undefined
        ? taskBlock(r.task)
        : `${taskBlock(r.task)}\n\nPREVIOUS STAGE'S HANDOFF:\n${r.best}`;
    const out = await r.call(
      `stage-${i + 1}`,
      member,
      r.best === undefined ? PIPELINE_FIRST_SYSTEM : PIPELINE_NEXT_SYSTEM,
      user,
    );
    // A failed stage passes the previous handoff on unchanged.
    if (out !== undefined) r.best = out;
  }
};

const PROTOCOLS: Record<TextPattern, Protocol> = {
  ensemble,
  debate,
  delphi,
  tournament,
  verification,
  deliberation,
  chorus,
  pipeline,
};

/** `{"verdict":"approve"|"revise","issues":"…"}` from a review; undefined when unreadable. */
export function parseReview(
  text: string,
): { verdict: "approve" | "revise"; issues: string } | undefined {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  try {
    const j = JSON.parse(m[0]) as { verdict?: unknown; issues?: unknown };
    if (j.verdict !== "approve" && j.verdict !== "revise") return undefined;
    return { verdict: j.verdict, issues: typeof j.issues === "string" ? j.issues.trim() : "" };
  } catch {
    return undefined;
  }
}

/**
 * Run `task` under `pattern` with `members` (1+ model ids, repeats allowed).
 * Never throws for a model failure: a failed call is a failed trace step, and
 * a stop (budget, daily cap, deadline, disconnect) returns the best answer so
 * far with `success: false` and `trace.fallback` naming the reason.
 */
export async function runTextPattern(
  pattern: TextPattern,
  task: string,
  members: string[],
  options: RunTextPatternOptions,
): Promise<PatternRunResult> {
  if (members.length === 0) throw new Error("runTextPattern needs at least one member");
  const run = new Run(task, options);
  await PROTOCOLS[pattern](run, members);
  return run.finish(pattern);
}
