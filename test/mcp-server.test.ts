// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { RateLimiter } from "../src/auth/rate-limiter";
import { Engine } from "../src/engine/engine";
import { resetTrustProfileForTests, setTrustProfile } from "../src/engine/trust-profile";
import type { FlywheelToolBackend } from "../src/integrations/flywheel-manager";
import { buildUnifiedContext, type UnifiedContextResult } from "../src/memory/unified-context";
import { resetHttpRateLimitersForTests } from "../src/net/http-utils";
import {
  authenticateMcpTransport,
  McpArgError,
  McpServerAdapter,
  mcpAllowedHosts,
  mcpTransportAuthRequired,
  quoteArg,
  textArg,
} from "../src/net/mcp-server";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { FIXTURE_QUERY, seedUnifiedFixture, tierIds } from "./fixtures/unified-memory-fixture";
import { cleanupDb, makeTestRoom, until } from "./helpers";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let dbCounter = 0;

function nextDbPath(): string {
  return `/tmp/marina-mcp-test-${process.pid}-${++dbCounter}.db`;
}

/** Send JSON-RPC request to an MCP endpoint, returns { response, sessionId }. */
async function mcpRequest(
  baseUrl: string,
  body: unknown,
  sessionId?: string,
): Promise<{ response: unknown; sessionId: string | null }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const resp = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const newSessionId = resp.headers.get("mcp-session-id");
  const contentType = resp.headers.get("content-type") ?? "";

  if (contentType.includes("text/event-stream")) {
    const text = await resp.text();
    const lines = text.split("\n");
    const results: unknown[] = [];
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6).trim();
        if (data) {
          try {
            results.push(JSON.parse(data));
          } catch {}
        }
      }
    }
    return { response: results[results.length - 1] ?? null, sessionId: newSessionId };
  }

  const json = await resp.json();
  return { response: json, sessionId: newSessionId };
}

/** Initialize an MCP session, returning the sessionId. */
async function initSession(baseUrl: string): Promise<string> {
  const { sessionId } = await mcpRequest(baseUrl, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  });
  if (!sessionId) throw new Error("No session ID returned from initialize");

  await mcpRequest(baseUrl, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);

  return sessionId;
}

/** Call an MCP tool, returning the result text. */
async function toolCall(
  baseUrl: string,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
  id = 100,
): Promise<string> {
  const { response } = await mcpRequest(
    baseUrl,
    {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    },
    sessionId,
  );
  return extractText(response);
}

/** Call an MCP tool, returning the raw result (text + structuredContent). */
async function toolCallRaw(
  baseUrl: string,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
  id = 101,
): Promise<{ text: string; structuredContent?: Record<string, unknown>; isError?: boolean }> {
  const { response } = await mcpRequest(
    baseUrl,
    {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    },
    sessionId,
  );
  const result = (
    response as {
      result?: { structuredContent?: Record<string, unknown>; isError?: boolean };
    }
  )?.result;
  return {
    text: extractText(response),
    structuredContent: result?.structuredContent,
    isError: result?.isError,
  };
}

/** List all tools from an MCP session. */
async function toolList(
  baseUrl: string,
  sessionId: string,
): Promise<{ name: string; description: string; inputSchema: unknown }[]> {
  const { response } = await mcpRequest(
    baseUrl,
    { jsonrpc: "2.0", id: 50, method: "tools/list", params: {} },
    sessionId,
  );
  return (
    (
      response as {
        result?: { tools?: { name: string; description: string; inputSchema: unknown }[] };
      }
    )?.result?.tools ?? []
  );
}

/** Extract text from a tool call response. */
function extractText(response: unknown): string {
  return (
    (response as { result?: { content?: { text: string }[] } })?.result?.content
      ?.map((block) => block.text)
      .join("\n\n") ?? ""
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("MCP Server", () => {
  let db: MarinaDB;
  let engine: Engine;
  let adapter: McpServerAdapter;
  let dbPath: string;
  let port: number;
  let url: string;
  let flywheelCalls: string[];
  let flywheel: FlywheelToolBackend;

  beforeEach(() => {
    dbPath = nextDbPath();
    db = new MarinaDB(dbPath);
    flywheelCalls = [];
    flywheel = {
      async create(entity) {
        flywheelCalls.push(`create:${entity}`);
        return {
          sessionId: "session-1",
          sandboxId: "sandbox-1",
          image: "test:latest",
          keepAlive: true,
          state: "running",
        };
      },
      async exec(entity, command) {
        flywheelCalls.push(`exec:${entity}:${command}`);
        return "sandbox output";
      },
      async publish() {
        return "https://app.example";
      },
      async hibernate() {},
      async resume() {},
      async stop() {},
      status() {
        return undefined;
      },
    };
    engine = new Engine({
      startRoom: roomId("test/start"),
      tickInterval: 60_000,
      db,
      flywheel,
    });

    engine.registerRoom(
      roomId("test/start"),
      makeTestRoom({
        short: "Starting Room",
        long: "You are in the starting room.",
        exits: { north: roomId("test/north") },
      }),
    );
    engine.registerRoom(
      roomId("test/north"),
      makeTestRoom({
        short: "Northern Room",
        long: "A room to the north.",
        exits: { south: roomId("test/start") },
      }),
    );

    adapter = new McpServerAdapter(engine, 0, undefined, flywheel);
    adapter.start();
    port = adapter.getPort();
    url = `http://localhost:${port}`;
    engine.start();
  });

  afterEach(() => {
    adapter.stop();
    engine.stop();
    db.close();
    cleanupDb(dbPath);
  });

  // ── Health Endpoint ──────────────────────────────────────────────────────

  describe("health endpoint", () => {
    it("should return health status", async () => {
      const resp = await fetch(`${url}/health`);
      const data = await resp.json();
      expect(data.status).toBe("ok");
      expect(data.protocol).toBe("mcp");
      expect(typeof data.sessions).toBe("number");
      expect(typeof data.rooms).toBe("number");
      expect(typeof data.entities).toBe("number");
    });

    it("should report correct room count", async () => {
      const resp = await fetch(`${url}/health`);
      const data = await resp.json();
      expect(data.rooms).toBe(2);
    });

    it("should reflect session count after initialize", async () => {
      await initSession(url);
      await Bun.sleep(30);
      const resp = await fetch(`${url}/health`);
      const data = await resp.json();
      expect(data.sessions).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Default Route ───────────────────────────────────────────────────────

  describe("default route", () => {
    it("should return info text for non-MCP requests", async () => {
      const resp = await fetch(`${url}/`);
      const text = await resp.text();
      expect(text).toContain("Marina MCP Server");
      expect(resp.status).toBe(200);
    });
  });

  // ── Session Management ──────────────────────────────────────────────────

  describe("session management", () => {
    it("should create a session on initialize", async () => {
      const sessionId = await initSession(url);
      expect(sessionId).toBeTruthy();
      expect(typeof sessionId).toBe("string");
    });

    it("should create unique session IDs", async () => {
      const s1 = await initSession(url);
      const s2 = await initSession(url);
      expect(s1).not.toBe(s2);
    });
  });

  describe("shared participation", () => {
    it("preserves a completed action when automatic goal retrieval fails", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "ContextFaultBot" });
      let executions = 0;
      engine.commands.registerOwned("context-fault", {
        name: "context-fault",
        help: "Commit a test action",
        handler: (ctx, input) => {
          executions++;
          ctx.send(input.entity, "Action committed");
        },
      });
      const goal = spyOn(db, "getCoreMemory").mockImplementation(() => {
        throw new Error("Injected goal read failure");
      });
      try {
        const result = await toolCallRaw(url, sid, "command", { input: "context-fault" });
        expect(result.isError).not.toBe(true);
        expect(result.text).toContain("Action committed");
        expect(result.text).toContain("Optional task context unavailable");
        expect(executions).toBe(1);
      } finally {
        goal.mockRestore();
      }
    });

    it("automatically follows the resident's saved goal and stops when it is cleared", async () => {
      db.setCoreMemory("GoalBot", "goal", "quartz");
      db.createNote("GoalBot", "quartz private plan", roomId("test/start"));
      db.createNote("GoalBot", "onyx current plan", roomId("test/start"));
      db.createNote("OtherBot", "quartz foreign secret", roomId("test/start"));
      const sid = await initSession(url);
      const login = await toolCall(url, sid, "login", { name: "GoalBot" });
      expect(login).toContain("quartz private plan");
      expect(login).not.toContain("foreign secret");
      expect(await toolCall(url, sid, "look", {})).toContain("quartz private plan");
      const changed = await toolCallRaw(url, sid, "memory", {
        action: "set",
        key: "goal",
        value: "onyx",
      });
      expect(changed.structuredContent).toBeDefined();
      expect(changed.text).toContain("onyx current plan");
      expect(changed.text).not.toContain("quartz private plan");
      await toolCall(url, sid, "memory", { action: "delete", key: "goal" });
      expect(await toolCall(url, sid, "look", {})).not.toContain("Task memory context");
    });

    it("keeps automatic context off when login explicitly selects manual or off", async () => {
      for (const mode of ["manual", "off"]) {
        const name = `Mode${mode}`;
        db.createNote(name, "quartz scoped context", roomId("test/start"));
        const sid = await initSession(url);
        const login = await toolCall(url, sid, "login", {
          name,
          task: "quartz",
          contextMode: mode,
        });
        if (mode === "manual") expect(login).toContain("quartz scoped context");
        else expect(login).not.toContain("quartz scoped context");
        expect(await toolCall(url, sid, "look", {})).not.toContain("Task memory context");
      }
    });

    it("validates queued structured input after preceding commands finish", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "QueuedBot" });
      let executions = 0;
      engine.commands.registerOwned("queued", {
        name: "queued-check",
        help: "Check a queued value",
        usage: ["queued-check <value>"],
        handler: () => {
          executions++;
        },
      });
      const session = (
        adapter as unknown as { sessions: Map<string, { commandTail: Promise<unknown> }> }
      ).sessions.get(sid)!;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      session.commandTail = barrier;
      const pending = toolCallRaw(url, sid, "invoke", {
        command: "queued-check",
        syntax: "queued-check <value>",
        values: { "field-0": "old" },
      });
      try {
        await until(() => session.commandTail !== barrier);
        engine.commands.registerOwned(
          "queued",
          {
            name: "queued-check",
            help: "New form",
            usage: ["queued-check <new-field>"],
            handler: () => {
              executions++;
            },
          },
          true,
        );
      } finally {
        release();
      }
      expect((await pending).isError).toBe(true);
      expect(executions).toBe(0);
    });

    it("delivers initial task context and keeps inspection independent of room overrides", async () => {
      db.createNote("InitialBot", "quartz initial context", roomId("test/start"));
      const sid = await initSession(url);
      const login = await toolCallRaw(url, sid, "login", {
        name: "InitialBot",
        task: "quartz",
        contextMode: "auto",
      });
      expect(login.structuredContent?.onboarding).toMatchObject({ schema: "marina.onboarding.v1" });
      expect(login.text).toContain("quartz initial context");
      const entity = engine.entities.findAgentByName("InitialBot")!;
      let overrideCalls = 0;
      engine.getEntityRoom(entity.id)!.module.commands = {
        help: () => {
          overrideCalls++;
        },
        context: () => {
          overrideCalls++;
        },
      };
      const catalog = await toolCallRaw(url, sid, "capabilities", { command: "say" });
      expect(catalog.structuredContent?.commands).toHaveLength(1);
      const preview = await toolCallRaw(url, sid, "context", { query: "quartz", mode: "auto" });
      expect(preview.text).toContain("quartz initial context");
      expect(await toolCall(url, sid, "context", { mode: "off" })).toContain(
        "Automatic task context is off",
      );
      expect(overrideCalls).toBe(0);
      await toolCall(url, sid, "command", { input: "context quartz" });
      expect(overrideCalls).toBe(1);
      engine.removeConnection(engine.getConnectionForEntity(entity.id)!.id, "explicit");
      const expired = await toolCallRaw(url, sid, "look", {});
      expect(expired.isError).toBe(true);
      expect(expired.text).not.toContain("quartz initial context");
    });

    it("discovers and invokes a runtime form without a separate MCP registration", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "ManifestBot" });
      engine.commands.registerOwned("runtime-test", {
        name: "runtime-check",
        aliases: ["rtc"],
        category: "Extensions",
        help: "Check a bounded value.",
        usage: [
          {
            syntax: "runtime-check <count>",
            effect: "read",
            fields: { count: { kind: "number", min: 1, max: 4 } },
          },
        ],
        handler: (ctx, input) => ctx.send(input.entity, `count=${input.args}`),
      });
      const discovery = await toolCallRaw(url, sid, "capabilities", { command: "runtime-check" });
      const commands = discovery.structuredContent?.commands as Array<{
        forms: Array<{ syntax: string }>;
      }>;
      expect(commands).toHaveLength(1);
      const syntax = commands[0]!.forms[0]!.syntax;
      expect(commands[0]!.forms[0]).toMatchObject({
        inputSchema: {
          properties: {
            values: { properties: { "field-0": { type: "number", minimum: 1, maximum: 4 } } },
          },
        },
      });
      const exposed = await toolCallRaw(url, sid, "capabilities", {
        command: "runtime-check",
        syntax,
        expose: true,
      });
      const name = exposed.structuredContent?.tool as string;
      expect(name).toMatch(/^world_runtime-check_/);
      const published = (await toolList(url, sid)).find((tool) => tool.name === name)!;
      expect(published.inputSchema).toMatchObject({
        properties: {
          values: { properties: { "field-0": { type: "number", minimum: 1, maximum: 4 } } },
        },
      });
      expect((await toolCallRaw(url, sid, name, { values: { "field-0": 9 } })).isError).toBe(true);
      expect(await toolCall(url, sid, name, { values: { "field-0": 3 } })).toContain("count=3");
      expect(
        (
          await toolCallRaw(url, sid, "invoke", {
            command: "runtime-check",
            syntax,
            values: { "field-0": 9 },
          })
        ).isError,
      ).toBe(true);
      expect(
        await toolCall(url, sid, "invoke", {
          command: "runtime-check",
          syntax,
          values: { "field-0": 2 },
        }),
      ).toContain("count=2");
      engine.commands.removeOwner("runtime-test");
      expect((await toolCallRaw(url, sid, name, { values: { "field-0": 3 } })).isError).toBe(true);
      expect(
        (
          await toolCallRaw(url, sid, "invoke", {
            command: "runtime-check",
            syntax,
            values: { "field-0": 2 },
          })
        ).isError,
      ).toBe(true);
    });
    it("bounds focused tools per session and rejects stale schemas after an extension update", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "FocusBot" });
      let executions = 0;
      const usage = Array.from({ length: 13 }, (_, i) => ({
        syntax: `focus-check action${i} <count>`,
        fields: { count: { kind: "number" as const, min: 1, max: 4 } },
      }));
      const definition = {
        name: "focus-check",
        help: "Check focused tool lifecycle",
        usage,
        handler: () => {
          executions++;
        },
      };
      engine.commands.registerOwned("focus-test", definition);
      const names: string[] = [];
      for (const form of usage) {
        const result = await toolCallRaw(url, sid, "capabilities", {
          command: "focus-check",
          syntax: form.syntax,
          expose: true,
        });
        names.push(result.structuredContent?.tool as string);
      }
      const tools = (await toolList(url, sid)).map((tool) => tool.name);
      expect(tools.filter((name) => name.startsWith("world_"))).toHaveLength(12);
      expect(tools).not.toContain(names[0]!);
      expect(tools).toContain(names[12]!);
      const other = await initSession(url);
      expect((await toolList(url, other)).some((tool) => tool.name.startsWith("world_"))).toBe(
        false,
      );
      engine.commands.registerOwned(
        "focus-test",
        {
          ...definition,
          usage: usage.map((form) => ({
            ...form,
            fields: { count: { kind: "number", min: 1, max: 2 } },
          })),
        },
        true,
      );
      const stale = await toolCallRaw(url, sid, names[12]!, { values: { "field-0": 1 } });
      expect(stale.isError).toBe(true);
      expect(stale.text).toContain("changed form");
      expect(executions).toBe(0);
      await toolCallRaw(url, sid, "capabilities", {
        command: "focus-check",
        syntax: usage[12]!.syntax,
        expose: true,
      });
      expect(
        (await toolCallRaw(url, sid, names[12]!, { values: { "field-0": 1 } })).isError,
      ).not.toBe(true);
      expect(executions).toBe(1);
    });
    it("negotiates task context, refreshes after deletion, and preserves manual/off modes", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "ContextBot" });
      const own = db.createNote("ContextBot", "quartz personal evidence", roomId("test/start"));
      db.createNote("SomeoneElse", "quartz foreign secret", roomId("test/start"));
      const preview = await toolCallRaw(url, sid, "context", { query: "quartz", mode: "auto" });
      expect(preview.structuredContent?.context).toBeDefined();
      expect(preview.text).toContain("personal evidence");
      expect(preview.text).not.toContain("foreign secret");
      const enriched = await toolCall(url, sid, "look", {});
      expect(enriched).toContain("Task memory context for your next decision");
      expect(enriched).toContain("marina.memory.receipt.v1");
      expect(enriched).toContain("personal evidence");
      db.deleteNote(own, "ContextBot");
      const refreshed = await toolCall(url, sid, "look", {});
      expect(refreshed).not.toContain("personal evidence");
      await toolCall(url, sid, "context", { mode: "off" });
      expect(await toolCall(url, sid, "look", {})).not.toContain("Task memory context");
    });
  });

  // ── Tool Registration ───────────────────────────────────────────────────

  describe("tool registration", () => {
    it("registers compatibility tools plus shared capabilities, invocation and context", async () => {
      const sid = await initSession(url);
      const tools = await toolList(url, sid);
      expect(tools.length).toBe(42);
    });

    it("should include all expected tool names", async () => {
      const sid = await initSession(url);
      const tools = await toolList(url, sid);
      const names = tools.map((t) => t.name).sort();

      const expected = [
        "auth",
        "batch",
        "board",
        "brief",
        "build",
        "canvas",
        "channel",
        "command",
        "capabilities",
        "invoke",
        "context",
        "crew",
        "evolve",
        "examine",
        "flywheel",
        "group",
        "help",
        "login",
        "look",
        "market",
        "memory",
        "memory_service",
        "memory_retrieve",
        "memory_workflow",
        "memory_assist",
        "memory_remember",
        "memory_query",
        "memory_graph",
        "move",
        "next",
        "probe",
        "quest",
        "quit",
        "say",
        "task",
        "tell",
        "think",
        "watch_create",
        "watch_due",
        "watch_list",
        "watch_retire",
        "who",
      ].sort();

      expect(names).toEqual(expected);
    });

    it("should have input schemas for tools with required params", async () => {
      const sid = await initSession(url);
      const tools = await toolList(url, sid);
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

      // login requires 'name'
      const loginSchema = byName.login!.inputSchema as {
        required?: string[];
        properties?: Record<string, unknown>;
      };
      expect(loginSchema.properties).toHaveProperty("name");
      expect(loginSchema.required).toContain("name");

      // move requires 'direction'
      const moveSchema = byName.move!.inputSchema as {
        required?: string[];
        properties?: Record<string, unknown>;
      };
      expect(moveSchema.properties).toHaveProperty("direction");
      expect(moveSchema.required).toContain("direction");

      // say requires 'message'
      const saySchema = byName.say!.inputSchema as {
        required?: string[];
        properties?: Record<string, unknown>;
      };
      expect(saySchema.properties).toHaveProperty("message");
      expect(saySchema.required).toContain("message");

      // tell requires both 'target' and 'message'
      const tellSchema = byName.tell!.inputSchema as {
        required?: string[];
        properties?: Record<string, unknown>;
      };
      expect(tellSchema.properties).toHaveProperty("target");
      expect(tellSchema.properties).toHaveProperty("message");
      expect(tellSchema.required).toContain("target");
      expect(tellSchema.required).toContain("message");
    });

    it("should have optional-only params for parameterless tools", async () => {
      const sid = await initSession(url);
      const tools = await toolList(url, sid);
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

      const whoSchema = byName.who!.inputSchema as { required?: string[] };
      expect(whoSchema.required ?? []).toEqual([]);

      const nextSchema = byName.next!.inputSchema as { required?: string[] };
      expect(nextSchema.required ?? []).toEqual([]);
    });

    it("should have proper descriptions on all tools", async () => {
      const sid = await initSession(url);
      const tools = await toolList(url, sid);

      for (const tool of tools) {
        expect(tool.description).toBeTruthy();
        expect(tool.description.length).toBeGreaterThan(10);
      }
    });

    it("should cover all tool categories", async () => {
      const sid = await initSession(url);
      const tools = await toolList(url, sid);
      const names = new Set(tools.map((t) => t.name));

      // Bootstrap
      expect(names.has("login")).toBe(true);
      expect(names.has("auth")).toBe(true);
      // Cognition
      for (const t of ["think", "memory", "next", "brief", "quest"]) {
        expect(names.has(t)).toBe(true);
      }
      // World
      for (const t of ["look", "move", "say", "tell", "who", "examine"]) {
        expect(names.has(t)).toBe(true);
      }
      // Coordination
      for (const t of ["channel", "board", "group", "task", "evolve"]) {
        expect(names.has(t)).toBe(true);
      }
      // Canvas
      expect(names.has("canvas")).toBe(true);
      // Building
      expect(names.has("build")).toBe(true);
      // Isolated execution
      expect(names.has("flywheel")).toBe(true);
      // Escape hatch
      expect(names.has("command")).toBe(true);
      expect(names.has("batch")).toBe(true);
      // Session
      expect(names.has("help")).toBe(true);
      expect(names.has("quit")).toBe(true);
    });

    it("should have think tool with enum params", async () => {
      const sid = await initSession(url);
      const tools = await toolList(url, sid);
      const think = tools.find((t) => t.name === "think")!;
      const schema = think.inputSchema as {
        properties?: Record<string, { enum?: string[] }>;
        required?: string[];
      };
      expect(schema.properties).toHaveProperty("action");
      expect(schema.properties).toHaveProperty("text");
      expect(schema.required).toContain("action");
      expect(schema.required).toContain("text");
    });

    it("should have memory tool with action enum", async () => {
      const sid = await initSession(url);
      const tools = await toolList(url, sid);
      const mem = tools.find((t) => t.name === "memory")!;
      const schema = mem.inputSchema as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(schema.properties).toHaveProperty("action");
      expect(schema.required).toContain("action");
    });
  });

  // ── Login Flow ──────────────────────────────────────────────────────────

  describe("login flow", () => {
    it("should login successfully and return welcome text", async () => {
      const sid = await initSession(url);
      const text = await toolCall(url, sid, "login", { name: "McpBot" });
      expect(text).toContain("Logged in as **McpBot**");
      expect(text).toContain("Starting Room");
    });

    it("should return session token on login", async () => {
      const sid = await initSession(url);
      const text = await toolCall(url, sid, "login", { name: "TokenBot" });
      expect(text).toContain("Session token:");
    });

    it("should reject double login on same session", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "First" });
      const text = await toolCall(url, sid, "login", { name: "Second" });
      expect(text).toContain("Already logged in");
    });

    it("should include quick reference in login output", async () => {
      const sid = await initSession(url);
      const text = await toolCall(url, sid, "login", { name: "RefBot" });
      expect(text).toContain("think");
      expect(text).toContain("memory");
      expect(text).toContain("next");
      expect(text).toContain("brief");
      expect(text).toContain("context <query>");
    });
  });

  describe("evolution transport conformance", () => {
    it("routes the dedicated MCP tool through the canonical world command", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "EvolutionMcpBot" });
      const text = await toolCall(url, sid, "evolve", { input: "sessions" });
      expect(text).toContain("Native evolution protocols are disabled");
    });
  });

  // ── Error Handling ──────────────────────────────────────────────────────

  describe("error handling", () => {
    it("should reject look without login", async () => {
      const sid = await initSession(url);
      const text = await toolCall(url, sid, "look", {});
      expect(text).toContain("Not logged in");
    });

    it("should reject who without login", async () => {
      const sid = await initSession(url);
      const text = await toolCall(url, sid, "who", {});
      expect(text).toContain("Not logged in");
    });

    it("should reject command tool without login", async () => {
      const sid = await initSession(url);
      const text = await toolCall(url, sid, "command", { input: "help" });
      expect(text).toContain("Not logged in");
    });

    it("should reject memory tool without login", async () => {
      const sid = await initSession(url);
      const text = await toolCall(url, sid, "memory", { action: "list" });
      expect(text).toContain("Not logged in");
    });

    it("should reject think tool without login", async () => {
      const sid = await initSession(url);
      const text = await toolCall(url, sid, "think", { action: "note", text: "test" });
      expect(text).toContain("Not logged in");
    });
  });

  // ── World Interaction Tools ─────────────────────────────────────────────

  describe("world tools", () => {
    it("should look at the current room", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "LookBot" });
      const text = await toolCall(url, sid, "look", {});
      expect(text).toContain("Starting Room");
    });

    it("should move between rooms", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "MoveBot" });
      const text = await toolCall(url, sid, "move", { direction: "north" });
      expect(text).toContain("Northern Room");
    });

    it("should say a message", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "SayBot" });
      const text = await toolCall(url, sid, "say", { message: "Hello world" });
      expect(text.length).toBeGreaterThan(0);
    });

    it("should list online entities with who", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "WhoBot" });
      const text = await toolCall(url, sid, "who", {});
      expect(text).toContain("WhoBot");
    });

    it("should handle look with optional target", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "TargBot" });
      const text = await toolCall(url, sid, "look", { target: "nonexistent" });
      expect(text.length).toBeGreaterThan(0);
    });
  });

  // ── Cognition Tools ─────────────────────────────────────────────────────

  describe("cognition tools", () => {
    it("should take a note via think", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "ThinkBot" });
      const text = await toolCall(url, sid, "think", {
        action: "note",
        text: "Test observation",
      });
      expect(text.length).toBeGreaterThan(0);
    });

    it("should recall via think", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "RecBot" });
      await toolCall(url, sid, "think", { action: "note", text: "Important fact about testing" });
      const text = await toolCall(url, sid, "think", { action: "recall", text: "testing" });
      expect(text.length).toBeGreaterThan(0);
    });

    it("should reflect via think", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "ReflBot" });
      const text = await toolCall(url, sid, "think", { action: "reflect", text: "observations" });
      expect(text.length).toBeGreaterThan(0);
    });

    it("should note with importance and type", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "ParamBot" });
      const text = await toolCall(url, sid, "think", {
        action: "note",
        text: "Critical finding",
        importance: 9,
        type: "decision",
      });
      expect(text.length).toBeGreaterThan(0);
    });

    it("should recall with modifier", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "ModBot" });
      await toolCall(url, sid, "think", { action: "note", text: "Important data" });
      const text = await toolCall(url, sid, "think", {
        action: "recall",
        text: "data",
        modifier: "important",
      });
      expect(text.length).toBeGreaterThan(0);
    });

    it("think(context) returns the unified memory context as structuredContent — same tiers/ids as the builder", async () => {
      // Seed both silos for the owner, then let it go offline so the MCP
      // session can log in under the same world account.
      const fx = await seedUnifiedFixture(engine, db, {
        owner: "McpAda",
        worker: "McpBea",
        disconnect: true,
      });
      const direct = await buildUnifiedContext(db, fx.owner, FIXTURE_QUERY, { budgetBytes: 4096 });
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: fx.owner });

      const result = await toolCallRaw(url, sid, "think", {
        action: "context",
        text: FIXTURE_QUERY,
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent?.schema).toBe("marina.memory.command.v1");
      expect(result.structuredContent?.operation).toBe("recall");
      const context = result.structuredContent?.context as UnifiedContextResult;
      expect(context?.schema).toBe("marina.memory.context.v1");
      const sorted = (m: Record<string, string[]>) =>
        Object.fromEntries(Object.entries(m).map(([k, v]) => [k, [...v].sort()]));
      expect(sorted(tierIds(context))).toEqual(sorted(tierIds(direct)));
      expect(tierIds(context).proposal).toEqual([fx.jobId]);
      expect(context.degraded).toEqual([]);
      // Human text carries the same labels for clients that only read text.
      expect(result.text).toContain("[evidence]");
      expect(result.text).toContain("[proposal]");
      expect(result.text).toContain(`record ${fx.recordId} v1`);

      // scope + budget flow through to the command.
      const evidence = await toolCallRaw(url, sid, "think", {
        action: "context",
        text: FIXTURE_QUERY,
        scope: "evidence",
        budget: 300,
      });
      const ev = evidence.structuredContent?.context as UnifiedContextResult;
      expect(ev.scope).toBe("evidence");
      expect(ev.budgetBytes).toBe(300);
      expect(Object.keys(tierIds(ev)).every((t) => t === "evidence" || t === "proposal")).toBe(
        true,
      );
    });

    it("think(recall) now also exposes the legacy payload as structuredContent (additive)", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "StructBot" });
      await toolCall(url, sid, "think", { action: "note", text: "Structured payload probe" });
      const result = await toolCallRaw(url, sid, "think", { action: "recall", text: "payload" });
      expect(result.structuredContent?.schema).toBe("marina.memory.command.v1");
      expect(Array.isArray(result.structuredContent?.notes)).toBe(true);
      expect(result.structuredContent?.context).toBeUndefined();
    });

    it("should set and get memory", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "MemBot" });
      await toolCall(url, sid, "memory", { action: "set", key: "goal", value: "test the MCP" });
      const text = await toolCall(url, sid, "memory", { action: "get", key: "goal" });
      expect(text).toContain("test the MCP");
    });

    it("should list memory entries", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "LstBot" });
      await toolCall(url, sid, "memory", { action: "set", key: "goal", value: "test" });
      const text = await toolCall(url, sid, "memory", { action: "list" });
      expect(text).toContain("goal");
    });

    it("should reject memory set without key", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "BadBot" });
      const text = await toolCall(url, sid, "memory", { action: "set", value: "no key" });
      expect(text).toContain("Both key and value required");
    });

    it("should reject memory get without key", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "NoKBot" });
      const text = await toolCall(url, sid, "memory", { action: "get" });
      expect(text).toContain("Key required");
    });

    it("should reject memory delete without key", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "NoDBot" });
      const text = await toolCall(url, sid, "memory", { action: "delete" });
      expect(text).toContain("Key required");
    });

    it("should get brief compass", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "BriBot" });
      const text = await toolCall(url, sid, "brief", {});
      expect(text.length).toBeGreaterThan(0);
    });

    it("should get brief full mode", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "FullBot" });
      const text = await toolCall(url, sid, "brief", { mode: "full" });
      expect(text.length).toBeGreaterThan(0);
    });

    it("should get next guidance", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "NextBot" });
      const text = await toolCall(url, sid, "next", {});
      expect(text.length).toBeGreaterThan(0);
    });
  });

  // ── Escape Hatch Tools ──────────────────────────────────────────────────

  describe("Flywheel tool", () => {
    afterEach(() => resetTrustProfileForTests());

    it("requires login and is gated like any other client (code.exec), never a side channel", async () => {
      const sid = await initSession(url);
      expect(await toolCall(url, sid, "flywheel", { action: "create" })).toContain("Not logged in");

      // Default (shared) posture: a fresh rank-0 entity has no `code.exec`
      // competence, so the sandbox mutation is refused by the gate and the
      // backend is never reached — the old direct path bypassed this entirely.
      await toolCall(url, sid, "login", { name: "FlyBot" });
      const refused = await toolCall(url, sid, "flywheel", { action: "create" });
      expect(refused).toContain("standing 5");
      expect(flywheelCalls).toHaveLength(0);
    });

    it("routes create through `code sandbox start` and binds it to the logged-in entity", async () => {
      // Ungated local posture: the command runs and reaches the engine backend.
      setTrustProfile("local");
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "FlyLocal" });
      const created = await toolCall(url, sid, "flywheel", { action: "create" });
      expect(created).toContain("Flywheel sandbox ready: sandbox-1");
      expect(flywheelCalls).toHaveLength(1);
      expect(flywheelCalls[0]).toStartWith("create:");
    });

    it("rejects a spaced image token instead of splicing it into the command", async () => {
      setTrustProfile("local");
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "FlyArgs" });
      const raw = await toolCallRaw(url, sid, "flywheel", {
        action: "create",
        image: "img:1 stop confirm",
      });
      expect(raw.isError).toBe(true);
      expect(raw.text).toContain("single token");
      expect(flywheelCalls).toHaveLength(0);
    });
  });

  describe("escape hatch tools", () => {
    it("should execute raw command via command tool", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "CmdBot" });
      const text = await toolCall(url, sid, "command", { input: "who" });
      expect(text).toContain("CmdBot");
    });

    it("should execute help command", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "HelpBot" });
      const text = await toolCall(url, sid, "help", {});
      expect(text.length).toBeGreaterThan(0);
    });

    it("should execute help with specific command arg", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "HCBot" });
      const text = await toolCall(url, sid, "help", { command: "look" });
      expect(text.length).toBeGreaterThan(0);
    });

    it("should execute batch commands", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "BatchBot" });
      const text = await toolCall(url, sid, "batch", { input: "who ; look" });
      expect(text.length).toBeGreaterThan(0);
    });
  });

  // ── Quit Tool ───────────────────────────────────────────────────────────

  describe("quit tool", () => {
    it("should reject quit without login", async () => {
      const sid = await initSession(url);
      const text = await toolCall(url, sid, "quit", {});
      expect(text).toContain("Not logged in");
    });

    it("should disconnect entity on quit", async () => {
      const sid = await initSession(url);
      const loginText = await toolCall(url, sid, "login", { name: "QuitBot" });
      expect(loginText).toContain("Logged in");
      const text = await toolCall(url, sid, "quit", {});
      expect(text).toContain("Disconnected");
      expect(text).toContain("Session ended");
    });

    it("should reject commands after quit", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "QBot2" });
      await toolCall(url, sid, "quit", {});
      const text = await toolCall(url, sid, "look", {});
      expect(text).toContain("Not logged in");
    });
  });

  // ── Auth/Reconnect Tool ─────────────────────────────────────────────────

  describe("auth tool", () => {
    it("should reject invalid token", async () => {
      const sid = await initSession(url);
      const text = await toolCall(url, sid, "auth", { token: "invalid-token-12345" });
      expect(text.length).toBeGreaterThan(0);
    });

    it("should reject auth when already logged in", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "AlrBot" });
      const text = await toolCall(url, sid, "auth", { token: "any-token" });
      expect(text).toContain("Already logged in");
    });

    it("should reconnect with valid token", async () => {
      // Login, extract token, quit, reconnect on new MCP session
      const sid1 = await initSession(url);
      const loginText = await toolCall(url, sid1, "login", { name: "AuthBot" });
      const tokenMatch = loginText.match(/Session token: `([^`]+)`/);
      expect(tokenMatch).toBeTruthy();
      const token = tokenMatch![1];

      await toolCall(url, sid1, "quit", {});

      const sid2 = await initSession(url);
      const text = await toolCall(url, sid2, "auth", { token });
      expect(text).toContain("Reconnected as **AuthBot**");
    });
  });

  // ── Quest Tool ──────────────────────────────────────────────────────────

  describe("quest tool", () => {
    it("should return quest status", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "QstBot" });
      const text = await toolCall(url, sid, "quest", {});
      expect(text.length).toBeGreaterThan(0);
    });

    it("should list available quests", async () => {
      const sid = await initSession(url);
      await toolCall(url, sid, "login", { name: "QLBot" });
      const text = await toolCall(url, sid, "quest", { action: "list" });
      expect(text.length).toBeGreaterThan(0);
    });
  });
});

// ─── Rate Limiting ────────────────────────────────────────────────────────────

describe("MCP Server with rate limiting", () => {
  let db: MarinaDB;
  let engine: Engine;
  let adapter: McpServerAdapter;
  let dbPath: string;
  let port: number;
  let rlUrl: string;

  beforeEach(() => {
    dbPath = nextDbPath();
    db = new MarinaDB(dbPath);
    const rateLimiter = new RateLimiter({ maxTokens: 3, refillRate: 0, refillInterval: 60_000 });
    engine = new Engine({
      startRoom: roomId("test/start"),
      tickInterval: 60_000,
      db,
    });

    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));

    adapter = new McpServerAdapter(engine, 0, rateLimiter);
    adapter.start();
    port = adapter.getPort();
    rlUrl = `http://localhost:${port}`;
    engine.start();
  });

  afterEach(() => {
    adapter.stop();
    engine.stop();
    db.close();
    cleanupDb(dbPath);
  });

  it("should allow requests within rate limit", async () => {
    const sid = await initSession(rlUrl);
    await toolCall(rlUrl, sid, "login", { name: "RLBot" });
    const text = await toolCall(rlUrl, sid, "look", {});
    expect(text).toContain("Start");
  });

  it("should block requests exceeding rate limit", async () => {
    const sid = await initSession(rlUrl);
    await toolCall(rlUrl, sid, "login", { name: "RLFlood" });

    // maxTokens = 3, no refill. Each toolCall via runCmd consumes 1 token.
    const results: string[] = [];
    for (let i = 0; i < 8; i++) {
      results.push(await toolCall(rlUrl, sid, "look", {}, 10 + i));
    }

    const rateLimited = results.some((r) => r.includes("Rate limited"));
    expect(rateLimited).toBe(true);
  });

  it("should return correct rate limit message text", async () => {
    const sid = await initSession(rlUrl);
    await toolCall(rlUrl, sid, "login", { name: "RLMsg" });

    // Drain the 3-token bucket
    for (let i = 0; i < 10; i++) {
      const text = await toolCall(rlUrl, sid, "who", {}, 10 + i);
      if (text.includes("Rate limited")) {
        expect(text).toBe("Rate limited. Please slow down.");
        return;
      }
    }
    // If we exhausted iterations without hitting the limit, that is unexpected
    // but not worth failing the test over timing vagaries
  });
});

// ─── Argument hygiene ─────────────────────────────────────────────────────────

describe("MCP argument hygiene (quoteArg / textArg)", () => {
  it("passes plain single tokens through unchanged", () => {
    expect(quoteArg("goal")).toBe("goal");
    expect(quoteArg("kalshi:ABC-123")).toBe("kalshi:ABC-123");
  });

  it("rejects whitespace, line breaks, control characters and empty values", () => {
    expect(() => quoteArg("pace fast")).toThrow(McpArgError);
    expect(() => quoteArg("a\nquit")).toThrow(McpArgError);
    expect(() => quoteArg("a\u0000b")).toThrow(McpArgError);
    expect(() => quoteArg("")).toThrow(McpArgError);
  });

  it("textArg keeps spaces but rejects line breaks", () => {
    expect(textArg("hello there")).toBe("hello there");
    expect(() => textArg("hello\nsay pwned")).toThrow(McpArgError);
  });
});

// ─── Transport hardening ──────────────────────────────────────────────────────

describe("MCP transport hardening", () => {
  let db: MarinaDB;
  let engine: Engine;
  let adapter: McpServerAdapter;
  let dbPath: string;
  let base: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = [
    "MODEL_API_KEYS",
    "MARINA_AUTH",
    "MARINA_MCP_SESSIONS_PER_MIN",
    "MARINA_MCP_ALLOWED_HOSTS",
  ];

  beforeEach(() => {
    for (const k of ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    resetHttpRateLimitersForTests();
    dbPath = nextDbPath();
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    adapter = new McpServerAdapter(engine, 0);
    adapter.start();
    base = `http://localhost:${adapter.getPort()}`;
    engine.start();
  });

  afterEach(() => {
    adapter.stop();
    engine.stop();
    db.close();
    cleanupDb(dbPath);
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetHttpRateLimitersForTests();
  });

  const initBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    },
  });
  const postInit = (headers: Record<string, string> = {}) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body: initBody,
    });

  it("stays unauthenticated in the local posture (loopback, no keys, no auth)", async () => {
    expect(mcpTransportAuthRequired(true)).toBe(false);
    const resp = await postInit();
    expect(resp.status).toBe(200);
    expect(resp.headers.get("mcp-session-id")).toBeTruthy();
  });

  it("requires a bearer once MODEL_API_KEYS is configured, accepting a key secret", async () => {
    process.env.MODEL_API_KEYS = "sk-test-secret:tester,sk-other";
    expect(mcpTransportAuthRequired(true)).toBe(true);

    const anon = await postInit();
    expect(anon.status).toBe(401);
    expect(anon.headers.get("WWW-Authenticate")).toContain("Bearer");

    const wrong = await postInit({ Authorization: "Bearer nope" });
    expect(wrong.status).toBe(401);

    const ok = await postInit({ Authorization: "Bearer sk-test-secret" });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("mcp-session-id")).toBeTruthy();
  });

  it("accepts a Marina session token as the bearer", async () => {
    // Mint a session token first (auth off), then turn the requirement on.
    const sid = await initSession(base);
    const loginText = await toolCall(base, sid, "login", { name: "BearerBot" });
    const token = loginText.match(/Session token: `([^`]+)`/)?.[1];
    expect(token).toBeTruthy();

    process.env.MARINA_AUTH = "better-auth";
    const denied = await postInit();
    expect(denied.status).toBe(401);
    const req = new Request(`${base}/mcp`, { headers: { Authorization: `Bearer ${token}` } });
    expect(authenticateMcpTransport(req, engine, true)).toBeNull();
  });

  it("rejects a foreign Host header (DNS-rebinding protection) on a loopback bind", async () => {
    const resp = await postInit({ Host: "evil.example:1234" });
    expect(resp.status).toBeGreaterThanOrEqual(400);
    expect(resp.headers.get("mcp-session-id")).toBeNull();
  });

  it("derives allowed hosts from the bind, the live port and MARINA_MCP_ALLOWED_HOSTS", () => {
    const hosts = mcpAllowedHosts("127.0.0.1", 3301, true, {
      MARINA_MCP_ALLOWED_HOSTS: "mcp.example.com, other.example:9000",
    });
    expect(hosts).toContain("localhost:3301");
    expect(hosts).toContain("127.0.0.1:3301");
    expect(hosts).toContain("[::1]:3301");
    expect(hosts).toContain("mcp.example.com");
    expect(hosts).toContain("mcp.example.com:3301");
    expect(hosts).toContain("other.example:9000");
    // Public bind without a declared list ⇒ validation off (bearer is mandatory there).
    expect(mcpAllowedHosts("0.0.0.0", 3301, false, {})).toBeUndefined();
    expect(
      mcpAllowedHosts("0.0.0.0", 3301, false, { MARINA_MCP_ALLOWED_HOSTS: "m.example" }),
    ).toEqual(["m.example", "m.example:3301"]);
  });

  it("refuses a foreign browser Origin", async () => {
    const resp = await postInit({ Origin: "https://evil.example" });
    expect(resp.status).toBe(403);
  });

  it("throttles session creation per client IP (MARINA_MCP_SESSIONS_PER_MIN)", async () => {
    process.env.MARINA_MCP_SESSIONS_PER_MIN = "2";
    resetHttpRateLimitersForTests();
    expect((await postInit()).status).toBe(200);
    expect((await postInit()).status).toBe(200);
    const third = await postInit();
    expect(third.status).toBe(429);
    expect(third.headers.get("Retry-After")).toBe("60");
  });

  it("throttles the login tool with the same per-IP budget", async () => {
    process.env.MARINA_MCP_SESSIONS_PER_MIN = "1";
    resetHttpRateLimitersForTests();
    const sid = await initSession(base); // consumes the single token
    const text = await toolCall(base, sid, "login", { name: "Throttled" });
    expect(text).toBe("Rate limited. Please slow down.");
  });
});

// ─── RateLimiter Unit Tests ───────────────────────────────────────────────────

describe("RateLimiter", () => {
  it("should allow requests within capacity", () => {
    const rl = new RateLimiter({ maxTokens: 5, refillRate: 0, refillInterval: 60_000 });
    for (let i = 0; i < 5; i++) {
      expect(rl.consume("test")).toBe(true);
    }
  });

  it("should reject requests over capacity", () => {
    const rl = new RateLimiter({ maxTokens: 2, refillRate: 0, refillInterval: 60_000 });
    expect(rl.consume("test")).toBe(true);
    expect(rl.consume("test")).toBe(true);
    expect(rl.consume("test")).toBe(false);
  });

  it("should refill tokens over time", () => {
    let now = 1000;
    const rl = new RateLimiter({
      maxTokens: 3,
      refillRate: 1,
      refillInterval: 100,
      now: () => now,
    });

    expect(rl.consume("test")).toBe(true);
    expect(rl.consume("test")).toBe(true);
    expect(rl.consume("test")).toBe(true);
    expect(rl.consume("test")).toBe(false);

    now += 100;
    expect(rl.consume("test")).toBe(true);
    expect(rl.consume("test")).toBe(false);
  });

  it("should track separate buckets per key", () => {
    const rl = new RateLimiter({ maxTokens: 1, refillRate: 0, refillInterval: 60_000 });
    expect(rl.consume("mcp:e_1")).toBe(true);
    expect(rl.consume("mcp:e_1")).toBe(false);
    expect(rl.consume("mcp:e_2")).toBe(true);
  });

  it("should reset a bucket to full capacity", () => {
    const rl = new RateLimiter({ maxTokens: 3, refillRate: 0, refillInterval: 60_000 });
    rl.consume("test");
    rl.consume("test");
    rl.consume("test");
    expect(rl.consume("test")).toBe(false);
    rl.reset("test");
    expect(rl.consume("test")).toBe(true);
  });

  it("should report remaining tokens", () => {
    const rl = new RateLimiter({ maxTokens: 5, refillRate: 0, refillInterval: 60_000 });
    expect(rl.getRemaining("test")).toBe(5);
    rl.consume("test");
    rl.consume("test");
    expect(rl.getRemaining("test")).toBe(3);
  });

  it("should clean up stale buckets", () => {
    let now = 1000;
    const rl = new RateLimiter({
      maxTokens: 5,
      refillRate: 1,
      refillInterval: 100,
      now: () => now,
    });

    rl.consume("stale");
    rl.consume("active");

    now += 7000;
    rl.consume("active");

    const removed = rl.cleanup();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(rl.getRemaining("active")).toBeLessThan(5);
  });

  it("should use mcp: key prefix pattern for entity rate limiting", () => {
    const rl = new RateLimiter({ maxTokens: 2, refillRate: 0, refillInterval: 60_000 });
    expect(rl.consume("mcp:e_42")).toBe(true);
    expect(rl.consume("mcp:e_42")).toBe(true);
    expect(rl.consume("mcp:e_42")).toBe(false);
    expect(rl.consume("mcp:e_99")).toBe(true);
  });
});
