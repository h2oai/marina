// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PinToCanvasDialog,
  parseCanvasReference,
  ReferenceContent,
  resolveCanvasReference,
} from "../components/CanvasReference";
import { attachedCommand, useWorkspaceState } from "../hooks/use-workspace-state";
import { requestResidentMemory } from "../lib/memory-service";
import { renderWithProviders } from "./test-utils";

vi.mock("../lib/memory-service", () => ({ requestResidentMemory: vi.fn() }));

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
  it("resolves a memory reference through the viewer's resident identity and respects refusal", async () => {
    const reference = parseCanvasReference({
      kind: "memory",
      id: "record",
      spaceId: "team",
      content: "Must not copy",
    });
    expect(reference).toEqual({ kind: "memory", id: "record", spaceId: "team" });
    const request = vi.mocked(requestResidentMemory);
    request.mockResolvedValueOnce({
      content: "Current evidence",
      version: 3,
      id: "record",
      subject: "Design",
    });
    expect(await resolveCanvasReference(reference!)).toMatchObject({
      content: "Current evidence",
      status: "current · revision 3",
    });
    expect(request).toHaveBeenCalledWith({ operation: "get", id: "record", space_id: "team" });
    request.mockRejectedValueOnce(new Error("forbidden"));
    await expect(resolveCanvasReference(reference!)).rejects.toThrow("forbidden");
    expect(parseCanvasReference({ kind: "memory", id: "record", spaceId: "" })).toBeNull();
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
