// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { MemoryWorkspace } from "../components/MemoryWorkspace";
import { useChatState } from "../hooks/use-chat-state";
import { useWorkspaceState } from "../hooks/use-workspace-state";
import { requestResidentMemory } from "../lib/memory-service";

vi.mock("../lib/memory-service", () => ({ requestResidentMemory: vi.fn() }));
const request = vi.mocked(requestResidentMemory);
const record = {
  id: "record-1",
  space_id: "space",
  version: 2,
  content: "Revised evidence",
  freshness: "current",
  type: "fact",
  tier: "fact",
  importance: 1,
  subject: null,
  metadata: {},
  source_ids: ["source-1"],
  depends_on: [],
  created_at: 1,
};
beforeEach(() => {
  request.mockReset();
  useChatState.getState().setLoggedIn(true, "Ada");
  request.mockImplementation(async (r) => {
    if (r.operation === "spaces") return { spaces: [] };
    if (r.operation === "query" || r.operation === "search")
      return { results: [record], next_cursor: null };
    if (r.operation === "get")
      return r.input?.version === 1
        ? { ...record, version: 1, content: "Original assertion" }
        : record;
    if (r.operation === "source_range")
      return {
        id: "source-1",
        start: 0,
        end: 4,
        text: "raw 🙂 source",
        text_hash: "hash",
        next_start: null,
      };
    if (r.operation === "source_headers")
      return { sources: [{ id: "source-1", seq: 1 }], next_cursor: null };
    if (r.operation === "review")
      return {
        items: [
          {
            record,
            competing_records: [{ ...record, id: "competitor", content: "Competing evidence" }],
            competing_truncated: false,
          },
        ],
        next_cursor: null,
      };
    return {};
  });
});
it("renders authored history and original source ranges", async () => {
  render(<MemoryWorkspace open onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Load" }));
  fireEvent.click(await screen.findByRole("button", { name: /Revised evidence/ }));
  expect(await screen.findByText("Revision 2 of 2")).toBeVisible();
  expect(await screen.findByText("Compare with revision 1")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "source-1" }));
  expect(await screen.findByText("raw 🙂 source")).toBeVisible();
});
it("opens the referenced memory space and pins only its identity", async () => {
  render(
    <MemoryWorkspace
      open
      onClose={() => {}}
      destination={{ recordId: "record-1", spaceId: "space", query: "navigation" }}
    />,
  );
  expect(await screen.findByText("Revision 2 of 2")).toBeVisible();
  expect(request).toHaveBeenCalledWith(
    { operation: "get", id: "record-1", space_id: "space" },
    expect.any(AbortSignal),
  );
  fireEvent.click(screen.getByRole("button", { name: "Pin to canvas" }));
  expect(useWorkspaceState.getState().pendingPin).toEqual({
    kind: "memory",
    id: "record-1",
    spaceId: "space",
  });
});
it("lists sources and exposes competing assertions for explicit review", async () => {
  render(<MemoryWorkspace open onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Sources" }));
  fireEvent.click(screen.getByRole("button", { name: "Load" }));
  expect(await screen.findByRole("button", { name: "source-1" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  fireEvent.click(screen.getByRole("button", { name: "Load" }));
  fireEvent.click(await screen.findByRole("button", { name: /Revised evidence/ }));
  expect(await screen.findByText("Competing evidence")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Reaffirm reviewed conclusion" }),
  ).not.toBeInTheDocument();
});
it("clears private entries on identity change and logout", async () => {
  render(<MemoryWorkspace open onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Load" }));
  await screen.findByRole("button", { name: /Revised evidence/ });
  act(() => useChatState.getState().setLoggedIn(true, "Grace"));
  expect(screen.queryByText("Revised evidence")).not.toBeInTheDocument();
  act(() => useChatState.getState().setLoggedIn(false));
  expect(await screen.findByText(/Sign in to world chat to search/)).toBeVisible();
});
it("aborts expired staging only after explicit confirmation", async () => {
  const transfer = {
    id: "transfer-1",
    state: "receiving",
    bytes: 123,
    expired: true,
    expires_at: 0,
    header: { schema: "marina.memory.transfer.v1" },
  };
  request.mockImplementation(async (r) =>
    r.operation === "spaces"
      ? { spaces: [] }
      : r.operation === "transfers"
        ? { transfers: [transfer], next_cursor: null }
        : r.operation === "transfer_status"
          ? { ...transfer, state: "aborted" }
          : {},
  );
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  render(<MemoryWorkspace open onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Transfers" }));
  fireEvent.click(screen.getByRole("button", { name: "Load" }));
  fireEvent.click(await screen.findByRole("button", { name: /transfer-1/ }));
  fireEvent.click(screen.getByRole("button", { name: "Abort unpublished transfer" }));
  expect(request.mock.calls.some(([r]) => r.operation === "transfer_abort")).toBe(false);
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Abort unpublished transfer" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "transfer_abort", key: "transfer-1:abort" }),
      expect.any(AbortSignal),
    ),
  );
  confirm.mockRestore();
});
