// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const panel = (page: Page, id: string) => page.locator(`[data-pane-key="${id}"]`);
async function openMap(page: Page) {
  await page.goto("/dashboard?surface=canvas");
  await page.getByRole("button", { name: "Dismiss getting-started guide" }).click();
  await page.getByRole("tab", { name: "Map", exact: true }).click();
  await expect(page.locator("#view-map").getByLabel("World map", { exact: true })).toBeVisible();
}

test("mixed map and Streams tiles restore through the same presets in both renderers", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openMap(page);
  await panel(page, "workspace").getByRole("button", { name: "Open map below" }).click();
  await page.getByRole("tab", { name: "Streams", exact: true }).click();
  await panel(page, "workspace").getByRole("button", { name: "Open streams below" }).click();
  await page.getByLabel("More dashboard options").click();
  page.once("dialog", (dialog) => dialog.accept("Work, world and agents"));
  await page.getByRole("button", { name: "Save layout preset", exact: true }).click();
  for (const url of ["/dashboard", "/dashboard?surface=canvas"]) {
    await page.goto(url);
    await expect(page.getByTitle("Switch workspace layout")).toContainText(
      "Work, world and agents",
    );
    await expect(page.locator('[data-pane-key^="view:"]')).toHaveCount(2);
    await expect(
      panel(page, "view:worldmap:1").getByLabel("World map", { exact: true }),
    ).toBeVisible();
    await expect(
      panel(page, "view:streams:1").getByText("Log in through Chat to view participant streams."),
    ).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("navigation", { name: "Dashboard panes" })
    .getByRole("button", { name: "Streams 1", exact: true })
    .click();
  await page.getByLabel("More dashboard options").click();
  await page.getByRole("button", { name: "Reset layout", exact: true }).click();
  await expect(page.locator('[data-pane-key^="view:"]')).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Work", exact: true })).toBeVisible();
});

test("repeated maps have independent controls while chat and live world connections stay intact", async ({
  page,
  browser,
}) => {
  test.setTimeout(60_000);
  const sockets: string[] = [];
  const commands: string[] = [];
  const mutations: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()))
      mutations.push(request.url());
  });
  page.on("websocket", (socket) => {
    sockets.push(socket.url());
    socket.on("framesent", (frame) => {
      const message = JSON.parse(String(frame.payload));
      if (message.type === "command") commands.push(message.command);
    });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openMap(page);
  await page.getByPlaceholder("Enter your name...").fill("MapViewsResident");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const input = page.locator("#marina-command-input");
  await expect(input).toBeVisible();
  await input.fill("Keep my unsent work");
  await input.evaluate((element) => element.setAttribute("data-mount-proof", "retained"));
  await expect
    .poll(() =>
      sockets.some(
        (url) =>
          new URL(url).pathname === "/dashboard-ws" && new URL(url).searchParams.has("token"),
      ),
    )
    .toBe(true);
  const initialSockets = [...sockets];
  expect(initialSockets.map((url) => new URL(url).pathname).sort()).toEqual([
    "/dashboard-ws",
    "/dashboard-ws",
    "/ws",
  ]);
  const initialMutations = [...mutations];
  const original = page.locator("#view-map");
  const originalSvg = original.getByLabel("World map", { exact: true });
  const viewBox = await originalSvg.getAttribute("viewBox");
  const initialBox = await panel(page, "workspace").boundingBox();
  await panel(page, "workspace").getByRole("button", { name: "Open map below" }).click();
  const copy = panel(page, "view:worldmap:1");
  await expect(copy).toBeVisible();
  await expect
    .poll(() => copy.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);
  const copiedSvg = copy.getByLabel("World map", { exact: true });
  await copiedSvg.evaluate((element) => element.setAttribute("data-mount-proof", "retained"));
  await copy.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(copiedSvg).not.toHaveAttribute("viewBox", viewBox!);
  await expect(originalSvg).toHaveAttribute("viewBox", viewBox!);
  await copy.getByRole("button", { name: "Heat", exact: true }).click();
  await expect(copy.getByRole("button", { name: "Heat", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(original.getByRole("button", { name: "Heat", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // Every SVG definition and reference belongs to this view, not another copy.
  const svgIntegrity = await page.locator('svg[aria-label="World map"]').evaluateAll((maps) => {
    const ids = maps.flatMap((map) => [...map.querySelectorAll("[id]")].map((node) => node.id));
    const missing = maps.flatMap((map) =>
      [...map.querySelectorAll("*")].flatMap((node) =>
        [...node.attributes].flatMap((attribute) =>
          [...attribute.value.matchAll(/url\(#([^)]*)\)/g)]
            .filter(
              (match) =>
                ![...map.querySelectorAll("[id]")].some((definition) => definition.id === match[1]),
            )
            .map((match) => match[1]),
        ),
      ),
    );
    return { duplicates: ids.filter((id, index) => ids.indexOf(id) !== index), missing };
  });
  expect(svgIntegrity).toEqual({ duplicates: [], missing: [] });
  await copy.getByRole("button", { name: "Maximize World 1 panel" }).click();
  await copy.getByRole("button", { name: "Restore World 1 panel" }).click();
  await expect(copiedSvg).toHaveAttribute("data-mount-proof", "retained");
  const peer = await browser.newPage();
  try {
    await peer.goto("/chat");
    await peer.locator("#name-input").fill("MapViewsPeer");
    await peer.locator("#login-btn").click();
    await expect(
      original.getByRole("button", { name: "Inspect MapViewsPeer", exact: true }),
    ).toBeAttached();
    await expect(
      copy.getByRole("button", { name: "Inspect MapViewsPeer", exact: true }),
    ).toBeAttached();
    await page.getByRole("tab", { name: "Work", exact: true }).click();
    await expect(originalSvg).toBeHidden();
    await expect(copiedSvg).toBeVisible();
    await expect(panel(page, "context").getByText("MapViewsPeer", { exact: true })).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(
      results.violations.map(({ id, nodes }) => ({
        id,
        targets: nodes.map((node) => node.target),
      })),
    ).toEqual([]);
    const path = test.info().outputPath("work-with-live-world.png");
    await page.screenshot({ path });
    await test.info().attach("Work alongside live World Map", { path, contentType: "image/png" });
  } finally {
    await peer.close();
  }
  await copy.getByRole("button", { name: "Close World 1 view" }).click();
  await expect(copy).toHaveCount(0);
  await expect
    .poll(() =>
      panel(page, "workspace").evaluate((element) => element.contains(document.activeElement)),
    )
    .toBe(true);
  await expect.poll(() => panel(page, "workspace").boundingBox()).toEqual(initialBox);
  await expect(input).toHaveValue("Keep my unsent work");
  await expect(input).toHaveAttribute("data-mount-proof", "retained");
  expect(sockets).toEqual(initialSockets);
  expect(mutations).toEqual(initialMutations);
  expect(commands).toEqual([]);
  expect(errors).toEqual([]);
});

test("extra maps save in existing presets, restore on both renderers and remain reachable on phones", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openMap(page);
  for (let i = 1; i <= 4; i++) {
    await panel(page, "workspace").getByRole("button", { name: "Open map below" }).click();
    await expect(panel(page, `view:worldmap:${i}`)).toBeAttached();
  }
  await expect(
    panel(page, "workspace").getByRole("button", { name: "Open map below" }),
  ).toBeDisabled();
  await expect
    .poll(() =>
      page
        .locator(".dashboard-grid")
        .evaluate((element) => element.scrollHeight > element.clientHeight),
    )
    .toBe(true);
  await page.getByLabel("More dashboard options").click();
  page.once("dialog", (dialog) => dialog.accept("Work with maps"));
  await page.getByRole("button", { name: "Save layout preset", exact: true }).click();
  await page.getByLabel("More dashboard options").click();
  for (const url of ["/dashboard?surface=canvas", "/dashboard"]) {
    await page.goto(url);
    await expect(page.getByTitle("Switch workspace layout")).toContainText("Work with maps");
    await expect(page.locator('[data-pane-key^="view:"]')).toHaveCount(4);
    await page.setViewportSize({ width: 390, height: 844 });
    const tabs = page.getByRole("navigation", { name: "Dashboard panes" });
    await tabs.getByRole("button", { name: "World 4", exact: true }).click();
    await expect(
      panel(page, "view:worldmap:4").getByLabel("World map", { exact: true }),
    ).toBeVisible();
    await tabs.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(page.getByPlaceholder("Enter your name...")).toBeVisible();
    await expect(
      panel(page, "view:worldmap:4").getByLabel("World map", { exact: true }),
    ).toBeHidden();
    if (url.includes("surface=canvas")) {
      await tabs.getByRole("button", { name: "World 4", exact: true }).click();
      await panel(page, "view:worldmap:4")
        .getByRole("button", { name: "Close World 4 view" })
        .click();
      await panel(page, "workspace").getByRole("button", { name: "Open map below" }).click();
      await expect(
        panel(page, "view:worldmap:4").getByLabel("World map", { exact: true }),
      ).toBeVisible();
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("navigation", { name: "Dashboard panes" })
    .getByRole("button", { name: "World 4", exact: true })
    .click();
  await panel(page, "view:worldmap:4").getByRole("button", { name: "Close World 4 view" }).click();
  await expect(page.getByRole("tab", { name: "Map", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-pane-key^="view:"]')).toHaveCount(3);
});

test("a saved view cannot duplicate an unqualified Chat component", async ({ page }) => {
  await page.addInitScript(() => {
    const layouts = {
      lg: [
        { i: "webchat", x: 0, y: 0, w: 6, h: 12 },
        { i: "workspace", x: 6, y: 0, w: 9, h: 6 },
        { i: "view:webchat:1", x: 6, y: 6, w: 9, h: 6 },
        { i: "context", x: 15, y: 0, w: 5, h: 12 },
      ],
    };
    localStorage.setItem(
      "marina-dashboard-layout-presets-v1",
      JSON.stringify({
        activeId: "unqualified",
        presets: [
          { id: "unqualified", name: "Unqualified copy", layouts, createdAt: 1, updatedAt: 1 },
        ],
      }),
    );
  });
  await page.goto("/dashboard?surface=canvas");
  await expect(page.locator("#marina-name-input")).toHaveCount(1);
  await expect(
    panel(page, "view:webchat:1").getByText("Unavailable panel", { exact: true }),
  ).toBeVisible();
  await panel(page, "view:webchat:1")
    .getByRole("button", { name: "Close Unavailable panel view" })
    .click();
  await expect(panel(page, "view:webchat:1")).toHaveCount(0);
});
