// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
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

/** A valid 2×2 PNG in one colour (distinct bytes per colour, so uploads do not dedupe). */
function png(rgb: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = (crcTable[(c ^ b) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.from([0, ...rgb, ...rgb]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat([row, row]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("asset library, uploads and the media viewer are accessible", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/dashboard?view=library");
  await page.getByRole("button", { name: "Dismiss getting-started guide" }).click();
  await page.getByPlaceholder("Enter your name...").fill("MediaBrowser");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("#marina-command-input")).toBeVisible();
  await page.getByRole("tab", { name: "Library", exact: true }).click();
  const library = page.getByRole("tabpanel", { name: "Library" });
  const stamp = Date.now() % 200;
  const files = [
    { name: "harbour-red.png", mimeType: "image/png", buffer: png([200, stamp, 40]) },
    { name: "harbour-blue.png", mimeType: "image/png", buffer: png([30, stamp, 210]) },
  ];
  await library.getByTestId("upload-input").first().setInputFiles(files);
  const uploads = library.getByRole("region", { name: "Uploads" });
  await expect(uploads.getByText("Uploaded")).toHaveCount(2);
  // The same bytes again are reported, not copied.
  await library.getByTestId("upload-input").first().setInputFiles([files[0]!]);
  await expect(uploads.getByText("Already in your library")).toBeVisible();
  const grid = library.getByRole("listbox", { name: /Assets/ });
  await expect(grid.getByRole("option", { name: /harbour-blue\.png/ })).toBeVisible();
  await audit(page, "asset-library");

  // Open from the keyboard; ←/→ move through the current results.
  await grid.getByRole("option", { name: /harbour-red\.png/ }).click();
  await grid.press("Enter");
  const viewer = page.getByRole("dialog", { name: /harbour-red\.png/ });
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole("button", { name: "Close viewer" })).toBeFocused();
  await viewer.getByRole("button", { name: "Details" }).click();
  await expect(viewer.getByRole("complementary", { name: "Asset details" })).toContainText("2 × 2");
  await page.screenshot({ path: test.info().outputPath("media-viewer.png") });
  await audit(page, "media-viewer");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("dialog", { name: /harbour-blue\.png/ })).toBeVisible();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme-scheme", "light");
  await audit(page, "media-viewer-light");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(grid).toBeFocused();
  await page.screenshot({ path: test.info().outputPath("asset-library-light.png") });

  // The uploads are durable chat media: after a reload (no live events) the
  // transcript still shows them as cards that open the viewer, with ←/→
  // moving through the conversation's media.
  await page.reload();
  await expect(page.locator("#marina-command-input")).toBeVisible();
  const card = page
    .getByTestId("chat-media-card")
    .filter({ hasText: "harbour-red.png" })
    .first();
  await expect(card).toBeVisible();
  await expect(
    page.getByTestId("chat-media-card").filter({ hasText: "harbour-blue.png" }).first(),
  ).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: test.info().outputPath("chat-media-card.png") });
  await audit(page, "chat-media-cards");
  await card.getByRole("button", { name: "Open harbour-red.png in the media viewer" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: /harbour-red\.png/ })).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("dialog", { name: /harbour-blue\.png/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
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
