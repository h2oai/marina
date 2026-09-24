// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PinToCanvasDialog,
  parseCanvasReference,
  ReferenceContent,
} from "../components/CanvasReference";
import { attachedCommand, useWorkspaceState } from "../hooks/use-workspace-state";
import { renderWithProviders } from "./test-utils";

beforeEach(() => {
  useWorkspaceState.setState({ pendingPin: null, selection: null, attachment: null });
  window.history.replaceState(null, "", "/dashboard");
});
describe("live canvas references", () => {
  it("saves only a reference and navigates to the created node", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async (_url, init) =>
          new Response(
            JSON.stringify(
              init?.method === "POST" ? { id: "new-node" } : [{ id: "board", name: "Team board" }],
            ),
            { status: 200 },
          ),
      );
    useWorkspaceState.setState({ pendingPin: { kind: "note", id: "42" } });
    renderWithProviders(<PinToCanvasDialog />);
    await screen.findByRole("option", { name: "Team board" });
    fireEvent.click(screen.getByRole("button", { name: "Pin reference" }));
    await waitFor(() => expect(useWorkspaceState.getState().pendingPin).toBeNull());
    const mutation = fetch.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(mutation?.[1]?.body)).data).toEqual({
      reference: { kind: "note", id: "42" },
    });
    expect(window.location.search).toContain("node=new-node");
    fetch.mockRestore();
  });
  it("shows a permission failure without revealing copied or cached content", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 403 }));
    renderWithProviders(<ReferenceContent reference={{ kind: "note", id: "42" }} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "unavailable or you do not have access",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    fetch.mockRestore();
  });
  it("rejects arbitrary reference paths", () => {
    expect(parseCanvasReference({ kind: "note", id: "../secrets" })).toBeNull();
    expect(parseCanvasReference({ kind: "artifact", id: "a" })).toBeNull();
  });
});
describe("explicit chat context", () => {
  const node = { canvasId: "board-id", nodeId: "node-id", title: "Review" };
  it("attaches context without sending and requires an agent for asks", () => {
    useWorkspaceState.getState().attach({ ...node, mode: "ask" });
    expect(useWorkspaceState.getState().pane).toBe("webchat");
    expect(attachedCommand({ ...node, mode: "ask" }, "Review this", "")).toBeNull();
    expect(attachedCommand({ ...node, mode: "ask" }, "Review this", "Sage")).toBe(
      "tell Sage Canvas board-id, node node-id: Review this",
    );
    expect(attachedCommand({ ...node, mode: "discuss" }, "Review this", "")).toBe(
      "canvas post on:board-id reply:node-id Review this",
    );
  });
});
