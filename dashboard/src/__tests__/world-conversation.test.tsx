// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { presenceLabel, ResidentsView, RoomLogView } from "../components/WorldConversation";
import { attentionCommand } from "../unified/panels/EntityContext";

const fetchApi = vi.fn();

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  fetchApi: (...args: unknown[]) => fetchApi(...args),
}));

beforeEach(() => {
  fetchApi.mockReset();
});

describe("Streams room view", () => {
  it("renders the room log with reply depth", async () => {
    fetchApi.mockResolvedValue({
      room: "test/start",
      entries: [
        { id: 1, entity: "Ash", kind: "arrive", content: "Ash arrives.", depth: 0, at: 1 },
        { id: 2, entity: "Ash", kind: "say", content: "Ash says: hi", depth: 2, at: 2 },
      ],
    });
    render(<RoomLogView active />);
    expect(await screen.findByText("Ash says: hi")).toBeTruthy();
    expect(screen.getByText("↳2")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "This room · test/start" })).toBeTruthy();
    expect(fetchApi).toHaveBeenCalledWith("/api/routing/room-log?limit=100");
  });

  it("asks a viewer who is not present to join first", async () => {
    fetchApi.mockRejectedValue(new Error("API error: 403"));
    render(<RoomLogView active />);
    expect((await screen.findByRole("alert")).textContent).toContain("Join the world");
  });

  it("does not poll while hidden", async () => {
    render(<RoomLogView active={false} />);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchApi).not.toHaveBeenCalled();
  });
});

describe("Streams residents view", () => {
  it("shows each resident's vendor, presence and wakes", async () => {
    fetchApi.mockResolvedValue({
      residents: [
        {
          name: "Wren",
          vendor: "claude",
          presence: "needs_you",
          room: "test/start",
          wakes: [
            { source: "tell", decision: "now", reason: "request", hop: 1, steered: true, at: 1 },
          ],
        },
      ],
    });
    render(<ResidentsView active />);
    expect(await screen.findByText("Wren [claude]")).toBeTruthy();
    expect(screen.getByText("needs you")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText(/tell → now \(steered\) · request · depth 1/)).toBeTruthy(),
    );
  });

  it("labels presence for people", () => {
    expect(presenceLabel("needs_you")).toBe("needs you");
    expect(presenceLabel("working")).toBe("working");
  });
});

describe("EntityContext attention box", () => {
  it("sends @ lines and resident attention as world commands", () => {
    expect(attentionCommand({ name: "Ash" }, "@all stop")).toBe("@all stop");
    expect(
      attentionCommand(
        { name: "Wren", resident: { vendor: "claude", owner: "Jeff" } },
        "look here",
      ),
    ).toBe("agent attention Wren look here");
    expect(attentionCommand({ name: "Ash" }, "look here")).toBeUndefined();
  });
});
