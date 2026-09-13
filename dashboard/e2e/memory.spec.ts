// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test";

test("resident browses original memory sources and revision history through the real world connection", async ({
  page,
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
});
