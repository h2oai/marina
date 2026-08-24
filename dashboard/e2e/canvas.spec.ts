// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test";

test("dashboard attention is globally visible and opens without navigating away", async ({
  page,
}) => {
  await page.goto("/dashboard");
  await page.getByRole("button", { name: /alerts/ }).click();
  await expect(page.getByRole("complementary", { name: "Attention inbox" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Needs attention" })).toBeVisible();
  await page.getByRole("button", { name: "Close attention inbox" }).click();
  await expect(page.getByRole("complementary", { name: "Attention inbox" })).toHaveCount(0);
});

test("dashboard Work and Pulse are globally reachable and mutually coherent", async ({ page }) => {
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Pulse" }).click();
  await expect(page.getByRole("complementary", { name: "Live pulse" })).toBeVisible();
  await expect(page.getByText(/live WebSocket window, not historical totals/i)).toBeVisible();

  await page.getByRole("button", { name: "Work" }).click();
  await expect(page.getByRole("complementary", { name: "Live pulse" })).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "Work overview" })).toBeVisible();
  await expect(page.locator('.glass-panel[style*="opacity: 0"]')).toHaveCount(0);
});

test("production Canvas opens in a coherent, actionable state", async ({ page }) => {
  await page.goto("/canvas");
  await expect(page.getByRole("heading", { name: "MARINA CANVAS" })).toBeVisible();
  await expect(page.getByRole("button", { name: "+ Canvas" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add a note" })).toBeVisible();
  await expect(page.getByText("This canvas is empty")).toBeVisible();
  await expect(page.locator('.react-flow__node [style*="scale(0)"]')).toHaveCount(0);
});

test("a user can create a canvas, add notes, and connect them without reloading", async ({
  page,
}) => {
  await page.goto("/canvas");
  await page.getByRole("button", { name: "+ Canvas" }).click();
  await page.getByLabel("Name").fill("Browser workflow");
  await page.getByLabel(/Description/).fill("Created entirely through the Canvas UI");
  await page.getByRole("button", { name: "Create canvas" }).click();
  await expect(page.getByRole("status")).toContainText("Created");
  await expect(page.getByText("This canvas is empty")).toBeVisible();

  await page.getByRole("button", { name: "Add a note" }).click();
  await page.getByRole("button", { name: "+ Note" }).click();
  const nodes = page.locator(".react-flow__node");
  await expect(nodes).toHaveCount(2);

  await nodes.nth(0).click();
  await nodes.nth(1).click({ modifiers: ["Control"] });
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByLabel("Relationship").selectOption("supports");
  await page.getByRole("button", { name: "Create relationship" }).click();
  await expect(page.getByText("supports", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await expect(page.getByText("supports", { exact: true })).toBeVisible();
});

test("mobile Canvas keeps the primary controls and a node in view", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/canvas");
  await expect(page.getByRole("button", { name: "+ Canvas" })).toBeVisible();
  await expect(page.getByRole("button", { name: "+ Note" })).toBeVisible();
  await expect(page.locator(".react-flow__node").first()).toBeInViewport();
});

test("a failed relationship mutation is visible and leaves the dialog recoverable", async ({
  page,
  request,
}) => {
  const canvasResponse = await request.post("/api/canvases", {
    data: { name: "Failure feedback", scope: "global" },
  });
  const canvas = (await canvasResponse.json()) as { id: string };
  for (const content of ["Source", "Target"]) {
    await request.post(`/api/canvases/${canvas.id}/nodes`, {
      data: { type: "text", data: { content } },
    });
  }
  await page.goto(`/canvas?canvas=${canvas.id}`);
  const nodes = page.locator(".react-flow__node");
  await expect(nodes).toHaveCount(2);
  await nodes.nth(0).click();
  await nodes.nth(1).click({ modifiers: ["Control"] });
  await page.getByRole("button", { name: "Connect" }).click();
  await page.route(`**/api/canvases/${canvas.id}/edges`, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"error":"Temporarily unavailable"}',
    }),
  );
  await page.getByRole("button", { name: "Create relationship" }).click();
  await expect(page.getByRole("alert")).toContainText("Temporarily unavailable");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create relationship" })).toBeEnabled();
});

test("an exact Canvas node link restores, focuses, and explains a missing target", async ({
  page,
  request,
}) => {
  const canvasResponse = await request.post("/api/canvases", {
    data: { name: "Deep link", scope: "global" },
  });
  const canvas = (await canvasResponse.json()) as { id: string };
  const nodeResponse = await request.post(`/api/canvases/${canvas.id}/nodes`, {
    data: { type: "text", data: { title: "Exact destination", content: "Referenced content" } },
  });
  const node = (await nodeResponse.json()) as { id: string };

  await page.goto(
    `/canvas?canvas=${encodeURIComponent(canvas.id)}&node=${encodeURIComponent(node.id)}`,
  );
  await expect(page.getByText("Exact destination").first()).toBeVisible();
  await expect(
    page.getByRole("complementary").getByRole("heading", { name: "Node Detail" }),
  ).toBeVisible();
  await expect(page).toHaveURL((url) => {
    return url.searchParams.get("canvas") === canvas.id && url.searchParams.get("node") === node.id;
  });

  await page.getByRole("complementary").getByRole("button", { name: "×" }).click();
  await expect(page).toHaveURL((url) => !url.searchParams.has("node"));
  await page.goBack();
  await expect(
    page.getByRole("complementary").getByRole("heading", { name: "Node Detail" }),
  ).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("complementary")).toHaveCount(0);

  await page.goto(`/canvas?canvas=${encodeURIComponent(canvas.id)}&node=deleted-node`);
  await expect(page.getByRole("alert")).toContainText("unavailable or was deleted");
});
