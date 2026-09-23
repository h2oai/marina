// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Ops API — `GET /api/ops/overview` scoping and the privileged cascade stop.
 *
 * Fixture: a booted engine (no sockets, no LLM) with three signed-in residents
 * and three fake agent handles injected into the runtime's maps the same way
 * `test/agent-runtime-cascade.test.ts` does: `Lead` (spawned by Owner),
 * `Worker` (spawned by Lead) and `Solo` (spawned by the system). Owner should
 * see its lineage, Stranger nothing, the desktop operator everything.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentHandle, AgentStatus } from "../src/agent/agent-types";
import type { AgentOperatorStatus } from "../src/agent/lean-agent-adapter";
import { LEAN_SYSTEM_PROMPT_BYTE_CAP } from "../src/agent/prompts/lean-system";
import { Engine } from "../src/engine/engine";
import { resetRetentionReportForTests } from "../src/engine/retention";
import { resetTrustProfileForTests } from "../src/engine/trust-profile";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { resetHttpRateLimitersForTests } from "../src/net/http-utils";
import {
  buildOpsOverview,
  descendantAgents,
  inferToolProfileForRole,
  loopbackBindFromEnv,
  mcpAuthRequiredFromEnv,
  opsObserverScope,
  promptBudget,
  resetPromptBudgetMemoForTests,
} from "../src/net/ops-api";
import type { OpsAgentStopResponse, OpsOverview } from "../src/net/ops-types";
import { MarinaDB } from "../src/persistence/database";
import { type EngineEvent, type EntityId, roomId } from "../src/types";
import { MockConnection, makeTestRoom } from "./helpers";

const OWNER = "Owner";
const STRANGER = "Stranger";
const DESKTOP_TOKEN = "desktop-capability-token-at-least-32-chars";

type RuntimeInternals = {
  agents: Map<string, AgentHandle>;
  spawnedByOf: Map<string, string>;
};

let directory: string;
let db: MarinaDB;
let engine: Engine;
let tokens: Record<string, string>;
let entityIds: Record<string, EntityId>;
let stopped: string[];
let connCounter = 0;
const prevEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "MARINA_OPEN_API",
  "MARINA_DESKTOP_API_TOKEN",
  "MARINA_PROFILE",
  "MARINA_AUTONOMY",
  "MARINA_TRUST_PROXY",
  "MODEL_API_KEYS",
  "MARINA_AUTH",
  "WS_HOST",
  "MARINA_HOST",
  "MARINA_PUBLIC",
];

function login(name: string): void {
  const conn = new MockConnection(`ops-${connCounter++}`);
  engine.addConnection(conn);
  const result = engine.login(conn.id, name);
  if ("error" in result) throw new Error(`login failed: ${result.error}`);
  tokens[name] = result.token;
  const entity = engine.entities.all().find((e) => e.name === name);
  if (!entity) throw new Error(`entity ${name} missing`);
  entityIds[name] = entity.id;
}

function fakeHandle(
  name: string,
  opts: { costLastHourUsd?: number; totalCostUsd?: number; role?: string; paused?: boolean } = {},
): AgentHandle {
  const status: AgentStatus = {
    name,
    entityId: `e_${name.toLowerCase()}` as EntityId,
    state: "autonomous",
    healthState: "ready",
    model: "anthropic/claude-x",
    role: opts.role ?? "",
    focus: null,
    goal: null,
    uptime: 90_000,
    toolCalls: 3,
    errors: 0,
    errorReason: null,
    lastActivity: Date.now(),
    supports: { text: true },
    contextWindow: 0,
    effectiveContextWindow: 0,
    maxOutputTokens: 0,
    peakInputTokens: 0,
    lastTurnMs: 0,
    avgTurnMs: 0,
    silentTurns: 0,
  };
  const handle = {
    name,
    getStatus: () => status,
    sendAttention: async () => {},
    setFocus: () => {},
    setSystemPrompt: () => {},
    stop: async () => {
      stopped.push(name);
    },
    subscribe: () => () => {},
    reconfigure: async () => {},
  } as AgentHandle;
  if (opts.costLastHourUsd !== undefined) {
    const ops: AgentOperatorStatus = {
      totalInputTokens: 1000,
      totalOutputTokens: 200,
      totalCostUsd: opts.totalCostUsd ?? opts.costLastHourUsd,
      costLastHourUsd: opts.costLastHourUsd,
      spendCaps: {},
      lastError: { text: "boom", at: Date.now() - 5000 },
      consecutiveErrors: 2,
      paused: opts.paused
        ? { kind: "spend-cap", reason: "spend cap reached", since: Date.now() - 1000 }
        : null,
      nextTickInMs: 1500,
    };
    (handle as unknown as { getOperatorStatus: () => AgentOperatorStatus }).getOperatorStatus =
      () => ops;
  }
  return handle;
}

function inject(name: string, spawnedBy: string, handle: AgentHandle): void {
  const internals = engine.agentRuntime as unknown as RuntimeInternals;
  internals.agents.set(name, handle);
  internals.spawnedByOf.set(name, spawnedBy);
  db.saveAgentConfig({ name, model: "anthropic/claude-x", spawnedBy });
}

async function api(
  path: string,
  opts: { method?: string; token?: string; desktop?: boolean } = {},
) {
  const url = new URL(`http://localhost:3300${path}`);
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.desktop) headers["X-Marina-Desktop-Token"] = DESKTOP_TOKEN;
  const method = opts.method ?? "GET";
  const req = new Request(url.toString(), { method, headers });
  const resp = await handleDashboardApi(req, url, method, engine, db);
  if (!resp) throw new Error(`no response for ${path}`);
  const text = await resp.text();
  return { status: resp.status, body: text ? (JSON.parse(text) as unknown) : undefined };
}

beforeEach(() => {
  // Retention keeps the last pass in module state; another test file's pass

  // must not leak into this file's `lastReport: null` assertion.

  resetRetentionReportForTests();
  for (const key of ENV_KEYS) {
    prevEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.MARINA_DESKTOP_API_TOKEN = DESKTOP_TOKEN;
  // Default in-process profile is `shared`, so residents log in at rank 0 and
  // the scoping below is real enforcement.
  resetTrustProfileForTests();
  resetHttpRateLimitersForTests();
  resetPromptBudgetMemoForTests();
  directory = mkdtempSync(join(tmpdir(), "marina-ops-api-"));
  db = new MarinaDB(join(directory, "world.db"));
  engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
  engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  tokens = {};
  entityIds = {};
  stopped = [];
  for (const name of [OWNER, STRANGER]) login(name);
  inject(
    "Lead",
    OWNER,
    fakeHandle("Lead", { costLastHourUsd: 0.5, totalCostUsd: 2, role: "watcher" }),
  );
  inject(
    "Worker",
    "Lead",
    fakeHandle("Worker", { costLastHourUsd: 0.25, role: "mathematician", paused: true }),
  );
  inject("Solo", "system", fakeHandle("Solo", { costLastHourUsd: 1 }));
});

afterEach(() => {
  resetTrustProfileForTests();
  for (const key of ENV_KEYS) {
    const v = prevEnv[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
  db.close();
  rmSync(directory, { recursive: true });
});

describe("GET /api/ops/overview", () => {
  it("requires authentication", async () => {
    const resp = await api("/api/ops/overview");
    expect(resp.status).toBe(401);
  });

  it("operator sees every agent, spend sums, retention, prompt budget and posture", async () => {
    const resp = await api("/api/ops/overview", { desktop: true });
    expect(resp.status).toBe(200);
    const body = resp.body as OpsOverview;
    expect(body.scope).toBe("privileged");
    // Sorted by rolling-hour spend, descending.
    expect(body.agents.map((a) => a.name)).toEqual(["Solo", "Lead", "Worker"]);
    const lead = body.agents.find((a) => a.name === "Lead")!;
    expect(lead).toMatchObject({
      spawnedBy: OWNER,
      role: "watcher",
      toolProfile: "full",
      tokens: { input: 1000, output: 200 },
      cost: { totalUsd: 2, lastHourUsd: 0.5 },
      consecutiveErrors: 2,
      operatorStatus: true,
      nextTickInMs: 1500,
      health: "ready",
    });
    expect(lead.lastError?.text).toBe("boom");
    const worker = body.agents.find((a) => a.name === "Worker")!;
    expect(worker.toolProfile).toBe("crew");
    expect(worker.spawnedBy).toBe("Lead");
    expect(worker.paused).toMatchObject({ kind: "spend-cap", until: null });

    expect(body.spend.lastHourUsd).toBeCloseTo(1.75, 6);
    expect(body.spend.totalUsd).toBeCloseTo(3.25, 6);
    expect(body.spend.caps).toEqual({ perAgentUsd: null, globalUsd: null });

    expect(body.retention.lastReport).toBeNull();
    expect(body.retention.policies.length).toBeGreaterThan(5);
    const appendOnly = body.retention.policies.filter((p) => p.kind === "append-only");
    expect(appendOnly.map((p) => p.table)).toContain("chronicle");
    for (const p of appendOnly) expect(p.keep).toBe("never");

    expect(body.prompt.systemPromptBytes).toBeGreaterThan(0);
    expect(body.prompt.systemPromptBytes).toBeLessThanOrEqual(LEAN_SYSTEM_PROMPT_BYTE_CAP);
    expect(body.prompt.systemPromptCapBytes).toBe(LEAN_SYSTEM_PROMPT_BYTE_CAP);
    expect(body.prompt.deferredTools).toBe(true);
    expect(body.prompt.residentSchemaBytesByProfile.full).toBeGreaterThan(0);
    expect(body.prompt.residentSchemaBytesByProfile.minimal).toBeLessThan(
      body.prompt.residentSchemaBytesByProfile.crew,
    );
    expect(body.prompt.deferredToolCount).toBeGreaterThan(0);
    expect(body.prompt.continuationBudgetBytes).toBeGreaterThanOrEqual(1000);

    // No probe has run in this process.
    expect(body.providers).toBeNull();

    expect(body.security).toMatchObject({
      trustProfile: "shared",
      ungated: false,
      autonomy: "guarded",
      openApi: false,
      trustProxy: false,
      loopbackBind: true,
      mcpAuthRequired: false,
    });
    expect(body.security.limiters.map((l) => l.name).sort()).toEqual(
      ["dashboard", "mcpSession", "mutation", "publicRead"].sort(),
    );
  });

  it("a resident sees only its own lineage (transitively) and no provider probe", async () => {
    const resp = await api("/api/ops/overview", { token: tokens[OWNER] });
    expect(resp.status).toBe(200);
    const body = resp.body as OpsOverview;
    expect(body.scope).toBe("resident");
    expect(body.agents.map((a) => a.name).sort()).toEqual(["Lead", "Worker"]);
    expect(body.spend.lastHourUsd).toBeCloseTo(0.75, 6);
    expect(body.providers).toBeNull();
    // Posture and retention are configuration, not secrets — still visible.
    expect(body.security.trustProfile).toBe("shared");
    expect(body.retention.policies.length).toBeGreaterThan(0);
  });

  it("a stranger sees no agents and zero spend", async () => {
    const resp = await api("/api/ops/overview", { token: tokens[STRANGER] });
    expect(resp.status).toBe(200);
    const body = resp.body as OpsOverview;
    expect(body.agents).toEqual([]);
    expect(body.spend).toMatchObject({ lastHourUsd: 0, totalUsd: 0 });
  });

  it("the MARINA_OPEN_API sentinel reads as privileged and reports openApi", async () => {
    process.env.MARINA_OPEN_API = "true";
    const resp = await api("/api/ops/overview");
    expect(resp.status).toBe(200);
    const body = resp.body as OpsOverview;
    expect(body.scope).toBe("privileged");
    expect(body.agents).toHaveLength(3);
    expect(body.security.openApi).toBe(true);
  });

  it("buildOpsOverview matches the route for the same scope", () => {
    const direct = buildOpsOverview(engine, opsObserverScope(engine, entityIds[OWNER]));
    expect(direct.scope).toBe("resident");
    expect(direct.agents.map((a) => a.name).sort()).toEqual(["Lead", "Worker"]);
  });
});

describe("POST /api/ops/agents/:name/stop", () => {
  it("operator stop cascades children-first and reports them", async () => {
    const events: EngineEvent[] = [];
    engine.addEventListener((e) => {
      if (e.type === "agent_stop") events.push(e);
    });
    const resp = await api("/api/ops/agents/Lead/stop", { method: "POST", desktop: true });
    expect(resp.status).toBe(200);
    expect(resp.body as OpsAgentStopResponse).toEqual({
      stopped: "Lead",
      stoppedChildren: ["Worker"],
    });
    expect(stopped).toEqual(["Worker", "Lead"]);
    expect(engine.agentRuntime.get("Lead")).toBeUndefined();
    expect(engine.agentRuntime.get("Worker")).toBeUndefined();
    expect(engine.agentRuntime.get("Solo")).toBeDefined();
    expect(events.map((e) => ("name" in e ? e.name : "")).sort()).toEqual(["Lead", "Worker"]);
  });

  it("a rank-0 resident is refused even for its own agent; unknown agents are 404", async () => {
    const denied = await api("/api/ops/agents/Lead/stop", { method: "POST", token: tokens[OWNER] });
    expect(denied.status).toBe(403);
    expect(stopped).toEqual([]);
    const missing = await api("/api/ops/agents/Nobody/stop", { method: "POST", desktop: true });
    expect(missing.status).toBe(404);
  });

  it("the dev-open sentinel may read but not stop", async () => {
    process.env.MARINA_OPEN_API = "true";
    const resp = await api("/api/ops/agents/Solo/stop", { method: "POST" });
    expect(resp.status).toBe(403);
    expect(engine.agentRuntime.get("Solo")).toBeDefined();
  });
});

describe("pure helpers", () => {
  it("descendantAgents walks the lineage children-first", () => {
    expect(descendantAgents(engine, OWNER)).toEqual(["Worker", "Lead"]);
    expect(descendantAgents(engine, "Solo")).toEqual([]);
  });

  it("inferToolProfileForRole mirrors the runtime default", () => {
    expect(inferToolProfileForRole("mathematician")).toBe("crew");
    expect(inferToolProfileForRole("general")).toBe("crew");
    expect(inferToolProfileForRole("answerer")).toBe("crew"); // coordinator roles are responders too
    expect(inferToolProfileForRole("watcher")).toBe("full");
    expect(inferToolProfileForRole(undefined)).toBe("full");
  });

  it("loopbackBindFromEnv follows WS_HOST / MARINA_HOST / MARINA_PUBLIC", () => {
    expect(loopbackBindFromEnv({})).toBe(true);
    expect(loopbackBindFromEnv({ MARINA_PUBLIC: "true" })).toBe(false);
    expect(loopbackBindFromEnv({ WS_HOST: "0.0.0.0", MARINA_PUBLIC: "false" })).toBe(false);
    expect(loopbackBindFromEnv({ MARINA_HOST: "localhost" })).toBe(true);
    expect(loopbackBindFromEnv({ WS_HOST: "127.0.0.2" })).toBe(true);
  });

  it("mcpAuthRequiredFromEnv turns on with keys, sign-in or a public bind", () => {
    expect(mcpAuthRequiredFromEnv(true, {})).toBe(false);
    expect(mcpAuthRequiredFromEnv(false, {})).toBe(true);
    expect(mcpAuthRequiredFromEnv(true, { MODEL_API_KEYS: "s3cret" })).toBe(true);
    expect(mcpAuthRequiredFromEnv(true, { MODEL_API_KEYS: " , " })).toBe(false);
    expect(mcpAuthRequiredFromEnv(true, { MARINA_AUTH: "better-auth" })).toBe(true);
  });

  it("promptBudget is memoized for a minute and honors MARINA_DEFERRED_TOOLS=off", () => {
    const first = promptBudget(1_000_000);
    const again = promptBudget(1_000_000 + 30_000);
    expect(again).toBe(first);
    const later = promptBudget(1_000_000 + 61_000);
    expect(later).not.toBe(first);
    expect(later.computedAt).toBe(1_061_000);

    const prev = process.env.MARINA_DEFERRED_TOOLS;
    process.env.MARINA_DEFERRED_TOOLS = "off";
    try {
      resetPromptBudgetMemoForTests();
      const allResident = promptBudget();
      expect(allResident.deferredTools).toBe(false);
      expect(allResident.deferredToolCount).toBe(0);
      expect(allResident.residentSchemaBytesByProfile.full).toBeGreaterThan(
        later.residentSchemaBytesByProfile.full,
      );
    } finally {
      if (prev === undefined) delete process.env.MARINA_DEFERRED_TOOLS;
      else process.env.MARINA_DEFERRED_TOOLS = prev;
      resetPromptBudgetMemoForTests();
    }
  });
});
