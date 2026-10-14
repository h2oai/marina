// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * What agents are told is product surface: the system prompt names only tools
 * the agent holds and commands it can run, typed tools send commands their
 * handlers accept, a handler's refusal reaches the model as an error, and
 * every dead-end reply says what to do next.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { getLeanSystemPrompt, getToolRouting } from "../src/agent/prompts/lean-system";
import { createAllTools, createProfileToolset, TOOL_PROFILE_NAMES } from "../src/agent/tools";
import { handlerRefusal } from "../src/agent/tools/shared";
import { commandManifest } from "../src/engine/command-manifest";
import { type CommandCatalogEntry, renderCapabilityRoster } from "../src/sdk/capabilities";
import type { Perception } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { stripAnsi } from "./helpers";

const message = (text: string): Perception => ({ kind: "message", timestamp: 0, data: { text } });

function stubCtx(sent: string[], reply: (command: string) => Perception[] = () => []) {
  return {
    client: {
      isConnected: () => true,
      command: async (command: string) => {
        sent.push(command);
        return reply(command);
      },
    },
    gameState: { handlePerception: () => undefined },
  } as never;
}

const tool = (sent: string[], name: string, reply?: (command: string) => Perception[]) =>
  createAllTools(stubCtx(sent, reply), {} as never).find((t) => t.name === name)!;

describe("TOOL ROUTING names only tools the agent holds", () => {
  const absentFromMinimal = [
    "marina_look",
    "marina_say",
    "marina_board",
    "marina_task",
    "marina_focus",
    "marina_goal",
    "marina_tool_search",
    "marina_tell",
  ];

  it("defaults to the minimal profile's tools and routes by command", () => {
    const routing = getToolRouting();
    for (const name of absentFromMinimal) expect(routing).not.toContain(name);
    expect(routing).toContain("`marina_command` runs any command");
    expect(getLeanSystemPrompt(null)).toContain(routing);
  });

  it("mentions marina_tool_search only when the profile has it", () => {
    for (const profile of ["crew", "minimal"] as const) {
      const routing = getToolRouting(TOOL_PROFILE_NAMES[profile]);
      expect(routing).not.toContain("marina_tool_search");
    }
    const full = createProfileToolset(stubCtx([]), {} as never, "full").resident.map((t) => t.name);
    expect(getToolRouting(full)).toContain("marina_tool_search");
    const plan = createProfileToolset(stubCtx([]), {} as never, "plan").resident.map((t) => t.name);
    expect(getToolRouting(plan)).not.toContain("marina_command");
  });
});

describe("live command roster", () => {
  let fixture: ReturnType<typeof createTestEngine>;
  beforeAll(() => {
    fixture = createTestEngine();
  });
  afterAll(() => fixture.dispose());

  it("leads with core work commands and omits niche and operator surfaces", () => {
    const roster = renderCapabilityRoster(
      commandManifest(fixture.engine.commands, { rank: 0 }),
      1500,
      {
        coreOnly: true,
      },
    );
    for (const core of [
      "work",
      "next",
      "task",
      "project",
      "channel",
      "web",
      "canvas",
      "orient",
      "challenge",
    ])
      expect(roster).toContain(`\n${core}: `);
    for (const niche of ["arena", "bankroll", "bookmark", "admin", "key", "adapter", "quit"])
      expect(roster).not.toContain(`\n${niche}: `);
    expect(roster.indexOf("\nwork: ")).toBeLessThan(roster.indexOf("\nlook: "));
  });

  it("filters commands above the caller's rank unless told to include them", () => {
    const entry: CommandCatalogEntry = {
      name: "task",
      aliases: [],
      category: "Coordination",
      help: "Manage tasks",
      minRank: 3,
      availability: {
        status: "conditional",
        reasons: ["Rank 3 or the current autonomy policy is required"],
      },
    };
    expect(renderCapabilityRoster([entry])).not.toContain("task:");
    expect(renderCapabilityRoster([entry], 1900, { includeRankLimited: true })).toContain("task:");
  });

  it("presents note as a supported private-notes verb, not a deprecated one", () => {
    const note = commandManifest(fixture.engine.commands).find((e) => e.name === "note")!;
    expect(note.help).not.toContain("deprecated");
    expect(note.help).toContain("Private numbered notes");
  });
});

describe("typed tools send commands their handlers accept", () => {
  it("marina_channel read is channel history", async () => {
    const sent: string[] = [];
    await tool(sent, "marina_channel").execute("1", { action: "read", channel: "general" });
    expect(sent).toEqual(["channel history general"]);
  });

  it("marina_project puts the project name before per-project actions", async () => {
    const sent: string[] = [];
    const project = tool(sent, "marina_project");
    await project.execute("1", { action: "status", project: "Alpha" });
    await project.execute("2", { action: "status", args: "Alpha" });
    await project.execute("3", { action: "orchestrate", project: "Alpha", args: "deliberation" });
    await project.execute("4", { action: "info", project: "Alpha" });
    await project.execute("5", { action: "list" });
    expect(sent).toEqual([
      "project Alpha status",
      "project Alpha status",
      "project Alpha orchestrate deliberation",
      "project info Alpha",
      "project list",
    ]);
    await expect(project.execute("6", { action: "status" })).rejects.toThrow("needs project");
  });

  it("marina_pool requires a pool for every action but list", async () => {
    const sent: string[] = [];
    await expect(
      tool(sent, "marina_pool").execute("1", { action: "recall", content: "q" }),
    ).rejects.toThrow("needs pool");
    expect(sent).toEqual([]);
  });

  it("marina_goal keeps the goal task and the `goal` memory key together", async () => {
    const sent: string[] = [];
    const goal = tool(sent, "marina_goal", (command) =>
      command.startsWith("task goal")
        ? [message('Goal set: #7 "Map the grid" (priority 5).')]
        : command === "memory kv get goal"
          ? [message("goal (v1): Map the grid (task #7)")]
          : [message("ok")],
    );
    await goal.execute("1", { action: "set", title: "Map the grid", priority: 6 });
    expect(sent).toEqual([
      "task goal Map the grid | Map the grid priority:6",
      "memory kv set goal Map the grid (task #7)",
    ]);
    sent.length = 0;
    await goal.execute("2", { action: "show" });
    expect(sent).toEqual(["memory kv get goal", "task list mine"]);
    sent.length = 0;
    const cleared = await goal.execute("3", { action: "clear" });
    expect(sent).toEqual(["memory kv get goal", "memory kv delete goal"]);
    expect(JSON.stringify(cleared.content)).toContain("#7 stays claimed");
  });

  it("marina_code refuses an unknown action and lists the valid ones", async () => {
    const sent: string[] = [];
    // marina_code reports a bad request through details.error, which the agent
    // loop marks as a failed call (lean-adapter-coding-task.test.ts).
    const result = await tool(sent, "marina_code").execute("1", { action: "explode" });
    expect((result.details as { error?: string }).error).toMatch(
      /Unknown marina_code action "explode"\. Valid: status, files/,
    );
    expect(sent).toEqual([]);
  });
});

describe("handler refusals surface as tool errors", () => {
  it("recognises usage, unknown-subcommand, not-found and refusal replies", () => {
    for (const text of [
      "Usage: task progress <id> [+N | N]",
      'Unknown task subcommand "frob". Usage: task list|info',
      'Pool "x" not found or inaccessible. List pools with `pool list`.',
      "Cannot cancel task #3. You may not be the creator or it's not open.",
    ])
      expect(handlerRefusal([message(text)])).toBe(text);
  });

  it("leaves successful replies alone, even when they mention such words", () => {
    for (const text of [
      'Goal set: #7 "Map the grid" (priority 5).',
      'No memory entry for "goal".',
      `Notes\n${"  #1 the file was not found yesterday\n".repeat(30)}`,
    ])
      expect(handlerRefusal([message(text)])).toBeUndefined();
    // Multi-message replies are listings or streams, never a single refusal.
    expect(handlerRefusal([message("Usage: x"), message("more")])).toBeUndefined();
  });

  it("rejects the tool call so the model sees an error", async () => {
    const sent: string[] = [];
    const task = tool(sent, "marina_task", () => [message("Usage: task progress <id> [+N | N]")]);
    await expect(task.execute("1", { action: "progress" })).rejects.toThrow("Usage: task progress");
  });
});

describe("dead-end replies say what to do next", () => {
  let fixture: ReturnType<typeof createTestEngine>;
  beforeAll(() => {
    fixture = createTestEngine();
  });
  afterAll(() => fixture.dispose());

  const run = async (who: ReturnType<typeof fixture.login>, command: string) => {
    who.connection.clear();
    await fixture.engine.processCommand(who.entityId, command);
    return stripAnsi(who.connection.allTextJoined());
  };

  it("pool not found points at pool list / pool create", async () => {
    const alice = fixture.login("Alice");
    expect(await run(alice, "pool nowhere recall x")).toContain("pool create nowhere");
  });

  it("note verify: verified points at ratify; unknown and foreign notes are told apart", async () => {
    const alice = fixture.login("Alicia");
    const bob = fixture.login("Bobby");
    await run(alice, "note The bridge is sound");
    const id = fixture.db.getNotesByEntity("Alicia", 1)[0]!.id;
    expect(await run(alice, `note verify ${id} verified`)).toContain("ratify");
    expect(await run(alice, "note verify 999999 disputed")).toContain("Note #999999 not found");
    expect(await run(bob, `note verify ${id} disputed`)).toMatch(/not found|not yours/);
    const help = await run(alice, "help catalog note");
    expect(help).not.toContain(" verified [");
  });

  it("canvas post reply: rejects an unknown node id without a database error", async () => {
    const alice = fixture.login("Canva");
    await run(alice, "canvas create board1");
    await run(alice, "canvas post on:board1 first");
    const reply = await run(alice, "canvas post on:board1 reply:nope second");
    expect(reply).toContain('Unknown node id "nope"');
    expect(reply).not.toContain("FOREIGN KEY");
    const node = fixture.db.getNodesByCanvas(fixture.db.getCanvasByName("board1")!.id)[0]!;
    const ok = await run(alice, `canvas post on:board1 reply:${node.id.slice(0, 8)}.. second`);
    expect(ok).toContain("Posted to canvas");
  });

  it("help catalog is compact text, filterable, with the full manifest as data", async () => {
    const alice = fixture.login("Cata");
    alice.connection.clear();
    await fixture.engine.processCommand(alice.entityId, "help catalog");
    const all = alice.connection.messages.at(-1)!;
    expect(Buffer.byteLength(String(all.data.text))).toBeLessThan(20_000);
    expect((all.data.capabilities as { commands: unknown[] }).commands.length).toBeGreaterThan(50);
    alice.connection.clear();
    await fixture.engine.processCommand(alice.entityId, "help catalog task request_id:r1");
    const one = alice.connection.messages.at(-1)!;
    expect(String(one.data.text)).toContain("task create");
    expect(one.data.capabilities).toMatchObject({ request_id: "r1", commands: [{ name: "task" }] });
    expect(await run(alice, "help catalog nosuchcommand")).toContain('No command "nosuchcommand"');
    const json = JSON.parse(await run(alice, "help catalog task json"));
    expect(json.commands.map((c: { name: string }) => c.name)).toEqual(["task"]);
  });
});
