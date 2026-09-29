// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * ChatStatusOverlay: each overlay kind renders its snapshot (loading, error,
 * empty, populated) and its buttons either send a command through the
 * overlay path or only draft it into the input.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatStatusOverlay } from "../components/ChatStatusOverlay";
import { useChatState } from "../hooks/use-chat-state";
import { useWorkspaceState } from "../hooks/use-workspace-state";
import type { OverlayState } from "../lib/chat-overlay";

type Query = {
  data?: unknown;
  isLoading?: boolean;
  isError?: boolean;
  refetch?: () => Promise<unknown>;
};
const queries: Record<string, Query> = {};
const q = (name: string) => queries[name] ?? { data: undefined, refetch: async () => {} };

vi.mock("../hooks/use-status-cards", () => ({
  useTasksSnapshot: () => q("tasks"),
  useBoardsSnapshot: () => q("boards"),
  useChannelsSnapshot: () => q("channels"),
  useGroupsSnapshot: () => q("groups"),
}));
vi.mock("../hooks/use-api", () => ({ useMediaJobs: () => q("media") }));
vi.mock("../hooks/use-coding", () => ({ useCodingSessionsSnapshot: () => q("sessions") }));

const draftCommand = vi.fn();
vi.mock("../lib/command-discovery", () => ({
  draftCommand: (command: string) => draftCommand(command),
}));

const authFetch = vi.fn();
vi.mock("../lib/api", () => ({ authFetch: (...args: unknown[]) => authFetch(...args) }));

vi.mock("../components/CoordinationCard", () => ({
  BoardDetailView: ({ name }: { name: string }) => <div>board detail {name}</div>,
  ChannelDetailView: ({ name }: { name: string }) => <div>channel detail {name}</div>,
}));
vi.mock("../components/CommandFavorites", () => ({ FavoriteCommandButton: () => null }));
vi.mock("../components/CanvasReference", () => ({ PinToCanvas: () => <span>pin</span> }));
vi.mock("../components/MediaJobsList", () => ({
  MediaJobsList: ({
    jobs,
    onRetry,
    onDeleteAsset,
  }: {
    jobs: { id: string; assetId?: string }[];
    onRetry(job: unknown): void;
    onDeleteAsset(job: unknown): void;
  }) => (
    <div>
      {jobs.map((job) => (
        <div key={job.id}>
          <button type="button" onClick={() => onRetry(job)}>
            retry {job.id}
          </button>
          <button type="button" onClick={() => onDeleteAsset(job)}>
            delete {job.id}
          </button>
        </div>
      ))}
    </div>
  ),
}));

const send = vi.fn(() => true);
const closeOverlay = vi.fn();
const detailRefetch = vi.fn(async () => ({}));

function overlayOf(type: OverlayState["type"], params?: Record<string, unknown>): OverlayState {
  return { type, issuedFrom: `${type} list`, params };
}

function show(
  overlay: OverlayState | null,
  detail: Partial<{ data: unknown; isLoading: boolean; isError: boolean }> = {},
  sessionId: string | null = "s1",
) {
  return render(
    <ChatStatusOverlay
      overlay={overlay}
      closeOverlay={closeOverlay}
      activeCodingSessionId={sessionId}
      codingDetailQuery={{ refetch: detailRefetch, ...detail } as never}
      copy={async () => {}}
      copied={null}
      sendCommandWithOverlay={send}
    />,
  );
}

beforeEach(() => {
  for (const key of Object.keys(queries)) delete queries[key];
  for (const fn of [draftCommand, authFetch, send, closeOverlay, detailRefetch]) fn.mockClear();
  useChatState.setState({ messages: [] });
});

describe("ChatStatusOverlay", () => {
  it("renders nothing without an overlay", () => {
    show(null);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("filters tasks by scope and routes Info/Claim", () => {
    queries.tasks = {
      data: {
        total: 3,
        items: [
          { id: 1, title: "Open one", status: "open", creator_name: "Ada" },
          { id: 2, title: "Claimed one", status: "claimed" },
        ],
      },
    };
    show(overlayOf("tasks", { scope: "open", group: "g1" }));
    expect(screen.getByText("Task Snapshot")).toBeInTheDocument();
    expect(screen.getByText("Open one")).toBeInTheDocument();
    expect(screen.queryByText("Claimed one")).toBeNull();
    expect(screen.getByText("1 shown · total 3")).toBeInTheDocument();
    expect(screen.getByText(/Group g1/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Info" }));
    expect(send).toHaveBeenCalledWith("task info 1");
    fireEvent.click(screen.getByRole("button", { name: "Claim" }));
    expect(draftCommand).toHaveBeenCalledWith("task claim 1");
  });

  it("shows every task under the mine scope, and loading/error states", () => {
    queries.tasks = { data: { items: [{ id: 1, title: "A", status: "claimed" }] } };
    const { unmount } = show(overlayOf("tasks", { scope: "mine" }));
    expect(screen.getByText(/mirrors the engine output/)).toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument();
    unmount();
    queries.tasks = { isLoading: true };
    const second = show(overlayOf("tasks"));
    expect(screen.getByText("Loading tasks…")).toBeInTheDocument();
    second.unmount();
    queries.tasks = { isError: true };
    show(overlayOf("tasks"));
    expect(screen.getByText("Failed to load tasks snapshot.")).toBeInTheDocument();
  });

  it("drafts, shows and inspects boards", () => {
    queries.boards = {
      data: [{ id: "b1", name: "ideas", postCount: 2, created_at: 1, scope_type: null }],
    };
    show(overlayOf("boards"));
    expect(screen.getByText("general")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Draft read" }));
    fireEvent.click(screen.getByRole("button", { name: "Draft post" }));
    expect(draftCommand).toHaveBeenCalledWith("board read ideas");
    expect(draftCommand).toHaveBeenCalledWith("board post ideas ");
    fireEvent.click(screen.getByRole("button", { name: "Show board" }));
    expect(send).toHaveBeenCalledWith("board read ideas");
    const inspect = vi.fn();
    useWorkspaceState.setState({ inspect } as never);
    fireEvent.click(screen.getByRole("button", { name: "Recent posts" }));
    expect(inspect).toHaveBeenCalledWith({ type: "board", name: "ideas" });
    expect(closeOverlay).toHaveBeenCalled();
  });

  it.each([
    ["boards", "No boards available yet."],
    ["channels", "No channels available yet."],
    ["groups", "No groups defined yet."],
  ] as const)("shows the empty %s state", (type, text) => {
    queries[type] = { data: [] };
    show(overlayOf(type));
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it.each([
    ["boards", "Failed to load boards snapshot."],
    ["channels", "Failed to load channels snapshot."],
    ["groups", "Failed to load groups snapshot."],
    ["sessions", "Failed to load coding sessions snapshot."],
  ] as const)("shows the %s error state", (key, text) => {
    queries[key] = { isError: true };
    show(overlayOf(key === "sessions" ? "coding-sessions" : key));
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("joins channels and runs group commands", () => {
    queries.channels = {
      data: [{ id: "abcdefghijk", name: "ops", type: "public", messageCount: 4 }],
    };
    const { unmount } = show(overlayOf("channels"));
    expect(screen.getByText("ID abcdefgh…")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    expect(draftCommand).toHaveBeenCalledWith("channel join ops");
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(send).toHaveBeenCalledWith("channel history ops");
    unmount();
    queries.groups = {
      data: [{ id: "g1", name: "crew", memberCount: 3, leader_id: "e_1234567890" }],
    };
    show(overlayOf("groups"));
    expect(screen.getByText("Lead: e_123456")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Members" }));
    fireEvent.click(screen.getByRole("button", { name: "Group info" }));
    expect(send).toHaveBeenCalledWith("group members crew");
    expect(send).toHaveBeenCalledWith("group info crew");
  });

  it("renders board and channel detail overlays", () => {
    const { unmount } = show(overlayOf("board-posts", { name: "ideas" }));
    expect(screen.getByText("board detail ideas")).toBeInTheDocument();
    unmount();
    show(overlayOf("channel-messages", { name: "ops" }));
    expect(screen.getByText("channel detail ops")).toBeInTheDocument();
  });

  it("retries media jobs and deletes their assets", async () => {
    const refetch = vi.fn(async () => ({}));
    queries.media = { data: [{ id: "j1", assetId: "a1" }], refetch };
    authFetch.mockResolvedValue({ ok: true, status: 200 });
    show(overlayOf("media", { entityName: "Ada" }));
    expect(screen.getByText("Ada")).toBeInTheDocument();
    await waitFor(() => expect(refetch).toHaveBeenCalled());
    refetch.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "retry j1" }));
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1));
    expect(authFetch.mock.calls[0]?.[0]).toMatch(/\/api\/media-jobs\/j1\/retry$/);
    fireEvent.click(screen.getByRole("button", { name: "delete j1" }));
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(2));
    expect(authFetch.mock.calls[1]).toEqual([
      expect.stringMatching(/\/api\/assets\/a1$/),
      { method: "DELETE" },
    ]);
  });

  it("shows media loading and error states", () => {
    queries.media = { isLoading: true, refetch: async () => ({}) };
    const { unmount } = show(overlayOf("media"));
    expect(screen.getByText("Loading media jobs…")).toBeInTheDocument();
    unmount();
    queries.media = { isError: true, refetch: async () => ({}) };
    show(overlayOf("media"));
    expect(screen.getByText("Failed to load media jobs.")).toBeInTheDocument();
  });

  it("resumes a coding session", () => {
    queries.sessions = {
      data: {
        total: 1,
        items: [
          { id: "s1", title: "Fix bug", status: "active", workspace_root: "/w", updated_at: 1 },
        ],
      },
    };
    show(overlayOf("coding-sessions"));
    fireEvent.click(screen.getByRole("button", { name: /Fix bug/ }));
    expect(send).toHaveBeenCalledWith("code resume s1");
    expect(closeOverlay).toHaveBeenCalled();
  });

  it("explains an empty coding sessions list", () => {
    queries.sessions = { data: { items: [] } };
    show(overlayOf("coding-sessions"));
    expect(screen.getByText(/No coding sessions yet/)).toBeInTheDocument();
  });

  it("groups coding artifacts and expands one", () => {
    const detail = {
      data: {
        session: { title: "Fix bug" },
        artifacts: [
          {
            id: "art1",
            kind: "diff",
            title: "patch",
            status: "ready",
            content_text: "diff --git a/x b/x",
            metadata_json: "{}",
            updated_at: 1,
          },
        ],
      },
    };
    show(overlayOf("coding-artifacts"), detail);
    expect(screen.getByText("Artifacts · Fix bug")).toBeInTheDocument();
    expect(screen.getByText("diff · 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /patch/ }));
    expect(screen.getByText("pin")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(screen.queryByText("pin")).toBeNull();
  });

  it("covers artifact empty, loading, error and no-session states", () => {
    const a = show(overlayOf("coding-artifacts"), {}, null);
    expect(screen.getByText(/No active coding session/)).toBeInTheDocument();
    a.unmount();
    const b = show(overlayOf("coding-artifacts"), { isLoading: true });
    expect(screen.getByText("Loading artifacts…")).toBeInTheDocument();
    b.unmount();
    const c = show(overlayOf("coding-artifacts"), { isError: true });
    expect(screen.getByText("Failed to load coding session detail.")).toBeInTheDocument();
    c.unmount();
    show(overlayOf("coding-artifacts"), { data: { artifacts: [] } });
    expect(screen.getByText("No artifacts in this session yet.")).toBeInTheDocument();
  });

  it("copies the issuing command to the input and closes from the footer", () => {
    queries.groups = { data: [] };
    show(overlayOf("groups"));
    fireEvent.click(screen.getByRole("button", { name: "Copy command to input" }));
    expect(draftCommand).toHaveBeenCalledWith("groups list");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(closeOverlay).toHaveBeenCalled();
  });
});
