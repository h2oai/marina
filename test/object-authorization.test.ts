// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Object-level authorization: canvases, assets, task progress, media retry,
 * project orchestration and note verification. On a shared instance the
 * owner (or an admin) acts and a refusal raises a challenge; on a
 * local-ungated instance anyone may act. Self-attestation is refused in every
 * posture.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { resetChallengesForTests } from "../src/engine/challenges";
import { resetGateContextForTests } from "../src/engine/gate-context";
import { handleAssetApi } from "../src/net/asset-api";
import type { DashboardRouteContext } from "../src/net/dashboard-api/shared";
import { handleCoordinationRoutes, handleWorldCatalogRoutes } from "../src/net/dashboard-api/world";
import { resetHttpRateLimitersForTests } from "../src/net/http-utils";
import type { MediaJobRow } from "../src/persistence/database";
import { LocalStorageProvider } from "../src/storage/local-provider";
import type { EngineEvent, EntityId } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { MockConnection, stripAnsi, until } from "./helpers";
import { scopeProcessState } from "./process-state";

const tokenIn = (text: string) => text.match(/\b(ch_[0-9a-f]{12})\b/)?.[1];

type World = ReturnType<typeof createTestEngine>;

interface Resident {
  connection: MockConnection;
  entityId: EntityId;
  token: string;
  name: string;
}

function resident(world: World, name: string, rank = 0): Resident {
  const connection = new MockConnection(crypto.randomUUID());
  world.engine.addConnection(connection);
  const login = world.engine.login(connection.id, name);
  if (!("token" in login)) throw new Error(`login failed for ${name}`);
  const entityId = login.entityId as EntityId;
  world.engine.entities.get(entityId)!.properties.rank = rank;
  connection.clear();
  return { connection, entityId, token: login.token, name };
}

async function run(world: World, who: Resident, raw: string): Promise<string> {
  who.connection.clear();
  await world.engine.processCommand(who.entityId, raw);
  return stripAnsi(who.connection.allText().join("\n"));
}

function withSetup(profile: "shared" | "local") {
  let world: World;
  let alice: Resident;
  let bob: Resident;
  let root: Resident;
  let events: EngineEvent[];
  let state: DisposableStack;
  beforeEach(() => {
    state = scopeProcessState({
      trustProfile: profile,
      rateLimitBypass: true,
      env: { MARINA_AUTONOMY: undefined, MARINA_CHALLENGES: undefined, MARINA_OPEN_API: undefined },
    });
    resetChallengesForTests();
    resetGateContextForTests();
    resetHttpRateLimitersForTests();
    world = createTestEngine();
    alice = resident(world, "Alice");
    bob = resident(world, "Bob");
    root = resident(world, "Root", 9);
    events = [];
    world.engine.addEventListener((event) => events.push(event));
  });
  afterEach(async () => {
    await world.dispose();
    resetChallengesForTests();
    resetGateContextForTests();
    state.dispose();
  });
  return {
    get world() {
      return world;
    },
    get alice() {
      return alice;
    },
    get bob() {
      return bob;
    },
    get root() {
      return root;
    },
    get events() {
      return events;
    },
  };
}

describe("ownership on a shared instance", () => {
  const t = withSetup("shared");

  it("canvas delete: a non-owner is refused with a challenge an admin can approve", async () => {
    await run(t.world, t.alice, "canvas create plans");
    t.world.engine.entities.get(t.bob.entityId)!.properties.rank = 1;
    const refused = await run(t.world, t.bob, "canvas delete plans");
    expect(refused).toContain('Only the owner of canvas "plans"');
    const token = tokenIn(refused);
    expect(token).toBeDefined();
    expect(t.world.db.getCanvasByName("plans")).toBeDefined();
    expect(stripAnsi(t.root.connection.allText().join("\n"))).toContain(
      `challenge approve ${token}`,
    );

    // The admin's approval re-runs the held command once.
    await run(t.world, t.root, `challenge approve ${token}`);
    await until(() => t.world.db.getCanvasByName("plans") === undefined);

    // The owner deletes their own canvas.
    await run(t.world, t.alice, "canvas create drafts");
    t.world.engine.entities.get(t.alice.entityId)!.properties.rank = 1;
    expect(await run(t.world, t.alice, "canvas delete drafts")).toContain("deleted");
  });

  it("canvas layout and disconnect: only the owner, the edge's author, or an admin", async () => {
    await run(t.world, t.alice, "canvas create board");
    await run(t.world, t.alice, "canvas post on:board first idea");
    await run(t.world, t.alice, "canvas post on:board second idea");
    expect(await run(t.world, t.bob, "canvas layout grid board")).toContain(
      'Only the owner of canvas "board"',
    );
    expect(await run(t.world, t.alice, "canvas layout grid board")).not.toContain("Only the owner");

    const canvas = t.world.db.getCanvasByName("board")!;
    const [a, b] = t.world.db.getNodesByCanvas(canvas.id);
    await run(t.world, t.alice, `canvas connect ${a!.id} ${b!.id} supports`);
    const edge = t.world.db.getCanvasEdges(canvas.id)[0]!;
    expect(await run(t.world, t.bob, `canvas disconnect ${edge.id}`)).toContain(
      "Only the edge's author",
    );
    expect(t.world.db.getCanvasEdge(edge.id)).toBeDefined();
    expect(await run(t.world, t.root, `canvas disconnect ${edge.id}`)).toContain("Disconnected");
  });

  it("canvas asset delete: owner-only, exact id, and an agent's creator may act for it", async () => {
    const make = (id: string, owner: string) =>
      t.world.db.createAsset({
        id,
        entityName: owner,
        filename: `${id}.png`,
        mimeType: "image/png",
        size: 10,
        storageKey: `${id}.png`,
      });
    make("11111111-aaaa-4000-8000-000000000001", "Alice");
    make("11111111-aaaa-4000-8000-000000000002", "Alice");
    // A prefix never deletes — it lists the candidates instead.
    const prefix = await run(t.world, t.alice, "canvas asset delete 11111111");
    expect(prefix).toContain("needs the full id");
    expect(t.world.db.getAsset("11111111-aaaa-4000-8000-000000000001")).toBeDefined();

    const refused = await run(
      t.world,
      t.bob,
      "canvas asset delete 11111111-aaaa-4000-8000-000000000001",
    );
    expect(refused).toContain("Only the asset's owner (Alice)");
    expect(tokenIn(refused)).toBeDefined();
    expect(t.world.db.getAsset("11111111-aaaa-4000-8000-000000000001")).toBeDefined();

    expect(
      await run(t.world, t.alice, "canvas asset delete 11111111-aaaa-4000-8000-000000000001"),
    ).toContain("deleted");

    // Bob spawned the agent Scout: Bob may act on Scout's asset.
    t.world.db.saveAgentConfig({ name: "Scout", model: "x", spawnedBy: "Bob" });
    make("22222222-bbbb-4000-8000-000000000001", "Scout");
    expect(
      await run(t.world, t.bob, "canvas asset delete 22222222-bbbb-4000-8000-000000000001"),
    ).toContain("deleted");
  });

  it("task progress: creator or current claimant only; 100 never emits task_approved", async () => {
    await run(t.world, t.alice, "task create Map the grid | Explore sectors");
    const task = t.world.db.listTasks({ limit: 1 })[0]!;
    const refused = await run(t.world, t.bob, `task progress ${task.id} 50`);
    expect(refused).toContain("creator, its current claimant, or an admin");
    expect(tokenIn(refused)).toBeDefined();
    expect(t.world.db.getTask(task.id)!.progress).toBe(0);

    await run(t.world, t.bob, `task claim ${task.id}`);
    expect(await run(t.world, t.bob, `task progress ${task.id} 40`)).toContain("40");
    // A claimant's 100 stops short: closing goes through submit → approve.
    expect(await run(t.world, t.bob, `task progress ${task.id} 100`)).toContain("task submit");
    expect(t.world.db.getTask(task.id)!.progress).toBe(99);
    expect(t.world.db.getTask(task.id)!.status).not.toBe("completed");

    // The creator closes it; completion is not approval.
    expect(await run(t.world, t.alice, `task progress ${task.id} 100`)).toContain("completed");
    expect(t.world.db.getTask(task.id)!.status).toBe("completed");
    expect(t.events.some((e) => e.type === "task_approved")).toBe(false);
    // Final: no re-fire on a completed task.
    expect(await run(t.world, t.alice, `task progress ${task.id} 100`)).toContain(
      "progress is final",
    );
    expect(t.events.some((e) => e.type === "task_approved")).toBe(false);
  });

  it("task progress: an abandoned claim is released and another resident takes over", async () => {
    await run(t.world, t.alice, "task create Survey | the north wing");
    const task = t.world.db.listTasks({ limit: 1 })[0]!;
    await run(t.world, t.bob, `task claim ${task.id}`);
    const carol = resident(t.world, "Carol");
    expect(await run(t.world, carol, `task claim ${task.id}`)).toContain("Cannot claim");

    // Bob goes quiet past the lease: the tick's recovery releases the claim.
    const released = t.world.db.recoverExpiredTaskClaims(Date.now() + 60 * 60_000);
    expect(released.map((c) => c.task_id)).toContain(task.id);
    expect(await run(t.world, carol, `task claim ${task.id}`)).toContain("Claimed");
    expect(await run(t.world, carol, `task progress ${task.id} 30`)).toContain("30");
    // The former claimant no longer holds it.
    expect(await run(t.world, t.bob, `task progress ${task.id} 90`)).toContain("current claimant");
    expect(t.world.db.getTask(task.id)!.progress).toBe(30);
  });

  it("note verify: an author can't verify their own note", async () => {
    await run(t.world, t.alice, "note The bridge is sound type fact");
    const note = t.world.db.getNotesByEntity("Alice", 1)[0]!;
    expect(await run(t.world, t.alice, `note verify ${note.id} verified 0.9`)).toContain(
      "can't verify their own note",
    );
    expect(t.world.db.getNote(note.id)!.verification_status).not.toBe("verified");
    expect(await run(t.world, t.alice, `note verify ${note.id} disputed 0.2`)).toContain(
      "marked disputed",
    );
  });
});

describe("ownership on a local-ungated instance", () => {
  const t = withSetup("local");

  it("anyone may act on canvases, assets and task progress", async () => {
    await run(t.world, t.alice, "canvas create plans");
    t.world.db.createAsset({
      id: "33333333-cccc-4000-8000-000000000001",
      entityName: "Alice",
      filename: "a.png",
      mimeType: "image/png",
      size: 10,
      storageKey: "a.png",
    });
    await run(t.world, t.alice, "task create Local work | anything");
    const task = t.world.db.listTasks({ limit: 1 })[0]!;

    expect(await run(t.world, t.bob, "canvas layout grid plans")).not.toContain("Only the owner");
    expect(
      await run(t.world, t.bob, "canvas asset delete 33333333-cccc-4000-8000-000000000001"),
    ).toContain("deleted");
    expect(await run(t.world, t.bob, `task progress ${task.id} 60`)).toContain("60");
    expect(await run(t.world, t.bob, "canvas delete plans")).toContain("deleted");
  });

  it("still refuses self-attestation", async () => {
    await run(t.world, t.alice, "note The tower leans type fact");
    const note = t.world.db.getNotesByEntity("Alice", 1)[0]!;
    expect(await run(t.world, t.alice, `note verify ${note.id} verified`)).toContain(
      "can't verify their own note",
    );
  });
});

describe("HTTP owner checks (shared instance)", () => {
  const t = withSetup("shared");
  const ASSET_DIR = `/tmp/marina-object-auth-${process.pid}`;

  afterEach(() => rmSync(ASSET_DIR, { recursive: true, force: true }));

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const ctx = (who: Resident, path: string, init: RequestInit): DashboardRouteContext => {
    const url = new URL(`http://localhost:3300${path}`);
    return {
      req: new Request(url, init),
      url,
      method: init.method ?? "GET",
      engine: t.world.engine,
      db: t.world.db,
      peerIp: "127.0.0.1",
      callerId: who.entityId,
      memory: {} as DashboardRouteContext["memory"],
    };
  };

  it("DELETE /api/assets/:id: the uploader or an admin", async () => {
    const storage = new LocalStorageProvider(ASSET_DIR);
    await storage.init();
    t.world.db.createAsset({
      id: "asset-http-1",
      entityName: "Alice",
      filename: "a.png",
      mimeType: "image/png",
      size: 10,
      storageKey: "a.png",
    });
    const del = (who: Resident) =>
      handleAssetApi(
        new URL("http://localhost:3300/api/assets/asset-http-1"),
        "DELETE",
        new Request("http://localhost:3300/api/assets/asset-http-1", {
          method: "DELETE",
          headers: bearer(who.token),
        }),
        t.world.db,
        storage,
        t.world.engine,
      );
    expect((await del(t.bob)).status).toBe(403);
    expect(t.world.db.getAsset("asset-http-1")).toBeDefined();
    expect((await del(t.alice)).status).toBe(200);
    expect(t.world.db.getAsset("asset-http-1")).toBeUndefined();
  });

  it("POST /api/media-jobs/:id/retry: the job's owner or an admin", async () => {
    const started: string[] = [];
    const now = Date.now();
    const job: MediaJobRow = {
      id: "job-retry-1",
      type: "image",
      status: "failed",
      entity_name: "Alice",
      entity_id: t.alice.entityId,
      provider: "openai",
      model: "openai/gpt-image-1",
      prompt: "a lighthouse",
      options: "{}",
      error: "timeout",
      asset_id: null,
      cost_estimate: null,
      provider_job_id: null,
      metadata: null,
      created_at: now,
      updated_at: now,
      completed_at: now,
    };
    t.world.db.createMediaJob({
      id: job.id,
      type: "image",
      entityName: "Alice",
      entityId: t.alice.entityId,
      provider: "openai",
      model: job.model,
      prompt: job.prompt,
      options: {},
    });
    (t.world.engine as unknown as { mediaManager: unknown }).mediaManager = {
      startJob: async (params: { entityName: string }) => {
        started.push(params.entityName);
        return { ...job, status: "succeeded" };
      },
      stop: () => {},
    };
    const retry = (who: Resident) =>
      handleCoordinationRoutes(
        ctx(who, "/api/media-jobs/job-retry-1/retry", {
          method: "POST",
          headers: bearer(who.token),
        }),
      );
    expect((await retry(t.bob))!.status).toBe(403);
    expect(started).toEqual([]);
    expect((await retry(t.alice))!.status).toBe(200);
    expect((await retry(t.root))!.status).toBe(200);
    expect(started).toEqual(["Alice", "Alice"]);
  });

  it("POST /api/coordination/projects/:id/orchestration: creator or admin; malformed JSON is a 400 with a code", async () => {
    t.world.db.createProject({ id: "proj-1", name: "Beacon", createdBy: "Alice" });
    const post = (who: Resident, body: string) =>
      handleWorldCatalogRoutes(
        ctx(who, "/api/coordination/projects/proj-1/orchestration", {
          method: "POST",
          headers: { ...bearer(who.token), "Content-Type": "application/json" },
          body,
        }),
      );
    const malformed = (await post(t.alice, "{not json"))!;
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as { code: unknown }).code).toBeString();

    const body = JSON.stringify({ orchestration: "chorus" });
    expect((await post(t.bob, body))!.status).toBe(403);
    expect(t.world.db.getProject("proj-1")!.orchestration).not.toBe("chorus");
    expect((await post(t.alice, body))!.status).toBe(200);
    expect(t.world.db.getProject("proj-1")!.orchestration).toBe("chorus");
  });
});
