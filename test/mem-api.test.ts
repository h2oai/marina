// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { buildUnifiedContext, type UnifiedContextResult } from "../src/memory/unified-context";
import { WebSocketServer } from "../src/net/websocket-server";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { FIXTURE_QUERY, seedUnifiedFixture, tierIds } from "./fixtures/unified-memory-fixture";
import { cleanupDb, makeTestRoom } from "./helpers";

const TEST_DB = "test_mem_api.db";
let BASE = "";
// Open-mode namespaces are normalized like login names (letters, digits, `_` only).
const AGENT = "test_agent";
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
    delete process.env.MARINA_OPEN_API;
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

  it("GET /mem/notes hides superseded, process-tier and pool notes unless ?all=1", async () => {
    // Fresh agent so counts are exact.
    const H = { ...HEADERS, "X-Agent-Name": "list_filter_agent" };
    const name = "list_filter_agent";
    const keep = db.createNote(name, "active personal fact about lighthouses");
    const old = db.createNote(name, "old fact about tides v1");
    db.reviseNote(name, old, "old fact about tides v2");
    db.createNote(name, "[compaction] cycle 12 summary");
    db.createMemoryPool("pool_memapi_filter", "memapi-filter", name);
    db.addPoolNote("pool_memapi_filter", name, "a pool deposit", 5);

    const res = await fetch(`${BASE}/notes`, { headers: H });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notes: Array<{ id: number; content: string }> };
    const contents = body.notes.map((n) => n.content);
    expect(contents).toContain("active personal fact about lighthouses");
    expect(contents).toContain("old fact about tides v2");
    expect(contents).not.toContain("old fact about tides v1");
    expect(contents.some((c) => c.startsWith("[compaction]"))).toBe(false);
    expect(contents).not.toContain("a pool deposit");
    expect(body.notes.some((n) => n.id === keep)).toBe(true);

    const raw = await fetch(`${BASE}/notes?all=1`, { headers: H });
    const rawBody = (await raw.json()) as { notes: Array<{ content: string }> };
    const rawContents = rawBody.notes.map((n) => n.content);
    expect(rawContents).toContain("old fact about tides v1");
    expect(rawContents.some((c) => c.startsWith("[compaction]"))).toBe(true);
    expect(rawContents).toContain("a pool deposit");
  });

  it("GET /mem/recall accepts long weight names as aliases for wi/wr/wrel", async () => {
    const res = await fetch(
      `${BASE}/recall?q=test&weightImportance=0.5&weightRecency=0.2&weightRelevance=0.3`,
      { headers: HEADERS },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { weights: Record<string, number> };
    expect(body.weights).toEqual({
      weightImportance: 0.5,
      weightRecency: 0.2,
      weightRelevance: 0.3,
    });

    const bad = await fetch(`${BASE}/recall?q=test&weightImportance=7`, { headers: HEADERS });
    expect(bad.status).toBe(400);
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
      headers: { "X-Agent-Name": "other_agent" },
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
      headers: { "X-Agent-Name": "isolated_agent_xyz" },
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.count).toBe(0);
  });

  it("agents cannot see each other's core memory", async () => {
    const res = await fetch(`${BASE}/core/goal`, {
      headers: { "X-Agent-Name": "isolated_agent_xyz" },
    });
    expect(res.status).toBe(404);
  });

  it("normalizes the open-mode X-Agent-Name like a login name (reserved namespaces unreachable)", async () => {
    // `memory:<principal>` is the durable service silo's entity_name prefix; a
    // header must not be able to name it. The sanitized namespace is what the
    // caller gets — consistently across writes and reads.
    const create = await fetch(`${BASE}/notes`, {
      method: "POST",
      headers: { "X-Agent-Name": "memory:spoof-ns", "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Spoofed namespace scratch note" }),
    });
    expect(create.status).toBe(201);
    const { note } = (await create.json()) as { note: { entity_name: string } };
    expect(note.entity_name).toBe("memoryspoofns");

    const list = await fetch(`${BASE}/notes`, { headers: { "X-Agent-Name": "memoryspoofns" } });
    expect(((await list.json()) as { count: number }).count).toBe(1);

    // A header with nothing left after normalization is a 400, not a namespace.
    const empty = await fetch(`${BASE}/notes`, { headers: { "X-Agent-Name": "::/.." } });
    expect(empty.status).toBe(400);
  });

  it("GET /mem/recall and /mem/context never serve another principal's durable records", async () => {
    const fx = await seedUnifiedFixture(engine, db, {
      owner: "RecallOwnerA",
      worker: "RecallWkrB",
    });
    // Find the durable record's backing legacy note (entity_name = memory:<principal>).
    const raw = (db as unknown as { db: import("bun:sqlite").Database }).db;
    const row = raw
      .query(
        "SELECT n.id AS id, n.entity_name AS entity_name FROM notes n JOIN memory_record_versions v ON v.note_id = n.id WHERE v.record_id = ?",
      )
      .get(fx.recordId) as { id: number; entity_name: string };
    expect(row.entity_name.startsWith("memory:")).toBe(true);

    for (const spoof of [row.entity_name, `${row.entity_name}!`]) {
      const recall = await fetch(`${BASE}/recall?q=${encodeURIComponent(FIXTURE_QUERY)}`, {
        headers: { "X-Agent-Name": spoof },
      });
      expect(recall.status).toBe(200);
      const body = (await recall.json()) as { results: Array<{ id: number }> };
      expect(body.results.some((r) => r.id === row.id)).toBe(false);

      const ctx = await fetch(`${BASE}/context?q=${encodeURIComponent(FIXTURE_QUERY)}`, {
        headers: { "X-Agent-Name": spoof },
      });
      expect(ctx.status).toBe(200);
      const context = (await ctx.json()) as UnifiedContextResult;
      const legacyIds = context.tiers
        .filter((t) => t.tier !== "evidence" && t.tier !== "proposal")
        .flatMap((t) => t.items.map((i) => i.id));
      expect(legacyIds).not.toContain(String(row.id));
      // No world account of that (sanitized) name → durable tiers degrade, not leak.
      expect(context.tiers.find((t) => t.tier === "evidence")?.items ?? []).toHaveLength(0);
    }

    // The owner still recalls its own legacy notes through the same route.
    const own = await fetch(`${BASE}/context?q=${encodeURIComponent(FIXTURE_QUERY)}`, {
      headers: { "X-Agent-Name": fx.owner },
    });
    const ownCtx = (await own.json()) as UnifiedContextResult;
    expect(ownCtx.tiers.some((t) => t.items.length > 0)).toBe(true);
  });

  // ── Unified context ────────────────────────────────────────────────────

  describe("GET /mem/context", () => {
    it("returns the same unified tiers/ids as buildUnifiedContext for a world account", async () => {
      const fx = await seedUnifiedFixture(engine, db, {
        owner: "ContextAda",
        worker: "ContextBea",
      });
      const direct = await buildUnifiedContext(db, fx.owner, FIXTURE_QUERY);
      const res = await fetch(`${BASE}/context?q=${encodeURIComponent(FIXTURE_QUERY)}`, {
        headers: { "X-Agent-Name": fx.owner },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as UnifiedContextResult;
      expect(body.schema).toBe("marina.memory.context.v1");
      expect(body.entity).toBe(fx.owner);
      expect(body.degraded).toEqual([]);
      expect(body.budgetBytes).toBe(2048);
      const sorted = (m: Record<string, string[]>) =>
        Object.fromEntries(Object.entries(m).map(([k, v]) => [k, [...v].sort()]));
      expect(sorted(tierIds(body))).toEqual(sorted(tierIds(direct)));
      expect(tierIds(body).proposal).toEqual([fx.jobId]);
      expect(tierIds(body).evidence!.sort()).toEqual([fx.recordId, fx.sourceId].sort());

      // budget + scope params
      const small = (await (
        await fetch(
          `${BASE}/context?q=${encodeURIComponent(FIXTURE_QUERY)}&budget=300&scope=evidence`,
          { headers: { "X-Agent-Name": fx.owner } },
        )
      ).json()) as UnifiedContextResult;
      expect(small.budgetBytes).toBe(300);
      expect(small.scope).toBe("evidence");
      expect(Object.keys(tierIds(small)).every((t) => t === "evidence" || t === "proposal")).toBe(
        true,
      );
    });

    it("degrades durable tiers for a namespace without a world account (legacy still served)", async () => {
      await fetch(`${BASE}/notes`, {
        method: "POST",
        headers: { "X-Agent-Name": "ghost_namespace", "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Amber deployment port scratch note" }),
      });
      const res = await fetch(`${BASE}/context?q=${encodeURIComponent(FIXTURE_QUERY)}`, {
        headers: { "X-Agent-Name": "ghost_namespace" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as UnifiedContextResult;
      expect(tierIds(body).unverified).toHaveLength(1);
      expect(body.degraded.map((d) => `${d.tier}:${d.code}`).sort()).toEqual([
        "evidence:world_identity_required",
        "proposal:world_identity_required",
      ]);
    });

    it("validates parameters", async () => {
      expect((await fetch(`${BASE}/context`, { headers: HEADERS })).status).toBe(400);
      expect((await fetch(`${BASE}/context?q=x&budget=abc`, { headers: HEADERS })).status).toBe(
        400,
      );
      expect((await fetch(`${BASE}/context?q=x&budget=10`, { headers: HEADERS })).status).toBe(400);
      expect((await fetch(`${BASE}/context?q=x&scope=nope`, { headers: HEADERS })).status).toBe(
        400,
      );
    });

    it("is documented in the API description", async () => {
      const body = (await (await fetch(BASE)).json()) as {
        endpoints: {
          recall: Record<string, { params?: Record<string, string>; response?: unknown }>;
        };
      };
      const doc = body.endpoints.recall["GET /mem/context"];
      expect(doc).toBeDefined();
      expect(doc!.params!.q).toBeDefined();
      expect(JSON.stringify(doc!.response)).toContain("world_identity_required");
    });
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
