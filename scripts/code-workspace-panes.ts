// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { HStack, ScrollView, Text, truncateToWidth, VStack } from "@earendil-works/pi-tui";
import type { CodeEditorState } from "./code-editor";
import { terminalText } from "./code-presentation";
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
    const split = ({ width, height }: { width: number; height: number }) =>
      this.layout !== "focus" && width >= (this.layout === "split" ? 80 : 110) && height >= 6;
    const pane = (view: TerminalView) =>
      new VStack([
        {
          component: {
            invalidate() {},
            render: (width: number) => [
              truncateToWidth(
                `${view === this.focus ? "● " : "  "}${LABELS[view]}${view === this.focus ? " · input here" : view === "world" ? " · F6 to reply" : ""}`,
                width,
                "…",
              ),
            ],
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
            this.focus === view || (view === "coding" && this.focus === "world" && split(viewport)),
        })),
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

  update(state: CodeEditorState) {
    this.focus = state.focus;
    this.layout = state.layout ?? "auto";
    for (const view of Object.keys(LABELS) as TerminalView[]) {
      const pane = this.panes[view];
      pane.scroll.primary = view === state.focus;
      const content = terminalText(
        (view === "coding" || view === "world" ? state.conversations?.[view] : undefined) ??
          (view === state.focus ? (state.transcript ?? "") : pane.content),
      );
      if (content === pane.content) continue;
      pane.text.setText(content);
      pane.content = content;
      if (view === "approvals") pane.scroll.scrollToStart();
    }
  }

  follow() {
    this.panes[this.focus].scroll.scrollToEnd();
  }
}
