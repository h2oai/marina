// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { ResearchBrief } from "../src/arena/research/briefs";
import type { Retriever } from "../src/arena/research/retrieve";
import type { AnswerSpec } from "../src/forecast/answer-types";
import { type FormedAnswer, forecastFormed } from "../src/forecast/formations";
import type { LookupFetch } from "../src/forecast/lookup-http";
import { triageSettingsFromEnv } from "../src/forecast/service";
import {
  type CalendarEvidence,
  dayMentions,
  deterministicFacts,
  extractFacts,
  factUser,
  parseModelFacts,
  periodIn,
  publicationStatus,
  statedReleaseDay,
  statedResolution,
  triageModeFromEnv,
  triageModelFromEnv,
  triageQuestion,
} from "../src/forecast/triage";
import { triageCalendar, triageCalendarEnabled } from "../src/forecast/triage-calendar";
import { READOFF_CONFIDENCE, type TriageSettings } from "../src/forecast/triage-route";
import type { ModelPart, TypedForecastAnswer, TypedForecastDeps } from "../src/forecast/typed";

const yesNo: AnswerSpec = {
  type: "choice",
  options: [
    { id: "Yes", label: "Yes" },
    { id: "No", label: "No" },
  ],
};
const num: AnswerSpec = { type: "number" };

describe("dates in the text", () => {
  it("reads days, periods, stated releases and stated resolutions", () => {
    expect(
      dayMentions("on 26 August 2026 and September 17, 2026 or 2026-09-15").map((d) => d.day),
    ).toEqual(["2026-08-26", "2026-09-17", "2026-09-15"]);
    expect(dayMentions("31 February 2026")).toEqual([]);
    expect(periodIn("CPI for August 2026")).toMatchObject({
      start: "2026-08-01",
      end: "2026-08-31",
      granularity: "month",
    });
    expect(periodIn("exports for Q2 2026")).toMatchObject({
      start: "2026-04-01",
      end: "2026-06-30",
    });
    expect(periodIn("second quarter of 2026")?.end).toBe("2026-06-30");
    expect(periodIn("fiscal Q3 2026 revenue")).toBeUndefined();
    expect(periodIn("stocks for the week ending 28 August 2026")).toMatchObject({
      start: "2026-08-22",
      end: "2026-08-28",
      granularity: "week",
    });
    expect(periodIn("outbreaks for surveillance week 35 of 2026")).toMatchObject({
      start: "2026-08-24",
      end: "2026-08-30",
    });
    expect(periodIn("the 18-20 September 2026 weekend")).toMatchObject({
      start: "2026-09-18",
      end: "2026-09-20",
      granularity: "range",
    });
    expect(
      statedReleaseDay("In Public Health Scotland's 25 August 2026 waiting-times release"),
    ).toBe("2026-08-25");
    expect(statedReleaseDay("the bulletin dated 18 September 2026")).toBe("2026-09-18");
    expect(statedReleaseDay("Will Arsenal win on 31 August 2026?")).toBeUndefined();
    expect(statedResolution("x (resolved around 2026-09-15T20:00:00+08:00 (GMT+8)).")).toBe(
      "2026-09-15T12:00:00.000Z",
    );
  });
});

describe("triageQuestion: the class is derived from facts and the clock", () => {
  const cpi = "What will the US CPI-U year-over-year inflation rate be for August 2026?";

  it("a statistic is an anchor before its release window and a lookup after it", () => {
    const before = triageQuestion({ question: cpi, answer: num, now: "2026-09-05T00:00:00Z" });
    expect(before.class).toBe("anchor");
    expect(before.published).toMatchObject({ status: "not-yet", basis: "typical-lag" });
    expect(before.method.card).toBe("triage:quant-anchor");
    expect(before.facts).toMatchObject({ publisher: "BLS", domain: "bls.gov", fred: ["CPIAUCSL"] });
    const inside = triageQuestion({ question: cpi, answer: num, now: "2026-09-12T00:00:00Z" });
    expect(inside.published.status).toBe("unknown");
    expect(inside.class).toBe("anchor");
    const after = triageQuestion({ question: cpi, answer: num, now: "2026-10-05T00:00:00Z" });
    expect(after.class).toBe("lookup");
    expect(after.method).toMatchObject({ card: "triage:readoff", fallback: "formation:ensemble" });
    expect(after.budget).toMatchObject({ runs: 1, researchRounds: 1, stopEarly: true });
  });

  it("a stated release date decides, and its own day is not yet published", () => {
    const q =
      "In Public Health Scotland's 25 August 2026 diagnostic-waiting-times release, how many ongoing waits will be reported?";
    expect(triageQuestion({ question: q, answer: num, now: "2026-08-24T00:00:00Z" }).class).toBe(
      "anchor",
    );
    // 25 Aug 18:00 UTC: the release day has not ended everywhere — not a lookup yet.
    expect(triageQuestion({ question: q, answer: num, now: "2026-08-25T18:00:00Z" }).class).toBe(
      "anchor",
    );
    const r = triageQuestion({ question: q, answer: num, now: "2026-08-27T00:00:00Z" });
    expect(r.class).toBe("lookup");
    expect(r.published.basis).toBe("stated");
  });

  it("a dated event is a forecast before it and a lookup once it is over", () => {
    const q = "Will Arsenal beat Aston Villa in the Premier League on 31 August 2026?";
    expect(triageQuestion({ question: q, answer: yesNo, now: "2026-08-30T00:00:00Z" }).class).toBe(
      "forecast",
    );
    const r = triageQuestion({ question: q, answer: yesNo, now: "2026-09-02T00:00:00Z" });
    expect(r.class).toBe("lookup");
    expect(r.published.basis).toBe("event");
  });

  it("a ranking is a list until it is published", () => {
    const q =
      "Which five films will rank first through fifth at the domestic box office for the 18-20 September 2026 weekend?";
    const r = triageQuestion({
      question: q,
      answer: { type: "ranking", size: 5 },
      now: "2026-09-15T00:00:00Z",
    });
    expect(r.class).toBe("list");
    expect(r.facts.list).toEqual({ size: 5, ordered: true });
    expect(r.method.card).toBe("triage:board");
    expect(
      triageQuestion({
        question: q,
        answer: { type: "ranking", size: 5 },
        now: "2026-09-25T00:00:00Z",
      }).class,
    ).toBe("lookup");
  });

  it("a stated resolution time that has passed makes it a lookup", () => {
    const q = "Who will win the race? (resolved around 2026-09-07T06:00:00+08:00 (GMT+8)).";
    expect(triageQuestion({ question: q, now: "2026-09-01T00:00:00Z" }).class).toBe("forecast");
    expect(triageQuestion({ question: q, now: "2026-09-08T00:00:00Z" }).published.basis).toBe(
      "resolution",
    );
    expect(
      triageQuestion({
        question: "Who wins?",
        resolvesAt: "2026-09-01T00:00:00Z",
        now: "2026-09-02T00:00:00Z",
      }).class,
    ).toBe("lookup");
  });

  it("numeric ranges and thresholds on a statistic are anchors; an open question is a forecast", () => {
    const ranges: AnswerSpec = {
      type: "choice",
      options: [
        { id: "A", label: "Below 3%" },
        { id: "B", label: "3% to 3.4%" },
        { id: "C", label: "3.5% or higher" },
      ],
    };
    expect(
      triageQuestion({
        question: "UK CPI 12-month inflation rate for August 2026?",
        answer: ranges,
        now: "2026-09-01T00:00:00Z",
      }).class,
    ).toBe("anchor");
    expect(
      triageQuestion({
        question:
          "Will Malaysia's Industrial Production Index grow at least 5.0% year on year in July 2026?",
        answer: yesNo,
        now: "2026-08-20T00:00:00Z",
      }).class,
    ).toBe("anchor");
    expect(
      triageQuestion({
        question: "Will the treaty be signed?",
        answer: yesNo,
        now: "2026-08-20T00:00:00Z",
      }).class,
    ).toBe("forecast");
  });

  it("is pure: the same input gives the same result", () => {
    const input = { question: cpi, answer: num, now: "2026-09-05T00:00:00Z" };
    expect(JSON.stringify(triageQuestion(input))).toBe(JSON.stringify(triageQuestion(input)));
  });
});

describe("leak safety: nothing after NOW (the cutoff) is used", () => {
  const cpi = "What will the US CPI-U inflation rate be for August 2026?";
  const now = "2026-09-05T00:00:00Z";

  it("a figure published after the cutoff is never a lookup, even before the question closes", () => {
    const r = triageQuestion({
      question: cpi,
      answer: num,
      endTime: "2026-09-30T00:00:00Z",
      now,
    });
    expect(r.class).not.toBe("lookup");
  });

  it("calendar evidence dated after now is ignored", () => {
    const late: CalendarEvidence = {
      published: { at: "2026-09-11T12:30:00Z", basis: "series", source: "FRED CPIAUCSL" },
      notes: [],
    };
    expect(triageQuestion({ question: cpi, answer: num, now }, { calendar: late }).class).toBe(
      "anchor",
    );
    const early: CalendarEvidence = {
      published: { at: "2026-09-04T00:00:00Z", basis: "series", source: "FRED CPIAUCSL" },
      notes: [],
    };
    expect(triageQuestion({ question: cpi, answer: num, now }, { calendar: early }).class).toBe(
      "lookup",
    );
  });

  it("a model's expected publication after now does not make a lookup; the model never sets the class", () => {
    const facts = parseModelFacts({
      class: "lookup",
      published: true,
      expectedPublication: "2026-09-11",
      domain: "https://www.bls.gov/cpi/",
    });
    expect(facts).not.toHaveProperty("class");
    expect(facts).not.toHaveProperty("published");
    const r = triageQuestion({ question: "What will the index be?", answer: num, now }, { facts });
    expect(r.class).not.toBe("lookup");
    expect(r.facts.domain).toBe("bls.gov");
  });

  it("the fact model is told the cutoff as today, never the wall clock", async () => {
    const seen: string[] = [];
    const model: ModelPart = {
      name: "flash",
      complete: async (s, u) => {
        seen.push(`${s}\n${u}`);
        return '{"publisher":"BLS","expectedPublication":"2026-09-11","recurringSeries":true}';
      },
    };
    const input = { question: cpi, answer: num, now: "2024-03-01T00:00:00Z" };
    const rec = await extractFacts(model, input);
    expect(rec.facts?.expectedPublication).toBe("2026-09-11");
    expect(seen[0]).toContain("Today: 2024-03-01");
    expect(seen[0]).not.toContain(new Date().toISOString().slice(0, 10));
    expect(factUser(input)).not.toContain("Answer:");
    const bad = await extractFacts(
      {
        name: "x",
        complete: async () => {
          throw new Error("down");
        },
      },
      input,
    );
    expect(bad.error).toContain("down");
  });

  it("the series probe reads FRED as of the day BEFORE now, and a past now reads no calendar", async () => {
    const urls: string[] = [];
    const http: LookupFetch = {
      async json<T>(url: string) {
        urls.push(url);
        if (url.includes("/series/observations"))
          return {
            ok: true,
            value: {
              observations: [
                { date: "2026-07-01", value: "320.1" },
                { date: "2026-08-01", value: "321.0" },
              ],
            } as T,
          };
        return { ok: true, value: { seriess: [{ title: "CPI" }] } as T };
      },
      async text() {
        return { ok: false, error: "no" };
      },
    };
    const facts = deterministicFacts({ question: cpi, answer: num });
    const past = await triageCalendar(facts, new Date("2026-09-12T08:00:00Z"), {
      fredApiKey: "k",
      http,
      clock: () => new Date("2026-10-20T00:00:00Z"),
    });
    const obs = urls.find((u) => u.includes("/series/observations"))!;
    expect(new URL(obs).searchParams.get("realtime_start")).toBe("2026-09-11");
    expect(past.published).toMatchObject({ basis: "series" });
    expect(Date.parse(past.published!.at)).toBeLessThan(Date.parse("2026-09-12T08:00:00Z"));
    expect(urls.some((u) => u.includes("release/dates"))).toBe(false);
    // Without a key a past now is never probed (keyless FRED only knows today's revision).
    urls.length = 0;
    const keyless = await triageCalendar(facts, new Date("2026-09-12T08:00:00Z"), {
      http,
      clock: () => new Date("2026-10-20T00:00:00Z"),
    });
    expect(keyless.published).toBeUndefined();
    expect(urls).toEqual([]);
  });

  it("the probe's observations before the period do not publish it; a live now reads the next release", async () => {
    const http: LookupFetch = {
      async json<T>(url: string) {
        if (url.includes("/series/observations"))
          return {
            ok: true,
            value: { observations: [{ date: "2026-07-01", value: "320.1" }] } as T,
          };
        if (url.includes("/series/release"))
          return { ok: true, value: { releases: [{ id: 10 }] } as T };
        if (url.includes("/release/dates"))
          return {
            ok: true,
            value: { release_dates: [{ date: "2026-08-12" }, { date: "2026-09-11" }] } as T,
          };
        return { ok: true, value: {} as T };
      },
      async text() {
        return { ok: false, error: "no" };
      },
    };
    const facts = deterministicFacts({ question: cpi, answer: num });
    const now = new Date("2026-09-05T00:00:00Z");
    const ev = await triageCalendar(facts, now, { fredApiKey: "k", http, clock: () => now });
    expect(ev.published).toBeUndefined();
    expect(ev.next?.at).toBe("2026-09-11");
    const r = triageQuestion(
      { question: cpi, answer: num, now: now.toISOString() },
      { calendar: ev },
    );
    expect(r.published).toMatchObject({ status: "not-yet", basis: "calendar" });
    expect(triageCalendarEnabled({})).toBe(true);
    expect(triageCalendarEnabled({ MARINA_FORECAST_TRIAGE_CALENDAR: "off" })).toBe(false);
  });

  it("publicationStatus never reads the wall clock", () => {
    const facts = deterministicFacts({ question: cpi, answer: num });
    const s1 = publicationStatus({ question: cpi, now: "2026-09-05T00:00:00Z" }, facts);
    const s2 = publicationStatus({ question: cpi, now: "2026-09-05T00:00:00Z" }, facts);
    expect(s1).toEqual(s2);
    expect(s1.status).toBe("not-yet");
  });
});

describe("knobs", () => {
  it("modes, model and settings from the environment", () => {
    expect(triageModeFromEnv({})).toBe("off");
    expect(triageModeFromEnv({ MARINA_FORECAST_TRIAGE: " Observe " })).toBe("observe");
    expect(triageModeFromEnv({ MARINA_FORECAST_TRIAGE: "yes" })).toBe("off");
    expect(triageModelFromEnv({})).toBe("openrouter/deepseek/deepseek-v4.1-flash");
    expect(triageModelFromEnv({ MARINA_FORECAST_TRIAGE_MODEL: "none" })).toBeUndefined();
    expect(triageSettingsFromEnv({})).toBeUndefined();
    expect(triageSettingsFromEnv({ MARINA_FORECAST_TRIAGE: "off" })).toBeUndefined();
    const det = triageSettingsFromEnv({
      MARINA_FORECAST_TRIAGE: "on",
      MARINA_FORECAST_TRIAGE_MODEL: "none",
      MARINA_FORECAST_TRIAGE_CALENDAR: "off",
    })!;
    expect(det).toEqual({ mode: "on" });
    // A fact model that cannot be built leaves triage deterministic, with the reason recorded.
    const noKey = triageSettingsFromEnv({
      MARINA_FORECAST_TRIAGE: "observe",
      MARINA_FORECAST_TRIAGE_MODEL: "openrouter/deepseek/deepseek-v4.1-flash",
    })!;
    expect(noKey.model).toBeUndefined();
    expect(noKey.modelError).toContain("deepseek");
    expect(typeof noKey.calendar).toBe("function");
  });
});

// ─── The typed pipeline ─────────────────────────────────────────────────────

interface Run {
  prompts: string[];
  briefs: ResearchBrief[];
  answer: FormedAnswer;
}

const CPI_Q = "What was the US CPI-U 12-month inflation rate for August 2026?";

async function forecast(opts: {
  triage?: TriageSettings;
  now: string;
  readoff?: string;
  report?: { text: string; sources: Array<{ url: string; published?: string }> };
  question?: string;
  answer?: AnswerSpec;
  asOf?: string;
}): Promise<Run> {
  const prompts: string[] = [];
  const briefs: ResearchBrief[] = [];
  const part = (name: string): ModelPart => ({
    name,
    complete: async (s, u) => {
      prompts.push(`${name}\n${s}\n${u}`);
      if (s.startsWith("You plan research"))
        return JSON.stringify({ restatement: "CPI", queries: ["us cpi august 2026"] });
      if (s.startsWith("You review a research dossier")) return JSON.stringify({ done: true });
      if (s.startsWith("You read ONE published value")) return opts.readoff ?? '{"found": false}';
      if (/critic|disconfirm/i.test(s)) return JSON.stringify({ verdict: "keep", confidence: 0.5 });
      return JSON.stringify({ answer: 3.1, sd: 0.2, confidence: 0.6, reason: "trend" });
    },
  });
  const report = opts.report ?? {
    text: "- 2026-09-11 — BLS: the all items index rose 2.9 percent for the 12 months ending August ([BLS](https://www.bls.gov/news.release/cpi.nr0.htm))",
    sources: [{ url: "https://www.bls.gov/news.release/cpi.nr0.htm", published: "2026-09-11" }],
  };
  const retriever: Retriever = async (brief) => {
    briefs.push(brief);
    return {
      report: report.text,
      sources: report.sources,
      costUsd: 0.001,
      searches: 1,
      retriever: "fake",
    };
  };
  const deps: TypedForecastDeps = {
    retriever,
    analysts: [part("m1")],
    planner: part("planner"),
    now: () => new Date(opts.now),
    options: { runs: 2, researchRounds: 1, followUp: false, critique: false },
    ...(opts.triage ? { triage: opts.triage } : {}),
  };
  const answer = await forecastFormed(
    {
      question: opts.question ?? CPI_Q,
      answer: opts.answer ?? num,
      endTime: "2026-12-31T00:00:00Z",
      ...(opts.asOf ? { asOf: opts.asOf } : {}),
    },
    deps,
  );
  return { prompts, briefs, answer };
}

const stable = (a: TypedForecastAnswer) => {
  const { latencyMs: _l, triage: _t, ...rest } = a;
  return JSON.stringify(rest);
};

describe("forecastFormed with MARINA_FORECAST_TRIAGE", () => {
  const live = "2026-10-05T00:00:00Z";

  it("off (no triage in the deps) is byte-identical: same prompts, same briefs, same answer", async () => {
    const none = await forecast({ now: live });
    const again = await forecast({ now: live });
    expect(again.prompts).toEqual(none.prompts);
    expect(JSON.stringify(again.briefs)).toBe(JSON.stringify(none.briefs));
    expect(stable(again.answer)).toBe(stable(none.answer));
    expect(none.answer.triage).toBeUndefined();
    expect("triage" in none.answer).toBe(false);
    expect(none.prompts.join("\n")).not.toContain("intake triage");
  });

  it("observe records the class and method and changes nothing a model sees or the answer", async () => {
    const off = await forecast({ now: live });
    const obs = await forecast({ now: live, triage: { mode: "observe" } });
    expect(obs.prompts).toEqual(off.prompts);
    expect(JSON.stringify(obs.briefs)).toBe(JSON.stringify(off.briefs));
    expect(stable(obs.answer)).toBe(stable(off.answer));
    const t = obs.answer.triage!;
    expect(t.mode).toBe("observe");
    expect(t.class).toBe("lookup");
    expect(t.applied).toBe(false);
    expect(t.method.card).toBe("triage:readoff");
    expect(t.readoff).toBeUndefined();
  });

  it("on: a lookup is read off the authority and the panel never runs", async () => {
    const run = await forecast({
      now: live,
      triage: { mode: "on" },
      readoff: JSON.stringify({
        found: true,
        answer: 2.9,
        quote: "the all items index rose 2.9 percent for the 12 months ending August",
        url: "https://www.bls.gov/news.release/cpi.nr0.htm",
        asOf: "2026-09-11",
      }),
    });
    expect(run.answer.prediction).toBe(2.9);
    expect(run.answer.confidence).toBe(READOFF_CONFIDENCE);
    expect(run.answer.triage).toMatchObject({ class: "lookup", applied: true });
    expect(run.answer.triage?.readoff).toMatchObject({
      answered: true,
      authority: { domain: "bls.gov" },
    });
    expect(run.answer.formation.fallback).toContain("read-off");
    // One brief, in authority mode; no planning, no runs.
    expect(run.briefs).toHaveLength(1);
    expect(run.briefs[0]!.authority?.[0]?.domain).toBe("bls.gov");
    expect(run.prompts.some((p) => p.includes("You plan research"))).toBe(false);
    expect(run.prompts.filter((p) => p.startsWith("m1"))).toHaveLength(0);
  });

  it("on: a read-off that cannot find the field falls back to the full panel", async () => {
    const run = await forecast({ now: live, triage: { mode: "on" } });
    expect(run.answer.triage?.readoff).toMatchObject({ answered: false });
    expect(run.answer.triage?.readoff?.failure).toContain("not found");
    expect(run.answer.triage?.applied).toBe(false);
    expect(run.answer.prediction).toBe(3.1);
    expect(run.prompts.some((p) => p.includes("You plan research"))).toBe(true);
  });

  it("on: a read-off whose value is not in its quote, or whose quote is invented, is refused", async () => {
    const wrongValue = await forecast({
      now: live,
      triage: { mode: "on" },
      readoff: JSON.stringify({
        found: true,
        answer: 3.4,
        quote: "the all items index rose 2.9 percent for the 12 months ending August",
      }),
    });
    expect(wrongValue.answer.triage?.readoff?.failure).toContain("value not stated");
    expect(wrongValue.answer.prediction).toBe(3.1);
    const invented = await forecast({
      now: live,
      triage: { mode: "on" },
      readoff: JSON.stringify({ found: true, answer: 2.9, quote: "CPI was 2.9 percent in August" }),
    });
    expect(invented.answer.triage?.readoff?.failure).toContain("quote not in the evidence");
  });

  it("a backtest cutoff: the read-off brief is bounded to it, never reads the authority page directly, and drops later sources", async () => {
    const urlModel: ModelPart = {
      name: "flash",
      complete: async () =>
        '{"domain":"bls.gov","url":"https://www.bls.gov/cpi/","field":"CPI-U 12-month change"}',
    };
    const report = {
      text: [
        "- 2026-09-11 — BLS: index rose 2.9 percent ([BLS](https://www.bls.gov/a))",
        "- 2026-10-15 — revised: index rose 3.0 percent ([later](https://example.org/later))",
      ].join("\n"),
      sources: [
        { url: "https://www.bls.gov/a", published: "2026-09-11" },
        { url: "https://example.org/later", published: "2026-10-15" },
      ],
    };
    const run = await forecast({
      now: "2026-10-20T00:00:00Z",
      asOf: "2026-10-01T00:00:00Z",
      triage: { mode: "on", model: urlModel },
      report,
      readoff: JSON.stringify({ found: true, answer: 3.0, quote: "index rose 3.0 percent" }),
    });
    const brief = run.briefs[0]!;
    expect(brief.until).toBe("2026-10-01");
    expect(brief.untilAt).toBe("2026-10-01T00:00:00.000Z");
    expect(brief.authority?.[0]).toMatchObject({
      domain: "bls.gov",
      url: "https://www.bls.gov/cpi/",
    });
    expect(brief.readFirst ?? []).not.toContain("https://www.bls.gov/cpi/");
    // The later source's line never reaches the read-off model, so its value is refused.
    const readPrompt = run.prompts.find((p) => p.includes("You read ONE published value"))!;
    expect(readPrompt).not.toContain("3.0 percent");
    expect(run.answer.triage?.readoff?.answered).toBe(false);
    // A live cutoff may read the authority page first.
    const liveRun = await forecast({
      now: "2026-10-05T00:00:00Z",
      triage: { mode: "on", model: urlModel },
      report,
    });
    expect(liveRun.briefs[0]!.readFirst).toContain("https://www.bls.gov/cpi/");
  });

  it("on: an anchor turns the quant stage on and tells the panel the method", async () => {
    const run = await forecast({ now: "2026-09-05T00:00:00Z", triage: { mode: "on" } });
    expect(run.answer.triage).toMatchObject({ class: "anchor", applied: true });
    expect(run.answer.quant?.mode).toBe("on");
    expect(run.prompts.find((p) => p.startsWith("m1"))).toContain("intake triage: anchor");
  });

  it("on: a list gets the ranking method; a forecast runs unchanged", async () => {
    const list = await forecast({
      now: "2026-09-15T00:00:00Z",
      triage: { mode: "on" },
      question:
        "Which five films will rank first through fifth at the domestic box office for the 18-20 September 2026 weekend?",
      answer: { type: "ranking", size: 5 },
    });
    expect(list.answer.triage?.class).toBe("list");
    expect(list.prompts.find((p) => p.startsWith("planner"))).toContain(
      "rebuild the full current board",
    );
    const open = await forecast({
      now: "2026-09-15T00:00:00Z",
      triage: { mode: "on" },
      question: "Will the treaty be signed?",
      answer: yesNo,
    });
    const plain = await forecast({
      now: "2026-09-15T00:00:00Z",
      question: "Will the treaty be signed?",
      answer: yesNo,
    });
    expect(open.answer.triage).toMatchObject({ class: "forecast", applied: false });
    expect(open.prompts).toEqual(plain.prompts);
  });

  it("the fact model and calendar feed the record; a fact-model outage stays deterministic", async () => {
    const calls: string[] = [];
    const run = await forecast({
      now: "2026-09-05T00:00:00Z",
      triage: {
        mode: "observe",
        model: {
          name: "flash",
          complete: async () => {
            throw new Error("rate limited");
          },
        },
        calendar: async (facts) => {
          calls.push(facts.fred?.[0] ?? "");
          return { next: { at: "2026-09-11", source: "test" }, notes: [] };
        },
      },
    });
    expect(calls).toEqual(["CPIAUCSL"]);
    expect(run.answer.triage?.factModel?.error).toContain("rate limited");
    expect(run.answer.triage?.published).toMatchObject({ status: "not-yet", basis: "calendar" });
    expect(run.answer.triage?.facts.source).toBe("deterministic");
  });
});
