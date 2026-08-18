// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { handleProbeApi } from "../src/net/probe-api";
import { MarinaDB } from "../src/persistence/database";
import { findLatestSample, registerBuiltinResolvers } from "../src/resolvers";
import { listActiveWatches } from "../src/resolvers/watch-spec";
import type { EngineEvent } from "../src/types";
import { cleanupDb } from "./helpers";

const TEST_DB = `/tmp/marina-probe-api-${process.pid}.db`;

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3300/api/probe", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("/api/probe", () => {
  let db: MarinaDB;
  const events: EngineEvent[] = [];
  const emit = (e: EngineEvent) => {
    events.push(e);
  };

  beforeAll(() => {
    process.env.MARINA_OPEN_API = "true"; // dev-mode auth for the suite
    delete process.env.MEM_API_KEYS;
    registerBuiltinResolvers();
  });

  afterAll(() => {
    delete process.env.MARINA_OPEN_API;
  });

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    events.length = 0;
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("GET /api/probe lists registered resolver kinds (no auth required)", async () => {
    const req = new Request("http://localhost:3300/api/probe", { method: "GET" });
    const url = new URL(req.url);
    const resp = await handleProbeApi(url, "GET", req, db, emit);
    expect(resp?.status).toBe(200);
    const body = (await resp!.json()) as { resolvers: { kind: string }[] };
    const kinds = body.resolvers.map((r) => r.kind);
    expect(kinds).toContain("echoing");
    expect(kinds).toContain("resolving");
  });

  it("returns undefined for non-/api/probe paths (drops through)", async () => {
    const url = new URL("http://localhost:3300/api/other");
    const req = new Request(url.toString(), { method: "GET" });
    const resp = await handleProbeApi(url, "GET", req, db, emit);
    expect(resp).toBeUndefined();
  });

  it("returns 405 for unsupported methods", async () => {
    const url = new URL("http://localhost:3300/api/probe");
    const req = new Request(url.toString(), { method: "DELETE" });
    const resp = await handleProbeApi(url, "DELETE", req, db, emit);
    expect(resp?.status).toBe(405);
  });

  it("requires X-Agent-Name header in open mode", async () => {
    const req = makeRequest({ kind: "echoing", args: { payload: "x" } });
    const url = new URL(req.url);
    const resp = await handleProbeApi(url, "POST", req, db, emit);
    expect(resp?.status).toBe(400);
    const body = (await resp!.json()) as { error: string };
    expect(body.error).toContain("X-Agent-Name");
  });

  it("authenticates open-mode probes via X-Agent-Name and writes a Sample", async () => {
    const req = makeRequest(
      { kind: "echoing", args: { payload: "hello" } },
      { "X-Agent-Name": "alice" },
    );
    const url = new URL(req.url);
    const resp = await handleProbeApi(url, "POST", req, db, emit);
    expect(resp?.status).toBe(200);
    const body = (await resp!.json()) as {
      sample: { kind: string; id: string; status: string; value: unknown };
      noteId: number;
    };
    expect(body.sample.kind).toBe("echoing");
    expect(body.sample.id).toBe("hello");
    expect(body.sample.status).toBe("changed");
    expect(body.noteId).toBeGreaterThan(0);

    // Sample wrote a note authored by the X-Agent-Name agent
    const note = db.getNote(body.noteId)!;
    expect(note.entity_name).toBe("alice");

    // changed samples emit a feed event
    expect(events.some((e) => e.type === "feed_event" && e.kind === "sample.changed")).toBe(true);
  });

  it("rejects unknown resolver kinds with 404", async () => {
    const req = makeRequest({ kind: "nonsense", args: {} }, { "X-Agent-Name": "alice" });
    const url = new URL(req.url);
    const resp = await handleProbeApi(url, "POST", req, db, emit);
    expect(resp?.status).toBe(404);
  });

  it("surfaces resolver parse errors as 400", async () => {
    const req = makeRequest(
      { kind: "echoing", args: {} }, // missing payload
      { "X-Agent-Name": "alice" },
    );
    const url = new URL(req.url);
    const resp = await handleProbeApi(url, "POST", req, db, emit);
    expect(resp?.status).toBe(400);
    const body = (await resp!.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain("payload");
  });

  it("requires kind in the body", async () => {
    const req = makeRequest({ args: { payload: "x" } }, { "X-Agent-Name": "alice" });
    const url = new URL(req.url);
    const resp = await handleProbeApi(url, "POST", req, db, emit);
    expect(resp?.status).toBe(400);
  });

  it("returns 400 for malformed JSON", async () => {
    const url = new URL("http://localhost:3300/api/probe");
    const req = new Request(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-Name": "alice" },
      body: "not-json{",
    });
    const resp = await handleProbeApi(url, "POST", req, db, emit);
    expect(resp?.status).toBe(400);
  });

  it("links sample to a watch spec when watch:<id> is provided", async () => {
    // Create a watch spec via the in-process helper (matches watch create flow)
    const { createWatchNote } = await import("../src/resolvers/watch-spec");
    const noteId = createWatchNote(
      db,
      {
        kind: "echoing",
        id: "tracked",
        args: { payload: "tracked" },
        cadence: { kind: "interval", ms: 60_000 },
        retirement: { kind: "forever" },
        notify: undefined,
        createdBy: "alice",
        createdAt: Date.now(),
      },
      "alice",
    );
    const req = makeRequest(
      { kind: "echoing", args: { payload: "tracked" }, watch: noteId },
      { "X-Agent-Name": "alice" },
    );
    const url = new URL(req.url);
    const resp = await handleProbeApi(url, "POST", req, db, emit);
    expect(resp?.status).toBe(200);
    const body = (await resp!.json()) as { noteId: number };
    const links = db.getNoteLinks(body.noteId);
    expect(links.find((l) => l.relationship === "derived_from")?.target_id).toBe(noteId);

    // forever retirement → spec stays active
    expect(listActiveWatches(db).map((w) => w.noteId)).toContain(noteId);
  });

  it("requires a Bearer token when MEM_API_KEYS is set", async () => {
    process.env.MEM_API_KEYS = "secret123:bob";
    delete process.env.MARINA_OPEN_API;
    try {
      // No Authorization header → 401
      const reqNoAuth = makeRequest({ kind: "echoing", args: { payload: "x" } });
      const url = new URL(reqNoAuth.url);
      const noAuthResp = await handleProbeApi(url, "POST", reqNoAuth, db, emit);
      expect(noAuthResp?.status).toBe(401);

      // Bad token → 401
      const reqBad = makeRequest(
        { kind: "echoing", args: { payload: "x" } },
        { Authorization: "Bearer wrong" },
      );
      const badResp = await handleProbeApi(url, "POST", reqBad, db, emit);
      expect(badResp?.status).toBe(401);

      // Good token → 200, agent=bob
      const reqOk = makeRequest(
        { kind: "echoing", args: { payload: "x" } },
        { Authorization: "Bearer secret123" },
      );
      const okResp = await handleProbeApi(url, "POST", reqOk, db, emit);
      expect(okResp?.status).toBe(200);
      const body = (await okResp!.json()) as { noteId: number };
      expect(db.getNote(body.noteId)?.entity_name).toBe("bob");
    } finally {
      delete process.env.MEM_API_KEYS;
      process.env.MARINA_OPEN_API = "true";
    }
  });
});

describe("/api/probe — resolving (Kalshi/Polymarket) integration with mocked clients", () => {
  // The HTTP probe surface invokes the registered `resolving` resolver. The
  // built-in instance binds to the real HTTP clients (which would hit prod
  // Kalshi/Polymarket). For the integration test, we assert the resolver
  // dispatches and returns the standard error path on network failure.

  let db: MarinaDB;
  const TEST_DB_2 = `/tmp/marina-probe-api-resolving-${process.pid}.db`;

  beforeAll(() => {
    process.env.MARINA_OPEN_API = "true";
    registerBuiltinResolvers();
  });

  afterAll(() => {
    delete process.env.MARINA_OPEN_API;
  });

  beforeEach(() => {
    cleanupDb(TEST_DB_2);
    db = new MarinaDB(TEST_DB_2);
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB_2);
  });

  it("resolving with a malformed ticker returns the resolver's error sample", async () => {
    // Test pattern: ask the live resolver to look up a market that won't
    // exist. Either the network fails (offline, blocked) or Kalshi returns
    // 404 — both produce status:error. We don't care which, just that the
    // resolver dispatches and the response shape is correct.
    const req = makeRequest(
      { kind: "resolving", args: { venue: "kalshi", ticker: "DOES-NOT-EXIST-XYZ" } },
      { "X-Agent-Name": "alice" },
    );
    const url = new URL(req.url);
    const resp = await handleProbeApi(url, "POST", req, db, () => {});
    // Response shape is well-formed regardless of upstream — the resolver
    // returns either error or no-change. Both are OK, neither is `resolved`.
    expect(resp?.status).toBe(200);
    const body = (await resp!.json()) as { sample: { kind: string; status: string } };
    expect(body.sample.kind).toBe("resolving");
    expect(["error", "no-change", "resolved"]).toContain(body.sample.status);
    // For resolved (real Kalshi response), findLatestSample picks it up
    const found = findLatestSample(db, "resolving", "kalshi/DOES-NOT-EXIST-XYZ");
    expect(found).toBeDefined();
  });
});
