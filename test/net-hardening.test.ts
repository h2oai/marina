// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Network hardening contracts: the shared bounded JSON reader, the error-code
// contract on representative routes, failed-auth throttling, limiter-before-
// parse on the pre-auth ingress, path-decoding refusals, hashed memory API
// keys (migration 143), `POST /mem/keys`, the Ollama field refusals, upstream
// deadlines and the shared connect/health handlers.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getInternalModelToken } from "../src/agent/agent-runtime";
import { RateLimiter } from "../src/auth/rate-limiter";
import { handleConnectRoutes, healthResponse } from "../src/net/connect-api";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { ensureErrorCode } from "../src/net/dashboard-api/shared";
import { handleEntityApi } from "../src/net/entity-api";
import {
  errorBody,
  inferHttpErrorCode,
  rateLimitedResponse,
  readJsonBody,
  resetHttpRateLimitersForTests,
  SMALL_JSON_BODY_BYTES,
  withErrorCode,
} from "../src/net/http-utils";
import { handleMemApi } from "../src/net/mem-api";
import { handleModelApi } from "../src/net/model-api";
import { proxyToAnthropic } from "../src/net/model-api/anthropic-bridge";
import { validateOllamaRequest } from "../src/net/model-api/ollama";
import { hasInternalBearer, upstreamAbort } from "../src/net/model-api/shared";
import { MarinaDB } from "../src/persistence/database";
import { hashMemApiKeySecret } from "../src/persistence/db-notes";
import { FORWARD_MIGRATIONS } from "../src/persistence/schema";
import { createTestEngine } from "./engine-fixture";
import { cleanupDb, MockConnection, until } from "./helpers";
import { scopeProcessState } from "./process-state";

const peer = (address: string) => ({ requestIP: () => ({ address }) });

function jsonRequest(url: string, body: string | object, init: RequestInit = {}): Request {
  return new Request(url, {
    method: "POST",
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => resetHttpRateLimitersForTests());

/** A real session token minted by a normal login; the connection is freed so it can be reused. */
function sessionToken(world: ReturnType<typeof createTestEngine>, name: string): string {
  const conn = new MockConnection(`net-${crypto.randomUUID()}`);
  world.engine.addConnection(conn);
  const login = world.engine.login(conn.id, name);
  if ("error" in login) throw new Error(login.error);
  world.engine.removeConnection(conn.id);
  return login.token;
}

describe("shared bounded JSON reader", () => {
  it("answers malformed JSON with 400 invalid_json", async () => {
    const read = await readJsonBody(jsonRequest("http://x/r", "{ nope"));
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.response.status).toBe(400);
    expect(await read.response.json()).toEqual({
      error: "Invalid JSON body",
      code: "invalid_json",
    });
  });

  it("answers a non-object body with 400 expected_object", async () => {
    const read = await readJsonBody(jsonRequest("http://x/r", "[1,2]"));
    expect(read.ok).toBe(false);
    if (!read.ok)
      expect(((await read.response.json()) as { code: string }).code).toBe("expected_object");
  });

  it("refuses a declared Content-Length over the route cap before reading", async () => {
    const req = jsonRequest("http://x/r", JSON.stringify({ pad: "x".repeat(200) }));
    const read = await readJsonBody(req, { maxBytes: 64 });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.response.status).toBe(413);
    expect(((await read.response.json()) as { code: string }).code).toBe("payload_too_large");
  });

  it("cancels a chunked body as soon as it crosses the cap", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls > 100) return controller.close();
        controller.enqueue(new Uint8Array(1024).fill(32));
      },
    });
    const req = new Request("http://x/r", { method: "POST", body });
    const read = await readJsonBody(req, { maxBytes: 4096 });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.response.status).toBe(413);
    expect(pulls).toBeLessThan(20);
  });

  it("treats an empty body as {} only when the route allows it", async () => {
    const empty = () => new Request("http://x/r", { method: "POST" });
    expect((await readJsonBody(empty(), { allowEmpty: true })).ok).toBe(true);
    expect((await readJsonBody(empty())).ok).toBe(false);
  });
});

describe("error-code contract", () => {
  it("infers a string code from the status and keeps an explicit one", () => {
    expect(inferHttpErrorCode(404)).toBe("not_found");
    expect(inferHttpErrorCode(429)).toBe("rate_limited");
    expect(inferHttpErrorCode(599)).toBe("internal_error");
    expect(errorBody(403, "no")).toEqual({ error: "no", code: "forbidden" });
    expect(withErrorCode({ error: "x", code: "mine" }, 400)).toEqual({ error: "x", code: "mine" });
    expect(withErrorCode({ error: "not_found" }, 404)).toEqual({
      error: "not_found",
      code: "not_found",
    });
    expect(withErrorCode({ ok: true }, 200)).toEqual({ ok: true });
  });

  it("the shared 429 body carries a code", async () => {
    expect(((await rateLimitedResponse(null).json()) as { code: string }).code).toBe(
      "rate_limited",
    );
  });

  it("ensureErrorCode backfills a hand-built JSON error response", async () => {
    const coded = await ensureErrorCode(Response.json({ error: "I am a teapot" }, { status: 418 }));
    expect(await coded.json()).toEqual({ error: "I am a teapot", code: "bad_request" });
    const ok = Response.json({ fine: true });
    expect(await ensureErrorCode(ok)).toBe(ok);
  });

  describe("representative dashboard routes", () => {
    let world: ReturnType<typeof createTestEngine>;
    beforeEach(() => {
      world = createTestEngine();
    });
    afterEach(() => world.dispose());

    const call = async (path: string, init: RequestInit = {}) => {
      const url = new URL(`http://localhost${path}`);
      const req = new Request(url, init);
      return (await handleDashboardApi(req, url, req.method, world.engine, world.db))!;
    };
    it("401, 403, 404 and 400 bodies all carry a string code", async () => {
      const unauth = await call("/api/agents");
      expect(unauth.status).toBe(401);
      expect(((await unauth.json()) as { code: unknown }).code).toBe("unauthorized");

      const bearer = sessionToken(world, "Coder");
      const auth = { headers: { Authorization: `Bearer ${bearer}` } };

      const missing = await call("/api/definitely-not-a-route", auth);
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as { code: unknown }).code).toBe("not_found");

      const forbidden = await call("/api/agents/spawn", {
        method: "POST",
        headers: { ...auth.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x" }),
      });
      expect(forbidden.status).toBe(403);
      expect(((await forbidden.json()) as { code: unknown }).code).toBe("forbidden");

      const badPath = await call("/api/entities/%E0", auth);
      expect(badPath.status).toBe(400);
      expect(((await badPath.json()) as { code: unknown }).code).toBe("invalid_path_encoding");
    });
  });
});

describe("pre-auth ingress", () => {
  let world: ReturnType<typeof createTestEngine>;
  beforeEach(() => {
    world = createTestEngine();
  });
  afterEach(() => world.dispose());

  const post = async (path: string, body: string, peerIp = "203.0.113.9") => {
    const url = new URL(`http://localhost${path}`);
    const req = jsonRequest(url.toString(), body);
    return (await handleDashboardApi(req, url, "POST", world.engine, world.db, peerIp))!;
  };

  it("spends the per-IP budget BEFORE the body is parsed", async () => {
    using _state = scopeProcessState({ rateLimitBypass: false });
    const limiter = new RateLimiter({ maxTokens: 1, refillRate: 1, refillInterval: 60_000 });
    (world.engine as { rateLimiter?: RateLimiter }).rateLimiter = limiter;
    while (limiter.consume("api:203.0.113.9"));
    const resp = await post("/api/command", "{ malformed");
    expect(resp.status).toBe(429);
    expect(((await resp.json()) as { code: string }).code).toBe("rate_limited");
  });

  it("caps the pre-auth body at the small-body limit", async () => {
    const big = JSON.stringify({ command: "look", pad: "x".repeat(SMALL_JSON_BODY_BYTES) });
    const resp = await post("/api/command", big, "203.0.113.10");
    expect(resp.status).toBe(413);
    expect(((await resp.json()) as { code: string }).code).toBe("payload_too_large");
  });

  it("runs the command through the engine's FIFO submit path", async () => {
    const submitted: string[] = [];
    const original = world.engine.submitCommand.bind(world.engine);
    world.engine.submitCommand = (entityId, raw, execute) => {
      submitted.push(raw);
      return original(entityId, raw, execute);
    };
    const resp = await post("/api/command", JSON.stringify({ command: "look" }), "203.0.113.11");
    expect(resp.status).toBe(200);
    expect(submitted).toEqual(["look"]);
    const body = (await resp.json()) as { perceptions: unknown[] };
    expect(body.perceptions.length).toBeGreaterThan(0);
  });

  it("answers 503 command_capacity when admission refuses the command", async () => {
    world.engine.submitCommand = () => false;
    const resp = await post("/api/command", JSON.stringify({ command: "look" }), "203.0.113.12");
    expect(resp.status).toBe(503);
    expect(((await resp.json()) as { code: string }).code).toBe("command_capacity");
  });

  it("/api/setup-status uses the named, evicting setupStatus limiter", async () => {
    using _state = scopeProcessState({ rateLimitBypass: false });
    const get = async () => {
      const url = new URL("http://localhost/api/setup-status");
      const req = new Request(url);
      return (await handleDashboardApi(req, url, "GET", world.engine, world.db, "198.51.100.3"))!;
    };
    for (let i = 0; i < 20; i++) expect((await get()).status).toBe(200);
    const limited = await get();
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { code: string }).code).toBe("rate_limited");
  });
});

describe("public entity profile path decoding", () => {
  it("answers 400 invalid_path_encoding for a malformed escape instead of throwing", async () => {
    const world = createTestEngine();
    try {
      const url = new URL("http://localhost/api/entity/%E0/profile");
      const resp = (await handleEntityApi(url, "GET", world.db, world.engine, "192.0.2.1"))!;
      expect(resp.status).toBe(400);
      expect(((await resp.json()) as { code: string }).code).toBe("invalid_path_encoding");
    } finally {
      await world.dispose();
    }
  });
});

describe("failed-auth throttling", () => {
  let world: ReturnType<typeof createTestEngine>;
  beforeEach(() => {
    world = createTestEngine();
  });
  afterEach(() => world.dispose());

  it("/v1 refuses an IP after 20 rejected keys, before comparing its credential", async () => {
    using _state = scopeProcessState({ env: { MODEL_API_KEYS: "sk-good-key" } });
    const call = (key: string, ip = "198.51.100.20") => {
      const url = new URL("http://localhost/v1/models");
      const req = new Request(url, { headers: { Authorization: `Bearer ${key}` } });
      return handleModelApi(url, "GET", req, world.engine, undefined, peer(ip));
    };
    for (let i = 0; i < 20; i++) expect((await call(`bad-${i}`))!.status).toBe(401);
    const locked = (await call("sk-good-key"))!;
    expect(locked.status).toBe(429);
    expect(((await locked.json()) as { error: { code: string } }).error.code).toBe(
      "rate_limit_exceeded",
    );
    // Another address is unaffected, and the internal token is never locked out.
    expect((await call("sk-good-key", "198.51.100.21"))!.status).toBe(200);
    expect((await call(getInternalModelToken()))!.status).toBe(200);
  });

  it("/mem refuses an IP after 20 rejected keys", async () => {
    using _state = scopeProcessState({ env: { MEM_API_KEYS: "mem-good:Alice" } });
    const call = (key: string) => {
      const url = new URL("http://localhost/mem/stats");
      const req = new Request(url, { headers: { Authorization: `Bearer ${key}` } });
      return handleMemApi(url, "GET", req, world.db, undefined, { peer: "198.51.100.30" });
    };
    for (let i = 0; i < 20; i++) {
      const resp = (await call(`bad-${i}`))!;
      expect(resp.status).toBe(401);
      expect(((await resp.json()) as { code: string }).code).toBe("invalid_api_key");
    }
    expect((await call("mem-good"))!.status).toBe(429);
  });

  it("rate-limits the cheap /v1 reads per IP", async () => {
    using _state = scopeProcessState({ rateLimitBypass: false, env: { MARINA_OPEN_API: "true" } });
    const call = () => {
      const url = new URL("http://localhost/v1/health");
      return handleModelApi(
        url,
        "GET",
        new Request(url),
        world.engine,
        undefined,
        peer("192.0.2.50"),
      );
    };
    for (let i = 0; i < 120; i++) expect((await call())!.status).toBe(200);
    expect((await call())!.status).toBe(429);
  });
});

describe("memory API keys", () => {
  const DB = `test_net_hardening_mem_${process.pid}.db`;
  afterEach(() => cleanupDb(DB));

  it("stores a digest, validates the raw secret, and never matches the digest itself", () => {
    const db = new MarinaDB(DB);
    try {
      db.createMemApiKey("k1", "raw-secret", "Alice");
      const row = db.listMemApiKeys()[0]!;
      expect(row.secret).toBe(hashMemApiKeySecret("raw-secret"));
      expect(row.secret).not.toContain("raw-secret");
      expect(db.validateMemApiKey("raw-secret")?.agent_name).toBe("Alice");
      expect(db.validateMemApiKey(row.secret)).toBeUndefined();
      expect(db.validateMemApiKey("wrong")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("migration 143 hashes existing plaintext rows and leaves hashed rows alone", () => {
    new MarinaDB(DB).close();
    const raw = new Database(DB);
    const now = Date.now();
    raw.run("INSERT INTO mem_api_keys (id, secret, agent_name, created_at) VALUES (?, ?, ?, ?)", [
      "legacy",
      "legacy-plain",
      "Bob",
      now,
    ]);
    raw.run("INSERT INTO mem_api_keys (id, secret, agent_name, created_at) VALUES (?, ?, ?, ?)", [
      "hashed",
      hashMemApiKeySecret("already"),
      "Cara",
      now,
    ]);
    const migration = FORWARD_MIGRATIONS.find((m) => m.version === 143)!;
    raw.exec(migration.sql);
    migration.apply!(raw);
    const rows = raw.query("SELECT id, secret FROM mem_api_keys ORDER BY id").all() as {
      id: string;
      secret: string;
    }[];
    expect(rows).toEqual([
      { id: "hashed", secret: hashMemApiKeySecret("already") },
      { id: "legacy", secret: hashMemApiKeySecret("legacy-plain") },
    ]);
    raw.close();
    const db = new MarinaDB(DB);
    try {
      expect(db.validateMemApiKey("legacy-plain")?.agent_name).toBe("Bob");
    } finally {
      db.close();
    }
  });

  it("env keys still resolve by constant-time membership over every configured key", async () => {
    const world = createTestEngine();
    try {
      using _state = scopeProcessState({ env: { MEM_API_KEYS: "k-one:Alice,k-two:Bob" } });
      const stats = async (key: string) => {
        const url = new URL("http://localhost/mem/stats");
        const req = new Request(url, { headers: { Authorization: `Bearer ${key}` } });
        return (await (await handleMemApi(url, "GET", req, world.db))!.json()) as {
          agent?: string;
        };
      };
      expect((await stats("k-one")).agent).toBe("Alice");
      expect((await stats("k-two")).agent).toBe("Bob");
    } finally {
      await world.dispose();
    }
  });
});

describe("POST /mem/keys", () => {
  let world: ReturnType<typeof createTestEngine>;
  beforeEach(() => {
    world = createTestEngine();
  });
  afterEach(() => world.dispose());

  const create = (headers: Record<string, string>, body: object = { agent: "Scout" }) => {
    const url = new URL("http://localhost/mem/keys");
    const req = jsonRequest(url.toString(), body, { headers });
    return handleMemApi(url, "POST", req, world.db, undefined, { engine: world.engine });
  };

  it("refuses an unauthenticated caller and a caller without key.manage", async () => {
    expect((await create({}))!.status).toBe(401);
    const denied = (await create({ Authorization: `Bearer ${sessionToken(world, "Plain")}` }))!;
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { code: string }).code).toBe("forbidden");
  });

  it("the desktop operator mints a key shown once that opens the namespace", async () => {
    const operatorToken = "d".repeat(40);
    using _state = scopeProcessState({ env: { MARINA_DESKTOP_API_TOKEN: operatorToken } });
    const resp = (await create({ "X-Marina-Desktop-Token": operatorToken }))!;
    expect(resp.status).toBe(201);
    const minted = (await resp.json()) as { id: string; agent: string; secret: string };
    expect(minted.agent).toBe("Scout");
    expect(world.db.listMemApiKeys().some((k) => k.secret === minted.secret)).toBe(false);
    const url = new URL("http://localhost/mem/stats");
    const req = new Request(url, { headers: { Authorization: `Bearer ${minted.secret}` } });
    const stats = (await (await handleMemApi(url, "GET", req, world.db))!.json()) as {
      agent: string;
    };
    expect(stats.agent).toBe("Scout");
  });
});

describe("Ollama field refusals", () => {
  it("refuses tools, format, images, think and unmapped options; passes mapped/runtime options", async () => {
    const code = async (resp: Response | undefined) =>
      resp ? ((await resp.json()) as { error: { code: string; param: string } }).error : undefined;
    expect(
      await code(validateOllamaRequest("chat", { tools: [{ type: "function" }] })),
    ).toMatchObject({ code: "unsupported_parameter", param: "tools" });
    expect(await code(validateOllamaRequest("chat", { format: "json" }))).toMatchObject({
      param: "format",
    });
    expect(await code(validateOllamaRequest("chat", { think: true }))).toMatchObject({
      param: "think",
    });
    expect(
      await code(
        validateOllamaRequest("chat", {
          messages: [{ role: "user", content: "x", images: ["a"] }],
        }),
      ),
    ).toMatchObject({ param: "messages[].images" });
    expect(await code(validateOllamaRequest("generate", { raw: true }))).toMatchObject({
      param: "raw",
    });
    expect(await code(validateOllamaRequest("chat", { options: { top_k: 5 } }))).toMatchObject({
      param: "options.top_k",
    });
    expect(
      validateOllamaRequest("chat", {
        think: false,
        tools: [],
        options: { temperature: 0.2, num_predict: 5, seed: 1, num_ctx: 8192 },
      }),
    ).toBeUndefined();
  });

  it("/api/chat answers 400 unsupported_parameter instead of dropping tools", async () => {
    const world = createTestEngine();
    try {
      using _state = scopeProcessState({ env: { MARINA_OPEN_API: "true" } });
      const url = new URL("http://localhost/api/chat");
      const req = jsonRequest(url.toString(), {
        model: "marina",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "f", parameters: {} } }],
      });
      const resp = (await handleModelApi(
        url,
        "POST",
        req,
        world.engine,
        undefined,
        peer("192.0.2.9"),
      ))!;
      expect(resp.status).toBe(400);
      expect(((await resp.json()) as { error: { code: string } }).error.code).toBe(
        "unsupported_parameter",
      );
    } finally {
      await world.dispose();
    }
  });
});

describe("upstream deadlines", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("aborts on the deadline and on a client disconnect; settle disarms both", async () => {
    using _state = scopeProcessState({ env: { MARINA_UPSTREAM_TIMEOUT_MS: "20" } });
    const timed = upstreamAbort();
    await until(() => timed.signal.aborted);
    expect(timed.timedOut()).toBe(true);

    const client = new AbortController();
    const byClient = upstreamAbort(client.signal);
    client.abort();
    expect(byClient.signal.aborted).toBe(true);
    expect(byClient.clientGone()).toBe(true);
    expect(byClient.timedOut()).toBe(false);

    const settled = upstreamAbort(new AbortController().signal);
    settled.settle();
    await Bun.sleep(40);
    expect(settled.signal.aborted).toBe(false);
  });

  it("a hung Anthropic upstream becomes a 504 instead of hanging the request", async () => {
    using _state = scopeProcessState({ env: { MARINA_UPSTREAM_TIMEOUT_MS: "30" } });
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as unknown as typeof fetch;
    const resp = await proxyToAnthropic(
      { model: "claude-x", messages: [{ role: "user", content: "hi" }] },
      "test-key",
      "claude-x",
    );
    expect(resp.status).toBe(504);
  });

  it("a non-streaming client disconnect aborts the in-flight upstream call", async () => {
    let upstreamSignal: AbortSignal | undefined;
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        upstreamSignal = init?.signal ?? undefined;
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as unknown as typeof fetch;
    const client = new AbortController();
    const pending = proxyToAnthropic(
      { model: "claude-x", messages: [{ role: "user", content: "hi" }] },
      "test-key",
      "claude-x",
      false,
      undefined,
      { clientSignal: client.signal },
    );
    await until(() => upstreamSignal !== undefined);
    client.abort();
    const resp = await pending;
    expect(upstreamSignal!.aborted).toBe(true);
    expect(resp.status).toBe(502);
  });
});

describe("drain bypass and shared discovery handlers", () => {
  it("hasInternalBearer is constant-time and never matches a missing token", () => {
    const ok = new Request("http://x", {
      headers: { Authorization: `Bearer ${getInternalModelToken()}` },
    });
    expect(hasInternalBearer(ok)).toBe(true);
    expect(
      hasInternalBearer(
        new Request("http://x", { headers: { Authorization: "Bearer undefined" } }),
      ),
    ).toBe(false);
    expect(hasInternalBearer(new Request("http://x"))).toBe(false);
  });

  it("both listeners serve /api/connect, /api/skill and /health from one implementation", async () => {
    const world = createTestEngine();
    try {
      const at = (path: string) => new URL(`http://localhost${path}`);
      const manifest = await handleConnectRoutes(
        new Request(at("/api/connect")),
        at("/api/connect"),
        world.engine,
      );
      expect(manifest?.status).toBe(200);
      const skill = await handleConnectRoutes(
        new Request(at("/api/skill")),
        at("/api/skill"),
        world.engine,
      );
      expect(skill?.headers.get("Content-Type")).toContain("text/markdown");
      expect(
        await handleConnectRoutes(new Request(at("/other")), at("/other"), world.engine),
      ).toBeUndefined();
      const health = (await healthResponse(world.engine, { protocol: "mcp" }).json()) as Record<
        string,
        unknown
      >;
      expect(health).toMatchObject({ status: "ok", protocol: "mcp", rooms: 1 });
    } finally {
      await world.dispose();
    }
  });
});
