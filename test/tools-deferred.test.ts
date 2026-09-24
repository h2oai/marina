// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Deferred tool schemas: the `full` profile ships the crew core set plus ONE
 * `marina_tool_search` whose description catalogs every deferred tool; loading
 * a tool by name makes it callable for the rest of the session. The merged
 * memory-service tool keeps the resident memory surface ≤ 2 KB.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { LeanAgentAdapter } from "../src/agent/lean-agent-adapter";
import {
  createProfileToolset,
  createScopedTools,
  deferredToolsEnabled,
  FULL_RESIDENT_TOOL_NAMES,
  TOOL_PROFILE_NAMES,
  TOOL_SEARCH_NAME,
} from "../src/agent/tools";

const serialized = (t: AgentTool) =>
  JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters });
const totalBytes = (tools: readonly AgentTool[]) =>
  tools.reduce((n, t) => n + Buffer.byteLength(serialized(t), "utf8"), 0);

function stubCtx(commands: string[]) {
  return {
    client: {
      isConnected: () => true,
      command: async (command: string) => {
        commands.push(command);
        return [{ kind: "text", data: { text: "ok" } }];
      },
    },
    gameState: { handlePerception: () => {} },
  } as never;
}
const memory = {} as never;

describe("deferred tool schemas (full profile)", () => {
  afterEach(() => {
    delete process.env.MARINA_DEFERRED_TOOLS;
  });

  it("keeps resident schemas ≤ 16 KB with the core set + one loader", () => {
    delete process.env.MARINA_DEFERRED_TOOLS;
    const { resident, deferred } = createProfileToolset(stubCtx([]), memory, "full");
    expect(totalBytes(resident)).toBeLessThanOrEqual(16 * 1024);
    const names = resident.map((t) => t.name);
    expect(names).toContain("marina_command");
    expect(names).toContain(TOOL_SEARCH_NAME);
    for (const core of FULL_RESIDENT_TOOL_NAMES) expect(names).toContain(core);
    expect(names.filter((n) => n === TOOL_SEARCH_NAME)).toHaveLength(1);
    expect(deferred.length).toBeGreaterThan(30);
    // Deferred and resident are disjoint; the loader is not deferred.
    for (const t of deferred) expect(names).not.toContain(t.name);
  });

  it("catalogs every deferred tool as `name — one line` in the loader description", () => {
    const { resident, deferred } = createProfileToolset(stubCtx([]), memory, "full");
    const loader = resident.find((t) => t.name === TOOL_SEARCH_NAME)!;
    for (const t of deferred) expect(loader.description).toContain(`${t.name} — `);
    for (const line of loader.description.split("\n").filter((l) => l.includes(" — "))) {
      expect(line.length).toBeLessThan(140);
    }
  });

  it("loads a deferred tool by name and it becomes callable", async () => {
    const commands: string[] = [];
    const live: AgentTool[] = [];
    const resident = createScopedTools(
      stubCtx(commands),
      memory,
      "full",
      { text: true },
      {
        onLoadTools: (tools) => live.push(...tools),
      },
    );
    expect(resident.some((t) => t.name === "marina_look")).toBe(false);
    const loader = resident.find((t) => t.name === TOOL_SEARCH_NAME)!;
    const result = await loader.execute("1", { names: ["marina_look"] });
    expect((result.details as { loaded: string[] }).loaded).toEqual(["marina_look"]);
    expect(result.content[0]).toMatchObject({ type: "text" });
    const look = live.find((t) => t.name === "marina_look")!;
    expect(look).toBeTruthy();
    await look.execute("2", { target: "board" });
    expect(commands).toEqual(["look board"]);
  });

  it("matches by keyword query and rejects unknown names", async () => {
    const live: AgentTool[] = [];
    const resident = createScopedTools(
      stubCtx([]),
      memory,
      "full",
      { text: true },
      {
        onLoadTools: (tools) => live.push(...tools),
      },
    );
    const loader = resident.find((t) => t.name === TOOL_SEARCH_NAME)!;
    const result = await loader.execute("1", { query: "canvas" });
    expect(live.some((t) => t.name === "marina_canvas")).toBe(true);
    expect((result.details as { loaded: string[] }).loaded.length).toBeGreaterThan(0);
    await expect(loader.execute("2", { names: ["marina_nope"] })).rejects.toThrow(
      /unknown: marina_nope/,
    );
  });

  it("MARINA_DEFERRED_TOOLS=off restores the all-resident full profile", () => {
    process.env.MARINA_DEFERRED_TOOLS = "off";
    expect(deferredToolsEnabled()).toBe(false);
    const { resident, deferred } = createProfileToolset(stubCtx([]), memory, "full");
    expect(deferred).toHaveLength(0);
    expect(resident.some((t) => t.name === TOOL_SEARCH_NAME)).toBe(false);
    expect(resident.some((t) => t.name === "marina_look")).toBe(true);
    expect(resident.length).toBeGreaterThan(50);
  });

  it("wires loaded tools into a live LeanAgentAdapter for the rest of the session", async () => {
    const adapter = new LeanAgentAdapter({ name: "deferred-loader" }, "ws://127.0.0.1:3300", null);
    const agent = (adapter as unknown as { agent: { state: { tools: AgentTool[] } } }).agent;
    expect(agent.state.tools.some((t) => t.name === TOOL_SEARCH_NAME)).toBe(true);
    expect(agent.state.tools.some((t) => t.name === "marina_canvas")).toBe(false);
    const loader = agent.state.tools.find((t) => t.name === TOOL_SEARCH_NAME)!;
    await loader.execute("1", { names: ["marina_canvas", "marina_task"] });
    expect([...adapter.loadedTools].sort()).toEqual(["marina_canvas", "marina_task"]);
    expect(agent.state.tools.some((t) => t.name === "marina_canvas")).toBe(true);
    expect(agent.state.tools.some((t) => t.name === "marina_task")).toBe(true);
    // Idempotent: loading again does not duplicate.
    await loader.execute("2", { names: ["marina_canvas"] });
    expect(agent.state.tools.filter((t) => t.name === "marina_canvas")).toHaveLength(1);
  });
});

describe("merged memory tool surface", () => {
  it("keeps marina_memory_service ≤ 2 KB and resident in crew/minimal; assistance is deferred", () => {
    const { resident, deferred } = createProfileToolset(stubCtx([]), memory, "full");
    const service = resident.find((t) => t.name === "marina_memory_service")!;
    expect(service).toBeTruthy();
    expect(Buffer.byteLength(serialized(service), "utf8")).toBeLessThanOrEqual(2048);
    expect(resident.some((t) => t.name === "marina_memory_assistance")).toBe(false);
    expect(deferred.some((t) => t.name === "marina_memory_assistance")).toBe(true);
    // The operation enum still covers the assistance operations.
    const ops = (service.parameters as { properties: { operation: { enum: string[] } } }).properties
      .operation.enum;
    for (const op of ["assist_create", "assist_claim", "assist_finish", "retrieve", "remember"]) {
      expect(ops).toContain(op);
    }
    expect(TOOL_PROFILE_NAMES.crew).toContain("marina_memory_service");
    expect(TOOL_PROFILE_NAMES.minimal).toContain("marina_memory_service");
    expect(TOOL_PROFILE_NAMES.crew).not.toContain("marina_memory_assistance");
  });

  it("crew and minimal profiles shrank", () => {
    expect(totalBytes(createScopedTools(stubCtx([]), memory, "crew"))).toBeLessThanOrEqual(
      11 * 1024,
    );
    expect(totalBytes(createScopedTools(stubCtx([]), memory, "minimal"))).toBeLessThanOrEqual(
      6 * 1024,
    );
  });
});
