// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Agent tool failures seen on a fresh world, each held to its fix: a seeded
 * multi-word project and its pool resolve however they are typed; refusals
 * say why and what to do next, and record failed usage; a deferred tool
 * called by name runs; a run-cap cut never drops the agent's closing call.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { closingToolCall, RUN_CAP_CLOSING_GRACE } from "../src/agent/budget-terminal";
import { LeanAgentAdapter } from "../src/agent/lean-agent-adapter";
import {
  applyEnumArgumentHints,
  createCommandTool,
  createScopedTools,
  createWorldTools,
  TOOL_SEARCH_NAME,
} from "../src/agent/tools";
import { createCodeTool } from "../src/agent/tools/code";
import { UNKNOWN_VERB_EQUIVALENTS } from "../src/engine/command-phase-coordinator";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { CommandError } from "../src/sdk/client";
import { type EntityId, roomId } from "../src/types";
import { seedBoard, seedProject } from "../worlds/seed";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi, tempDbPath } from "./helpers";

const TEST_DB = tempDbPath("test_agent_tool_failures.db");

describe("fresh-world command surface", () => {
  let db: MarinaDB;
  let engine: Engine;

  const run = async (conn: MockConnection, text: string) => {
    conn.clear();
    await engine.processCommand(conn.entity as EntityId, text);
    return stripAnsi(conn.allTextJoined());
  };
  const join = (id: string, name: string, rank = 0) => {
    const conn = new MockConnection(`c-${name}`);
    db.createUser({ id, name });
    engine.addConnection(conn);
    engine.spawnEntity(conn.id, name);
    engine.entities.get(conn.entity as EntityId)!.properties.rank = rank;
    return conn;
  };
  const usage = (actor: string) => {
    const raw = new Database(TEST_DB, { readonly: true });
    try {
      return raw
        .query("SELECT primitive, success FROM primitive_usage WHERE actor_name = ? ORDER BY id")
        .all(actor) as { primitive: string; success: number }[];
    } finally {
      raw.close();
    }
  };

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    seedProject(db, {
      name: "Demo Pulse",
      description: "A seeded project with a two-word name.",
      orchestration: "pipeline",
      tasks: [
        { title: "Explain the world", description: "One paragraph.", validationMode: "single" },
      ],
      poolNotes: [{ content: "Every submission cites evidence.", importance: 9 }],
    });
    seedBoard(db, "demo-scenarios", { title: "Brief", body: "Turn the brief into a plan." });
  });

  afterEach(() => {
    engine.stop();
    db.close();
    cleanupDb(TEST_DB);
  });

  it("a multi-word project resolves bare, quoted, any case, with show/info verbs", async () => {
    const a = join("u_a", "Ann");
    for (const form of [
      "project Demo Pulse",
      'project "Demo Pulse"',
      "project demo pulse show",
      "project show Demo Pulse",
      'project info "Demo Pulse"',
    ]) {
      const out = await run(a, form);
      expect(out, form).toContain("Project: Demo Pulse");
    }
    expect(await run(a, 'project "Demo Pulse" tasks')).not.toContain("not found");
    expect(await run(a, "project help")).toContain("Usage: project");
  });

  it("project info names the pool that exists, and every spelling of it resolves", async () => {
    const a = join("u_a", "Ann");
    const info = await run(a, "project Demo Pulse");
    const pool = db.getMemoryPoolById(db.getProjectByName("Demo Pulse")!.pool_id!)!.name;
    expect(info).toContain(`Pool: ${pool}`);
    // The pool is members-only: the refusal names the join.
    expect(await run(a, `pool ${pool} recall evidence`)).toContain("project Demo Pulse join");
    await run(a, "project Demo Pulse join");
    for (const name of [pool, `"${pool}"`, "Demo Pulse", "project:Demo Pulse"]) {
      const out = await run(a, `pool ${name} recall evidence`);
      expect(out, name).toContain("Every submission cites evidence");
    }
    // Verb-first order reads as `pool <name> recall …`.
    expect(await run(a, `pool recall ${pool} evidence`)).toContain("cites evidence");
    // A missing pool is still refused, and the refusal is failed usage.
    expect(await run(a, "pool nowhere recall x")).toContain('Pool "nowhere" not found');
    expect(usage("Ann").at(-1)?.success).toBe(0);
  });

  it("a bare board name, or show/history, reads the board", async () => {
    const a = join("u_a", "Ann");
    for (const form of ["board demo-scenarios", "board history demo-scenarios"]) {
      expect(await run(a, form), form).toContain("Brief");
    }
    expect(await run(a, "board nope")).toContain("Unknown board subcommand");
  });

  it("task refusals say why and what next, and record failed usage", async () => {
    const creator = join("u_c", "Cara");
    const worker = join("u_w", "Wes");
    const other = join("u_o", "Otto");
    const id = db.createTask({ title: "T", creatorId: creator.entity!, creatorName: "Cara" });

    expect(await run(other, `task submit ${id} ANSWER: 4`)).toContain(`task claim ${id}`);
    expect(await run(worker, `task claim ${id}`)).toContain(`Claimed task #${id}`);
    expect(await run(other, `task claim ${id}`)).toContain("Wes (claimed)");
    expect(await run(worker, `task claim ${id}`)).toContain("you already hold it");
    expect(await run(worker, `task submit ${id} ANSWER: 4`)).toContain("Submitted");
    expect(await run(worker, `task submit ${id} ANSWER: 5`)).toContain("already submitted");

    expect(await run(creator, `task approve ${id}`)).toContain(`pending on #${id}: Wes`);
    const refused = await run(other, `task approve ${id} Wes`);
    expect(refused).toContain("Cannot approve");
    expect(refused).toContain("creator (Cara)");
    expect(db.getTask(id)!.status).not.toBe("completed");
    // The refused approve is recorded as a failure, not a success.
    expect(usage("Otto").at(-1)).toMatchObject({ success: 0 });
    expect(await run(creator, `task approve ${id} Wes`)).toContain("Approved Wes's submission");
    expect(usage("Cara").at(-1)).toMatchObject({ success: 1 });
  });

  it("a tell to a known account that is offline names the routes that reach it", async () => {
    const a = join("u_a", "Ann");
    db.createUser({ id: "u_gone", name: "Overseer" });
    const out = await run(a, "tell Overseer done");
    expect(out).toContain('"Overseer" is offline');
    expect(out).toContain("board post");
    expect(await run(a, "tell Nobody hi")).toContain('No one named "Nobody" is online');
  });

  it("verbs from other shells name the command that does it here", async () => {
    const a = join("u_a", "Ann");
    expect(await run(a, "whoami")).toContain("Use `score`");
    expect(await run(a, "inbox")).toContain("`tell inbox`");
    expect(await run(a, "focus set x")).toContain("`memory set focus <text>`");
    expect(await run(a, "memory search x")).toContain("`memory recall <query>`");
    const builtins = new Set(engine.commands.allBuiltins().map((def) => def.name));
    for (const target of Object.values(UNKNOWN_VERB_EQUIVALENTS)) {
      for (const [, verb] of target.matchAll(/`([a-z]+)/g))
        expect(builtins.has(verb!), verb).toBe(true);
    }
  });
});

describe("agent tool surface", () => {
  it("a refusal echoed as output is stated once, not as partial output", () => {
    const echo = (text: string) => ({ kind: "message", timestamp: 1, data: { text } }) as never;
    const single = new CommandError("Unknown command: whoami", [
      echo('Unknown command: whoami. Use `score` (your profile). Type "help" for commands.'),
    ]);
    expect(single.message).toStartWith("Unknown command: whoami. Use `score`");
    expect(single.message).not.toContain("Partial command output");
    const batch = new CommandError("Unknown command: no", [
      echo("Recorded #13."),
      echo('Unknown command: no. Did you mean "go"?'),
    ]);
    expect(batch.message).toStartWith('Unknown command: no. Did you mean "go"?');
    expect(batch.message).toContain("Partial command output");
    expect(batch.message).toContain("Recorded #13.");
    expect(batch.message.match(/Unknown command: no/g)).toHaveLength(1);
  });

  it("a rejected command's partial output reaches the agent without ANSI", async () => {
    const coloured = (text: string) => ({ kind: "message", timestamp: 1, data: { text } }) as never;
    const rejection = () =>
      new CommandError("Unknown command: #286", [
        coloured("\x1b[1m\x1b[36mTask \x1b[1m\x1b[33m#118\x1b[0m: claimed."),
        coloured("\x1b[31mUnknown command: #286\x1b[0m"),
      ]);
    const ctx = {
      client: {
        isConnected: () => true,
        command: async () => {
          throw rejection();
        },
        capabilities: async () => ({ commands: [] }),
      },
      gameState: { handlePerception: () => {} },
    } as never;
    const plain = (message: string) => {
      expect(message).not.toContain("\x1b");
      expect(message).toContain("Partial command output");
      expect(message).toContain("Task #118: claimed.");
    };
    // The error path that marina_batch, marina_command and every wrapped tool share.
    const batch = createWorldTools(ctx).find((t) => t.name === "marina_batch")!;
    const error = await batch.execute("1", { commands: "task claim 118; #286" }).then(
      () => undefined,
      (err: Error) => err,
    );
    expect(error).toBeInstanceOf(CommandError);
    plain(error!.message);
    const command = await createCommandTool(ctx)
      .execute("2", { command: "batch task claim 118; #286" })
      .then(
        () => undefined,
        (err: Error) => err,
      );
    plain(command!.message);
    // Tools that report a failure as a result rather than throwing.
    const code = await createCodeTool(ctx).execute("3", { action: "status" } as never);
    plain((code.content[0] as { text: string }).text);
  });

  it("marina_tool_search matches a multi-word query word by word", async () => {
    const live: AgentTool[] = [];
    const resident = createScopedTools(
      { client: { isConnected: () => true }, gameState: { handlePerception: () => {} } } as never,
      {} as never,
      "full",
      { text: true },
      { onLoadTools: (tools) => live.push(...tools) },
    );
    const loader = resident.find((t) => t.name === TOOL_SEARCH_NAME)!;
    await loader.execute("1", { query: "code run python" });
    expect(live[0]?.name).toStartWith("marina_code");
  });

  it("a wrong enum argument names the allowed values; a case variant is normalised", () => {
    const [tool] = applyEnumArgumentHints([
      {
        name: "memory",
        label: "m",
        description: "m",
        parameters: Type.Object({ action: Type.String({ enum: ["write", "rest", "wake"] }) }),
        execute: async () => ({ content: [], details: {} }),
      } as AgentTool,
    ]);
    expect(() => tool!.prepareArguments!({ action: "delete" })).toThrow("write|rest|wake");
    expect(tool!.prepareArguments!({ action: "Rest" })).toEqual({ action: "rest" });
  });

  it("a deferred tool called by name is executable and then declared", () => {
    const adapter = new LeanAgentAdapter({ name: "deferred-direct" }, "ws://127.0.0.1:3300", null);
    const inner = adapter as unknown as {
      agent: { state: { tools: AgentTool[] } };
      withDeferredExecutable(context: {
        messages: unknown[];
        tools?: AgentTool[];
      }): { context: { tools: AgentTool[] } } | undefined;
      loadCalledDeferredTool(name: string): void;
      prepareNextTurn(context: unknown): Promise<{ context: { tools: AgentTool[] } }>;
    };
    const declared = inner.agent.state.tools.slice();
    expect(declared.some((t) => t.name === "marina_who")).toBe(false);
    const request = inner.withDeferredExecutable({ messages: [], tools: declared });
    expect(request?.context.tools.some((t) => t.name === "marina_who")).toBe(true);
    inner.loadCalledDeferredTool("marina_who");
    expect(inner.agent.state.tools.some((t) => t.name === "marina_who")).toBe(true);
    expect(adapter.loadedTools).toContain("marina_who");
  });

  it("the next turn executes exactly the declared tools", async () => {
    const adapter = new LeanAgentAdapter({ name: "deferred-turn" }, "ws://127.0.0.1:3300", null);
    const inner = adapter as unknown as {
      agent: { state: { tools: AgentTool[] } };
      prepareNextTurn(context: unknown): Promise<{ context: { tools: AgentTool[] } }>;
    };
    const widened = [...inner.agent.state.tools, { name: "marina_who" } as AgentTool];
    const next = await inner.prepareNextTurn({ context: { messages: [], tools: widened } });
    expect(next.context.tools.map((t) => t.name)).toEqual(
      inner.agent.state.tools.map((t) => t.name),
    );
  });

  it("past the run cap only closing calls run, and only a few", () => {
    expect(closingToolCall("marina_command", { command: "memory set rest done" })).toBe(true);
    expect(closingToolCall("marina_command", { command: "task submit 4 ANSWER: 2" })).toBe(true);
    expect(closingToolCall("memory", { action: "write", content: "x" })).toBe(true);
    expect(closingToolCall("marina_command", { command: "task list" })).toBe(false);
    expect(closingToolCall("marina_tell", { target: "a", message: "b" })).toBe(false);
    expect(RUN_CAP_CLOSING_GRACE).toBeLessThanOrEqual(3);
  });
});
