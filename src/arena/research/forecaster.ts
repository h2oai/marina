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
 * Every stage's output is returned (`dossier`, `proposals`, `judged`) so a
 * shadow run can be audited and the stages measured separately. Web research
 * cannot be backtested — a search run after release finds the answer — so this
 * forecaster is evaluated in SHADOW on live rounds only.
 */

import type { Evidence } from "../../decisions/evidence";
import type { DecisionProvider } from "../../decisions/types";
import { checkDraft } from "../../decisions/verify";
import { forecastRound, type RoundForecast } from "../forecast";
import { type Complete, parseReply } from "../model-forecaster";
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
  dossier?: Pick<ResearchReport, "report" | "sources" | "costUsd" | "searches" | "retriever"> & {
    since: string;
    verification?: Record<string, number>;
  };
  proposals?: Record<string, JudgedProposal>;
  /** The judge's identity, latency and cost (present whenever a judge was configured). */
  judge?: JudgeRecord;
  /** The daily series the analysts read, when there was one. */
  dailySource?: string;
  trust?: number;
  roles?: Record<string, string>;
  fallback?: string;
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

/** What the judge was and what it cost, summed over the proposals it judged. */
export interface JudgeRecord {
  provider?: string;
  model?: string;
  calls: number;
  latencyMs: number;
  costUsd: number;
  errors: number;
  error?: string;
}

export async function researchForecastRound(
  round: ArenaRound,
  lock: ArenaLock,
  deps: ResearchDeps,
): Promise<ResearchForecast> {
  const given = deps.base ? await deps.base(round, lock) : forecastRound(round, lock);
  const daily = dailyOf(given);
  const baseline = withoutDaily(given);
  const keep = (why: string, extra: Partial<ResearchForecast> = {}): ResearchForecast => ({
    ...baseline,
    ...extra,
    fallback: why,
  });
  if (round.target_type !== "continuous_normal" || !baseline.topline) {
    return keep("research agent answers numeric rounds; baseline for this shape");
  }
  const base = baseline.topline;
  const brief = buildResearchBrief(round, lock);

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
  const raw = await Promise.all(
    deps.analysts.map(async (a) => {
      try {
        const reply = parseReply(await a.complete(ANALYST_SYSTEM, user));
        roles[a.name] = reply ? "ok" : "invalid reply (no JSON object)";
        return [a.name, reply] as const;
      } catch (err) {
        roles[a.name] =
          `error: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`;
        return [a.name, undefined] as const;
      }
    }),
  );

  // The judge grounds rationales in the series data every analyst was given,
  // plus only the dossier lines that survived verification (when it ran).
  const evidence = [
    ...seriesEvidence(round, history, baseline, daily),
    ...chunks(checked ? checked.verifiedText || "(no verified facts)" : research.report),
  ];
  const judgeRecord: JudgeRecord | undefined = deps.judge
    ? {
        provider: deps.judge.kind,
        ...(deps.judge.model ? { model: deps.judge.model } : {}),
        calls: 0,
        latencyMs: 0,
        costUsd: 0,
        errors: 0,
      }
    : undefined;
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
      let weight = 1;
      let quality: number | undefined;
      let grounded: number | undefined;
      let judgeError: string | undefined;
      let judgeLatencyMs: number | undefined;
      let judgeCostUsd: number | undefined;
      if (deps.judge) {
        const verdict = await checkDraft(
          deps.judge,
          `Forecast ${mean} ± ${sd} (start forecast ${base.mean} ± ${base.sd}). ${reason}`.slice(
            0,
            3_000,
          ),
          evidence,
          round.question,
        );
        if (judgeRecord) {
          judgeRecord.calls++;
          if (verdict.provider) judgeRecord.provider = verdict.provider;
          if (verdict.model) judgeRecord.model = verdict.model;
          judgeRecord.latencyMs = Math.max(judgeRecord.latencyMs, verdict.latencyMs ?? 0);
          judgeRecord.costUsd += verdict.costUsd ?? 0;
        }
        judgeLatencyMs = verdict.latencyMs;
        judgeCostUsd = verdict.costUsd;
        if (!verdict.error) {
          quality = verdict.signals.quality;
          grounded = verdict.signals.grounded;
          // No grounding ⇒ no weight; a fully grounded, high-quality rationale ⇒ weight 1.
          weight = Math.max(0, Math.min(1, (grounded ?? 0) * ((quality ?? 0) / 2)));
        } else {
          // A judge outage is no opinion, never a pass: an unjudged proposal
          // gets no weight (it used to keep weight 1 — ~10× a judged run).
          weight = 0;
          judgeError = String(verdict.error).slice(0, 200);
          if (judgeRecord) {
            judgeRecord.errors++;
            judgeRecord.error = judgeError;
          }
        }
      }
      proposals[name] = {
        mean,
        sd,
        weight,
        ...(reason ? { reason: reason.slice(0, 400) } : {}),
        ...(quality === undefined ? {} : { quality }),
        ...(grounded === undefined ? {} : { grounded }),
        ...(judgeError ? { judgeError } : {}),
        ...(judgeLatencyMs === undefined ? {} : { judgeLatencyMs }),
        ...(judgeCostUsd === undefined ? {} : { judgeCostUsd }),
      };
    }),
  );

  const audit = {
    ...(judgeRecord
      ? { judge: { ...judgeRecord, costUsd: Math.round(judgeRecord.costUsd * 1e6) / 1e6 } }
      : {}),
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
