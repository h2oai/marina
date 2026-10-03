// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Structured data as research evidence for arena rounds — the forecast
 * lookups (src/forecast/lookups.ts: prediction markets, official series)
 * appended to a research dossier, OPT-IN (`MARINA_ARENA_RESEARCH_LOOKUPS`,
 * default off, same spec as `MARINA_FORECAST_LOOKUPS`).
 *
 * The arena rule holds: the round's own benchmark history is authoritative
 * for the LEVEL; other sources are evidence of CHANGES only. The lines are
 * headed accordingly, and the analysts' prompt already says the same. Every
 * lookup reads as of the brief's cutoff (`untilAt` / `until`, else now) and
 * never later than now, so nothing published after the lock is read.
 *
 * Official series are named only where an arena series has a close official
 * relative (`ARENA_RELATED_SERIES`); a round with none gets market prices
 * only. Unmatched lookups add nothing.
 */

import type { DataHints, ForecastLookup } from "../../forecast/lookup-types";
import { type LookupName, lookupsFromSpec, runLookups } from "../../forecast/lookups";
import type { ResearchBrief } from "./briefs";
import type { ResearchReport, Retriever } from "./retrieve";

/**
 * Official series related to an arena round (by round id): evidence of the
 * DIRECTION of change in the same quantity, never its level. Kept small and
 * explicit: only series that measure nearly the same thing.
 */
export const ARENA_RELATED_SERIES: Array<{ round: RegExp; hints: DataHints; why: string }> = [
  {
    round: /^sce-.*-infl1y$/,
    hints: { fred: ["MICH"] },
    why: "University of Michigan 1-year expected inflation (a different survey of the same expectation)",
  },
  {
    round: /^sce-.*-infl3y$/,
    hints: { fred: ["EXPINF3YR"] },
    why: "Cleveland Fed 3-year expected inflation (model-based)",
  },
  {
    round: /^civiqs-.*-econ-(now|direction)$/,
    hints: { fred: ["UMCSENT"] },
    why: "University of Michigan consumer sentiment",
  },
];

/** The data lookups an arena brief may use (markets always; series where related). */
export function arenaLookupHints(brief: ResearchBrief): {
  hints: DataHints;
  related?: string;
} {
  const hit = ARENA_RELATED_SERIES.find((r) => r.round.test(brief.roundId));
  return hit ? { hints: { ...hit.hints }, related: hit.why } : { hints: {} };
}

/** The brief's evidence cutoff: its exact instant, else its last allowed day, else now. */
export function briefCutoff(brief: ResearchBrief, now: Date): Date {
  const at = brief.untilAt ? Date.parse(brief.untilAt) : Number.NaN;
  if (Number.isFinite(at)) return new Date(at);
  const day = brief.until ? Date.parse(`${brief.until}T00:00:00Z`) : Number.NaN;
  if (Number.isFinite(day)) return new Date(day);
  return now;
}

/**
 * Wrap a research retriever so its report also carries the structured-data
 * lines for the round, under a CHANGES-only heading. A lookup failure never
 * fails the research; nothing is added when nothing matched.
 */
export function withDataLookups(
  inner: Retriever,
  lookups: ForecastLookup[],
  opts: { now?: () => Date; query?: (brief: ResearchBrief) => string } = {},
): Retriever {
  if (lookups.length === 0) return inner;
  return async (brief: ResearchBrief): Promise<ResearchReport> => {
    const report = await inner(brief);
    const now = (opts.now ?? (() => new Date()))();
    const { hints, related } = arenaLookupHints(brief);
    const query =
      opts.query?.(brief) ?? brief.queries?.slice(0, 2).join(" ") ?? brief.request.slice(0, 200);
    let lines: string[] = [];
    const sources: ResearchReport["sources"] = [];
    try {
      const seriesNamed = !!(hints.fred?.length || hints.bls?.length);
      const usable = lookups.filter((l) => seriesNamed || (l.name !== "fred" && l.name !== "bls"));
      const results = await runLookups(usable, query, briefCutoff(brief, now), now, {
        hints: { ...hints, markets: query },
      });
      for (const r of results) {
        lines = lines.concat(r.lines);
        for (const s of r.sources)
          sources.push({ url: s.url, ...(s.title ? { title: s.title } : {}) });
      }
    } catch {
      // allow-empty-catch: structured data is optional evidence; research stands without it
    }
    if (lines.length === 0) return report;
    const head = `STRUCTURED DATA (as of the cutoff; evidence of CHANGES only — the round's own history sets the level${related ? `; related series: ${related}` : ""}):`;
    return {
      ...report,
      report: `${report.report}\n\n${head}\n${lines.join("\n")}`,
      sources: [
        ...report.sources,
        ...sources.filter((s) => !report.sources.some((x) => x.url === s.url)),
      ],
    };
  };
}

/** `MARINA_ARENA_RESEARCH_LOOKUPS` (default off): the lookups arena research may add. */
export function arenaResearchLookups(env: NodeJS.ProcessEnv = process.env): ForecastLookup[] {
  const spec = env.MARINA_ARENA_RESEARCH_LOOKUPS?.trim();
  if (!spec || spec.toLowerCase() === "off" || spec.toLowerCase() === "none") return [];
  // Odds have no arena family; everything else follows the general spec.
  return lookupsFromSpec(spec, env).filter((l) => (l.name as LookupName) !== "odds");
}
