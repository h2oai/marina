// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

test("workspace preserves chat, edits nodes, pins live work, and adapts to mobile", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const board = await (
    await request.post("/api/canvases", { data: { name: "Workspace workflow", scope: "global" } })
  ).json();
  const node = await (
    await request.post(`/api/canvases/${board.id}/nodes`, {
      data: { type: "text", data: { title: "Review target", content: "Review this design" } },
    })
  ).json();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/dashboard?view=canvas&canvas=${board.id}`);
  await page.getByRole("button", { name: "Dismiss getting-started guide" }).click();
  await page.getByPlaceholder("Enter your name...").fill("WorkspaceBrowser");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const input = page.locator("#marina-command-input");
  await expect(input).toBeVisible();
  await input.fill("Keep my draft");
  const card = page.locator(`.react-flow__node[data-id="${node.id}"]`);
  await card.click();
  const inspector = page.getByRole("region", { name: "Shared inspector" });
  await expect(inspector.getByRole("heading", { name: "Node Detail" })).toBeVisible();
  await inspector.getByLabel("Node title").fill("Revised design");
  await inspector.getByRole("button", { name: "Save properties" }).click();
  await expect(card).toContainText("Revised design");
  await inspector.getByRole("button", { name: "Discuss this node" }).click();
  await expect(page.getByRole("region", { name: "Attached canvas context" })).toBeVisible();
  await expect(input).toHaveValue("Keep my draft");
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await input.fill("This design is ready for review");
  await input.press("Enter");
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await expect(page.getByRole("region", { name: "Attached canvas context" })).toHaveCount(0);
  await input.fill("Preserve across views");
  await page.getByRole("button", { name: "Zoom In", exact: true }).click();
  await page.waitForTimeout(250);
  const viewport = await page.locator(".react-flow__viewport").getAttribute("style");
  await page.getByRole("tab", { name: "Map", exact: true }).click();
  await page.getByRole("tab", { name: "Canvas", exact: true }).click();
  await expect(page.locator(".react-flow__viewport")).toHaveAttribute("style", viewport!);
  await expect(input).toHaveValue("Preserve across views");
  await page.getByRole("button", { name: "Full screen", exact: true }).click();
  await expect(page).toHaveURL(/\/canvas\?/);
  await page.getByRole("button", { name: "Exit full screen", exact: true }).click();
  await expect(input).toHaveValue("Preserve across views");
  await input.fill("task create Workspace review | Review the new panels");
  await input.press("Enter");
  await expect
    .poll(async () => (await request.get("/api/search?q=Workspace%20review")).json())
    .toContainEqual(expect.objectContaining({ kind: "task", title: "Workspace review" }));
  await input.press("Control+k");
  await page.getByRole("combobox", { name: "Search commands and world" }).fill("Workspace review");
  await page.getByRole("option", { name: /Workspace review.*task/ }).click();
  await inspector.getByRole("button", { name: "Pin to canvas" }).click();
  await page.getByLabel("Destination canvas").selectOption(board.id);
  await page.getByRole("button", { name: "Pin reference" }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await expect(page.locator(".react-flow__node").filter({ hasText: "Live task" })).toContainText(
    "Workspace review",
  );
  await input.fill("Still here on mobile");
  await page.screenshot({ path: "/tmp/marina-workspace-create.png" });
  await page.getByTitle("Switch workspace layout").selectOption("default");
  await expect(page.getByRole("tab", { name: "Work", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(input).toHaveValue("Still here on mobile");
  await page.screenshot({ path: "/tmp/marina-workspace-operate.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("navigation", { name: "Dashboard panes" })
    .getByRole("button", { name: "Chat", exact: true })
    .click();
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("Still here on mobile");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: "/tmp/marina-workspace-mobile.png" });
  expect(errors).toEqual([]);
});
