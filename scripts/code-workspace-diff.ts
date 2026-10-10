// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  type Component,
  matchesKey,
  ScrollView,
  truncateToWidth,
  VStack,
} from "@earendil-works/pi-tui";
import { diffAnchors } from "../src/coding/unified-diff";
import { colorizeDiff, diffColorEnabled } from "./code-diff";
import { terminalText } from "./code-presentation";

/**
 * Fullscreen diff reader for `marina --tui`: n/p jump between files, ]/[
 * between hunks, q returns. Presentation only; it never sends a command.
 */
export class WorkspaceDiffView {
  readonly component: VStack;
  active = false;
  private plain: string[] = [];
  private lines: string[] = [];
  private anchors: { files: number[]; hunks: number[] } = { files: [], hunks: [] };
  private readonly scroll: ScrollView;
  /** Line the reader is on. It can sit below a clamped scroll position near the end. */
  private cursor = 0;

  constructor(private readonly requestRender: () => void) {
    // One output line per diff line (truncated, never wrapped), so a jump
    // target is exactly its line index.
    const body: Component = {
      invalidate() {},
      render: (width) => this.lines.map((line) => truncateToWidth(line, Math.max(1, width), "…")),
    };
    this.scroll = new ScrollView(body, { follow: "none", scrollbar: "auto" });
    this.component = new VStack([
      {
        component: {
          invalidate() {},
          render: (width: number) => [truncateToWidth(this.title(), Math.max(1, width), "…")],
        },
        basis: 1,
      },
      { component: this.scroll, basis: 0, grow: 1, minSize: 1 },
    ]);
  }

  open(text: string) {
    this.plain = terminalText(text).split("\n");
    // Colour is added after sanitising, from the diff structure only.
    this.lines = colorizeDiff(this.plain.join("\n"), diffColorEnabled({ isTTY: true })).split("\n");
    this.anchors = diffAnchors(this.plain);
    this.active = true;
    this.cursor = 0;
    this.scroll.scrollToStart();
    this.requestRender();
  }

  close() {
    this.active = false;
    this.requestRender();
  }

  /** 1-based item in view: the last anchor at or above the top line (the first before any). */
  private position(list: number[]): number {
    const top = this.cursor;
    let index = 0;
    for (let i = 0; i < list.length; i++) if (list[i]! <= top) index = i + 1;
    return list.length ? Math.max(1, index) : 0;
  }

  private title(): string {
    const files = this.anchors.files.length;
    const hunks = this.anchors.hunks.length;
    return `Diff · file ${this.position(this.anchors.files)}/${files} · hunk ${this.position(this.anchors.hunks)}/${hunks} · n/p file · ]/[ hunk · q returns`;
  }

  private jump(list: number[], direction: 1 | -1) {
    const current = this.position(list);
    if (!current) return;
    const top = this.cursor;
    // Back first returns to the start of the item in view, then to the one before it.
    const target =
      direction > 0
        ? list[current]
        : top > list[current - 1]!
          ? list[current - 1]
          : list[current - 2];
    if (target !== undefined) {
      this.cursor = target;
      this.scroll.scrollTo(target, { disableFollow: true });
    } else if (direction < 0) {
      this.cursor = 0;
      this.scroll.scrollToStart();
    }
  }

  /** Every key is consumed while the view is open; only q/Escape leave it. */
  handleInput(data: string): void {
    const page = Math.max(1, this.scroll.viewportHeight - 1);
    if (matchesKey(data, "q") || matchesKey(data, "escape")) {
      this.close();
      return;
    }
    if (matchesKey(data, "n")) this.jump(this.anchors.files, 1);
    else if (matchesKey(data, "p")) this.jump(this.anchors.files, -1);
    else if (matchesKey(data, "]")) this.jump(this.anchors.hunks, 1);
    else if (matchesKey(data, "[")) this.jump(this.anchors.hunks, -1);
    else if (this.scrollKey(data, page))
      this.cursor = matchesKey(data, "end")
        ? Math.max(0, this.lines.length - 1)
        : this.scroll.scrollTop;
    this.requestRender();
  }

  /** Scroll keys move the view; any other key is ignored. */
  private scrollKey(data: string, page: number): boolean {
    if (matchesKey(data, "down") || matchesKey(data, "j")) this.scroll.scrollBy(1);
    else if (matchesKey(data, "up") || matchesKey(data, "k")) this.scroll.scrollBy(-1);
    else if (matchesKey(data, "pageDown") || matchesKey(data, "space")) this.scroll.scrollBy(page);
    else if (matchesKey(data, "pageUp")) this.scroll.scrollBy(-page);
    else if (matchesKey(data, "home")) this.scroll.scrollToStart();
    else if (matchesKey(data, "end")) this.scroll.scrollToEnd();
    else return false;
    return true;
  }
}
