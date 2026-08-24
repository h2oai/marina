// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test";

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
