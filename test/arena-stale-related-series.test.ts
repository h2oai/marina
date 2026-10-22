import { describe, expect, it } from "bun:test";
import { buildResearchBrief, monthlyTargetPeriod } from "../src/arena/research/briefs";
import { staleFor, withDataLookups } from "../src/arena/research/data-evidence";
import type { ArenaLock, ArenaRound } from "../src/arena/types";
import type { ForecastLookup } from "../src/forecast/lookup-types";
import type { ResearchReport } from "../src/research/retrieve";

const monthly = (months: string[]) =>
  months.map((m, i) => ({ date: `${m}-01`, value: 3 + i / 10 }));

describe("target period of a monthly round", () => {
  it("is the month after the last published value", () => {
    expect(monthlyTargetPeriod(monthly(["2026-06", "2026-07", "2026-08"]))).toBe("2026-09-01");
    expect(monthlyTargetPeriod(monthly(["2026-11", "2026-12"]))).toBe("2027-01-01");
  });

  it("is undefined for weekly, daily or gapped histories", () => {
    expect(monthlyTargetPeriod([{ date: "2026-09-18" }, { date: "2026-09-25" }])).toBeUndefined();
    expect(monthlyTargetPeriod(monthly(["2026-05", "2026-07"]))).toBeUndefined();
    expect(monthlyTargetPeriod(monthly(["2026-08"]))).toBeUndefined();
  });

  it("rides on the research brief of a monthly round", () => {
    const round = {
      round_id: "sce-2026-09-infl1y",
      tracker: "ny_fed_sce",
      series: "sce_inflation_1y",
      question: "NY Fed SCE median one-year-ahead expected inflation, September 2026",
      unit: "percent",
      release_at: "2026-10-07T15:00:00Z",
      lock_at: "2026-10-05T15:00:00Z",
      target_type: "continuous_normal",
    } as unknown as ArenaRound;
    const lock = { history: monthly(["2026-06", "2026-07", "2026-08"]) } as unknown as ArenaLock;
    const brief = buildResearchBrief(round, lock, { now: Date.parse("2026-10-05T08:00:00Z") });
    expect(brief.targetPeriod).toBe("2026-09-01");
  });
});

describe("stale related series", () => {
  it("flags an observation older than the target period, never a fresh one", () => {
    expect(staleFor("2026-08-01", "2026-09-01")).toBe("STALE: ends 2026-08, target period 2026-09");
    expect(staleFor("2026-09-01", "2026-09-01")).toBeUndefined();
    expect(staleFor("2026-09-29", "2026-09-01")).toBeUndefined(); // a weekly reading inside the period
    expect(staleFor("2026-08-01", undefined)).toBeUndefined();
  });

  it("labels the stale series in the dossier, with observation and vintage dates", async () => {
    const now = new Date("2026-10-05T08:00:00Z");
    const fred: ForecastLookup = {
      name: "fred",
      async lookup(_q, cutoff, _now, ctx) {
        return {
          name: "fred",
          lines: [],
          sources: [],
          readings: (ctx?.hints?.fred ?? []).map((series) => ({
            source: "FRED",
            series,
            date: series === "MICH" ? "2026-08-01" : "2026-09-01",
            value: series === "MICH" ? 4 : 2.64,
            asOf: cutoff.toISOString().slice(0, 10),
            history: [
              { date: series === "MICH" ? "2026-07-01" : "2026-08-01", value: 4.2 },
              { date: series === "MICH" ? "2026-08-01" : "2026-09-01", value: 4 },
            ],
          })),
        };
      },
    };
    const base: ResearchReport = { report: "research", sources: [] } as unknown as ResearchReport;
    const retriever = withDataLookups(async () => base, [fred], {
      now: () => now,
      hints: () => ({ hints: { fred: ["MICH", "EXPINF1YR"] }, related: "test" }),
    });
    const out = await retriever({
      roundId: "sce-2026-09-infl1y",
      since: "2026-08-01",
      targetPeriod: "2026-09-01",
      request: "r",
      untilAt: "2026-10-05T15:00:00Z",
      until: "2026-10-05",
    });
    expect(out.report).toContain("STALE for the target period 2026-09: MICH (ends 2026-08)");
    expect(out.report).toContain("observed 2026-08-01 — FRED MICH: 4");
    expect(out.report).toContain("STALE: ends 2026-08, target period 2026-09");
    expect(out.report).toContain("vintage as of 2026-10-0");
    const expinf = out.report.split("\n").find((l) => l.includes("FRED EXPINF1YR"));
    expect(expinf).toBeDefined();
    expect(expinf).not.toContain("STALE");
  });
});
