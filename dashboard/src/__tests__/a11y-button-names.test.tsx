// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Every rendered <button> in the largest owned panels must have an accessible
 * name (text content, aria-label or aria-labelledby). A `title` alone is not
 * an accessible name for assistive tech, so icon/glyph-only buttons need an
 * explicit label — this test is the regression fence for that sweep.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LogExplorer } from "../components/LogExplorer";
import { NarrativePlayback } from "../components/NarrativePlayback";
import { ThemeSwitcher } from "../components/ThemeSwitcher";
import { useFeedState } from "../hooks/use-feed-state";
import { useWorldState } from "../hooks/use-world-state";
import type { FeedEvent } from "../lib/types";
import { CanvasBreadcrumb } from "../unified/overlays/CanvasBreadcrumb";
import { LayerChips } from "../unified/overlays/LayerChips";
import { ShortcutHelp } from "../unified/overlays/ShortcutHelp";
import { TimelineStrip } from "../unified/overlays/TimelineStrip";
import { TopbarNotices } from "../unified/overlays/TopbarNotices";
import { ContextPanel } from "../unified/panels/ContextPanel";
import { EntityPanel } from "../unified/panels/EntityPanel";
import { MessageRow } from "../unified/panels/MessageRow";
import { WorldNav } from "../unified/panels/WorldNav";
import { renderWithProviders, resetWorldState } from "./test-utils";

const useLogs = vi.fn();
vi.mock("../hooks/use-api", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../hooks/use-api");
  return {
    ...actual,
    useLogs: (...args: unknown[]) => useLogs(...args),
    logQueryString: () => "limit=100",
    useEntityDetail: () => ({ data: undefined, isLoading: false }),
    useRoomDetail: () => ({ data: undefined, isLoading: false }),
    useNoteDetail: () => ({ data: undefined, isLoading: false }),
    useCanvasNodeDetail: () => ({ data: undefined, isLoading: false }),
    useModelCatalog: () => ({ data: undefined, isLoading: false }),
    useRoles: () => ({ data: [], isLoading: false }),
    useAgents: () => ({ data: [], isLoading: false, refetch: vi.fn() }),
  };
});
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/api");
  return {
    ...actual,
    fetchApi: vi.fn().mockResolvedValue({}),
    postApi: vi.fn().mockResolvedValue({}),
    describeApiError: (error: unknown) => String(error),
    downloadApi: vi.fn(),
  };
});

/**
 * Assert every button in `container` has a non-empty accessible name.
 * `getAllByRole("button", { name })` matches on the computed accessible name
 * (text content, aria-label, aria-labelledby — NOT title), so any button
 * present in the unfiltered query but absent from the name-filtered one has
 * no accessible name.
 */
function expectAllButtonsNamed(container: HTMLElement, label: string) {
  const all = within(container).queryAllByRole("button");
  const named = new Set(within(container).queryAllByRole("button", { name: /\S/ }));
  const unnamed = all
    .filter((b) => !named.has(b))
    .map(
      (b) =>
        `${label}: <${b.tagName.toLowerCase()} class="${b.className}">${b.innerHTML.slice(0, 60)}`,
    );
  expect(unnamed, `unnamed buttons in ${label}`).toEqual([]);
  return all.length;
}

const feedEvent = (i: number, kind = "task_claimed"): FeedEvent =>
  ({
    id: i,
    kind,
    summary: `event ${i}`,
    timestamp: Date.now() - i * 1000,
    entity: "Ada",
    ref: i % 2 ? `request:trace-${i}` : null,
    payload: {},
  }) as unknown as FeedEvent;

describe("accessible button names", () => {
  beforeEach(() => {
    resetWorldState();
    useLogs.mockReturnValue({
      data: {
        logs: Array.from({ length: 3 }, (_, i) => ({
          id: i + 1,
          timestamp: 1000 + i,
          level: "info",
          category: "engine",
          message: `log ${i}`,
          traceId: `trace-${i}`,
        })),
        page: { limit: 100, hasMore: true, nextCursor: "c2" },
        source: "structured_logs",
        retention: 10_000,
        otlp: { enabled: false, pendingLogs: 0, exportedLogs: 0 },
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
  });

  it("LogExplorer (including expanded rows)", () => {
    const { container } = render(<LogExplorer />);
    fireEvent.click(screen.getByText("log 0"));
    expect(expectAllButtonsNamed(container, "LogExplorer")).toBeGreaterThan(4);
  });

  it("NarrativePlayback transport controls", () => {
    useFeedState.setState({ events: [feedEvent(1), feedEvent(2)] });
    const { container } = renderWithProviders(<NarrativePlayback />);
    expect(expectAllButtonsNamed(container, "NarrativePlayback")).toBeGreaterThanOrEqual(3);
    expect(screen.getByRole("button", { name: "Previous event" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next event" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /play timeline|pause playback/i })).toHaveAttribute(
      "aria-pressed",
    );
  });

  it("ThemeSwitcher trigger and options", () => {
    const { container } = render(<ThemeSwitcher />);
    fireEvent.click(screen.getByRole("button", { name: /switch theme/i }));
    // The trigger is the only <button role=button>; the menu entries are
    // role="option" — each must be named too.
    expect(expectAllButtonsNamed(container, "ThemeSwitcher")).toBe(1);
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(5);
    expect(screen.getAllByRole("option", { name: /\S/ })).toHaveLength(options.length);
  });

  it("TimelineStrip filter chips", () => {
    useFeedState.setState({ events: [feedEvent(1), feedEvent(2, "board_post")], kindFilter: null });
    const { container } = render(<TimelineStrip />);
    expectAllButtonsNamed(container, "TimelineStrip");
    useFeedState.setState({ kindFilter: "board_post" });
    expectAllButtonsNamed(container, "TimelineStrip(filtered)");
  });

  it("unified overlays: layer chips carry aria-pressed, breadcrumb/notices/help are named", () => {
    const onToggle = vi.fn();
    const { container } = render(
      <>
        <LayerChips
          hidden={{ world: false, canvas: true, graph: false, feed: false, memory: true }}
          onToggle={onToggle}
          onApply={vi.fn()}
        />
        <CanvasBreadcrumb
          canvasList={[
            { id: "g", name: "global" },
            { id: "a", name: "alice's canvas" },
          ]}
          activeCanvasId="a"
          onSelectCanvas={vi.fn()}
        />
        <TopbarNotices
          canvasWsStatus="reconnecting"
          canvasLoading
          canvasError="boom"
          onRetryCanvas={vi.fn()}
        />
        <ShortcutHelp onClose={vi.fn()} />
      </>,
    );
    expect(expectAllButtonsNamed(container, "overlays")).toBeGreaterThanOrEqual(8);
    const world = screen.getByRole("button", { name: /WORLD layer/ });
    expect(world).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /CANVAS layer/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    fireEvent.click(world);
    expect(onToggle).toHaveBeenCalledWith("world", true);
    const dialog = screen.getByRole("dialog", { name: "KEYBOARD SHORTCUTS" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("toolbar", { name: "Layer visibility" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Return to global canvas" })).toBeInTheDocument();
  });

  it("unified panels: EntityPanel, WorldNav, ContextPanel header, MessageRow", () => {
    useWorldState.setState({
      rooms: [
        {
          id: "zone/lobby",
          short: "Lobby",
          district: "zone",
          exits: {},
          entityCount: 1,
        },
      ] as never,
      entities: [{ id: "e_1", name: "Ada", kind: "agent", room: "zone/lobby", rank: 1 }] as never,
    });
    const { container } = renderWithProviders(
      <>
        <EntityPanel visible onClose={vi.fn()} onEntityClick={vi.fn()} sendCommand={vi.fn()} />
        <WorldNav
          visible
          districts={["zone"]}
          hiddenDistricts={new Set<string>()}
          toggleDistrict={vi.fn()}
          hideEmptyRooms={false}
          setHideEmptyRooms={vi.fn()}
          canvasList={[]}
          activeCanvasId={null}
          setSelectedCanvasId={vi.fn()}
          roomCount={1}
          entityCount={1}
          connectionCount={1}
          rooms={[]}
          roomPositions={{}}
          onHome={vi.fn()}
          onZoomIn={vi.fn()}
          onZoomOut={vi.fn()}
        />
        <ContextPanel
          type="room"
          id="zone/lobby"
          anchorPos={null}
          onClose={vi.fn()}
          onEntityClick={vi.fn()}
          onRoomClick={vi.fn()}
          onNoteClick={vi.fn()}
          onVisitEntityCanvas={vi.fn()}
          sendCommand={vi.fn()}
        />
        <MessageRow
          msg={{
            id: 1,
            name: "Ada",
            text: "hi",
            isSys: false,
            type: "tell",
            time: 0,
            tell: { from: "Ada", to: "Bob" },
          }}
          onEntityClick={vi.fn()}
        />
      </>,
    );
    expect(expectAllButtonsNamed(container, "unified panels")).toBeGreaterThan(4);
    expect(screen.getByRole("button", { name: "Close context panel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close entity panel" })).toBeInTheDocument();
  });
});
