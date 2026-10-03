// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { commandManifest } from "../src/engine/command-manifest";
import { handleCanvasApi } from "../src/net/canvas-api";
import { RoutingService } from "../src/routing/service";
import { compileCommandForms } from "../src/sdk/command-forms";
import type { StorageProvider } from "../src/storage/provider";
import type { EntityId } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { MockConnection } from "./helpers";
import { scopeProcessState } from "./process-state";

const document = {
  title: "Build status",
  components: [
    { id: "root", component: "Column", children: ["label", "field", "button"] },
    { id: "label", component: "Text", text: "Ready for review" },
    { id: "field", component: "TextField", label: "Comment" },
    { id: "button", component: "Button", label: "Refresh", action: { event: { name: "refresh" } } },
  ],
};
describe("Canvas panel publication and interaction", () => {
  let fixture: ReturnType<typeof createTestEngine>;
  let state: DisposableStack;
  let token: string;
  let entity: EntityId;
  const files = new Map<string, Uint8Array>();
  const storage: StorageProvider = {
    async init() {},
    async put(key, data) {
      files.set(key, data);
      return key;
    },
    async get(key) {
      const data = files.get(key);
      return data ? { data, mime: "application/json" } : null;
    },
    async delete(key) {
      return files.delete(key);
    },
    resolve: (key) => `/assets/${key}`,
  };
  beforeEach(() => {
    state = scopeProcessState({ rateLimitBypass: true, env: { MARINA_OPEN_API: undefined } });
    files.clear();
    fixture = createTestEngine({ assetStorage: storage });
    const connection = new MockConnection("publisher");
    fixture.engine.addConnection(connection);
    const result = fixture.engine.login(connection.id, "PanelAuthor");
    if ("error" in result) throw new Error(result.error);
    token = result.token;
    entity = result.entityId;
    fixture.db.createCanvas({ id: "board", name: "board", creatorName: "PanelAuthor" });
  });
  afterEach(async () => {
    await fixture.dispose();
    state.dispose();
  });
  async function request(path: string, method = "GET", body?: unknown, credential = token) {
    const url = new URL(`http://localhost/api/canvases/board${path}`);
    return handleCanvasApi(
      url,
      method,
      new Request(url, {
        method,
        headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      fixture.db,
      storage,
      undefined,
      fixture.engine,
    );
  }
  async function asset() {
    const bytes = new TextEncoder().encode(JSON.stringify(document));
    await storage.put("panel.json", bytes, "application/json");
    fixture.db.createAsset({
      id: "asset",
      entityName: "PanelAuthor",
      filename: "panel.json",
      mimeType: "application/json",
      size: bytes.length,
      storageKey: "panel.json",
    });
  }
  it("publishes stored assets through commands and inline data through HTTP equivalently", async () => {
    await asset();
    await fixture.engine.dispatchCommand(entity, "canvas publish a2ui asset board");
    const node = fixture.db.getNodesByCanvas("board")[0]!;
    expect(JSON.parse(node.data).components).toEqual(document.components);
    const response = await request("/nodes", "POST", { type: "a2ui", data: document });
    expect(response.status).toBe(201);
    expect((await response.json()).data.components).toEqual(document.components);
  });
  it("resolves legacy asset nodes on an authorized single-node read without rewriting storage", async () => {
    await asset();
    fixture.db.createNode({
      id: "legacy",
      canvasId: "board",
      type: "a2ui",
      assetId: "asset",
      data: {},
      creatorName: "PanelAuthor",
    });
    expect((await (await request("/nodes/legacy")).json()).data.components).toEqual(
      document.components,
    );
    expect(fixture.db.getNode("legacy")!.data).toBe("{}");
  });
  it("rejects malformed content at create, update and rich intent completion", async () => {
    const bad = { components: [{ id: "cycle", component: "Card", child: "cycle" }] };
    expect((await request("/nodes", "POST", { type: "a2ui", data: bad })).status).toBe(400);
    const node = await (await request("/nodes", "POST", { type: "a2ui", data: document })).json();
    expect((await request(`/nodes/${node.id}`, "PATCH", { data: bad })).status).toBe(400);
    fixture.db.createNode({
      id: "intent",
      canvasId: "board",
      type: "text",
      creatorName: "PanelAuthor",
      data: {
        intent: {
          prompt: "Build panel",
          status: "active",
          claimedBy: "PanelAuthor",
          claimedAt: Date.now(),
        },
      },
    });
    expect(
      (
        await request("/nodes/intent/intent/complete", "POST", {
          result: "Done",
          type: "a2ui",
          data: bad,
        })
      ).status,
    ).toBe(400);
    expect(JSON.parse(fixture.db.getNode("intent")!.data).intent.status).toBe("active");
  });
  it("binds interactions to the current definition and ignores client-supplied event names", async () => {
    const node = await (await request("/nodes", "POST", { type: "a2ui", data: document })).json();
    const input = {
      revision: node.data.panelRevision,
      componentId: "button",
      event: { name: "execute" },
    };
    expect((await request(`/nodes/${node.id}/interaction`, "POST", input)).status).toBe(200);
    expect(JSON.parse(fixture.db.getNode(node.id)!.data).lastAction.name).toBe("refresh");
    expect(
      (await request(`/nodes/${node.id}/interaction`, "POST", { ...input, componentId: "label" }))
        .status,
    ).toBe(400);
    await request(`/nodes/${node.id}`, "PATCH", { data: { ...document, title: "Changed" } });
    expect((await request(`/nodes/${node.id}/interaction`, "POST", input)).status).toBe(409);
    expect(JSON.parse(fixture.db.getNode(node.id)!.data).title).toBe("Changed");
    expect(
      (await request(`/nodes/${node.id}/interaction`, "POST", input, "bad-token")).status,
    ).toBe(401);
  });
  it("deduplicates messages and refuses to borrow another resident's sending session", async () => {
    const router = new RoutingService(fixture.db, fixture.db.durableEntityKey(entity));
    const sender = router.join({ clientKey: "panel-sender", label: "Sender", kind: "service" });
    const target = router.join({ clientKey: "panel-target", label: "Target", kind: "service" });
    const data = {
      components: [
        { id: "root", component: "Column", children: ["draft", "send"] },
        { id: "draft", component: "TextField", label: "Message" },
        {
          id: "send",
          component: "Button",
          label: "Send",
          operation: { kind: "message", targetId: target.id, message: { field: "draft" } },
        },
      ],
    };
    const node = await (await request("/nodes", "POST", { type: "a2ui", data })).json();
    const body = {
      revision: node.data.panelRevision,
      componentId: "send",
      fields: { draft: "Hello" },
      sourceId: sender.id,
      requestId: "same-message-id",
    };
    const first = await (await request(`/nodes/${node.id}/interaction`, "POST", body)).json();
    const second = await (await request(`/nodes/${node.id}/interaction`, "POST", body)).json();
    expect(first.status).toBe("queued");
    expect(first.receipt.id).toBe(second.receipt.id);
    expect(router.inbox(target.id)).toHaveLength(1);
    expect(router.inbox(target.id)[0]!.payload).toEqual({ text: "Hello" });
    fixture.db.createUser({ id: "other", name: "Other" });
    const other = new RoutingService(fixture.db, "other").join({
      clientKey: "private",
      label: "Private",
      kind: "service",
    });
    expect(
      (await request(`/nodes/${node.id}/interaction`, "POST", { ...body, sourceId: other.id }))
        .status,
    ).toBe(404);
    expect(
      (
        await request(`/nodes/${node.id}/interaction`, "POST", {
          ...body,
          fields: { draft: "Changed" },
        })
      ).status,
    ).toBe(409);
  });
  it("rechecks command definitions in the FIFO and refuses stale revisions", async () => {
    let calls = 0;
    fixture.engine.commands.registerBuiltin({
      name: "panelproof",
      help: "Panel test",
      usage: [{ syntax: "panelproof", description: "Record one invocation" }],
      handler: () => {
        calls++;
      },
    });
    const form = commandManifest(fixture.engine.commands).find(
      (entry) => entry.name === "panelproof",
    )!.forms![0]!;
    const data = {
      components: [
        {
          id: "run",
          component: "Button",
          operation: { kind: "command", command: "panelproof", syntax: form.syntax },
        },
      ],
    };
    const node = await (await request("/nodes", "POST", { type: "a2ui", data })).json();
    const body = {
      revision: node.data.panelRevision,
      componentId: "run",
      capabilityRevision: fixture.engine.commands.revision,
    };
    expect(
      (await request(`/nodes/${node.id}/interaction`, "POST", { ...body, capabilityRevision: -1 }))
        .status,
    ).toBe(409);
    expect(calls).toBe(0);
    expect((await request(`/nodes/${node.id}/interaction`, "POST", body)).status).toBe(200);
    expect(calls).toBe(1);
    const barrier = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    fixture.engine.submitCommand(entity, "barrier", async () => {
      started.resolve();
      await barrier.promise;
    });
    await started.promise;
    const pending = request(`/nodes/${node.id}/interaction`, "POST", body);
    await request(`/nodes/${node.id}`, "PATCH", {
      revision: body.revision,
      data: { ...data, title: "Changed destination review" },
    });
    barrier.resolve();
    expect((await pending).status).toBe(409);
    expect(calls).toBe(1);
    expect(
      (await request(`/nodes/${node.id}`, "PATCH", { revision: body.revision, data })).status,
    ).toBe(409);
  });
  it("a coding panel targets its own session without changing Chat selection or borrowing ownership", async () => {
    for (const id of ["selected", "desk", "foreign"])
      fixture.db.createCodingSession({
        id,
        title: id,
        workspaceRoot: `/tmp/${id}`,
        createdBy: id === "foreign" ? "Other" : "PanelAuthor",
      });
    const resident = fixture.engine.entities.get(entity)!;
    resident.properties.coding_session_id = "selected";
    const form = compileCommandForms(["code observe <note>"])[0]!;
    const publish = async (sessionId: string) =>
      (
        await request("/nodes", "POST", {
          type: "a2ui",
          data: {
            components: [
              {
                id: "observe",
                component: "Button",
                operation: {
                  kind: "command",
                  command: "code",
                  syntax: form.syntax,
                  codingTarget: { sessionId },
                  values: { [form.fields[0]!.id]: "Only this desk" },
                },
              },
            ],
          },
        })
      ).json();
    const node = await publish("desk");
    const run = (node: { id: string; data: { panelRevision: string } }) =>
      request(`/nodes/${node.id}/interaction`, "POST", {
        componentId: "observe",
        revision: node.data.panelRevision,
        capabilityRevision: fixture.engine.commands.revision,
      });
    expect((await run(node)).status).toBe(200);
    expect(fixture.db.listCodingArtifacts("desk")[0]?.content_text).toBe("Only this desk");
    expect(fixture.db.listCodingArtifacts("selected")).toHaveLength(0);
    await run(await publish("foreign"));
    expect(fixture.db.listCodingArtifacts("foreign")).toHaveLength(0);
    expect(resident.properties.coding_session_id).toBe("selected");
  });
  it("runtime controls require the clicking resident's existing execution gate", async () => {
    const router = new RoutingService(fixture.db, fixture.db.durableEntityKey(entity));
    const target = router.join({ clientKey: "controlled", label: "Controlled", kind: "service" });
    const node = await (
      await request("/nodes", "POST", {
        type: "a2ui",
        data: {
          components: [
            {
              id: "stop",
              component: "Button",
              label: "Stop",
              operation: { kind: "control", targetId: target.id, control: "stop" },
            },
          ],
        },
      })
    ).json();
    using _guarded = scopeProcessState({
      trustProfile: "public",
      env: { MARINA_AUTONOMY: "earned" },
    });
    const response = await request(`/nodes/${node.id}/interaction`, "POST", {
      revision: node.data.panelRevision,
      componentId: "stop",
      requestId: "control-attempt",
    });
    expect(response.status).toBe(403);
    expect(router.inbox(target.id)).toHaveLength(0);
  });
});
