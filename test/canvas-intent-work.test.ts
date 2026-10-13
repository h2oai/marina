// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { listWorkItems, nextWorkItem } from "../src/coordination/work-loop";
import { handleCanvasApi } from "../src/net/canvas/canvas-api";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { parseCanvasIntent } from "../src/persistence/db-canvas";
import { createTestEngine } from "./engine-fixture";
import { MockConnection, stripAnsi } from "./helpers";
import { scopeProcessState } from "./process-state";

let fixture: ReturnType<typeof createTestEngine>;
beforeEach(() => {
  fixture = createTestEngine();
});
afterEach(async () => {
  await fixture.dispose();
});

function login(name: string) {
  const connection = new MockConnection(crypto.randomUUID());
  fixture.engine.addConnection(connection);
  const result = fixture.engine.login(connection.id, name);
  if ("error" in result) throw new Error(result.error);
  return { ...result, connection };
}
function seed(id = "request") {
  if (!fixture.db.getCanvas("requests"))
    fixture.db.createCanvas({ id: "requests", name: "requests", creatorName: "Requester" });
  fixture.db.createNode({
    id,
    canvasId: "requests",
    type: "text",
    creatorName: "Requester",
    data: { intent: { status: "pending", prompt: "Review the release plan" } },
  });
}
function intent(id = "request") {
  return parseCanvasIntent(fixture.db.getNode(id)!.data)!;
}
async function api(token: string, action: string, body: object = {}) {
  const url = new URL(`http://localhost/api/canvases/requests/nodes/request/intent/${action}`);
  return handleCanvasApi(
    url,
    "POST",
    new Request(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    fixture.db,
    undefined,
    undefined,
    fixture.engine,
  );
}

it.each(["command", "dashboard"])(
  "%s completion records one result, one notification, and one memory across retries",
  async (surface) => {
    using _state = scopeProcessState({ env: { MARINA_OPEN_API: undefined } });
    const requester = login("Requester");
    const worker = login("Worker");
    seed();
    await fixture.engine.dispatchCommand(worker.entityId, "canvas intent claim request");
    const events = spyOn(fixture.engine, "logEvent");
    const complete = async () => {
      if (surface === "command")
        await fixture.engine.dispatchCommand(
          worker.entityId,
          "canvas intent complete request Reviewed release plan",
        );
      else return api(worker.token, "complete", { result: "Reviewed release plan" });
    };
    requester.connection.clear();
    const first = await complete();
    if (first) expect(first.status).toBe(200);
    expect(stripAnsi(requester.connection.lastText())).toContain(
      "Worker completed your canvas intent",
    );
    const retry = await complete();
    if (retry) expect(retry.status).toBe(409);
    expect(intent().history?.map((entry) => entry.status)).toEqual(["active", "done"]);
    expect(intent().history?.at(-1)?.actor).toBe("Worker");
    expect(fixture.db.getChildNodes("request")).toHaveLength(1);
    expect(
      fixture.db
        .getNotesByEntity("Worker", 100)
        .filter((note) => note.content.includes("[intent-done]")),
    ).toHaveLength(1);
    expect(events.mock.calls.filter(([event]) => event.type === "canvas_intent")).toHaveLength(1);
    events.mockRestore();
  },
);

it("records stale-claim takeover and API failure without inventing history on reads", async () => {
  const worker = login("Worker");
  seed();
  fixture.db.claimCanvasIntent("request", "First", Date.now() - 600_000);
  const before = fixture.db.getNode("request")!.data;
  const suggestions = listWorkItems(fixture.engine.entities.get(worker.entityId)!, {
    db: fixture.db,
  });
  expect(suggestions.find((item) => item.kind === "canvas_intent")?.command).toBe(
    "canvas intent claim request",
  );
  expect(fixture.db.getNode("request")!.data).toBe(before);
  expect((await api(worker.token, "claim")).status).toBe(200);
  expect(intent().history?.at(-1)).toMatchObject({
    status: "active",
    actor: "Worker",
    previousClaimant: "First",
  });
  expect((await api(worker.token, "fail", { reason: "Source unavailable" })).status).toBe(200);
  expect(intent().history?.at(-1)).toMatchObject({
    status: "failed",
    actor: "Worker",
    reason: "Source unavailable",
  });
  await fixture.engine.dispatchCommand(worker.entityId, "canvas intent fail request again");
  expect(intent().history).toHaveLength(3);
});

it("keeps a claimed request and its recent delivery in the requester's shared work inbox", async () => {
  const requester = login("Requester");
  const worker = login("Worker");
  seed();
  const items = () =>
    listWorkItems(fixture.engine.entities.get(requester.entityId)!, { db: fixture.db });
  expect(items().find((item) => item.kind === "canvas_intent")).toMatchObject({
    status: "pending",
    target: { kind: "canvas", canvasId: "requests", nodeId: "request" },
  });
  await fixture.engine.dispatchCommand(worker.entityId, "canvas intent claim request");
  expect(items().find((item) => item.kind === "canvas_intent")).toMatchObject({
    status: "active",
    owner: "Worker",
  });
  await fixture.engine.dispatchCommand(worker.entityId, "canvas intent complete request Finished");
  expect(items().find((item) => item.kind === "canvas_intent")).toMatchObject({
    status: "done",
    owner: "Worker",
  });
});

it("filters private requests before the inbox limit and uses the HTTP viewer's authority", async () => {
  const owner = login("Owner");
  const stranger = login("Stranger");
  fixture.db.createCanvas({
    id: "private",
    name: "private",
    scope: "entity",
    scopeId: owner.entityId,
    creatorName: "Owner",
  });
  for (let index = 0; index < 110; index++)
    fixture.db.createNode({
      id: `secret-${index}`,
      canvasId: "private",
      type: "text",
      creatorName: "Owner",
      data: { intent: { status: "pending", prompt: "Private request" } },
    });
  seed();
  const url = new URL("http://localhost/api/entities/Owner/work");
  const response = await handleDashboardApi(
    new Request(url, { headers: { Authorization: `Bearer ${stranger.token}` } }),
    url,
    "GET",
    fixture.engine,
    fixture.db,
  );
  expect(response?.status).toBe(200);
  const body = await response!.json();
  expect(JSON.stringify(body)).not.toContain("Private request");
  expect(body.items.some((item: { ref: string }) => item.ref === "canvas_intent:request")).toBe(
    true,
  );
});

it("keeps other workers' commitments and finished requests out of next-work guidance", async () => {
  const worker = login("Worker");
  const other = login("Other");
  seed();
  const entity = fixture.engine.entities.get(worker.entityId)!;
  await fixture.engine.dispatchCommand(worker.entityId, "memory set goal Review release requests");
  await fixture.engine.dispatchCommand(other.entityId, "canvas intent claim request");
  expect(
    listWorkItems(entity, { db: fixture.db }).some((item) => item.ref === "canvas_intent:request"),
  ).toBe(false);
  seed("my-request");
  await fixture.engine.dispatchCommand(worker.entityId, "canvas intent claim my-request");
  expect(nextWorkItem(entity, { db: fixture.db }).ref).toBe("canvas_intent:my-request");
  await fixture.engine.dispatchCommand(
    worker.entityId,
    "canvas intent complete my-request Reviewed",
  );
  expect(
    listWorkItems(entity, { db: fixture.db }).some(
      (item) => item.ref === "canvas_intent:my-request",
    ),
  ).toBe(true);
  expect(nextWorkItem(entity, { db: fixture.db }).ref).not.toBe("canvas_intent:my-request");
});
