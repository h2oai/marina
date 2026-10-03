// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

async function openWorkspace(page: Page, preview: boolean) {
  await page.goto(`/dashboard${preview ? "?surface=canvas" : ""}`);
  await page.getByRole("button", { name: "Dismiss getting-started guide" }).click();
  await expect(page.getByRole("complementary", { name: "Getting started" })).toBeHidden();
  if ((page.viewportSize()?.width ?? 1440) < 800) {
    await page
      .getByRole("navigation", { name: "Dashboard panes" })
      .getByRole("button", { name: "Chat", exact: true })
      .click();
  }
  await expect(page.getByPlaceholder("Enter your name...")).toBeVisible();
  if (preview) await expect(page.getByLabel("Workspace panels", { exact: true })).toBeVisible();
}

async function geometry(page: Page) {
  return page.locator("[data-pane-key]").evaluateAll((elements) =>
    elements.map((element) => {
      const panel = element.querySelector(".glass-panel")!;
      const rect = panel.getBoundingClientRect();
      const style = getComputedStyle(panel);
      const title = panel.querySelector("h2")!;
      const titleStyle = getComputedStyle(title);
      return {
        id: element.getAttribute("data-pane-key"),
        box: [rect.x, rect.y, rect.width, rect.height].map(Math.round),
        background: style.backgroundColor,
        border: style.border,
        radius: style.borderRadius,
        title: title.textContent,
        font: titleStyle.font,
        color: titleStyle.color,
      };
    }),
  );
}

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
]) {
  test(`Default workspace and former preview links share geometry and chrome at ${viewport.width}px`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
    const grid = await context.newPage();
    const canvas = await context.newPage();
    try {
      await openWorkspace(grid, false);
      // Dismissing the guide is persisted, so reset it for the second page.
      await canvas.goto("/dashboard?surface=canvas");
      await expect(canvas.locator("[data-workspace-surface=canvas]")).toBeVisible();
      if (viewport.width < 800) {
        await canvas
          .getByRole("navigation", { name: "Dashboard panes" })
          .getByRole("button", { name: "Chat", exact: true })
          .click();
      }
      await expect(canvas.getByPlaceholder("Enter your name...")).toBeVisible();
      for (const colorScheme of ["light", "dark"] as const) {
        await grid.emulateMedia({ colorScheme });
        await canvas.emulateMedia({ colorScheme });
        await expect(grid.locator("html")).toHaveAttribute("data-theme-scheme", colorScheme);
        await expect(canvas.locator("html")).toHaveAttribute("data-theme-scheme", colorScheme);
        await expect
          .poll(
            async () =>
              JSON.stringify(await geometry(canvas)) === JSON.stringify(await geometry(grid)),
          )
          .toBe(true);
        await grid.mouse.move(0, 0);
        await canvas.mouse.move(0, 0);
        for (const [name, page] of [
          ["grid", grid],
          ["canvas", canvas],
        ] as const) {
          const path = test.info().outputPath(`${name}-${viewport.width}-${colorScheme}.png`);
          await page.screenshot({ path });
          await test.info().attach(`${name}-${colorScheme}`, { path, contentType: "image/png" });
        }
      }
    } finally {
      await context.close();
    }
  });
}

test("Canvas layout edits preserve one chat connection, drafts, focus and saved grid presets", async ({
  page,
  browser,
}) => {
  const sockets: string[] = [];
  const commands: string[] = [];
  const errors: string[] = [];
  const mutations: string[] = [];
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
  await openWorkspace(page, true);
  await page
    .getByText("Welcome to Marina. Enter your name to begin.", { exact: true })
    .click({ clickCount: 3 });
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toContain("Welcome to Marina");
  await page.getByPlaceholder("Enter your name...").fill("CanvasHostBrowser");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const input = page.locator("#marina-command-input");
  await expect(input).toBeVisible();
  await input.fill("Keep this unsent draft");
  // Login replaces the anonymous observer with a credential-bound dashboard
  // subscription; layout edits must not create further sockets or resident logins.
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
  // Tag the DOM element itself: preserving text in a remounted input is insufficient.
  await input.evaluate((element) => element.setAttribute("data-mount-proof", "retained"));
  // `geometry()` reads the panel border, which `.glass-panel:hover` changes. Park the
  // pointer off every panel before each comparison: after Maximize/Restore it would
  // otherwise rest over whichever panel moved under it, and Chromium re-evaluates
  // :hover after a layout change asynchronously.
  await page.mouse.move(0, 0);
  const before = await geometry(page);
  await page.getByRole("button", { name: "Maximize Web Chat panel" }).click();
  await expect.poll(async () => (await geometry(page))[0].box[2]).toBeGreaterThan(before[0].box[2]);
  await page.getByRole("button", { name: "Restore Web Chat panel" }).click();
  await page.mouse.move(0, 0);
  await expect.poll(() => geometry(page)).toEqual(before);
  const handle = page.locator('[data-pane-key="webchat"] > .workspace-panel-resize');
  const bounds = (await handle.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x - 70, bounds.y - 170, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await geometry(page))[0].box[3]).toBeLessThan(before[0].box[3]);
  await expect(input).toHaveValue("Keep this unsent draft");
  await expect(input).toHaveAttribute("data-mount-proof", "retained");
  // Moving a panel must reuse the same input instance too.
  const chatHeader = page.locator('[data-pane-key="webchat"] > .glass-panel > .drag-handle');
  const headerBox = (await chatHeader.boundingBox())!;
  const chatBeforeMove = (await geometry(page))[0].box;
  await page.mouse.move(headerBox.x + 100, headerBox.y + headerBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(headerBox.x + 240, headerBox.y + headerBox.height / 2, { steps: 12 });
  const draggingBox = (await geometry(page))[0].box;
  // Another resident arrives while this user is arranging their workspace.
  // Live data must update without resetting the in-progress drag.
  const peer = await browser.newPage();
  try {
    await peer.goto("/chat");
    await peer.locator("#name-input").fill("CanvasLivePeer");
    await peer.locator("#login-btn").click();
    await expect(
      page.locator('[data-pane-key="context"]').getByText("CanvasLivePeer", { exact: true }),
    ).toBeVisible();
    await expect.poll(async () => (await geometry(page))[0].box).toEqual(draggingBox);
  } finally {
    await peer.close();
  }
  await page.mouse.up();
  await expect
    .poll(async () => (await geometry(page))[0].box[0])
    .toBeGreaterThan(chatBeforeMove[0]);
  await expect(input).toHaveAttribute("data-mount-proof", "retained");
  // Save with the existing UI, then prove the standard grid reads the same preset.
  await page.getByLabel("More dashboard options").click();
  page.once("dialog", (dialog) => dialog.accept("Canvas parity arrangement"));
  await page.getByRole("button", { name: "Save layout preset", exact: true }).click();
  await page.getByLabel("More dashboard options").click();
  const savedGeometry = await geometry(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const panes = page.getByRole("navigation", { name: "Dashboard panes" });
  await panes.getByRole("button", { name: "Context", exact: true }).click();
  await expect(input).toBeHidden();
  await panes.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute("data-mount-proof", "retained");
  await expect(input).toHaveValue("Keep this unsent draft");
  expect(sockets).toEqual(initialSockets);
  expect(mutations).toEqual(initialMutations);
  expect(commands).toEqual([]);
  await input.fill("look");
  await input.press("Enter");
  await expect.poll(() => commands).toEqual(["look"]);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/dashboard");
  await expect(page.getByTitle("Switch workspace layout")).toContainText(
    "Canvas parity arrangement",
  );
  await expect.poll(() => geometry(page)).toEqual(savedGeometry);
  await expect(page.locator("[data-workspace-surface=canvas]")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("Canvas panel host retains accessible controls on desktop and phone", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openWorkspace(page, true);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(
      results.violations.map(({ id, nodes }) => ({
        id,
        targets: nodes.map((node) => node.target),
      })),
    ).toEqual([]);
  }
});

test("touch scrolling stays inside panel content on phones and tablets", async ({ browser }) => {
  for (const width of [390, 1024]) {
    const context = await browser.newContext({
      viewport: { width, height: 700 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      const page = await context.newPage();
      await openWorkspace(page, true);
      if (width < 800) {
        await page
          .getByRole("navigation", { name: "Dashboard panes" })
          .getByRole("button", { name: "Workspace", exact: true })
          .click();
      }
      const scroller = page
        .getByRole("complementary", { name: "Work overview" })
        .locator(":scope > .overflow-y-auto");
      await expect
        .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight))
        .toBeGreaterThan(100);
      const rect = (await scroller.boundingBox())!;
      const initial = await geometry(page);
      const session = await context.newCDPSession(page);
      const x = rect.x + 8;
      const y = rect.y + rect.height - 50;
      await session.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y }],
      });
      for (let step = 1; step <= 12; step++) {
        await session.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x, y: y - step * 18 }],
        });
      }
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect
        .poll(() => scroller.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(30);
      expect(await geometry(page)).toEqual(initial);
    } finally {
      await context.close();
    }
  }
});

test("older grid presets remain usable and changing presets keeps the chat mounted", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const ids = [
      "webchat",
      "insights",
      "worldmap",
      "coordination",
      "entities",
      "playback",
      "room",
      "admin",
    ];
    const layouts = Object.fromEntries(
      ["lg", "md"].map((bp) => [
        bp,
        ids.map((id, index) => ({
          i: id,
          x: (index % 3) * (bp === "lg" ? 4 : 3),
          y: Math.floor(index / 3) * 4,
          w: bp === "lg" ? 4 : 3,
          h: 4,
        })),
      ]),
    );
    localStorage.setItem(
      "marina-dashboard-layout-presets-v1",
      JSON.stringify({
        activeId: "classic-test",
        presets: [
          { id: "classic-test", name: "Previous grid", layouts, createdAt: 0, updatedAt: 0 },
        ],
      }),
    );
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openWorkspace(page, true);
  await expect(page.locator(".legacy-grid [data-pane-key]")).toHaveCount(8);
  await page.getByPlaceholder("Enter your name...").fill("ClassicCanvas");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const input = page.locator("#marina-command-input");
  await input.fill("Retain across classic and current layouts");
  await input.evaluate((element) => element.setAttribute("data-mount-proof", "classic"));
  await page.getByTitle("Switch workspace layout").selectOption("default");
  await expect(page.locator(".workspace-grid [data-pane-key]")).toHaveCount(3);
  await expect(input).toHaveValue("Retain across classic and current layouts");
  await expect(input).toHaveAttribute("data-mount-proof", "classic");
  await page.getByTitle("Switch workspace layout").selectOption("classic-test");
  await expect(page.locator(".legacy-grid [data-pane-key]")).toHaveCount(8);
  await expect(input).toHaveValue("Retain across classic and current layouts");
  await expect(input).toHaveAttribute("data-mount-proof", "classic");
});
