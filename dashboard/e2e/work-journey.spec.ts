// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

test("starts native work, follows attention back to an agent, and preserves workspace drafts", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/dashboard?view=work");
  await page.getByRole("button", { name: "Dismiss getting-started guide" }).click();
  await page.getByPlaceholder("Enter your name...").fill("JourneyBrowser");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const input = page.locator("#marina-command-input");
  await expect(input).toBeVisible();
  await input.fill("My chat draft");
  const token = await page.evaluate(() => localStorage.getItem("marina_chat_token"));
  const headers = { Authorization: `Bearer ${token}` };
  const supervisor = await (
    await request.post("/api/routing/sessions", {
      headers,
      data: {
        clientKey: "journey-supervisor",
        label: "Orbit workshop",
        kind: "supervisor",
        capabilities: ["runtime.control"],
      },
    })
  ).json();
  const publish = async (id: string, payload: object) => {
    expect(
      (
        await request.post(`/api/routing/sessions/${id}/events`, {
          headers,
          data: { events: [{ id: crypto.randomUUID(), kind: "runtime.state", payload }] },
        })
      ).ok(),
    ).toBe(true);
  };
  const state = {
    version: 1,
    role: "supervisor",
    status: "idle",
    mode: "managed",
    adapter: "supervisor",
    cwd: "/project",
    supervisorId: supervisor.id,
    updatedAt: Date.now(),
    adapters: [{ id: "fixture", label: "Custom coding tool" }],
  };
  await publish(supervisor.id, state);
  const launch = page.getByRole("region", { name: "Start work" });
  await launch.getByLabel("What would you like to make?").fill("Build a delightful star map");
  await page.screenshot({ path: "/tmp/marina-work-launch-desktop.png" });
  await launch.getByRole("button", { name: "Native agent", exact: true }).click();
  await expect(launch.getByRole("option", { name: "Custom coding tool" })).toBeAttached();
  await launch.getByLabel("Agent name").fill("Comet");
  await launch.getByRole("button", { name: "Start work", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Streams", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(input).toHaveValue("My chat draft");
  const inbox = await (
    await request.get(`/api/routing/sessions/${supervisor.id}/inbox`, { headers })
  ).json();
  expect(inbox.messages).toHaveLength(1);
  expect(inbox.messages[0].payload).toMatchObject({
    action: "launch",
    label: "Comet",
    workspace: "worktree",
    prompt: "Build a delightful star map",
  });

  const agent = await (
    await request.post("/api/routing/sessions", {
      headers,
      data: {
        clientKey: "journey-comet",
        label: "Comet",
        kind: "fixture",
        capabilities: ["runtime.control"],
      },
    })
  ).json();
  await publish(agent.id, {
    ...state,
    role: "agent",
    status: "waiting",
    request: {
      id: "question",
      kind: "question",
      title: "Which constellation should I start with?",
      input: {},
    },
  });
  await page.getByRole("tab", { name: "Work", exact: true }).click();
  await launch.getByRole("button", { name: "Marina", exact: true }).click();
  await launch.getByLabel("What would you like to make?").fill("My next idea");
  await page.getByRole("button", { name: /attention/ }).click();
  const attention = page.getByRole("complementary", { name: "Attention inbox" });
  await expect(attention.getByRole("button", { name: /Which constellation/ })).toBeVisible();
  await page.screenshot({ path: "/tmp/marina-work-attention.png" });
  await attention.getByRole("button", { name: /Which constellation/ }).click();
  await expect(page.getByRole("region", { name: "Agent controls" })).toContainText(
    "Which constellation",
  );
  expect(
    (await (await request.get(`/api/routing/sessions/${agent.id}/inbox`, { headers })).json())
      .messages,
  ).toHaveLength(0);
  await page.getByRole("tab", { name: "Work", exact: true }).click();
  await expect(launch.getByLabel("What would you like to make?")).toHaveValue("My next idea");
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("navigation", { name: "Dashboard panes" })
    .getByRole("button", { name: "Workspace", exact: true })
    .click();
  await expect(launch.getByRole("heading", { name: "Start something." })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/marina-work-launch-mobile.png" });
  await page.emulateMedia({ colorScheme: "light" });
  await page.screenshot({ path: "/tmp/marina-work-launch-mobile-light.png" });
  expect(errors).toEqual([]);
});
