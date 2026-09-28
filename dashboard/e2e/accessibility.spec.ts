// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { writeFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

async function audit(page: Page, name: string) {
  await expect(page.getByRole("complementary", { name: "Getting started" })).toBeHidden();
  // Theme colors must settle; live map position/opacity transitions never stop.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter(
              (animation) =>
                animation instanceof CSSTransition &&
                ["background-color", "color"].includes(animation.transitionProperty) &&
                animation.playState === "running",
            ).length,
      ),
    )
    .toBe(0);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const report = test.info().outputPath(`${name}.json`);
  await writeFile(report, JSON.stringify(results, null, 2));
  await test.info().attach(name, { path: report, contentType: "application/json" });
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
  expect
    .soft(
      results.violations.map(({ id, nodes }) => ({
        id,
        nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
      })),
      name,
    )
    .toEqual([]);
}

test("dashboard participation and discovery are accessible", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Dismiss getting-started guide" }).click();
  await audit(page, "dashboard-before-login");
  await page.getByPlaceholder("Enter your name...").fill("AccessibilityBrowser");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const input = page.locator("#marina-command-input");
  await expect(input).toBeVisible();
  await audit(page, "dashboard-connected");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme-scheme", "dark");
  await audit(page, "dashboard-connected-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme-scheme", "light");
  await input.fill("/mem");
  await expect(page.getByRole("listbox", { name: "Command suggestions" })).toBeVisible();
  await audit(page, "inline-command-suggestions");
  await input.fill("");
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog")).toBeVisible();
  await audit(page, "command-discovery-dialog");
  await page.keyboard.press("Escape");
});

test("mobile dashboard is accessible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Dismiss getting-started guide" }).click();
  await audit(page, "mobile-dashboard");
});

test("canvas workspace is accessible", async ({ page }) => {
  await page.goto("/canvas");
  await expect(page.getByRole("button", { name: "Dismiss getting-started guide" })).toBeVisible();
  await page.getByRole("button", { name: "Dismiss getting-started guide" }).click();
  await audit(page, "canvas-workspace");
});

test("unified panels and modal retain keyboard access", async ({ page }) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/dashboard?unified");
  await expect(page.getByRole("region", { name: "World canvas" })).toBeVisible();
  await page.getByRole("button", { name: "Expand entity panel", exact: true }).press("Enter");
  await expect(
    page.getByRole("button", { name: "Collapse entity panel", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await audit(page, "unified-panels");
  const opener = page.getByRole("button", { name: "Keyboard shortcuts", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "KEYBOARD SHORTCUTS" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "CLOSE", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "CLOSE", exact: true })).toBeFocused();
  await audit(page, "unified-shortcuts-modal");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});
