// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Panel safety: only a person acts through a panel, a panel an agent writes
// carries no operations, and a reader draws a newer Marina's component as an
// inert placeholder instead of refusing the whole panel.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { commandManifest } from "../src/engine/command-manifest";
import { DESKTOP_OPERATOR_ENTITY_ID, OPEN_API_ENTITY_ID } from "../src/net/auth-middleware";
import { handleCanvasApi } from "../src/net/canvas/canvas-api";
import { httpPanelActorKind } from "../src/net/canvas/panel-actor";
import { validatePanelDocument } from "../src/sdk/panel-document";
import { resolvePanelBindings } from "../src/sdk/panel-resources";
import { panelText } from "../src/sdk/panel-text";
import type { StorageProvider } from "../src/storage/provider";
import type { EntityId } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { MockConnection } from "./helpers";
import { scopeProcessState } from "./process-state";

const notify = {
  components: [
    { id: "root", component: "Column", children: ["field", "ping"] },
    { id: "field", component: "TextField", label: "Comment" },
    { id: "ping", component: "Button", label: "Ping", action: { event: { name: "ping" } } },
  ],
};

describe("panel authority", () => {
  let fixture: ReturnType<typeof createTestEngine>;
  let state: DisposableStack;
  let person: { token: string; entityId: EntityId };
  let agent: { token: string; entityId: EntityId; connection: MockConnection };
  let calls: number;
  let syntax: string;
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
  const login = (name: string, asAgent: boolean) => {
    const connection = new MockConnection(`conn-${name}`) as MockConnection & { agent?: boolean };
    if (asAgent) connection.agent = true;
    fixture.engine.addConnection(connection);
    const result = fixture.engine.login(connection.id, name);
    if ("error" in result) throw new Error(result.error);
    return { token: result.token, entityId: result.entityId, connection };
  };
  beforeEach(() => {
    state = scopeProcessState({ rateLimitBypass: true, env: { MARINA_OPEN_API: undefined } });
    files.clear();
    fixture = createTestEngine({ assetStorage: storage });
    person = login("Owner", false);
    agent = login("Builder", true);
    fixture.db.createCanvas({ id: "board", name: "board", creatorName: "Owner" });
    calls = 0;
    fixture.engine.commands.registerBuiltin({
      name: "panelproof",
      help: "Panel test",
      usage: [{ syntax: "panelproof", description: "Record one invocation" }],
      handler: () => {
        calls++;
      },
    });
    syntax = commandManifest(fixture.engine.commands).find((e) => e.name === "panelproof")!
      .forms![0]!.syntax;
  });
  afterEach(async () => {
    await fixture.dispose();
    state.dispose();
  });
  const withOperation = () => ({
    components: [
      {
        id: "run",
        component: "Button",
        label: "Run",
        operation: { kind: "command", command: "panelproof", syntax },
      },
    ],
  });
  async function request(path: string, method = "GET", body?: unknown, token = person.token) {
    const url = new URL(`http://localhost/api/canvases/board${path}`);
    return handleCanvasApi(
      url,
      method,
      new Request(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      fixture.db,
      storage,
      undefined,
      fixture.engine,
    );
  }
  const publish = async (data: unknown, token = person.token) =>
    request("/nodes", "POST", { type: "a2ui", data }, token);
  const run = (node: { id: string; data: { panelRevision: string } }, token = person.token) =>
    request(
      `/nodes/${node.id}/interaction`,
      "POST",
      {
        revision: node.data.panelRevision,
        componentId: "run",
        capabilityRevision: fixture.engine.commands.revision,
      },
      token,
    );

  it("refuses an agent on every interaction path", async () => {
    const plain = await (await publish(notify)).json();
    const ops = await (await publish(withOperation())).json();
    const attempts = [
      { node: plain, body: { componentId: "ping" } },
      { node: plain, body: { componentId: "field", value: "hi" } },
      {
        node: ops,
        body: { componentId: "run", capabilityRevision: fixture.engine.commands.revision },
      },
    ];
    for (const { node, body } of attempts) {
      const response = await request(
        `/nodes/${node.id}/interaction`,
        "POST",
        { revision: node.data.panelRevision, ...body },
        agent.token,
      );
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe("person_required");
    }
    expect(calls).toBe(0);
    expect(JSON.parse(fixture.db.getNode(plain.id)!.data).lastAction).toBeUndefined();
    // The person's own click runs.
    expect((await run(ops)).status).toBe(200);
    expect(calls).toBe(1);
  });

  it("rechecks the clicker in the queue, after it waited behind other work", async () => {
    const ops = await (await publish(withOperation())).json();
    const barrier = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    fixture.engine.submitCommand(person.entityId, "barrier", async () => {
      started.resolve();
      await barrier.promise;
    });
    await started.promise;
    const pending = run(ops);
    // The credential now resolves to an agent (e.g. an MCP session on the same account).
    fixture.db.saveAgentConfig({ name: "Owner", model: "marina/default", spawnedBy: "system" });
    barrier.resolve();
    const response = await pending;
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("person_required");
    expect(calls).toBe(0);
  });

  it("refuses an agent's panel with operations at every write, and accepts one without", async () => {
    const created = await publish(withOperation(), agent.token);
    expect(created.status).toBe(403);
    expect((await created.json()).code).toBe("agent_panel");
    expect((await publish(notify, agent.token)).status).toBe(201);

    // Revising a person's panel: an agent may not keep or add operations.
    const owned = await (await publish(withOperation())).json();
    const revised = await request(
      `/nodes/${owned.id}`,
      "PATCH",
      { data: withOperation() },
      agent.token,
    );
    expect(revised.status).toBe(403);

    // A rich intent result from an agent.
    fixture.db.createNode({
      id: "intent",
      canvasId: "board",
      type: "text",
      creatorName: "Owner",
      data: {
        intent: { prompt: "Build", status: "active", claimedBy: "Builder", claimedAt: Date.now() },
      },
    });
    const completed = await request(
      "/nodes/intent/intent/complete",
      "POST",
      { result: "Done", type: "a2ui", data: withOperation() },
      agent.token,
    );
    expect(completed.status).toBe(403);
    expect(JSON.parse(fixture.db.getNode("intent")!.data).intent.status).toBe("active");

    // In-world `canvas publish` of a stored panel asset.
    const bytes = new TextEncoder().encode(JSON.stringify(withOperation()));
    await storage.put("ops.json", bytes, "application/json");
    fixture.db.createAsset({
      id: "ops",
      entityName: "Builder",
      filename: "ops.json",
      mimeType: "application/json",
      size: bytes.length,
      storageKey: "ops.json",
    });
    const before = fixture.db.getNodesByCanvas("board").length;
    await fixture.engine.dispatchCommand(agent.entityId, "canvas publish a2ui ops board");
    expect(fixture.db.getNodesByCanvas("board")).toHaveLength(before);
    expect(agent.connection.messages.map((m) => JSON.stringify(m)).join("\n")).toContain(
      "carries no `operation`",
    );
  });

  it("an agent-written panel's buttons stay inert until a person revises it", async () => {
    // Written before the publish rule: an agent account created it with an operation.
    fixture.db.saveAgentConfig({ name: "Builder", model: "marina/default", spawnedBy: "Owner" });
    fixture.db.createNode({
      id: "legacy",
      canvasId: "board",
      type: "a2ui",
      creatorName: "Builder",
      data: withOperation(),
    });
    const legacy = await (await request("/nodes/legacy")).json();
    const refused = await run(legacy);
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("agent_panel");
    expect(calls).toBe(0);
    // The person revises it; the operation is now theirs.
    const revised = await request("/nodes/legacy", "PATCH", {
      revision: legacy.data.panelRevision,
      data: withOperation(),
    });
    expect(revised.status).toBe(200);
    expect((await run(await revised.json())).status).toBe(200);
    expect(calls).toBe(1);
  });

  it("counts the desktop token as a person and a token-less caller as an agent", () => {
    expect(httpPanelActorKind(fixture.engine, DESKTOP_OPERATOR_ENTITY_ID)).toBe("person");
    expect(httpPanelActorKind(fixture.engine, OPEN_API_ENTITY_ID)).toBe("agent");
    expect(httpPanelActorKind(fixture.engine, undefined)).toBe("agent");
    expect(httpPanelActorKind(fixture.engine, person.entityId)).toBe("person");
    expect(httpPanelActorKind(fixture.engine, agent.entityId)).toBe("agent");
  });

  describe("a newer Marina's component", () => {
    const newer = {
      title: "Triage",
      components: [
        { id: "root", component: "Column", children: ["tabs", "reviewer", "assign"] },
        { id: "tabs", component: "Tabs", label: "Queues", tabs: [{ id: "a" }], children: ["note"] },
        { id: "note", component: "Text", text: "Open items" },
        { id: "reviewer", component: "Select", label: "Reviewer", options: ["ada", "lin"] },
        {
          id: "assign",
          component: "Button",
          label: "Assign",
          operation: {
            kind: "command",
            command: "panelproof",
            syntax: "panelproof",
            values: { who: { field: "reviewer" } },
          },
        },
      ],
    };

    it("reads tolerantly and keeps the component verbatim; writes refuse it", () => {
      const read = validatePanelDocument(newer);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.document.components.find((c) => c.id === "reviewer")).toEqual(
        newer.components[3]!,
      );
      const write = validatePanelDocument(newer, { unknownComponents: "refuse" });
      expect(write.ok).toBe(false);
      if (!write.ok) expect(write.error).toContain("Supported: Text");
      // A malformed type name is never tolerated.
      expect(validatePanelDocument({ components: [{ id: "x", component: "<script>" }] }).ok).toBe(
        false,
      );
    });

    it("prints a placeholder and still prints the known children", () => {
      const text = panelText(newer);
      expect(text).toContain("[Tabs · Queues · needs a newer Marina]");
      expect(text).toContain("Open items");
      expect(text).toContain("[Select · Reviewer · needs a newer Marina]");
      expect(text).toContain("[assign] Assign");
    });

    it("binds only the safe properties onto it", () => {
      const read = validatePanelDocument({
        dataModel: { evil: { kind: "command", command: "panelproof", syntax: "panelproof" } },
        components: [
          {
            id: "x",
            component: "Gauge",
            bindings: {
              operation: { source: "dataModel", path: ["evil"] },
              text: { source: "dataModel", path: ["evil", "command"] },
            },
          },
        ],
      });
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      const resolved = resolvePanelBindings(read.document, {}).components[0]!;
      expect(resolved.operation).toBeUndefined();
      expect(resolved.text).toBe("panelproof");
    });

    it("is never actionable, and an action reading it names why", async () => {
      // Stored by a newer Marina, then read here after a rollback.
      fixture.db.createNode({
        id: "newer",
        canvasId: "board",
        type: "a2ui",
        creatorName: "Owner",
        data: newer,
      });
      const node = await (await request("/nodes/newer")).json();
      const select = await request("/nodes/newer/interaction", "POST", {
        revision: node.data.panelRevision,
        componentId: "reviewer",
        value: "ada",
      });
      expect(select.status).toBe(400);
      const assign = await request("/nodes/newer/interaction", "POST", {
        revision: node.data.panelRevision,
        componentId: "assign",
        fields: {},
        capabilityRevision: fixture.engine.commands.revision,
      });
      expect(assign.status).toBe(409);
      expect((await assign.json()).code).toBe("component_unavailable");
      expect(calls).toBe(0);
    });

    it("survives a field-change save on the same panel without losing data", async () => {
      fixture.db.createNode({
        id: "mixed",
        canvasId: "board",
        type: "a2ui",
        creatorName: "Owner",
        data: {
          components: [...notify.components, { id: "s", component: "Select", options: [1] }],
        },
      });
      const node = await (await request("/nodes/mixed")).json();
      const saved = await request("/nodes/mixed/interaction", "POST", {
        revision: node.data.panelRevision,
        componentId: "field",
        value: "kept",
      });
      expect(saved.status).toBe(200);
      const stored = JSON.parse(fixture.db.getNode("mixed")!.data);
      expect(stored.components.find((c: { id: string }) => c.id === "s")).toEqual({
        id: "s",
        component: "Select",
        options: [1],
      });
    });
  });
});
