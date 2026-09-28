// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { writeFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { reviewTextContrast } from "./contrast-review";

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
  expect
    .soft(
      results.incomplete.flatMap(({ id, nodes }) =>
        id === "color-contrast"
          ? nodes
              .filter((node) =>
                node.any.some((check) => check.data?.messageKey === "pseudoContent"),
              )
              .map(({ target }) => target)
          : [],
      ),
      `${name}: decorative overlays must not obscure text`,
    )
    .toEqual([]);
  if (name.startsWith("unified-")) {
    const targets = results.incomplete
      .filter(({ id }) => id === "color-contrast")
      .flatMap(({ nodes }) =>
        nodes
          // Moving SVG coordinates can change while axe analyzes the page.
          // These labels are all measured below through their stable class.
          .filter(({ html }) => !html.includes('class="uc-map-label"'))
          .flatMap(({ target }) => target.map(String)),
      );
    // Also check every outlined map label; axe does not always inspect SVG text.
    targets.push(".uc-map-label");
    const review = await reviewTextContrast(page, targets);
    const paintReport = test.info().outputPath(`${name}-contrast-paints.json`);
    await writeFile(paintReport, JSON.stringify(review, null, 2));
    await test.info().attach(`${name}-contrast-paints`, {
      path: paintReport,
      contentType: "application/json",
    });
    expect
      .soft(
        review.filter((entry) => entry.error || (entry.ratio ?? 0) < 4.5),
        `${name}: supplemental contrast review`,
      )
      .toEqual([]);
  }
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
  await page.getByRole("button", { name: "Expand command bar", exact: true }).click();
  await page
    .getByRole("region", { name: "World navigation" })
    .getByRole("button", { name: "WORLD", exact: true })
    .click();
  await audit(page, "unified-expanded-controls");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme-scheme", "light");
  await audit(page, "unified-panels-light");
  await opener.click();
  await audit(page, "unified-shortcuts-light");
  await page.keyboard.press("Escape");
  // The theme switcher cycles Light → H2O → the other four dark palettes.
  for (const theme of ["h2o", "cyberpunk", "synthwave", "matrix", "ocean"]) {
    await page.getByRole("button", { name: /^Cycle theme/ }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await audit(page, `unified-theme-${theme}`);
  }
});

test("supplemental contrast review detects low contrast and unknown backgrounds", async ({
  page,
}) => {
  await page.setContent(`
    <div style="background: white">
      <span id="readable" style="color: black">Readable</span>
      <span id="faint" style="color: #aaa">Faint</span>
      <span id="alpha" style="color: rgb(0 0 0 / 10%)">Translucent</span>
      <span id="gradient" style="background: linear-gradient(white, black)">Unknown</span>
      <span style="opacity: .2"><span id="inherited">Faded parent</span></span>
    </div>
  `);
  const results = await reviewTextContrast(page, [
    "#readable",
    "#faint",
    "#alpha",
    "#gradient",
    "#inherited",
    "#missing",
  ]);
  expect(results[0].ratio).toBe(21);
  expect(results[1].ratio).toBeLessThan(4.5);
  expect(results[2].ratio).toBeLessThan(4.5);
  expect(results[3].error).toContain("Non-solid");
  expect(results[4].error).toContain("Transparent");
  expect(results[5].error).toContain("disappeared");
});
