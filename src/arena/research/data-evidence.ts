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

import { createHash } from "node:crypto";
import type { DataHints, ForecastLookup, LookupResult } from "../../forecast/lookup-types";
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
  opts: {
    now?: () => Date;
    query?: (brief: ResearchBrief) => string;
    /** Explicit experiment inputs; default mappings and live routes stay unchanged. */
    hints?: (brief: ResearchBrief) => ReturnType<typeof arenaLookupHints>;
  } = {},
): Retriever {
  if (lookups.length === 0) return inner;
  return async (brief: ResearchBrief): Promise<ResearchReport> => {
    const report = await inner(brief);
    const now = (opts.now ?? (() => new Date()))();
    const { hints, related } = (opts.hints ?? arenaLookupHints)(brief);
    const query =
      opts.query?.(brief) ?? brief.queries?.slice(0, 2).join(" ") ?? brief.request.slice(0, 200);
    let lines: string[] = [];
    let evidence: LookupResult[] = [];
    const sources: ResearchReport["sources"] = [];
    try {
      const seriesNamed = !!(hints.fred?.length || hints.bls?.length);
      const usable = lookups
        .filter((l) => seriesNamed || (l.name !== "fred" && l.name !== "bls"))
        .map(
          (l): ForecastLookup =>
            l.name !== "fred"
              ? l
              : {
                  name: l.name,
                  lookup: (query, cutoff, now, ctx) => {
                    // Historical FRED vintages have day precision, not publication instants.
                    // A live read is causal; a past intraday cutoff uses the prior UTC day.
                    const at =
                      cutoff.getTime() < now.getTime()
                        ? new Date(Date.parse(cutoff.toISOString().slice(0, 10)) - 1)
                        : cutoff;
                    return l.lookup(query, at, now, ctx);
                  },
                },
        );
      const results = await runLookups(usable, query, briefCutoff(brief, now), now, {
        hints: { ...hints, markets: query },
      });
      evidence = results;
      // Compare information vintages as well as observation periods. A monthly
      // decline already known at the start reading is not fresh weekly news.
      const anchorAt = new Date(`${brief.since}T00:00:00Z`);
      const fred = usable.find((l) => l.name === "fred");
      const prior =
        fred &&
        Number.isFinite(anchorAt.getTime()) &&
        anchorAt < now &&
        results.some((r) => r.name === "fred" && r.readings?.length)
          ? (await runLookups([fred], query, anchorAt, now, { hints }))[0]
          : undefined;
      if (prior) evidence = [...results, { ...prior, name: "fred-anchor-vintage" }];
      for (const r of results) {
        if (r.name === "fred" && r.readings?.length) {
          for (const reading of r.readings) {
            const previous = reading.history?.filter((p) => p.date < reading.date).at(-1);
            const delta = previous
              ? Math.round((reading.value - previous.value) * 1000) / 1000
              : undefined;
            const anchor = prior?.readings?.find((p) => p.series === reading.series);
            const vintageDelta = anchor
              ? Math.round((reading.value - anchor.value) * 1000) / 1000
              : undefined;
            const payload = JSON.stringify({ reading, previous, delta, anchor, vintageDelta });
            const digest = createHash("sha256").update(payload).digest("hex");
            // A unique URL identifies the frozen payload in the existing provided-text
            // verifier; a current HTML series page cannot verify an older vintage.
            const url = `https://fred.stlouisfed.org/series/${encodeURIComponent(reading.series)}#marina-vintage-${digest}`;
            const change = previous
              ? `previous ${previous.value} on ${previous.date}; same-vintage change ${delta}`
              : "no previous observation; change unavailable";
            const update = anchor
              ? `change since anchor vintage ${anchor.asOf.slice(0, 10)}: ${vintageDelta}${vintageDelta === 0 ? " (no new level change)" : ""}`
              : "change since start reading unavailable; do not treat the period change as new evidence";
            lines.push(
              `- ${reading.date} — FRED ${reading.series}: ${reading.value}${reading.unit ? ` ${reading.unit}` : ""}; ${change}; ${update}; vintage ${reading.asOf.slice(0, 10)} [FRED](${url})`,
            );
            sources.push({ url, title: `FRED ${reading.series}`, text: payload });
          }
          continue;
        }
        lines = lines.concat(r.lines);
        for (const s of r.sources)
          sources.push({ url: s.url, ...(s.title ? { title: s.title } : {}) });
      }
    } catch {
      // allow-empty-catch: structured data is optional evidence; research stands without it
    }
    if (lines.length === 0) return { ...report, data: evidence };
    const head = `STRUCTURED DATA (as of the cutoff; evidence of CHANGES only — the round's own history sets the level${related ? `; related series: ${related}` : ""}):`;
    return {
      ...report,
      data: evidence,
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
