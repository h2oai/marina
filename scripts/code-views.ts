// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Perception } from "../src/sdk/client";
import { terminalText } from "./code-presentation";

export type ConversationView = "coding" | "world";
export type TerminalView = ConversationView | "approvals" | "panel";
export type TranscriptView = ConversationView | "all";

export const TERMINAL_HISTORY_LIMITS = {
  entries: 400,
  perView: 200,
  totalBytes: 512 * 1024,
  entryBytes: 16 * 1024,
  pageEntries: 12,
  pageBytes: 24 * 1024,
};

/** Only protocol metadata categorizes output. Unstructured notices stay visible. */
export function perceptionView(p: Perception): TranscriptView {
  if (p.data?.code && typeof p.data.code === "object") return "coding";
  if (p.kind === "room" || p.kind === "movement") return "world";
  if (
    [
      "tell",
      "say",
      "shout",
      "emote",
      "broadcast",
      "channel",
      "connect",
      "disconnect",
      "move",
      "leave",
    ].includes(p.tag ?? "")
  )
    return "world";
  return "all";
}

interface Entry {
  sequence: number;
  view: TranscriptView;
  text: string;
  bytes: number;
}

function clipped(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  const notice = "\n[Local history excerpt truncated; inspect the original output or artifact.]";
  const end = Math.max(0, maxBytes - Buffer.byteLength(notice));
  // Do not split a UTF-8 character while retaining a bounded excerpt.
  let boundary = end;
  while (boundary > 0 && (bytes[boundary]! & 0xc0) === 0x80) boundary--;
  return bytes.subarray(0, boundary).toString("utf8") + notice;
}

/** Ephemeral projection only: no message authority, durable history, or replay of actions. */
export class TerminalViews {
  focus: TerminalView = "coding";
  private entries: Entry[] = [];
  private bytes = 0;
  private sequence = 0;
  private unread = { coding: 0, world: 0 };
  private evicted = { coding: 0, world: 0, all: 0 };
  private pageEnd: Record<ConversationView, number | undefined> = {
    coding: undefined,
    world: undefined,
  };

  constructor(private limits = TERMINAL_HISTORY_LIMITS) {
    for (const limit of Object.values(limits))
      if (!Number.isSafeInteger(limit) || limit <= 0)
        throw new Error("Terminal history limits must be positive integers");
    if (limits.entryBytes < 128)
      throw new Error("Terminal history entries need at least 128 bytes");
  }

  append(view: TranscriptView, text: string): { visible: boolean; firstUnread: boolean } {
    const retained = clipped(terminalText(text), this.limits.entryBytes);
    this.entries.push({
      view,
      sequence: ++this.sequence,
      text: retained,
      bytes: Buffer.byteLength(retained),
    });
    this.bytes += this.entries.at(-1)!.bytes;
    while (
      this.entries.length > this.limits.entries ||
      this.bytes > this.limits.totalBytes ||
      this.entries.filter((entry) => entry.view === view).length > this.limits.perView
    ) {
      const removed = this.entries.shift()!;
      this.bytes -= removed.bytes;
      this.evicted[removed.view]++;
    }
    const visible = view === "all" || (view === this.focus && this.pageEnd[view] === undefined);
    const firstUnread = view !== "all" && !visible && this.unread[view] === 0;
    if (view !== "all" && !visible) this.unread[view] = Math.min(9999, this.unread[view] + 1);
    return { visible, firstUnread };
  }

  badge(questions: number): string {
    const count = (value: number) => (value > 999 ? "999+" : String(value));
    return `[C${this.focus === "coding" ? "*" : ""}:${count(this.unread.coding)} W${this.focus === "world" ? "*" : ""}:${count(this.unread.world)} A${this.focus === "approvals" ? "*" : ""}:${questions}]`;
  }

  navigation(questions: number): string {
    const label = (view: TerminalView, name: string, count: number) =>
      `${view === this.focus ? "● " : ""}${name}${count ? ` (${count})` : ""}`;
    return `${label("coding", "Coding", this.unread.coding)}  ·  ${label("world", "World", this.unread.world)}  ·  ${label("approvals", "Requests", questions)}  ·  ${label("panel", "Panel", 0)}`;
  }

  select(view: TerminalView): void {
    this.focus = view;
    if (view !== "approvals" && view !== "panel" && this.pageEnd[view] === undefined)
      this.unread[view] = 0;
  }

  /** Return to live local output without moving the other conversation's history. */
  latest(): string {
    if (this.focus === "approvals" || this.focus === "panel") return this.page("newer");
    this.pageEnd[this.focus] = undefined;
    this.unread[this.focus] = 0;
    return this.snapshot(this.focus);
  }

  page(direction: "older" | "newer"): string {
    if (this.focus === "panel")
      return "This view shows the current publication. /panel refresh reloads it; F6 returns to conversations.";
    if (this.focus === "approvals")
      return "Approval details are attached to the pending request; F6 returns to conversations.";
    const view = this.focus;
    const entries = this.forView(view);
    const current = this.pageEntries(view);
    if (direction === "older") {
      const previous = entries.filter((entry) => entry.sequence < (current[0]?.sequence ?? 0));
      if (!previous.length) return "No earlier entries are retained in this local view.";
      this.pageEnd[view] = previous.at(-1)!.sequence;
    } else {
      const next = entries.filter((entry) => entry.sequence > (current.at(-1)?.sequence ?? 0));
      let bytes = 0;
      let count = 0;
      for (const entry of next) {
        if (
          count &&
          (count >= this.limits.pageEntries || bytes + entry.bytes > this.limits.pageBytes)
        )
          break;
        bytes += entry.bytes;
        count++;
      }
      this.pageEnd[view] = count < next.length ? next[count - 1]!.sequence : undefined;
      if (this.pageEnd[view] === undefined) this.unread[view] = 0;
    }
    return this.snapshot(view);
  }

  snapshot(view: ConversationView, workspace = false): string {
    const omitted = this.evicted[view] + this.evicted.all;
    const entries = this.pageEntries(view);
    return [
      `[${view === "coding" ? "Coding" : "World"} · ${this.pageEnd[view] === undefined ? "recent" : "earlier"} local history]`,
      ...(omitted
        ? [
            `[${omitted} earlier entries evicted from this view; this is not complete server history.]`,
          ]
        : []),
      entries.map((entry) => entry.text).join("\n\n") || "No output received in this view yet.",
      ...(workspace
        ? []
        : ["[/view older | /view newer · F6 switches conversations · F7 opens pending requests]"]),
    ].join("\n");
  }

  stats() {
    return {
      entries: this.entries.length,
      bytes: this.bytes,
      unread: { ...this.unread },
      evicted: { ...this.evicted },
    };
  }

  private forView(view: ConversationView): Entry[] {
    return this.entries.filter((entry) => entry.view === view || entry.view === "all");
  }

  private pageEntries(view: ConversationView): Entry[] {
    const entries = this.forView(view).filter(
      (entry) => entry.sequence <= (this.pageEnd[view] ?? Infinity),
    );
    const page: Entry[] = [];
    let bytes = 0;
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]!;
      if (
        page.length &&
        (page.length >= this.limits.pageEntries || bytes + entry.bytes > this.limits.pageBytes)
      )
        break;
      page.unshift(entry);
      bytes += entry.bytes;
    }
    return page;
  }
}
