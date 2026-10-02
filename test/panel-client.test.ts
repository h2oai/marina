// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "bun:test";
import { CodePanels } from "../scripts/code-panels";
import { MarinaPanelClient } from "../src/sdk/panel-client";
import { resolvePanelSource } from "../src/sdk/panel-resources";
import { panelText } from "../src/sdk/panel-text";

it("terminal panels read live sources and keep the same captured delivery through an explicit retry", async () => {
  const posts: Array<Record<string, unknown>> = [];
  const output: string[] = [];
  let failed = false;
  const document = {
    title: "One coding session",
    panelRevision: "revision",
    sources: { task: { kind: "task", id: "1" } },
    components: [
      { id: "root", component: "Column", children: ["status", "draft", "send"] },
      { id: "status", component: "Text", bindings: { text: { source: "task", path: ["title"] } } },
      { id: "draft", component: "TextField" },
      {
        id: "send",
        component: "Button",
        label: "Send request",
        operation: { kind: "message", targetId: "worker", message: { field: "draft" } },
      },
    ],
  };
  const client = new MarinaPanelClient({
    url: "http://marina.test",
    token: "test",
    fetch: (async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        if (!failed) {
          failed = true;
          throw new Error("Lost acknowledgment");
        }
        return Response.json({ status: "queued", receipt: { id: "same-receipt" } });
      }
      if (path === "/api/routing/overview")
        return Response.json({
          items: [{ owned: true, session: { id: "sender", label: "Sender", state: "active" } }],
        });
      if (path === "/api/coordination/tasks/1")
        return Response.json({ task: { title: "Real task title" } });
      return Response.json({
        id: "panel",
        canvas_id: "board",
        creator_name: "Author",
        data: document,
      });
    }) as typeof fetch,
  });
  const panel = new CodePanels(
    client,
    (text) => output.push(text),
    async () => null,
    { watch: false },
  );
  try {
    await panel.command("open board panel");
    expect(output.at(-1)).toContain("Real task title");
    expect(posts).toHaveLength(0);
    await panel.command("field draft Please review");
    await panel.command("act send sender");
    expect(output.at(-1)).toContain("participant worker");
    expect(posts).toHaveLength(0);
    await panel.command("confirm");
    await panel.command("field draft Changed after the lost response");
    await panel.command("confirm");
    expect(posts).toHaveLength(2);
    expect(posts[0]).toEqual(posts[1]);
    expect(posts[0]!.fields).toEqual({ draft: "Please review" });
    await panel.command("close");
    expect(posts).toHaveLength(2);
  } finally {
    panel.dispose();
  }
});
it("resource adapters encode references and never read an arbitrary URL", async () => {
  const paths: string[] = [];
  const result = await resolvePanelSource({ kind: "participant", id: "a/b?x=1" }, async (path) => {
    paths.push(path);
    return path.includes("events?") ? { events: [], gap: true } : { lastSequence: 150 };
  });
  expect(paths).toEqual([
    "/api/routing/sessions/a%2Fb%3Fx%3D1",
    "/api/routing/sessions/a%2Fb%3Fx%3D1/events?after=50&limit=100",
  ]);
  expect(result).toMatchObject({ gap: true });
  expect(panelText({ components: [{ id: "label", component: "Text", text: "Hello" }] })).toContain(
    "Hello",
  );
  expect(panelText({ components: [{ id: "loop", component: "Card", child: "loop" }] })).toContain(
    "unavailable",
  );
});
