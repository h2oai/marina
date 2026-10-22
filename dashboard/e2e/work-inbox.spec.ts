// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

test("follows a canvas request from Work through claim, history, and delivered output", async ({
  page,
  request,
}) => {
  // Specs share one server across retries and repeats: an earlier attempt's
  // account, canvas name and cards are still there, so each attempt is its own.
  const tag = crypto.randomUUID().slice(0, 8);
  const who = `Inbox${tag}`;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/dashboard?view=work");
  await page.getByRole("button", { name: "Dismiss getting-started guide" }).click();
  await page.getByPlaceholder("Enter your name...").fill(who);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const input = page.locator("#marina-command-input");
  await expect(input).toBeVisible();
  const token = await page.evaluate(() => localStorage.getItem("marina_chat_token"));
  const headers = { Authorization: `Bearer ${token}` };
  const prompt = `Review the observatory release plan ${tag}`;
  const canvasResponse = await request.post("/api/canvases", {
    headers,
    data: { name: `Inbox journey ${tag}` },
  });
  expect(canvasResponse.ok()).toBe(true);
  const canvas = await canvasResponse.json();
  const nodeResponse = await request.post(`/api/canvases/${canvas.id}/nodes`, {
    headers,
    data: {
      type: "text",
      data: {
        title: "Release plan",
        intent: { status: "pending", prompt },
      },
    },
  });
  expect(nodeResponse.ok()).toBe(true);
  const node = await nodeResponse.json();
  const inbox = page.getByRole("region", { name: "Work inbox", exact: true });
  const card = inbox
    .getByRole("article")
    .filter({ hasText: prompt });
  await expect(card).toBeVisible();
  await input.fill("Keep this chat draft");
  await page.screenshot({ path: "/tmp/marina-unified-work-inbox.png" });
  await card.getByRole("button", { name: "Open request" }).click();
  await expect(page).toHaveURL(new RegExp(`node=${node.id}`));
  await expect(input).toHaveValue("Keep this chat draft");
  await page.getByRole("button", { name: "Claim Intent", exact: true }).click();
  const timeline = page.getByRole("region", { name: "Request history" });
  await expect(timeline).toContainText(`${who} claimed the request`);
  await page
    .getByPlaceholder("Deliver the result for this intent...")
    .fill("Release reviewed: ready for the task verification step.");
  await page.getByRole("button", { name: "Complete Intent", exact: true }).click();
  await expect(timeline).toContainText(`${who} delivered a result`);
  await expect(timeline).toContainText("does not establish verification or task approval");
  await page.screenshot({ path: "/tmp/marina-unified-work-history.png" });
  await page.getByRole("tab", { name: "Work", exact: true }).click();
  await expect(card).toContainText("Completed");
  await expect(card).toContainText("verification and task approval are separate");
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("navigation", { name: "Dashboard panes" })
    .getByRole("button", { name: "Workspace", exact: true })
    .click();
  await expect(card).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/marina-unified-work-mobile.png" });
  expect(errors).toEqual([]);
});
