// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IntentHistory } from "../canvas/components/IntentHistory";
import { WorkInbox } from "../components/WorkInbox";
import { useChatState } from "../hooks/use-chat-state";
import { useWorkspaceState } from "../hooks/use-workspace-state";
import { useWorldState } from "../hooks/use-world-state";
import { renderWithProviders, resetWorldState } from "./test-utils";

beforeEach(() => {
  resetWorldState();
  history.replaceState(null, "", "/dashboard?view=work");
  useWorkspaceState.setState({ view: "work", canvasOrigin: null });
  useChatState.setState({ connected: true, loggedIn: true, entityName: "Ada" });
});
afterEach(() => vi.restoreAllMocks());
const pending = {
  kind: "canvas_intent",
  title: "Pending canvas intent on planning",
  detail: "Review the release",
  action: "canvas intent claim request or canvas intent list",
  command: "canvas intent claim request-full-id",
  ref: "canvas_intent:request",
  status: "pending",
  target: { kind: "canvas", canvasId: "planning", nodeId: "request-full-id" },
};

it("opens the canonical request without sending work, and drafts the exact claim separately", async () => {
  const send = vi.fn();
  useChatState.setState({ sendCommand: send });
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(Response.json({ items: [pending] }));
  const draft = vi.fn();
  window.addEventListener("marina:draft-command", draft);
  renderWithProviders(<WorkInbox name="Ada" />);
  fireEvent.click(await screen.findByRole("button", { name: "Draft claim" }));
  expect(draft.mock.calls[0][0].detail.command).toBe("canvas intent claim request-full-id");
  fireEvent.click(screen.getByRole("button", { name: "Open request" }));
  expect(location.search).toContain("canvas=planning");
  expect(location.search).toContain("node=request-full-id");
  expect(useWorkspaceState.getState().canvasOrigin?.view).toBe("work");
  expect(send).not.toHaveBeenCalled();
  expect(
    fetch.mock.calls.every(([, options]) => !options?.method || options.method === "GET"),
  ).toBe(true);
  window.removeEventListener("marina:draft-command", draft);
});

it("refreshes claimed work on live events and removes stale data after access fails", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json({ items: [pending] }));
  renderWithProviders(<WorkInbox name="Ada" />);
  await screen.findByText("Review the release");
  fetch.mockImplementation(async () =>
    Response.json({
      items: [{ ...pending, status: "active", command: undefined, owner: "Builder" }],
    }),
  );
  act(() =>
    useWorldState.setState({ eventFeed: [{ type: "canvas_intent", timestamp: Date.now() }] }),
  );
  await screen.findByText("Claimed by Builder");
  expect(screen.queryByRole("button", { name: "Draft claim" })).not.toBeInTheDocument();
  fetch.mockImplementation(async () => Response.json({ error: "Access revoked" }, { status: 403 }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh work inbox" }));
  await screen.findByRole("alert");
  expect(screen.queryByText("Review the release")).not.toBeInTheDocument();
});

it("does not read work while its panel is hidden", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ items: [] }));
  const { rerender } = renderWithProviders(<WorkInbox name="Ada" active={false} />);
  expect(fetch).not.toHaveBeenCalled();
  rerender(<WorkInbox name="Ada" active />);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
});

it("reconciles a request immediately when returning from Canvas", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json({ items: [pending] }));
  const { rerender } = renderWithProviders(<WorkInbox name="Ada" />);
  await screen.findByRole("button", { name: "Draft claim" });
  rerender(<WorkInbox name="Ada" active={false} />);
  fetch.mockImplementation(async () =>
    Response.json({ items: [{ ...pending, status: "done", command: undefined }] }),
  );
  rerender(<WorkInbox name="Ada" active />);
  await screen.findByText("Completed");
  expect(screen.queryByRole("button", { name: "Draft claim" })).not.toBeInTheDocument();
});

it("shows takeover, failure, and delivery history with an explicit verification distinction", () => {
  renderWithProviders(
    <IntentHistory
      author="Ada"
      canvasId="planning"
      resultNodeId="result"
      completed
      history={[
        { at: 1000, status: "active", actor: "First" },
        { at: 400000, status: "active", actor: "Builder", previousClaimant: "First" },
        { at: 401000, status: "failed", actor: "Builder", reason: "Source unavailable" },
        { at: 402000, status: "done", actor: "Reviewer" },
      ]}
    />,
  );
  expect(screen.getByRole("region", { name: "Request history" })).toHaveTextContent(
    "Builder took over from First",
  );
  expect(screen.getByText("Source unavailable")).toBeVisible();
  expect(screen.getByText(/does not establish verification or task approval/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Open delivered result" }));
  expect(location.search).toContain("node=result");
});
