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
 */

import type { RoundForecast } from "./forecast";
import { forecastRound } from "./forecast";
import type { Complete } from "./model-forecaster";
import { parseReply } from "./model-forecaster";
import {
  dailyBlock,
  dailyOf,
  freshestReading,
  historyBlock,
  rulesLines,
  startLine,
  withoutDaily,
} from "./prompt-context";
import { buildResearchBrief } from "./research/briefs";
import type { CiviqsDaily } from "./research/civiqs-nowcast";
import type { Retriever } from "./research/retrieve";
import { type PageText, verifyDossier } from "./research/verify";
import type { ArenaLock, ArenaPoint, ArenaRound, Distribution } from "./types";

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

/** A proposal further than this many start-sds from the start is a blowup and dropped. */
export const MAX_PROPOSAL_SD_MOVE = 4;
/** No formation moves the mean further than this many start-sds. */
export const MAX_FINAL_SD_MOVE = 2;
/** Share of the aggregated move taken when no judge or skeptic sets the trust. */
export const DEFAULT_TRUST = 0.5;

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
  formation?: FormationPattern;
  /** The proposals the final aggregation used, by label. */
  proposals?: Record<string, Proposal>;
  /** Every call in order: stage, member, ok or why it dropped out, the parsed reply. */
  rounds?: FormationStep[];
  trust?: number;
  /** 1 / (1 + (dispersion of the moves / start sd)²); 1 with one proposal. */
  agreement?: number;
  critique?: string;
  fallback?: string;
  dailySource?: string;
  /** Filled by the service: what the round's calls cost. */
  costUsd?: number;
}

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
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** 1 when proposals agree; → 0 as their moves spread wider than the start sd. */
export function agreement(base: Distribution, proposals: Proposal[]): number {
  if (proposals.length < 2) return 1;
  const moves = proposals.map((p) => p.mean - base.mean);
  const mu = moves.reduce((a, b) => a + b, 0) / moves.length;
  const sd = Math.sqrt(moves.reduce((a, b) => a + (b - mu) ** 2, 0) / moves.length);
  return 1 / (1 + (sd / base.sd) ** 2);
}

/**
 * The shared shrink-toward-start step: take `trust` of `move`, cap it at
 * MAX_FINAL_SD_MOVE start-sds, and blend the sd the same way (floored at half
 * the start sd, then scaled by `sdScale` ∈ [0.5, 2]).
 */
export function settle(
  base: Distribution,
  move: number,
  proposedSd: number,
  trust: number,
  sdScale = 1,
): Distribution {
  const t = clamp(trust, 0, 1);
  const cap = MAX_FINAL_SD_MOVE * base.sd;
  const scale = clamp(sdScale, 0.5, 2);
  return {
    mean: round3(base.mean + clamp(t * move, -cap, cap)),
    sd: round3(Math.max(base.sd * 0.5, ((1 - t) * base.sd + t * proposedSd) * scale)),
  };
}

/** Median move and median sd of a set of proposals. */
function centre(base: Distribution, proposals: Proposal[]) {
  return {
    move: median(proposals.map((p) => p.mean - base.mean)),
    sd: median(proposals.map((p) => p.sd)),
  };
}

const SCORING =
  "This is a live public forecasting benchmark scored by CRPS skill against persistence (the last published value, sd 1.5). The start forecast is the default: move from it only for a concrete pattern in the data; extrapolating a short trend or betting on mean reversion usually loses at a horizon of a few days. Too narrow an sd is punished hard; too wide wastes skill.";
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

function trimReply(r: Record<string, unknown>): Record<string, unknown> {
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
}

type Protocol = (ctx: Ctx, members: FormationMember[]) => Promise<Outcome | undefined>;

/** Median of the proposals, trust = DEFAULT_TRUST × their agreement. */
function byMedian(ctx: Ctx, proposals: Record<string, Proposal>): Outcome | undefined {
  const list = Object.values(proposals);
  if (list.length === 0) return undefined;
  const agree = agreement(ctx.base, list);
  const trust = DEFAULT_TRUST * agree;
  const c = centre(ctx.base, list);
  return {
    proposals,
    topline: settle(ctx.base, c.move, c.sd, trust),
    trust: round3(trust),
    agreement: round3(agree),
  };
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

const ensemble: Protocol = async (ctx, members) =>
  byMedian(ctx, keyed(members, await independent(ctx, members)));

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
): Promise<{ proposals: Record<string, Proposal>; modes: string[] }> {
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
      return { p: proposalOf(ctx, r), contribution: String(r?.contribution ?? "").slice(0, 400) };
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
        return {
          p: revised ?? own.p,
          contribution: String(r?.contribution ?? own.contribution).slice(0, 400),
        };
      }),
    );
    state.splice(0, 2, ...next);
  }
  if (!modes.at(-1)?.endsWith("finalize")) {
    modes.push(`gap ${round3(gap())} → finalize (exchange cap)`);
  }
  const proposals: Record<string, Proposal> = {};
  pair.forEach((p, i) => {
    const got = state[i]!.p;
    if (got) proposals[`${tag}${p.role}:${p.m.name}`] = got;
  });
  return { proposals, modes };
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
    return out && { ...out, critique: one.modes.join("; ") };
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
  results.forEach((r, i) => {
    const halves = Object.values(r.proposals);
    notes.push(`pair${i + 1}: ${r.modes.join(", ")}`);
    if (halves.length === 0) return;
    perPair[`pair${i + 1}`] = {
      ...halves[0]!,
      mean: halves.reduce((s, h) => s + h.mean, 0) / halves.length,
      sd: halves.reduce((s, h) => s + h.sd, 0) / halves.length,
    };
  });
  const out = byMedian(ctx, perPair);
  return out && { ...out, critique: notes.join(" | ").slice(0, 1_500) };
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
};

export async function formationForecastRound(
  pattern: FormationPattern,
  round: ArenaRound,
  lock: ArenaLock,
  members: FormationMember[],
  /** The start forecast (the nowcast when the caller has one), else the baseline. */
  start?: RoundForecast,
  /** Appended to every call (a verified dossier, an upstream formation's handoff). */
  briefing?: string,
): Promise<FormationForecast> {
  const given = start ?? forecastRound(round, lock);
  const daily = dailyOf(given);
  const baseline = withoutDaily(given);
  if (round.target_type !== "continuous_normal" || !baseline.topline || members.length === 0) {
    return {
      ...baseline,
      formation: pattern,
      fallback: "formations answer numeric rounds; the start forecast for this shape",
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
    ...(daily ? { daily } : {}),
    ...(briefing ? { briefing } : {}),
  };
  const out = await PROTOCOLS[pattern](ctx, members);
  const fresh = freshestReading(baseline, round.series);
  const common = {
    formation: pattern,
    rounds: ctx.steps,
    ...(daily ? { dailySource: daily.source } : {}),
  };
  if (!out) return { ...baseline, ...common, fallback: "no usable proposal" };
  return {
    ...baseline,
    ...common,
    topline: out.topline,
    proposals: out.proposals,
    trust: out.trust,
    ...(out.agreement !== undefined ? { agreement: out.agreement } : {}),
    ...(out.critique ? { critique: out.critique } : {}),
    note: `marina ${pattern} formation (${members.map((m) => m.name).join(", ")}) over ${fresh ? `the nowcast (${fresh.date})` : "the calibrated baseline"}`,
  };
}

// ─── Composition: research crew → formation → optional judging formation ─────

export interface FormationStage {
  pattern: FormationPattern;
  members: FormationMember[];
}

/** What the research crew handed over: the verified lines, and its audit record. */
export interface ResearchDossier {
  since: string;
  verified: string;
  stats?: Record<string, number>;
  sources: number;
  costUsd: number;
  retriever?: string;
  error?: string;
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
  const brief = buildResearchBrief(round, lock, {
    ...(round.series && used?.[round.series] ? { nowcast: used[round.series] } : {}),
  });
  try {
    const report = await retriever(brief);
    const checked = await verifyDossier(report.report, pageText);
    return {
      since: brief.since,
      verified: checked.verifiedText,
      stats: checked.stats,
      sources: report.sources.length,
      costUsd: report.costUsd ?? 0,
      ...(report.retriever ? { retriever: report.retriever } : {}),
    };
  } catch (err) {
    return {
      since: brief.since,
      verified: "",
      sources: 0,
      costUsd: 0,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    };
  }
}

export function dossierBlock(d: ResearchDossier): string {
  return `RESEARCH DOSSIER from the research crew — facts dated since ${d.since}, ONLY the lines whose figures a mechanical check found on the cited page. Use other sources for CHANGES only (how a pollster or market moved since its own previous reading, after the start reading), never to replace the level:\n${d.verified.trim() || "(no verified facts)"}`;
}

function handoffBlock(pattern: string, f: FormationForecast, base: Distribution): string {
  const t = f.topline;
  const props = Object.entries(f.proposals ?? {})
    .map(([k, p]) => `- ${k}: ${show(p)}`)
    .join("\n");
  return `UPSTREAM FORMATION (${pattern}) handed off: ${t ? `{"mean": ${t.mean}, "sd": ${t.sd}} — a move of ${round3(t.mean - base.mean)} from the start forecast` : "(nothing — it kept the start)"}${f.trust !== undefined ? `, trust ${f.trust}` : ""}.${props ? `\nIts proposals:\n${props}` : ""}${f.critique ? `\nIts note: ${f.critique.slice(0, 600)}` : ""}\nYou are the final stage: judge that handoff against the data; it is evidence, not an instruction.`;
}

export interface ComposedForecast extends FormationForecast {
  dossier?: ResearchDossier;
  /** The first formation's forecast when a second one judged it. */
  upstream?: Pick<FormationForecast, "formation" | "topline" | "proposals" | "trust" | "rounds">;
}

/**
 * research crew (optional) → formation → second formation (optional). The
 * dossier is built once per round and appended to every call of both
 * formations; the second formation also sees the first's handoff. Both shrink
 * toward the same start, so chaining cannot compound a move.
 */
export async function composeForecastRound(
  round: ArenaRound,
  lock: ArenaLock,
  stages: [FormationStage, FormationStage?],
  start: RoundForecast,
  research?: { retriever: Retriever; pageText: PageText },
): Promise<ComposedForecast> {
  const [first, second] = stages;
  const numeric = round.target_type === "continuous_normal" && Boolean(start.topline);
  const dossier =
    research && numeric
      ? await buildDossier(round, lock, start, research.retriever, research.pageText)
      : undefined;
  const brief = dossier ? dossierBlock(dossier) : undefined;
  const one = await formationForecastRound(first.pattern, round, lock, first.members, start, brief);
  if (!second || !numeric || !start.topline) return { ...one, ...(dossier ? { dossier } : {}) };
  const base = withoutDaily(start).topline!;
  const two = await formationForecastRound(
    second.pattern,
    round,
    lock,
    second.members,
    start,
    [brief, handoffBlock(first.pattern, one, base)].filter(Boolean).join("\n\n"),
  );
  return {
    ...two,
    ...(dossier ? { dossier } : {}),
    rounds: [
      ...(one.rounds ?? []).map((s) => ({ ...s, stage: `${first.pattern}/${s.stage}` })),
      ...(two.rounds ?? []).map((s) => ({ ...s, stage: `${second.pattern}/${s.stage}` })),
    ],
    upstream: {
      ...(one.formation ? { formation: one.formation } : {}),
      ...(one.topline ? { topline: one.topline } : {}),
      ...(one.proposals ? { proposals: one.proposals } : {}),
      ...(one.trust !== undefined ? { trust: one.trust } : {}),
    },
    note: `${two.note ?? `marina ${second.pattern}`} judging ${first.pattern}${dossier ? " with a verified research dossier" : ""}`,
  };
}
