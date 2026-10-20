// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Marina's orchestration patterns as arena forecasters
 * (`MARINA_ARENA_FORECASTER=formation:<pattern>:<model>[,<model>…]`).
 *
 * Each formation is a small forecasting PROTOCOL over the same round context
 * the crew and the research agent read (`prompt-context.ts`: the truthful start
 * line — the Civiqs nowcast with its date, or the persistence baseline — the
 * rules, the dated history and, for Civiqs, the daily tracker). Formations
 * change HOW several models combine, never WHAT they know: every model sees
 * only what the round froze at its lock.
 *
 *   ensemble     — N independent proposals; the control for the others
 *   deliberation — propose → see the others' anonymized proposals → revise once
 *   debate       — two sealed advocates (above the start / at-or-below it); the
 *                  last model judges direction and trust
 *   chorus       — independent proposals broadcast → each critiques one peer →
 *                  each revises in light of the critique it received
 *   pipeline     — quant → analyst (sees the quant's handoff) → skeptic (trust);
 *                  the crew made strictly sequential (alias `cascade`)
 *   mapreduce    — one model per driver (level/trend, calendar/publication,
 *                  source quirks) proposes an adjustment; reduce = the sum of
 *                  the confidence-shrunk adjustments
 *   blackboard   — a shared scratchpad; two rounds in which each model reads
 *                  the board, appends or corrects evidence and a number
 *   symbiosis    — a pair with complementary inputs (a quant with the numbers,
 *                  an analyst with the context) exchanges contributions; each
 *                  revision must credit the partner's; high disagreement ⇒
 *                  another exchange (at most two), low ⇒ finalize; with more
 *                  than two models, independent pairs aggregated by median
 *   research     — iterative experimentation: each model states a hypothesis
 *                  and picks a small check on the history / daily series; the
 *                  check is COMPUTED here (recent mean, trend, last-k deltas,
 *                  typical move, daily readings after the last value); the
 *                  model keeps or reverts and revises (two checks each)
 *   delphi       — independence before influence: round 1 independent; the
 *                  code summarizes the panel ANONYMOUSLY (median, range, short
 *                  reason snippets, no names); each model revises once having
 *                  seen only that summary; median of the revisions
 *   tournament   — proposals {mean, sd, rationale} meet in pairwise knockout
 *                  matches judged by the last model (an odd field gives a bye);
 *                  the champion's distribution is the answer; the bracket is
 *                  recorded
 *   verification — proposals must pass every aspect check: the mean within the
 *                  series' typical moves of the start, the sd consistent with
 *                  the history's spread, every cited (date, value) present in
 *                  the data shown (all computed here), and — when a decision
 *                  judge is configured — a judged "follows from the evidence";
 *                  median of the passers, the start when none pass
 *
 * Composition (`composeForecastRound`): an optional research crew builds ONE
 * dated, citation-verified dossier per round (the research agent's retrieval
 * and verification), and every member of the formation is handed only its
 * VERIFIED lines; an optional second formation then judges, seeing the first
 * formation's handoff. Research inputs read today's web: shadow only.
 *
 * Aggregation is deterministic code with the crew's clamps, so no formation
 * can make a wild move: a proposal further than 4 start-sds from the start is
 * dropped; the median move is scaled by a trust (0.5 × the proposals'
 * agreement, or the judge's/skeptic's trust); the final move is capped at
 * 2 start-sds; the sd blends toward the proposals' by the same trust with a
 * floor of half the start sd. A failed or malformed call drops out; with no
 * usable proposal the formation files the start forecast.
 *
 * With a verified dossier, delphi and symbiosis also pass their final
 * proposals through the proposal judge (`proposal-judge.ts`,
 * `MARINA_ARENA_PROPOSAL_JUDGE`): judged support weights the median move and
 * can only lower the trust; any judge failure files the unjudged aggregation.
 *
 * Profile rounds run the same patterns over whole profiles, one call per
 * member per step, aggregated cell by cell with these clamps
 * (`formation-profile.ts`); ranking rounds keep their start.
 */

import type { Evidence } from "../decisions/evidence";
import type { DecisionProvider } from "../decisions/types";
import { getErrorMessage } from "../engine/errors";
import { judgeAudit, judgeClaim, newJudgeRecord } from "../forecast/judge";
import { NUMERIC_TEMPLATES, partAssignee } from "../orchestration/formations/catalogue";
import {
  agreement,
  centre,
  DEFAULT_TRUST,
  delphiSummary,
  MAX_FINAL_SD_MOVE,
  MAX_PROPOSAL_SD_MOVE,
  median,
  medianOutcome,
  movedCount,
  round3,
  settle,
} from "../orchestration/formations/combine-numeric";
import { runFormationScore } from "../orchestration/formations/run";
import { formationScore } from "../orchestration/formations/template";
import { requireResearchEvidence } from "../research/admission";
import type { Retriever } from "../research/retrieve";
import { type PageText, verifyDossier } from "../research/verify";
import type { RoundForecast } from "./forecast";
import { forecastRound } from "./forecast";
import {
  type ForecastSignal,
  memberSignals,
  researchSignals,
  SIGNALS_REQUEST,
  signalLines,
} from "./forecast-signals";
import type { ProfileProposal } from "./formation-profile";
import type { Complete } from "./model-forecaster";
import { parseReply } from "./model-forecaster";
import {
  dailyBlock,
  dailyOf,
  datedLines,
  freshestReading,
  historyBlock,
  rulesLines,
  startLine,
  withoutDaily,
} from "./prompt-context";
import {
  PROPOSAL_JUDGED_PATTERNS,
  type ProposalJudgeConfig,
  type ProposalJudgeRecord,
  weighProposals,
} from "./proposal-judge";
import { buildResearchBrief } from "./research/briefs";
import type { CiviqsDaily } from "./research/civiqs-nowcast";
import {
  markResearchFallback,
  type ResearchFallbackMode,
  type ResearchFallbackRecord,
} from "./research-fallback";
import type { ArenaLock, ArenaPoint, ArenaRound, Distribution } from "./types";

// The shared clamps and the ensemble/delphi combiners live in the formation
// catalogue (`src/orchestration/formations/combine-numeric.ts`).
export {
  agreement,
  anonymize,
  DEFAULT_TRUST,
  DELPHI_SNIPPET_CHARS,
  delphiSummary,
  MAX_FINAL_SD_MOVE,
  MAX_PROPOSAL_SD_MOVE,
  median,
  settle,
} from "../orchestration/formations/combine-numeric";

export const FORMATION_PATTERNS = [
  "ensemble",
  "deliberation",
  "debate",
  "chorus",
  "pipeline",
  "mapreduce",
  "blackboard",
  "symbiosis",
  "research",
  "delphi",
  "tournament",
  "verification",
] as const;
export type FormationPattern = (typeof FORMATION_PATTERNS)[number];

/** Legacy / descriptive aliases accepted in a spec. */
const ALIASES: Record<string, FormationPattern> = { cascade: "pipeline" };

export function formationPattern(name: string): FormationPattern | undefined {
  const n = name.toLowerCase();
  if (Object.hasOwn(ALIASES, n)) return ALIASES[n];
  return (FORMATION_PATTERNS as readonly string[]).includes(n)
    ? (n as FormationPattern)
    : undefined;
}

export interface FormationMember {
  name: string;
  complete: Complete;
}

export interface Proposal extends Distribution {
  reason?: string;
}

/** One model call in the protocol, as recorded for the round's detail. */
export interface FormationStep {
  stage: string;
  member: string;
  status: string;
  reply?: Record<string, unknown>;
}

export interface FormationForecast extends RoundForecast {
  lessons?: Awaited<ReturnType<typeof import("../forecast/lessons").recallForecastLessons>>;
  formation?: FormationPattern;
  /** The proposals the final aggregation used, by label. */
  proposals?: Record<string, Proposal>;
  /** Every call in order: stage, member, ok or why it dropped out, the parsed reply. */
  rounds?: FormationStep[];
  trust?: number;
  /** 1 / (1 + (dispersion of the moves / start sd)²); 1 with one proposal. */
  agreement?: number;
  critique?: string;
  /** Pattern-specific audit record: delphi's summary, the tournament bracket, verification's verdicts. */
  protocol?: Record<string, unknown>;
  /** Profile rounds: the whole-profile proposals the per-cell aggregation used, by label. */
  profileProposals?: Record<string, ProfileProposal>;
  fallback?: string;
  dailySource?: string;
  /** The start forecast the formation moved from (the move weight's origin). */
  formationStart?: Distribution;
  /** Profile rounds: the per-cell start the formation moved from (the move weight's origin). */
  formationStartProfile?: Record<string, Distribution>;
  /** Typed signals the members listed (unanchored variant). */
  signals?: ForecastSignal[];
  /** Filled by the service: what the round's calls cost. */
  costUsd?: number;
  /** The proposal judge's record (delphi / symbiosis with verified lines, scalar or per cell; `proposal-judge.ts`). */
  judge?: ProposalJudgeRecord;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

interface Ctx {
  round: ArenaRound;
  base: Distribution;
  history: ArenaPoint[];
  /** Question, dates, rules and the start line. */
  head: string;
  /** The numbers: the 30-point dated history and, when there is one, the daily tracker. */
  numbers: string;
  /** The last 8 dated values (for roles that read context, not the numbers). */
  recent: string;
  steps: FormationStep[];
  daily?: CiviqsDaily;
  /** Appended to every call: the verified dossier and/or an upstream formation's handoff. */
  briefing?: string;
  /** The start forecast as the members were told it (no daily attached). */
  start: RoundForecast;
  /** The dated points the members were shown (history window, daily tracker, start reading). */
  shown: ArenaPoint[];
  /** A decision backend for model-judged aspects (verification); optional. */
  judge?: DecisionProvider;
}

/**
 * The blend with a narrow start can file an sd narrower than every member
 * proposed (start 0.148, members 0.18 / 0.2 / 0.3 → 0.174). No member asked
 * for that confidence: the final sd is at least the narrowest proposal's.
 */
export function atLeastNarrowestProposal(
  topline: Distribution,
  proposals: Record<string, Proposal> | undefined,
): Distribution {
  const sds = Object.values(proposals ?? {})
    .map((p) => p.sd)
    .filter((sd) => Number.isFinite(sd) && sd > 0);
  if (!sds.length) return topline;
  const narrowest = Math.min(...sds);
  return topline.sd < narrowest ? { ...topline, sd: round3(narrowest) } : topline;
}

/**
 * The sd of the equal-weight linear pool (mixture) of members' normals:
 * √(mean sd² + variance of the means). Under CRPS a pool's gain grows with the
 * members' disagreement (Krüger, arXiv:2412.09430), and a delphi round that
 * converges hides the disagreement the members started with — so the pool is
 * taken over EVERY usable reply the protocol recorded, every stage.
 */
export function linearPoolSd(replies: Array<{ mean: number; sd: number }>): number | undefined {
  const ok = replies.filter((r) => Number.isFinite(r.mean) && Number.isFinite(r.sd) && r.sd > 0);
  if (!ok.length) return undefined;
  const mu = ok.reduce((s, r) => s + r.mean, 0) / ok.length;
  const within = ok.reduce((s, r) => s + r.sd * r.sd, 0) / ok.length;
  const between = ok.reduce((s, r) => s + (r.mean - mu) ** 2, 0) / ok.length;
  return Math.sqrt(within + between);
}

/**
 * The usable (mean, sd) replies among a protocol's recorded steps — members'
 * own forecasts. Debate advocates argue an assigned side, so theirs are not
 * opinions; a dropped blowup is not `ok`.
 */
export function recordedReplies(steps: FormationStep[]): Array<{ mean: number; sd: number }> {
  const out: Array<{ mean: number; sd: number }> = [];
  for (const s of steps) {
    const r = s.reply;
    if (s.status !== "ok" || !r || /(^|\/)advocate/.test(s.stage)) continue;
    if (typeof r.mean === "number" && typeof r.sd === "number")
      out.push({ mean: r.mean, sd: r.sd });
  }
  return out;
}

/**
 * The final sd is at least the linear pool of every recorded member reply:
 * the trust blend may file a confident centre, never a spread narrower than
 * the members' own pooled uncertainty. The mean is untouched.
 */
export function atLeastLinearPool(topline: Distribution, steps: FormationStep[]): Distribution {
  const pooled = linearPoolSd(recordedReplies(steps));
  return pooled !== undefined && topline.sd < pooled ? { ...topline, sd: round3(pooled) } : topline;
}

/** The sentence that anchors every member to the start forecast (removed by `unanchored`). */
export const ANCHOR =
  "The start forecast is the default: move from it only for a concrete pattern in the data; extrapolating a short trend or betting on mean reversion usually loses at a horizon of a few days.";
const SCORING = `This is a live public forecasting benchmark scored by CRPS skill against persistence (the last published value, sd 1.5). ${ANCHOR} Too narrow an sd is punished hard; too wide wastes skill.`;
/** The profile protocols' anchoring sentence (`PROFILE_SCORING` in formation-profile.ts). */
export const PROFILE_ANCHOR =
  "The start forecast is the default for every cell: move a cell only for a concrete reason — a pattern in its data or a scheduled event you are confident about; extrapolating a short trend or betting on mean reversion usually loses at a horizon of a few days.";

/** What an `unanchored` member is told instead of `ANCHOR` / `PROFILE_ANCHOR`. */
export const UNANCHORED_GUIDANCE =
  "The start forecast is one estimate, not a default: move from it as far as the evidence warrants — no further, and no less. Weigh each cited source or data point by how fresh it is relative to the start reading and how directly it bears on this measure; an observation older than the start reading is already in it.";

/**
 * The `unanchored` formation variant: the same members, dossier and protocol,
 * but the anchoring sentence is replaced and every reply also lists its
 * evidence as typed signals. A shadow challenger: whether unanchored moves
 * carry information is decided on resolved rounds (earned routing and the
 * learned move weight), not assumed.
 */
export function unanchoredMember(m: FormationMember): FormationMember {
  return {
    name: m.name,
    complete: (system, user) =>
      m.complete(
        `${system.replace(ANCHOR, UNANCHORED_GUIDANCE).replace(PROFILE_ANCHOR, UNANCHORED_GUIDANCE)} ${SIGNALS_REQUEST}`,
        user,
      ),
  };
}
const PROPOSAL_REPLY =
  'Reply with ONE JSON object: {"mean": number, "sd": number > 0, "reason": "<one sentence>"}.';

async function ask(
  ctx: Ctx,
  stage: string,
  member: FormationMember,
  system: string,
  user: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const full = ctx.briefing ? `${user}\n\n${ctx.briefing}` : user;
    const reply = parseReply(await member.complete(system, full));
    ctx.steps.push({
      stage,
      member: member.name,
      status: reply ? "ok" : "invalid reply (no JSON object)",
      ...(reply ? { reply: trimReply(reply) } : {}),
    });
    return reply;
  } catch (err) {
    ctx.steps.push({
      stage,
      member: member.name,
      status: `error: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`,
    });
    return undefined;
  }
}

export function trimReply(r: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(r).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 400) : v]),
  );
}

/** A valid, non-wild proposal, or undefined (and the step says why). */
function proposalOf(ctx: Ctx, reply: Record<string, unknown> | undefined): Proposal | undefined {
  const mean = Number(reply?.mean);
  const sd = Number(reply?.sd);
  const step = ctx.steps.at(-1);
  if (!reply) return undefined;
  if (!Number.isFinite(mean) || !Number.isFinite(sd) || sd <= 0) {
    if (step?.status === "ok") step.status = "invalid reply (no valid mean/sd)";
    return undefined;
  }
  if (Math.abs(mean - ctx.base.mean) > MAX_PROPOSAL_SD_MOVE * ctx.base.sd) {
    if (step) {
      step.status = `dropped: move ${Math.round((mean - ctx.base.mean) * 100) / 100} beyond ${MAX_PROPOSAL_SD_MOVE} start sd`;
    }
    return undefined;
  }
  const reason = typeof reply.reason === "string" ? reply.reason.slice(0, 300) : undefined;
  return { mean, sd, ...(reason ? { reason } : {}) };
}

/** Ask and validate in one step; the proposal is keyed by the step that produced it. */
async function propose(ctx: Ctx, stage: string, m: FormationMember, system: string, user: string) {
  return proposalOf(ctx, await ask(ctx, stage, m, system, user));
}

const show = (p: Proposal) =>
  `{"mean": ${p.mean}, "sd": ${p.sd}}${p.reason ? ` — ${p.reason}` : ""}`;
const peerLabel = (i: number) => `Peer ${String.fromCharCode(65 + i)}`;

interface Outcome {
  proposals: Record<string, Proposal>;
  topline: Distribution;
  trust: number;
  agreement?: number;
  critique?: string;
  protocol?: Record<string, unknown>;
  /** A member's stated reason by proposal key, when the proposal itself carries none (symbiosis). */
  reasons?: Record<string, string>;
}

type Protocol = (ctx: Ctx, members: FormationMember[]) => Promise<Outcome | undefined>;

/** Median of the proposals, trust = DEFAULT_TRUST × their agreement (the catalogue's ensemble combine). */
function byMedian(ctx: Ctx, proposals: Record<string, Proposal>): Outcome | undefined {
  return medianOutcome(ctx.base, proposals);
}

const FORECASTER_SYSTEM = `You are one of several independent forecasters. ${SCORING} ${PROPOSAL_REPLY}`;

async function independent(ctx: Ctx, members: FormationMember[], stage = "propose") {
  const user = `${ctx.head}\n\n${ctx.numbers}`;
  const out = await Promise.all(
    members.map((m) => propose(ctx, stage, m, FORECASTER_SYSTEM, user)),
  );
  return out;
}

function keyed(members: FormationMember[], ps: Array<Proposal | undefined>, prefix = "") {
  const rec: Record<string, Proposal> = {};
  ps.forEach((p, i) => {
    if (p) rec[`${prefix}${i + 1}:${members[i]!.name}`] = p;
  });
  return rec;
}

/** The catalogue's numeric template for these members (`NUMERIC_TEMPLATES`). */
function numericScore(name: keyof typeof NUMERIC_TEMPLATES, members: FormationMember[]) {
  return formationScore(NUMERIC_TEMPLATES[name], {
    k: members.length,
    id: `arena-${name}`,
    assign: (slot, i) =>
      slot === "member" ? partAssignee(members[i]!.name) : "model:marina-arena",
  });
}

/** Step `<prefix><n>` → its 0-based instance. */
const instance = (id: string, prefix: string) => Number(id.slice(prefix.length)) - 1;

/** The catalogue's ensemble: N independent proposals → the median combine. */
const ensemble: Protocol = async (ctx, members) => {
  const user = `${ctx.head}\n\n${ctx.numbers}`;
  const proposals: Array<Proposal | undefined> = [];
  let out: Outcome | undefined;
  await runFormationScore(numericScore("ensemble", members), async ({ step }) => {
    if (step.id === "combine") {
      out = byMedian(ctx, keyed(members, proposals));
      return out ? JSON.stringify(out.topline) : "";
    }
    const i = instance(step.id, "propose");
    proposals[i] = await propose(ctx, "propose", members[i]!, FORECASTER_SYSTEM, user);
    return proposals[i] ? show(proposals[i]!) : "";
  });
  return out;
};

const deliberation: Protocol = async (ctx, members) => {
  const first = await independent(ctx, members);
  const system = `You are one of several forecasters deliberating. You proposed a forecast; now you see your peers' proposals and reasons (anonymized). Revise ONCE: keep yours, move toward a peer whose reason is concrete and grounded in the data, or merge. ${SCORING} ${PROPOSAL_REPLY}`;
  const revised = await Promise.all(
    members.map(async (m, i) => {
      const own = first[i];
      if (!own) return undefined;
      const peers = first
        .map((p, j) => (j !== i && p ? `${peerLabel(j)}: ${show(p)}` : undefined))
        .filter(Boolean);
      if (peers.length === 0) return own;
      const user = `${ctx.head}\n\n${ctx.numbers}\n\nYour proposal: ${show(own)}\nPeers:\n${peers.join("\n")}`;
      return (await propose(ctx, "revise", m, system, user)) ?? own;
    }),
  );
  return byMedian(ctx, keyed(members, revised));
};

const ADVOCATE = (side: string) =>
  `You are a sealed advocate in a forecasting debate. Argue, from the data given only, the strongest HONEST case that the published value will come in ${side} the start forecast's mean, and give the forecast you would file if your case is right. Say plainly if your case is weak (strength near 0). ${SCORING} Reply with ONE JSON object: {"argument": "<two sentences>", "mean": number, "sd": number > 0, "strength": number between 0 and 1}.`;

const debate: Protocol = async (ctx, members) => {
  const up = members[0]!;
  const down = members[1 % members.length]!;
  const judge = members[members.length - 1]!;
  const user = `${ctx.head}\n\n${ctx.numbers}`;
  const [a, b] = await Promise.all([
    ask(ctx, "advocate-up", up, ADVOCATE("ABOVE"), user),
    ask(ctx, "advocate-stay-or-down", down, ADVOCATE("AT OR BELOW"), user),
  ]);
  const pa = proposalOf(ctx, a);
  const pb = proposalOf(ctx, b);
  const side = (r: Record<string, unknown> | undefined, p: Proposal | undefined) =>
    p
      ? `${show(p)}; argument: ${String(r?.argument ?? "").slice(0, 400)}; self-rated strength ${Number(r?.strength ?? Number.NaN)}`
      : "(no valid position)";
  const proposals: Record<string, Proposal> = {};
  if (pa) proposals[`up:${up.name}`] = pa;
  if (pb) proposals[`stay-or-down:${down.name}`] = pb;
  if (!pa && !pb) return undefined;
  const system = `You judge a forecasting debate; you wrote neither position. Decide which direction from the start forecast the evidence supports — "up", "down" or "stay" — how much of that move to trust (0 = file the start forecast, 1 = the full move to your mean), and your forecast. Advocates are paid to argue a side: trust only concrete, data-grounded arguments. ${SCORING} Reply with ONE JSON object: {"direction": "up" | "down" | "stay", "mean": number, "sd": number > 0, "trust": number between 0 and 1, "critique": "<one sentence>"}.`;
  const verdict = await ask(
    ctx,
    "judge",
    judge,
    system,
    `${ctx.head}\n\n${ctx.recent}\n\nAdvocate UP: ${side(a, pa)}\nAdvocate AT-OR-BELOW: ${side(b, pb)}`,
  );
  const critique = typeof verdict?.critique === "string" ? verdict.critique.slice(0, 300) : "";
  const ruled = proposalOf(ctx, verdict);
  if (!ruled) {
    // No usable ruling: the two sealed sides, at the default trust — biased by
    // design, so their median sits near the start unless both lean one way.
    const out = byMedian(ctx, proposals);
    return out && { ...out, critique: "no usable ruling; median of the advocates" };
  }
  const dir = String(verdict?.direction ?? "").toLowerCase();
  const move = ruled.mean - ctx.base.mean;
  const consistent = dir === "up" ? move > 0 : dir === "down" ? move < 0 : false;
  const raw = Number(verdict?.trust);
  const trust = consistent && Number.isFinite(raw) ? clamp(raw, 0, 1) : 0;
  proposals[`judge:${judge.name}`] = ruled;
  return {
    proposals,
    topline: settle(ctx.base, move, ruled.sd, trust),
    trust: round3(trust),
    critique: consistent ? critique : `${dir || "no direction"}: filed the start. ${critique}`,
  };
};

const chorus: Protocol = async (ctx, members) => {
  const first = await independent(ctx, members);
  const wall = first
    .map((p, j) => `${peerLabel(j)}: ${p ? show(p) : "(no valid proposal)"}`)
    .join("\n");
  const n = members.length;
  // Crossfire: member i reviews peer (i+1) mod n.
  const reviewSystem = `You are on a forecasting chorus. Every member's proposal is on the broadcast wall. Critique ONE peer's proposal: what in the data supports or contradicts its move from the start forecast and its sd. ${SCORING} Reply with ONE JSON object: {"critique": "<two sentences>", "suggested_mean": number, "suggested_sd": number > 0}.`;
  const reviews = await Promise.all(
    members.map(async (m, i) => {
      const j = (i + 1) % n;
      if (!first[j]) return undefined;
      const r = await ask(
        ctx,
        "crossfire",
        m,
        reviewSystem,
        `${ctx.head}\n\n${ctx.numbers}\n\nBroadcast wall:\n${wall}\n\nReview ${peerLabel(j)}.`,
      );
      return r
        ? { from: peerLabel(i), text: String(r.critique ?? "").slice(0, 400), r }
        : undefined;
    }),
  );
  const reviseSystem = `You are on a forecasting chorus. A peer critiqued your proposal. Revise once in light of the critique and the wall: keep yours if the critique is not grounded in the data. ${SCORING} ${PROPOSAL_REPLY}`;
  const revised = await Promise.all(
    members.map(async (m, j) => {
      const own = first[j];
      const review = reviews[(j - 1 + n) % n];
      if (!own || !review) return own;
      const s = Number(review.r.suggested_mean);
      const user = `${ctx.head}\n\n${ctx.numbers}\n\nBroadcast wall:\n${wall}\n\nYour proposal (${peerLabel(j)}): ${show(own)}\nCritique from ${review.from}: ${review.text}${Number.isFinite(s) ? ` (suggests mean ${s})` : ""}`;
      return (await propose(ctx, "revise", m, reviseSystem, user)) ?? own;
    }),
  );
  return byMedian(ctx, keyed(members, revised));
};

const PIPELINE_SYSTEM = {
  quant: `You are stage 1 (the quant) of a forecasting pipeline. Read only the numbers: the start forecast, the dated weekly history and, when given, the DAILY tracker the round resolves on. Contract: hand the next stage a distribution grounded in a concrete pattern in the numbers (daily readings after the start reading, a consistent revision), else the start forecast. ${SCORING} ${PROPOSAL_REPLY}`,
  analyst: `You are stage 2 (the analyst) of a forecasting pipeline. You receive the quant's handoff. Contract: adjust it ONLY for context the numbers cannot show — this pollster's or source's house effects, fielding, publication schedule and typical week-to-week noise. If nothing applies, return the quant's numbers unchanged. ${SCORING} ${PROPOSAL_REPLY}`,
  skeptic: `You are stage 3 (the skeptic) of a forecasting pipeline. Most forecasters on this benchmark lose to persistence by moving too far on weak evidence. Contract: given the start forecast and both earlier stages' handoffs, decide how much of the pipeline's move away from the start forecast is justified: trust 0 files the start forecast, 1 the full move. Reply with ONE JSON object: {"trust": number between 0 and 1, "sd_scale": number between 0.5 and 2, "critique": "<one sentence>"}.`,
};

const pipeline: Protocol = async (ctx, members) => {
  const quant = members[0]!;
  const analyst = members[1 % members.length]!;
  const skeptic = members[2 % members.length]!;
  const q = await propose(
    ctx,
    "quant",
    quant,
    PIPELINE_SYSTEM.quant,
    `${ctx.head}\n\n${ctx.numbers}`,
  );
  const a = await propose(
    ctx,
    "analyst",
    analyst,
    PIPELINE_SYSTEM.analyst,
    `${ctx.head}\n\n${ctx.recent}\n\nQuant handoff: ${q ? show(q) : "(the quant produced nothing usable; work from the start forecast)"}`,
  );
  const proposals: Record<string, Proposal> = {};
  if (q) proposals[`quant:${quant.name}`] = q;
  if (a) proposals[`analyst:${analyst.name}`] = a;
  const final = a ?? q;
  if (!final) return undefined;
  const verdict = await ask(
    ctx,
    "skeptic",
    skeptic,
    PIPELINE_SYSTEM.skeptic,
    `${ctx.head}\n\n${ctx.recent}\n\nQuant handoff: ${q ? show(q) : "(none)"}\nAnalyst handoff (the pipeline's forecast): ${a ? show(a) : "(none — the quant's stands)"}`,
  );
  const raw = Number(verdict?.trust);
  const trust = Number.isFinite(raw) ? clamp(raw, 0, 1) : DEFAULT_TRUST;
  const scaleRaw = Number(verdict?.sd_scale);
  return {
    proposals,
    topline: settle(
      ctx.base,
      final.mean - ctx.base.mean,
      final.sd,
      trust,
      Number.isFinite(scaleRaw) ? scaleRaw : 1,
    ),
    trust: round3(trust),
    ...(typeof verdict?.critique === "string" ? { critique: verdict.critique.slice(0, 300) } : {}),
  };
};

/** The drivers mapreduce splits a round into; each is one independent chunk. */
export const DRIVERS = [
  {
    id: "level-trend",
    brief:
      "LEVEL AND TREND: what the numbers alone say about where the value will be — the latest readings relative to the start, any consistent drift or revision.",
    input: (ctx: Ctx) => ctx.numbers,
  },
  {
    id: "calendar",
    brief:
      "CALENDAR AND PUBLICATION: what the timing implies — the days between the last reading and the release, the weekday, holidays, fielding windows, seasonal patterns visible in the dated history.",
    input: (ctx: Ctx) => historyBlock(ctx.round, ctx.history, 16),
  },
  {
    id: "source",
    brief:
      "SOURCE QUIRKS: what you know about this pollster or source — house effects, methodology, sample size and noise, how it revises, known biases relative to other sources.",
    input: (ctx: Ctx) => ctx.recent,
  },
] as const;

const mapreduce: Protocol = async (ctx, members) => {
  const results = await Promise.all(
    DRIVERS.map(async (d, i) => {
      const m = members[i % members.length]!;
      const system = `You are one specialist in a map-reduce forecast. Consider ONLY this driver: ${d.brief} Propose the adjustment to the start forecast's mean attributable to this driver alone (0 when it implies none — the usual case), how confident you are in it, and the sd you would expect for the whole forecast. ${SCORING} Reply with ONE JSON object: {"adjustment": number, "confidence": number between 0 and 1, "sd": number > 0, "reason": "<one sentence>"}.`;
      const r = await ask(ctx, `map:${d.id}`, m, system, `${ctx.head}\n\n${d.input(ctx)}`);
      const adj = Number(r?.adjustment);
      const conf = Number(r?.confidence);
      const sd = Number(r?.sd);
      const step = ctx.steps.find((s) => s.stage === `map:${d.id}`);
      if (!r) return undefined;
      if (!Number.isFinite(adj) || !Number.isFinite(sd) || sd <= 0) {
        if (step) step.status = "invalid reply (no valid adjustment/sd)";
        return undefined;
      }
      if (Math.abs(adj) > MAX_PROPOSAL_SD_MOVE * ctx.base.sd) {
        if (step)
          step.status = `dropped: adjustment ${adj} beyond ${MAX_PROPOSAL_SD_MOVE} start sd`;
        return undefined;
      }
      const reason = typeof r.reason === "string" ? r.reason.slice(0, 300) : undefined;
      return {
        key: `${d.id}:${m.name}`,
        adj,
        weight: DEFAULT_TRUST * (Number.isFinite(conf) ? clamp(conf, 0, 1) : 0.5),
        proposal: { mean: ctx.base.mean + adj, sd, ...(reason ? { reason } : {}) },
      };
    }),
  );
  const ok = results.filter((r): r is NonNullable<typeof r> => r !== undefined);
  if (ok.length === 0) return undefined;
  // Reduce: the shrunk adjustments add (drivers are independent chunks); the
  // sd blends toward the specialists' by their mean weight.
  const move = ok.reduce((s, r) => s + r.weight * r.adj, 0);
  const w = ok.reduce((s, r) => s + r.weight, 0) / ok.length;
  const sd = median(ok.map((r) => r.proposal.sd));
  // settle() applies the trust; pass the already-shrunk move with trust 1 on
  // the mean, and the sd blend at the mean weight.
  const blended = settle(ctx.base, 0, sd, w);
  const cap = MAX_FINAL_SD_MOVE * ctx.base.sd;
  return {
    proposals: Object.fromEntries(ok.map((r) => [r.key, r.proposal])),
    topline: { mean: round3(ctx.base.mean + clamp(move, -cap, cap)), sd: blended.sd },
    trust: round3(w),
  };
};

const blackboard: Protocol = async (ctx, members) => {
  const board: string[] = [];
  const latest: Array<Proposal | undefined> = members.map(() => undefined);
  const system = `You work on a shared forecasting blackboard with other models. Read the CURRENT board and improve it: add one new piece of evidence from the data, or correct an existing entry that misreads it (name its number) — never repeat what is already there. Then give your current forecast. ${SCORING} Reply with ONE JSON object: {"evidence": "<one sentence, or 'none'>", "corrects": number | null, "mean": number, "sd": number > 0}.`;
  for (let pass = 1; pass <= 2; pass++) {
    for (const [i, m] of members.entries()) {
      const state = board.length ? board.join("\n") : "(empty)";
      const r = await ask(
        ctx,
        `pass${pass}`,
        m,
        system,
        `${ctx.head}\n\n${ctx.numbers}\n\nBLACKBOARD (oldest first):\n${state}`,
      );
      const p = proposalOf(ctx, r);
      if (!p) continue;
      latest[i] = p;
      const ev = String(r?.evidence ?? "none").slice(0, 300);
      const fix = Number(r?.corrects);
      board.push(
        `#${board.length + 1} (${peerLabel(i)}, pass ${pass})${Number.isInteger(fix) && fix >= 1 && fix <= board.length ? ` corrects #${fix}:` : ""} ${ev} → {"mean": ${p.mean}, "sd": ${p.sd}}`,
      );
    }
  }
  const out = byMedian(ctx, keyed(members, latest));
  return out && { ...out, critique: board.join(" | ").slice(0, 1_500) };
};

/** |move difference| of a pair in start-sds above which symbiosis exchanges again. */
export const SYMBIOSIS_DISAGREEMENT = 0.5;
const SYMBIOSIS_MAX_EXCHANGES = 2;

const SYMBIOSIS_SYSTEM = {
  quant: `You are the QUANT half of a symbiotic forecasting pair. You see the numbers (the dated history and, when given, the daily tracker); your partner, the analyst, does not — and it knows the source's context (house effects, fielding, publication) that you are not asked about. ${SCORING}`,
  analyst: `You are the ANALYST half of a symbiotic forecasting pair. You see the question, the rules and the last few published values; your partner, the quant, sees the full numbers (and any daily tracker) that you do not. Contribute what you know about this source — house effects, fielding, publication schedule, typical noise. ${SCORING}`,
};
const FIRST_REPLY =
  'Reply with ONE JSON object: {"contribution": "<the one thing your partner cannot see that matters most>", "mean": number, "sd": number > 0}.';
const EXCHANGE_REPLY =
  'Use your partner\'s contribution and CREDIT it: say what you took from it (or why it changes nothing). Reply with ONE JSON object: {"credit": "<what you used from your partner>", "contribution": "<anything new for your partner, or none>", "mean": number, "sd": number > 0}.';

/** One symbiotic pair: quant + analyst, credited exchanges, mode switch on disagreement. */
async function symbioticPair(
  ctx: Ctx,
  quant: FormationMember,
  analyst: FormationMember,
  tag: string,
): Promise<{
  proposals: Record<string, Proposal>;
  modes: string[];
  reasons: Record<string, string>;
}> {
  const pair = [
    { role: "quant" as const, m: quant, input: ctx.numbers },
    { role: "analyst" as const, m: analyst, input: ctx.recent },
  ];
  const state = await Promise.all(
    pair.map(async (p) => {
      const r = await ask(
        ctx,
        `${tag}${p.role}:open`,
        p.m,
        `${SYMBIOSIS_SYSTEM[p.role]} ${FIRST_REPLY}`,
        `${ctx.head}\n\n${p.input}`,
      );
      const contribution = String(r?.contribution ?? "").slice(0, 400);
      return { p: proposalOf(ctx, r), contribution, note: contribution };
    }),
  );
  const modes: string[] = [];
  const gap = () =>
    state[0]!.p && state[1]!.p ? Math.abs(state[0]!.p.mean - state[1]!.p.mean) / ctx.base.sd : 0;
  for (let x = 1; x <= SYMBIOSIS_MAX_EXCHANGES; x++) {
    // Mode switch: exchange when the pair disagrees (or one half is still
    // missing a partner's view); finalize when it has converged.
    const g = gap();
    const exchange = x === 1 || g > SYMBIOSIS_DISAGREEMENT;
    modes.push(`${x === 1 ? "open" : `gap ${round3(g)}`} → ${exchange ? "exchange" : "finalize"}`);
    if (!exchange) break;
    const next = await Promise.all(
      pair.map(async (p, i) => {
        const partner = state[1 - i]!;
        const own = state[i]!;
        const r = await ask(
          ctx,
          `${tag}${p.role}:exchange${x}`,
          p.m,
          `${SYMBIOSIS_SYSTEM[p.role]} ${EXCHANGE_REPLY}`,
          `${ctx.head}\n\n${p.input}\n\nYour forecast: ${own.p ? show(own.p) : "(none yet)"}\nYour partner's contribution: ${partner.contribution || "(none)"}\nYour partner's forecast: ${partner.p ? show(partner.p) : "(none)"}`,
        );
        const credit = String(r?.credit ?? "").trim();
        const revised = proposalOf(ctx, r);
        const step = ctx.steps.at(-1);
        if (revised && !credit) {
          // Symbiosis requires using the partner: an uncredited revision is not taken.
          if (step) step.status = "not taken: no credit to the partner";
          return own;
        }
        const contribution = String(r?.contribution ?? own.contribution).slice(0, 400);
        return {
          p: revised ?? own.p,
          contribution,
          note: revised ? [credit, contribution].filter(Boolean).join("; ") : own.note,
        };
      }),
    );
    state.splice(0, 2, ...next);
  }
  if (!modes.at(-1)?.endsWith("finalize")) {
    modes.push(`gap ${round3(gap())} → finalize (exchange cap)`);
  }
  const proposals: Record<string, Proposal> = {};
  const reasons: Record<string, string> = {};
  pair.forEach((p, i) => {
    const got = state[i]!.p;
    if (!got) return;
    const key = `${tag}${p.role}:${p.m.name}`;
    proposals[key] = got;
    if (state[i]!.note) reasons[key] = `${p.role}: ${state[i]!.note}`;
  });
  return { proposals, modes, reasons };
}

/**
 * Symbiosis. Two models: one pair, as designed. More: consecutive pairs
 * (an odd member out pairs with the first), run in parallel; each pair
 * contributes ONE proposal — the mean of its halves — and the pairs are
 * aggregated by median with the usual dispersion shrink, so a single bad
 * exchange no longer moves the whole forecast.
 */
const symbiosis: Protocol = async (ctx, members) => {
  if (members.length <= 2) {
    const one = await symbioticPair(ctx, members[0]!, members[1 % members.length]!, "");
    const out = byMedian(ctx, one.proposals);
    return out && { ...out, critique: one.modes.join("; "), reasons: one.reasons };
  }
  const pairs: Array<[FormationMember, FormationMember]> = [];
  for (let i = 0; i < members.length; i += 2) {
    pairs.push([members[i]!, members[i + 1] ?? members[0]!]);
  }
  const results = await Promise.all(
    pairs.map(([q, a], i) => symbioticPair(ctx, q, a, `pair${i + 1}/`)),
  );
  const perPair: Record<string, Proposal> = {};
  const notes: string[] = [];
  const reasons: Record<string, string> = {};
  results.forEach((r, i) => {
    const halves = Object.values(r.proposals);
    notes.push(`pair${i + 1}: ${r.modes.join(", ")}`);
    if (halves.length === 0) return;
    const said = Object.values(r.reasons).join(" | ");
    if (said) reasons[`pair${i + 1}`] = said;
    perPair[`pair${i + 1}`] = {
      ...halves[0]!,
      mean: halves.reduce((s, h) => s + h.mean, 0) / halves.length,
      sd: halves.reduce((s, h) => s + h.sd, 0) / halves.length,
    };
  });
  const out = byMedian(ctx, perPair);
  return out && { ...out, critique: notes.join(" | ").slice(0, 1_500), reasons };
};

/** The checks the research pattern can run; each is computed here, never by a model. */
export const RESEARCH_CHECKS = [
  "recent_mean",
  "trend",
  "deltas",
  "typical_move",
  "daily_after_last",
] as const;

/** Run one named check on the round's own series. Pure; unknown checks say so. */
export function runCheck(
  name: string,
  k: number,
  series: "history" | "daily",
  history: ArenaPoint[],
  daily: CiviqsDaily | undefined,
): string {
  const pts = series === "daily" ? (daily?.points ?? []) : history;
  const n = Math.max(2, Math.min(Number.isFinite(k) ? Math.round(k) : 4, 30));
  const vals = pts.slice(-n).map((p) => p.value);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  if (name === "daily_after_last") {
    const last = history.at(-1);
    const after = (daily?.points ?? []).filter((p) => !last || p.date > last.date);
    return after.length
      ? `daily readings after the last published value (${last?.date} ${last?.value}): ${after.map((p) => `${p.date} ${p.value}`).join(", ")}`
      : "no daily readings after the last published value";
  }
  if (vals.length < 2) return `${name}: not enough ${series} points`;
  if (name === "recent_mean") {
    return `mean of the last ${vals.length} ${series} values: ${r2(vals.reduce((a, b) => a + b, 0) / vals.length)} (last ${vals.at(-1)})`;
  }
  const deltas = vals.slice(1).map((v, i) => v - vals[i]!);
  if (name === "deltas") {
    return `last ${deltas.length} ${series} changes: ${deltas.map((d) => (d >= 0 ? `+${r2(d)}` : `${r2(d)}`)).join(", ")}`;
  }
  if (name === "trend") {
    const xs = vals.map((_, i) => i);
    const mx = (vals.length - 1) / 2;
    const my = vals.reduce((a, b) => a + b, 0) / vals.length;
    const slope =
      xs.reduce((a, x, i) => a + (x - mx) * (vals[i]! - my), 0) /
      xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    return `least-squares slope over the last ${vals.length} ${series} values: ${r2(slope)} per step`;
  }
  if (name === "typical_move") {
    const abs = deltas.map(Math.abs).sort((a, b) => a - b);
    const q = (p: number) => abs[Math.min(abs.length - 1, Math.floor(p * abs.length))]!;
    return `over the last ${deltas.length} ${series} changes: median |change| ${r2(median(abs))}, 80th percentile ${r2(q(0.8))}, largest ${r2(abs.at(-1)!)}`;
  }
  return `unknown check "${name}" (choose one of ${RESEARCH_CHECKS.join(", ")})`;
}

const RESEARCH_SYSTEM = `You forecast by iterative experimentation. Each iteration: state a HYPOTHESIS about the published value, choose ONE small check to test it — ${RESEARCH_CHECKS.join(", ")} — with k (how many recent points) and series ("history" or "daily"), and give your current forecast. You will see the check's result, computed exactly; then KEEP or REVERT your move and revise. ${SCORING} Reply with ONE JSON object: {"hypothesis": "<one sentence>", "check": {"name": "<check>", "k": number, "series": "history" | "daily"}, "decision": "keep" | "revert" | "start", "mean": number, "sd": number > 0}.`;

const research: Protocol = async (ctx, members) => {
  const finals = await Promise.all(
    members.map(async (m) => {
      const log: string[] = [];
      let current: Proposal | undefined;
      let checkReq: Record<string, unknown> | undefined;
      for (let it = 1; it <= 3; it++) {
        const user = `${ctx.head}\n\n${ctx.numbers}${log.length ? `\n\nLAB NOTEBOOK (your iterations so far):\n${log.join("\n")}` : ""}${it === 3 ? "\n\nThis is your FINAL iteration: give your forecast (the check is ignored)." : ""}`;
        const r = await ask(ctx, `iteration${it}`, m, RESEARCH_SYSTEM, user);
        const p = proposalOf(ctx, r);
        const decision = String(r?.decision ?? "");
        // "revert" returns to the previous forecast (or the start on the first).
        if (p) current = decision === "revert" ? (current ?? p) : p;
        checkReq = (r?.check ?? undefined) as Record<string, unknown> | undefined;
        if (it === 3 || !checkReq) break;
        const name = String(checkReq.name ?? "");
        const series = checkReq.series === "daily" ? "daily" : "history";
        const result = runCheck(name, Number(checkReq.k), series, ctx.history, ctx.daily);
        log.push(
          `Gen ${it}: hypothesis=${String(r?.hypothesis ?? "").slice(0, 200)} forecast=${current ? show(current) : "(none)"} check=${name}(${series}, k=${String(checkReq.k)}) result=${result}`,
        );
      }
      return current;
    }),
  );
  return byMedian(ctx, keyed(members, finals));
};

// ─── Delphi: independence before influence ───────────────────────────────────

/** Longest reason snippet a Delphi summary quotes. */
const DELPHI_SYSTEM = `You are a panelist in a Delphi forecast. In round 1 every panelist forecast independently. You now see only an anonymized statistical summary of the panel's round-1 forecasts — no individual forecasts, no names. Revise ONCE: keep your forecast unless the summary points you to something concrete in the data you had missed; a panel median is not evidence by itself. ${SCORING} ${PROPOSAL_REPLY}`;

/**
 * The catalogue's delphi: round 1 independent → the anonymous summary (pure)
 * → each member whose round-1 forecast counted revises once (a failed
 * revision keeps it) → the median combine over the revisions.
 */
const delphi: Protocol = async (ctx, members) => {
  const user = `${ctx.head}\n\n${ctx.numbers}`;
  const first: Array<Proposal | undefined> = [];
  const revised: Array<Proposal | undefined> = [];
  let summary: ReturnType<typeof delphiSummary> | undefined;
  let out: Outcome | undefined;
  await runFormationScore(numericScore("delphi", members), async ({ step }) => {
    if (step.id === "summary") {
      const valid = first.filter((p): p is Proposal => p !== undefined);
      // A summary of one forecast is that forecast: nothing to revise against.
      if (valid.length >= 2) summary = delphiSummary(ctx.base, valid, members);
      return summary?.text ?? "";
    }
    if (step.id === "combine") {
      out = summaryOutcome(ctx, members, first, revised, summary);
      return out ? JSON.stringify(out.topline) : "";
    }
    if (step.id.startsWith("round1")) {
      const i = instance(step.id, "round1");
      first[i] = await propose(ctx, "round1", members[i]!, FORECASTER_SYSTEM, user);
      return first[i] ? show(first[i]!) : "";
    }
    const i = instance(step.id, "round2");
    const own = first[i];
    if (!summary || !own) return "";
    revised[i] =
      (await propose(
        ctx,
        "round2",
        members[i]!,
        DELPHI_SYSTEM,
        `${user}\n\nYour round-1 forecast: ${show(own)}\n\n${summary.text}`,
      )) ?? own;
    return show(revised[i]!);
  });
  return out;
};

/** Delphi's combine: the median over the revisions, with the protocol's audit record. */
function summaryOutcome(
  ctx: Ctx,
  members: FormationMember[],
  first: Array<Proposal | undefined>,
  revised: Array<Proposal | undefined>,
  summary: ReturnType<typeof delphiSummary> | undefined,
): Outcome | undefined {
  if (!summary) {
    const out = byMedian(ctx, keyed(members, first));
    return out && { ...out, protocol: { summary: null, revised: 0 } };
  }
  const all = members.map((_, i) => revised[i]);
  const out = byMedian(ctx, keyed(members, all));
  return (
    out && {
      ...out,
      protocol: {
        summary: summary.record,
        round1: keyed(members, first),
        moved: movedCount(all, first),
      },
    }
  );
}

// ─── Tournament: pairwise knockout judged by the last model ──────────────────

export interface TournamentMatch {
  round: number;
  /** Candidate labels; `b` absent ⇒ `a` had a bye. */
  a: string;
  b?: string;
  winner: string;
  /** "judge", "bye", or "fallback: <why>" (the candidate nearer the start advances). */
  decided: string;
  reason?: string;
}

const TOURNAMENT_JUDGE = `You judge one match of a forecasting tournament: two candidate forecasts for the same round, anonymized as A and B, each with its rationale. Pick the one that better fits the evidence in the data and the scoring rule: a mean moved only as far as concrete evidence supports, and an sd honest about how this series moves. A confident-sounding rationale is not evidence. ${SCORING} Reply with ONE JSON object: {"winner": "A" | "B", "reason": "<one sentence>"}.`;

const candidateLine = (tag: string, p: Proposal, base: Distribution) =>
  `Candidate ${tag}: {"mean": ${p.mean}, "sd": ${p.sd}} — a move of ${round3(p.mean - base.mean)} from the start. Rationale: ${p.reason ?? "(none given)"}`;

/**
 * Tournament. With three or more models the last judges and the others
 * propose; with one or two, every model proposes and the last also judges
 * (candidates are anonymized). Each round pairs the survivors in order; an
 * odd survivor out (the last) gets a bye. A match without a usable judgment
 * advances the candidate nearer the start. The champion's distribution is
 * settled at the default trust × the field's agreement, like a median.
 */
const tournament: Protocol = async (ctx, members) => {
  const judge = members[members.length - 1]!;
  const proposers = members.length >= 3 ? members.slice(0, -1) : members;
  const field = keyed(proposers, await independent(ctx, proposers));
  let alive = Object.keys(field);
  if (alive.length === 0) return undefined;
  const bracket: TournamentMatch[] = [];
  for (let round = 1; alive.length > 1; round++) {
    const pairs: Array<[string, string | undefined]> = [];
    for (let i = 0; i < alive.length; i += 2) pairs.push([alive[i]!, alive[i + 1]]);
    const results = await Promise.all(
      pairs.map(async ([a, b], slot): Promise<TournamentMatch> => {
        if (!b) return { round, a, winner: a, decided: "bye" };
        const pa = field[a]!;
        const pb = field[b]!;
        const stage = `match r${round}.${slot + 1}`;
        const verdict = await ask(
          ctx,
          stage,
          judge,
          TOURNAMENT_JUDGE,
          `${ctx.head}\n\n${ctx.numbers}\n\n${candidateLine("A", pa, ctx.base)}\n${candidateLine("B", pb, ctx.base)}`,
        );
        const pick = String(verdict?.winner ?? "")
          .trim()
          .toUpperCase();
        const reason =
          typeof verdict?.reason === "string" ? verdict.reason.slice(0, 300) : undefined;
        if (pick === "A" || pick === "B") {
          return {
            round,
            a,
            b,
            winner: pick === "A" ? a : b,
            decided: "judge",
            ...(reason ? { reason } : {}),
          };
        }
        // No usable judgment: the more conservative candidate advances.
        const why = verdict
          ? "no A/B winner in the reply"
          : (ctx.steps.find((s) => s.stage === stage)?.status ?? "no reply");
        const nearer =
          Math.abs(pb.mean - ctx.base.mean) < Math.abs(pa.mean - ctx.base.mean) ? b : a;
        return { round, a, b, winner: nearer, decided: `fallback: ${why}` };
      }),
    );
    bracket.push(...results);
    alive = results.map((m) => m.winner);
  }
  const champion = alive[0]!;
  const win = field[champion]!;
  const agree = agreement(ctx.base, Object.values(field));
  const trust = DEFAULT_TRUST * agree;
  return {
    proposals: { [champion]: win },
    topline: settle(ctx.base, win.mean - ctx.base.mean, win.sd, trust),
    trust: round3(trust),
    agreement: round3(agree),
    critique: `champion ${champion}`,
    protocol: { judge: judge.name, field, bracket, champion },
  };
};

// ─── Verification: every aspect must pass ────────────────────────────────────

/** The plausible band's half-width: this quantile of |one-step change| … */
export const VERIFY_BAND_QUANTILE = 0.9;
/** … and at least this share of the start sd. */
export const VERIFY_BAND_FLOOR_SD = 0.25;
/** A proposal's sd must lie in [LO × min(spread, start sd), HI × max(spread, start sd)]. */
export const VERIFY_SD_LO = 0.5;
export const VERIFY_SD_HI = 3;
/** With fewer history points than this, the computed aspects cannot pass. */
export const VERIFY_MIN_POINTS = 3;

export interface AspectVerdict {
  pass: boolean;
  detail: string;
}

/**
 * The series' own scales the computed aspects check against (the last 30
 * published values): the plausible band around the start, from the typical
 * one-step move, and the sd range, from the RMS one-step change. Pure.
 */
export function verificationScales(base: Distribution, history: ArenaPoint[]) {
  const vals = history.slice(-30).map((p) => p.value);
  if (vals.length < VERIFY_MIN_POINTS) return undefined;
  const deltas = vals.slice(1).map((v, i) => v - vals[i]!);
  const abs = deltas.map(Math.abs).sort((a, b) => a - b);
  const q = abs[Math.min(abs.length - 1, Math.floor(VERIFY_BAND_QUANTILE * abs.length))]!;
  const halfWidth = Math.max(q, VERIFY_BAND_FLOOR_SD * base.sd);
  const rms = Math.sqrt(deltas.reduce((s, d) => s + d * d, 0) / deltas.length);
  const spread = rms > 0 ? rms : base.sd;
  return {
    band: [round3(base.mean - halfWidth), round3(base.mean + halfWidth)] as [number, number],
    sdRange: [
      round3(VERIFY_SD_LO * Math.min(spread, base.sd)),
      round3(VERIFY_SD_HI * Math.max(spread, base.sd)),
    ] as [number, number],
    spread: round3(spread),
  };
}

/** A cited value matches the data point on its date, to the data's rounding. */
function citeMatches(point: ArenaPoint, value: number): boolean {
  return (
    Number.isFinite(value) &&
    Math.abs(point.value - value) <= Math.max(0.051, 0.005 * Math.abs(point.value))
  );
}

/**
 * Every `{date, value}` the rationale cites must be a point the members were
 * shown, and at least one is required. Mechanical: dates and values only.
 */
export function checkCitations(cites: unknown, shown: ArenaPoint[]): AspectVerdict {
  if (!Array.isArray(cites) || cites.length === 0) {
    return { pass: false, detail: "cites no dated value from the data" };
  }
  const bad: string[] = [];
  const checked = cites.slice(0, 12);
  for (const c of checked) {
    const date = String((c as { date?: unknown } | null)?.date ?? "").slice(0, 10);
    const value = Number((c as { value?: unknown } | null)?.value);
    if (!shown.some((p) => p.date === date && citeMatches(p, value))) {
      bad.push(`${date || "?"} ${Number.isFinite(value) ? value : "?"}`);
    }
  }
  return bad.length
    ? { pass: false, detail: `${bad.length} cited value(s) not in the data: ${bad.join(", ")}` }
    : { pass: true, detail: `${checked.length} cited value(s), all in the data` };
}

const VERIFY_SYSTEM = `You are one of several independent forecasters; every proposal is checked before it counts. ${SCORING} Ground your reason in the data and cite the dated values it relies on exactly as shown. Reply with ONE JSON object: {"mean": number, "sd": number > 0, "reason": "<one or two sentences>", "cites": [{"date": "YYYY-MM-DD", "value": number}, …]}.`;

/** The series data as judge evidence, labeled as the benchmark's own measurements. */
function judgeEvidence(ctx: Ctx): Evidence[] {
  const label = "STRUCTURED SOURCE DATA (the benchmark's own series; not web research)";
  const out: Evidence[] = [
    {
      ref: "series:history",
      text: `${label}. Published history of ${ctx.round.series ?? ctx.round.round_id} (date value, oldest first):\n${datedLines(ctx.history, 12)}`,
    },
    { ref: "series:start", text: `${label}. ${startLine(ctx.round, ctx.start, ctx.history)}` },
  ];
  if (ctx.daily?.points.length) {
    out.push({
      ref: "series:daily",
      text: `${label}. Civiqs daily tracker from ${ctx.daily.source} (date value, oldest first):\n${datedLines(ctx.daily.points, ctx.daily.points.length)}`,
    });
  }
  return out;
}

/**
 * Verification. Every proposal is checked on separate aspects: `range` (the
 * mean within the series' typical one-step moves of the start), `sd`
 * (consistent with the history's spread), `cites` (every cited dated value is
 * in the data shown) — all computed here — and, when a decision judge is
 * configured, `follows` (the judge finds the rationale grounded in the series
 * data; an outage is no opinion, never a pass; only proposals that passed the
 * computed aspects are judged). A proposal counts only if it passes every
 * aspect; the passers are aggregated by median; none ⇒ the start forecast.
 */
const verification: Protocol = async (ctx, members) => {
  const user = `${ctx.head}\n\n${ctx.numbers}`;
  const replies = await Promise.all(
    members.map(async (m) => {
      const r = await ask(ctx, "propose", m, VERIFY_SYSTEM, user);
      return { r, p: proposalOf(ctx, r) };
    }),
  );
  const scales = verificationScales(ctx.base, ctx.history);
  const judgeRecord = newJudgeRecord(ctx.judge);
  const evidence = ctx.judge ? judgeEvidence(ctx) : [];
  const checked = await Promise.all(
    replies.map(async ({ r, p }, i) => {
      if (!p) return undefined;
      const key = `${i + 1}:${members[i]!.name}`;
      const aspects: Record<string, AspectVerdict> = {};
      if (!scales) {
        const none = { pass: false, detail: `fewer than ${VERIFY_MIN_POINTS} history points` };
        aspects.range = none;
        aspects.sd = none;
      } else {
        const [lo, hi] = scales.band;
        aspects.range = {
          pass: p.mean >= lo && p.mean <= hi,
          detail: `mean ${p.mean} vs plausible ${lo}..${hi}`,
        };
        const [slo, shi] = scales.sdRange;
        aspects.sd = {
          pass: p.sd >= slo && p.sd <= shi,
          detail: `sd ${p.sd} vs consistent ${slo}..${shi}`,
        };
      }
      aspects.cites = checkCitations(r?.cites, ctx.shown);
      if (ctx.judge) {
        if (!Object.values(aspects).every((a) => a.pass)) {
          aspects.follows = { pass: false, detail: "not judged (failed a computed aspect)" };
        } else {
          const draft = `Forecast {"mean": ${p.mean}, "sd": ${p.sd}}. Reason: ${p.reason ?? ""}`;
          const judged = await judgeClaim(
            ctx.judge,
            judgeRecord,
            draft,
            evidence,
            ctx.round.question,
          );
          aspects.follows = judged.judgeError
            ? { pass: false, detail: `judge unavailable: ${judged.judgeError}` }
            : {
                pass: judged.weight > 0,
                detail: `grounded ${judged.grounded ?? "?"}, quality ${judged.quality ?? "?"}`,
              };
        }
      }
      return { key, p, aspects, passed: Object.values(aspects).every((a) => a.pass) };
    }),
  );
  // Recorded in member order, whatever order the checks finished in.
  const verdicts: Record<string, Record<string, AspectVerdict | boolean>> = {};
  const passers: Record<string, Proposal> = {};
  for (const c of checked) {
    if (!c) continue;
    verdicts[c.key] = { ...c.aspects, passed: c.passed };
    if (c.passed) passers[c.key] = c.p;
  }
  const proposed = Object.keys(verdicts).length;
  if (proposed === 0) return undefined;
  const accepted = Object.keys(passers).length;
  const protocol = {
    ...(scales ?? {}),
    verdicts,
    proposed,
    accepted,
    rejected: proposed - accepted,
    ...judgeAudit(judgeRecord),
  };
  if (accepted === 0) {
    // No proposal survived its checks: the start forecast, and the record says why.
    return {
      proposals: {},
      topline: { mean: ctx.base.mean, sd: ctx.base.sd },
      trust: 0,
      critique: `0/${proposed} passed every aspect; the start forecast`,
      protocol,
    };
  }
  const out = byMedian(ctx, passers);
  return out && { ...out, critique: `${accepted}/${proposed} passed every aspect`, protocol };
};

const PROTOCOLS: Record<FormationPattern, Protocol> = {
  ensemble,
  deliberation,
  debate,
  chorus,
  pipeline,
  mapreduce,
  blackboard,
  symbiosis,
  research,
  delphi,
  tournament,
  verification,
};

/** The dated points a member is shown: the history window, the daily tracker, the start reading. */
function shownPoints(
  round: ArenaRound,
  start: RoundForecast,
  history: ArenaPoint[],
  daily: CiviqsDaily | undefined,
): ArenaPoint[] {
  const fresh = freshestReading(start, round.series);
  return [...history.slice(-30), ...(daily?.points ?? []), ...(fresh ? [fresh] : [])];
}

/** The start forecast carries a distribution for every cell of a profile round. */
function hasEveryCell(round: ArenaRound, start: RoundForecast): boolean {
  const cells = round.cells ?? [];
  return cells.length >= 2 && cells.every((c) => start.profile?.[c] !== undefined);
}

export async function formationForecastRound(
  pattern: FormationPattern,
  round: ArenaRound,
  lock: ArenaLock,
  members: FormationMember[],
  /** The start forecast (the nowcast when the caller has one), else the baseline. */
  start?: RoundForecast,
  /** Appended to every call (a verified dossier, an upstream formation's handoff). */
  briefing?: string,
  /** A decision backend for model-judged aspects (verification); omitted ⇒ computed aspects only. */
  judge?: DecisionProvider,
  /** The proposal judge (delphi / symbiosis, scalar or profile) and the verified dossier lines it reads. */
  proposalJudge?: ProposalJudgeConfig & { verified?: string },
): Promise<FormationForecast> {
  const given = start ?? forecastRound(round, lock);
  const daily = dailyOf(given);
  const baseline = withoutDaily(given);
  if (round.target_type === "profile_energy" && hasEveryCell(round, baseline) && members.length) {
    // Profile rounds: the same protocols over whole profiles, aggregated per cell.
    const { profileFormationForecastRound } = await import("./formation-profile");
    return profileFormationForecastRound(
      pattern,
      round,
      lock,
      members,
      baseline,
      briefing,
      judge,
      proposalJudge,
    );
  }
  if (round.target_type !== "continuous_normal" || !baseline.topline || members.length === 0) {
    return {
      ...baseline,
      formation: pattern,
      fallback: "formations answer numeric and profile rounds; the start forecast for this shape",
    };
  }
  const history = lock.answer_history ?? lock.history ?? [];
  const ctx: Ctx = {
    round,
    base: baseline.topline,
    history,
    head: [
      `Question: ${round.question}`,
      `Unit: ${round.unit ?? "(see question)"}`,
      `Published around ${round.release_at}; forecasts lock ${round.lock_at}.`,
      ...rulesLines(round),
      startLine(round, baseline, history),
    ].join("\n"),
    numbers: [historyBlock(round, history, 30), dailyBlock(daily)].filter(Boolean).join("\n\n"),
    recent: historyBlock(round, history, 8),
    steps: [],
    start: baseline,
    shown: shownPoints(round, baseline, history, daily),
    ...(daily ? { daily } : {}),
    ...(briefing ? { briefing } : {}),
    ...(judge ? { judge } : {}),
  };
  const out = await PROTOCOLS[pattern](ctx, members);
  const judged =
    out && proposalJudge && (PROPOSAL_JUDGED_PATTERNS as readonly string[]).includes(pattern)
      ? await judgeOutcome(ctx, out, proposalJudge)
      : undefined;
  const fresh = freshestReading(baseline, round.series);
  const common = {
    formation: pattern,
    rounds: ctx.steps,
    ...(daily ? { dailySource: daily.source } : {}),
  };
  if (!out) return { ...baseline, ...common, fallback: "no usable proposal" };
  const signals = memberSignals(ctx.steps, history.at(-1)?.date);
  return {
    ...baseline,
    ...common,
    formationStart: { mean: ctx.base.mean, sd: ctx.base.sd },
    ...(signals.length ? { signals } : {}),
    topline: atLeastLinearPool(
      atLeastNarrowestProposal(judged?.topline ?? out.topline, out.proposals),
      ctx.steps,
    ),
    proposals: out.proposals,
    trust: judged ? round3(judged.trust) : out.trust,
    ...(judged ? { judge: judged.record } : {}),
    ...(out.agreement !== undefined ? { agreement: out.agreement } : {}),
    ...(out.critique ? { critique: out.critique } : {}),
    ...(out.protocol ? { protocol: out.protocol } : {}),
    note: `marina ${pattern} formation (${members.map((m) => m.name).join(", ")}) over ${fresh ? `the nowcast (${fresh.date})` : "the calibrated baseline"}`,
  };
}

/**
 * The proposal judge over a delphi / symbiosis outcome (`proposal-judge.ts`):
 * the unjudged aggregation is recomputed exactly as `byMedian` made it, then
 * weighed. Anything but `applied` returns that aggregation unchanged.
 */
async function judgeOutcome(
  ctx: Ctx,
  out: Outcome,
  config: ProposalJudgeConfig & { verified?: string },
) {
  const list = Object.values(out.proposals);
  if (list.length === 0) return undefined;
  const trust = DEFAULT_TRUST * agreement(ctx.base, list);
  const c = centre(ctx.base, list);
  return weighProposals({
    config,
    round: ctx.round,
    base: ctx.base,
    proposals: out.proposals,
    ...(out.reasons ? { reasons: out.reasons } : {}),
    verified: config.verified,
    unjudged: { topline: out.topline, trust, move: c.move, sd: c.sd },
    settle: (move, sd, t) => settle(ctx.base, move, sd, t),
  });
}

// ─── Composition: research crew → formation → optional judging formation ─────

export interface FormationStage {
  pattern: FormationPattern;
  members: FormationMember[];
}

/** What the research crew handed over: the verified lines, and its audit record. */
export interface ResearchDossier {
  readSwarm?: import("../research/retrieve").ResearchReport["readSwarm"];
  evidence?: import("../research/evidence").EvidenceSnapshot;
  researchLoop?: import("../research/evidence-loop").ResearchLoopAudit;
  since: string;
  verified: string;
  stats?: Record<string, number>;
  sources: number;
  costUsd: number;
  retriever?: string;
  error?: string;
  status?: "verified" | "empty" | "failed";
  warnings?: string[];
  funnels?: import("../research/retrieve").ResearchReport["funnels"];
  data?: import("../research/retrieve").ResearchReport["data"];
  /** The dossier's typed measurements (target / change claims) as signals. */
  signals?: ForecastSignal[];
}

/**
 * The research crew's one job: a dated, cited dossier for the round, checked
 * line by line against the cited pages (research/verify.ts). Only the lines
 * whose figures were found on their page are handed on.
 */
export async function buildDossier(
  round: ArenaRound,
  lock: ArenaLock,
  start: RoundForecast,
  retriever: Retriever,
  pageText: PageText,
): Promise<ResearchDossier> {
  const used = (start as { nowcast?: Record<string, { date: string; value: number }> }).nowcast;
  const brief =
    round.target_type === "profile_energy"
      ? buildResearchBrief(round, lock, { ...(used ? { cellNowcasts: used } : {}) })
      : buildResearchBrief(round, lock, {
          ...(round.series && used?.[round.series] ? { nowcast: used[round.series] } : {}),
        });
  try {
    const report = await retriever(brief);
    const checked = await verifyDossier(report.report, pageText, report.sources);
    const warnings = [...(report.warnings ?? [])];
    const researchError =
      report.researchLoop?.error ??
      (report.researchLoop?.costFinal === false
        ? "research requests still in flight; cost is not final"
        : undefined);
    if (!checked.verifiedText.trim())
      warnings.push(
        "No verified research evidence; do not attribute forecast changes to research.",
      );
    const signals = researchSignals(
      report.evidence?.index,
      checked.verifiedText,
      (lock.answer_history ?? lock.history ?? []).at(-1)?.date,
    );
    return {
      since: brief.since,
      verified: checked.verifiedText,
      stats: checked.stats,
      status: researchError ? "failed" : checked.verifiedText.trim() ? "verified" : "empty",
      ...(researchError ? { error: researchError } : {}),
      ...(warnings.length ? { warnings } : {}),
      ...(report.funnels ? { funnels: report.funnels } : {}),
      sources: report.sources.length,
      costUsd: report.costUsd ?? 0,
      ...(report.retriever ? { retriever: report.retriever } : {}),
      ...(report.data ? { data: report.data } : {}),
      ...(report.evidence ? { evidence: report.evidence } : {}),
      ...(report.researchLoop ? { researchLoop: report.researchLoop } : {}),
      ...(report.readSwarm ? { readSwarm: report.readSwarm } : {}),
      ...(signals.length ? { signals } : {}),
    };
  } catch (err) {
    return {
      since: brief.since,
      verified: "",
      sources: 0,
      costUsd: 0,
      status: "failed",
      error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    };
  }
}

export function dossierBlock(d: ResearchDossier): string {
  const index = d.researchLoop?.selection?.mode === "on" ? d.evidence?.index : undefined;
  const identity = index
    ? `\nTyped evidence: ${index.stats.target} matching measurements; ${index.stats.change} related changes; ${index.stats.background} background claims; ${index.stats.independentOrigins} distinct recorded origins. Unstructured identity is not a matching measurement.\n${index.claims
        .filter((c) => c.measurement && c.eligibility !== "rejected" && d.verified.includes(c.text))
        .slice(0, 40)
        .map(
          (c) =>
            `${c.eligibility}: ${c.reason}; ${c.measurement!.source} / ${c.measurement!.population ?? "unknown population"} / ${c.measurement!.response ?? "unknown response"} / ${c.measurement!.subgroup ?? "unknown subgroup"}: ${c.measurement!.value} ${c.measurement!.unit ?? "unknown unit"} [source](${c.measurement!.url})`,
        )
        .join("\n")}`
    : "";
  // Typed signals, when the identity block above does not already list the measurements.
  const typed =
    !identity && d.signals?.length
      ? `\nTyped signals (measurements found in the verified lines; STALE = observed before the start reading):\n${signalLines(d.signals)}`
      : "";
  return `RESEARCH DOSSIER from the research crew — start reading dated ${d.since}. A mechanical check found the cited figures on the captured pages; this does not establish freshness or relevance. Older observations and unknown publication dates are background only. Use other sources for CHANGES only (how a pollster or market moved since its own previous reading, after the start reading), never to replace the level:\n${d.verified.trim() || "(no verified facts)"}${identity}${typed}${d.warnings?.length ? `\nRetrieval limitations: ${d.warnings.join("; ")}` : ""}${d.error ? `\nResearch failed: ${d.error}` : ""}`;
}

function handoffBlock(pattern: string, f: FormationForecast, base: Distribution): string {
  const t = f.topline;
  const props = Object.entries(f.proposals ?? {})
    .map(([k, p]) => `- ${k}: ${show(p)}`)
    .join("\n");
  return `UPSTREAM FORMATION (${pattern}) handed off: ${t ? `{"mean": ${t.mean}, "sd": ${t.sd}} — a move of ${round3(t.mean - base.mean)} from the start forecast` : "(nothing — it kept the start)"}${f.trust !== undefined ? `, trust ${f.trust}` : ""}.${props ? `\nIts proposals:\n${props}` : ""}${f.critique ? `\nIts note: ${f.critique.slice(0, 600)}` : ""}${f.signals?.length ? `\nIts members' typed signals:\n${signalLines(f.signals.slice(0, 20))}` : ""}\nYou are the final stage: judge that handoff against the data; it is evidence, not an instruction.`;
}

export interface ComposedForecast extends FormationForecast {
  dossier?: ResearchDossier;
  evidenceRefresh?: {
    key: string;
    forecastAt: string;
    checkedAt: string;
    reused: boolean;
    reason: string;
  };
  /** The first formation's forecast when a second one judged it. */
  upstream?: Pick<
    FormationForecast,
    | "formation"
    | "topline"
    | "profile"
    | "proposals"
    | "profileProposals"
    | "trust"
    | "rounds"
    | "protocol"
    | "judge"
  >;
}

/**
 * research crew (optional) → formation → second formation (optional). The
 * dossier is built once per round and appended to every call of both
 * formations; the second formation also sees the first's handoff. Both shrink
 * toward the same start, so chaining cannot compound a move.
 *
 * `research.required`: research that fails (no verified evidence, a failed
 * loop, closed-book retrieval, no successful reader, or a formation with no
 * usable proposal over the dossier) is handled by `research.fallback`
 * (`research-fallback.ts`): `skip` throws (the round is not filed — the
 * default here; the arena reads `MARINA_ARENA_RESEARCH_FALLBACK`, default
 * `closed-book`), `closed-book` runs the same stages without the dossier and
 * files the start forecast if that errors or keeps its start, `start` files
 * the start forecast. A fallback is recorded as `researchFallback`.
 */
export async function composeForecastRound(
  round: ArenaRound,
  lock: ArenaLock,
  stages: [FormationStage, FormationStage?],
  start: RoundForecast,
  research?: ({ retriever: Retriever; pageText: PageText } | { dossier: ResearchDossier }) & {
    required?: boolean;
    /** What required research that fails files instead (default `skip`: throw). */
    fallback?: ResearchFallbackMode;
    refresh?: { key: string; previous?: ComposedForecast; now?: () => Date };
  },
  /** A decision backend for model-judged aspects, handed to both formations. */
  judge?: DecisionProvider,
  additionalBrief?: string,
  /** The proposal judge: weighs delphi / symbiosis proposals against the dossier's verified lines. */
  proposalJudge?: ProposalJudgeConfig,
): Promise<ComposedForecast> {
  const [first, second] = stages;
  const numeric = round.target_type === "continuous_normal" && Boolean(start.topline);
  const profiled = round.target_type === "profile_energy" && hasEveryCell(round, start);
  const dossier =
    research && (numeric || profiled)
      ? "dossier" in research
        ? structuredClone(research.dossier)
        : await buildDossier(round, lock, start, research.retriever, research.pageText)
      : undefined;
  const fallbackMode = research?.fallback ?? "skip";
  /** Required research failed: the closed-book stages, else the start forecast. */
  const fallBack = async (reason: string): Promise<ComposedForecast> => {
    const mode = fallbackMode as Exclude<ResearchFallbackMode, "skip">;
    const record: ResearchFallbackRecord = { mode, reason, used: "start" };
    const audit = dossier ? { dossier } : {};
    if (mode === "closed-book") {
      try {
        const closed = await composeForecastRound(
          round,
          lock,
          stages,
          start,
          undefined,
          judge,
          additionalBrief,
          proposalJudge,
        );
        if (!closed.fallback)
          return { ...markResearchFallback(closed, { ...record, used: "closed-book" }), ...audit };
        record.closedBookError = closed.fallback;
      } catch (err) {
        record.closedBookError = getErrorMessage(err).slice(0, 300);
      }
    }
    return { ...markResearchFallback(withoutDaily(start), record), ...audit };
  };
  if (research?.required) {
    if (!dossier) throw new Error("Required research refused: unsupported forecast shape");
    try {
      requireResearchEvidence(
        { ...dossier, retriever: dossier.retriever ?? "" },
        dossier.verified,
        dossier.error,
      );
    } catch (err) {
      if (fallbackMode === "skip") throw err;
      return fallBack(getErrorMessage(err));
    }
  }
  let evidenceRefresh: ComposedForecast["evidenceRefresh"];
  if (research?.refresh && dossier) {
    const { decideEvidenceRefresh } = await import("../research/refresh");
    const { key, previous } = research.refresh;
    const now = (research.refresh.now?.() ?? new Date()).toISOString();
    const prior = previous?.evidenceRefresh;
    const decision = decideEvidenceRefresh({
      target: round.round_id,
      releases: dossier.evidence?.brief.releaseEvents,
      key,
      evidence: dossier.evidence?.index,
      now,
      deadline: round.lock_at,
      researchComplete: dossier.status === "verified" && !dossier.error,
      ...(prior && previous?.dossier?.evidence?.index
        ? {
            previous: {
              key: prior.key,
              forecastAt: prior.forecastAt,
              evidence: previous.dossier.evidence.index,
              complete: !previous.fallback && !previous.rounds?.some((r) => r.status !== "ok"),
            },
          }
        : {}),
    });
    if (!decision.run && decision.reason !== "same claims and inputs; reuse complete forecast")
      throw new Error(decision.reason);
    evidenceRefresh = {
      key,
      forecastAt: decision.run ? now : prior!.forecastAt,
      checkedAt: now,
      reused: !decision.run,
      reason: decision.reason,
    };
    if (!decision.run && previous)
      return { ...structuredClone(previous), dossier, evidenceRefresh };
  }
  const brief =
    [dossier ? dossierBlock(dossier) : undefined, additionalBrief].filter(Boolean).join("\n\n") ||
    undefined;
  const weigh = proposalJudge && { ...proposalJudge, verified: dossier?.verified };
  const one = await formationForecastRound(
    first.pattern,
    round,
    lock,
    first.members,
    start,
    brief,
    judge,
    weigh,
  );
  if (research?.required && one.fallback) {
    if (fallbackMode === "skip")
      throw new Error(`Required research forecast refused: ${one.fallback}`);
    return fallBack(`research forecast refused: ${one.fallback}`);
  }
  if (!second || !(numeric || profiled))
    return {
      ...one,
      ...(dossier ? { dossier } : {}),
      ...(evidenceRefresh ? { evidenceRefresh } : {}),
    };
  const handoff = numeric
    ? handoffBlock(first.pattern, one, withoutDaily(start).topline!)
    : (await import("./formation-profile")).profileHandoffBlock(
        first.pattern,
        one,
        round.cells ?? [],
        withoutDaily(start).profile!,
      );
  const two = await formationForecastRound(
    second.pattern,
    round,
    lock,
    second.members,
    start,
    [brief, handoff].filter(Boolean).join("\n\n"),
    judge,
    weigh,
  );
  if (research?.required && two.fallback) {
    if (fallbackMode === "skip")
      throw new Error(`Required research forecast refused: ${two.fallback}`);
    return fallBack(`research forecast refused: ${two.fallback}`);
  }
  return {
    ...two,
    ...(evidenceRefresh ? { evidenceRefresh } : {}),
    ...(dossier ? { dossier } : {}),
    rounds: [
      ...(one.rounds ?? []).map((s) => ({ ...s, stage: `${first.pattern}/${s.stage}` })),
      ...(two.rounds ?? []).map((s) => ({ ...s, stage: `${second.pattern}/${s.stage}` })),
    ],
    upstream: {
      ...(one.formation ? { formation: one.formation } : {}),
      ...(one.topline ? { topline: one.topline } : {}),
      ...(one.profile && profiled ? { profile: one.profile } : {}),
      ...(one.proposals ? { proposals: one.proposals } : {}),
      ...(one.profileProposals ? { profileProposals: one.profileProposals } : {}),
      ...(one.trust !== undefined ? { trust: one.trust } : {}),
      ...(one.protocol ? { protocol: one.protocol } : {}),
      ...(one.judge ? { judge: one.judge } : {}),
    },
    note: `${two.note ?? `marina ${second.pattern}`} judging ${first.pattern}${dossier?.verified.trim() ? " with a verified research dossier" : dossier ? " without verified research evidence" : ""}`,
  };
}
