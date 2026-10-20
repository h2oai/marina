// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed analysis tools (`src/agent/tools/analysis.ts`): each builds ONE world
 * command (`src/agent/analysis-commands.ts`) and runs it like
 * `marina_command`, so the command's own rank, gates and spend guards decide.
 * They are deferred in the `full` profile, absent from `crew` / `minimal`,
 * named in TOOL ROUTING, and classified by the tool policy from the same
 * command string they send.
 */

import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { ANALYSIS_TOOL_COMMANDS, ANALYSIS_TOOL_NAMES } from "../src/agent/analysis-commands";
import { getToolRouting } from "../src/agent/prompts/lean-system";
import {
  classifyToolRisk,
  READ_TOOL_NAMES,
  toolResultTrust,
  typedToolCommand,
} from "../src/agent/tool-policy";
import {
  createAllTools,
  createAnalysisTools,
  createProfileToolset,
  FULL_RESIDENT_TOOL_NAMES,
  READ_ONLY_TOOL_NAMES,
  TOOL_SEARCH_NAME,
} from "../src/agent/tools";
import { createTestEngine } from "./engine-fixture";
import { scopeProcessState } from "./process-state";

type Perception = { kind: string; data: Record<string, unknown> };

function stubCtx(sent: string[], reply: (command: string) => Perception[] = () => []) {
  return {
    client: {
      isConnected: () => true,
      command: async (command: string) => {
        sent.push(command);
        const out = reply(command);
        return out.length ? out : [{ kind: "message", data: { text: "ok" } }];
      },
    },
    gameState: { handlePerception: () => {} },
  } as never;
}
const memory = {} as never;

const EXPECTED_NAMES = [
  "marina_forecast",
  "marina_research",
  "marina_swarm",
  "marina_quant",
  "marina_calc",
  "marina_data",
  "marina_decision_check",
  "marina_triage",
  "marina_arbiter",
  "marina_pattern",
];

/** One representative call per tool and the exact command it must send. */
const CASES: Array<[string, Record<string, unknown>, string]> = [
  [
    "marina_forecast",
    { question: "Will the Fed cut in October?" },
    "forecast Will the Fed cut in October?",
  ],
  [
    "marina_forecast",
    {
      question: "Who wins?",
      type: "choice",
      options: ["A", "B"],
      ends: "2026-11-01T00:00:00Z",
      formation: "verify",
      retriever: "asof",
    },
    "forecast type:choice options:A,B ends:2026-11-01T00:00:00Z formation:verify retriever:asof -- Who wins?",
  ],
  ["marina_forecast", { action: "list" }, "forecast list"],
  ["marina_research", { question: "Who founded X?" }, "research ask -- Who founded X?"],
  [
    "marina_research",
    { question: "Q", mode: "authority", retriever: "search", budgetUsd: 0.5 },
    "research ask mode:authority retriever:search budget:0.5 -- Q",
  ],
  [
    "marina_swarm",
    { question: "list every X", engines: ["ddg", "corpus:docs"], docs: 8 },
    "web swarm engines:ddg,corpus:docs docs:8 list every X",
  ],
  ["marina_quant", { action: "fit", values: [1, 2, 3], steps: 2 }, "quant fit 1 2 3 steps:2"],
  [
    "marina_quant",
    { action: "buckets", mean: 3.4, sd: 0.3, buckets: "<3, 3-4, >=4" },
    "quant buckets mean:3.4 sd:0.3 -- <3, 3-4, >=4",
  ],
  [
    "marina_quant",
    {
      action: "buckets",
      quantiles: [
        { level: 0.1, value: 38 },
        { level: 0.9, value: 47 },
      ],
      cuts: [40, 45],
    },
    "quant buckets q:0.1=38,0.9=47 cuts:40,45",
  ],
  ["marina_calc", { expression: "0.3 * 1.2 + 4" }, "calc 0.3 * 1.2 + 4"],
  [
    "marina_data",
    { source: "markets", query: "fed cut", asOf: "2026-09-01" },
    "data markets asof:2026-09-01 fed cut",
  ],
  [
    "marina_data",
    { source: "polls", pollType: "approval", query: "Donald Trump", exclude: ["Rasmussen"] },
    "data polls exclude:Rasmussen approval Donald Trump",
  ],
  ["marina_data", { source: "crowd", query: "AGI by 2030" }, "data crowd AGI by 2030"],
  ["marina_data", { source: "sources" }, "data sources"],
  [
    "marina_decision_check",
    { draft: "The answer is 4", request: "2+2?" },
    "decision check 2+2? | The answer is 4",
  ],
  ["marina_decision_check", { draft: "a | b" }, "decision check | a | b"],
  ["marina_triage", { question: "What was CPI in May?" }, "triage What was CPI in May?"],
  [
    "marina_triage",
    { question: "Q", type: "number", asOf: "2026-06-01" },
    "triage type:number asof:2026-06-01 -- Q",
  ],
  [
    "marina_arbiter",
    { action: "contested", type: "choice", answers: ["A", "B|C"] },
    "arbiter contested type:choice -- A | B/C",
  ],
  [
    "marina_arbiter",
    { action: "check", majority: "A", agreement: 0.6, verdict: '{"verdict":"keep"}' },
    'arbiter check majority:A agreement:0.6 -- {"verdict":"keep"}',
  ],
  ["marina_arbiter", { action: "policy" }, "arbiter policy"],
  [
    "marina_pattern",
    { pattern: "debate", task: "Pick a name", budgetUsd: 1 },
    "pattern run debate budget:1 -- Pick a name",
  ],
  ["marina_pattern", { action: "list" }, "pattern list"],
];

describe("analysis tool schemas", () => {
  const tools = createAnalysisTools(stubCtx([]));

  it("ships exactly the ten analysis tools, each with an object schema and a description", () => {
    expect(tools.map((t) => t.name)).toEqual(EXPECTED_NAMES);
    expect([...ANALYSIS_TOOL_NAMES]).toEqual(EXPECTED_NAMES);
    for (const t of tools) {
      const schema = t.parameters as { type?: string; properties?: Record<string, unknown> };
      expect(schema.type).toBe("object");
      expect(Object.keys(schema.properties ?? {}).length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.description.length).toBeLessThan(220);
    }
  });

  it("declares the fields each command needs as required", () => {
    const required = (name: string) =>
      (
        (tools.find((t) => t.name === name)!.parameters as { required?: string[] }).required ?? []
      ).sort();
    expect(required("marina_research")).toEqual(["question"]);
    expect(required("marina_swarm")).toEqual(["question"]);
    expect(required("marina_calc")).toEqual(["expression"]);
    expect(required("marina_quant")).toEqual(["action"]);
    expect(required("marina_data")).toEqual(["source"]);
    expect(required("marina_decision_check")).toEqual(["draft"]);
    expect(required("marina_triage")).toEqual(["question"]);
    expect(required("marina_arbiter")).toEqual(["action"]);
  });

  it("every tool is in createAllTools", () => {
    const all = createAllTools(stubCtx([]), memory).map((t) => t.name);
    for (const name of EXPECTED_NAMES) expect(all).toContain(name);
  });
});

describe("analysis tools send exactly their command", () => {
  for (const [name, args, command] of CASES) {
    it(`${name} ${JSON.stringify(args).slice(0, 60)}`, async () => {
      const sent: string[] = [];
      const tool = createAnalysisTools(stubCtx(sent)).find((t) => t.name === name)!;
      await tool.execute("call", args as never);
      expect(sent).toEqual([command]);
      // The policy classifies the same string the tool sends.
      expect(typedToolCommand(name, args)).toBe(command);
      expect(ANALYSIS_TOOL_COMMANDS[name]!(args)).toBe(command);
    });
  }

  it("refuses arguments that cannot make a valid command, sending nothing", async () => {
    const bad: Array<[string, Record<string, unknown>, RegExp]> = [
      ["marina_forecast", {}, /needs question/],
      ["marina_forecast", { question: "Q", options: ["New York", "LA"], type: "choice" }, /spaces/],
      ["marina_quant", { action: "fit", values: [1] }, /2 or more/],
      ["marina_quant", { action: "buckets", buckets: "<1" }, /mean and sd/],
      ["marina_quant", { action: "nope" }, /fit or buckets/],
      ["marina_data", { source: "weather", query: "x" }, /source must be/],
      ["marina_data", { source: "polls", query: "Trump" }, /pollType/],
      ["marina_arbiter", { action: "contested", answers: ["only"] }, /2 or more/],
      ["marina_pattern", { pattern: "debate" }, /needs task/],
    ];
    for (const [name, args, message] of bad) {
      const sent: string[] = [];
      const tool = createAnalysisTools(stubCtx(sent)).find((t) => t.name === name)!;
      await expect(tool.execute("call", args as never)).rejects.toThrow(message);
      expect(sent).toEqual([]);
      expect(typedToolCommand(name, args)).toBeUndefined();
    }
  });

  it("a rank, gate or spend refusal from the command fails the tool call", async () => {
    const replies: Record<string, string> = {
      forecast: "Not forecasting: daily spend cap reached.",
      pattern: "Usage: pattern run <pattern> [budget:<usd>] -- <task>",
      research: "Could not research: no model is available to run the research agent",
    };
    for (const [name, args] of [
      ["marina_pattern", { pattern: "debate", task: "t" }],
      ["marina_research", { question: "q" }],
    ] as const) {
      const tool = createAnalysisTools(
        stubCtx([], (c) => [{ kind: "message", data: { text: replies[c.split(" ")[0]!]! } }]),
      ).find((t) => t.name === name)!;
      await expect(tool.execute("call", args as never)).rejects.toThrow();
    }
    // An engine error perception (a rank floor or gate hold) always fails the call.
    const gated = createAnalysisTools(
      stubCtx([], () => [
        { kind: "error", data: { text: "You must be at least rank 3 to do that." } },
      ]),
    ).find((t) => t.name === "marina_forecast")!;
    await expect(gated.execute("call", { question: "q" } as never)).rejects.toThrow(/rank 3/);
  });
});

describe("analysis tools in the profiles", () => {
  it("are deferred in `full`: listed in the tool-search catalog, never resident", () => {
    using _state = scopeProcessState({ env: { MARINA_DEFERRED_TOOLS: undefined } });
    const { resident, deferred } = createProfileToolset(stubCtx([]), memory, "full");
    const residentNames = resident.map((t) => t.name);
    for (const name of EXPECTED_NAMES) {
      expect(residentNames).not.toContain(name);
      expect(deferred.map((t) => t.name)).toContain(name);
    }
    expect(FULL_RESIDENT_TOOL_NAMES.some((n) => EXPECTED_NAMES.includes(n))).toBe(false);
    const search = resident.find((t) => t.name === TOOL_SEARCH_NAME)!;
    for (const name of EXPECTED_NAMES) expect(search.description).toContain(`${name} — `);
  });

  it("load by name through marina_tool_search", async () => {
    using _state = scopeProcessState({ env: { MARINA_DEFERRED_TOOLS: undefined } });
    const loaded: AgentTool[] = [];
    const { resident } = createProfileToolset(
      stubCtx([]),
      memory,
      "full",
      { text: true },
      {
        onLoadTools: (tools) => loaded.push(...tools),
      },
    );
    const search = resident.find((t) => t.name === TOOL_SEARCH_NAME)!;
    await search.execute("load", { names: ["marina_forecast", "marina_data"] } as never);
    expect(loaded.map((t) => t.name)).toEqual(["marina_forecast", "marina_data"]);
  });

  it("are resident when deferral is off, and absent from crew / minimal", () => {
    {
      using _state = scopeProcessState({ env: { MARINA_DEFERRED_TOOLS: "off" } });
      const { resident } = createProfileToolset(stubCtx([]), memory, "full");
      for (const name of EXPECTED_NAMES) expect(resident.map((t) => t.name)).toContain(name);
    }
    for (const profile of ["crew", "minimal"] as const) {
      const { resident, deferred } = createProfileToolset(stubCtx([]), memory, profile);
      for (const name of EXPECTED_NAMES) {
        expect(resident.map((t) => t.name)).not.toContain(name);
        expect(deferred.map((t) => t.name)).not.toContain(name);
      }
    }
  });

  it("are named in TOOL ROUTING when the agent holds marina_tool_search", () => {
    const routing = getToolRouting(["marina_command", TOOL_SEARCH_NAME]);
    for (const name of EXPECTED_NAMES) {
      expect(routing).toContain(name.slice("marina_".length));
    }
    expect(routing).toContain("analysis tools are marina_ +");
    expect(getToolRouting(["marina_command"])).not.toContain("analysis tools");
  });
});

describe("analysis tools under the tool policy", () => {
  it("pure helpers are reads (parallel, replay-safe); paid work and lookups are gated", () => {
    for (const name of ["marina_calc", "marina_quant", "marina_triage", "marina_arbiter"]) {
      expect(READ_TOOL_NAMES.has(name)).toBe(true);
      expect(READ_ONLY_TOOL_NAMES.has(name)).toBe(true);
    }
    expect(classifyToolRisk("marina_calc", { expression: "1+1" })).toBe("read");
    expect(
      classifyToolRisk("marina_data", { source: "polls", pollType: "approval", query: "X" }),
    ).toBe("egress");
    expect(classifyToolRisk("marina_data", { source: "crowd", query: "X" })).toBe("egress");
    expect(classifyToolRisk("marina_data", { source: "sources" })).toBe("read");
    for (const [name, args] of [
      ["marina_forecast", { question: "q" }],
      ["marina_research", { question: "q" }],
      ["marina_swarm", { question: "q" }],
      ["marina_pattern", { pattern: "debate", task: "t" }],
      ["marina_decision_check", { draft: "d" }],
    ] as const) {
      expect(classifyToolRisk(name, args)).toBe("mutate");
      expect(READ_ONLY_TOOL_NAMES.has(name)).toBe(false);
    }
  });

  it("fences web-research results as external content", () => {
    expect(toolResultTrust("marina_research", { question: "q" }).fence).toBe("external_tool");
    expect(toolResultTrust("marina_swarm", { question: "q" }).fence).toBe("external_tool");
    expect(toolResultTrust("marina_data", { source: "crowd", query: "q" }).fence).toBe(
      "external_tool",
    );
    expect(toolResultTrust("marina_calc", { expression: "1" }).fence).toBeUndefined();
  });
});

describe("analysis commands reach the live command surface", () => {
  it("every tool's command is a registered builtin a rank-0 entity can run", async () => {
    const fixture = createTestEngine();
    try {
      const builtins = new Map(
        fixture.engine.commands.allBuiltins().map((c) => [c.name, c] as const),
      );
      for (const [, args, command] of CASES) {
        const verb = command.split(" ")[0]!;
        const def = builtins.get(verb);
        expect([verb, def !== undefined]).toEqual([verb, true]);
        // Rank 0 (or a gate) is the command's own: the tool adds nothing.
        expect([verb, def!.minRank ?? 0]).toEqual([verb, 0]);
        void args;
      }
    } finally {
      await fixture.dispose();
    }
  });
});
