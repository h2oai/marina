// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommandFavorites,
  FavoriteCommandButton,
  suggestMacroName,
} from "../components/CommandFavorites";
import { MACROS_CHANGED_EVENT, useChatState } from "../hooks/use-chat-state";
import { fetchApi } from "../lib/api";
import type { MacroEntry } from "../lib/types";

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  fetchApi: vi.fn(),
}));

const macro = (id: number, name: string, command: string, author = "e_1"): MacroEntry => ({
  id,
  name,
  command,
  author_id: author,
  created_at: 1,
  updated_at: 1,
});

function renderRow() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <CommandFavorites />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.mocked(fetchApi).mockReset();
  localStorage.clear();
});

describe("macro chips", () => {
  it("lists the caller's macros and shared ones, and drafts (never sends) the macro", async () => {
    useChatState.setState({ entityName: "MacroUser", sendCommand: vi.fn() });
    vi.mocked(fetchApi).mockResolvedValue([
      macro(1, "morning", "brief social; task list mine"),
      macro(2, "tour", "guide", "system"),
    ]);
    const drafted = vi.fn();
    window.addEventListener("marina:draft-command", drafted);
    renderRow();
    const chip = await screen.findByRole("button", { name: "morning" });
    expect(fetchApi).toHaveBeenCalledWith("/api/macros");
    expect(chip).toHaveAttribute("title", "Macro: brief social; task list mine");
    expect(screen.getByRole("button", { name: "tour" })).toHaveAttribute(
      "title",
      "Macro (shared): guide",
    );
    fireEvent.click(chip);
    expect((drafted.mock.calls[0]![0] as CustomEvent).detail.command).toBe("morning");
    expect(useChatState.getState().sendCommand).not.toHaveBeenCalled();
    window.removeEventListener("marina:draft-command", drafted);
  });

  it("refetches when this client changes a macro", async () => {
    vi.mocked(fetchApi).mockResolvedValue([]);
    renderRow();
    await waitFor(() => expect(fetchApi).toHaveBeenCalledTimes(1));
    vi.mocked(fetchApi).mockResolvedValue([macro(3, "digest", "chronicle list")]);
    window.dispatchEvent(new Event(MACROS_CHANGED_EVENT));
    expect(await screen.findByRole("button", { name: "digest" })).toBeInTheDocument();
  });

  it("offers to save a pinned command as a macro, as a draft", async () => {
    vi.mocked(fetchApi).mockResolvedValue([]);
    useChatState.setState({ entityName: "MacroSaver" });
    const drafted = vi.fn();
    window.addEventListener("marina:draft-command", drafted);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <FavoriteCommandButton command="agent status builder" />
        <CommandFavorites />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Pin command" }));
    fireEvent.click(screen.getByRole("button", { name: "Save agent status builder as a macro" }));
    expect((drafted.mock.calls[0]![0] as CustomEvent).detail.command).toBe(
      "macro create agent-status agent status builder",
    );
    window.removeEventListener("marina:draft-command", drafted);
  });

  it("suggests a slug from the command's first two words", () => {
    expect(suggestMacroName("task list mine")).toBe("task-list");
    expect(suggestMacroName("  ")).toBe("my-macro");
  });
});
