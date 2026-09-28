// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test("login orients the resident before inline discovery, note helpers and sidebar context", async ({
  page,
}) => {
  const commands: string[] = [];
  const arrival: string[] = [];
  let manifestBytes = 0;
  let confirmedBytes = 0;
  page.on("websocket", (socket) => {
    socket.on("framesent", (frame) => {
      const message = JSON.parse(String(frame.payload));
      if (message.type === "command") commands.push(message.command);
    });
    socket.on("framereceived", (frame) => {
      const message = JSON.parse(String(frame.payload));
      const output = String(message.data?.text ?? "");
      if (output.includes("Workbench") && output.includes("Exits:")) arrival.push("look");
      if (output.includes("You think, therefore you are here.")) {
        arrival.push("brief");
      }
      if (message.data?.onboarding?.schema === "marina.onboarding.v1") arrival.push("onboarding");
      const catalog = message.data?.capabilities;
      if (catalog?.commands) manifestBytes = Buffer.byteLength(String(frame.payload));
      if (catalog?.unchanged) confirmedBytes = Buffer.byteLength(String(frame.payload));
    });
  });
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Dismiss getting-started guide" }).click();
  await page.getByPlaceholder("Enter your name...").fill("InlineAuditBrowser");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const input = page.locator("#marina-command-input");
  await expect.poll(() => arrival).toContain("onboarding");
  expect(arrival.indexOf("look")).toBeGreaterThanOrEqual(0);
  expect(arrival.indexOf("brief")).toBeGreaterThan(arrival.indexOf("look"));
  expect(arrival.indexOf("onboarding")).toBeGreaterThan(arrival.indexOf("brief"));
  await input.fill("/mem");
  await expect(page.getByRole("listbox", { name: "Command suggestions" })).toContainText("memory");
  await input.press("Tab");
  await expect(input).toHaveValue("memory ");
  await input.fill("note claim ");
  await expect(page.getByLabel("Command action")).toHaveValue(/note claim .*observed/);
  await page.getByLabel("Text", { exact: true }).fill("opal inline observation");
  await page.getByLabel("Include confidence:0..1").check();
  await page.getByLabel("Confidence", { exact: true }).fill("0.8");
  await page.getByRole("button", { name: "Fill command", exact: true }).click();
  expect(commands).toEqual([]);
  await input.press("Enter");
  await expect.poll(() => commands).toEqual(["note claim opal inline observation confidence:0.8"]);
  await expect(input).toHaveValue("");
  const sidebar = page.getByRole("region", { name: "My memory context", exact: true });
  await sidebar.getByText("My memory context", { exact: true }).click();
  await sidebar.getByLabel("Query", { exact: true }).fill("opal");
  await sidebar.getByRole("button", { name: "Refresh context" }).click();
  await sidebar.getByText(/\[unverified\] 1 items/).click();
  await expect(sidebar.getByText("opal inline observation", { exact: true })).toBeVisible();
  await page.screenshot({ path: "/tmp/marina-sidebar-context.png", fullPage: true });
  await input.fill("note verify 51 verified");
  await expect(page.getByLabel("Command action")).toHaveValue(/note verify .* verified /);
  // Choosing a helper changes the draft only; no verification is submitted here.
  expect(commands).toHaveLength(1);
  await input.fill("/look");
  await input.press("Enter");
  await expect.poll(() => commands.at(-1)).toBe("look");
  await expect.poll(() => confirmedBytes).toBeGreaterThan(0);
  expect(confirmedBytes).toBeLessThan(manifestBytes / 10);
  writeFileSync(
    "/tmp/marina-followup-discovery-bytes.json",
    JSON.stringify({ manifestBytes, confirmedBytes }),
  );
  await test.info().attach("discovery-payload-sizes", {
    body: JSON.stringify({ manifestBytes, confirmedBytes }),
    contentType: "application/json",
  });
});

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
