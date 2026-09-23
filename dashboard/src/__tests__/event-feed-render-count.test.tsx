// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Performance fence: an `eventFeed` update must not re-render the unified
 * canvas or the command bar. Before this change both subscribed with
 * `useWorldState((s) => s.eventFeed)`, so every WebSocket event (the store
 * replaces the 200-item array each time) re-rendered the ~2,900- and
 * ~3,250-line components. Now they read the feed through non-reactive
 * `getState()` + `subscribe` bridges (unified/hooks/use-event-feed-bridge.ts,
 * command-bar/EventsTab.tsx) — the pattern WorldMap.tsx documents.
 *
 * Two fences:
 *  1. Render counting with React.Profiler — the OLD pattern (reactive selector)
 *     vs the NEW hooks, on the same event burst, in one test.
 *  2. A static check that neither giant component carries the reactive
 *     selector any more.
 */

import { act, render } from "@testing-library/react";
import { Profiler, type ProfilerOnRenderCallback, useCallback, useMemo } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorldState } from "../hooks/use-world-state";
import type { DashboardEvent } from "../lib/types";
import {
  useEventFeedActivity,
  useLatestRoomMessages,
} from "../unified/hooks/use-event-feed-bridge";
// Source text of the two giants for the static fence (Vite `?raw` import).
import commandBarSource from "../unified/panels/CommandBar.tsx?raw";
import { useBatchedEventFeed } from "../unified/panels/command-bar/EventsTab";
import unifiedCanvasSource from "../unified/UnifiedCanvas.tsx?raw";
import { resetWorldState } from "./test-utils";

const ENTITIES = [
  { id: "e_1", name: "Ada", kind: "agent", room: "zone/lobby", rank: 1 },
  { id: "e_2", name: "Bob", kind: "agent", room: "zone/lobby", rank: 1 },
] as never;

function ev(i: number, type = "command", input = "brief"): DashboardEvent {
  return {
    type,
    timestamp: 1_000_000 + i,
    entity: "e_1",
    room: "zone/lobby",
    input,
  } as DashboardEvent;
}

/** The pre-change shape: a reactive eventFeed selector inside an "expensive" component. */
function OldPattern({ onWork }: { onWork: (n: number) => void }) {
  const eventFeed = useWorldState((s) => s.eventFeed);
  const entities = useWorldState((s) => s.entities);
  const derived = useMemo(() => eventFeed.length + entities.length, [eventFeed, entities]);
  onWork(derived);
  return <div data-testid="old">{derived}</div>;
}

/** The post-change shape: the same consumers, via the non-reactive bridge hooks. */
function NewPattern({ onWork }: { onWork: (n: number) => void }) {
  const entities = useWorldState((s) => s.entities);
  const logActivity = useCallback(() => {}, []);
  const addInteraction = useCallback(() => {}, []);
  useEventFeedActivity(logActivity, addInteraction, entities);
  const resolveName = useCallback((id: string) => id, []);
  const rooms = useLatestRoomMessages(resolveName);
  onWork(entities.length);
  return <div data-testid="new">{Object.keys(rooms).length}</div>;
}

function counter() {
  let renders = 0;
  const onRender: ProfilerOnRenderCallback = () => {
    renders += 1;
  };
  return {
    onRender,
    get renders() {
      return renders;
    },
  };
}

describe("eventFeed updates and re-renders", () => {
  beforeEach(() => {
    resetWorldState();
    useWorldState.setState({ entities: ENTITIES });
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  it("old reactive selector re-renders once per event; new bridge hooks do not re-render", () => {
    const oldCount = counter();
    const newCount = counter();
    const oldWork = vi.fn();
    const newWork = vi.fn();
    render(
      <>
        <Profiler id="old" onRender={oldCount.onRender}>
          <OldPattern onWork={oldWork} />
        </Profiler>
        <Profiler id="new" onRender={newCount.onRender}>
          <NewPattern onWork={newWork} />
        </Profiler>
      </>,
    );
    const oldBase = oldCount.renders;
    const newBase = newCount.renders;
    const oldWorkBase = oldWork.mock.calls.length;
    const newWorkBase = newWork.mock.calls.length;

    const BURST = 25;
    // One act() per event: each is a separate WebSocket message in production.
    for (let i = 0; i < BURST; i++) {
      act(() => useWorldState.getState().pushEvent(ev(i)));
    }

    // Before: one commit + one body evaluation per event.
    expect(oldCount.renders - oldBase).toBe(BURST);
    expect(oldWork.mock.calls.length - oldWorkBase).toBe(BURST);
    // After: the feed went through the bridge without a single re-render.
    expect(newCount.renders - newBase).toBe(0);
    expect(newWork.mock.calls.length - newWorkBase).toBe(0);
    // …and the bridge still saw every event (watermark advanced).
    expect(useWorldState.getState().eventFeed.length).toBe(BURST);
  });

  it("re-renders exactly once when a room-message pill actually changes", () => {
    const count = counter();
    const work = vi.fn();
    render(
      <Profiler id="new" onRender={count.onRender}>
        <NewPattern onWork={work} />
      </Profiler>,
    );
    const base = count.renders;
    // Ten unrelated events → no render; then one in-room `say` → one pill → one render.
    for (let i = 0; i < 10; i++) {
      act(() => useWorldState.getState().pushEvent(ev(i)));
    }
    expect(count.renders - base).toBe(0);
    act(() =>
      useWorldState.getState().pushEvent({
        ...ev(100, "say", "say hello there"),
        timestamp: Date.now(),
      }),
    );
    expect(count.renders - base).toBe(1);
    // A second unrelated event after the pill: still no extra render.
    act(() => useWorldState.getState().pushEvent({ ...ev(101), timestamp: Date.now() + 1 }));
    expect(count.renders - base).toBe(1);
  });

  it("EventsTab's batched feed collapses a burst into one state update", () => {
    let renders = 0;
    function Harness() {
      renders += 1;
      const feed = useBatchedEventFeed();
      return <div>{feed.length}</div>;
    }
    // Defer rAF so the burst lands before the flush.
    const queued: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      queued.push(cb);
      return queued.length;
    });
    render(<Harness />);
    const base = renders;
    act(() => {
      for (let i = 0; i < 30; i++) useWorldState.getState().pushEvent(ev(i));
    });
    expect(renders - base).toBe(0);
    act(() => {
      for (const cb of queued.splice(0)) cb(0);
    });
    expect(renders - base).toBe(1);
  });

  it("neither giant component subscribes to eventFeed reactively (static fence)", () => {
    for (const [name, src] of [
      ["UnifiedCanvas.tsx", unifiedCanvasSource],
      ["CommandBar.tsx", commandBarSource],
    ] as const) {
      expect(src.length, name).toBeGreaterThan(1000);
      expect(src, name).not.toMatch(/useWorldState\(\s*\(s\)\s*=>\s*s\.eventFeed\s*\)/);
    }
  });
});
