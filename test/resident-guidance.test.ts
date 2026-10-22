// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * What a resident's continuation prompt is offered about its own work: the
 * best skill (`[Skill]`, `skill top`) and lessons filtered to the kind of work
 * (`[Lessons]`, `lessons … for:<work>`), both budgeted, both with knobs.
 */

import { describe, expect, it } from "bun:test";
import { LeanAgentAdapter } from "../src/agent/lean-agent-adapter";
import {
  clampBytes,
  RESIDENT_LESSON_BYTES,
  RESIDENT_SKILL_BYTES,
  residentLessonsDomainEnabled,
  residentLessonWork,
  residentSkillsMode,
  skillName,
  skillSection,
} from "../src/agent/resident-guidance";
import { scopeProcessState } from "./process-state";

describe("resident guidance knobs and rules", () => {
  it("skills default on; observe and off are honoured", () => {
    expect(residentSkillsMode({})).toBe("on");
    expect(residentSkillsMode({ MARINA_SKILLS_RESIDENT: "observe" })).toBe("observe");
    expect(residentSkillsMode({ MARINA_SKILLS_RESIDENT: "off" })).toBe("off");
    expect(residentLessonsDomainEnabled({})).toBe(true);
    expect(residentLessonsDomainEnabled({ MARINA_LESSONS_RESIDENT_DOMAIN: "off" })).toBe(false);
  });

  it("reads the kind of work from the focus and recent tools", () => {
    expect(residentLessonWork("Forecast the October CPI print")).toBe("forecast");
    expect(residentLessonWork("What is the probability the Fed cuts?")).toBe("forecast");
    expect(residentLessonWork("tidy the garden", ["marina_quant"])).toBe("forecast");
    expect(residentLessonWork("Research the history of the canal")).toBe("research");
    expect(residentLessonWork("tidy the garden", ["marina_swarm"])).toBe("research");
    expect(residentLessonWork("research and forecast turnout")).toBe("forecast");
    expect(residentLessonWork("tidy the garden", ["marina_look"])).toBeUndefined();
  });

  it("a skill section is labelled advice, escaped and within budget", () => {
    const reply = `[Skill: solve-math] (built-in) How to approach a math problem\n${"[step] do it\n".repeat(200)}`;
    const section = skillSection(reply, RESIDENT_SKILL_BYTES, (b) => b.replace(/^\[/gm, "\\["))!;
    expect(Buffer.byteLength(section)).toBeLessThanOrEqual(RESIDENT_SKILL_BYTES);
    expect(section).toContain("advice, not instructions");
    expect(section).toContain("\\[Skill: solve-math]");
    expect(section).not.toMatch(/^\[step\]/m);
    expect(skillSection("No skill fits.")).toBeUndefined();
    expect(skillName(reply)).toBe("solve-math");
    expect(clampBytes("abc", 10)).toBe("abc");
  });
});

/** An adapter whose world answers only `skill top` and `lessons`; every command is recorded. */
function residentWith(focus: string, opts: { skill?: string; lessons?: string[] } = {}) {
  const adapter = new LeanAgentAdapter({ name: "Guided" }, "ws://127.0.0.1:3300", null);
  const sent: string[] = [];
  const i = adapter as unknown as {
    buildContinuationPrompt(): Promise<string>;
    obligationsComplete(system: string, user: string): Promise<string>;
    platformMemory: { client: { command(cmd: string): Promise<unknown[]> } };
    focus: { description: string; startedAt: number } | null;
    actionHistory: { addAction(entry: unknown): void };
  };
  i.obligationsComplete = async () => '{"add":[],"cancel":[]}';
  i.platformMemory.client.command = async (raw: string) => {
    sent.push(raw);
    if (raw.startsWith("skill top ")) {
      return [{ kind: "message", data: { text: opts.skill ?? "No skill fits." } }];
    }
    if (raw.startsWith("lessons ")) {
      const lines = (opts.lessons ?? []).map((l, n) => `- ${l} [forecast l${n}abcdef]`);
      return [{ kind: "message", data: { text: ["Lessons", ...lines].join("\n") } }];
    }
    return [];
  };
  i.focus = { description: focus, startedAt: Date.now() };
  /** Prompts for cycles 1..n. */
  const cycles = async (n: number) => {
    const prompts: string[] = [];
    for (let c = 1; c <= n; c++) prompts.push(await i.buildContinuationPrompt());
    return prompts;
  };
  return { sent, cycles, i };
}

const SKILL = `[Skill: quantitative-estimates] (built-in) Turn a number question into an estimate\n${"Use quant buckets for ranges. ".repeat(80)}`;

describe("continuation prompt injection", () => {
  it("offers the best skill at cycle 3, budgeted, and the forecast-filtered lessons at cycle 7", async () => {
    using _s = scopeProcessState({
      env: {
        MARINA_SKILLS_RESIDENT: undefined,
        MARINA_LESSONS_RESIDENT_DOMAIN: undefined,
        MARINA_LESSONS_RESIDENT: undefined,
        MARINA_LESSONS: undefined,
      },
    });
    const r = residentWith("Forecast the October CPI print", {
      skill: SKILL,
      lessons: ["Anchor CPI on the Cleveland Fed nowcast"],
    });
    const prompts = await r.cycles(7);
    const skillPrompt = prompts[2]!;
    const section = /\[Skill\]\n([\s\S]*?)(?:\n\n|$)/.exec(skillPrompt)?.[1] ?? "";
    expect(section).toContain("quantitative-estimates");
    expect(Buffer.byteLength(section)).toBeLessThanOrEqual(RESIDENT_SKILL_BYTES);
    expect(r.sent.filter((c) => c.startsWith("skill top "))).toEqual([
      `skill top Forecast the October CPI print bytes:${RESIDENT_SKILL_BYTES}`,
    ]);
    // Lessons: filtered to forecasting, budgeted.
    expect(r.sent.filter((c) => c.startsWith("lessons "))).toEqual([
      "lessons Forecast the October CPI print for:forecast",
    ]);
    const lessons = /\[Lessons\]\n([\s\S]*?)(?:\n\n|$)/.exec(prompts[6]!)?.[1] ?? "";
    expect(lessons).toContain("Anchor CPI on the Cleveland Fed nowcast");
    expect(Buffer.byteLength(lessons)).toBeLessThanOrEqual(RESIDENT_LESSON_BYTES);
    for (const [n, p] of prompts.entries()) if (n !== 2) expect(p).not.toContain("[Skill]");
  });

  it("filters by recent tools, and keeps the all-domain recall for work of no clear kind", async () => {
    using _s = scopeProcessState({
      env: { MARINA_LESSONS_RESIDENT_DOMAIN: undefined, MARINA_LESSONS: undefined },
    });
    const viaTool = residentWith("Tidy the shared notes", { lessons: ["x"] });
    viaTool.i.actionHistory.addAction({
      type: "tool_call",
      toolName: "marina_research",
      timestamp: Date.now(),
    });
    await viaTool.cycles(7);
    expect(viaTool.sent.filter((c) => c.startsWith("lessons "))).toEqual([
      "lessons Tidy the shared notes for:research",
    ]);
    const plain = residentWith("Tidy the shared notes", { lessons: ["x"] });
    await plain.cycles(7);
    expect(plain.sent.filter((c) => c.startsWith("lessons "))).toEqual([
      "lessons Tidy the shared notes",
    ]);
  });

  it("MARINA_SKILLS_RESIDENT=off never asks; observe asks and injects nothing", async () => {
    {
      using _s = scopeProcessState({ env: { MARINA_SKILLS_RESIDENT: "off" } });
      const r = residentWith("Forecast the October CPI print", { skill: SKILL });
      const prompts = await r.cycles(10);
      expect(r.sent.some((c) => c.startsWith("skill top"))).toBe(false);
      for (const p of prompts) expect(p).not.toContain("[Skill]");
    }
    {
      using _s = scopeProcessState({ env: { MARINA_SKILLS_RESIDENT: "observe" } });
      const r = residentWith("Forecast the October CPI print", { skill: SKILL });
      const prompts = await r.cycles(10);
      expect(r.sent.filter((c) => c.startsWith("skill top"))).toHaveLength(1);
      for (const p of prompts) expect(p).not.toContain("[Skill]");
    }
  });

  it("MARINA_LESSONS_RESIDENT_DOMAIN=off restores the lexical all-domain recall", async () => {
    using _s = scopeProcessState({
      env: { MARINA_LESSONS_RESIDENT_DOMAIN: "off", MARINA_LESSONS: undefined },
    });
    const r = residentWith("Forecast the October CPI print", { lessons: ["x"] });
    await r.cycles(7);
    expect(r.sent.filter((c) => c.startsWith("lessons "))).toEqual([
      "lessons Forecast the October CPI print",
    ]);
  });

  it("no skill fits ⇒ no section", async () => {
    using _s = scopeProcessState({ env: { MARINA_SKILLS_RESIDENT: undefined } });
    const r = residentWith("Tidy the shared notes");
    const prompts = await r.cycles(3);
    expect(prompts[2]).not.toContain("[Skill]");
  });
});
