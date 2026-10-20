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
import { getErrorMessage } from "../../engine/errors";
import type { DataHints, ForecastLookup, LookupResult } from "../../forecast/lookup-types";
import {
  type LookupName,
  lookupsFromSpec,
  runLookups,
  voteHubLookup,
} from "../../forecast/lookups";
import { isDateStrict, type ResearchReport, type Retriever } from "../../research/retrieve";
import type { ResearchBrief } from "./briefs";
import { arenaLookupSpec, arenaSignalEntry, arenaSignalSet } from "./signal-map";

/** FRED series per lookup call (the lookup's own cap); more named series run in chunks. */
const FRED_CHUNK = 3;

/**
 * Freeze one non-FRED lookup line (a market price, a poll) under a unique URL
 * whose provided text is the line's own payload, so the citation check
 * verifies it against what was read at the cutoff rather than a live page
 * that has moved on. The original link stays as the source's `origin`.
 */
export function freezeLookupLine(
  name: string,
  line: string,
  asOf: string | undefined,
): { line: string; source?: ResearchReport["sources"][number] } {
  const link = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/.exec(line);
  if (!link) return { line };
  const origin = link[2]!.split("#")[0]!;
  const payload = JSON.stringify({ lookup: name, asOf, line });
  const digest = createHash("sha256").update(payload).digest("hex").slice(0, 32);
  const url = `${origin}#marina-snapshot-${digest}`;
  const observed = /^- (\d{4}-\d{2}-\d{2})/.exec(line)?.[1];
  return {
    line: line.replace(link[0], `[${link[1]}](${url})`),
    source: {
      url,
      title: `${name} ${link[1]}`.trim(),
      text: payload,
      origin,
      ...(observed ? { observedAt: observed } : {}),
      ...(asOf ? { availableAt: asOf } : {}),
    },
  };
}

/** Run a FRED lookup over every named series, three at a time, merged into one result. */
function chunkedFred(l: ForecastLookup): ForecastLookup {
  return {
    name: l.name,
    lookup: async (query, cutoff, now, ctx) => {
      const ids = ctx?.hints?.fred ?? [];
      if (ids.length <= FRED_CHUNK) return l.lookup(query, cutoff, now, ctx);
      const parts: LookupResult[] = [];
      for (let i = 0; i < ids.length; i += FRED_CHUNK) {
        const hints = { ...ctx!.hints, fred: ids.slice(i, i + FRED_CHUNK) };
        parts.push(await l.lookup(query, cutoff, now, { ...ctx, hints }));
      }
      const ok = parts.filter((p) => !p.skipped || p.readings?.length);
      if (ok.length === 0) return parts[0]!;
      return {
        ...ok[0]!,
        lines: ok.flatMap((p) => p.lines),
        sources: ok.flatMap((p) => p.sources),
        readings: ok.flatMap((p) => p.readings ?? []),
      };
    },
  };
}

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

/**
 * Task-matched explanatory changes; opt-in so historical controls keep their
 * inputs. `consumer` adds GASREGW and ICSA to Civiqs economic rounds; `all`
 * adds every mapped signal for the round's family (`ARENA_SIGNAL_MAP`:
 * FRED series, a market phrase and other pollsters' polls), after the
 * default related series.
 */
export function arenaSignalHints(env: NodeJS.ProcessEnv) {
  const set = arenaSignalSet(env);
  return (brief: ResearchBrief): ReturnType<typeof arenaLookupHints> => {
    const base = arenaLookupHints(brief);
    if (set === "all") {
      const entry = arenaSignalEntry(brief.roundId);
      if (!entry) return base;
      const fred = [...new Set([...(base.hints.fred ?? []), ...(entry.hints.fred ?? [])])];
      return {
        hints: { ...base.hints, ...entry.hints, ...(fred.length ? { fred } : {}) },
        related: entry.why,
      };
    }
    if (
      set !== "consumer" ||
      !/^civiqs-.*-(econ-(now|direction)|family-finances|inflation-concern)$/.test(brief.roundId)
    )
      return base;
    return {
      hints: { fred: [...new Set([...(base.hints.fred ?? []), "GASREGW", "ICSA"])].slice(0, 3) },
      related:
        "consumer sentiment, retail gasoline prices and initial unemployment claims; different populations and units, changes only",
    };
  };
}

/**
 * A reading observed before the target period (`YYYY-MM-01`) is stale for it:
 * a monthly related series that has not yet published the month being
 * forecast. Undefined when fresh or when the brief names no target period.
 */
export function staleFor(observed: string, targetPeriod: string | undefined): string | undefined {
  if (!targetPeriod || !/^\d{4}-\d{2}-\d{2}/.test(observed) || observed >= targetPeriod)
    return undefined;
  return `STALE: ends ${observed.slice(0, 7)}, target period ${targetPeriod.slice(0, 7)}`;
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
  const wrapped: Retriever = async (brief: ResearchBrief): Promise<ResearchReport> => {
    const report = await inner(brief);
    const now = (opts.now ?? (() => new Date()))();
    const { hints, related } = (opts.hints ?? arenaLookupHints)(brief);
    // A family's market phrase (`all`) is the search; otherwise the brief's queries.
    const query =
      opts.query?.(brief) ??
      hints.markets ??
      brief.queries?.slice(0, 2).join(" ") ??
      brief.request.slice(0, 200);
    const lines: string[] = [];
    const staleSeries: string[] = [];
    let evidence: LookupResult[] = [];
    const sources: ResearchReport["sources"] = [];
    const warnings = [...(report.warnings ?? [])];
    try {
      const seriesNamed = !!(hints.fred?.length || hints.bls?.length);
      const usable = lookups
        .filter((l) => seriesNamed || (l.name !== "fred" && l.name !== "bls"))
        .filter((l) => l.name !== "votehub" || !!hints.polls)
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
                    return chunkedFred(l).lookup(query, at, now, ctx);
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
            const stale = staleFor(reading.date, brief.targetPeriod);
            if (stale) staleSeries.push(`${reading.series} (ends ${reading.date.slice(0, 7)})`);
            lines.push(
              `- observed ${reading.date} — FRED ${reading.series}: ${reading.value}${reading.unit ? ` ${reading.unit}` : ""}; ${change}; ${update}; vintage as of ${reading.asOf.slice(0, 10)}${stale ? `; ${stale}` : ""} [FRED](${url})`,
            );
            sources.push({
              url,
              title: `FRED ${reading.series}`,
              text: payload,
              observedAt: reading.date,
              availableAt: reading.asOf,
              origin: `https://fred.stlouisfed.org/series/${encodeURIComponent(reading.series)}`,
              measurements: [
                {
                  source: "FRED",
                  measure: reading.series,
                  value: reading.value,
                  unit: reading.unit,
                  url,
                  origin: `https://fred.stlouisfed.org/series/${encodeURIComponent(reading.series)}`,
                  quote: JSON.stringify(reading),
                  observedFrom: reading.date,
                  availableAt: reading.asOf,
                  relation: "explanatory",
                },
              ],
            });
          }
          continue;
        }
        // Market prices and polls: each line frozen under its own payload URL.
        for (const raw of r.lines) {
          const frozen = freezeLookupLine(r.name, raw, r.asOf);
          lines.push(frozen.line);
          if (frozen.source) sources.push(frozen.source);
        }
      }
    } catch (error) {
      warnings.push(`Structured data failed: ${getErrorMessage(error).slice(0, 160)}`);
    }
    warnings.push(...evidence.filter((r) => r.skipped).map((r) => `${r.name}: ${r.skipped}`));
    if (lines.length === 0) return { ...report, data: evidence, warnings };
    const head = `STRUCTURED DATA (as of the cutoff; evidence of CHANGES only — the round's own history sets the level${related ? `; related series: ${related}` : ""}):${
      staleSeries.length
        ? `\nSTALE for the target period ${brief.targetPeriod!.slice(0, 7)}: ${staleSeries.join(", ")} — published only through an EARLIER period; their latest change is old news, not evidence about the period being forecast.`
        : ""
    }`;
    return {
      ...report,
      data: evidence,
      warnings,
      report: `${report.report}\n\n${head}\n${lines.join("\n")}`,
      sources: [
        ...report.sources,
        ...sources.filter((s) => !report.sources.some((x) => x.url === s.url)),
      ],
    };
  };
  return isDateStrict(inner) ? Object.assign(wrapped, { dateStrict: true as const }) : wrapped;
}

/**
 * `MARINA_ARENA_RESEARCH_LOOKUPS` (default off; `polymarket,kalshi,fred,votehub`
 * when unset under `MARINA_ARENA_RESEARCH_SIGNALS=all`): the lookups arena
 * research may add. The general spec, plus `votehub` (other pollsters' polls),
 * which `auto` and `all` include; it runs only for a round that names a poll
 * quantity.
 */
export function arenaResearchLookups(env: NodeJS.ProcessEnv = process.env): ForecastLookup[] {
  const spec = arenaLookupSpec(env).trim();
  if (!spec || spec.toLowerCase() === "off" || spec.toLowerCase() === "none") return [];
  const items = spec
    .toLowerCase()
    .split(",")
    .map((s) => s.trim());
  const polls = items.some((s) => s === "votehub" || s === "polls" || s === "auto" || s === "all");
  // Odds have no arena family; everything else follows the general spec.
  const general = lookupsFromSpec(spec, env).filter((l) => (l.name as LookupName) !== "odds");
  return polls ? [...general, voteHubLookup()] : general;
}
