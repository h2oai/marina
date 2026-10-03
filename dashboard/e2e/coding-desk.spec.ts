// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

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
