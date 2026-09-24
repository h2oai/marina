// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BoardDetailView, ChannelDetailView } from "../components/CoordinationCard";
import { MyInventory } from "../components/MyInventory";
import { useChatState } from "../hooks/use-chat-state";
import { renderWithProviders } from "./test-utils";

afterEach(() => vi.unstubAllGlobals());
it("drafts an exact board reply without issuing a mutation", async () => {
  const posts = [{ id: 7, title: "Review", body: "Ready?", author_name: "Builder", created_at: 1 }];
  const fetch = vi.fn(async (path: string, _init?: RequestInit) => ({
    ok: true,
    json: async () =>
      path.includes("/posts")
        ? { items: posts, total: 1 }
        : { name: "general", posts, postCount: 1 },
  }));
  vi.stubGlobal("fetch", fetch);
  const draft = vi.fn();
  window.addEventListener("marina:draft-command", draft);
  renderWithProviders(<BoardDetailView name="general" />);
  fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
  expect((draft.mock.calls[0]![0] as CustomEvent).detail.command).toBe("board reply 7 ");
  expect(fetch.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  window.removeEventListener("marina:draft-command", draft);
});
it("offers channel join alongside its messages", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => ({
      ok: true,
      json: async () =>
        path.includes("/messages") ? { items: [], total: 0 } : { name: "general", messages: [] },
    })),
  );
  const draft = vi.fn();
  window.addEventListener("marina:draft-command", draft);
  renderWithProviders(<ChannelDetailView name="general" />);
  fireEvent.click(await screen.findByRole("button", { name: "Join channel" }));
  expect((draft.mock.calls[0]![0] as CustomEvent).detail.command).toBe("channel join general");
  window.removeEventListener("marina:draft-command", draft);
});
it("keeps the logged-in resident's inventory visible independently of selection", async () => {
  useChatState.setState({ entityName: "InventoryUser" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ privateVisible: true, inventory: ["Compass", "Notebook"] }),
    })),
  );
  renderWithProviders(<MyInventory />);
  expect(await screen.findByText("Compass")).toBeVisible();
  expect(screen.getByRole("region", { name: "My inventory" })).toHaveTextContent("Notebook");
});
