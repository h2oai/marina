// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared canvas read check (src/engine/canvas-access.ts): a node on a
 * private (`entity`) canvas is read by its owner and admins, by another
 * principal only under an explicit, expiring grant, and is "not found" to
 * everyone else on every read path — the `canvas` command (which also backs
 * `marina_see` and the MCP `canvas` tool), `image`/`video describe`, the
 * canvas and asset HTTP APIs, asset bytes and journey projections. Public
 * canvases are unaffected. Model-API request images are granted to the
 * serving crew for the request's lifetime.
 */

import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CanvasReadGrants,
  canvasReaderFor,
  mayReadAsset,
  mayReadCanvas,
  readableNode,
} from "../src/engine/canvas-access";
import { resolveJourneyRecord } from "../src/engine/journey-projection";
import {
  clearVisionCache,
  loadVisualSource,
  resetVisionRateLimits,
} from "../src/engine/media/vision";
import { handleAssetApi, handleAssetServing } from "../src/net/asset-api";
import { handleCanvasApi } from "../src/net/canvas-api";
import { resetHttpRateLimitersForTests } from "../src/net/http-utils";
import { handleModelApi } from "../src/net/model-api";
import { REQUEST_IMAGE_GRANT_MARGIN_MS, requestImageGrant } from "../src/net/model-api/routing";
import { LocalStorageProvider } from "../src/storage/local-provider";
import type { EntityId } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { MockConnection } from "./helpers";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2]);
const PNG_URL = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;
const REMOTE = "203.0.113.9";

describe("canvas read rules and grants (pure)", () => {
  it("public canvases are open; entity canvases are owner and operator only", () => {
    expect(mayReadCanvas(undefined, {})).toBe(true);
    expect(mayReadCanvas({ scope: "global", scope_id: null }, {})).toBe(true);
    const priv = { scope: "entity", scope_id: "e_owner" };
    expect(mayReadCanvas(priv, { entityId: "e_owner" })).toBe(true);
    expect(mayReadCanvas(priv, { entityId: "e_x", isOperator: true })).toBe(true);
    expect(mayReadCanvas(priv, { entityId: "e_x" })).toBe(false);
    expect(mayReadCanvas(priv, {})).toBe(false);
    expect(mayReadCanvas(priv, undefined)).toBe(false);
  });

  it("a grant names one node and one principal, extends but never shortens, and expires", () => {
    let now = 1_000;
    const grants = new CanvasReadGrants(() => now);
    grants.grant({ nodeIds: ["n1"], principals: ["e_a"], ttlMs: 100, reason: "test" });
    expect(grants.allows("n1", "e_a")).toBe(true);
    expect(grants.allows("n1", "e_b")).toBe(false);
    expect(grants.allows("n2", "e_a")).toBe(false);
    expect(grants.allows("n1", undefined)).toBe(false);
    grants.grant({ nodeIds: ["n1"], principals: ["e_a"], ttlMs: 10, reason: "shorter" });
    now = 1_050;
    expect(grants.allows("n1", "e_a")).toBe(true);
    now = 1_100;
    expect(grants.allows("n1", "e_a")).toBe(false);
    expect(grants.list()).toEqual([]);
    grants.grant({ nodeIds: ["n3"], principals: ["e_c"], ttlMs: 5, reason: "prune" });
    now = 2_000;
    expect(grants.prune()).toBe(1);
  });
});

describe("private canvas nodes on every read path", () => {
  let assets: string;
  let fixture: ReturnType<typeof createTestEngine>;
  let originalFetch: typeof fetch;
  let saved: Record<string, string | undefined>;
  let owner: { id: EntityId; token: string; conn: MockConnection };
  let admin: { id: EntityId; token: string; conn: MockConnection };
  let stranger: { id: EntityId; token: string; conn: MockConnection };
  let crew: { id: EntityId; token: string; conn: MockConnection };

  function enter(name: string, rank: number) {
    const conn = new MockConnection(`c-${name}`);
    conn.peerIp = REMOTE;
    fixture.engine.addConnection(conn);
    const login = fixture.engine.login(conn.id, name);
    if (!("token" in login)) throw new Error(`login failed: ${login.error}`);
    fixture.engine.entities.get(login.entityId)!.properties.rank = rank;
    return { id: login.entityId, token: login.token, conn };
  }

  async function run(who: { id: EntityId; conn: MockConnection }, raw: string): Promise<string> {
    const before = who.conn.messages.length;
    await fixture.engine.processCommand(who.id, raw);
    return who.conn.allText().slice(before).join("\n");
  }

  beforeEach(async () => {
    assets = mkdtempSync(join(tmpdir(), "canvas-access-"));
    const storage = new LocalStorageProvider(assets);
    await storage.init();
    fixture = createTestEngine({ assetStorage: storage });
    fixture.db.setSetting("default_model", "openrouter/vision/model");
    clearVisionCache();
    resetVisionRateLimits();
    resetHttpRateLimitersForTests();
    saved = {
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      MARINA_VISION_MODEL: process.env.MARINA_VISION_MODEL,
      MARINA_DAILY_SPEND_CAP_USD: process.env.MARINA_DAILY_SPEND_CAP_USD,
      MARINA_OPEN_API: process.env.MARINA_OPEN_API,
      MODEL_API_KEYS: process.env.MODEL_API_KEYS,
    };
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    delete process.env.MARINA_VISION_MODEL;
    delete process.env.MARINA_DAILY_SPEND_CAP_USD;
    delete process.env.MARINA_OPEN_API;
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return Response.json({
        id: "c1",
        object: "chat.completion",
        created: 1,
        model: String(body.model),
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "A red square." },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      });
    }) as typeof fetch;

    owner = enter("Owner", 1);
    admin = enter("Admin", 9);
    stranger = enter("Stranger", 4);
    crew = enter("Crewmate", 1);

    const { db, engine } = fixture;
    await engine.storage!.put("pa.png", PNG, "image/png");
    db.createAsset({
      id: "pa",
      entityName: "Owner",
      filename: "secret.png",
      mimeType: "image/png",
      size: PNG.byteLength,
      storageKey: "pa.png",
      metadata: {},
    });
    db.createCanvas({
      id: "priv",
      name: "private-board",
      scope: "entity",
      scopeId: owner.id,
      creatorName: "Owner",
    });
    db.createNode({
      id: "pn-image",
      canvasId: "priv",
      type: "image",
      assetId: "pa",
      creatorName: "Owner",
    });
    db.createNode({
      id: "pn-text",
      canvasId: "priv",
      type: "text",
      data: { text: "the private plan", intent: { prompt: "do it", status: "pending" } },
      creatorName: "Owner",
    });
    db.createNode({
      id: "pn-other",
      canvasId: "priv",
      type: "text",
      data: { text: "x" },
      creatorName: "Owner",
    });
    db.createCanvasEdge({
      id: "pe1",
      canvasId: "priv",
      sourceId: "pn-text",
      targetId: "pn-other",
      relationship: "supports",
      creatorName: "Owner",
    });

    await engine.storage!.put("ga.png", PNG, "image/png");
    db.createAsset({
      id: "ga",
      entityName: "Owner",
      filename: "public.png",
      mimeType: "image/png",
      size: PNG.byteLength,
      storageKey: "ga.png",
      metadata: {},
    });
    db.createCanvas({ id: "pub", name: "public-board", creatorName: "Owner" });
    db.createNode({
      id: "gn-image",
      canvasId: "pub",
      type: "image",
      assetId: "ga",
      creatorName: "Owner",
    });
  });

  afterEach(async () => {
    setSystemTime();
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await fixture.dispose();
    rmSync(assets, { recursive: true, force: true });
  });

  const reader = (id: EntityId) => canvasReaderFor(fixture.engine, id);

  it("owner and admin load a private node; a stranger gets 'not found'", async () => {
    const own = await loadVisualSource(fixture.engine, "pn-image", reader(owner.id));
    expect(own.nodeId).toBe("pn-image");
    const adm = await loadVisualSource(fixture.engine, "node:pn-image", reader(admin.id));
    expect(adm.assetId).toBe("pa");
    for (const ref of ["pn-image", "node:pn-image", "asset:pa", "pa"]) {
      await expect(loadVisualSource(fixture.engine, ref, reader(stranger.id))).rejects.toThrow(
        /not found/,
      );
    }
  });

  it("a refusal reads exactly like a missing node", async () => {
    const denied = await run(stranger, "canvas look pn-text what is it");
    const missing = await run(stranger, "canvas look no-such-node what is it");
    expect(denied).toBe(missing.replace("no-such-node", "pn-text"));
    expect(denied).not.toContain("private plan");
  });

  it("canvas look, image describe and video describe refuse a stranger and serve the owner", async () => {
    expect(await run(stranger, "canvas look pn-image what")).toContain("not found");
    expect(await run(stranger, "canvas see node:pn-image")).toContain("not found");
    expect(await run(stranger, "image describe pn-image")).toContain("not found");
    expect(await run(stranger, "image describe asset:pa")).toContain("not found");
    expect(await run(stranger, "video describe pn-image")).toContain("not found");
    expect(await run(owner, "canvas look pn-image what")).toContain("A red square.");
    expect(await run(admin, "image describe pn-image")).toContain("A red square.");
  });

  it("the canvas command hides a private canvas from a stranger on every subcommand", async () => {
    expect(await run(stranger, "canvas list")).not.toContain("private-board");
    expect(await run(owner, "canvas list")).toContain("private-board");
    for (const sub of ["info", "nodes", "edges"]) {
      expect(await run(stranger, `canvas ${sub} private-board`)).toContain("not found");
      expect(await run(owner, `canvas ${sub} private-board`)).not.toContain("not found");
    }
    expect(await run(stranger, "canvas visit private-board")).toContain("No canvas or entity");
    expect(await run(stranger, "canvas visit Owner")).toContain("Owner's canvas is private");
    // A visit by a non-owner never creates another entity's canvas.
    expect(await run(stranger, "canvas visit Admin")).toContain("Admin's canvas is private");
    expect(fixture.db.getEntityCanvas(admin.id)).toBeUndefined();
    expect(await run(stranger, "canvas layout grid private-board")).toContain("not found");
    expect(await run(stranger, "canvas delete private-board")).toContain("not found");
    expect(await run(stranger, "canvas post on:private-board hi")).toContain("not found");
    expect(await run(stranger, "canvas publish image pa")).toContain("not found");
    expect(await run(stranger, "canvas publish image ga private-board")).toContain("not found");
    expect(await run(stranger, "canvas connect pn-text pn-other extends")).toContain(
      "doesn't exist",
    );
    expect(await run(stranger, "canvas disconnect pe1")).toContain("not found");
    expect(await run(stranger, "canvas intent list")).not.toContain("do it");
    expect(await run(owner, "canvas intent list")).toContain("do it");
    expect(await run(stranger, "canvas intent claim pn-text")).toContain("not found");
    expect(await run(stranger, "canvas asset list")).not.toContain("secret.png");
    expect(await run(owner, "canvas asset list")).toContain("secret.png");
    expect(await run(stranger, "canvas asset info pa")).toContain("not found");
    expect(await run(stranger, "canvas asset delete pa")).toContain("not found");
    expect(fixture.db.getAsset("pa")).toBeDefined();
    expect(fixture.db.getNodesByCanvas("priv")).toHaveLength(3);
  });

  it("public canvases and their assets are unaffected", async () => {
    expect(await run(stranger, "canvas look gn-image")).toContain("A red square.");
    expect(await run(stranger, "canvas info public-board")).toContain("public-board");
    expect(await run(stranger, "canvas asset info ga")).toContain("public.png");
    expect(readableNode(fixture.engine, "gn-image", {}, "test")?.id).toBe("gn-image");
    const [url, r] = get("/api/canvases/pub/nodes/gn-image");
    expect(
      (
        await handleCanvasApi(
          url,
          "GET",
          r,
          fixture.db,
          undefined,
          undefined,
          fixture.engine,
          undefined,
          REMOTE,
        )
      ).status,
    ).toBe(200);
  });

  function get(path: string, token?: string): [URL, Request] {
    const url = new URL(`http://localhost:3300${path}`);
    return [
      url,
      new Request(url.toString(), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }),
    ];
  }

  async function httpNode(nodeId: string, token?: string): Promise<number> {
    const [url, r] = get(`/api/canvases/priv/nodes/${nodeId}`, token);
    const resp = await handleCanvasApi(
      url,
      "GET",
      r,
      fixture.db,
      undefined,
      undefined,
      fixture.engine,
      undefined,
      REMOTE,
    );
    return resp.status;
  }

  it("the canvas and asset HTTP APIs apply the same rule", async () => {
    expect(await httpNode("pn-image", owner.token)).toBe(200);
    expect(await httpNode("pn-image", admin.token)).toBe(200);
    expect(await httpNode("pn-image", stranger.token)).toBe(404);
    expect(await httpNode("pn-image")).toBe(404);

    const asset = async (path: string, token?: string) => {
      const [url, r] = get(path, token);
      return handleAssetApi(
        url,
        "GET",
        r,
        fixture.db,
        fixture.engine.storage!,
        fixture.engine,
        REMOTE,
      );
    };
    expect((await asset("/api/assets/pa", owner.token)).status).toBe(200);
    expect((await asset("/api/assets/pa", stranger.token)).status).toBe(404);
    expect((await asset("/api/assets/ga", stranger.token)).status).toBe(200);
    const list = (await (await asset("/api/assets", stranger.token)).json()) as { id: string }[];
    expect(list.map((a) => a.id)).toEqual(["ga"]);
    const ownList = (await (await asset("/api/assets", owner.token)).json()) as { id: string }[];
    expect(ownList.map((a) => a.id).sort()).toEqual(["ga", "pa"]);

    // Attaching a private asset to a node on a public canvas reads it.
    const url = new URL("http://localhost:3300/api/canvases/pub/nodes");
    const post = new Request(url.toString(), {
      method: "POST",
      headers: { Authorization: `Bearer ${stranger.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "image", asset_id: "pa" }),
    });
    const posted = await handleCanvasApi(
      url,
      "POST",
      post,
      fixture.db,
      undefined,
      undefined,
      fixture.engine,
      undefined,
      REMOTE,
    );
    expect(posted.status).toBe(404);
  });

  it("journeys never resolve a private node", () => {
    expect(resolveJourneyRecord(fixture.db, "canvas_node", "pn-text")).toBeUndefined();
    expect(resolveJourneyRecord(fixture.db, "canvas_node", "gn-image")?.ref).toBe("gn-image");
  });

  it("a crew member reads under a grant, then is refused once it expires", async () => {
    expect(await run(crew, "canvas look pn-image")).toContain("not found");
    const expiresAt = fixture.engine.canvasGrants.grant({
      nodeIds: ["pn-image"],
      principals: [crew.id],
      ttlMs: 60_000,
      reason: "test request",
    });
    expect(await run(crew, "canvas look pn-image what")).toContain("A red square.");
    expect(await httpNode("pn-image", crew.token)).toBe(200);
    // The grant covers that node only, and reading only.
    expect(await run(crew, "canvas look pn-text")).toContain("not found");
    expect(await run(crew, "canvas nodes private-board")).toContain("not found");
    expect(mayReadAsset(fixture.engine, fixture.db.getAsset("pa")!, reader(crew.id), "test")).toBe(
      true,
    );

    setSystemTime(new Date(expiresAt + 1));
    expect(await run(crew, "canvas look pn-image what")).toContain("not found");
    expect(await httpNode("pn-image", crew.token)).toBe(404);
    expect(fixture.engine.canvasGrants.list()).toEqual([]);
  });

  describe("model-API request images", () => {
    let requests: string[];

    beforeEach(async () => {
      process.env.MODEL_API_KEYS = "sk-test-access";
      requests = [];
      await fixture.engine.processCommand(crew.id, "channel join model");
      const cm = fixture.engine.channelManager!;
      cm.onMessage((channelId, senderId, _name, content) => {
        if (senderId !== "__model_api__") return;
        const parsed = JSON.parse(content) as { type?: string; id?: string; content?: string };
        if (parsed.type !== "model_request" || (parsed as { reminder?: boolean }).reminder) return;
        requests.push(String(parsed.content));
        cm.send(
          channelId,
          crew.id,
          "Crewmate",
          JSON.stringify({ type: "model_response", id: parsed.id, content: "seen" }),
        );
      });
    });

    it("grants the serving channel's members, for the request lifetime plus a margin", () => {
      const grant = requestImageGrant(fixture.engine, "marina");
      expect(grant?.principals).toContain(crew.id);
      expect(grant?.principals).not.toContain(stranger.id);
      expect(grant!.ttlMs).toBeGreaterThan(REQUEST_IMAGE_GRANT_MARGIN_MS);
    });

    it("the crew reads the staged image; a stranger with the node id cannot", async () => {
      const url = new URL("http://localhost:3300/v1/chat/completions");
      const req = new Request(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sk-test-access" },
        body: JSON.stringify({
          model: "marina",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "what is it?" },
                { type: "image_url", image_url: { url: PNG_URL } },
              ],
            },
          ],
        }),
      });
      const resp = await handleModelApi(url, "POST", req, fixture.engine);
      expect(resp?.status).toBe(200);
      const nodeId = /canvas node ([0-9a-f-]+)/.exec(requests[0] ?? "")?.[1];
      expect(nodeId).toBeTruthy();
      expect(fixture.engine.canvasGrants.list(nodeId!).map((g) => g.principal)).toEqual([crew.id]);
      expect(await run(crew, `canvas look ${nodeId} what`)).toContain("A red square.");
      expect(await run(stranger, `canvas look ${nodeId} what`)).toContain("not found");
      const assetId = fixture.db.getNode(nodeId!)!.asset_id!;
      const key = fixture.db.getAsset(assetId)!.storage_key;
      // The image's bytes follow the same rule: the crew's token reads them,
      // a stranger's does not, and an unidentified caller never does.
      const bytes = async (token?: string) => {
        const [u, r] = get(`/assets/${key}`, token);
        return (
          await handleAssetServing(u, fixture.engine.storage!, fixture.db, {
            engine: fixture.engine,
            req: r,
            peerIp: REMOTE,
          })
        ).status;
      };
      expect(await bytes(crew.token)).toBe(200);
      expect(await bytes(stranger.token)).toBe(404);
      expect(await bytes()).toBe(404);
      const [u] = get(`/assets/${key}`);
      expect((await handleAssetServing(u, fixture.engine.storage!, fixture.db)).status).toBe(404);
    });
  });
});
