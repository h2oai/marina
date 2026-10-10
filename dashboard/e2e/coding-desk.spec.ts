// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("open a personal coding desk and an authored multi-source publication without launching another worker", async ({
  page,
  request,
}) => {
  const commands: Array<{ command: string; coding_target?: { sessionId: string } }> = [];
  page.on("websocket", (socket) =>
    socket.on("framesent", (frame) => {
      const value = JSON.parse(String(frame.payload));
      if (value.type === "command") commands.push(value);
    }),
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Dismiss getting-started guide" }).click();
  await page.getByPlaceholder("Enter your name...").fill("PersonalDeskResident");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const input = page.locator("#marina-command-input");
  await input.fill("code start Personal development");
  await input.press("Enter");
  const token = await page.evaluate(() => localStorage.getItem("marina_chat_token"));
  const headers = { Authorization: `Bearer ${token}` };
  await expect
    .poll(async () =>
      (await (await request.get("/api/coding/sessions?limit=100", { headers })).json()).items.some(
        (s: { title: string }) => s.title === "Personal development",
      ),
    )
    .toBe(true);
  const session = (
    await (await request.get("/api/coding/sessions?limit=100", { headers })).json()
  ).items.find((s: { title: string }) => s.title === "Personal development");
  await page.getByRole("button", { name: "Refresh work", exact: true }).click();
  await page.getByRole("button", { name: /Personal development/ }).click();
  const desk = page.locator('[data-pane-key="view:coding-desk:1"]');
  await expect(
    desk.getByText(`Repository: ${session.workspace_root}`, { exact: true }),
  ).toBeVisible();
  await desk.getByLabel("Request for coder").fill("Unsent Marina self-development request");
  await desk.getByRole("button", { name: "Review coding request" }).click();
  await expect(desk.getByRole("region", { name: "Review coding request" })).toContainText(
    session.id,
  );
  expect(commands.map((c) => c.command)).toEqual(["code start Personal development"]);

  await desk.getByLabel("Workspace image path").fill("inputs/drawing.png");
  await desk.getByRole("button", { name: "Review image inspection", exact: true }).click();
  const imageReview = desk.getByRole("region", { name: "Review image inspection" });
  await expect(imageReview).toContainText("inputs/drawing.png");
  await expect(imageReview).toContainText(session.id);
  await desk.getByLabel("Delivery manifest path").fill("delivery.json");
  await desk.getByRole("button", { name: "Review delivery check", exact: true }).click();
  const deliveryReview = desk.getByRole("region", { name: "Review delivery check" });
  await expect(deliveryReview).toContainText(session.id);
  await expect(deliveryReview).toContainText("delivery.json");
  await desk.screenshot({ path: test.info().outputPath("delivery-check-review.png") });
  await desk.screenshot({ path: test.info().outputPath("workspace-image-review.png") });
  expect(commands.map((c) => c.command)).toEqual(["code start Personal development"]);

  const catalog = await (await request.get("/api/panel-resources", { headers })).json();
  expect(catalog.resources.map((r: { id: string }) => r.id)).toContain("coding.sessions");
  const canvas = await (
    await request.post("/api/canvases", { headers, data: { name: "Authored development panels" } })
  ).json();
  const created = await request.post(`/api/canvases/${canvas.id}/nodes`, {
    headers,
    data: {
      type: "a2ui",
      data: {
        title: "Composed development",
        sources: {
          coding: {
            kind: "resource",
            resource: "coding.sessions",
            query: { createdBy: "PersonalDeskResident", limit: 25 },
          },
        },
        components: [
          { id: "root", component: "Column", children: ["sessions", "world"] },
          {
            id: "sessions",
            component: "DataTable",
            columns: ["title", "status", "workspace_root"],
            bindings: { rows: { source: "coding", path: ["items"] } },
          },
          {
            id: "world",
            component: "Resource",
            reference: { kind: "resource", resource: "world" },
          },
        ],
      },
    },
  });
  expect(created.status()).toBe(201);
  await page.getByRole("tab", { name: "Canvas", exact: true }).click();
  await page.getByRole("button", { name: "Published panels", exact: true }).click();
  const library = page.getByRole("region", { name: "Published panels" });
  await library.getByText("Compose a panel", { exact: true }).click();
  await library.getByLabel("Find a data source").fill("coding.sessions");
  await expect(library.getByText("coding.sessions", { exact: true })).toBeVisible();
  await library.getByRole("combobox", { name: "Canvas", exact: true }).selectOption(canvas.id);
  await library.getByRole("button", { name: "Open beside my work" }).click();
  const published = page.locator('[data-pane-key="view:published:1"]');
  await expect(
    published.getByRole("cell", { name: "Personal development", exact: true }),
  ).toBeVisible();
  await expect(desk.getByLabel("Request for coder")).toHaveValue(
    "Unsent Marina self-development request",
  );
  await expect(desk.getByRole("region", { name: "Review coding request" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("composed-coding-workspace.png") });
  expect(commands.map((c) => c.command)).toEqual(["code start Personal development"]);
  await desk.getByRole("button", { name: /Close Coding desk/ }).click();
  expect(
    (await (await request.get(`/api/coding/session/${session.id}`, { headers })).json()).session
      .status,
  ).toBe("active");
});

test("publish a coding desk, exchange live output and messages, reconnect and close without stopping work", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let subscriptions = 0;
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname === "/dashboard-ws") subscriptions++;
  });
  // Keep real sockets and servers; close a test handle to prove reconnect.
  await page.addInitScript(() => {
    const sockets: WebSocket[] = [];
    const NativeSocket = WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    };
    Reflect.set(window, "__deskTestSockets", sockets);
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/dashboard?surface=canvas");
  await page.getByRole("button", { name: "Dismiss getting-started guide" }).click();
  await page.getByPlaceholder("Enter your name...").fill("CodingDeskResident");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const input = page.locator("#marina-command-input");
  await expect(input).toBeVisible();
  await input.fill("code start Browser coding desk");
  await input.press("Enter");
  const token = await page.evaluate(() => localStorage.getItem("marina_chat_token"));
  const headers = { Authorization: `Bearer ${token}` };
  await expect
    .poll(async () => {
      const value = await (await request.get("/api/coding/sessions?limit=100", { headers })).json();
      return (
        value.items?.find((s: { title: string }) => s.title === "Browser coding desk")?.id ?? ""
      );
    })
    .not.toBe("");
  // Fetch the canonical ID after the command has finished; the form chooses it explicitly.
  const sessions = await (await request.get("/api/coding/sessions?limit=100", { headers })).json();
  const coding = sessions.items.find((s: { title: string }) => s.title === "Browser coding desk");
  const canvas = await (
    await request.post("/api/canvases", { headers, data: { name: "Coding desk publications" } })
  ).json();
  const peer = await (
    await request.post("/api/routing/sessions", {
      headers,
      data: { clientKey: "desk-peer", kind: "service", label: "Desk peer" },
    })
  ).json();
  await input.fill("Keep my world conversation draft");
  await page.getByRole("tab", { name: "Canvas", exact: true }).click();
  await page.getByRole("button", { name: "Published panels", exact: true }).click();
  const library = page.getByRole("region", { name: "Published panels" });
  await library.getByRole("combobox", { name: "Canvas", exact: true }).selectOption(canvas.id);
  await library.getByRole("button", { name: "Create coding desk" }).click();
  await library.getByLabel("Coding session", { exact: true }).selectOption(coding.id);
  await library.getByLabel("Participant (optional)").selectOption(peer.id);
  await library.getByRole("button", { name: "Publish and open desk" }).click();
  const desk = page.locator('[data-pane-key="view:published:1"]');
  await expect(desk.getByRole("heading", { name: "Browser coding desk" })).toBeVisible();
  await expect(desk.getByLabel("Workspace image path")).toBeVisible();
  await expect(desk.getByLabel("Delivery manifest path")).toBeVisible();
  await desk.getByLabel("Request for coder").fill("Keep the coding request draft");
  await expect(input).toHaveValue("Keep my world conversation draft");
  // A write through the normal participant API must become visible before the 5s recovery poll.
  const output = "Desk peer published fresh output";
  await request.post(`/api/routing/sessions/${peer.id}/events`, {
    headers,
    data: { events: [{ id: crypto.randomUUID(), kind: "output", payload: { text: output } }] },
  });
  await expect(desk.getByText(output, { exact: true })).toBeVisible({ timeout: 3000 });
  await expect(desk.getByLabel("Request for coder")).toHaveValue("Keep the coding request draft");
  await desk.getByLabel("Message to participant").fill("Keep working while I read the world");
  await desk.getByRole("button", { name: "Review message", exact: true }).click();
  const review = desk.getByRole("region", { name: "Review panel action" });
  await review.getByLabel("Sending participant").selectOption(peer.id);
  await review.getByRole("button", { name: "Confirm action", exact: true }).click();
  await expect(review.getByText(/receipt/)).toBeVisible();
  const inbox = await (
    await request.get(`/api/routing/sessions/${peer.id}/inbox`, { headers })
  ).json();
  expect(inbox.messages[0].payload.text).toBe("Keep working while I read the world");
  const beforeReconnect = subscriptions;
  await page.evaluate(() => {
    for (const socket of Reflect.get(window, "__deskTestSockets") as WebSocket[])
      if (new URL(socket.url).pathname === "/dashboard-ws" && socket.readyState === WebSocket.OPEN)
        socket.close();
  });
  await expect.poll(() => subscriptions).toBeGreaterThan(beforeReconnect);
  await request.post(`/api/routing/sessions/${peer.id}/events`, {
    headers,
    data: {
      events: [
        {
          id: crypto.randomUUID(),
          kind: "output",
          payload: { text: "Output continues after reconnect" },
        },
      ],
    },
  });
  await expect(desk.getByText("Output continues after reconnect", { exact: true })).toBeVisible({
    timeout: 3000,
  });
  await expect(desk.getByLabel("Request for coder")).toHaveValue("Keep the coding request draft");
  const violations = (
    await new AxeBuilder({ page }).include('[data-pane-key="view:published:1"]').analyze()
  ).violations;
  expect(violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("coding-desk-desktop.png") });
  await page.getByLabel("More dashboard options").click();
  page.once("dialog", (dialog) => dialog.accept("Coding desk layout"));
  await page.getByRole("button", { name: "Save layout preset", exact: true }).click();
  await page.goto("/dashboard");
  await expect(desk.getByRole("heading", { name: "Browser coding desk" })).toBeVisible();
  await desk.getByRole("button", { name: /Close/ }).first().click();
  headers.Authorization = `Bearer ${await page.evaluate(() => localStorage.getItem("marina_chat_token"))}`;
  const detail = await (await request.get(`/api/coding/session/${coding.id}`, { headers })).json();
  expect(detail.session.status).toBe("active");
  expect(
    (await (await request.get(`/api/routing/sessions/${peer.id}`, { headers })).json()).state,
  ).toBe("active");
  expect(errors).toEqual([]);
});
