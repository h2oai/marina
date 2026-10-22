// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Prompt budget tiers and on-demand tools (2026-10-20): the adapter picks the
 * `lean` tier for a model window ≤ 32k tokens (and with it the `minimal`
 * tool profile unless the profile was chosen explicitly); `marina_code`
 * becomes resident only for a bound coding task, a coding role or an
 * explicit profile, and `think` loads by name. Nothing becomes unreachable:
 * each on-demand tool is listed in the agent's `marina_tool_search`.
 */

import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { LeanAgentAdapter } from "../src/agent/lean-agent-adapter";
import { taughtCommandNames } from "../src/agent/prompts/lean-system";
import { ON_DEMAND_TOOL_NAMES, resolveToolProfile, TOOL_SEARCH_NAME } from "../src/agent/tools";
import { scopeProcessState } from "./process-state";

type Probe = {
  agent: { state: { tools: AgentTool[]; systemPrompt: string } };
  promptTier: "lean" | "full";
  loadedTools: readonly string[];
  setActiveCodingTask(task: string | null): void;
  setToolProfile(profile: "full" | "crew" | "minimal" | "plan" | "base"): void;
};

const WS = "ws://127.0.0.1:3300";
const adapter = (config: Record<string, unknown>) =>
  new LeanAgentAdapter(
    { name: `tier-${crypto.randomUUID().slice(0, 8)}`, ...config } as never,
    WS,
    null,
  ) as unknown as Probe;
const toolNames = (a: Probe) => a.agent.state.tools.map((t) => t.name);
const loaderText = (a: Probe) =>
  a.agent.state.tools.find((t) => t.name === TOOL_SEARCH_NAME)?.description ?? "";

describe("resolveToolProfile", () => {
  it("gives a lean-tier model `minimal` unless the profile was chosen explicitly", () => {
    expect(resolveToolProfile({}, "lean")).toBe("minimal");
    expect(resolveToolProfile({ toolProfile: "crew", toolProfileInferred: true }, "lean")).toBe(
      "minimal",
    );
    expect(resolveToolProfile({ toolProfile: "crew" }, "lean")).toBe("crew");
    expect(resolveToolProfile({ toolProfile: "full" }, "lean")).toBe("full");
    // Large windows keep whatever was configured or inferred.
    expect(resolveToolProfile({}, "full")).toBe("full");
    expect(resolveToolProfile({ toolProfile: "crew", toolProfileInferred: true }, "full")).toBe(
      "crew",
    );
    expect(resolveToolProfile({ toolProfile: "minimal" }, "full")).toBe("minimal");
  });
});

describe("the adapter's prompt tier", () => {
  it("a 16k-window model runs the lean tier with the minimal tools; think stays loadable", () => {
    using _state = scopeProcessState({ env: { MARINA_DEFERRED_TOOLS: undefined } });
    const a = adapter({ contextWindow: 16_384 });
    expect(a.promptTier).toBe("lean");
    expect(toolNames(a).sort()).toEqual(
      ["marina_command", "marina_memory_service", "memory", TOOL_SEARCH_NAME].sort(),
    );
    expect(loaderText(a)).toContain("think — ");
  });

  it("an inferred crew profile also yields to minimal on a lean model; an explicit one does not", () => {
    const inferred = adapter({
      contextWindow: 16_384,
      toolProfile: "crew",
      toolProfileInferred: true,
    });
    expect(toolNames(inferred)).not.toContain("marina_tell");
    const explicit = adapter({ contextWindow: 16_384, toolProfile: "crew" });
    expect(toolNames(explicit)).toContain("marina_tell");
    // An explicit profile is honored as declared: marina_code stays resident.
    expect(toolNames(explicit)).toContain("marina_code");
  });

  it("a large-window model keeps the full tier; marina_code and think are on demand", () => {
    const a = adapter({});
    expect(a.promptTier).toBe("full");
    const names = toolNames(a);
    for (const name of ON_DEMAND_TOOL_NAMES) {
      expect(names).not.toContain(name);
      expect(loaderText(a)).toContain(`${name} — `);
    }
    for (const name of ["marina_command", "marina_tell", "marina_channel", "marina_pool"])
      expect(names).toContain(name);
  });

  it("binding a coding task loads marina_code, and it survives a plan → base round trip", () => {
    const a = adapter({ toolProfile: "crew", toolProfileInferred: true });
    expect(toolNames(a)).not.toContain("marina_code");
    a.setActiveCodingTask("Task #1: fix the failing test");
    expect(toolNames(a)).toContain("marina_code");
    expect(a.loadedTools).toContain("marina_code");
    a.setToolProfile("plan");
    expect(toolNames(a)).not.toContain("marina_code");
    a.setToolProfile("base");
    expect(toolNames(a)).toContain("marina_code");
    // Loading another tool afterwards keeps it.
    const loader = a.agent.state.tools.find((t) => t.name === TOOL_SEARCH_NAME)!;
    return loader.execute("1", { names: ["think"] }).then(() => {
      expect(toolNames(a)).toContain("think");
      expect(toolNames(a)).toContain("marina_code");
    });
  });

  it("a coding role keeps marina_code resident from the start", () => {
    const a = adapter({ role: "coding-agent", toolProfile: "crew", toolProfileInferred: true });
    expect(toolNames(a)).toContain("marina_code");
  });

  it("MARINA_DEFERRED_TOOLS=off keeps marina_code and think resident as before", () => {
    using _state = scopeProcessState({ env: { MARINA_DEFERRED_TOOLS: "off" } });
    const a = adapter({ toolProfile: "crew", toolProfileInferred: true });
    expect(toolNames(a)).toContain("marina_code");
    expect(toolNames(a)).toContain("think");
    expect(toolNames(a)).not.toContain(TOOL_SEARCH_NAME);
  });
});

describe("roster dedupe", () => {
  it("collects the first word of every backticked span", () => {
    const names = taughtCommandNames(
      "Observe: `look`, `brief`. Direct yourself: `memory set focus <text>`, `task goal <title>`.",
      "`pool <name> add|recall` · `skill store|search`",
    );
    for (const name of ["look", "brief", "memory", "task", "pool", "skill"])
      expect(names.has(name)).toBe(true);
    expect(names.has("focus")).toBe(false);
  });
});
