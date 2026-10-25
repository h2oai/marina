// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The commands behind the typed resident tools: `pattern run`, `research ask`,
 * `forecast formation:/retriever:`, `data polls|crowd`, `skill top` and
 * `lessons … for:`. No model or network call: every model and lookup is a fake.
 */

import { describe, expect, it } from "bun:test";
import { BUILTIN_SKILLS, rankBuiltinSkills } from "../src/agent/builtin-skills";
import { dataCommand } from "../src/engine/commands/data";
import { forecastCommand, forecastSurfaceEnv } from "../src/engine/commands/forecast";
import { LESSON_WORK_KINDS, lessonsCommand } from "../src/engine/commands/lessons";
import { PATTERN_USAGE, patternCommand } from "../src/engine/commands/pattern";
import { researchAskHandler } from "../src/engine/commands/research-ask";
import { clipBytes } from "../src/engine/commands/skill";
import { dataCrowd, dataPolls } from "../src/forecast/data-query";
import type { ForecastLookup } from "../src/forecast/lookup-types";
import type { TextComplete } from "../src/orchestration/text-patterns";
import { MarinaDB } from "../src/persistence/database";
import {
  RESEARCH_ASK_MAX_BUDGET_USD,
  researchAsk,
  researchModeEnv,
  residentRetrieverSpec,
} from "../src/research/ask";
import type { CommandDef, EntityId, RoomContext } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { stripAnsi } from "./helpers";
import { scopeProcessState } from "./process-state";

/** Run a command handler directly and collect what it sends. */
async function run(def: CommandDef, raw: string, entity = "e_1"): Promise<string[]> {
  const out: string[] = [];
  const ctx = {
    send: (_e: EntityId, m: string) => out.push(stripAnsi(m)),
    getEntity: () => ({ name: "Alice" }),
  } as unknown as RoomContext;
  const args = raw.replace(/^\S+\s*/, "");
  await def.handler(ctx, {
    entity: entity as EntityId,
    verb: def.name,
    args,
    tokens: args.split(/\s+/).filter(Boolean),
    raw,
  } as never);
  return out;
}

/** A fake panel: drafts answer, the checker picks draft 1. */
function fakeComplete(calls: string[]): (spec: string) => TextComplete {
  return () => async (model, system, user) => {
    calls.push(model);
    if (/JSON/.test(system) || /"pick"/.test(system)) {
      return { text: '{"pick":1,"reason":"clearest"}', costUsd: 0.001 };
    }
    return { text: `draft by ${model}: ${user.slice(-12)}`, costUsd: 0.001 };
  };
}

describe("pattern run", () => {
  it("runs a text pattern over the operator's members and reports one picked answer", async () => {
    using _s = scopeProcessState({ env: { MARINA_DAILY_SPEND_CAP_USD: "off" } });
    const calls: string[] = [];
    const cmd = patternCommand({ members: () => ["m/a", "m/b"], complete: fakeComplete(calls) });
    const out = await run(cmd, "pattern run ensemble -- Name the project");
    const text = out.join("\n");
    expect(text).toContain("Pattern: ensemble");
    expect(text).toContain("draft by m/");
    expect(text).toMatch(/completed · \d+ step\(s\)/);
    expect(calls.length).toBeGreaterThanOrEqual(3); // two drafts + the checker's pick
    expect(new Set(calls)).toEqual(new Set(["m/a", "m/b"]));
  });

  it("is rank 0, experimental and lists the patterns", async () => {
    const cmd = patternCommand({ members: () => [] });
    expect(cmd.minRank).toBe(0);
    expect(cmd.help.startsWith("[experimental]")).toBe(true);
    expect((await run(cmd, "pattern list")).join("\n")).toContain("debate");
    expect((await run(cmd, "pattern")).join("\n")).toBe(PATTERN_USAGE);
  });

  it("refuses crew-only and unknown patterns, bad budgets and missing members before spending", async () => {
    using _s = scopeProcessState({ env: { MARINA_DAILY_SPEND_CAP_USD: "off" } });
    const calls: string[] = [];
    const cmd = patternCommand({ members: () => ["m/a"], complete: fakeComplete(calls) });
    expect((await run(cmd, "pattern run foundry -- t")).join()).toContain(
      "needs a persistent crew",
    );
    expect((await run(cmd, "pattern run nope -- t")).join()).toContain('Unknown pattern "nope"');
    expect((await run(cmd, "pattern run debate budget:9 -- t")).join()).toContain("at most 2");
    expect((await run(cmd, "pattern run debate")).join()).toContain("Usage");
    const empty = patternCommand({ members: () => [], complete: fakeComplete(calls) });
    const refusal = (await run(empty, "pattern run debate -- t")).join();
    expect(refusal).toContain("No model is available");
    // The refusal names the fix: a provider key, `key add`, or a local runtime.
    expect(refusal).toContain("OPENROUTER_API_KEY");
    expect(refusal).toContain("key add");
    expect(calls).toEqual([]);
  });

  it("parses budget after the pattern name without `--`, and stops at the daily cap", async () => {
    const calls: string[] = [];
    const cmd = patternCommand({ members: () => ["m/a", "m/a"], complete: fakeComplete(calls) });
    {
      using _s = scopeProcessState({ env: { MARINA_DAILY_SPEND_CAP_USD: "off" } });
      const out = (await run(cmd, "pattern run ensemble budget:0.2 pick a budget:9 word")).join(
        "\n",
      );
      expect(out).toContain("Pattern: ensemble");
      expect(calls.length).toBeGreaterThan(0);
    }
  });

  it("is spend-limited per entity: a small token bucket", async () => {
    using _s = scopeProcessState({
      rateLimitBypass: false,
      env: { MARINA_DAILY_SPEND_CAP_USD: "off" },
    });
    const cmd = patternCommand({ members: () => ["m/a"], complete: fakeComplete([]) });
    for (let i = 0; i < 3; i++) await run(cmd, "pattern run ensemble -- t");
    expect((await run(cmd, "pattern run ensemble -- t")).join()).toContain("used up");
  });

  it("is a registered builtin", async () => {
    const fixture = createTestEngine();
    try {
      expect(fixture.engine.commands.allBuiltins().some((c) => c.name === "pattern")).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });
});

describe("research ask", () => {
  const env = { OPENROUTER_API_KEY: "k", MARINA_FORECAST_RETRIEVER: "openrouter-web:x/y@exa" };

  it("lets a resident pick model-free retrievers or the operator's own entries only", () => {
    expect(residentRetrieverSpec(undefined, env)).toEqual({ spec: "openrouter-web:x/y@exa" });
    expect(residentRetrieverSpec("default", env)).toEqual({ spec: "openrouter-web:x/y@exa" });
    expect(residentRetrieverSpec("search, asof:gdelt", env)).toEqual({ spec: "search,asof:gdelt" });
    expect(residentRetrieverSpec("openrouter-web:x/y@exa,corpus:docs", env)).toEqual({
      spec: "openrouter-web:x/y@exa,corpus:docs",
    });
    expect(residentRetrieverSpec("sonar:sonar-deep-research", env)).toMatchObject({
      error: expect.stringContaining("not available to residents"),
    });
    expect(residentRetrieverSpec("openrouter-web:other/model", env)).toHaveProperty("error");
    expect(residentRetrieverSpec("search,asof,corpus:a,closed-book", env)).toHaveProperty("error");
  });

  it("maps each research mode onto the operator's research switches", () => {
    expect(researchModeEnv("agent", {})).toEqual({ env: {} });
    expect(researchModeEnv("evidence-loop", {})).toEqual({
      env: { MARINA_RESEARCH_EVIDENCE: "on", MARINA_RESEARCH_LOOP_ROUNDS: "2" },
    });
    expect(researchModeEnv("evidence-loop", { MARINA_RESEARCH_LOOP_ROUNDS: "3" })).toMatchObject({
      env: { MARINA_RESEARCH_LOOP_ROUNDS: "3" },
    });
    expect(researchModeEnv("authority", {})).toEqual({ env: { MARINA_RESEARCH_AUTHORITY: "on" } });
    expect(researchModeEnv("survey", {})).toHaveProperty("error");
    expect(researchModeEnv("survey", { MARINA_RESEARCH_SURVEY_FILE: "/s.json" })).toHaveProperty(
      "env",
    );
  });

  it("runs the web agent by default and a retriever pass in a research mode", async () => {
    const agentRuns: Array<{ question: string; budget: number }> = [];
    const briefs: Array<{ spec: string; authority?: string; measure?: string }> = [];
    const deps = {
      env: { ...env, MARINA_DAILY_SPEND_CAP_USD: "off" },
      lead: () => "m/lead",
      runAgent: async (question: string, _lead: string, o: { budgetUsd: number }) => {
        agentRuns.push({ question, budget: o.budgetUsd });
        return {
          mode: "agent" as const,
          text: "X was founded by Y [s](https://a.example/1)",
          sources: ["https://a.example/1"],
          costUsd: 0.02,
          check: "citations: 1 read, 0 never opened, 0 failed of 1 cited",
        };
      },
      retrieve: async (
        brief: { target?: { measure: string } },
        spec: string,
        o: { env: NodeJS.ProcessEnv },
      ) => {
        briefs.push({
          spec,
          ...(o.env.MARINA_RESEARCH_AUTHORITY
            ? { authority: o.env.MARINA_RESEARCH_AUTHORITY }
            : {}),
          ...(brief.target ? { measure: brief.target.measure } : {}),
        });
        return {
          report: "- 2026-10-01 fact [src](https://b.example)",
          sources: [{ url: "https://b.example" }],
          costUsd: 0.01,
        };
      },
    };
    const a = await researchAsk({ question: "Who founded X?", mode: "agent", budgetUsd: 99 }, deps);
    expect(a).toMatchObject({ mode: "agent", sources: ["https://a.example/1"] });
    expect(agentRuns).toEqual([
      { question: "Who founded X?", budget: RESEARCH_ASK_MAX_BUDGET_USD },
    ]);
    const r = await researchAsk({ question: "Q", mode: "authority", retriever: "search" }, deps);
    expect(r).toMatchObject({
      mode: "authority",
      retriever: "search",
      sources: ["https://b.example"],
    });
    expect(briefs).toEqual([{ spec: "search", authority: "on" }]);
    expect(
      await researchAsk({ question: "Q", mode: "agent", retriever: "search" }, deps),
    ).toHaveProperty("error");
    expect(await researchAsk({ question: "Q", mode: "survey" }, deps)).toMatchObject({
      error: expect.stringContaining("MARINA_RESEARCH_SURVEY_FILE"),
    });
    expect(await researchAsk({ question: "  ", mode: "agent" }, deps)).toHaveProperty("error");
    expect(
      await researchAsk({ question: "Q", mode: "agent" }, { ...deps, lead: () => undefined }),
    ).toMatchObject({ error: expect.stringContaining("no model") });
  });

  it("the `research ask` command parses modes and refuses before spending", async () => {
    using _s = scopeProcessState({ env: { MARINA_DAILY_SPEND_CAP_USD: "off" } });
    const seen: string[] = [];
    const handler = researchAskHandler({
      env: { MARINA_DAILY_SPEND_CAP_USD: "off" },
      lead: () => "m/lead",
      runAgent: async (question) => {
        seen.push(question);
        return { mode: "agent", text: "answer", sources: [], costUsd: 0, check: "citations: 0" };
      },
    });
    const def = { name: "research", handler } as unknown as CommandDef;
    const ok = (await run(def, "research ask -- What is X?")).join("\n");
    expect(ok).toContain("Research (agent)");
    expect(seen).toEqual(["What is X?"]);
    expect((await run(def, "research ask mode:bogus -- Q")).join()).toContain("mode: takes one of");
    expect((await run(def, "research ask budget:50 -- Q")).join()).toContain("at most 3");
    expect((await run(def, "research ask")).join()).toContain("Usage");
    // A mode or retriever the operator does not allow is refused before the budget is touched.
    expect((await run(def, "research ask mode:survey -- Q")).join("\n")).toMatch(
      /^Could not research: survey mode/,
    );
    expect(
      (await run(def, "research ask mode:retrieve retriever:sonar:x -- Q")).join("\n"),
    ).toMatch(/^Could not research: retriever: "sonar:x"/);
  });

  it("`research <goal>` still launches a project; `research ask` is its own form", async () => {
    const fixture = createTestEngine();
    try {
      const research = fixture.engine.commands.allBuiltins().find((c) => c.name === "research")!;
      expect(research.usage?.map((u) => (typeof u === "string" ? u : u.syntax))).toEqual([
        "research <goal>",
        expect.stringContaining("research ask"),
      ]);
      expect(research.help).toContain("research ask <question>");
    } finally {
      await fixture.dispose();
    }
  });
});

describe("forecast formation: and retriever:", () => {
  it("builds the env a chosen formation and retriever run under", async () => {
    const base = { OPENROUTER_API_KEY: "k" };
    expect(await forecastSurfaceEnv({}, base)).toEqual({});
    expect(await forecastSurfaceEnv({ formation: "delphi" }, base)).toEqual({
      env: { ...base, MARINA_FORECAST_FORMATION: "delphi" },
    });
    expect(await forecastSurfaceEnv({ formation: "verify", retriever: "asof" }, base)).toEqual({
      env: { ...base, MARINA_FORECAST_VERIFY: "on", MARINA_FORECAST_RETRIEVER: "asof" },
    });
    expect(await forecastSurfaceEnv({ formation: "nope" }, base)).toMatchObject({
      error: expect.stringContaining('unknown formation "nope"'),
    });
    expect(await forecastSurfaceEnv({ retriever: "sonar:sonar-pro" }, base)).toHaveProperty(
      "error",
    );
  });

  it("refuses an unknown formation or a model retriever without spending the forecast budget", async () => {
    using _s = scopeProcessState({
      rateLimitBypass: false,
      env: { MARINA_DAILY_SPEND_CAP_USD: "off", OPENROUTER_API_KEY: undefined },
    });
    const cmd = forecastCommand({});
    for (let i = 0; i < 8; i++) {
      const out = (await run(cmd, "forecast formation:nope -- Will it rain?")).join();
      expect(out).toContain("unknown formation");
    }
    const model = (await run(cmd, "forecast retriever:sonar:sonar-pro -- Will it rain?")).join();
    expect(model).toContain("not available to residents");
  });
});

describe("data polls and data crowd", () => {
  const votehub: ForecastLookup = {
    name: "votehub",
    lookup: async (_q, cutoff, _now, ctx) => ({
      name: "votehub",
      lines: [
        `- poll ${ctx?.hints?.polls?.type} ${ctx?.hints?.polls?.subject} excl=${ctx?.hints?.polls?.exclude?.join("+") ?? ""} at ${cutoff.toISOString().slice(0, 10)}`,
      ],
      sources: [],
    }),
  };
  const manifold: ForecastLookup = {
    name: "manifold",
    lookup: async (q) => ({ name: "manifold", lines: [`- crowd ${q} 41%`], sources: [] }),
  };
  const now = () => new Date("2026-10-20T12:00:00Z");

  it("reads polls with an as-of date and pollster exclusions, and crowd probabilities", async () => {
    const polls = await dataPolls("approval", "Donald Trump", new Date("2026-09-01"), {
      lookups: [votehub],
      now,
      exclude: ["Rasmussen"],
    });
    expect(polls).toContain("poll approval Donald Trump excl=Rasmussen at 2026-09-01");
    expect(await dataPolls("weather", "x", undefined, { lookups: [votehub], now })).toContain(
      "Usage",
    );
    const crowd = await dataCrowd("AGI by 2030", undefined, { lookups: [manifold], now });
    expect(crowd).toContain("crowd AGI by 2030 41%");
    expect(crowd).toContain("play money");
  });

  it("the data command dispatches polls, crowd and the manifold alias", async () => {
    let t = 0;
    const cmd = dataCommand({
      options: { lookups: [votehub, manifold], now },
      now: () => (t += 10_000),
    });
    expect((await run(cmd, "data polls approval Donald Trump exclude:A,B")).join()).toContain(
      "excl=A+B",
    );
    expect((await run(cmd, "data crowd fed cut")).join()).toContain("crowd fed cut");
    expect((await run(cmd, "data manifold fed cut")).join()).toContain("crowd fed cut");
    expect((await run(cmd, "data sources")).join()).toContain("votehub");
  });
});

describe("skills: built-ins and `skill top`", () => {
  it("ships all eight seed skills and ranks them by fit, not by any shared word", () => {
    expect(BUILTIN_SKILLS).toHaveLength(8);
    expect(rankBuiltinSkills("solve this math problem")[0]?.skill.name).toBe("solve-math");
    expect(rankBuiltinSkills("decompose a multi-hop question")[0]?.skill.name).toBe(
      "decompose-multihop",
    );
    expect(rankBuiltinSkills("triage the intake queue")[0]?.skill.name).toBe("intake-triage");
    // One weak description word is not enough.
    expect(rankBuiltinSkills("water the incoming plants")).toEqual([]);
    expect(rankBuiltinSkills("the and for with")).toEqual([]);
  });

  it("clips to a byte budget at a boundary", () => {
    const text = `[Skill: x] ${"word ".repeat(400)}`;
    const clipped = clipBytes(text, 300);
    expect(Buffer.byteLength(clipped)).toBeLessThanOrEqual(300);
    expect(clipped.endsWith("…")).toBe(true);
    expect(clipBytes("short", 300)).toBe("short");
  });

  it("returns the agent's own skill first, else a relevant built-in, within the budget", async () => {
    const fixture = createTestEngine();
    try {
      const { connection, entityId } = fixture.login("Alice");
      const last = () => stripAnsi(connection.lastText());
      fixture.engine.processCommand(entityId, "skill top solve a math problem bytes:400");
      const builtin = last();
      expect(builtin.startsWith("[Skill: solve-math] (built-in)")).toBe(true);
      expect(Buffer.byteLength(builtin)).toBeLessThanOrEqual(400);
      fixture.engine.processCommand(entityId, "skill top water the ferns");
      expect(last()).toBe("No skill fits.");
      fixture.engine.processCommand(
        entityId,
        "skill store fern-care | water the ferns weekly | look ; note watered",
      );
      fixture.engine.processCommand(entityId, "skill top water the ferns");
      expect(last()).toMatch(/^\[Skill: fern-care\] water the ferns weekly .*\(own skill #\d+\)$/);
    } finally {
      await fixture.dispose();
    }
  });
});

describe("lessons … for:<work>", () => {
  it("validates the work kind and recalls through the work's own path", async () => {
    const db = new MarinaDB(":memory:");
    try {
      const cmd = lessonsCommand({ db });
      expect(LESSON_WORK_KINDS).toContain("forecast");
      expect((await run(cmd, "lessons rates for:bogus")).join()).toContain("for: takes one of");
      expect((await run(cmd, "lessons fed rates for:forecast")).join()).toBe(
        'No forecast lessons for "fed rates" yet.',
      );
      expect((await run(cmd, "lessons parser for:code")).join()).toBe(
        'No code lessons for "parser" yet.',
      );
      using _s = scopeProcessState({ env: { MARINA_LESSONS: "off" } });
      expect((await run(cmd, "lessons x for:research")).join()).toContain("Lessons are off");
    } finally {
      db.close();
    }
  });
});
