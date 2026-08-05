import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { WebSocketServer } from "../src/net/websocket-server";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, makeTestRoom } from "./helpers";

const TEST_DB = "test_mem_api.db";
let BASE = "";
const AGENT = "test-agent";
const HEADERS: Record<string, string> = {
  "X-Agent-Name": AGENT,
  "Content-Type": "application/json",
};

describe("Memory API", () => {
  let engine: Engine;
  let wsServer: WebSocketServer;
  let db: MarinaDB;

  beforeAll(() => {
    // Enable open API mode for tests (no auth required, X-Agent-Name fallback)
    process.env.MARINA_OPEN_API = "true";

    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start", long: "Start." }));
    wsServer = new WebSocketServer(engine, 0);
    wsServer.setDb(db);
    wsServer.start();
    BASE = `http://localhost:${wsServer.getPort()}/mem`;
    engine.start();
  });

  afterAll(() => {
    engine.stop();
    wsServer.stop();
    db.close();
    cleanupDb(TEST_DB);
    process.env.MARINA_OPEN_API = undefined;
  });

  // ── Discovery & Health ──────────────────────────────────────────────────

  it("GET /mem returns API description (no auth)", async () => {
    const res = await fetch(BASE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.name).toBe("Marina Memory API");
    expect(body.version).toBe(1);
    expect(body.endpoints).toBeDefined();
    expect(body.note_types).toContain("observation");
    expect(body.relationships).toContain("supports");
    expect((body.features as string[]).length).toBeGreaterThan(0);
  });

  it("GET /mem/health returns ok (no auth)", async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.service).toBe("marina-mem");
  });

  // ── Auth ────────────────────────────────────────────────────────────────

  it("rejects requests without X-Agent-Name in open mode", async () => {
    const res = await fetch(`${BASE}/notes`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toContain("X-Agent-Name");
  });

  // ── Notes CRUD ──────────────────────────────────────────────────────────

  it("POST /mem/notes creates a note", async () => {
    const res = await fetch(`${BASE}/notes`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ content: "Test observation", importance: 7, type: "fact" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBeGreaterThan(0);
    const note = body.note as Record<string, unknown>;
    expect(note.content).toBe("Test observation");
    expect(note.importance).toBe(7);
    expect(note.note_type).toBe("fact");
  });

  it("POST /mem/notes validates content required", async () => {
    const res = await fetch(`${BASE}/notes`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ importance: 5 }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /mem/notes validates importance range", async () => {
    const res = await fetch(`${BASE}/notes`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ content: "test", importance: 11 }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /mem/notes validates note type", async () => {
    const res = await fetch(`${BASE}/notes`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ content: "test", type: "invalid" }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /mem/notes lists notes", async () => {
    const res = await fetch(`${BASE}/notes`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.notes as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it("GET /mem/notes/:id returns note with links", async () => {
    const createRes = await fetch(`${BASE}/notes`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ content: "Specific note for get" }),
    });
    const { id } = (await createRes.json()) as { id: number };

    const res = await fetch(`${BASE}/notes/${id}`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.note as Record<string, unknown>).content).toBe("Specific note for get");
    expect(body.links).toEqual([]);
  });

  it("GET /mem/notes/:id returns 404 for other agent's note", async () => {
    const createRes = await fetch(`${BASE}/notes`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ content: "Private note" }),
    });
    const { id } = (await createRes.json()) as { id: number };

    const res = await fetch(`${BASE}/notes/${id}`, {
      headers: { "X-Agent-Name": "other-agent" },
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /mem/notes/:id deletes a note", async () => {
    const createRes = await fetch(`${BASE}/notes`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ content: "To delete" }),
    });
    const { id } = (await createRes.json()) as { id: number };

    const res = await fetch(`${BASE}/notes/${id}`, { method: "DELETE", headers: HEADERS });
    expect(res.status).toBe(200);

    const getRes = await fetch(`${BASE}/notes/${id}`, { headers: HEADERS });
    expect(getRes.status).toBe(404);
  });

  // ── Notes with auto-linking ─────────────────────────────────────────────

  it("POST /mem/notes with links creates note and links", async () => {
    const first = (await (
      await fetch(`${BASE}/notes`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ content: "Link source" }),
      })
    ).json()) as { id: number };

    const second = await fetch(`${BASE}/notes`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        content: "Link target",
        links: [{ target: first.id, relationship: "supports" }],
      }),
    });
    expect(second.status).toBe(201);
    const { id } = (await second.json()) as { id: number };

    const res = await fetch(`${BASE}/notes/${id}`, { headers: HEADERS });
    const body = (await res.json()) as Record<string, unknown>;
    const links = body.links as Array<Record<string, unknown>>;
    expect(links.length).toBe(1);
    expect(links[0]!.relationship).toBe("supports");
  });

  // ── Recall ──────────────────────────────────────────────────────────────

  it("GET /mem/recall returns scored results", async () => {
    await fetch(`${BASE}/notes`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        content: "Redis cache performance is degrading rapidly",
        importance: 8,
      }),
    });

    const res = await fetch(`${BASE}/recall?q=cache+performance+degrading`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.query).toBe("cache performance degrading");
    expect(body.weights).toBeDefined();
    const results = body.results as Array<Record<string, unknown>>;
    expect(results.length).toBeGreaterThan(0);
    expect((results[0]!.score as number) > 0).toBe(true);
  });

  it("GET /mem/recall requires q parameter", async () => {
    const res = await fetch(`${BASE}/recall`, { headers: HEADERS });
    expect(res.status).toBe(400);
  });

  it("GET /mem/recall supports weight overrides", async () => {
    await fetch(`${BASE}/notes`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ content: "Weighted recall test content" }),
    });

    const res = await fetch(`${BASE}/recall?q=weighted+recall+test&wi=0.8&wr=0.1&wrel=0.1`, {
      headers: HEADERS,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const weights = body.weights as Record<string, number>;
    expect(weights.weightImportance).toBe(0.8);
  });

  // ── Knowledge Graph ─────────────────────────────────────────────────────

  it("POST /mem/notes/:id/link creates a link", async () => {
    const a = (await (
      await fetch(`${BASE}/notes`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ content: "Graph note A" }),
      })
    ).json()) as { id: number };
    const b = (await (
      await fetch(`${BASE}/notes`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ content: "Graph note B" }),
      })
    ).json()) as { id: number };

    const res = await fetch(`${BASE}/notes/${a.id}/link`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ target: b.id, relationship: "contradicts" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.source).toBe(a.id);
    expect(body.target).toBe(b.id);
    expect(body.relationship).toBe("contradicts");
  });

  it("POST /mem/notes/:id/link validates relationship", async () => {
    const a = (await (
      await fetch(`${BASE}/notes`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ content: "Validate link note" }),
      })
    ).json()) as { id: number };

    const res = await fetch(`${BASE}/notes/${a.id}/link`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ target: 999, relationship: "invalid_type" }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /mem/notes/:id/trace returns graph", async () => {
    const a = (await (
      await fetch(`${BASE}/notes`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ content: "Trace root" }),
      })
    ).json()) as { id: number };
    const b = (await (
      await fetch(`${BASE}/notes`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ content: "Trace linked" }),
      })
    ).json()) as { id: number };

    await fetch(`${BASE}/notes/${a.id}/link`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ target: b.id, relationship: "related_to" }),
    });

    const res = await fetch(`${BASE}/notes/${a.id}/trace?depth=1`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.root).toBe(a.id);
    expect((body.graph as unknown[]).length).toBe(2);
  });

  // ── Core Memory ─────────────────────────────────────────────────────────

  it("PUT /mem/core/:key sets a value", async () => {
    const res = await fetch(`${BASE}/core/goal`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ value: "Fix the cache" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.key).toBe("goal");
    expect(body.value).toBe("Fix the cache");
    expect(body.version).toBe(1);
  });

  it("PUT /mem/core/:key increments version on update", async () => {
    const res = await fetch(`${BASE}/core/goal`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ value: "Deploy the fix" }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.version as number).toBeGreaterThanOrEqual(2);
    expect(body.value).toBe("Deploy the fix");
  });

  it("GET /mem/core lists all keys", async () => {
    await fetch(`${BASE}/core/extra`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ value: "val" }),
    });

    const res = await fetch(`${BASE}/core`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.count as number).toBeGreaterThanOrEqual(2);
  });

  it("GET /mem/core/:key returns 404 for missing key", async () => {
    const res = await fetch(`${BASE}/core/nonexistent_key_xyz`, { headers: HEADERS });
    expect(res.status).toBe(404);
  });

  it("DELETE /mem/core/:key deletes a key", async () => {
    await fetch(`${BASE}/core/temp`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ value: "temporary" }),
    });
    const res = await fetch(`${BASE}/core/temp`, { method: "DELETE", headers: HEADERS });
    expect(res.status).toBe(200);

    const getRes = await fetch(`${BASE}/core/temp`, { headers: HEADERS });
    expect(getRes.status).toBe(404);
  });

  it("GET /mem/core/:key/history returns version trail", async () => {
    await fetch(`${BASE}/core/hist`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ value: "first" }),
    });
    await fetch(`${BASE}/core/hist`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ value: "second" }),
    });

    const res = await fetch(`${BASE}/core/hist/history`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.key).toBe("hist");
    expect(body.count as number).toBeGreaterThanOrEqual(1);
  });

  // ── Pools ───────────────────────────────────────────────────────────────

  it("POST /mem/pools creates a pool", async () => {
    const res = await fetch(`${BASE}/pools`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ name: "team-alpha" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.name).toBe("team-alpha");
    expect(body.created_by).toBe(AGENT);
  });

  it("POST /mem/pools rejects duplicate names", async () => {
    const res = await fetch(`${BASE}/pools`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ name: "team-alpha" }),
    });
    expect(res.status).toBe(409);
  });

  it("GET /mem/pools lists pools", async () => {
    const res = await fetch(`${BASE}/pools`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.count as number).toBeGreaterThanOrEqual(1);
  });

  it("POST /mem/pools/:name/notes adds to pool", async () => {
    const res = await fetch(`${BASE}/pools/team-alpha/notes`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ content: "Shared finding", importance: 6 }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.pool).toBe("team-alpha");
  });

  it("GET /mem/pools/:name/notes lists pool notes", async () => {
    const res = await fetch(`${BASE}/pools/team-alpha/notes`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.count as number).toBeGreaterThanOrEqual(1);
  });

  it("GET /mem/pools/:name returns pool info with note count", async () => {
    const res = await fetch(`${BASE}/pools/team-alpha`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.note_count as number).toBeGreaterThanOrEqual(1);
    expect(body.name).toBe("team-alpha");
  });

  it("GET /mem/pools/:name/recall returns scored results", async () => {
    await fetch(`${BASE}/pools/team-alpha/notes`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ content: "Pool recall search target content", importance: 8 }),
    });

    const res = await fetch(`${BASE}/pools/team-alpha/recall?q=pool+recall+search+target`, {
      headers: HEADERS,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.pool).toBe("team-alpha");
    expect((body.results as unknown[]).length).toBeGreaterThan(0);
  });

  it("returns 404 for nonexistent pool", async () => {
    const res = await fetch(`${BASE}/pools/no_such_pool_xyz/notes`, { headers: HEADERS });
    expect(res.status).toBe(404);
  });

  // ── Stats ───────────────────────────────────────────────────────────────

  it("GET /mem/stats returns namespace stats", async () => {
    const res = await fetch(`${BASE}/stats`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.agent).toBe(AGENT);
    expect(body.notes as number).toBeGreaterThanOrEqual(1);
    expect(typeof body.links).toBe("number");
    expect(typeof body.coreKeys).toBe("number");
    expect(typeof body.pools).toBe("number");
  });

  // ── Namespace isolation ─────────────────────────────────────────────────

  it("agents cannot see each other's notes", async () => {
    const res = await fetch(`${BASE}/notes`, {
      headers: { "X-Agent-Name": "isolated-agent-xyz" },
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.count).toBe(0);
  });

  it("agents cannot see each other's core memory", async () => {
    const res = await fetch(`${BASE}/core/goal`, {
      headers: { "X-Agent-Name": "isolated-agent-xyz" },
    });
    expect(res.status).toBe(404);
  });

  // ── Connect manifest ───────────────────────────────────────────────────

  it("GET /api/connect includes memory protocol", async () => {
    const res = await fetch(`${BASE.replace(/\/mem$/, "")}/api/connect`);
    const body = (await res.json()) as Record<string, unknown>;
    const protocols = body.protocols as Record<string, unknown>;
    const memory = protocols.memory as Record<string, unknown>;
    expect(memory).toBeDefined();
    expect(memory.url).toContain("/mem");
    const endpoints = memory.endpoints as Record<string, string>;
    expect(endpoints.recall).toBe("/mem/recall");
  });
});
