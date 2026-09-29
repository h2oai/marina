// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * CommandBar drill-down detail views: each kind renders its record, falls back
 * to the loading / empty states, and turns its action buttons into the exact
 * world command the server expects.
 */

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CoordDetailView } from "../unified/panels/command-bar/DetailViews";
import type { CoordDetail } from "../unified/panels/command-bar/shared";
import { renderWithProviders } from "./test-utils";

type HookResult = { data: unknown; isLoading: boolean; refetch?: () => void };
const hooks: Record<string, HookResult> = {};
const hook = (name: string) => () => hooks[name] ?? { data: undefined, isLoading: false };

vi.mock("../hooks/use-api", () => ({
  useTaskDetail: () => hook("task")(),
  useBoardDetail: () => hook("board")(),
  useGroupDetail: () => hook("group")(),
  useChannelDetail: () => hook("channel")(),
  useProjects: () => hook("projects")(),
  useMemoryPools: () => hook("pools")(),
  useConnectors: () => hook("connectors")(),
  useDynamicCommands: () => hook("commands")(),
}));

const fetchApi = vi.fn();
const postApi = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock("../lib/api", () => ({
  fetchApi: (...args: unknown[]) => fetchApi(...args),
  postApi: (...args: unknown[]) => postApi(...args),
}));

const sendCommand = vi.fn();
const onEntityClick = vi.fn();
const onNavigate = vi.fn();
const onBack = vi.fn();

function show(detail: CoordDetail, withCommands = true) {
  return renderWithProviders(
    <CoordDetailView
      detail={detail}
      onBack={onBack}
      onNavigate={onNavigate}
      onEntityClick={onEntityClick}
      sendCommand={withCommands ? sendCommand : undefined}
    />,
  );
}

beforeEach(() => {
  for (const key of Object.keys(hooks)) delete hooks[key];
  for (const fn of [sendCommand, onEntityClick, onNavigate, onBack, postApi]) fn.mockClear();
  fetchApi.mockReset();
  fetchApi.mockResolvedValue({ patterns: [] });
});

describe("CoordDetailView", () => {
  it("goes back, and shows loading and empty states", () => {
    hooks.task = { data: undefined, isLoading: true };
    const { unmount } = show({ kind: "task", id: 1 });
    expect(screen.getByText("Loading...")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(onBack).toHaveBeenCalled();
    unmount();
    hooks.task = { data: undefined, isLoading: false };
    show({ kind: "task", id: 1 });
    expect(screen.getByText("No task found")).toBeInTheDocument();
  });

  it.each([
    ["open", "CLAIM", "task claim 7"],
    ["claimed", "SUBMIT", "task submit 7"],
    ["submitted", "COMPLETE", "task complete 7"],
  ])("a %s task offers %s", (status, label, command) => {
    hooks.task = {
      isLoading: false,
      data: {
        id: 7,
        title: "Map the reef",
        status,
        creator_name: "Ada",
        assignee_name: "Bob",
        description: "Survey first",
        children: [{ id: 8, title: "Buy rope", status: "open" }],
      },
    };
    show({ kind: "task", id: 7 });
    expect(screen.getByText("#7 Map the reef")).toBeInTheDocument();
    expect(screen.getByText("Survey first")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(sendCommand).toHaveBeenCalledWith(command);
    fireEvent.click(screen.getByRole("button", { name: "Bob" }));
    expect(onEntityClick).toHaveBeenCalledWith("Bob");
    fireEvent.click(screen.getByRole("button", { name: /#8 Buy rope/ }));
    expect(onNavigate).toHaveBeenCalledWith({ kind: "task", id: 8 });
  });

  it("hides task actions without a command sender", () => {
    hooks.task = {
      isLoading: false,
      data: { id: 7, title: "T", status: "open", creator_name: "Ada" },
    };
    show({ kind: "task", id: 7 }, false);
    expect(screen.queryByRole("button", { name: "CLAIM" })).toBeNull();
  });

  it("posts, replies and votes on a board", () => {
    hooks.board = {
      isLoading: false,
      data: {
        name: "ideas",
        scope_type: "global",
        postCount: 1,
        posts: [{ id: 3, title: "Docks", body: "Build docks", author_name: "Ada" }],
      },
    };
    show({ kind: "board", name: "ideas" });
    expect(screen.getByText("global | 1 posts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "POST" }));
    const input = screen.getByPlaceholderText("Title | Body text...");
    fireEvent.change(input, { target: { value: "Hi | there" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(sendCommand).toHaveBeenCalledWith("board post ideas Hi | there");
    fireEvent.click(screen.getByRole("button", { name: "REPLY" }));
    fireEvent.change(screen.getByPlaceholderText("Reply text..."), { target: { value: "yes" } });
    fireEvent.click(screen.getByRole("button", { name: "GO" }));
    expect(sendCommand).toHaveBeenCalledWith("board reply 3 yes");
    fireEvent.click(screen.getByRole("button", { name: "+1" }));
    fireEvent.click(screen.getByRole("button", { name: "-1" }));
    expect(sendCommand).toHaveBeenCalledWith("board vote 3 up");
    expect(sendCommand).toHaveBeenCalledWith("board vote 3 down");
  });

  it("joins and leaves a group and opens members", () => {
    hooks.group = {
      isLoading: false,
      data: {
        name: "crew",
        memberCount: 1,
        description: "Builders",
        leader_id: "Ada",
        members: [{ entity_id: "Bob", rank: 2 }],
      },
    };
    show({ kind: "group", name: "crew" });
    fireEvent.click(screen.getByRole("button", { name: "JOIN" }));
    fireEvent.click(screen.getByRole("button", { name: "LEAVE" }));
    expect(sendCommand).toHaveBeenCalledWith("group join crew");
    expect(sendCommand).toHaveBeenCalledWith("group leave crew");
    fireEvent.click(screen.getByRole("button", { name: /Bob/ }));
    expect(onEntityClick).toHaveBeenCalledWith("Bob");
  });

  it("subscribes to and sends on a channel", () => {
    hooks.channel = {
      isLoading: false,
      data: {
        name: "ops",
        type: "public",
        messages: [{ sender_name: "Ada", created_at: 1, content: "hello" }],
      },
    };
    show({ kind: "channel", name: "ops" });
    expect(screen.getByText("#ops")).toBeInTheDocument();
    expect(screen.getByText("hello")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "SUBSCRIBE" }));
    expect(sendCommand).toHaveBeenCalledWith("channel sub ops");
    fireEvent.click(screen.getByRole("button", { name: "SEND" }));
    fireEvent.click(screen.getByRole("button", { name: "X" }));
    expect(screen.getByRole("button", { name: "SEND" })).toBeInTheDocument();
  });

  it("changes a project's orchestration through the API", async () => {
    const refetch = vi.fn();
    hooks.projects = {
      isLoading: false,
      refetch,
      data: [
        {
          id: "p1",
          name: "Harbour",
          status: "active",
          orchestration: "swarm",
          memory_arch: "shared",
          created_by: "Ada",
          bundleProgress: { done: 1, total: 3 },
        },
      ],
    };
    show({ kind: "project", id: "p1" });
    expect(screen.getByText("Progress: 1/3 tasks")).toBeInTheDocument();
    expect(screen.getByText(/built-in fallback/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Orchestration pattern"), {
      target: { value: "debate" },
    });
    await waitFor(() => expect(refetch).toHaveBeenCalled());
    expect(postApi).toHaveBeenCalledWith("/api/coordination/projects/p1/orchestration", {
      orchestration: "debate",
    });
  });

  it("uses the server orchestration catalogue once loaded", async () => {
    fetchApi.mockResolvedValue({
      patterns: [{ id: "chorus", name: "Chorus", description: "d", fit: "many voices" }],
    });
    hooks.projects = {
      isLoading: false,
      data: [{ id: "p1", name: "H", status: "active", orchestration: "chorus", created_by: "A" }],
    };
    show({ kind: "project", id: "p1" });
    expect(await screen.findByText("Chorus — many voices")).toBeInTheDocument();
    expect(screen.queryByText(/built-in fallback/)).toBeNull();
  });

  it("recalls a pool and shows connector status", () => {
    hooks.pools = {
      isLoading: false,
      data: [{ id: "pool1", name: "lore", created_by: "Ada", group_id: "crew:x" }],
    };
    const { unmount } = show({ kind: "pool", id: "pool1" });
    expect(screen.getByText("Group: crew:x")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "RECALL" }));
    expect(sendCommand).toHaveBeenCalledWith("pool recall lore");
    unmount();
    hooks.connectors = {
      isLoading: false,
      data: [
        {
          id: "c1",
          name: "gh",
          transport: "http",
          status: "error",
          url: "https://x",
          auth_type: "bearer",
          created_by: "Ada",
        },
      ],
    };
    show({ kind: "connector", id: "c1" });
    expect(screen.getByText("error")).toBeInTheDocument();
    expect(screen.getByText("Auth: bearer")).toBeInTheDocument();
  });

  it("runs every macro command action", () => {
    hooks.commands = {
      isLoading: false,
      data: [
        { id: "m1", name: "greet", version: 2, valid: false, created_by: "Ada", created_at: 1 },
      ],
    };
    show({ kind: "command", id: "m1" });
    expect(screen.getByText("No")).toBeInTheDocument();
    for (const label of ["RUN", "VIEW CODE", "VALIDATE", "RELOAD", "DELETE"]) {
      fireEvent.click(screen.getByRole("button", { name: label }));
    }
    expect(sendCommand.mock.calls.map((c) => c[0])).toEqual([
      "greet",
      "build command code greet",
      "build command validate greet",
      "build command reload greet",
      "build command destroy greet",
    ]);
  });

  it.each([
    [{ kind: "pool", id: "missing" }, "pools", "No pool found"],
    [{ kind: "connector", id: "missing" }, "connectors", "No connector found"],
    [{ kind: "command", id: "missing" }, "commands", "No command found"],
    [{ kind: "project", id: "missing" }, "projects", "No project found"],
    [{ kind: "board", name: "missing" }, "board", "No board found"],
    [{ kind: "group", name: "missing" }, "group", "No group found"],
    [{ kind: "channel", name: "missing" }, "channel", "No channel found"],
  ] as const)("shows an empty state for %o", (detail, key, text) => {
    hooks[key] = { isLoading: false, data: key.endsWith("s") ? [] : undefined };
    show(detail as CoordDetail);
    expect(screen.getByText(text)).toBeInTheDocument();
  });
});
