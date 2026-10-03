// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "bun:test";
import type { TerminalPanelState } from "../scripts/code-panel-form";
import { CodePanels } from "../scripts/code-panels";
import { DashboardBroadcaster } from "../src/net/dashboard-ws";
import { WebSocketServer } from "../src/net/websocket-server";
import { MarinaClient } from "../src/sdk/client";
import { codingDesk } from "../src/sdk/coding-desk";
import { MarinaPanelClient } from "../src/sdk/panel-client";
import { createTestEngine } from "./engine-fixture";
import { until } from "./helpers";
import { scopeProcessState } from "./process-state";

it("terminal desk rereads live changes, pauses while hidden, recovers on return and closes only its view", async () => {
  using _state = scopeProcessState({
    trustProfile: "shared",
    rateLimitBypass: true,
    env: { WS_HOST: "127.0.0.1" },
  });
  await using cleanup = new AsyncDisposableStack();
  const f = createTestEngine();
  cleanup.defer(() => f.dispose());
  const server = new WebSocketServer(f.engine, 0);
  server.setDb(f.db);
  const broadcaster = new DashboardBroadcaster();
  server.setBroadcaster(broadcaster);
  f.engine.addEventListener((e) => broadcaster.broadcastEvent(e));
  server.start();
  cleanup.defer(() => server.stop());
  const resident = new MarinaClient(`ws://127.0.0.1:${server.getPort()}`, {
    autoReconnect: false,
    pingInterval: 0,
  });
  cleanup.defer(() => resident.disconnect());
  await resident.connect("DeskOwner");
  f.db.createCodingSession({
    id: "coding",
    title: "Live coding",
    workspaceRoot: "/tmp",
    createdBy: "DeskOwner",
  });
  const client = new MarinaPanelClient({
    url: `http://127.0.0.1:${server.getPort()}`,
    token: resident.getSession()!.token,
  });
  const canvas = await client.request<{ id: string }>("/api/canvases", "POST", { name: "Desk" });
  const node = await client.publish(canvas.id, codingDesk({ sessionId: "coding" }));
  let rendered = "";
  let form: TerminalPanelState | undefined;
  const desk = new CodePanels(
    client,
    (text) => {
      rendered = text;
    },
    async () => null,
    {
      present: (value) => {
        form = value;
      },
    },
  );
  cleanup.defer(() => desk.dispose());
  await desk.command(`open ${canvas.id} ${node.id}`);
  expect(rendered).toContain("Live coding");
  desk.input({ type: "field", id: "request", value: "Keep this draft" });
  f.db.updateCodingSession("coding", { title: "Changed through canonical persistence" });
  await until(() => rendered.includes("Changed through canonical persistence"), {
    timeoutMs: 2500,
  });
  expect(form?.fields[0]?.value).toBe("Keep this draft");
  desk.setActive(false);
  f.db.updateCodingSession("coding", { title: "Changed while reading the world" });
  await Bun.sleep(200);
  expect(rendered).not.toContain("Changed while reading the world");
  desk.setActive(true);
  await until(() => rendered.includes("Changed while reading the world"), { timeoutMs: 2500 });
  expect(form?.fields[0]?.value).toBe("Keep this draft");
  await desk.command("close");
  expect(form).toBeUndefined();
  expect(f.db.getCodingSession("coding")?.status).toBe("active");
});
