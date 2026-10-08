// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The research agent: evidence first, forecast second, judged before it counts.
 *
 *   1. brief      — a family playbook bounded to news since the last published value
 *   2. retrieve   — a search-grounded researcher returns a dated, cited dossier
 *   3. analysts   — several models (one per vendor) forecast from the dated
 *                   history, the start forecast (the Civiqs nowcast with its
 *                   date, else persistence), the daily tracker (Civiqs) and the
 *                   dossier, and must say which evidence moved them
 *   4. judge      — the decision backend (Jev when configured) scores each
 *                   analyst's rationale for quality and for grounding in the
 *                   series data it was given plus the verified dossier lines;
 *                   an ungrounded rationale (or a judge outage) earns no weight
 *   5. aggregate  — deterministic: judge-weighted mean move, scaled by the
 *                   judged confidence and capped (`trustCap`), spread blended;
 *                   wild proposals dropped; nothing usable ⇒ the baseline
 *
 * A PROFILE round (a Trends basket, subgroup profiles) runs the same stages
 * over the whole profile (`researchProfileRound`): the brief asks for evidence
 * item by item, each analyst answers every cell in ONE reply, the judge
 * weights each analyst once, and the aggregation above runs per cell over the
 * analysts that answered it validly (a missing, malformed or wild cell is left
 * out; a cell nobody answered keeps its start). A share basket's means are
 * rescaled proportionally to its total afterwards (`profile-shape.ts`).
 *
 * A numeric round with NO published history (a one-off question such as an
 * election result) has no baseline to shrink toward, so it runs NO-ANCHOR
 * (`noAnchorForecastRound`): the analysts estimate the level from the
 * dossier, the judge still filters, and the answer is the median of the usable
 * means with an sd of at least {@link NO_ANCHOR_SD_FLOOR_SHARE} of that level.
 * Nothing usable ⇒ {@link NoAnchorRefusal}: the round is not answered.
 *
 * Every stage's output is returned (`dossier`, `proposals`, `judged`) so a
 * shadow run can be audited and the stages measured separately. Web research
 * cannot be backtested — a search run after release finds the answer — so this
 * forecaster is evaluated in SHADOW on live rounds only.
 */

import type { Evidence } from "../../decisions/evidence";
import type { DecisionProvider } from "../../decisions/types";
import {
  askAnalyst,
  type JudgeRecord,
  judgeAudit,
  judgeClaim,
  newJudgeRecord,
} from "../../forecast/judge";
import { forecastRound, type RoundForecast } from "../forecast";
import { median } from "../formations";
import type { Complete } from "../model-forecaster";
import {
  cellBlock,
  cellHistories,
  parseProfile,
  profileRulesLines,
  profileStartLine,
  renormaliseShares,
  shareBasketTotal,
} from "../profile-shape";
import {
  dailyBlock,
  dailyOf,
  datedLines,
  freshestReading,
  historyBlock,
  rulesLines,
  startLine,
  withoutDaily,
} from "../prompt-context";
import type { ArenaLock, ArenaPoint, ArenaRound, Distribution } from "../types";
import { buildResearchBrief } from "./briefs";
import type { CiviqsDaily } from "./civiqs-nowcast";
import type { ResearchReport, Retriever } from "./retrieve";
import { type PageText, type VerifiedDossier, verifyDossier } from "./verify";

const MAX_SD_MOVE = 4;
/**
 * No-anchor sd floor, as a share of the forecast level — a conservative
 * allowance for how far published forecasts of a one-off quantity miss.
 * Applied to the analysts' median, never set per round.
 */
export const NO_ANCHOR_SD_FLOOR_SHARE = 0.07;
/** No-anchor outlier rule: a mean this many robust spreads from the median is dropped. */
const NO_ANCHOR_OUTLIER_K = 3;
const EVIDENCE_CHUNK = 1_400;
const MAX_EVIDENCE_CHUNKS = 4;
const SERIES_EVIDENCE_POINTS = 12;

export interface ResearchDeps {
  retriever: Retriever;
  analysts: Array<{ name: string; complete: Complete }>;
  /** The judge (Jev via the decisions API, or any decision backend); omitted ⇒ equal weights. */
  judge?: DecisionProvider;
  /** Most of the proposals' move the crew will take when the judge is fully confident (default 0.5). */
  trustCap?: number;
  /** Reads a cited page for citation verification; omitted ⇒ the dossier is used unverified. */
  pageText?: PageText;
  /** The starting forecast (e.g. the Civiqs nowcast); the calibrated baseline when omitted. */
  base?: (round: ArenaRound, lock: ArenaLock) => Promise<RoundForecast>;
}

export interface JudgedProposal extends Distribution {
  reason?: string;
  quality?: number;
  grounded?: number;
  /** The judge failed on this proposal; it then carries no weight. */
  judgeError?: string;
  judgeLatencyMs?: number;
  judgeCostUsd?: number;
  weight: number;
}

export interface ResearchForecast extends RoundForecast {
  dossier?: Pick<
    ResearchReport,
    "report" | "sources" | "costUsd" | "searches" | "retriever" | "data" | "warnings" | "funnels"
  > & {
    since: string;
    verification?: Record<string, number>;
  };
  proposals?: Record<string, JudgedProposal>;
  /** Profile rounds: each analyst's judged whole-profile proposal. */
  profileProposals?: Record<string, JudgedProfileProposal>;
  /** Profile rounds: the per-cell aggregation (analysts counted, their weight) and any share rescale. */
  protocol?: Record<string, unknown>;
  /** The judge's identity, latency and cost (present whenever a judge was configured). */
  judge?: JudgeRecord;
  /** The daily series the analysts read, when there was one. */
  dailySource?: string;
  trust?: number;
  roles?: Record<string, string>;
  fallback?: string;
  /** `none`: the round had no published history, so no baseline was used (no-anchor mode). */
  anchor?: "none";
  /** How the no-anchor answer was aggregated from the proposals. */
  noAnchor?: NoAnchorAudit;
}

/** A judged whole-profile proposal: the cells it answered validly, one judge weight. */
export interface JudgedProfileProposal extends Omit<JudgedProposal, "mean" | "sd"> {
  profile: Record<string, Distribution>;
}

/** Sanity bounds a question implies (a named total, a percentage). */
export interface Bounds {
  lo: number;
  hi: number;
  why: string;
}

/** The no-anchor aggregation, stage by stage. */
export interface NoAnchorAudit {
  bounds?: Bounds;
  /** Analysts whose proposals counted. */
  used: string[];
  /** Proposals left out, with why. */
  dropped: Record<string, string>;
  median: number;
  medianSd: number;
  /** Sample sd of the used means (0 with one analyst). */
  dispersion: number;
  floor: number;
  floorShare: number;
}

/**
 * Thrown when a no-history round gets no usable proposal: the round is NOT
 * answered (there is no baseline to fall back to, and a number no evidence
 * supports is never filed). `detail` keeps the audit trail: dossier,
 * proposals, roles, judge and cost.
 */
export class NoAnchorRefusal extends Error {
  constructor(
    message: string,
    readonly detail: Partial<ResearchForecast>,
  ) {
    super(message);
    this.name = "NoAnchorRefusal";
  }
}

const ANALYST_SYSTEM = [
  "You are an analyst forecasting a published statistic for a live benchmark scored by CRPS skill against persistence (the last published value).",
  "You get the round's resolution and scoring rules, the start forecast (the prompt says what it is: the Civiqs nowcast — the freshest daily reading, with its date — or the persistence baseline), the series' dated history, for Civiqs its recent DAILY tracker, and a research dossier of dated, sourced facts.",
  "The history and the daily tracker are the benchmark's own measurements of this series. A press report of a different poll is a different population or question: never replace the level with it.",
  "Use other sources for CHANGES only: how each pollster moved since its own previous reading (house effects cancel in a change), how far markets or prices moved — and only changes the start reading does not already include (dated after it). Move from the start forecast only as far as those changes justify.",
  "If nothing is decisive, stay on the start forecast. Size sd honestly.",
  'Reply with ONE JSON object: {"mean": number, "sd": number > 0, "evidence": "<the specific facts that moved you, or none>", "reason": "<one or two sentences>"}.',
].join(" ");

function chunks(text: string): Evidence[] {
  const out: Evidence[] = [];
  for (let i = 0; i < text.length && out.length < MAX_EVIDENCE_CHUNKS; i += EVIDENCE_CHUNK) {
    out.push({ ref: `dossier:${out.length + 1}`, text: text.slice(i, i + EVIDENCE_CHUNK) });
  }
  return out;
}

/**
 * The structured facts every analyst is given — the series' own recent
 * history, the start forecast (the nowcast reading and its date) and the daily
 * tracker — as judge evidence, labeled as source data, not web research. A
 * rationale grounded in the series itself is grounded; without these, only
 * the dossier counted and a data-based rationale scored as ungrounded.
 */
export function seriesEvidence(
  round: ArenaRound,
  history: ArenaPoint[],
  start: RoundForecast,
  daily: CiviqsDaily | undefined,
): Evidence[] {
  const label = "STRUCTURED SOURCE DATA (the benchmark's own series; not web research)";
  const out: Evidence[] = [];
  if (history.length) {
    out.push({
      ref: "series:history",
      text: `${label}. Published history of ${round.series ?? round.round_id} (date value, oldest first):\n${datedLines(history, SERIES_EVIDENCE_POINTS)}`,
    });
  }
  out.push({ ref: "series:start", text: `${label}. ${startLine(round, start, history)}` });
  if (daily?.points.length) {
    out.push({
      ref: "series:daily",
      text: `${label}. Civiqs daily tracker from ${daily.source} (date value, oldest first):\n${datedLines(daily.points, daily.points.length)}`,
    });
  }
  return out;
}

export type { JudgeRecord } from "../../forecast/judge";

/** Each analyst's parsed reply (undefined on an error or no JSON), with the outcome noted in `roles`. */
async function askAnalysts(
  analysts: ResearchDeps["analysts"],
  system: string,
  user: string,
  roles: Record<string, string>,
): Promise<Array<readonly [string, Record<string, unknown> | undefined]>> {
  return Promise.all(
    analysts.map(async (a) => {
      const { reply, error } = await askAnalyst(a, system, user);
      roles[a.name] =
        error !== undefined
          ? `error: ${error.slice(0, 120)}`
          : reply
            ? "ok"
            : "invalid reply (no JSON object)";
      return [a.name, reply] as const;
    }),
  );
}

/**
 * One proposal through the judge (`judgeClaim`, shared with forecasting any
 * question): weight = grounded × quality / 2, clamped to [0, 1]; no judge ⇒
 * weight 1; a judge outage ⇒ weight 0 (no opinion, never a pass). Totals
 * accumulate into `judgeRecord`.
 */
async function judgeProposal(
  judge: DecisionProvider | undefined,
  judgeRecord: JudgeRecord | undefined,
  p: { mean: number; sd: number; reason: string },
  draft: string,
  evidence: Evidence[],
  question: string,
): Promise<JudgedProposal> {
  const judged = await judgeClaim(judge, judgeRecord, draft, evidence, question);
  return {
    mean: p.mean,
    sd: p.sd,
    weight: judged.weight,
    ...(p.reason ? { reason: p.reason.slice(0, 400) } : {}),
    ...(judged.quality === undefined ? {} : { quality: judged.quality }),
    ...(judged.grounded === undefined ? {} : { grounded: judged.grounded }),
    ...(judged.judgeError ? { judgeError: judged.judgeError } : {}),
    ...(judged.judgeLatencyMs === undefined ? {} : { judgeLatencyMs: judged.judgeLatencyMs }),
    ...(judged.judgeCostUsd === undefined ? {} : { judgeCostUsd: judged.judgeCostUsd }),
  };
}

export async function researchForecastRound(
  round: ArenaRound,
  lock: ArenaLock,
  deps: ResearchDeps,
): Promise<ResearchForecast> {
  if (round.target_type === "continuous_normal" && !hasHistory(lock)) {
    return noAnchorForecastRound(round, lock, deps);
  }
  const given = deps.base ? await deps.base(round, lock) : forecastRound(round, lock);
  const daily = dailyOf(given);
  const baseline = withoutDaily(given);
  const keep = (why: string, extra: Partial<ResearchForecast> = {}): ResearchForecast => ({
    ...baseline,
    ...extra,
    fallback: why,
  });
  const cells = round.cells ?? [];
  if (
    round.target_type === "profile_energy" &&
    cells.length >= 2 &&
    cells.every((c) => baseline.profile?.[c] !== undefined)
  ) {
    return researchProfileRound(round, lock, deps, baseline);
  }
  if (round.target_type !== "continuous_normal" || !baseline.topline) {
    return keep("research agent answers numeric and profile rounds; baseline for this shape");
  }
  const base = baseline.topline;
  // Search from the nowcast's own date when it is fresher than the weekly history.
  const nowcastUsed = (baseline as { nowcast?: Record<string, { date: string; value: number }> })
    .nowcast;
  const brief = buildResearchBrief(round, lock, {
    ...(round.series && nowcastUsed?.[round.series] ? { nowcast: nowcastUsed[round.series] } : {}),
  });

  let research: ResearchReport;
  try {
    research = await deps.retriever(brief);
  } catch (err) {
    return keep(`research failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const checked: VerifiedDossier | undefined = deps.pageText
    ? await verifyDossier(research.report, deps.pageText)
    : undefined;
  const dossier = {
    since: brief.since,
    report: research.report,
    sources: research.sources,
    costUsd: research.costUsd,
    searches: research.searches,
    retriever: research.retriever,
    ...(research.data ? { data: research.data } : {}),
    ...(research.warnings ? { warnings: research.warnings } : {}),
    ...(research.funnels ? { funnels: research.funnels } : {}),
    ...(checked ? { verification: checked.stats } : {}),
  };

  const history = lock.answer_history ?? lock.history ?? [];
  const sourceList = research.sources
    .map((s, i) => `[${i + 1}] ${s.title ?? ""} ${s.url}`)
    .join("\n");
  const user = [
    `Question: ${round.question}`,
    `Unit: ${round.unit ?? "(see question)"}; published around ${round.release_at}; locks ${round.lock_at}.`,
    ...rulesLines(round),
    "",
    historyBlock(round, history, 20),
    ...(daily ? ["", dailyBlock(daily)] : []),
    "",
    startLine(round, baseline, history),
    "",
    checked
      ? `RESEARCH DOSSIER (facts since ${brief.since}). Each cited line is tagged by a mechanical check of its figures against the cited page: rely on [verified] lines; treat [unverified] figures as likely wrong and [unreachable] ones as unconfirmed.\n${checked.annotated}`
      : `RESEARCH DOSSIER (facts since ${brief.since}):\n${research.report}`,
    sourceList ? `\nSources:\n${sourceList}` : "",
  ].join("\n");

  const roles: Record<string, string> = {};
  const raw = await askAnalysts(deps.analysts, ANALYST_SYSTEM, user, roles);

  // The judge grounds rationales in the series data every analyst was given,
  // plus only the dossier lines that survived verification (when it ran).
  const evidence = [
    ...seriesEvidence(round, history, baseline, daily),
    ...chunks(checked ? checked.verifiedText || "(no verified facts)" : research.report),
  ];
  const judgeRecord = newJudgeRecord(deps.judge);
  const proposals: Record<string, JudgedProposal> = {};
  await Promise.all(
    raw.map(async ([name, reply]) => {
      const mean = Number(reply?.mean);
      const sd = Number(reply?.sd);
      if (!reply || !Number.isFinite(mean) || !Number.isFinite(sd) || sd <= 0) {
        if (roles[name] === "ok") roles[name] = "invalid reply (no valid mean/sd)";
        return;
      }
      if (Math.abs(mean - base.mean) > MAX_SD_MOVE * base.sd) {
        roles[name] =
          `dropped: move ${Math.round((mean - base.mean) * 100) / 100} beyond ${MAX_SD_MOVE} baseline sd`;
        return;
      }
      const reason = [reply.evidence, reply.reason]
        .filter((x) => typeof x === "string")
        .join(" — ");
      proposals[name] = await judgeProposal(
        deps.judge,
        judgeRecord,
        { mean, sd, reason },
        `Forecast ${mean} ± ${sd} (start forecast ${base.mean} ± ${base.sd}). ${reason}`,
        evidence,
        round.question,
      );
    }),
  );

  const audit = {
    ...judgeAudit(judgeRecord),
    ...(daily ? { dailySource: daily.source } : {}),
  };
  const usable = Object.values(proposals);
  const totalWeight = usable.reduce((s, p) => s + p.weight, 0);
  if (usable.length === 0 || totalWeight <= 0) {
    return keep(usable.length ? "judge found no grounded proposal" : "no usable proposal", {
      dossier,
      proposals,
      roles,
      ...audit,
    });
  }
  const move = usable.reduce((s, p) => s + p.weight * (p.mean - base.mean), 0) / totalWeight;
  const sd = usable.reduce((s, p) => s + p.weight * p.sd, 0) / totalWeight;
  const confidence = totalWeight / usable.length;
  const trust = Math.min(Math.max(deps.trustCap ?? 0.5, 0), 1) * confidence;
  const round3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    ...baseline,
    topline: {
      mean: round3(base.mean + trust * move),
      sd: round3(Math.max(base.sd * 0.5, (1 - trust) * base.sd + trust * sd)),
    },
    dossier,
    proposals,
    ...audit,
    trust,
    roles,
    note: `marina research agent (${research.retriever}; ${usable.length} judged analysts) over ${freshestReading(baseline, round.series) ? "the Civiqs nowcast" : "the calibrated baseline"}`,
  };
}

// ─── No-anchor mode: a numeric round with no published history ──────────────

/** Does the lock carry any published value to anchor on? */
export function hasHistory(lock: ArenaLock): boolean {
  return (lock.answer_history ?? lock.history ?? []).some((p) => Number.isFinite(p.value));
}

/**
 * Sanity bounds the question itself implies: a total it names (`all 500
 * decided`, `out of 100`) bounds a count to [0, total]; a percentage unit (not
 * a margin, net or change) to [0, 100]. Otherwise none.
 */
export function questionBounds(round: ArenaRound): Bounds | undefined {
  const total = round.question.match(/\b(?:all|out of)\s+(\d[\d,]*)\b/i)?.[1];
  const n = total ? Number(total.replace(/,/g, "")) : Number.NaN;
  if (Number.isFinite(n) && n > 0) {
    return { lo: 0, hi: n, why: `the question names a total of ${n}` };
  }
  const unit = round.unit ?? "";
  if (
    /percent|%/i.test(unit) &&
    !/margin|net|change|spread|points/i.test(`${unit} ${round.series ?? ""}`)
  ) {
    return { lo: 0, hi: 100, why: "a percentage" };
  }
  return undefined;
}

/**
 * The deterministic no-anchor aggregate. Proposals outside the question's
 * bounds are dropped, then any mean more than {@link NO_ANCHOR_OUTLIER_K}
 * robust spreads (the larger of the median sd and 1.4826 × MAD of the means)
 * from the median; the answer is the median of what is left, with
 * sd = max(median analyst sd, the means' dispersion, the floor share × |median|).
 * Only `dropped` when nothing is left.
 */
export function aggregateNoAnchor(
  proposals: Record<string, Distribution>,
  bounds?: Bounds,
): { topline: Distribution; audit: NoAnchorAudit } | { dropped: Record<string, string> } {
  const dropped: Record<string, string> = {};
  let kept = Object.entries(proposals).filter(([name, p]) => {
    if (bounds && (p.mean < bounds.lo || p.mean > bounds.hi)) {
      dropped[name] = `mean ${p.mean} outside [${bounds.lo}, ${bounds.hi}] (${bounds.why})`;
      return false;
    }
    return true;
  });
  if (kept.length === 0) return { dropped };
  const m0 = median(kept.map(([, p]) => p.mean));
  const mad = median(kept.map(([, p]) => Math.abs(p.mean - m0)));
  const scale = Math.max(median(kept.map(([, p]) => p.sd)), 1.4826 * mad);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  kept = kept.filter(([name, p]) => {
    if (Math.abs(p.mean - m0) > NO_ANCHOR_OUTLIER_K * scale) {
      dropped[name] =
        `mean ${p.mean} is ${r2(Math.abs(p.mean - m0))} from the median ${r2(m0)} (> ${NO_ANCHOR_OUTLIER_K} × ${r2(scale)})`;
      return false;
    }
    return true;
  });
  const means = kept.map(([, p]) => p.mean);
  const mid = median(means);
  const medianSd = median(kept.map(([, p]) => p.sd));
  const avg = means.reduce((s, x) => s + x, 0) / means.length;
  const dispersion =
    means.length > 1
      ? Math.sqrt(means.reduce((s, x) => s + (x - avg) ** 2, 0) / (means.length - 1))
      : 0;
  const floor = NO_ANCHOR_SD_FLOOR_SHARE * Math.abs(mid);
  const round3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    topline: { mean: round3(mid), sd: round3(Math.max(medianSd, dispersion, floor)) },
    audit: {
      ...(bounds ? { bounds } : {}),
      used: kept.map(([name]) => name),
      dropped,
      median: round3(mid),
      medianSd: round3(medianSd),
      dispersion: round3(dispersion),
      floor: round3(floor),
      floorShare: NO_ANCHOR_SD_FLOOR_SHARE,
    },
  };
}

const NO_ANCHOR_SYSTEM = [
  "You are an analyst forecasting a quantity for a live benchmark scored by the CRPS of your normal {mean, sd} against the value that resolves the question.",
  "This quantity has NO published history and there is no start forecast: estimate its LEVEL from the research dossier — published forecasts of this exact quantity, prediction-market prices, the data they rest on and the base rate.",
  "Prefer the consensus of established forecasting models and markets over any single source, and rely on [verified] dossier lines; treat [unverified] figures as likely wrong.",
  "Size sd for the uncertainty that remains until resolution: honest, never artificially narrow (a too-narrow sd is punished hard).",
  'If the dossier holds no evidence of the level, abstain: reply {"abstain": true, "reason": "<why>"} — never guess.',
  'Otherwise reply with ONE JSON object: {"mean": number, "sd": number > 0, "evidence": "<the specific facts your estimate rests on>", "reason": "<one or two sentences>"}.',
].join(" ");

/**
 * The research agent for a numeric round with no history: brief → retrieve →
 * verify → analysts (levels, not moves) → judge (a filter: an ungrounded or
 * unjudged proposal does not count) → {@link aggregateNoAnchor}. Throws
 * {@link NoAnchorRefusal}, carrying the audit trail, when nothing is usable.
 */
export async function noAnchorForecastRound(
  round: ArenaRound,
  lock: ArenaLock,
  deps: ResearchDeps,
): Promise<ResearchForecast> {
  const brief = buildResearchBrief(round, lock);
  let research: ResearchReport;
  try {
    research = await deps.retriever(brief);
  } catch (err) {
    throw new NoAnchorRefusal(
      `${round.round_id}: no history to forecast from, and research failed (${err instanceof Error ? err.message : String(err)}) — not answered`,
      { anchor: "none" },
    );
  }
  const checked: VerifiedDossier | undefined = deps.pageText
    ? await verifyDossier(research.report, deps.pageText)
    : undefined;
  const dossier = {
    since: brief.since,
    report: research.report,
    sources: research.sources,
    costUsd: research.costUsd,
    searches: research.searches,
    retriever: research.retriever,
    ...(research.data ? { data: research.data } : {}),
    ...(research.warnings ? { warnings: research.warnings } : {}),
    ...(research.funnels ? { funnels: research.funnels } : {}),
    ...(checked ? { verification: checked.stats } : {}),
  };
  const bounds = questionBounds(round);
  const sourceList = research.sources
    .map((s, i) => `[${i + 1}] ${s.title ?? ""} ${s.url}`)
    .join("\n");
  const user = [
    `Question: ${round.question}`,
    `Unit: ${round.unit ?? "(see question)"}; published around ${round.release_at}; locks ${round.lock_at}.`,
    round.resolve ? `Resolution: ${round.resolve}.` : rulesLines(round)[0]!,
    "Scoring: CRPS of your normal {mean, sd} against the resolved value; a too-narrow sd is punished hard, a too-wide one wastes skill.",
    ...(bounds ? [`Bounds: the answer lies in [${bounds.lo}, ${bounds.hi}] (${bounds.why}).`] : []),
    "",
    "History: (none — this quantity has never been published; there is no start forecast)",
    "",
    checked
      ? `RESEARCH DOSSIER (facts since ${brief.since}). Each cited line is tagged by a mechanical check of its figures against the cited page: rely on [verified] lines; treat [unverified] figures as likely wrong and [unreachable] ones as unconfirmed.\n${checked.annotated}`
      : `RESEARCH DOSSIER (facts since ${brief.since}):\n${research.report}`,
    sourceList ? `\nSources:\n${sourceList}` : "",
  ].join("\n");

  const roles: Record<string, string> = {};
  const raw = await askAnalysts(deps.analysts, NO_ANCHOR_SYSTEM, user, roles);
  const evidence: Evidence[] = [
    {
      ref: "series:none",
      text: "STRUCTURED SOURCE DATA: this quantity has no published history and no start forecast; the estimate must rest on the research dossier.",
    },
    ...chunks(checked ? checked.verifiedText || "(no verified facts)" : research.report),
  ];
  const judgeRecord = newJudgeRecord(deps.judge);
  const proposals: Record<string, JudgedProposal> = {};
  await Promise.all(
    raw.map(async ([name, reply]) => {
      if (reply?.abstain === true) {
        roles[name] = `abstained: ${String(reply.reason ?? "").slice(0, 160)}`;
        return;
      }
      const mean = Number(reply?.mean);
      const sd = Number(reply?.sd);
      if (!reply || !Number.isFinite(mean) || !Number.isFinite(sd) || sd <= 0) {
        if (roles[name] === "ok") roles[name] = "invalid reply (no valid mean/sd)";
        return;
      }
      const reason = [reply.evidence, reply.reason]
        .filter((x) => typeof x === "string")
        .join(" — ");
      proposals[name] = await judgeProposal(
        deps.judge,
        judgeRecord,
        { mean, sd, reason },
        `Forecast ${mean} ± ${sd} (no published history; no start forecast). ${reason}`,
        evidence,
        round.question,
      );
    }),
  );

  // The judge is a filter here: only a grounded (weight > 0) proposal counts.
  const judged: Record<string, Distribution> = {};
  for (const [name, p] of Object.entries(proposals)) {
    if (p.weight > 0) judged[name] = { mean: p.mean, sd: p.sd };
    else roles[name] = p.judgeError ? `unjudged: ${p.judgeError}` : "dropped: judged ungrounded";
  }
  const agg = aggregateNoAnchor(judged, bounds);
  const dropped = "topline" in agg ? agg.audit.dropped : agg.dropped;
  for (const [name, why] of Object.entries(dropped)) roles[name] = `dropped: ${why}`;
  const audit: Partial<ResearchForecast> = {
    anchor: "none",
    dossier,
    proposals,
    roles,
    ...judgeAudit(judgeRecord),
  };
  if (!("topline" in agg)) {
    const reasons = Object.entries(roles).map(([name, r]) => `${name}: ${r}`);
    throw new NoAnchorRefusal(
      `${round.round_id}: no history to forecast from, and no usable research proposal (${reasons.join("; ") || "no analysts"}) — not answered`.slice(
        0,
        600,
      ),
      audit,
    );
  }
  return {
    topline: agg.topline,
    rules: {},
    ...audit,
    noAnchor: agg.audit,
    note: `marina research agent, no anchor (${research.retriever}; median of ${agg.audit.used.length} judged analysts; sd ≥ ${Math.round(NO_ANCHOR_SD_FLOOR_SHARE * 100)}% of the level): the series has no published history`,
  };
}

// ─── Profile rounds: the whole profile per analyst, aggregated per cell ─────

const PROFILE_ANALYST_SYSTEM = [
  "You are an analyst forecasting a published PROFILE — one statistic per cell — for a live benchmark scored by the energy score of the whole profile against persistence (each cell's last published value).",
  "You get the round's resolution and scoring rules, every cell's dated history and start forecast (the Civiqs nowcast reading, with its date, where noted; else persistence), and a research dossier of dated, sourced facts gathered item by item.",
  "The histories are the benchmark's own measurements of these cells. Never replace a cell's level with a different source's number.",
  "Use the dossier for CHANGES only: scheduled or reported events that bear on one item (a launch, an announcement, a premiere, a final), how a pollster's reading of a subgroup moved since its own previous one — and only what is dated after the start. Move a cell only as far as that evidence justifies; leave every other cell on its start.",
  "Size each sd honestly.",
  'Reply with ONE JSON object: {"profile": {"<cell>": {"mean": number, "sd": number > 0}, …one entry for EVERY cell, keyed exactly as listed…}, "evidence": "<the specific facts that moved you, cell by cell, or none>", "reason": "<one or two sentences>"}.',
].join(" ");

/**
 * The research agent on a profile round (anchored: the start profile is the
 * anchor). One retrieval, one reply per analyst for the whole profile, one
 * judgment per analyst, then per cell: the judge-weighted mean move of the
 * analysts that answered the cell, scaled by trustCap × the judged confidence,
 * the sd blended with a floor of half the start sd.
 */
async function researchProfileRound(
  round: ArenaRound,
  lock: ArenaLock,
  deps: ResearchDeps,
  baseline: RoundForecast,
): Promise<ResearchForecast> {
  const cells = round.cells ?? [];
  const base = baseline.profile!;
  const keep = (why: string, extra: Partial<ResearchForecast> = {}): ResearchForecast => ({
    ...baseline,
    ...extra,
    fallback: why,
  });
  const nowcastUsed = (baseline as { nowcast?: Record<string, { date: string; value: number }> })
    .nowcast;
  const brief = buildResearchBrief(round, lock, nowcastUsed ? { cellNowcasts: nowcastUsed } : {});
  let research: ResearchReport;
  try {
    research = await deps.retriever(brief);
  } catch (err) {
    return keep(`research failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const checked: VerifiedDossier | undefined = deps.pageText
    ? await verifyDossier(research.report, deps.pageText)
    : undefined;
  const dossier = {
    since: brief.since,
    report: research.report,
    sources: research.sources,
    costUsd: research.costUsd,
    searches: research.searches,
    retriever: research.retriever,
    ...(research.data ? { data: research.data } : {}),
    ...(research.warnings ? { warnings: research.warnings } : {}),
    ...(research.funnels ? { funnels: research.funnels } : {}),
    ...(checked ? { verification: checked.stats } : {}),
  };
  const histories = cellHistories(round, lock);
  const share = shareBasketTotal(round, lock, baseline);
  const sourceList = research.sources
    .map((s, i) => `[${i + 1}] ${s.title ?? ""} ${s.url}`)
    .join("\n");
  const user = [
    `Question: ${round.question}`,
    `Unit: ${round.unit ?? "(see question)"}; published around ${round.release_at}; locks ${round.lock_at}.`,
    ...profileRulesLines(round, share),
    `Cells (${cells.length}): ${cells.join(", ")}`,
    profileStartLine(baseline, cells),
    "",
    cellBlock(round, histories, baseline, SERIES_EVIDENCE_POINTS),
    "",
    checked
      ? `RESEARCH DOSSIER (facts since ${brief.since}). Each cited line is tagged by a mechanical check of its figures against the cited page: rely on [verified] lines; treat [unverified] figures as likely wrong and [unreachable] ones as unconfirmed.\n${checked.annotated}`
      : `RESEARCH DOSSIER (facts since ${brief.since}):\n${research.report}`,
    sourceList ? `\nSources:\n${sourceList}` : "",
  ].join("\n");

  const roles: Record<string, string> = {};
  const raw = await askAnalysts(deps.analysts, PROFILE_ANALYST_SYSTEM, user, roles);
  const evidence: Evidence[] = [
    {
      ref: "series:cells",
      text: `STRUCTURED SOURCE DATA (the benchmark's own series; not web research). ${cellBlock(round, histories, baseline, 6)}`,
    },
    ...chunks(checked ? checked.verifiedText || "(no verified facts)" : research.report),
  ];
  const judgeRecord = newJudgeRecord(deps.judge);
  const proposals: Record<string, JudgedProfileProposal> = {};
  await Promise.all(
    raw.map(async ([name, reply]) => {
      if (!reply) return;
      const { profile, issues } = parseProfile(reply.profile, cells, base, MAX_SD_MOVE);
      if (Object.keys(profile).length === 0) {
        if (roles[name] === "ok") roles[name] = "invalid reply (no valid cell)";
        return;
      }
      if (issues.length && roles[name] === "ok") {
        roles[name] = `ok; ${issues.length} cell(s) left out: ${issues.join("; ")}`.slice(0, 400);
      }
      const reason = [reply.evidence, reply.reason]
        .filter((x) => typeof x === "string")
        .join(" — ");
      const moves = Object.entries(profile)
        .filter(([c, d]) => d.mean !== base[c]!.mean)
        .map(([c, d]) => `${c} ${base[c]!.mean}→${d.mean} (sd ${d.sd})`);
      const judged = await judgeProposal(
        deps.judge,
        judgeRecord,
        { mean: 0, sd: 1, reason },
        `Profile forecast: ${moves.length ? moves.join("; ") : "every cell at its start"}. ${reason}`,
        evidence,
        round.question,
      );
      const { mean: _m, sd: _s, ...rest } = judged;
      proposals[name] = { ...rest, profile };
    }),
  );

  const audit = judgeAudit(judgeRecord);
  const usable = Object.values(proposals);
  const totalWeight = usable.reduce((s, p) => s + p.weight, 0);
  if (usable.length === 0 || totalWeight <= 0) {
    return keep(usable.length ? "judge found no grounded proposal" : "no usable proposal", {
      dossier,
      profileProposals: proposals,
      roles,
      ...audit,
    });
  }
  const trustCap = Math.min(Math.max(deps.trustCap ?? 0.5, 0), 1);
  const round3 = (x: number) => Math.round(x * 1000) / 1000;
  const profile: Record<string, Distribution> = {};
  const perCell: Record<string, { n: number; weight: number; trust: number }> = {};
  for (const c of cells) {
    const b = base[c]!;
    const on = usable.filter((p) => p.profile[c]);
    const w = on.reduce((s, p) => s + p.weight, 0);
    if (on.length === 0 || w <= 0) {
      profile[c] = { mean: b.mean, sd: b.sd };
      perCell[c] = { n: on.length, weight: 0, trust: 0 };
      continue;
    }
    const move = on.reduce((s, p) => s + p.weight * (p.profile[c]!.mean - b.mean), 0) / w;
    const sd = on.reduce((s, p) => s + p.weight * p.profile[c]!.sd, 0) / w;
    const trust = trustCap * (w / on.length);
    profile[c] = {
      mean: round3(b.mean + trust * move),
      sd: round3(Math.max(b.sd * 0.5, (1 - trust) * b.sd + trust * sd)),
    };
    perCell[c] = { n: on.length, weight: round3(w), trust: round3(trust) };
  }
  const closed = share !== undefined ? renormaliseShares(profile, cells, share) : undefined;
  return {
    ...baseline,
    profile: closed?.profile ?? profile,
    dossier,
    profileProposals: proposals,
    ...audit,
    trust: trustCap * (totalWeight / usable.length),
    roles,
    protocol: { cells: perCell, ...(closed ? { shares: closed.audit } : {}) },
    note: `marina research agent (${research.retriever}; ${usable.length} judged analysts) over ${nowcastUsed ? "the Civiqs nowcast profile" : "the calibrated baseline"}, per cell${closed ? `, shares rescaled to ${share}` : ""}`,
  };
}
