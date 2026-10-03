// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

test("published panel opens beside work, preserves independent drafts and restores its exact target", async ({
  page,
}, testInfo) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/dashboard?surface=canvas");
  await page.getByRole("button", { name: "Dismiss getting-started guide" }).click();
  await page.getByPlaceholder("Enter your name...").fill("PublishedPanelResident");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const input = page.locator("#marina-command-input");
  await expect(input).toBeVisible();
  await input.fill("Keep this coding conversation draft");
  const published = await page.evaluate(async () => {
    const headers = {
      Authorization: `Bearer ${localStorage.getItem("marina_chat_token")}`,
      "Content-Type": "application/json",
    };
    const canvas = await (
      await fetch("/api/canvases", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Project publications" }),
      })
    ).json();
    const node = await (
      await fetch(`/api/canvases/${canvas.id}/nodes`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          type: "a2ui",
          data: {
            title: "Live project panel",
            components: [
              { id: "root", component: "Column", children: ["status", "draft", "save"] },
              { id: "status", component: "Text", text: "Ready for review" },
              { id: "draft", component: "TextField", label: "Panel comment" },
              {
                id: "save",
                component: "Button",
                label: "Notify",
                action: { event: { name: "review" } },
              },
            ],
          },
        }),
      })
    ).json();
    return { canvasId: canvas.id, nodeId: node.id };
  });
  await page.getByRole("tab", { name: "Canvas", exact: true }).click();
  await page.getByRole("button", { name: "Published panels", exact: true }).click();
  const library = page.getByRole("region", { name: "Published panels" });
  await library
    .getByRole("combobox", { name: "Canvas", exact: true })
    .selectOption(published.canvasId);
  await library.getByRole("button", { name: "Open beside my work" }).click();
  const first = page.locator('[data-pane-key="view:published:1"]');
  await expect(first.getByText("Ready for review", { exact: true })).toBeVisible();
  await first.getByLabel("Panel comment").fill("First panel draft");
  await first.getByRole("button", { name: "Open as panel", exact: true }).click();
  const second = page.locator('[data-pane-key="view:published:2"]');
  await expect(second.getByLabel("Panel comment")).toHaveValue("");
  await expect(first.getByLabel("Panel comment")).toHaveValue("First panel draft");
  await expect(input).toHaveValue("Keep this coding conversation draft");
  await second.getByRole("button", { name: "Notify", exact: true }).click();
  await expect(second.getByText("Interaction saved.", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("published-panels-desktop.png") });
  await page.getByLabel("More dashboard options").click();
  page.once("dialog", (dialog) => dialog.accept("Published project"));
  await page.getByRole("button", { name: "Save layout preset", exact: true }).click();
  await page.goto("/dashboard");
  await expect(
    page
      .locator('[data-pane-key="view:published:1"]')
      .getByText("Ready for review", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("navigation", { name: "Dashboard panes" })
    .getByRole("button", { name: "Published panel 1", exact: true })
    .click();
  await expect(
    page.locator('[data-pane-key="view:published:1"]').getByLabel("Panel comment"),
  ).toBeVisible();
  const tabsDoNotOverlap = await page
    .getByRole("navigation", { name: "Dashboard panes" })
    .evaluate((nav) => {
      const boxes = [...nav.querySelectorAll("button")].map((button) =>
        button.getBoundingClientRect(),
      );
      return boxes.every((box, i) => i === 0 || boxes[i - 1]!.right <= box.left + 1);
    });
  expect(tabsDoNotOverlap).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("published-panels-phone.png") });
});
