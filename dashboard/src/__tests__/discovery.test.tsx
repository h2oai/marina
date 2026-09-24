// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandCatalogEntry } from "../../../src/net/discovery-types";
import { DiscoveryPalette } from "../components/DiscoveryPalette";
import { EntityPreviewTooltip } from "../components/EntityPreviewTooltip";
import { useChatState } from "../hooks/use-chat-state";
import { useWorldState } from "../hooks/use-world-state";
import { fuzzyScore, matchCommands } from "../lib/command-discovery";
import { renderWithProviders } from "./test-utils";

const catalog: CommandCatalogEntry[] = [
  {
    name: "task",
    aliases: ["tasks"],
    help: "Claim and create work. Usage: task create <title> | <description>",
    category: "Coordination",
    minRank: 0,
  },
  {
    name: "inventory",
    aliases: ["inv"],
    help: "List carried objects",
    category: "Objects",
    minRank: 0,
  },
];
afterEach(() => {
  vi.unstubAllGlobals();
  useWorldState.setState({ selectedEntity: null });
});

describe("command discovery", () => {
  it("keeps an entity preview open while another pane scrolls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ name: "Alice", rank: 1, standing: 5, privateVisible: false }),
      })),
    );
    renderWithProviders(
      <>
        <div data-testid="chat-scroll">Chat</div>
        <div data-testid="roster-scroll">
          <button type="button" data-entity-preview="Alice">
            Alice
          </button>
        </div>
        <EntityPreviewTooltip />
      </>,
    );
    fireEvent.mouseOver(screen.getByRole("button", { name: "Alice" }));
    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent("Standing 5"));
    fireEvent.scroll(screen.getByTestId("chat-scroll"));
    expect(screen.getByRole("tooltip")).toBeVisible();
    fireEvent.scroll(screen.getByTestId("roster-scroll"));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
  it("ranks names and aliases ahead of fuzzy descriptions", () => {
    expect(matchCommands(catalog, "inv")[0]?.name).toBe("inventory");
    expect(matchCommands(catalog, "tsk")[0]?.name).toBe("task");
    expect(matchCommands(catalog, "carried")[0]?.name).toBe("inventory");
    expect(matchCommands(catalog, "", "Objects")).toHaveLength(1);
    expect(fuzzyScore("xyz", "task")).toBe(0);
    expect(fuzzyScore("abc", "a very long help page before b and much later c")).toBe(0);
  });
  it("builds a task for review without sending it", async () => {
    const send = vi.fn(() => true);
    useChatState.setState({ loggedIn: true, connected: true, sendCommand: send });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => catalog })),
    );
    const onClose = vi.fn();
    const draft = vi.fn();
    window.addEventListener("marina:draft-command", draft);
    renderWithProviders(<DiscoveryPalette onClose={onClose} />);
    fireEvent.click(await screen.findByRole("option", { name: /Compose task/ }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Review release" } });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Check the changes" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Fill command" }));
    expect(screen.getByLabelText("Arguments and parameters")).toHaveValue(
      "create Review release | Check the changes",
    );
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Insert into chat" }));
    expect((draft.mock.calls[0]![0] as CustomEvent).detail.command).toBe(
      "task create Review release | Check the changes",
    );
    expect(send).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
    window.removeEventListener("marina:draft-command", draft);
  });
  it("searches the backend and selects an entity without sending a command", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => ({
        ok: true,
        json: async () =>
          path.includes("command-catalog")
            ? catalog
            : [{ kind: "entity", id: "Alice", title: "Alice", detail: "agent" }],
      })),
    );
    renderWithProviders(<DiscoveryPalette onClose={() => {}} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Search commands and world" }), {
      target: { value: "Alice" },
    });
    fireEvent.click(await screen.findByRole("option", { name: /Alice.*entity.*agent/ }));
    expect(useWorldState.getState().selectedEntity).toBe("Alice");
  });
  it("offers retry when catalog loading fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new Error("Offline"))
        .mockResolvedValue({ ok: true, json: async () => catalog }),
    );
    renderWithProviders(<DiscoveryPalette onClose={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("option", { name: /Compose task/ })).toBeVisible());
  });
});
