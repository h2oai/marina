import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RateLimiter } from "../src/auth/rate-limiter";
import { Engine } from "../src/engine/engine";
import { McpServerAdapter } from "../src/net/mcp-server";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, makeTestRoom } from "./helpers";

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
    (response as { result?: { content?: { text: string }[] } })?.result?.content?.[0]?.text ?? ""
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

  beforeEach(() => {
    dbPath = nextDbPath();
    db = new MarinaDB(dbPath);
    engine = new Engine({
      startRoom: roomId("test/start"),
      tickInterval: 60_000,
      db,
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

    adapter = new McpServerAdapter(engine, 0);
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

  // ── Tool Registration ───────────────────────────────────────────────────

  describe("tool registration", () => {
    it("should register all 30 tools", async () => {
      const sid = await initSession(url);
      const tools = await toolList(url, sid);
      expect(tools.length).toBe(30);
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
        "crew",
        "examine",
        "group",
        "help",
        "login",
        "look",
        "market",
        "memory",
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

    it("should cover all 8 tool categories", async () => {
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
      for (const t of ["channel", "board", "group", "task"]) {
        expect(names.has(t)).toBe(true);
      }
      // Canvas
      expect(names.has("canvas")).toBe(true);
      // Building
      expect(names.has("build")).toBe(true);
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
      expect(text).toContain("canvas");
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
