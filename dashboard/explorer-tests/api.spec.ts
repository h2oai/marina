// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

test("explorer searches generated tools, expands fields, and preserves shareable selection", async ({
  page,
}) => {
  await page.goto("/api");
  await page.getByRole("searchbox").fill("memory_retrieve");
  await page.getByRole("button", { name: "memory_retrieve", exact: true }).click();
  await expect(page.getByRole("heading", { name: "memory_retrieve", exact: true })).toBeVisible();
  await page.getByText("max_results · optional", { exact: true }).click();
  await expect(page.getByText('"maximum": 20', { exact: false }).first()).toBeVisible();
  expect(
    JSON.parse(await page.getByRole("textbox", { name: /Request template/ }).inputValue()),
  ).toEqual({ name: "memory_retrieve", arguments: { task: "" } });
  await page.reload();
  await expect(page.getByRole("heading", { name: "memory_retrieve", exact: true })).toBeVisible();
  await page.screenshot({ path: "/tmp/marina-api-explorer.png", fullPage: true });
});

test("explorer handles mobile navigation, all reference surfaces, and empty searches", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/api");
  for (const [surface, query] of [
    ["commands", "context"],
    ["http", "/health"],
    ["sdk", "memory-client"],
  ]) {
    await page.getByLabel("Interface", { exact: true }).selectOption(surface!);
    await page.getByRole("searchbox").fill(query!);
    await page.getByRole("navigation", { name: "API entries" }).getByRole("button").first().click();
    await expect(page.getByRole("article")).toContainText(query!);
  }
  await page.getByRole("searchbox").fill("<img src=x onerror=alert(1)>");
  await expect(page.getByRole("status")).toHaveText("0 entries");
  await expect(page.locator("#detail img")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
