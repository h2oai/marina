// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The formations (`formations.ts`) on PROFILE rounds (`profile_energy`: a
 * Google Trends basket, Civiqs or YouGov subgroup profiles). Each pattern keeps
 * its protocol; what changes is the unit a member proposes — the WHOLE profile,
 * one `{mean, sd}` per cell, in ONE call per member per step (never one call
 * per cell) — and that aggregation runs cell by cell:
 *
 *   - every reply is validated per cell (`profile-shape.ts`): a missing or
 *     malformed cell, or one beyond MAX_PROPOSAL_SD_MOVE of ITS start sd, is
 *     left out of that proposal; the rest of the proposal still counts;
 *   - each cell is aggregated on its own with the scalar path's clamps: the
 *     median move of the proposals that answered it, scaled by a trust (0.5 ×
 *     their agreement on that cell, or the judge's/skeptic's), capped at
 *     MAX_FINAL_SD_MOVE of the cell's start sd, the sd blended by the same
 *     trust with a floor of half the start sd; a cell nobody answered keeps
 *     its start;
 *   - a share basket (the round says its cells add to 100, and its last
 *     published values do) is rescaled proportionally to 100 AFTER
 *     aggregation; independent cells never are.
 *
 * Per-pattern protocol on a profile:
 *   ensemble / deliberation / chorus / blackboard — as for a number, with whole
 *     profiles on the wall / board;
 *   debate — the sealed sides are CHANGE (the profile will move from the start)
 *     and STAY (it will not); the judge rules change or stay and sets one trust;
 *   pipeline — quant → analyst → skeptic; a cell the analyst left out keeps
 *     the quant's;
 *   mapreduce — each driver proposes a per-cell adjustment; reduce = the per-
 *     cell sum of the confidence-shrunk adjustments;
 *   symbiosis — quant/analyst pairs; the gap that triggers another exchange
 *     is the LARGEST per-cell gap in start sds;
 *   research — the check names a cell and runs on that cell's history;
 *   delphi — the anonymized summary is per cell (median, range of means and
 *     sds), plus reason snippets;
 *   tournament — the judge compares whole-profile candidates; a match without
 *     a usable judgment advances the candidate with the smaller total move in
 *     start sds;
 *   verification — range and sd are checked PER CELL (a failing cell drops out
 *     of that proposal), citations (each naming its cell) and the judged
 *     "follows" per proposal; a cell's passers are aggregated by median.
 *
 * Ranking rounds are out of scope and keep their start.
 */

import type { Evidence } from "../decisions/evidence";
import type { DecisionProvider } from "../decisions/types";
import { judgeAudit, judgeClaim, newJudgeRecord } from "../forecast/judge";
import type { RoundForecast } from "./forecast";
import {
  type AspectVerdict,
  agreement,
  anonymize,
  DEFAULT_TRUST,
  DELPHI_SNIPPET_CHARS,
  DRIVERS,
  type FormationForecast,
  type FormationMember,
  type FormationPattern,
  type FormationStep,
  MAX_FINAL_SD_MOVE,
  MAX_PROPOSAL_SD_MOVE,
  median,
  RESEARCH_CHECKS,
  runCheck,
  SYMBIOSIS_DISAGREEMENT,
  settle,
  trimReply,
  VERIFY_MIN_POINTS,
  verificationScales,
} from "./formations";
import { parseReply } from "./model-forecaster";
import {
  cellBlock,
  cellHistories,
  formatProfile,
  parseProfile,
  profileRulesLines,
  profileStartLine,
  renormaliseShares,
  shareBasketTotal,
} from "./profile-shape";
import { freshestReading } from "./prompt-context";
import type { ArenaLock, ArenaPoint, ArenaRound, Distribution } from "./types";

/** Published values per cell a member reads as "the numbers". */
const NUMBER_POINTS = 12;
/** … and as the short context roles read. */
const RECENT_POINTS = 4;

/** A whole-profile proposal: one distribution per cell it validly answered. */
export interface ProfileProposal {
  profile: Record<string, Distribution>;
  reason?: string;
}

/** The per-cell aggregation record. */
export interface CellAudit {
  /** Proposals that answered this cell validly. */
  n: number;
  trust: number;
  agreement?: number;
}

interface PCtx {
  round: ArenaRound;
  cells: string[];
  base: Record<string, Distribution>;
  histories: Record<string, ArenaPoint[]>;
  head: string;
  numbers: string;
  recent: string;
  steps: FormationStep[];
  briefing?: string;
  start: RoundForecast;
  judge?: DecisionProvider;
}

interface POutcome {
  proposals: Record<string, ProfileProposal>;
  profile: Record<string, Distribution>;
  trust: number;
  agreement?: number;
  critique?: string;
  protocol?: Record<string, unknown>;
  cells?: Record<string, CellAudit>;
}

type PProtocol = (ctx: PCtx, members: FormationMember[]) => Promise<POutcome | undefined>;

const round3 = (x: number) => Math.round(x * 1000) / 1000;
const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export const PROFILE_SCORING =
  "This is a live public forecasting benchmark: a profile forecast is one normal {mean, sd} per cell, scored together by the energy score against the published profile, as skill against persistence (each cell's last published value, sd 1.5). The start forecast is the default for every cell: move a cell only for a concrete reason — a pattern in its data or a scheduled event you are confident about; extrapolating a short trend or betting on mean reversion usually loses at a horizon of a few days. Too narrow an sd is punished hard; too wide wastes skill.";
export const PROFILE_REPLY =
  'Reply with ONE JSON object: {"profile": {"<cell>": {"mean": number, "sd": number > 0}, …one entry for EVERY cell, keyed exactly as listed…}, "reason": "<one sentence naming the cells you moved and why>"}.';

/**
 * The step each parsed reply was recorded as. Members answer concurrently, so
 * "the last step" is not necessarily this reply's; validation marks the right one.
 */
const stepOf = new WeakMap<object, FormationStep>();

async function ask(
  ctx: PCtx,
  stage: string,
  member: FormationMember,
  system: string,
  user: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const full = ctx.briefing ? `${user}\n\n${ctx.briefing}` : user;
    const reply = parseReply(await member.complete(system, full));
    const step: FormationStep = {
      stage,
      member: member.name,
      status: reply ? "ok" : "invalid reply (no JSON object)",
      ...(reply ? { reply: trimReply(reply) } : {}),
    };
    ctx.steps.push(step);
    if (reply) stepOf.set(reply, step);
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

/**
 * A reply's profile, validated per cell; undefined when no cell is usable. The
 * step's status names the cells left out and why.
 */
function proposalOf(
  ctx: PCtx,
  reply: Record<string, unknown> | undefined,
  step: FormationStep | undefined = reply ? stepOf.get(reply) : undefined,
): ProfileProposal | undefined {
  if (!reply) return undefined;
  const { profile, issues } = parseProfile(
    reply.profile,
    ctx.cells,
    ctx.base,
    MAX_PROPOSAL_SD_MOVE,
  );
  if (Object.keys(profile).length === 0) {
    if (step?.status === "ok") step.status = "invalid reply (no valid cell)";
    return undefined;
  }
  if (issues.length && step?.status === "ok") {
    step.status = `ok; ${issues.length} cell(s) left out: ${issues.join("; ")}`.slice(0, 400);
  }
  const reason = typeof reply.reason === "string" ? reply.reason.slice(0, 300) : undefined;
  return { profile, ...(reason ? { reason } : {}) };
}

async function propose(ctx: PCtx, stage: string, m: FormationMember, system: string, user: string) {
  return proposalOf(ctx, await ask(ctx, stage, m, system, user));
}

const show = (ctx: PCtx, p: ProfileProposal) =>
  `${formatProfile(p.profile, ctx.cells)}${p.reason ? ` — ${p.reason}` : ""}`;
const peerLabel = (i: number) => `Peer ${String.fromCharCode(65 + i)}`;

/** Per cell: the median of the proposals that answered it, trust = DEFAULT_TRUST × their agreement. */
export function aggregateCells(
  cells: string[],
  base: Record<string, Distribution>,
  proposals: ProfileProposal[],
): {
  profile: Record<string, Distribution>;
  cells: Record<string, CellAudit>;
  trust: number;
  agreement: number;
} {
  const profile: Record<string, Distribution> = {};
  const audit: Record<string, CellAudit> = {};
  for (const c of cells) {
    const b = base[c]!;
    const ps = proposals.map((p) => p.profile[c]).filter((d): d is Distribution => !!d);
    if (ps.length === 0) {
      profile[c] = { mean: b.mean, sd: b.sd };
      audit[c] = { n: 0, trust: 0 };
      continue;
    }
    const agree = agreement(b, ps);
    const trust = DEFAULT_TRUST * agree;
    profile[c] = settle(
      b,
      median(ps.map((p) => p.mean - b.mean)),
      median(ps.map((p) => p.sd)),
      trust,
    );
    audit[c] = { n: ps.length, trust: round3(trust), agreement: round3(agree) };
  }
  const answered = Object.values(audit).filter((a) => a.n > 0);
  return {
    profile,
    cells: audit,
    trust: round3(mean(answered.map((a) => a.trust))),
    agreement: round3(mean(answered.map((a) => a.agreement ?? 0))),
  };
}

function byMedian(ctx: PCtx, proposals: Record<string, ProfileProposal>): POutcome | undefined {
  const list = Object.values(proposals);
  if (list.length === 0) return undefined;
  const agg = aggregateCells(ctx.cells, ctx.base, list);
  return { proposals, ...agg };
}

/** Every cell moved by one external trust (a judge's or skeptic's); a cell `final` lacks keeps its start. */
function settleAll(
  ctx: PCtx,
  final: Record<string, Distribution>,
  trust: number,
  sdScale = 1,
): { profile: Record<string, Distribution>; cells: Record<string, CellAudit> } {
  const profile: Record<string, Distribution> = {};
  const cells: Record<string, CellAudit> = {};
  for (const c of ctx.cells) {
    const b = ctx.base[c]!;
    const d = final[c];
    profile[c] = d ? settle(b, d.mean - b.mean, d.sd, trust, sdScale) : { mean: b.mean, sd: b.sd };
    cells[c] = { n: d ? 1 : 0, trust: d ? round3(clamp(trust, 0, 1)) : 0 };
  }
  return { profile, cells };
}

const FORECASTER_SYSTEM = `You are one of several independent forecasters. ${PROFILE_SCORING} ${PROFILE_REPLY}`;

async function independent(ctx: PCtx, members: FormationMember[], stage = "propose") {
  const user = `${ctx.head}\n\n${ctx.numbers}`;
  return Promise.all(members.map((m) => propose(ctx, stage, m, FORECASTER_SYSTEM, user)));
}

function keyed(members: FormationMember[], ps: Array<ProfileProposal | undefined>, prefix = "") {
  const rec: Record<string, ProfileProposal> = {};
  ps.forEach((p, i) => {
    if (p) rec[`${prefix}${i + 1}:${members[i]!.name}`] = p;
  });
  return rec;
}

const ensemble: PProtocol = async (ctx, members) =>
  byMedian(ctx, keyed(members, await independent(ctx, members)));

const deliberation: PProtocol = async (ctx, members) => {
  const first = await independent(ctx, members);
  const system = `You are one of several forecasters deliberating. You proposed a profile forecast; now you see your peers' proposals and reasons (anonymized). Revise ONCE, cell by cell: keep yours, move toward a peer whose reason is concrete and grounded in the data, or merge. ${PROFILE_SCORING} ${PROFILE_REPLY}`;
  const revised = await Promise.all(
    members.map(async (m, i) => {
      const own = first[i];
      if (!own) return undefined;
      const peers = first
        .map((p, j) => (j !== i && p ? `${peerLabel(j)}: ${show(ctx, p)}` : undefined))
        .filter(Boolean);
      if (peers.length === 0) return own;
      const user = `${ctx.head}\n\n${ctx.numbers}\n\nYour proposal: ${show(ctx, own)}\nPeers:\n${peers.join("\n")}`;
      return (await propose(ctx, "revise", m, system, user)) ?? own;
    }),
  );
  return byMedian(ctx, keyed(members, revised));
};

const ADVOCATE = (side: "CHANGE" | "STAY") =>
  `You are a sealed advocate in a forecasting debate over a whole profile. Argue, from the data given only, the strongest HONEST case that ${
    side === "CHANGE"
      ? "the published profile will MOVE away from the start forecast — which cells rise, which fall, and why"
      : "the published profile will STAY at the start forecast — why the apparent reasons to move are noise"
  }, and give the profile you would file if your case is right. Say plainly if your case is weak (strength near 0). ${PROFILE_SCORING} Reply with ONE JSON object: {"argument": "<two sentences>", "profile": {"<cell>": {"mean": number, "sd": number > 0}, …every cell…}, "strength": number between 0 and 1}.`;

const debate: PProtocol = async (ctx, members) => {
  const change = members[0]!;
  const stay = members[1 % members.length]!;
  const judge = members[members.length - 1]!;
  const user = `${ctx.head}\n\n${ctx.numbers}`;
  const [a, b] = await Promise.all([
    ask(ctx, "advocate-change", change, ADVOCATE("CHANGE"), user),
    ask(ctx, "advocate-stay", stay, ADVOCATE("STAY"), user),
  ]);
  const pa = proposalOf(ctx, a);
  const pb = proposalOf(ctx, b);
  const side = (r: Record<string, unknown> | undefined, p: ProfileProposal | undefined) =>
    p
      ? `${formatProfile(p.profile, ctx.cells)}; argument: ${String(r?.argument ?? "").slice(0, 400)}; self-rated strength ${Number(r?.strength ?? Number.NaN)}`
      : "(no valid position)";
  const proposals: Record<string, ProfileProposal> = {};
  if (pa) proposals[`change:${change.name}`] = pa;
  if (pb) proposals[`stay:${stay.name}`] = pb;
  if (!pa && !pb) return undefined;
  const system = `You judge a forecasting debate over a whole profile; you wrote neither position. Rule whether the evidence supports the profile MOVING from the start forecast ("change") or not ("stay"), how much of the move to trust (0 = file the start forecast, 1 = the full move to your profile), and your profile. Advocates are paid to argue a side: trust only concrete, data-grounded arguments. ${PROFILE_SCORING} Reply with ONE JSON object: {"verdict": "change" | "stay", "profile": {"<cell>": {"mean": number, "sd": number > 0}, …every cell…}, "trust": number between 0 and 1, "critique": "<one sentence>"}.`;
  const verdict = await ask(
    ctx,
    "judge",
    judge,
    system,
    `${ctx.head}\n\n${ctx.recent}\n\nAdvocate CHANGE: ${side(a, pa)}\nAdvocate STAY: ${side(b, pb)}`,
  );
  const critique = typeof verdict?.critique === "string" ? verdict.critique.slice(0, 300) : "";
  const ruled = proposalOf(ctx, verdict);
  if (!ruled) {
    const out = byMedian(ctx, proposals);
    return out && { ...out, critique: "no usable ruling; median of the advocates" };
  }
  const rule = String(verdict?.verdict ?? "").toLowerCase();
  const moved = Object.entries(ruled.profile).some(([c, d]) => d.mean !== ctx.base[c]!.mean);
  const consistent = rule === "change" && moved;
  const raw = Number(verdict?.trust);
  const trust = consistent && Number.isFinite(raw) ? clamp(raw, 0, 1) : 0;
  proposals[`judge:${judge.name}`] = ruled;
  const settled = settleAll(ctx, ruled.profile, trust);
  return {
    proposals,
    ...settled,
    trust: round3(trust),
    critique: consistent ? critique : `${rule || "no verdict"}: filed the start. ${critique}`,
  };
};

const chorus: PProtocol = async (ctx, members) => {
  const first = await independent(ctx, members);
  const wall = first
    .map((p, j) => `${peerLabel(j)}: ${p ? show(ctx, p) : "(no valid proposal)"}`)
    .join("\n");
  const n = members.length;
  const reviewSystem = `You are on a forecasting chorus. Every member's profile proposal is on the broadcast wall. Critique ONE peer's proposal: which of its cell moves and sds the data supports or contradicts, naming the cells. ${PROFILE_SCORING} Reply with ONE JSON object: {"critique": "<two sentences naming the cells>"}.`;
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
      return r ? { from: peerLabel(i), text: String(r.critique ?? "").slice(0, 600) } : undefined;
    }),
  );
  const reviseSystem = `You are on a forecasting chorus. A peer critiqued your profile proposal. Revise once in light of the critique and the wall: keep a cell if the critique of it is not grounded in the data. ${PROFILE_SCORING} ${PROFILE_REPLY}`;
  const revised = await Promise.all(
    members.map(async (m, j) => {
      const own = first[j];
      const review = reviews[(j - 1 + n) % n];
      if (!own || !review) return own;
      const user = `${ctx.head}\n\n${ctx.numbers}\n\nBroadcast wall:\n${wall}\n\nYour proposal (${peerLabel(j)}): ${show(ctx, own)}\nCritique from ${review.from}: ${review.text}`;
      return (await propose(ctx, "revise", m, reviseSystem, user)) ?? own;
    }),
  );
  return byMedian(ctx, keyed(members, revised));
};

const PIPELINE_SYSTEM = {
  quant: `You are stage 1 (the quant) of a forecasting pipeline over a whole profile. Read only the numbers: each cell's dated history and start forecast (and nowcast reading where noted). Contract: hand the next stage a profile grounded in concrete patterns in the numbers, else the start forecast. ${PROFILE_SCORING} ${PROFILE_REPLY}`,
  analyst: `You are stage 2 (the analyst) of a forecasting pipeline over a whole profile. You receive the quant's handoff. Contract: adjust cells ONLY for context the numbers cannot show — the source's house effects, fielding, publication schedule, scheduled events for an item, typical week-to-week noise. If nothing applies, return the quant's profile unchanged. ${PROFILE_SCORING} ${PROFILE_REPLY}`,
  skeptic: `You are stage 3 (the skeptic) of a forecasting pipeline over a whole profile. Most forecasters on this benchmark lose to persistence by moving too far on weak evidence. Contract: given the start forecast and both earlier stages' handoffs, decide how much of the pipeline's move away from the start forecast is justified: trust 0 files the start forecast, 1 the full move. Reply with ONE JSON object: {"trust": number between 0 and 1, "sd_scale": number between 0.5 and 2, "critique": "<one sentence>"}.`,
};

const pipeline: PProtocol = async (ctx, members) => {
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
    `${ctx.head}\n\n${ctx.recent}\n\nQuant handoff: ${q ? show(ctx, q) : "(the quant produced nothing usable; work from the start forecast)"}`,
  );
  const proposals: Record<string, ProfileProposal> = {};
  if (q) proposals[`quant:${quant.name}`] = q;
  if (a) proposals[`analyst:${analyst.name}`] = a;
  if (!q && !a) return undefined;
  // The analyst's cell where it answered one, else the quant's.
  const final = { ...(q?.profile ?? {}), ...(a?.profile ?? {}) };
  const verdict = await ask(
    ctx,
    "skeptic",
    skeptic,
    PIPELINE_SYSTEM.skeptic,
    `${ctx.head}\n\n${ctx.recent}\n\nQuant handoff: ${q ? show(ctx, q) : "(none)"}\nAnalyst handoff (the pipeline's forecast): ${a ? show(ctx, a) : "(none — the quant's stands)"}`,
  );
  const raw = Number(verdict?.trust);
  const trust = Number.isFinite(raw) ? clamp(raw, 0, 1) : DEFAULT_TRUST;
  const scaleRaw = Number(verdict?.sd_scale);
  return {
    proposals,
    ...settleAll(ctx, final, trust, Number.isFinite(scaleRaw) ? scaleRaw : 1),
    trust: round3(trust),
    ...(typeof verdict?.critique === "string" ? { critique: verdict.critique.slice(0, 300) } : {}),
  };
};

const mapreduce: PProtocol = async (ctx, members) => {
  const inputs: Record<string, string> = {
    "level-trend": ctx.numbers,
    calendar: ctx.numbers,
    source: ctx.recent,
  };
  const results = await Promise.all(
    DRIVERS.map(async (d, i) => {
      const m = members[i % members.length]!;
      const system = `You are one specialist in a map-reduce forecast of a whole profile. Consider ONLY this driver: ${d.brief} For EVERY cell, propose the adjustment to its start mean attributable to this driver alone (0 when it implies none — the usual case) and the sd you would expect for that cell's whole forecast, and say how confident you are overall. ${PROFILE_SCORING} Reply with ONE JSON object: {"profile": {"<cell>": {"adjustment": number, "sd": number > 0}, …every cell…}, "confidence": number between 0 and 1, "reason": "<one sentence>"}.`;
      const stage = `map:${d.id}`;
      const r = await ask(ctx, stage, m, system, `${ctx.head}\n\n${inputs[d.id] ?? ctx.numbers}`);
      if (!r) return undefined;
      // An adjustment is a proposal at start + adjustment, validated as one.
      const got = (r.profile ?? {}) as Record<string, unknown>;
      const asProfile: Record<string, unknown> = {};
      for (const c of ctx.cells) {
        const v = (Object.hasOwn(got, c) ? got[c] : undefined) as
          | { adjustment?: unknown; sd?: unknown }
          | undefined;
        const adj = Number(v?.adjustment);
        if (v && Number.isFinite(adj)) asProfile[c] = { mean: ctx.base[c]!.mean + adj, sd: v.sd };
      }
      const p = proposalOf(ctx, { ...r, profile: asProfile }, stepOf.get(r));
      if (!p) return undefined;
      const conf = Number(r.confidence);
      return {
        key: `${d.id}:${m.name}`,
        weight: DEFAULT_TRUST * (Number.isFinite(conf) ? clamp(conf, 0, 1) : 0.5),
        proposal: p,
      };
    }),
  );
  const ok = results.filter((r): r is NonNullable<typeof r> => r !== undefined);
  if (ok.length === 0) return undefined;
  // Reduce, per cell: the shrunk adjustments add; the sd blends toward the
  // specialists' median at their mean weight; the move is capped.
  const profile: Record<string, Distribution> = {};
  const cells: Record<string, CellAudit> = {};
  for (const c of ctx.cells) {
    const b = ctx.base[c]!;
    const on = ok.filter((r) => r.proposal.profile[c]);
    if (on.length === 0) {
      profile[c] = { mean: b.mean, sd: b.sd };
      cells[c] = { n: 0, trust: 0 };
      continue;
    }
    const move = on.reduce((s, r) => s + r.weight * (r.proposal.profile[c]!.mean - b.mean), 0);
    const w = on.reduce((s, r) => s + r.weight, 0) / on.length;
    const blended = settle(b, 0, median(on.map((r) => r.proposal.profile[c]!.sd)), w);
    const cap = MAX_FINAL_SD_MOVE * b.sd;
    profile[c] = { mean: round3(b.mean + clamp(move, -cap, cap)), sd: blended.sd };
    cells[c] = { n: on.length, trust: round3(w) };
  }
  return {
    proposals: Object.fromEntries(ok.map((r) => [r.key, r.proposal])),
    profile,
    cells,
    trust: round3(mean(ok.map((r) => r.weight))),
  };
};

const blackboard: PProtocol = async (ctx, members) => {
  const board: string[] = [];
  const latest: Array<ProfileProposal | undefined> = members.map(() => undefined);
  const system = `You work on a shared forecasting blackboard with other models, forecasting a whole profile. Read the CURRENT board and improve it: add one new piece of evidence from the data (name the cell), or correct an existing entry that misreads it (name its number) — never repeat what is already there. Then give your current profile. ${PROFILE_SCORING} Reply with ONE JSON object: {"evidence": "<one sentence, or 'none'>", "corrects": number | null, "profile": {"<cell>": {"mean": number, "sd": number > 0}, …every cell…}}.`;
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
        `#${board.length + 1} (${peerLabel(i)}, pass ${pass})${Number.isInteger(fix) && fix >= 1 && fix <= board.length ? ` corrects #${fix}:` : ""} ${ev} → ${formatProfile(p.profile, ctx.cells)}`,
      );
    }
  }
  const out = byMedian(ctx, keyed(members, latest));
  return out && { ...out, critique: board.join(" | ").slice(0, 3_000) };
};

const SYMBIOSIS_SYSTEM = {
  quant: `You are the QUANT half of a symbiotic forecasting pair over a whole profile. You see the numbers (every cell's dated history); your partner, the analyst, does not — and it knows the source's context (house effects, fielding, publication, scheduled events for an item) that you are not asked about. ${PROFILE_SCORING}`,
  analyst: `You are the ANALYST half of a symbiotic forecasting pair over a whole profile. You see the question, the rules and each cell's last few published values; your partner, the quant, sees the full numbers that you do not. Contribute what you know about this source and these items — house effects, fielding, publication schedule, scheduled events, typical noise. ${PROFILE_SCORING}`,
};
const FIRST_REPLY =
  'Reply with ONE JSON object: {"contribution": "<the one thing your partner cannot see that matters most>", "profile": {"<cell>": {"mean": number, "sd": number > 0}, …every cell…}}.';
const EXCHANGE_REPLY =
  'Use your partner\'s contribution and CREDIT it: say what you took from it (or why it changes nothing). Reply with ONE JSON object: {"credit": "<what you used from your partner>", "contribution": "<anything new for your partner, or none>", "profile": {"<cell>": {"mean": number, "sd": number > 0}, …every cell…}}.';
const SYMBIOSIS_MAX_EXCHANGES = 2;

/** The largest per-cell gap between two profiles, in start sds (cells both answered). */
function profileGap(ctx: PCtx, a?: ProfileProposal, b?: ProfileProposal): number {
  if (!a || !b) return 0;
  let g = 0;
  for (const c of ctx.cells) {
    const x = a.profile[c];
    const y = b.profile[c];
    if (x && y) g = Math.max(g, Math.abs(x.mean - y.mean) / ctx.base[c]!.sd);
  }
  return g;
}

async function symbioticPair(
  ctx: PCtx,
  quant: FormationMember,
  analyst: FormationMember,
  tag: string,
): Promise<{ proposals: Record<string, ProfileProposal>; modes: string[] }> {
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
  const gap = () => profileGap(ctx, state[0]!.p, state[1]!.p);
  for (let x = 1; x <= SYMBIOSIS_MAX_EXCHANGES; x++) {
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
          `${ctx.head}\n\n${p.input}\n\nYour forecast: ${own.p ? show(ctx, own.p) : "(none yet)"}\nYour partner's contribution: ${partner.contribution || "(none)"}\nYour partner's forecast: ${partner.p ? show(ctx, partner.p) : "(none)"}`,
        );
        const credit = String(r?.credit ?? "").trim();
        const revised = proposalOf(ctx, r);
        const step = r ? stepOf.get(r) : undefined;
        if (revised && !credit) {
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
  const proposals: Record<string, ProfileProposal> = {};
  pair.forEach((p, i) => {
    const got = state[i]!.p;
    if (got) proposals[`${tag}${p.role}:${p.m.name}`] = got;
  });
  return { proposals, modes };
}

/** Per cell, the mean of the halves that answered it. */
function meanProfile(ctx: PCtx, halves: ProfileProposal[]): ProfileProposal {
  const profile: Record<string, Distribution> = {};
  for (const c of ctx.cells) {
    const ds = halves.map((h) => h.profile[c]).filter((d): d is Distribution => !!d);
    if (ds.length)
      profile[c] = { mean: mean(ds.map((d) => d.mean)), sd: mean(ds.map((d) => d.sd)) };
  }
  return { profile, ...(halves[0]?.reason ? { reason: halves[0].reason } : {}) };
}

const symbiosis: PProtocol = async (ctx, members) => {
  if (members.length <= 2) {
    const one = await symbioticPair(ctx, members[0]!, members[1 % members.length]!, "");
    const out = byMedian(ctx, one.proposals);
    return out && { ...out, critique: one.modes.join("; ") };
  }
  const pairs: Array<[FormationMember, FormationMember]> = [];
  for (let i = 0; i < members.length; i += 2)
    pairs.push([members[i]!, members[i + 1] ?? members[0]!]);
  const results = await Promise.all(
    pairs.map(([q, a], i) => symbioticPair(ctx, q, a, `pair${i + 1}/`)),
  );
  const perPair: Record<string, ProfileProposal> = {};
  const notes: string[] = [];
  results.forEach((r, i) => {
    const halves = Object.values(r.proposals);
    notes.push(`pair${i + 1}: ${r.modes.join(", ")}`);
    if (halves.length) perPair[`pair${i + 1}`] = meanProfile(ctx, halves);
  });
  const out = byMedian(ctx, perPair);
  return out && { ...out, critique: notes.join(" | ").slice(0, 1_500) };
};

const RESEARCH_SYSTEM = `You forecast a whole profile by iterative experimentation. Each iteration: state a HYPOTHESIS about the published profile, choose ONE small check to test it on ONE cell — ${RESEARCH_CHECKS.filter((c) => c !== "daily_after_last").join(", ")} — with k (how many recent points) and the cell's id, and give your current profile. You will see the check's result, computed exactly on that cell's published history; then KEEP or REVERT your moves and revise. ${PROFILE_SCORING} Reply with ONE JSON object: {"hypothesis": "<one sentence>", "check": {"name": "<check>", "k": number, "cell": "<cell id>"}, "decision": "keep" | "revert" | "start", "profile": {"<cell>": {"mean": number, "sd": number > 0}, …every cell…}}.`;

const research: PProtocol = async (ctx, members) => {
  const finals = await Promise.all(
    members.map(async (m) => {
      const log: string[] = [];
      let current: ProfileProposal | undefined;
      for (let it = 1; it <= 3; it++) {
        const user = `${ctx.head}\n\n${ctx.numbers}${log.length ? `\n\nLAB NOTEBOOK (your iterations so far):\n${log.join("\n")}` : ""}${it === 3 ? "\n\nThis is your FINAL iteration: give your profile (the check is ignored)." : ""}`;
        const r = await ask(ctx, `iteration${it}`, m, RESEARCH_SYSTEM, user);
        const p = proposalOf(ctx, r);
        const decision = String(r?.decision ?? "");
        if (p) current = decision === "revert" ? (current ?? p) : p;
        const checkReq = (r?.check ?? undefined) as Record<string, unknown> | undefined;
        if (it === 3 || !checkReq) break;
        const name = String(checkReq.name ?? "");
        const cell = String(checkReq.cell ?? "");
        const known = ctx.cells.includes(cell);
        const result = known
          ? runCheck(name, Number(checkReq.k), "history", ctx.histories[cell] ?? [], undefined)
          : `unknown cell "${cell.slice(0, 60)}" (choose one of the cells listed)`;
        log.push(
          `Gen ${it}: hypothesis=${String(r?.hypothesis ?? "").slice(0, 200)} forecast=${current ? formatProfile(current.profile, ctx.cells) : "(none)"} check=${name}(${known ? cell : "?"}, k=${String(checkReq.k)}) result=${result}`,
        );
      }
      return current;
    }),
  );
  return byMedian(ctx, keyed(members, finals));
};

/**
 * Delphi's anonymized panel summary for a profile: for each cell, how many
 * forecasts answered it, the median and range of their means (and the median
 * move from the start) and of their sds; then short reason snippets, sorted
 * and scrubbed of member names.
 */
export function delphiProfileSummary(
  cells: string[],
  base: Record<string, Distribution>,
  proposals: ProfileProposal[],
  members: FormationMember[],
): { text: string; record: Record<string, unknown> } {
  const perCell: Record<string, Record<string, unknown>> = {};
  const lines: string[] = [];
  for (const c of cells) {
    const ds = proposals.map((p) => p.profile[c]).filter((d): d is Distribution => !!d);
    if (ds.length === 0) {
      lines.push(`- ${c}: no forecast`);
      continue;
    }
    const means = ds.map((d) => d.mean);
    const sds = ds.map((d) => d.sd);
    const rec = {
      n: ds.length,
      medianMean: round3(median(means)),
      meanRange: [round3(Math.min(...means)), round3(Math.max(...means))],
      medianMove: round3(median(means) - base[c]!.mean),
      medianSd: round3(median(sds)),
      sdRange: [round3(Math.min(...sds)), round3(Math.max(...sds))],
    };
    perCell[c] = rec;
    lines.push(
      `- ${c}: mean median ${rec.medianMean} (move ${rec.medianMove}), range ${rec.meanRange[0]} to ${rec.meanRange[1]}; sd median ${rec.medianSd}, range ${rec.sdRange[0]} to ${rec.sdRange[1]}`,
    );
  }
  const snippets = proposals
    .map((p) => anonymize((p.reason ?? "").trim(), members).slice(0, DELPHI_SNIPPET_CHARS))
    .filter(Boolean)
    .sort();
  const text = [
    `PANEL SUMMARY (round 1, ${proposals.length} independent profile forecasts, anonymized), per cell:`,
    ...lines,
    ...(snippets.length
      ? ["- reasons given (unordered):", ...snippets.map((s) => `  • ${s}`)]
      : []),
  ].join("\n");
  return { text, record: { n: proposals.length, cells: perCell, snippets } };
}

const DELPHI_SYSTEM = `You are a panelist in a Delphi forecast of a whole profile. In round 1 every panelist forecast independently. You now see only an anonymized per-cell statistical summary of the panel's round-1 forecasts — no individual forecasts, no names. Revise ONCE: keep each cell unless the summary points you to something concrete in the data you had missed; a panel median is not evidence by itself. ${PROFILE_SCORING} ${PROFILE_REPLY}`;

const delphi: PProtocol = async (ctx, members) => {
  const first = await independent(ctx, members, "round1");
  const valid = first.filter((p): p is ProfileProposal => p !== undefined);
  if (valid.length < 2) {
    const out = byMedian(ctx, keyed(members, first));
    return out && { ...out, protocol: { summary: null, revised: 0 } };
  }
  const summary = delphiProfileSummary(ctx.cells, ctx.base, valid, members);
  const revised = await Promise.all(
    members.map(async (m, i) => {
      const own = first[i];
      if (!own) return undefined;
      const user = `${ctx.head}\n\n${ctx.numbers}\n\nYour round-1 forecast: ${show(ctx, own)}\n\n${summary.text}`;
      return (await propose(ctx, "round2", m, DELPHI_SYSTEM, user)) ?? own;
    }),
  );
  const out = byMedian(ctx, keyed(members, revised));
  const moved = revised.filter(
    (p, i) => p && first[i] && JSON.stringify(p.profile) !== JSON.stringify(first[i]!.profile),
  ).length;
  return (
    out && {
      ...out,
      protocol: { summary: summary.record, round1: keyed(members, first), moved },
    }
  );
};

/** A profile's total move from the start, in start sds (a cell it lacks counts as no move). */
function totalMove(ctx: PCtx, p: ProfileProposal): number {
  return ctx.cells.reduce((s, c) => {
    const d = p.profile[c];
    return s + (d ? Math.abs(d.mean - ctx.base[c]!.mean) / ctx.base[c]!.sd : 0);
  }, 0);
}

const TOURNAMENT_JUDGE = `You judge one match of a forecasting tournament: two candidate profile forecasts for the same round, anonymized as A and B, each with its rationale. Pick the one that better fits the evidence in the data and the scoring rule across the whole profile: cells moved only as far as concrete evidence supports, and sds honest about how each cell moves. A confident-sounding rationale is not evidence. ${PROFILE_SCORING} Reply with ONE JSON object: {"winner": "A" | "B", "reason": "<one sentence>"}.`;

const tournament: PProtocol = async (ctx, members) => {
  const judge = members[members.length - 1]!;
  const proposers = members.length >= 3 ? members.slice(0, -1) : members;
  const field = keyed(proposers, await independent(ctx, proposers));
  let alive = Object.keys(field);
  if (alive.length === 0) return undefined;
  const candidate = (tag: string, p: ProfileProposal) =>
    `Candidate ${tag}: ${formatProfile(p.profile, ctx.cells)} — a total move of ${round3(totalMove(ctx, p))} start sds. Rationale: ${p.reason ?? "(none given)"}`;
  const bracket: Array<Record<string, unknown>> = [];
  for (let round = 1; alive.length > 1; round++) {
    const pairs: Array<[string, string | undefined]> = [];
    for (let i = 0; i < alive.length; i += 2) pairs.push([alive[i]!, alive[i + 1]]);
    const results = await Promise.all(
      pairs.map(async ([a, b], slot) => {
        if (!b) return { round, a, winner: a, decided: "bye" };
        const pa = field[a]!;
        const pb = field[b]!;
        const stage = `match r${round}.${slot + 1}`;
        const verdict = await ask(
          ctx,
          stage,
          judge,
          TOURNAMENT_JUDGE,
          `${ctx.head}\n\n${ctx.numbers}\n\n${candidate("A", pa)}\n${candidate("B", pb)}`,
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
        const why = verdict
          ? "no A/B winner in the reply"
          : (ctx.steps.find((s) => s.stage === stage)?.status ?? "no reply");
        const nearer = totalMove(ctx, pb) < totalMove(ctx, pa) ? b : a;
        return { round, a, b, winner: nearer, decided: `fallback: ${why}` };
      }),
    );
    bracket.push(...results);
    alive = results.map((m) => m.winner);
  }
  const champion = alive[0]!;
  const win = field[champion]!;
  // The champion per cell, at the default trust × the field's agreement on that cell.
  const profile: Record<string, Distribution> = {};
  const cells: Record<string, CellAudit> = {};
  const fieldList = Object.values(field);
  for (const c of ctx.cells) {
    const b = ctx.base[c]!;
    const d = win.profile[c];
    if (!d) {
      profile[c] = { mean: b.mean, sd: b.sd };
      cells[c] = { n: 0, trust: 0 };
      continue;
    }
    const agree = agreement(
      b,
      fieldList.map((p) => p.profile[c]).filter((x): x is Distribution => !!x),
    );
    const trust = DEFAULT_TRUST * agree;
    profile[c] = settle(b, d.mean - b.mean, d.sd, trust);
    cells[c] = { n: 1, trust: round3(trust), agreement: round3(agree) };
  }
  const answered = Object.values(cells).filter((a) => a.n > 0);
  return {
    proposals: { [champion]: win },
    profile,
    cells,
    trust: round3(mean(answered.map((a) => a.trust))),
    agreement: round3(mean(answered.map((a) => a.agreement ?? 0))),
    critique: `champion ${champion}`,
    protocol: { judge: judge.name, field, bracket, champion },
  };
};

/** A cited value matches the data point on its date, to the data's rounding. */
function citeMatches(point: ArenaPoint, value: number): boolean {
  return (
    Number.isFinite(value) &&
    Math.abs(point.value - value) <= Math.max(0.051, 0.005 * Math.abs(point.value))
  );
}

/**
 * Every `{cell, date, value}` a profile rationale cites must be a point of
 * THAT cell the members were shown; at least one is required. Mechanical.
 */
export function checkCellCitations(
  cites: unknown,
  shown: Record<string, ArenaPoint[]>,
): AspectVerdict {
  if (!Array.isArray(cites) || cites.length === 0) {
    return { pass: false, detail: "cites no dated value from the data" };
  }
  const bad: string[] = [];
  const checked = cites.slice(0, 16);
  for (const c of checked) {
    const x = c as { cell?: unknown; date?: unknown; value?: unknown } | null;
    const cell = String(x?.cell ?? "");
    const date = String(x?.date ?? "").slice(0, 10);
    const value = Number(x?.value);
    const pts = Object.hasOwn(shown, cell) ? shown[cell]! : [];
    if (!pts.some((p) => p.date === date && citeMatches(p, value))) {
      bad.push(
        `${cell.slice(0, 40) || "?"} ${date || "?"} ${Number.isFinite(value) ? value : "?"}`,
      );
    }
  }
  return bad.length
    ? { pass: false, detail: `${bad.length} cited value(s) not in the data: ${bad.join(", ")}` }
    : { pass: true, detail: `${checked.length} cited value(s), all in the data` };
}

const VERIFY_SYSTEM = `You are one of several independent forecasters of a whole profile; every proposal is checked before it counts. ${PROFILE_SCORING} Ground your reason in the data and cite the dated values it relies on exactly as shown, each with its cell. Reply with ONE JSON object: {"profile": {"<cell>": {"mean": number, "sd": number > 0}, …every cell…}, "reason": "<one or two sentences>", "cites": [{"cell": "<cell id>", "date": "YYYY-MM-DD", "value": number}, …]}.`;

const verification: PProtocol = async (ctx, members) => {
  const user = `${ctx.head}\n\n${ctx.numbers}`;
  const replies = await Promise.all(
    members.map(async (m) => {
      const r = await ask(ctx, "propose", m, VERIFY_SYSTEM, user);
      return { r, p: proposalOf(ctx, r) };
    }),
  );
  const scales = Object.fromEntries(
    ctx.cells.map((c) => [c, verificationScales(ctx.base[c]!, ctx.histories[c] ?? [])]),
  );
  // What the members were shown per cell: its history window and any nowcast reading.
  const shown: Record<string, ArenaPoint[]> = Object.fromEntries(
    ctx.cells.map((c) => {
      const fresh = freshestReading(ctx.start, c);
      return [c, [...(ctx.histories[c] ?? []).slice(-30), ...(fresh ? [fresh] : [])]];
    }),
  );
  const judgeRecord = newJudgeRecord(ctx.judge);
  const evidence: Evidence[] = ctx.judge
    ? [
        {
          ref: "series:cells",
          text: `STRUCTURED SOURCE DATA (the benchmark's own series; not web research). ${cellBlock(ctx.round, ctx.histories, ctx.start, 6)}`,
        },
      ]
    : [];
  const checked = await Promise.all(
    replies.map(async ({ r, p }, i) => {
      if (!p) return undefined;
      const key = `${i + 1}:${members[i]!.name}`;
      const cellVerdicts: Record<string, Record<string, AspectVerdict>> = {};
      const kept: Record<string, Distribution> = {};
      for (const [c, d] of Object.entries(p.profile)) {
        const s = scales[c];
        let range: AspectVerdict;
        let sd: AspectVerdict;
        if (!s) {
          range = { pass: false, detail: `fewer than ${VERIFY_MIN_POINTS} history points` };
          sd = range;
        } else {
          range = {
            pass: d.mean >= s.band[0] && d.mean <= s.band[1],
            detail: `mean ${d.mean} vs plausible ${s.band[0]}..${s.band[1]}`,
          };
          sd = {
            pass: d.sd >= s.sdRange[0] && d.sd <= s.sdRange[1],
            detail: `sd ${d.sd} vs consistent ${s.sdRange[0]}..${s.sdRange[1]}`,
          };
        }
        cellVerdicts[c] = { range, sd };
        if (range.pass && sd.pass) kept[c] = d;
      }
      const aspects: Record<string, AspectVerdict> = {
        cites: checkCellCitations(r?.cites, shown),
      };
      if (ctx.judge) {
        if (!aspects.cites!.pass || Object.keys(kept).length === 0) {
          aspects.follows = {
            pass: false,
            detail: "not judged (failed a computed aspect)",
          };
        } else {
          const moves = Object.entries(kept)
            .filter(([c, d]) => d.mean !== ctx.base[c]!.mean)
            .map(([c, d]) => `${c} ${ctx.base[c]!.mean}→${d.mean} (sd ${d.sd})`);
          const draft = `Profile forecast: ${moves.length ? moves.join("; ") : "every cell at its start"}. Reason: ${p.reason ?? ""}`;
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
      const whole = Object.values(aspects).every((a) => a.pass);
      const counted = whole ? kept : {};
      return {
        key,
        aspects,
        cellVerdicts,
        counted,
        passedCells: Object.keys(counted).length,
        reason: p.reason,
      };
    }),
  );
  const verdicts: Record<string, unknown> = {};
  const passers: Record<string, ProfileProposal> = {};
  for (const c of checked) {
    if (!c) continue;
    verdicts[c.key] = { ...c.aspects, cells: c.cellVerdicts, passedCells: c.passedCells };
    if (c.passedCells > 0) {
      passers[c.key] = { profile: c.counted, ...(c.reason ? { reason: c.reason } : {}) };
    }
  }
  const proposed = Object.keys(verdicts).length;
  if (proposed === 0) return undefined;
  const accepted = Object.keys(passers).length;
  const protocol = {
    scales,
    verdicts,
    proposed,
    accepted,
    rejected: proposed - accepted,
    ...judgeAudit(judgeRecord),
  };
  if (accepted === 0) {
    return {
      proposals: {},
      profile: Object.fromEntries(
        ctx.cells.map((c) => [c, { mean: ctx.base[c]!.mean, sd: ctx.base[c]!.sd }]),
      ),
      cells: Object.fromEntries(ctx.cells.map((c) => [c, { n: 0, trust: 0 }])),
      trust: 0,
      critique: `0/${proposed} passed; the start forecast`,
      protocol,
    };
  }
  const out = byMedian(ctx, passers);
  return (
    out && {
      ...out,
      critique: `${accepted}/${proposed} passed the whole-proposal aspects with at least one passing cell`,
      protocol,
    }
  );
};

const PROTOCOLS: Record<FormationPattern, PProtocol> = {
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

/**
 * A formation on a profile round. `baseline` is the start forecast without its
 * daily series, and must carry a profile with every cell.
 */
export async function profileFormationForecastRound(
  pattern: FormationPattern,
  round: ArenaRound,
  lock: ArenaLock,
  members: FormationMember[],
  baseline: RoundForecast,
  briefing?: string,
  judge?: DecisionProvider,
): Promise<FormationForecast> {
  const cells = round.cells ?? [];
  const base = baseline.profile!;
  const histories = cellHistories(round, lock);
  const share = shareBasketTotal(round, lock, baseline);
  const ctx: PCtx = {
    round,
    cells,
    base,
    histories,
    head: [
      `Question: ${round.question}`,
      `Unit: ${round.unit ?? "(see question)"}`,
      `Published around ${round.release_at}; forecasts lock ${round.lock_at}.`,
      ...profileRulesLines(round, share),
      `Cells (${cells.length}): ${cells.join(", ")}`,
      profileStartLine(baseline, cells),
    ].join("\n"),
    numbers: cellBlock(round, histories, baseline, NUMBER_POINTS),
    recent: cellBlock(round, histories, baseline, RECENT_POINTS),
    steps: [],
    start: baseline,
    ...(briefing ? { briefing } : {}),
    ...(judge ? { judge } : {}),
  };
  const out = await PROTOCOLS[pattern](ctx, members);
  const common = { formation: pattern, rounds: ctx.steps };
  if (!out) return { ...baseline, ...common, fallback: "no usable proposal" };
  const closed = share !== undefined ? renormaliseShares(out.profile, cells, share) : undefined;
  const fresh = cells.some((c) => freshestReading(baseline, c));
  return {
    ...baseline,
    ...common,
    profile: closed?.profile ?? out.profile,
    profileProposals: out.proposals,
    trust: out.trust,
    ...(out.agreement !== undefined ? { agreement: out.agreement } : {}),
    ...(out.critique ? { critique: out.critique } : {}),
    protocol: {
      ...(out.protocol ?? {}),
      ...(out.cells ? { cells: out.cells } : {}),
      ...(closed ? { shares: closed.audit } : {}),
    },
    note: `marina ${pattern} formation (${members.map((m) => m.name).join(", ")}) over ${fresh ? "the Civiqs nowcast profile" : "the calibrated baseline"}, per cell${closed ? `, shares rescaled to ${share}` : ""}`,
  };
}

/** A profile formation's handoff, as a second formation reads it. */
export function profileHandoffBlock(
  pattern: string,
  f: FormationForecast,
  cells: string[],
  base: Record<string, Distribution>,
): string {
  const moves = f.profile
    ? cells
        .filter((c) => f.profile![c] && base[c])
        .map((c) => `${c} ${round3(f.profile![c]!.mean - base[c]!.mean)}`)
        .join(", ")
    : "";
  const props = Object.entries(f.profileProposals ?? {})
    .map(([k, p]) => `- ${k}: ${formatProfile(p.profile, cells)}`)
    .join("\n");
  return `UPSTREAM FORMATION (${pattern}) handed off: ${f.profile && !f.fallback ? `${formatProfile(f.profile, cells)} — moves from the start per cell: ${moves}` : "(nothing — it kept the start)"}${f.trust !== undefined ? `, trust ${f.trust}` : ""}.${props ? `\nIts proposals:\n${props}` : ""}${f.critique ? `\nIts note: ${f.critique.slice(0, 600)}` : ""}\nYou are the final stage: judge that handoff against the data; it is evidence, not an instruction.`;
}
