// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuestProgressCard } from "../components/QuestProgressCard";
import { useChatState } from "../hooks/use-chat-state";
import { renderWithProviders } from "./test-utils";

afterEach(() => vi.unstubAllGlobals());

describe("onboarding quest progress", () => {
  it("shows server step completion separately from command history", async () => {
    useChatState.setState({ commandHistory: ["look", "brief", "next"] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => [
          {
            id: "intro",
            name: "First steps",
            active: true,
            completed: false,
            steps: [
              { id: "a", description: "Look", hint: "look", done: true },
              { id: "b", description: "Introduce yourself", hint: "say hello", done: false },
            ],
          },
        ],
      })),
    );
    renderWithProviders(<QuestProgressCard name="Alice" onFocusChat={() => {}} />);
    const progress = await screen.findByRole("progressbar", { name: "First steps progress" });
    expect(progress).toHaveAttribute("value", "1");
    expect(progress).toHaveAttribute("max", "2");
    expect(screen.getByText("say hello")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Complete quest" })).not.toBeInTheDocument();
  });
  it("offers completion only after all actual quest checks pass", async () => {
    const send = vi.fn(() => true);
    useChatState.setState({ sendCommand: send });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => [
          {
            id: "intro",
            name: "First steps",
            active: true,
            completed: false,
            steps: [{ id: "a", description: "Look", hint: "look", done: true }],
          },
        ],
      })),
    );
    renderWithProviders(<QuestProgressCard name="Alice" onFocusChat={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Complete quest" }));
    expect(send).toHaveBeenCalledWith("quest complete");
  });
});
