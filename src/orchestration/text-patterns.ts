// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Free-text protocols for ONE task under a named orchestration pattern
 * (`POST /v1/patterns/run`, `src/net/api/patterns-api.ts`, and `pattern run`).
 *
 * Each protocol is its formation's catalogue entry (`./formations/catalogue.ts`,
 * `TEXT_TEMPLATES`): a Score template run on the Score executor, its member
 * steps asked of the members' models and its checker steps of the checker.
 * The members that answer the entrant step are the formation's entrants; the
 * rest of the template runs over them (`afterEntrants`). Between stages the
 * run's budget is checked once (`StageGates`); a checker model picks ONE whole
 * answer where a protocol needs a choice (answers are never merged), with the
 * ensemble's JSON pick contract (`parsePick`, `src/orchestration/pick.ts`).
 *
 * The forecasting surfaces run the same catalogue entries with numeric
 * (`src/arena/formations.ts`) and typed (`src/forecast/formations.ts`)
 * combiners. Patterns that need a persistent crew (roles, memory pools, tasks
 * spread over time) are refused here — they run as `marina:<crew>`; the
 * catalogue says why (`crewOnly`).
 *
 * Pure: every model call goes through the injected `complete`, every dollar
 * is counted on the injected `SpendGuard`, so the protocols are testable
 * without an engine. The catalogue implementation reproduces the
 * pre-catalogue one exactly (`test/formation-equivalence-text.test.ts`).
 */

import { getErrorMessage } from "../engine/errors";
import type { SpendGuard } from "../engine/spend-guard";
import type { Score } from "../sdk/score";
import type { DispatchContext } from "../sdk/score-executor";
import {
  FORMATION_NAMES,
  FORMATIONS,
  partAssignee,
  TEXT_TEMPLATES,
  type TextFormationName,
} from "./formations/catalogue";
import { runFormationScore, StageGates } from "./formations/run";
import { afterEntrants, formationScore, knockout } from "./formations/template";
import { parsePick } from "./pick";

/** One model call: a system prompt and a user message in, text and its cost out. Throws on failure. */
export type TextComplete = (
  model: string,
  system: string,
  user: string,
) => Promise<{ text: string; costUsd: number }>;

/** The patterns this endpoint runs as one free-text task: the catalogue's text templates, in order. */
export const TEXT_PATTERNS: readonly TextFormationName[] = Object.keys(
  TEXT_TEMPLATES,
) as TextFormationName[];

export type TextPattern = TextFormationName;

/** Catalogue patterns that need a persistent crew, each with why (the catalogue's `crewOnly`). */
export const CREW_ONLY_PATTERNS: Readonly<Record<string, string>> = Object.fromEntries(
  FORMATION_NAMES.flatMap((name) => {
    const why = FORMATIONS[name].crewOnly;
    return why ? [[name, why]] : [];
  }),
);

/** The assignee of a text template's pure-code steps. */
const PATTERN_PIPELINE = "model:marina-pattern";

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

// ─── Protocols: the catalogue's text templates on the Score executor ─────────

type Protocol = (r: Run, members: string[]) => Promise<void>;

/** A step that did not run (its stage halted, or its input failed). */
const SKIPPED = "";

/** Step `<prefix><n>` → its 0-based instance. */
const instance = (id: string, prefix: string) => Number(id.slice(prefix.length)) - 1;

/** The template's Score over `n` members (only `steps`, when given). */
function textScore(
  r: Run,
  name: TextPattern,
  members: readonly string[],
  steps?: readonly string[],
): Score {
  return formationScore(TEXT_TEMPLATES[name], {
    k: members.length,
    id: `pattern-${name}`,
    assign: (slot, i) =>
      slot === "checker"
        ? partAssignee(r.checkerModel)
        : slot === "peer"
          ? partAssignee(members[(i + 1) % members.length]!)
          : slot === "member"
            ? partAssignee(members[i % members.length]!)
            : PATTERN_PIPELINE,
    ...(steps ? { only: steps } : {}),
  });
}

/**
 * The template's entrant step: one Score step per member, all at once; the
 * answers that came back, in member order (failed members drop out).
 */
async function entrants(
  r: Run,
  name: TextPattern,
  jobs: Array<{ label: string; member: string; system: string; user: string }>,
  stage: string,
): Promise<Answer[]> {
  const step = TEXT_TEMPLATES[name].entrants!;
  const texts: Array<string | undefined> = [];
  await runFormationScore(
    textScore(
      r,
      name,
      jobs.map((j) => j.member),
      [step],
    ),
    async (ctx) => {
      const i = instance(ctx.step.id, step);
      const j = jobs[i]!;
      texts[i] = await r.call(`${stage}:${j.label}`, j.member, j.system, j.user);
      return texts[i] ?? SKIPPED;
    },
  );
  return jobs.flatMap((j, i) => {
    const text = texts[i];
    return text === undefined ? [] : [{ label: j.label, member: j.member, text }];
  });
}

/** Every member answers the task independently (the entrant step). */
function drafts(r: Run, name: TextPattern, members: string[], stage = "draft"): Promise<Answer[]> {
  return entrants(
    r,
    name,
    members.map((member, i) => ({
      label: `${stage}-${i + 1}`,
      member,
      system: ANSWER_SYSTEM,
      user: taskBlock(r.task),
    })),
    stage,
  );
}

/** The rest of the template, over the entrants that answered. */
function afterThe(
  r: Run,
  name: TextPattern,
  answered: readonly Answer[],
  dispatch: (ctx: DispatchContext) => Promise<string>,
) {
  return runFormationScore(
    textScore(
      r,
      name,
      answered.map((a) => a.member),
      afterEntrants(TEXT_TEMPLATES[name]),
    ),
    dispatch,
  );
}

/** Pick ONE of `finals` as the best answer (a no-op once the run has stopped). */
async function pickBest(r: Run, stage: string, finals: Answer[]): Promise<string> {
  r.best = finals[0]!.text;
  if (r.halt()) return SKIPPED;
  r.best = finals[await r.pick(stage, finals)]!.text;
  return r.best;
}

/** Parallel independent drafts → the checker picks one. */
const ensemble: Protocol = async (r, members) => {
  if (r.halt()) return;
  const answered = await drafts(r, "ensemble", members);
  r.best = answered[0]?.text;
  if (answered.length < 2 || r.halt()) return;
  await afterThe(r, "ensemble", answered, async () => {
    r.best = answered[await r.pick("pick", answered)]!.text;
    return r.best;
  });
};

/**
 * Two advocates (the first two members) answer and argue; each then sees the
 * other's opening and rebuts it with a final answer; the checker judges.
 */
const debate: Protocol = async (r, members) => {
  const sides = [members[0]!, members[1] ?? members[0]!];
  if (r.halt()) return;
  const openings = await entrants(
    r,
    "debate",
    sides.map((member, i) => ({
      label: `advocate-${i + 1}`,
      member,
      system: ADVOCATE_SYSTEM,
      user: taskBlock(r.task),
    })),
    "opening",
  );
  r.best = openings[0]?.text;
  if (openings.length < 2 || r.halt()) return;
  const rebuttals: Array<Answer | undefined> = [];
  await afterThe(r, "debate", openings, async ({ step }) => {
    if (step.id === "judge") {
      // An advocate whose rebuttal failed stands on its opening.
      return pickBest(
        r,
        "judge",
        openings.map((o, i) => rebuttals[i] ?? o),
      );
    }
    const i = instance(step.id, "rebuttal");
    const own = openings[i]!;
    const text = await r.call(
      `rebuttal:${own.label}`,
      own.member,
      REBUTTAL_SYSTEM,
      [
        taskBlock(r.task),
        `YOUR OPENING:\n${own.text}`,
        `YOUR OPPONENT'S OPENING:\n${openings[1 - i]!.text}`,
      ].join("\n\n"),
    );
    if (text !== undefined) rebuttals[i] = { ...own, text };
    return text ?? SKIPPED;
  });
};

/**
 * Independent drafts → the checker writes an anonymised summary → every
 * panelist revises once against it → the checker picks.
 */
const delphi: Protocol = async (r, members) => {
  if (r.halt()) return;
  const round1 = await drafts(r, "delphi", members, "round-1");
  r.best = round1[0]?.text;
  if (round1.length < 2 || r.halt()) return;
  const gates = new StageGates<boolean>();
  const round2: Array<Answer | undefined> = [];
  let summary = "";
  await afterThe(r, "delphi", round1, async ({ step }) => {
    if (step.id === "summary") {
      const anonymous = round1.map((a) => `ANSWER:\n${a.text}`).join("\n\n---\n\n");
      // Facilitator outage: the panel sees the anonymous answers themselves.
      summary =
        (await r.call(
          "summary",
          r.checkerModel,
          FACILITATOR_SYSTEM,
          `${taskBlock(r.task)}\n\n${anonymous}`,
        )) ?? anonymous;
      return summary;
    }
    if (step.id === "pick") {
      if (r.stopped) return SKIPPED;
      return pickBest(
        r,
        "pick",
        round1.map((a, i) => round2[i] ?? a),
      );
    }
    if (gates.once("round-2", () => r.halt())) return SKIPPED;
    const i = instance(step.id, "round2");
    const a = round1[i]!;
    const text = await r.call(
      `round-2:${a.label}`,
      a.member,
      DELPHI_REVISE_SYSTEM,
      [taskBlock(r.task), `YOUR EARLIER ANSWER:\n${a.text}`, `PANEL SUMMARY:\n${summary}`].join(
        "\n\n",
      ),
    );
    if (text !== undefined) round2[i] = { ...a, text };
    return text ?? SKIPPED;
  });
};

/**
 * Independent drafts → single-elimination bracket of pairwise picks (an odd
 * entrant gets a bye); each match is a trace step `round-N:<a>-vs-<b>`. The
 * bracket is the template's, round by round over the drafts that answered.
 */
const tournament: Protocol = async (r, members) => {
  if (r.halt()) return;
  const answered = await drafts(r, "tournament", members);
  r.best = answered[0]?.text;
  if (answered.length < 2) return;
  const rounds = knockout(
    answered.map((_, i) => `draft${i + 1}`),
    "match",
  );
  const slots = new Map(rounds.flat().map((s) => [s.id, s]));
  const holder = new Map<string, Answer>(answered.map((a, i) => [`draft${i + 1}`, a]));
  const gates = new StageGates<boolean>();
  await afterThe(r, "tournament", answered, async ({ step }) => {
    const slot = slots.get(step.id)!;
    const halted = gates.once(`round-${slot.round}`, () => {
      // An earlier round stopped the run: its best answer stands.
      if (r.stopped) return true;
      // The field so far: the first entrant of this round's field is the best answer.
      if (slot.round > 1) r.best = holder.get(rounds[slot.round - 2]![0]!.id)!.text;
      return r.halt();
    });
    if (halted) return SKIPPED;
    const a = holder.get(slot.a)!;
    const b = slot.b === undefined ? undefined : holder.get(slot.b)!;
    if (!b) {
      r.steps.push({
        stage: `round-${slot.round}:${a.label}`,
        member: a.member,
        status: "skipped",
        text: "bye",
      });
      holder.set(slot.id, a);
      return a.text;
    }
    const k = await r.pick(`round-${slot.round}:${a.label}-vs-${b.label}`, [a, b]);
    const winner = k ? b : a;
    holder.set(slot.id, winner);
    if (slot.id === rounds.at(-1)![0]!.id) r.best = winner.text;
    return winner.text;
  });
};

/** The first member drafts → the checker reviews → one revision when the review asks for it. */
const verification: Protocol = async (r, members) => {
  const author = members[0]!;
  if (r.halt()) return;
  let draft: string | undefined;
  let review: ReturnType<typeof parseReview>;
  let ended = false;
  await runFormationScore(textScore(r, "verification", [author]), async ({ step }) => {
    if (step.id === "draft") {
      draft = await r.call("draft", author, ANSWER_SYSTEM, taskBlock(r.task));
      r.best = draft;
      return draft ?? SKIPPED;
    }
    if (step.id === "review") {
      if (draft === undefined || r.halt()) {
        ended = true;
        return SKIPPED;
      }
      const raw = await r.call(
        "review",
        r.checkerModel,
        REVIEW_SYSTEM,
        `${taskBlock(r.task)}\n\nDRAFT:\n${draft}`,
      );
      review = raw === undefined ? undefined : parseReview(raw);
      return raw ?? SKIPPED;
    }
    // A failed or unreadable review keeps the draft (fail open, as the ensemble's pick does).
    if (ended || !review || review.verdict === "approve" || r.halt()) return SKIPPED;
    const revised = await r.call(
      "revise",
      author,
      REVISE_SYSTEM,
      [taskBlock(r.task), `DRAFT:\n${draft}`, `REVIEWER'S ISSUES:\n${review.issues}`].join("\n\n"),
    );
    if (revised !== undefined) r.best = revised;
    return revised ?? SKIPPED;
  });
};

/**
 * Every member proposes → each sees its peers' proposals anonymised and
 * revises once → the checker picks.
 */
const deliberation: Protocol = async (r, members) => {
  if (r.halt()) return;
  const proposals = await drafts(r, "deliberation", members, "propose");
  r.best = proposals[0]?.text;
  if (proposals.length < 2 || r.halt()) return;
  const revised: Array<Answer | undefined> = [];
  await afterThe(r, "deliberation", proposals, async ({ step }) => {
    if (step.id === "pick")
      return pickBest(
        r,
        "pick",
        proposals.map((p, i) => revised[i] ?? p),
      );
    const i = instance(step.id, "revise");
    const own = proposals[i]!;
    const text = await r.call(
      `revise:${own.label}`,
      own.member,
      PEER_REVISE_SYSTEM,
      [
        taskBlock(r.task),
        `YOUR PROPOSAL:\n${own.text}`,
        "PEER PROPOSALS:",
        ...proposals.filter((p) => p !== own).map((p) => `PROPOSAL:\n${p.text}`),
      ].join("\n\n"),
    );
    if (text !== undefined) revised[i] = { ...own, text };
    return text ?? SKIPPED;
  });
};

/**
 * Every member proposes → each critiques ONE peer (the next in a ring) →
 * each revises against the critique it received → the checker picks.
 */
const chorus: Protocol = async (r, members) => {
  if (r.halt()) return;
  const proposals = await drafts(r, "chorus", members, "propose");
  r.best = proposals[0]?.text;
  if (proposals.length < 2 || r.halt()) return;
  const n = proposals.length;
  const critiques: Array<string | undefined> = [];
  const revised: Array<Answer | undefined> = [];
  const gates = new StageGates<boolean>();
  await afterThe(r, "chorus", proposals, async ({ step }) => {
    if (step.id === "pick") {
      if (r.stopped) return SKIPPED;
      return pickBest(
        r,
        "pick",
        proposals.map((p, i) => revised[i] ?? p),
      );
    }
    if (step.id.startsWith("critique")) {
      const i = instance(step.id, "critique");
      const target = proposals[i]!;
      critiques[i] = await r.call(
        `critique:${target.label}`,
        proposals[(i + 1) % n]!.member,
        CRITIC_SYSTEM,
        `${taskBlock(r.task)}\n\nPEER PROPOSAL:\n${target.text}`,
      );
      return critiques[i] ?? SKIPPED;
    }
    if (gates.once("revise", () => r.halt())) return SKIPPED;
    const i = instance(step.id, "revise");
    const p = proposals[i]!;
    const critique = critiques[i];
    if (critique === undefined) return SKIPPED;
    const text = await r.call(
      `revise:${p.label}`,
      p.member,
      CRITIQUE_REVISE_SYSTEM,
      [taskBlock(r.task), `YOUR PROPOSAL:\n${p.text}`, `PEER CRITIQUE:\n${critique}`].join("\n\n"),
    );
    if (text !== undefined) revised[i] = { ...p, text };
    return text ?? SKIPPED;
  });
};

/** Each member in order refines the previous handoff; the last output wins. */
const pipeline: Protocol = async (r, members) => {
  await runFormationScore(textScore(r, "pipeline", members), async ({ step }) => {
    if (r.halt()) return SKIPPED;
    const i = instance(step.id, "stage");
    const member = members[i]!;
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
    return r.best ?? SKIPPED;
  });
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
