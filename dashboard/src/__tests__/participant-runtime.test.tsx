// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MarinaRoutingClient } from "../../../src/sdk/routing-client";
import type { RuntimeState } from "../../../src/sdk/routing-runtime-types";
import { ParticipantRuntimeControls } from "../components/ParticipantRuntimeControls";

afterEach(() => vi.restoreAllMocks());
const state = (): RuntimeState => ({
  version: 1,
  role: "supervisor",
  status: "idle",
  mode: "managed",
  adapter: "supervisor",
  supervisorId: "runner",
  cwd: "/project",
  updatedAt: Date.now(),
  adapters: [{ id: "arbitrary", label: "Custom agent" }],
});
function fixture(runtime: RuntimeState) {
  const requests: Record<string, unknown>[] = [];
  let fail = false;
  const client = new MarinaRoutingClient({
    url: "http://localhost",
    token: "fixture",
    fetch: vi.fn(async (_url, init) => {
      if (!init?.body) return Response.json({ state: runtime });
      requests.push(JSON.parse(String(init.body)));
      if (fail) {
        fail = false;
        throw new Error("Response lost");
      }
      return Response.json({ id: "receipt", status: "queued" });
    }) as typeof fetch,
  });
  render(<ParticipantRuntimeControls client={client} sessionId="runner" />);
  return {
    requests,
    failNext: () => {
      fail = true;
    },
  };
}

it("launches registry-provided agents with isolated worktrees and retries using the same id", async () => {
  const { requests, failNext } = fixture(state());
  await screen.findByRole("option", { name: "Custom agent" });
  fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Reviewer" } });
  failNext();
  fireEvent.click(screen.getByRole("button", { name: "Launch agent" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Response lost");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText(/Queued · receipt/);
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  expect(requests[0]!.control).toMatchObject({
    adapter: "arbitrary",
    workspace: "worktree",
    label: "Reviewer",
  });
});

it("shows exact approval details and sends only the selected one-time decision", async () => {
  const runtime = {
    ...state(),
    role: "agent" as const,
    status: "waiting" as const,
    request: {
      id: "ask-1",
      kind: "permission" as const,
      title: "Run tests?",
      input: { command: "bun test" },
    },
  };
  const { requests } = fixture(runtime);
  await screen.findByText("Run tests?");
  expect(screen.getByText(/bun test/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Decline" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]!.control).toEqual({ action: "respond", requestId: "ask-1", allow: false });
});

it("disables execution controls when the supervisor heartbeat is stale", async () => {
  fixture({ ...state(), updatedAt: 1 });
  expect(await screen.findByText(/connection is stale/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Launch agent" })).toBeDisabled();
});
