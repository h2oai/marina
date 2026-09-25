// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoutingEventPage, RoutingSession } from "../../../src/sdk/routing-types";
import { ParticipantStreams } from "../components/ParticipantStreams";
import { useChatState } from "../hooks/use-chat-state";
import { clearToken, setToken } from "../lib/api";

const session: RoutingSession = {
  id: "external",
  ownerId: "owner",
  clientKey: "external",
  label: "Build worker",
  kind: "service",
  groupId: null,
  capabilities: [],
  state: "active",
  createdAt: 1,
  lastSeenAt: 1,
  lastSequence: 2,
};
const page: RoutingEventPage = {
  events: [
    {
      sessionId: "external",
      id: "text",
      sequence: 2,
      kind: "output",
      payload: { text: "<script>literal output</script>" },
      createdAt: 2,
    },
  ],
  nextCursor: 2,
  lastSequence: 2,
  hasMore: false,
  gap: true,
};
const fetcher = vi.fn();
beforeEach(() => {
  setToken("private-token");
  useChatState.setState({ loggedIn: true, entityName: "owner" });
  fetcher.mockReset();
  fetcher.mockImplementation(async (url: string) =>
    Response.json(url.includes("/events?") ? page : { sessions: [session], nextCursor: null }),
  );
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearToken();
  useChatState.setState({ loggedIn: false, entityName: null });
});

describe("participant streams", () => {
  it("does not poll while hidden or before login", () => {
    const view = render(<ParticipantStreams active={false} />);
    expect(fetcher).not.toHaveBeenCalled();
    useChatState.setState({ loggedIn: false });
    view.rerender(<ParticipantStreams active />);
    expect(screen.getByText(/Log in through Chat/)).toBeVisible();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("selects published output safely, labels history gaps, and clears it on logout", async () => {
    render(<ParticipantStreams active />);
    fireEvent.click(await screen.findByRole("button", { name: /Build worker/ }));
    expect(await screen.findByText("<script>literal output</script>")).toBeVisible();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText(/history is incomplete/)).toBeVisible();
    expect(screen.getByRole("region", { name: "Build worker output" })).toBeVisible();
    expect(
      fetcher.mock.calls.every(([, init]) => init.headers.Authorization === "Bearer private-token"),
    ).toBe(true);
    act(() => useChatState.setState({ loggedIn: false, entityName: null }));
    expect(screen.queryByText("<script>literal output</script>")).not.toBeInTheDocument();
  });
  it("provides an explicit retry after API failure and unmounts polling when hidden", async () => {
    fetcher.mockResolvedValueOnce(
      Response.json({ error: "Temporarily unavailable" }, { status: 503 }),
    );
    const view = render(<ParticipantStreams active />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Temporarily unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: /Build worker/ })).toBeVisible();
    view.rerender(<ParticipantStreams active={false} />);
    const count = fetcher.mock.calls.length;
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetcher).toHaveBeenCalledTimes(count);
  });
  it("removes stale private output immediately after a revoked stream request", async () => {
    render(<ParticipantStreams active />);
    fireEvent.click(await screen.findByRole("button", { name: /Build worker/ }));
    await screen.findByText("<script>literal output</script>");
    fetcher.mockResolvedValueOnce(Response.json({ error: "not found" }, { status: 404 }));
    fireEvent.click(screen.getByRole("button", { name: "Replay retained history" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("not found"));
    expect(screen.queryByText("<script>literal output</script>")).not.toBeInTheDocument();
  });
});
