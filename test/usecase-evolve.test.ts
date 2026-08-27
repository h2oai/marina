// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getRecipe } from "../src/engine/commands/usecase";
import { Engine } from "../src/engine/engine";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { MarinaDB } from "../src/persistence/database";
import type { EntityId, RoomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_usecase_evolve.db";
const PROVIDER_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "CEREBRAS_API_KEY",
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "LLAMA_API_KEY",
  "LLAMA_BASE_URL",
  "OLLAMA_API_KEY",
  "OLLAMA_BASE_URL",
  "VIBETHINKER_API_KEY",
  "VIBETHINKER_BASE_URL",
];

function makeRequest(path: string, body: unknown): [URL, string, Request] {
  const url = new URL(`http://localhost:3300${path}`);
  const req = new Request(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return [url, "POST", req];
}

describe("usecase evolve recipe", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;
  let entityId: EntityId;
  let savedProviders: Record<string, string | undefined>;

  beforeEach(() => {
    savedProviders = Object.fromEntries(PROVIDER_VARS.map((name) => [name, process.env[name]]));
    for (const name of PROVIDER_VARS) delete process.env[name];
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ db, startRoom: "test/start" as RoomId });
    engine.registerRoom("test/start" as RoomId, makeTestRoom());

    conn = new MockConnection("c1");
    engine.addConnection(conn);
    const result = engine.login("c1", "Tester");
    if ("error" in result) throw new Error(result.error);
    entityId = result.entityId;
    conn.clear();
  });

  afterEach(() => {
    try {
      engine.shutdown();
    } catch {}
    try {
      db.close();
    } catch {}
    cleanupDb(TEST_DB);
    for (const [name, value] of Object.entries(savedProviders)) {
      if (value !== undefined) process.env[name] = value;
      else delete process.env[name];
    }
  });

  it("is registered as a built-in recipe with an evolver/advisor team", () => {
    const factory = getRecipe("evolve");
    expect(factory).toBeDefined();

    const recipe = factory!("improve research synthesis");
    expect(recipe.description).toContain("Autonomous evolution cycle");
    expect(recipe.orchestration).toBe("swarm");
    expect(recipe.tasks.map((t) => t.title)).toContain("Run one improvement cycle");
    expect(recipe.team?.map((m) => m.namePrefix)).toEqual(["evolver", "advisor"]);
    expect(recipe.requesterCoreMemory?.goal).toBe("improve research synthesis");
    expect(recipe.poolNotes.some((n) => n.content.includes("Prompt budget policy"))).toBe(true);
  });

  it("ships direct universal-intent recipes with fitting orchestration", () => {
    expect(getRecipe("debate")!("A or B").orchestration).toBe("debate");
    expect(getRecipe("solve")!("hard problem").orchestration).toBe("blackboard");
    expect(getRecipe("explore")!("new domain").orchestration).toBe("symbiosis");
    expect(getRecipe("plan")!("launch").orchestration).toBe("deliberation");
  });

  it("appears in recipe list and info with team-aware display", async () => {
    await engine.processCommand(entityId, "usecase list");
    let text = stripAnsi(conn.allTextJoined());
    expect(text).toContain("evolve");
    expect(text).toContain("2 agent team");

    conn.clear();
    await engine.processCommand(entityId, "usecase info evolve");
    text = stripAnsi(conn.allTextJoined());
    expect(text).toContain("Recipe: evolve");
    expect(text).toContain("Create or request a mind-room");
    expect(text).toContain("researcher, scholar");
  });

  it("launches a project, tasks, pool notes, and requester memory without requiring API keys", async () => {
    await engine.processCommand(entityId, "usecase evolve improve autonomous research synthesis");

    const text = stripAnsi(conn.allTextJoined());
    expect(text).toContain("Use case launched: evolve");
    // This test deliberately runs with no provider configured, so the recipe
    // takes the "agent runtime unavailable" path and reports that reason. The
    // "spawn unavailable" wording belongs to a different branch — runtime
    // available but the agent.spawn gate closed — which this case never enters.
    expect(text).toContain("none (no model provider configured)");

    const project = db.getProjectByName("evolve: improve autonomous research synthesis");
    expect(project).toBeDefined();
    expect(project!.orchestration).toBe("swarm");
    expect(project!.group_id).toBeTruthy();
    expect(project!.bundle_id).toBeTruthy();

    const pool = db.getMemoryPool("usecase:evolve: improve autonomous research synthesis");
    expect(pool).toBeDefined();
    const tasks = db.listTasks({ groupId: project!.group_id ?? undefined, limit: 10 });
    expect(tasks.length).toBe(5);
    expect(tasks.some((t) => t.title === "Publish lineage")).toBe(true);
    expect(engine.taskManager!.listChildren(project!.bundle_id!)).toHaveLength(5);

    expect(db.getCoreMemory("Tester", "goal")?.value).toBe("improve autonomous research synthesis");
    expect(db.getCoreMemory("Tester", "constitution")?.value).toContain("Improve one thing");
  });

  it("launches universal intents directly and exposes project progress", async () => {
    await engine.processCommand(entityId, "debate whether local-first systems age better");
    const text = stripAnsi(conn.allTextJoined());
    expect(text).toContain("Use case launched: debate");

    const project = db.getProjectByName("debate: whether local-first systems age better");
    expect(project?.orchestration).toBe("debate");
    expect(project?.bundle_id).toBeTruthy();

    conn.clear();
    await engine.processCommand(entityId, `project ${project!.name} status`);
    expect(stripAnsi(conn.allTextJoined())).toContain("Tasks: 0/4 (4 open)");

    conn.clear();
    await engine.processCommand(
      entityId,
      `project ${project!.name} outcome 0.82 | Evidence: board #7 captured a judged synthesis; dissent remained explicit.`,
    );
    expect(stripAnsi(conn.allTextJoined())).toContain("Recorded outcome 0.82");
    expect(db.getProject(project!.id)?.status).toBe("completed");
    const tradition = db.getMemoryPool("orchestration:debate");
    expect(tradition).toBeDefined();
    expect(db.recallPoolNotes(tradition!.id, "judged synthesis")).toHaveLength(1);
  });

  it("detects natural-language evolution requests", async () => {
    await engine.processCommand(entityId, "usecase make an agent better over generations");
    const text = stripAnsi(conn.allTextJoined());
    expect(text).toContain("Detected intent: evolve");
    expect(text).toContain("Use case launched: evolve");
    expect(db.getProjectByName("evolve: make an agent better over generations")).toBeDefined();
  });

  it("is reachable through the command API", async () => {
    const [url, method, req] = makeRequest("/api/command", {
      name: "ApiEvolver",
      command: "usecase evolve improve long-run autonomy",
      render: "text",
    });

    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).toBe(200);
    const body = (await resp!.json()) as { text: string };

    expect(body.text).toContain("Use case launched: evolve");
    expect(db.getProjectByName("evolve: improve long-run autonomy")).toBeDefined();
  });
});
