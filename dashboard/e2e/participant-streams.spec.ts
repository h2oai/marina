// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("independent Streams tiles keep agent output and controls beside work without owning the sessions", async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  const sockets: string[] = [];
  const commands: string[] = [];
  const writes: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (req) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method()))
      writes.push(new URL(req.url()).pathname);
  });
  page.on("websocket", (socket) => {
    sockets.push(new URL(socket.url()).pathname);
    socket.on("framesent", (frame) => {
      const message = JSON.parse(String(frame.payload));
      if (message.type === "command") commands.push(message.command);
    });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/dashboard?surface=canvas&view=streams");
  await page.getByRole("button", { name: "Dismiss getting-started guide" }).click();
  await page.getByPlaceholder("Enter your name...").fill("StreamTilesResident");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const input = page.locator("#marina-command-input");
  await expect(input).toBeVisible();
  await input.fill("Keep this world-chat draft");
  await input.evaluate((element) => element.setAttribute("data-mount-proof", "retained"));
  const token = await page.evaluate(() => localStorage.getItem("marina_chat_token"));
  const headers = { Authorization: `Bearer ${token}` };
  async function publish(id: string, kind: string, payload: object) {
    const response = await request.post(`/api/routing/sessions/${id}/events`, {
      headers,
      data: { events: [{ id: crypto.randomUUID(), kind, payload }] },
    });
    expect(response.ok()).toBe(true);
  }
  async function register(clientKey: string, label: string) {
    const response = await request.post("/api/routing/sessions", {
      headers,
      data: { clientKey, label, kind: "service", capabilities: ["runtime.control"] },
    });
    expect(response.ok()).toBe(true);
    const session = await response.json();
    await publish(session.id, "runtime.state", {
      version: 1,
      role: "agent",
      mode: "managed",
      status: "idle",
      adapter: "service",
      supervisorId: "fixture",
      cwd: "/project",
      updatedAt: Date.now(),
    });
    return session;
  }
  const build = await register("tile-build", "Tile build worker");
  const review = await register("tile-review", "Tile review worker");
  await publish(build.id, "output", { text: "Build work is in progress." });
  await publish(review.id, "output", { text: "Review work is in progress." });
  const workspace = page.locator('[data-pane-key="workspace"]');
  await workspace.getByRole("button", { name: /Tile build worker/ }).click();
  const mainDraft = workspace.getByLabel("Message agent");
  await mainDraft.fill("Keep the build draft");
  await workspace.getByRole("button", { name: "Open streams below" }).click();
  const copy = page.locator('[data-pane-key="view:streams:1"]');
  await expect(copy).toBeVisible();
  await copy.getByRole("button", { name: /Tile review worker/ }).click();
  await copy.getByLabel("Filter this participant page").fill("review");
  await expect(workspace.getByLabel("Filter this participant page")).toHaveValue("");
  await expect(mainDraft).toHaveValue("Keep the build draft");
  const copyDraft = copy.getByLabel("Message agent");
  await copyDraft.fill("Check the isolated review target");
  await copyDraft.evaluate((element) => element.setAttribute("data-mount-proof", "retained"));
  await page.getByRole("tab", { name: "Work", exact: true }).click();
  await publish(review.id, "output", { text: "Review continues while you work elsewhere." });
  await expect(
    copy.getByText("Review continues while you work elsewhere.", { exact: true }),
  ).toBeVisible();
  await copy.getByRole("button", { name: "Send", exact: true }).click();
  await expect(copy.getByText(/Queued ·/)).toBeVisible();
  const inbox = await (
    await request.get(`/api/routing/sessions/${review.id}/inbox`, { headers })
  ).json();
  expect(inbox.messages).toHaveLength(1);
  expect(inbox.messages[0].payload).toEqual({
    action: "prompt",
    text: "Check the isolated review target",
  });
  expect(
    (await (await request.get(`/api/routing/sessions/${build.id}/inbox`, { headers })).json())
      .messages,
  ).toHaveLength(0);
  await copyDraft.fill("Keep this next review draft");
  await copy.getByRole("button", { name: "Maximize Streams 1 panel" }).click();
  await copy.getByRole("button", { name: "Restore Streams 1 panel" }).click();
  await expect(copyDraft).toHaveAttribute("data-mount-proof", "retained");
  // Resize within a wide browser: the sidebar must follow the tile's width.
  const resize = await copy.locator(":scope > .workspace-panel-resize").boundingBox();
  await page.mouse.move(resize!.x + resize!.width / 2, resize!.y + resize!.height / 2);
  await page.mouse.down();
  await page.mouse.move(resize!.x - 280, resize!.y + resize!.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect
    .poll(() =>
      copy
        .locator(".participant-streams-layout")
        .evaluate((element) => getComputedStyle(element).flexDirection),
    )
    .toBe("column");
  await expect(copyDraft).toHaveValue("Keep this next review draft");
  await expect.poll(async () => (await copyDraft.boundingBox())!.width).toBeGreaterThan(150);
  await expect
    .poll(
      async () =>
        (await copy.getByRole("region", { name: "Published output" }).boundingBox())!.height,
    )
    .toBeGreaterThanOrEqual(96);
  await copy.getByRole("button", { name: "Maximize Streams 1 panel" }).click();
  await expect
    .poll(() =>
      copy
        .locator(".participant-streams-layout")
        .evaluate((element) => getComputedStyle(element).flexDirection),
    )
    .toBe("row");
  const violations = (
    await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze()
  ).violations;
  expect(
    violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })),
  ).toEqual([]);
  const path = test.info().outputPath("work-with-participant-stream.png");
  await page.screenshot({ path });
  await test.info().attach("Work alongside a participant", { path, contentType: "image/png" });
  await page.setViewportSize({ width: 390, height: 844 });
  const panes = page.getByRole("navigation", { name: "Dashboard panes" });
  await panes.getByRole("button", { name: "Streams 1", exact: true }).click();
  await expect(copyDraft).toHaveValue("Keep this next review draft");
  await panes.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(input).toBeVisible();
  await expect(copyDraft).toBeHidden();
  await expect(input).toHaveValue("Keep this world-chat draft");
  await panes.getByRole("button", { name: "Streams 1", exact: true }).click();
  await expect(copyDraft).toHaveAttribute("data-mount-proof", "retained");
  await expect(copyDraft).toHaveValue("Keep this next review draft");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await copy.getByRole("button", { name: "Close Streams 1 view" }).click();
  await expect(copy).toHaveCount(0);
  await page.getByRole("tab", { name: "Streams", exact: true }).click();
  await expect(mainDraft).toHaveValue("Keep the build draft");
  const session = await (
    await request.get(`/api/routing/sessions/${review.id}`, { headers })
  ).json();
  expect(session.state).toBe("active");
  await publish(review.id, "output", { text: "Publishing still works after the view closes." });
  expect(writes).toEqual([`/api/routing/sessions/${review.id}/control`]);
  // Anonymous observation is replaced once at login with the resident credential.
  expect(sockets.sort()).toEqual(["/dashboard-ws", "/dashboard-ws", "/ws"]);
  expect(commands).toEqual([]);
  await panes.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(input).toHaveAttribute("data-mount-proof", "retained");
  await input.fill("look");
  await input.press("Enter");
  await expect.poll(() => commands).toEqual(["look"]);
  expect(errors).toEqual([]);
});

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
  const register = async (clientKey: string, label: string, kind = "service") => {
    const response = await request.post("/api/routing/sessions", {
      headers,
      data: { clientKey, label, kind },
    });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const a = await register("build", "Build worker", "codex");
  const b = await register("review", "Review worker");
  const publish = await request.post(`/api/routing/sessions/${a.id}/events`, {
    headers,
    data: {
      events: [
        {
          id: "build-1",
          kind: "output",
          payload: {
            text: "Build and checks ",
            method: "item/agentMessage/delta",
            itemId: "build",
          },
        },
        {
          id: "build-2",
          kind: "output",
          payload: { text: "succeeded.", method: "item/agentMessage/delta", itemId: "build" },
        },
      ],
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
  await page.getByText("Inspect source events (2)", { exact: true }).click();
  await expect(page.getByText(/"id": "build-2"/)).toBeVisible();
  await page.getByText("Inspect source events (2)", { exact: true }).click();
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
  await expect(page.getByRole("button", { name: /Build worker/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
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
  await page.getByLabel("Message agent").fill("Keep this draft while I inspect Canvas");
  await page.getByRole("tab", { name: "Canvas", exact: true }).click();
  await page.getByRole("tab", { name: "Streams", exact: true }).click();
  await expect(page.getByLabel("Message agent")).toHaveValue(
    "Keep this draft while I inspect Canvas",
  );
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
  await publish(agent.id, {
    ...state,
    role: "agent",
    status: "disconnected",
    nativeSessionId: "native-review",
    resumeSupported: true,
    updatedAt: Date.now(),
  });
  const resume = page.getByRole("button", { name: "Resume native session", exact: true });
  await expect(resume).toBeEnabled();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await resume.click();
  await expect
    .poll(async () => {
      const inbox = await (
        await request.get(`/api/routing/sessions/${agent.id}/inbox`, { headers })
      ).json();
      return inbox.messages
        .filter((message: { payload: { action: string } }) => message.payload.action === "resume")
        .map((message: { payload: unknown }) => message.payload);
    })
    .toEqual([{ action: "resume" }]);
  await expect(page.getByLabel("Message agent")).toHaveValue(
    "Keep this draft while I inspect Canvas",
  );
  await page.screenshot({ path: test.info().outputPath("native-session-recovery.png") });
  const axe = await new AxeBuilder({ page }).include('[aria-label="Agent controls"]').analyze();
  expect(axe.violations).toEqual([]);
});
