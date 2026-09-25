// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test";

test("participant output and delivery receipts remain visible alongside native chat", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/dashboard?view=streams");
  await page.getByRole("button", { name: "Dismiss getting-started guide" }).click();
  await page.getByPlaceholder("Enter your name...").fill("RoutingBrowser");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const input = page.locator("#marina-command-input");
  await expect(input).toBeVisible();
  const token = await page.evaluate(() => localStorage.getItem("marina_chat_token"));
  const headers = { Authorization: `Bearer ${token}` };
  const register = async (clientKey: string, label: string) => {
    const response = await request.post("/api/routing/sessions", {
      headers,
      data: { clientKey, label, kind: "service" },
    });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const a = await register("build", "Build worker");
  const b = await register("review", "Review worker");
  const publish = await request.post(`/api/routing/sessions/${a.id}/events`, {
    headers,
    data: {
      events: [{ id: "build-1", kind: "output", payload: { text: "Build and checks succeeded." } }],
    },
  });
  expect(publish.ok()).toBe(true);
  const sent = await request.post(`/api/routing/sessions/${a.id}/messages`, {
    headers,
    data: {
      clientMessageId: "review-1",
      targetId: b.id,
      kind: "note",
      payload: { text: "Please review the change." },
    },
  });
  expect(sent.ok()).toBe(true);
  const message = await sent.json();
  await expect(page.getByRole("tab", { name: "Streams", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("button", { name: /Build worker/ }).click();
  await expect(page.getByText("Build and checks succeeded.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Inspect deliveries and conversations" }).click();
  const log = page.getByRole("region", { name: "Participant delivery log" });
  await expect(log).toContainText("Sent · queued · note");
  await expect(log).toContainText(message.id);
  const ack = await request.post(`/api/routing/sessions/${b.id}/messages/${message.id}/ack`, {
    headers,
  });
  expect(ack.ok()).toBe(true);
  await expect(log).toContainText("Sent · acknowledged · note");
  await input.fill("Draft survives stream inspection");
  await page.screenshot({ path: "/tmp/marina-participant-streams.png" });
  await page.getByRole("tab", { name: "Canvas", exact: true }).click();
  await expect(input).toHaveValue("Draft survives stream inspection");
  await page.getByRole("tab", { name: "Streams", exact: true }).click();
  await page.getByRole("button", { name: /Build worker/ }).click();
  await expect(page.getByText("Build and checks succeeded.", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("navigation", { name: "Dashboard panes" })
    .getByRole("button", { name: "Workspace", exact: true })
    .click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: "/tmp/marina-participant-streams-mobile.png" });
  expect(errors).toEqual([]);
});

test("operator can launch and answer native approvals through participant controls", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/dashboard?view=streams");
  await page.getByRole("button", { name: "Dismiss getting-started guide" }).click();
  await page.getByPlaceholder("Enter your name...").fill("RuntimeBrowser");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("#marina-command-input")).toBeVisible();
  const token = await page.evaluate(() => localStorage.getItem("marina_chat_token"));
  const headers = { Authorization: `Bearer ${token}` };
  const registration = await request.post("/api/routing/sessions", {
    headers,
    data: {
      clientKey: "runtime-browser",
      label: "Local supervisor",
      kind: "supervisor",
      capabilities: ["runtime.control"],
    },
  });
  const supervisor = await registration.json();
  const publish = async (id: string, state: object) => {
    const response = await request.post(`/api/routing/sessions/${id}/events`, {
      headers,
      data: { events: [{ id: crypto.randomUUID(), kind: "runtime.state", payload: state }] },
    });
    expect(response.ok()).toBe(true);
  };
  const state = {
    version: 1,
    role: "supervisor",
    mode: "managed",
    status: "idle",
    adapter: "supervisor",
    supervisorId: supervisor.id,
    cwd: "/project",
    updatedAt: Date.now(),
    adapters: [{ id: "fixture", label: "Test adapter" }],
  };
  await publish(supervisor.id, state);
  await page.getByRole("button", { name: /Local supervisor/ }).click();
  await page.getByLabel("Agent name").fill("Reviewer");
  await page.getByLabel("Initial agent task").fill("Review the change");
  await page.getByRole("button", { name: "Launch agent" }).click();
  await expect(page.getByText(/Queued ·/)).toBeVisible();
  const inbox = await (
    await request.get(`/api/routing/sessions/${supervisor.id}/inbox`, { headers })
  ).json();
  expect(inbox.messages[0].payload).toMatchObject({
    action: "launch",
    adapter: "fixture",
    workspace: "worktree",
    label: "Reviewer",
  });
  await page.screenshot({ path: "/tmp/marina-supervisor-launch.png" });
  const agent = await (
    await request.post("/api/routing/sessions", {
      headers,
      data: {
        clientKey: "runtime-worker",
        label: "Reviewer",
        kind: "fixture",
        capabilities: ["runtime.control"],
      },
    })
  ).json();
  await publish(agent.id, {
    ...state,
    role: "agent",
    status: "waiting",
    nativeSessionId: "native-review",
    request: {
      id: "approval-test",
      kind: "permission",
      title: "Run review tests?",
      input: { command: "bun test" },
    },
  });
  await page.getByRole("button", { name: /^Reviewer/ }).click();
  await expect(page.getByText("Run review tests?", { exact: true })).toBeVisible();
  await page.screenshot({ path: "/tmp/marina-agent-approval.png" });
  await page.getByRole("button", { name: "Decline", exact: true }).click();
  await expect(page.getByText(/Queued ·/)).toBeVisible();
  const decision = await (
    await request.get(`/api/routing/sessions/${agent.id}/inbox`, { headers })
  ).json();
  expect(decision.messages[0].payload).toEqual({
    action: "respond",
    requestId: "approval-test",
    allow: false,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("navigation", { name: "Dashboard panes" })
    .getByRole("button", { name: "Workspace", exact: true })
    .click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await expect
    .poll(async () => (await page.getByRole("region", { name: "Agent controls" }).boundingBox())?.x)
    .toBeLessThan(30);
  await page.screenshot({ path: "/tmp/marina-agent-approval-mobile.png" });
});
