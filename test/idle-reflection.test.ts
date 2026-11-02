// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The idle turn is append-only (`src/agent/idle-reflection.ts`): `[Quiet]`
 * and `[Reflection Due]` ask for one reflection, a goal update and rest —
 * never the old curation menu — and `MARINA_IDLE_REFLECTION=rest` offers
 * rest alone. A saved reflection-tier note answers the ask.
 */

import { describe, expect, it } from "bun:test";
import {
  APPEND_ASK,
  idleReflectionMode,
  QUIET_HEADER,
  quietBody,
  REFLECTION_DUE_HEADER,
  reflectionDueBody,
  savedReflection,
} from "../src/agent/idle-reflection";
import { LeanAgentAdapter } from "../src/agent/lean-agent-adapter";
import { scopeProcessState } from "./process-state";

type Internals = {
  buildContinuationPrompt(): Promise<string>;
  loopIterationCount: number;
  lastReflectionCycle: number;
  notesSinceReflection: number;
  idleCycles: number;
  notesSinceConsolidation: number;
};

const CURATION = ["resolve a known contradiction", "link evidence", "evolve a stale belief"];

function idleAdapter(name: string): Internals {
  const adapter = new LeanAgentAdapter({ name }, "ws://127.0.0.1:3300", null);
  const internals = adapter as unknown as Internals;
  internals.idleCycles = 3;
  internals.notesSinceConsolidation = 1;
  return internals;
}

function dueAdapter(name: string): Internals {
  const adapter = new LeanAgentAdapter({ name }, "ws://127.0.0.1:3300", null);
  const internals = adapter as unknown as Internals;
  internals.loopIterationCount = 79;
  internals.lastReflectionCycle = -100;
  internals.notesSinceReflection = 4;
  return internals;
}

describe("the idle turn is append-only", () => {
  it("reads the mode: append by default, rest on request", () => {
    expect(idleReflectionMode({})).toBe("append");
    expect(idleReflectionMode({ MARINA_IDLE_REFLECTION: "rest" })).toBe("rest");
    expect(idleReflectionMode({ MARINA_IDLE_REFLECTION: "off" })).toBe("rest");
    expect(idleReflectionMode({ MARINA_IDLE_REFLECTION: "anything" })).toBe("append");
  });

  it("the ask names one new reflection, a goal update and rest — and forbids curation", () => {
    for (const text of [quietBody("append"), reflectionDueBody("append", 3)!]) {
      expect(text).toContain("ONE reflection");
      expect(text).toContain("memory note <text> type reflection");
      expect(text).toContain("memory set goal");
      expect(text).toContain("Do not resolve, link, evolve, merge or delete");
      for (const verb of CURATION) expect(text).not.toContain(verb);
    }
    expect(quietBody("append")).toContain("memory set rest");
    expect(reflectionDueBody("append", 1)).toContain("1 new note since");
    expect(reflectionDueBody("append", 3)).toContain("consolidate-memory");
    expect(quietBody("rest")).not.toContain(APPEND_ASK);
    expect(quietBody("rest")).toContain("memory set rest");
    expect(reflectionDueBody("rest", 5)).toBeUndefined();
  });

  it("a saved reflection-tier note counts as a reflection; other saves do not", () => {
    expect(savedReflection("Note #12 saved (type=reflection).")).toBe(true);
    expect(savedReflection("Note #12 saved (importance=7, type=reflection). Auto-linked…")).toBe(
      true,
    );
    expect(savedReflection("Note #12 saved (importance=7).")).toBe(false);
    expect(savedReflection("Note #12 saved.")).toBe(false);
    expect(savedReflection("Note #12 already holds this.")).toBe(false);
  });

  it("[Quiet] carries the append ask in append mode and rest alone in rest mode", async () => {
    {
      using _state = scopeProcessState({ env: { MARINA_IDLE_REFLECTION: undefined } });
      const prompt = await idleAdapter("idle-append").buildContinuationPrompt();
      expect(prompt).toContain(QUIET_HEADER);
      expect(prompt).toContain("ONE reflection");
      expect(prompt).toContain("type reflection");
      for (const verb of CURATION) expect(prompt).not.toContain(verb);
    }
    {
      using _state = scopeProcessState({ env: { MARINA_IDLE_REFLECTION: "rest" } });
      const prompt = await idleAdapter("idle-rest").buildContinuationPrompt();
      expect(prompt).toContain(QUIET_HEADER);
      expect(prompt).not.toContain("ONE reflection");
      expect(prompt).toContain("memory set rest");
      for (const verb of CURATION) expect(prompt).not.toContain(verb);
    }
  });

  it("[Reflection Due] carries the same ask with its count, and is absent in rest mode", async () => {
    {
      using _state = scopeProcessState({ env: { MARINA_IDLE_REFLECTION: undefined } });
      const prompt = await dueAdapter("due-append").buildContinuationPrompt();
      expect(prompt).toContain(REFLECTION_DUE_HEADER);
      expect(prompt).toContain("4 new notes since your last reflection");
      expect(prompt).toContain("ONE reflection");
      expect(prompt).not.toContain("then curate");
      for (const verb of CURATION) expect(prompt).not.toContain(verb);
    }
    {
      using _state = scopeProcessState({ env: { MARINA_IDLE_REFLECTION: "rest" } });
      const prompt = await dueAdapter("due-rest").buildContinuationPrompt();
      expect(prompt).not.toContain(REFLECTION_DUE_HEADER);
    }
  });
});
