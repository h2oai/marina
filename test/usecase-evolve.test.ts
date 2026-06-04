import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getRecipe } from "../src/engine/commands/usecase";
import { Engine } from "../src/engine/engine";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { MarinaDB } from "../src/persistence/database";
import type { EntityId, RoomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_usecase_evolve.db";

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

  beforeEach(() => {
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
    expect(text).toContain("none (no API key configured)");

    const project = db.getProjectByName("evolve: improve autonomous research synthesis");
    expect(project).toBeDefined();
    expect(project!.orchestration).toBe("swarm");
    expect(project!.group_id).toBeTruthy();

    const pool = db.getMemoryPool("usecase:evolve: improve autonomous research synthesis");
    expect(pool).toBeDefined();
    const tasks = db.listTasks({ groupId: project!.group_id ?? undefined, limit: 10 });
    expect(tasks.length).toBe(5);
    expect(tasks.some((t) => t.title === "Publish lineage")).toBe(true);

    expect(db.getCoreMemory("Tester", "goal")?.value).toBe("improve autonomous research synthesis");
    expect(db.getCoreMemory("Tester", "constitution")?.value).toContain("Improve one thing");
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
