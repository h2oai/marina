// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test";

test("resident browses original memory sources and revision history through the real world connection", async ({
  page,
  request,
}) => {
  const replies = new Map<string, { ok: boolean; result: { id: string }; error?: unknown }>();
  page.on("websocket", (socket) =>
    socket.on("framereceived", (frame) => {
      try {
        const message = JSON.parse(String(frame.payload));
        const result = message.data?.memory_service;
        if (result?.request_id) replies.set(result.request_id, result);
      } catch {}
    }),
  );
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Dismiss getting-started guide" }).click();
  await page.getByPlaceholder("Enter your name...").fill("MemoryBrowser");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const command = page.locator("#marina-command-input");
  await expect(command).toBeVisible();
  const send = async (operation: string, input: Record<string, unknown>, id?: string) => {
    const request_id = crypto.randomUUID();
    await command.fill(`memory api ${JSON.stringify({ operation, input, id, request_id })}`);
    await command.press("Enter");
    await expect.poll(() => replies.has(request_id)).toBe(true);
    const reply = replies.get(request_id)!;
    expect(reply.ok, JSON.stringify(reply.error)).toBe(true);
    return reply.result;
  };
  const source = await send("capture", {
    content: "Browser original α🙂 evidence: the launch review is scheduled.",
  });
  const memory = await send("remember", {
    content: "Initial launch assertion",
    source_ids: [source.id],
  });
  await send(
    "revise",
    { expected_version: 1, content: "Revised launch assertion", source_ids: [source.id] },
    memory.id,
  );
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  const workspace = page.getByRole("complementary", { name: "Memory workspace" });
  await expect(workspace).toBeVisible();
  await workspace.getByRole("button", { name: "Load", exact: true }).click();
  await workspace.getByRole("button", { name: /Revised launch assertion/ }).click();
  await expect(workspace.getByText("Revision 2 of 2")).toBeVisible();
  await workspace.getByRole("button", { name: source.id, exact: true }).click();
  await expect(
    workspace.getByText("Browser original α🙂 evidence: the launch review is scheduled.", {
      exact: true,
    }),
  ).toBeVisible();
  await workspace.getByText("Compare with revision 1").click();
  await expect(workspace.getByText("Initial launch assertion", { exact: true })).toBeVisible();
  await page.screenshot({ path: "/tmp/marina-followon-memory-workspace.png", fullPage: true });
  await workspace.getByRole("button", { name: "Sources", exact: true }).click();
  await workspace.getByRole("button", { name: "Load", exact: true }).click();
  await workspace.getByRole("button", { name: source.id, exact: true }).click();
  await expect(
    workspace.getByText("Browser original α🙂 evidence: the launch review is scheduled.", {
      exact: true,
    }),
  ).toBeVisible();
  await workspace.getByRole("button", { name: "Memories", exact: true }).click();
  await workspace.getByRole("button", { name: "Load", exact: true }).click();
  await workspace.getByRole("button", { name: /Revised launch assertion/ }).click();
  const board = await (
    await request.post("/api/canvases", { data: { name: "Memory references", scope: "global" } })
  ).json();
  await workspace.getByRole("button", { name: "Pin to canvas" }).click();
  await page.getByLabel("Destination canvas").selectOption(board.id);
  await page.getByRole("button", { name: "Pin reference" }).click();
  await expect(workspace).not.toBeVisible();
  const card = page.locator(".react-flow__node").filter({ hasText: "Live memory" });
  await expect(card).toContainText("Revised launch assertion");
  const snapshot = await (await request.get(`/api/canvases/${board.id}`)).json();
  const pinned = snapshot.nodes.find(
    (node: { data: { reference?: { id: string } } }) => node.data.reference?.id === memory.id,
  );
  expect(Object.keys(pinned.data)).toEqual(["reference"]);
  expect(JSON.stringify(pinned.data)).not.toContain("Revised launch assertion");
  await card.getByRole("button", { name: "Inspect source" }).click();
  await page.getByRole("button", { name: "Open in memory" }).click();
  await expect(workspace.getByText("Revision 2 of 2")).toBeVisible();
  await workspace.getByRole("button", { name: "Close memory" }).click();
  await page.getByRole("button", { name: "Back to work" }).click();
  await expect(page.getByRole("tab", { name: "Work", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});
