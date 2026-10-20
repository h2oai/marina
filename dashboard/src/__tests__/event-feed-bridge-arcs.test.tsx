// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The canvas arcs come from the typed, content-free message events the
 * engine emits (`say_sent`, `tell_sent`): names and a message ref, never the
 * words — so an arc never carries a body.
 */

import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorldState } from "../hooks/use-world-state";
import type { DashboardEvent } from "../lib/types";
import { type AddInteraction, useEventFeedActivity } from "../unified/hooks/use-event-feed-bridge";
import { resetWorldState } from "./test-utils";

const ENTITIES = [
  { id: "e_1", name: "Ada", kind: "agent", room: "zone/lobby", rank: 1 },
  { id: "e_2", name: "Bob", kind: "agent", room: "zone/lobby", rank: 1 },
  { id: "e_3", name: "Cy", kind: "agent", room: "zone/annex", rank: 1 },
] as never;

function Bridge({ addInteraction }: { addInteraction: AddInteraction }) {
  const entities = useWorldState((s) => s.entities);
  useEventFeedActivity(() => {}, addInteraction, entities);
  return null;
}

describe("event feed bridge arcs", () => {
  beforeEach(() => {
    resetWorldState();
    useWorldState.setState({ entities: ENTITIES });
  });

  it("draws a room-local say arc and a cross-room tell arc, without bodies", () => {
    const addInteraction = vi.fn<AddInteraction>();
    render(<Bridge addInteraction={addInteraction} />);
    const now = Date.now();
    act(() =>
      useWorldState.getState().pushEvent({
        type: "say_sent",
        entity: "e_1",
        from: "Ada",
        room: "zone/lobby",
        messageRef: "say:00000000-0000-0000-0000-000000000001",
        depth: 0,
        timestamp: now,
      } as DashboardEvent),
    );
    act(() =>
      useWorldState.getState().pushEvent({
        type: "tell_sent",
        entity: "e_1",
        from: "Ada",
        to: "Cy",
        messageRef: "tell:4",
        cause: "tell:3",
        depth: 1,
        timestamp: now + 1,
      } as DashboardEvent),
    );

    // The say reaches the one other entity in the room (not Cy in the annex).
    expect(addInteraction).toHaveBeenCalledWith("Ada", "Bob", "say");
    expect(addInteraction).not.toHaveBeenCalledWith("Ada", "Cy", "say");
    expect(addInteraction).toHaveBeenCalledWith("Ada", "Cy", "tell", undefined, undefined, {
      recipient: "Cy",
    });
    expect(addInteraction).toHaveBeenCalledTimes(2);
    for (const call of addInteraction.mock.calls) {
      expect(call[5]?.body).toBeUndefined();
    }
  });

  it("processes each typed event once", () => {
    const addInteraction = vi.fn<AddInteraction>();
    render(<Bridge addInteraction={addInteraction} />);
    const event = {
      type: "tell_sent",
      entity: "e_2",
      from: "Bob",
      to: "Ada",
      messageRef: "tell:9",
      depth: 0,
      timestamp: Date.now(),
    } as DashboardEvent;
    act(() => useWorldState.getState().pushEvent(event));
    // An unrelated later event re-runs the bridge; the tell is not redrawn.
    act(() =>
      useWorldState.getState().pushEvent({
        type: "entity_enter",
        entity: "e_3",
        room: "zone/annex",
        timestamp: event.timestamp + 1,
      } as DashboardEvent),
    );
    expect(addInteraction.mock.calls.filter((c) => c[2] === "tell")).toHaveLength(1);
  });
});
