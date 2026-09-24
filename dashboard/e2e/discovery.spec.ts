// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test";

test("operator discovers commands, drafts work, searches entities, and restores a maximized panel", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Dismiss getting-started guide" }).click();
  await page.getByPlaceholder("Enter your name...").fill("DiscoveryBrowser");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const input = page.locator("#marina-command-input");
  await expect(input).toBeVisible();
  await input.press("Control+k");
  const search = page.getByRole("combobox", { name: "Search commands and world" });
  await expect(search).toBeFocused();
  await search.fill("task");
  await page.getByRole("option", { name: "Compose task, Coordination", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Review dashboard");
  await page.getByLabel("Description", { exact: true }).fill("Check discovery and navigation");
  await page.getByRole("button", { name: "Fill command" }).click();
  await page.screenshot({ path: "/tmp/marina-ux-command-composer.png", fullPage: true });
  await page.getByRole("button", { name: "Insert into chat" }).click();
  await expect(input).toHaveValue("task create Review dashboard | Check discovery and navigation");
  await expect(input).toBeFocused();
  await input.press("Enter");
  await expect
    .poll(async () => (await page.request.get("/api/search?q=Review%20dashboard")).json())
    .toContainEqual(expect.objectContaining({ kind: "task", title: "Review dashboard" }));
  await page.getByRole("button", { name: /^Maximize Workspace/ }).click();
  await expect(page.locator(".react-grid-item")).toHaveCount(3);
  await page.getByRole("button", { name: /^Restore Workspace/ }).click();
  await page.getByRole("button", { name: "Search Marina (Ctrl or Command K)" }).click();
  await search.fill("DiscoveryBrowser");
  await expect(page.getByRole("option", { name: /DiscoveryBrowser.*entity/ })).toBeVisible();
  await page.screenshot({ path: "/tmp/marina-ux-global-search.png", fullPage: true });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const roster = page.locator('div[data-entity-preview="DiscoveryBrowser"]');
  await roster.hover();
  await expect(page.getByRole("tooltip")).toContainText("Standing");
  await page.screenshot({ path: "/tmp/marina-ux-dashboard.png", fullPage: true });
  await page.getByText("More", { exact: true }).click();
  await page.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Search Marina (Ctrl or Command K)" }).click();
  await expect(search).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: "/tmp/marina-ux-mobile-search.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("guided crew commands, favorites, and task actions prepare drafts without sending", async ({
  page,
}) => {
  const commands: string[] = [];
  page.on("websocket", (socket) =>
    socket.on("framesent", (frame) => {
      const message = JSON.parse(String(frame.payload));
      if (message.type === "command") commands.push(message.command);
    }),
  );
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Dismiss getting-started guide" }).click();
  await page.getByPlaceholder("Enter your name...").fill("ComposerBrowser");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const input = page.locator("#marina-command-input");
  await expect(input).toBeVisible();
  await page.getByRole("button", { name: "Commands", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Search and compose commands" });
  await dialog.getByRole("combobox", { name: "Search commands and world" }).fill("crew");
  await dialog.getByRole("option", { name: /^Compose crew,/ }).click();
  await dialog.getByLabel("Command action").selectOption("crew invite <name> <agent> [role:<r>]");
  await dialog.getByLabel("Name", { exact: true }).fill("builders");
  await dialog.getByLabel("Agent", { exact: true }).fill("builder");
  await dialog.getByLabel("Include role:r").check();
  await dialog.getByLabel("Role", { exact: true }).fill("engineer");
  await dialog.getByRole("button", { name: "Fill command" }).click();
  await dialog.getByRole("button", { name: "Pin command", exact: true }).click();
  await dialog.getByRole("button", { name: "Insert into chat" }).click();
  await expect(input).toHaveValue("crew invite builders builder role:engineer");
  expect(commands).toEqual([]);
  await input.fill("A different draft");
  await page
    .getByRole("navigation", { name: "Favorite commands" })
    .getByRole("button", { name: "crew invite builders builder role:engineer", exact: true })
    .click();
  await expect(input).toHaveValue("crew invite builders builder role:engineer");
  expect(commands).toEqual([]);
  await expect(page.getByRole("region", { name: "My inventory" })).toBeVisible();
  await page.getByRole("button", { name: "Commands", exact: true }).click();
  await dialog.getByRole("combobox", { name: "Search commands and world" }).fill("code");
  await dialog.getByRole("option", { name: /^Compose code,/ }).click();
  await dialog.getByLabel("Command action").selectOption("code write <path> <content>");
  await dialog.getByLabel("Path", { exact: true }).fill("example.ts");
  await dialog.getByLabel("Content", { exact: true }).fill("const value = 1;\nconsole.log(value);");
  await dialog.getByRole("button", { name: "Fill command" }).click();
  await expect(dialog.getByLabel("Arguments and parameters")).toHaveValue(
    "write example.ts\nconst value = 1;\nconsole.log(value);",
  );
  await dialog.getByRole("button", { name: "Insert into chat" }).click();
  await expect(input).toHaveValue("code write example.ts\nconst value = 1;\nconsole.log(value);");
  expect(commands).toEqual([]);
  await input.fill("task list");
  await input.press("Enter");
  await page
    .getByRole("dialog", { name: "Task Snapshot" })
    .getByRole("button", { name: "Claim", exact: true })
    .first()
    .click();
  await expect(input).toHaveValue(/^task claim \d+$/);
  expect(commands).toEqual(["task list"]);
  await page.screenshot({ path: "/tmp/marina-command-favorites.png", fullPage: true });
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Favorite commands" })).toContainText(
    "crew invite builders builder role:engineer",
  );
});
