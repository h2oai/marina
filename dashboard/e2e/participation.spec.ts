// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

test("inline completion drafts a command and the resident previews, corrects and refreshes memory", async ({
  page,
}) => {
  const commands: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("websocket", (socket) =>
    socket.on("framesent", (frame) => {
      const message = JSON.parse(String(frame.payload));
      if (message.type === "command") commands.push(message.command);
    }),
  );
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Dismiss getting-started guide" }).click();
  await page.getByPlaceholder("Enter your name...").fill("ParticipationBrowser");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const input = page.locator("#marina-command-input");
  await expect(input).toBeVisible();
  await input.fill("reca");
  await expect(page.getByRole("listbox", { name: "Command suggestions" })).toContainText("recall");
  await input.press("Tab");
  await expect(input).toHaveValue("recall ");
  expect(commands).toEqual([]);
  await input.fill("note quartz participation assertion");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await page.getByRole("button", { name: "Memory context", exact: true }).click();
  const workspace = page.getByRole("complementary", { name: "Memory workspace" });
  await expect(
    workspace.getByRole("heading", { name: "Your memory context preview" }),
  ).toBeVisible();
  await workspace.getByLabel("Query", { exact: true }).fill("quartz");
  await workspace.getByRole("button", { name: "Refresh context" }).click();
  await workspace.getByText(/\[unverified\] 1 items/).click();
  await expect(
    workspace.getByText("quartz participation assertion", { exact: true }),
  ).toBeVisible();
  await workspace.getByRole("button", { name: "Inspect or correct memory" }).click();
  await expect(workspace.getByText("Revision 1 of 1")).toBeVisible();
  await workspace.getByText("Correct this memory", { exact: true }).click();
  await workspace.getByLabel("Corrected content").fill("quartz corrected participation assertion");
  await workspace.getByRole("button", { name: "Save correction" }).click();
  await expect(workspace.getByText("Revision 2 of 2")).toBeVisible();
  await workspace.getByRole("button", { name: "Context preview", exact: true }).click();
  await workspace.getByLabel("Query", { exact: true }).fill("quartz");
  await workspace.getByRole("button", { name: "Refresh context" }).click();
  await workspace.getByText(/\[unverified\] 1 items/).click();
  await expect(
    workspace.getByText("quartz corrected participation assertion", { exact: true }),
  ).toBeVisible();
  await expect(workspace.getByText("quartz participation assertion", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText(/"legacy_note_id":/)).toHaveCount(0);
  await page.screenshot({ path: "/tmp/marina-participation-context.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("standalone chat discovers the same live command names", async ({ page }) => {
  await page.goto("/chat");
  await page.locator("#name-input").fill("StandaloneBrowser");
  await page.locator("#login-btn").click();
  await expect(page.getByLabel("World command")).toBeVisible();
  await expect.poll(() => page.locator('#command-options option[value="context"]').count()).toBe(1);
});
