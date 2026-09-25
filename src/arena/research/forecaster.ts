// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The research agent: evidence first, forecast second, judged before it counts.
 *
 *   1. brief      — a family playbook bounded to news since the last published value
 *   2. retrieve   — a search-grounded researcher returns a dated, cited dossier
 *   3. analysts   — several models (one per vendor) forecast from history + baseline
 *                   + dossier, and must say which evidence moved them
 *   4. judge      — the decision backend (Jev when configured) scores each
 *                   analyst's rationale for quality and for grounding in the
 *                   dossier; an ungrounded rationale earns no weight
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
import type { ArenaLock, ArenaRound, Distribution } from "../types";
import { buildResearchBrief } from "./briefs";
import type { ResearchReport, Retriever } from "./retrieve";
import { type PageText, type VerifiedDossier, verifyDossier } from "./verify";

const MAX_SD_MOVE = 4;
const EVIDENCE_CHUNK = 1_400;
const MAX_EVIDENCE_CHUNKS = 4;

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
  weight: number;
}

export interface ResearchForecast extends RoundForecast {
  dossier?: Pick<ResearchReport, "report" | "sources" | "costUsd" | "searches" | "retriever"> & {
    since: string;
    verification?: Record<string, number>;
  };
  proposals?: Record<string, JudgedProposal>;
  trust?: number;
  roles?: Record<string, string>;
  fallback?: string;
}

const ANALYST_SYSTEM = [
  "You are an analyst forecasting a published statistic for a live benchmark scored by CRPS against persistence (the last published value).",
  "You get the series' recent history, a calibrated baseline, and a research dossier of dated, sourced facts published since the last value.",
  "The history is the benchmark's OWN measurement and is authoritative: its last value is already the latest wave (dated by field start). If a press report of that same survey shows a different number, it is a different population or question — never replace the level with it.",
  "Use other sources for CHANGES only: how each pollster moved since its own previous reading (house effects cancel in a change), how far markets or prices moved. Move from the baseline only as far as those changes justify.",
  "If the dossier holds nothing decisive, stay on the baseline. Size sd honestly.",
  'Reply with ONE JSON object: {"mean": number, "sd": number > 0, "evidence": "<the specific facts that moved you, or none>", "reason": "<one or two sentences>"}.',
].join(" ");

function chunks(text: string): Evidence[] {
  const out: Evidence[] = [];
  for (let i = 0; i < text.length && out.length < MAX_EVIDENCE_CHUNKS; i += EVIDENCE_CHUNK) {
    out.push({ ref: `dossier:${out.length + 1}`, text: text.slice(i, i + EVIDENCE_CHUNK) });
  }
  return out;
}

export async function researchForecastRound(
  round: ArenaRound,
  lock: ArenaLock,
  deps: ResearchDeps,
): Promise<ResearchForecast> {
  const baseline = deps.base ? await deps.base(round, lock) : forecastRound(round, lock);
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

  const history = (lock.answer_history ?? lock.history ?? []).slice(-20);
  const sourceList = research.sources
    .map((s, i) => `[${i + 1}] ${s.title ?? ""} ${s.url}`)
    .join("\n");
  const user = [
    `Question: ${round.question}`,
    `Unit: ${round.unit ?? "(see question)"}; published around ${round.release_at}; locks ${round.lock_at}.`,
    "",
    `History (date value), oldest first:\n${history.map((p) => `${p.date} ${p.value}`).join("\n")}`,
    `Baseline: ${JSON.stringify(base)}`,
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

  // The judge grounds rationales only in what survived verification (when it ran).
  const evidence = chunks(
    checked ? checked.verifiedText || "(no verified facts)" : research.report,
  );
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
      if (deps.judge) {
        const verdict = await checkDraft(
          deps.judge,
          `Forecast ${mean} ± ${sd} (baseline ${base.mean} ± ${base.sd}). ${reason}`.slice(
            0,
            3_000,
          ),
          evidence,
          round.question,
        );
        if (!verdict.error) {
          quality = verdict.signals.quality;
          grounded = verdict.signals.grounded;
          // No grounding ⇒ no weight; a fully grounded, high-quality rationale ⇒ weight 1.
          weight = Math.max(0, Math.min(1, (grounded ?? 0) * ((quality ?? 0) / 2)));
        }
      }
      proposals[name] = {
        mean,
        sd,
        weight,
        ...(reason ? { reason: reason.slice(0, 400) } : {}),
        ...(quality === undefined ? {} : { quality }),
        ...(grounded === undefined ? {} : { grounded }),
      };
    }),
  );

  const usable = Object.values(proposals);
  const totalWeight = usable.reduce((s, p) => s + p.weight, 0);
  if (usable.length === 0 || totalWeight <= 0) {
    return keep(usable.length ? "judge found no grounded proposal" : "no usable proposal", {
      dossier,
      proposals,
      roles,
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
    trust,
    roles,
    note: `marina research agent (${research.retriever}; ${usable.length} judged analysts) over the calibrated baseline`,
  };
}
