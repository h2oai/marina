// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { TERMINAL_HISTORY_LIMITS, TerminalViews } from "../scripts/code-views";

test("latest resumes one conversation without losing other history, unread activity or retention evidence", () => {
  for (const focus of ["coding", "world"] as const) {
    for (const pageEntries of [1, 2, 5]) {
      const other = focus === "coding" ? "world" : "coding";
      const views = new TerminalViews({
        ...TERMINAL_HISTORY_LIMITS,
        entries: 16,
        perView: 8,
        pageEntries,
      });
      for (let index = 0; index < 20; index++) {
        views.append(focus, `${focus}-${index}`);
        views.append(other, `${other}-${index}`);
      }
      views.select(other);
      views.page("older");
      views.append(other, "Other unseen activity");
      const otherPage = views.snapshot(other);
      views.select(focus);
      views.page("older");
      views.append(focus, "Newest result");
      const before = views.stats();
      expect(before.unread[focus]).toBe(1);
      expect(views.snapshot(focus)).not.toContain("Newest result");
      const latest = views.latest();
      expect(latest).toContain("Newest result");
      expect(latest).toContain("recent local history");
      expect(views.snapshot(other)).toBe(otherPage);
      expect(views.stats()).toEqual({ ...before, unread: { ...before.unread, [focus]: 0 } });
      expect(views.focus).toBe(focus);
      expect(views.latest()).toBe(latest);
      expect(views.append(focus, "Still following").visible).toBe(true);
      for (const detail of ["approvals", "panel"] as const) {
        views.select(detail);
        const beforeDetail = views.stats();
        const conversation = views.snapshot(focus);
        expect(views.latest()).toContain("F6 returns to conversations");
        expect(views.focus).toBe(detail);
        expect(views.stats()).toEqual(beforeDetail);
        expect(views.snapshot(focus)).toBe(conversation);
        expect(views.snapshot(other)).toBe(otherPage);
      }
    }
  }
});

test("latest is safe before any output has arrived", () => {
  const views = new TerminalViews();
  const before = views.stats();
  expect(views.latest()).toContain("No output received");
  expect(views.stats()).toEqual(before);
});
