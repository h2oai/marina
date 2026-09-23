// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `/who/<name>` at phone width (≤ 640 px). jsdom has no layout engine, so the
 * narrow layout is pinned two ways: the `matchMedia`-driven bits (sigil size,
 * copy-button label) via a mocked media query, and the CSS-driven bits via the
 * responsive class contract (single column below `sm:`, wrapping / clipping
 * classes on every long-text surface, `max-width: 100%` on images).
 */

import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntityProfile } from "../who/types";
import { NARROW_LAYOUT_QUERY } from "../who/types";
import { renderWithProviders } from "./test-utils";

vi.mock("../lib/api", () => ({
  fetchApi: vi.fn(),
}));

import { fetchApi } from "../lib/api";
import { WhoPage } from "../who/WhoPage";

const LONG_ID = `e_${"0123456789abcdef".repeat(6)}`;

function profile(): EntityProfile {
  return {
    identity: {
      local_id: LONG_ID,
      id_stability: "durable",
      name: "Alice",
      kind: "agent",
      role: "guide",
      rank: 2,
      standing: 17.5,
      first_seen: Date.now() - 86_400_000,
      last_active: Date.now() - 60_000,
      online: true,
      spawned_by: null,
      identity_assurance: "internal_agent",
    },
    bio: {
      goal: "Help newcomers",
      model: "marina/default",
      traits: ["curious"],
      operator_bio: null,
    },
    narratives: [
      {
        id: 7,
        created_at: Date.now() - 3_600_000,
        kind: "narrative",
        source: "chronicler",
        title: "First light",
        body: `Alice arrived and ${"verylongunbrokenword".repeat(8)}`,
        participants: ["Alice", "Bob"],
        refs: ["chronicle:1", `task:${"x".repeat(80)}`],
        period: null,
        supersedes: null,
      },
    ],
    achievements: [
      { id: "rank-1", title: "Rank 1", description: "Crossed 5 standing", achieved_at: 1 },
    ],
    stats: {
      chronicle_citations: { event: 0, narrative: 1, digest: 0, correction: 0 },
      chronicle_citations_total: 1,
      rooms_visited: 1,
      unique_commands: 2,
      entities_interacted: 3,
      total_actions: 4,
      competence_gates_passed: 0,
      days_active: 1,
    },
    connections: [{ name: "Bob", co_chronicles: 1 }],
  };
}

/** Install a matchMedia mock that answers `narrow` for the page's query. */
function mockMatchMedia(narrow: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const impl = (query: string) => ({
    matches: query === NARROW_LAYOUT_QUERY ? narrow : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb),
    dispatchEvent: () => false,
  });
  // test-setup.ts defines `matchMedia` writable but non-configurable: assign, don't redefine.
  (window as unknown as { matchMedia: unknown }).matchMedia = impl;
  return {
    resize(toNarrow: boolean) {
      for (const cb of listeners) cb({ matches: toNarrow } as MediaQueryListEvent);
    },
  };
}

describe("WhoPage narrow layout", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/who/Alice");
    vi.mocked(fetchApi).mockResolvedValue(profile());
    document.title = "Marina — Mission Control";
  });
  afterEach(() => {
    vi.mocked(fetchApi).mockReset();
  });

  it("renders a single column at ≤ 640 px with no fixed-width surfaces and a compact sigil", async () => {
    mockMatchMedia(true);
    renderWithProviders(<WhoPage />);
    await screen.findByRole("heading", { level: 1, name: "Alice" });

    // Sigil: compact size, announced, never wider than its box.
    const sigil = screen.getByRole("img", { name: "Sigil of Alice" });
    expect(sigil).toHaveAttribute("width", "64");
    expect(sigil.getAttribute("class")).toContain("max-w-full");

    // Identity block stacks (flex-col) and only goes side-by-side from `sm:`.
    const identity = screen.getByTestId("who-identity");
    expect(identity.className).toMatch(/\bflex-col\b/);
    expect(identity.className).toMatch(/\bsm:flex-row\b/);

    // Stats/achievements/connections: one column until `md:`.
    const grid = screen.getByTestId("who-stats-grid");
    expect(grid.className).toMatch(/\bgrid-cols-1\b/);
    expect(grid.className).toMatch(/\bmd:grid-cols-3\b/);

    // The page root clips horizontal overflow and caps images at 100%.
    const main = screen.getByTestId("who-profile");
    expect(main.className).toContain("overflow-x-hidden");
    expect(main.className).toContain("[&_img]:max-w-full");

    // Long unbroken strings are allowed to break instead of forcing a scrollbar.
    expect(screen.getByText(`Local ID · ${LONG_ID}`).parentElement?.className).toContain(
      "break-all",
    );
    expect(screen.getByText(/verylongunbrokenword/).className).toContain("break-words");
    expect(screen.getByText(/^refs:/).parentElement?.className).toContain("break-all");

    // Nothing declares a fixed pixel min-width wider than a phone.
    for (const el of Array.from(main.querySelectorAll<HTMLElement>("*"))) {
      const cls = el.className;
      if (typeof cls !== "string") continue;
      expect(cls).not.toMatch(/\bmin-w-\[[0-9]{4,}px\]/);
      expect(cls).not.toMatch(/\bw-\[[0-9]{4,}px\]/);
    }
  });

  it("gives every button an accessible name and shortens the copy label when narrow", async () => {
    const media = mockMatchMedia(true);
    renderWithProviders(<WhoPage />);
    await screen.findByRole("heading", { level: 1, name: "Alice" });

    for (const button of screen.getAllByRole("button")) {
      const name =
        button.getAttribute("aria-label") ?? button.getAttribute("title") ?? button.textContent;
      expect(name?.trim().length ?? 0).toBeGreaterThan(0);
    }
    const copy = screen.getByRole("button", { name: "Copy canonical profile link" });
    expect(copy).toHaveTextContent("Copy link");

    // Widening past the breakpoint restores the long label and the full sigil.
    media.resize(false);
    await waitFor(() => expect(copy).toHaveTextContent("Copy canonical profile link"));
    expect(screen.getByRole("img", { name: "Sigil of Alice" })).toHaveAttribute("width", "88");
  });

  it("sets the document title from the entity name", async () => {
    mockMatchMedia(false);
    renderWithProviders(<WhoPage />);
    await screen.findByRole("heading", { level: 1, name: "Alice" });
    expect(document.title).toBe("Alice — Marina");
  });

  it("uses the wide layout when the media query does not match", async () => {
    mockMatchMedia(false);
    renderWithProviders(<WhoPage />);
    await screen.findByRole("heading", { level: 1, name: "Alice" });
    expect(screen.getByRole("img", { name: "Sigil of Alice" })).toHaveAttribute("width", "88");
    expect(screen.getByRole("button", { name: "Copy canonical profile link" })).toHaveTextContent(
      "Copy canonical profile link",
    );
  });
});
