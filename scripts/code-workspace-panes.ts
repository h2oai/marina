// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  type Component,
  HStack,
  ScrollView,
  Text,
  truncateToWidth,
  VStack,
} from "@earendil-works/pi-tui";
import type { CodeEditorState } from "./code-editor";
import { MODES, type WorkspaceMode } from "./code-modes";
import { terminalText } from "./code-presentation";
import { styleCodeEntry, themeFor } from "./code-style";
import type { TerminalView } from "./code-views";

export type WorkspaceLayout = "auto" | "focus" | "split";

/** The renderer selects the primary viewport for scrolling and transcript search.
 * Changing that selection must not recreate a viewport or lose its scroll position. */
class PaneScrollView extends ScrollView {
  override primary = false;
}

const LABELS: Record<TerminalView, string> = {
  coding: "Coding",
  world: "World",
  approvals: "Requests",
  panel: "Panel",
};

/** Presentation only. Both panes read the existing bounded histories; neither
 * subscribes, sends a command, changes a session, nor acknowledges a request. */
export class WorkspacePanes {
  readonly component: HStack;
  private focus: TerminalView = "coding";
  private layout: WorkspaceLayout = "auto";
  private mode: WorkspaceMode = "coding";
  private board?: (width: number) => string[];
  private readonly boardScroll: PaneScrollView;
  private boardWidth?: number;
  /** Last width each pane was drawn at; locally drawn cards are sized to it. */
  private widths: Partial<Record<TerminalView, number>> = {};
  private panes = Object.fromEntries(
    Object.keys(LABELS).map((view) => {
      const text = new Text("", 0, 0);
      return [
        view,
        {
          text,
          scroll: new PaneScrollView(text, { follow: "end", scrollbar: "auto" }),
          content: "",
        },
      ];
    }),
  ) as Record<TerminalView, { text: Text; scroll: PaneScrollView; content: string }>;

  constructor() {
    // Coding mode keeps the World to a mentions line unless split is asked for;
    // a board mode sits its board beside the World. Either way from 80 columns.
    const split = ({ width, height }: { width: number; height: number }) =>
      (this.layout === "split" || (this.layout === "auto" && this.hasBoard())) &&
      width >= 80 &&
      height >= 6;
    const boardPane: Component = {
      invalidate() {},
      render: (width: number) => {
        this.boardWidth = width;
        return this.board?.(width) ?? [];
      },
    };
    this.boardScroll = new PaneScrollView(boardPane, { follow: "none", scrollbar: "auto" });
    const pane = (view: TerminalView) =>
      new VStack([
        {
          component: {
            invalidate() {},
            render: (width: number) => {
              this.widths[view] = width;
              return [
                truncateToWidth(
                  `${view === this.focus ? "● " : "  "}${LABELS[view]}${view === this.focus ? " · input here" : view === "world" ? " · F6 to reply" : ""}`,
                  width,
                  "…",
                ),
              ];
            },
          },
          basis: 1,
        },
        { component: this.panes[view].scroll, basis: 0, grow: 1, minSize: 1 },
      ]);
    this.component = new HStack(
      [
        ...(["coding", "approvals", "panel"] as const).map((view) => ({
          component: pane(view),
          basis: 44,
          grow: 2,
          minSize: 1,
          visible: (viewport: { width: number; height: number }) =>
            this.focus === view ||
            (view === "coding" && this.focus === "world" && !this.hasBoard() && split(viewport)),
        })),
        {
          component: new VStack([
            {
              component: {
                invalidate() {},
                render: (width: number) => [
                  truncateToWidth(`  ${MODES[this.mode].label} · live`, width, "…"),
                ],
              },
              basis: 1,
            },
            { component: this.boardScroll, basis: 0, grow: 1, minSize: 1 },
          ]),
          basis: 44,
          grow: 2,
          minSize: 1,
          visible: (viewport: { width: number; height: number }) =>
            this.hasBoard() && this.focus === "world" && split(viewport),
        },
        {
          component: pane("world"),
          basis: 36,
          grow: 1,
          minSize: 1,
          visible: (viewport) => this.focus === "world" || split(viewport),
        },
      ],
      { gap: 2 },
    );
    this.panes.coding.scroll.primary = true;
  }

  private hasBoard(): boolean {
    return !!this.board && MODES[this.mode].board.length > 0;
  }

  update(state: CodeEditorState) {
    this.focus = state.focus;
    this.layout = state.layout ?? "auto";
    this.mode = state.mode ?? "coding";
    this.board = state.board;
    for (const view of Object.keys(LABELS) as TerminalView[]) {
      const pane = this.panes[view];
      pane.scroll.primary = view === state.focus;
      const content = terminalText(
        (view === "coding" || view === "world" ? state.conversations?.[view] : undefined) ??
          (view === state.focus ? (state.transcript ?? "") : pane.content),
      );
      if (content === pane.content) continue;
      // Entries are separated by a blank line; each is styled from its own label.
      const theme = themeFor(process.stdout);
      pane.text.setText(
        theme.level
          ? content
              .split("\n\n")
              .map((entry) => styleCodeEntry(entry, theme, { width: Number.POSITIVE_INFINITY }))
              .join("\n\n")
          : content,
      );
      pane.content = content;
      if (view === "approvals") pane.scroll.scrollToStart();
    }
  }

  /** Columns the pane was last drawn with (minus its scrollbar), or undefined before the first draw. */
  /** Scroll the board (it never takes the composer, so it has its own keys). */
  scrollBoard(lines: number): void {
    this.boardScroll.scrollBy(lines);
  }

  /** Columns the board pane was last drawn with. */
  boardColumns(): number | undefined {
    return this.boardWidth === undefined ? undefined : Math.max(20, this.boardWidth - 1);
  }

  columns(view: TerminalView): number | undefined {
    const width = this.widths[view];
    return width === undefined ? undefined : Math.max(20, width - 1);
  }

  follow() {
    this.panes[this.focus].scroll.scrollToEnd();
  }
}
