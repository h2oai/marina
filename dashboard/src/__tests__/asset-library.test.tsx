// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { gridGeometry } from "../components/media/AssetGrid";
import { AssetLibrary } from "../components/media/AssetLibrary";
import { MediaViewerProvider } from "../components/media/MediaViewer";
import { useChatState } from "../hooks/use-chat-state";
import { assetIdFromUrl, type LibraryItem, libraryQueryString } from "../lib/asset-library";
import {
  EMPTY_SELECTION,
  gridMove,
  pruneSelection,
  selectAll,
  selectClick,
} from "../lib/asset-selection";
import { renderWithProviders } from "./test-utils";

const authFetch = vi.fn();
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  authFetch: (...args: unknown[]) => authFetch(...args),
}));

function item(id: string, over: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id,
    filename: `${id}.png`,
    mime: "image/png",
    type: "image",
    size: 1000,
    owner: "Ada",
    origin: "upload",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    sha256: null,
    width: 64,
    height: 64,
    durationMs: null,
    pages: null,
    caption: null,
    alt: null,
    tags: [],
    provenance: null,
    url: `/assets/${id}.png`,
    urlExpiresAt: null,
    thumbs: {},
    thumb: { url: `/assets/${id}.png`, expiresAt: null, width: 64, height: 64 },
    placeholder: null,
    derivativeState: "done",
    derivativeNote: null,
    derivedFrom: null,
    ...over,
  };
}

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

const facets = {
  type: { image: 3, video: 1 },
  origin: { upload: 3, generated: 1 },
  owner: { Ada: 3, Bob: 1 },
  tag: { moodboard: 2, draft: 1 },
  total: 4,
  truncated: false,
};

/** Library GETs observed, as parsed query params. */
function libraryCalls(): URLSearchParams[] {
  return authFetch.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.includes("/api/assets?"))
    .map((url) => new URL(url).searchParams);
}

let pages: Record<string, { items: LibraryItem[]; nextCursor: string | null }>;

beforeEach(() => {
  authFetch.mockReset();
  localStorage.clear();
  useChatState.setState({ entityName: "Ada" });
  pages = {
    first: { items: [item("a1"), item("a2"), item("a3")], nextCursor: null },
  };
  authFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes("/api/assets?")) {
      const params = new URL(url).searchParams;
      const page = pages[params.get("cursor") ?? "first"] ?? { items: [], nextCursor: null };
      return json({ ...page, ...(params.get("facets") ? { facets } : {}) });
    }
    if (/\/api\/assets\/[^/]+$/.test(url) && init?.method === "PATCH")
      return json({ ...item("x"), parents: [], children: [], usedIn: [] });
    if (/\/api\/assets\/[^/]+$/.test(url) && init?.method === "DELETE") return json({ ok: true });
    return json({}, 404);
  });
});

function renderLibrary() {
  return renderWithProviders(
    <MediaViewerProvider>
      <AssetLibrary />
    </MediaViewerProvider>,
  );
}

describe("library query contract", () => {
  it("builds the library query string (empty filters omitted, tags repeated)", () => {
    const qs = new URLSearchParams(
      libraryQueryString(
        { type: "image", owner: "me", tags: ["a", "b"], q: " fox ", sort: "name", since: "7d" },
        { cursor: "c1", facets: true },
      ),
    );
    expect(qs.get("view")).toBe("library");
    expect(qs.get("type")).toBe("image");
    expect(qs.get("owner")).toBe("me");
    expect(qs.getAll("tag")).toEqual(["a", "b"]);
    expect(qs.get("q")).toBe("fox");
    expect(qs.get("sort")).toBe("name");
    expect(qs.get("since")).toBe("7d");
    expect(qs.get("cursor")).toBe("c1");
    expect(qs.get("facets")).toBe("1");
    const bare = new URLSearchParams(libraryQueryString({ owner: "all", sort: "new" }));
    expect(bare.has("owner")).toBe(false);
    expect(bare.has("sort")).toBe(false);
    expect(bare.has("facets")).toBe(false);
  });

  it("reads asset ids from asset URLs", () => {
    expect(assetIdFromUrl("/assets/abc.png?p=x&exp=1&sig=y")).toBe("abc");
    expect(assetIdFromUrl("https://h/assets/abc")).toBe("abc");
    expect(assetIdFromUrl("/other/abc.png")).toBeUndefined();
  });

  it("lays the grid out by width", () => {
    expect(gridGeometry(0, "grid").columns).toBeGreaterThan(1);
    expect(gridGeometry(100, "grid").columns).toBe(1);
    expect(gridGeometry(800, "list")).toMatchObject({ columns: 1, rowHeight: 56 });
  });
});

describe("selection model", () => {
  const order = ["a", "b", "c", "d", "e"];
  it("click selects one, toggle adds/removes, shift selects a range from the anchor", () => {
    let s = selectClick(EMPTY_SELECTION, "b", order);
    expect([...s.selected]).toEqual(["b"]);
    s = selectClick(s, "d", order, { shift: true });
    expect([...s.selected]).toEqual(["b", "c", "d"]);
    // Shift from the same anchor backwards replaces the range.
    s = selectClick(s, "a", order, { shift: true });
    expect([...s.selected].sort()).toEqual(["a", "b"]);
    s = selectClick(s, "e", order, { toggle: true });
    expect([...s.selected].sort()).toEqual(["a", "b", "e"]);
    s = selectClick(s, "e", order, { toggle: true });
    expect(s.selected.has("e")).toBe(false);
    // Ctrl+Shift adds a range to the existing selection.
    s = selectClick({ selected: new Set(["a"]), anchor: "c" }, "e", order, {
      shift: true,
      toggle: true,
    });
    expect([...s.selected].sort()).toEqual(["a", "c", "d", "e"]);
  });

  it("select-all and pruning", () => {
    const all = selectAll(order);
    expect(all.selected.size).toBe(5);
    const pruned = pruneSelection(all, ["a", "b"]);
    expect([...pruned.selected]).toEqual(["a", "b"]);
    expect(pruneSelection(pruned, ["a", "b"])).toBe(pruned);
  });

  it("moves through a grid with arrows, Home/End and pages", () => {
    expect(gridMove("ArrowRight", 0, 10, 4)).toBe(1);
    expect(gridMove("ArrowDown", 1, 10, 4)).toBe(5);
    expect(gridMove("ArrowDown", 8, 10, 4)).toBe(9);
    expect(gridMove("ArrowUp", 1, 10, 4)).toBe(0);
    expect(gridMove("End", 0, 10, 4)).toBe(9);
    expect(gridMove("Home", 7, 10, 4)).toBe(0);
    expect(gridMove("x", 0, 10, 4)).toBeNull();
  });
});

describe("AssetLibrary", () => {
  it("loads the first page with facets and shows the items", async () => {
    renderLibrary();
    const grid = await screen.findByRole("listbox", { name: /Assets/ });
    expect(within(grid).getAllByRole("option")).toHaveLength(3);
    expect(libraryCalls()[0]?.get("facets")).toBe("1");
    const filters = screen.getByRole("navigation", { name: "Asset filters" });
    expect(within(filters).getByText("4 visible")).toBeInTheDocument();
  });

  it("turns facet choices, search, sort and since into query params", async () => {
    renderLibrary();
    await screen.findByRole("listbox", { name: /Assets/ });
    const filters = screen.getByRole("navigation", { name: "Asset filters" });
    fireEvent.click(within(filters).getByRole("button", { name: /^video/ }));
    await waitFor(() => expect(libraryCalls().at(-1)?.get("type")).toBe("video"));
    fireEvent.click(within(filters).getByRole("button", { name: /^generated/ }));
    await waitFor(() => expect(libraryCalls().at(-1)?.get("origin")).toBe("generated"));
    fireEvent.click(within(filters).getByRole("button", { name: /^moodboard/ }));
    fireEvent.click(within(filters).getByRole("button", { name: /^draft/ }));
    await waitFor(() =>
      expect(libraryCalls().at(-1)?.getAll("tag")).toEqual(["moodboard", "draft"]),
    );
    fireEvent.click(within(filters).getByRole("button", { name: "Mine" }));
    await waitFor(() => expect(libraryCalls().at(-1)?.get("owner")).toBe("me"));
    fireEvent.change(screen.getByRole("combobox", { name: "Sort" }), { target: { value: "size" } });
    await waitFor(() => expect(libraryCalls().at(-1)?.get("sort")).toBe("size"));
    fireEvent.change(screen.getByRole("combobox", { name: "Created" }), {
      target: { value: "7d" },
    });
    await waitFor(() => expect(libraryCalls().at(-1)?.get("since")).toBe("7d"));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search assets" }), {
      target: { value: "fox" },
    });
    await waitFor(() => expect(libraryCalls().at(-1)?.get("q")).toBe("fox"), { timeout: 2000 });
  });

  it("follows nextCursor until the pages run out (short pages included)", async () => {
    pages = {
      first: { items: [item("a1")], nextCursor: "c2" },
      c2: { items: [], nextCursor: "c3" },
      c3: { items: [item("a2"), item("a3")], nextCursor: null },
    };
    renderLibrary();
    const grid = await screen.findByRole("listbox", { name: /Assets/ });
    await waitFor(() =>
      expect(
        within(grid)
          .getAllByRole("option")
          .map((o) => o.id),
      ).toEqual(["asset-opt-a1", "asset-opt-a2", "asset-opt-a3"]),
    );
    const cursors = libraryCalls().map((p) => p.get("cursor"));
    expect(cursors).toEqual([null, "c2", "c3"]);
    expect(libraryCalls()[1]?.has("facets")).toBe(false);
  });

  it("selects with click, shift-range and ctrl-toggle, and opens on Enter", async () => {
    renderLibrary();
    const grid = await screen.findByRole("listbox", { name: /Assets/ });
    const [o1, o2, o3] = within(grid).getAllByRole("option") as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    fireEvent.click(o1);
    fireEvent.click(o3, { shiftKey: true });
    expect([o1, o2, o3].map((o) => o.getAttribute("aria-selected"))).toEqual([
      "true",
      "true",
      "true",
    ]);
    fireEvent.click(o2, { ctrlKey: true });
    expect(o2).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("toolbar", { name: "Selected assets" })).toHaveTextContent(
      "2 selected",
    );
    // Keyboard: Space toggles the active item, Enter opens the viewer on it.
    grid.focus();
    expect(grid).toHaveAttribute("aria-activedescendant", "asset-opt-a2");
    fireEvent.keyDown(grid, { key: "ArrowLeft" });
    expect(grid).toHaveAttribute("aria-activedescendant", "asset-opt-a1");
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    expect(grid).toHaveAttribute("aria-activedescendant", "asset-opt-a2");
    fireEvent.keyDown(grid, { key: " " });
    expect(o2).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(grid, { key: "Enter" });
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName("a2.png");
    expect(within(dialog).getByText("2 / 3")).toBeInTheDocument();
  });

  it("bulk-tags and bulk-deletes the selection through the asset endpoints", async () => {
    renderLibrary();
    const grid = await screen.findByRole("listbox", { name: /Assets/ });
    fireEvent.keyDown(grid, { key: "a", ctrlKey: true });
    const bar = screen.getByRole("toolbar", { name: "Selected assets" });
    expect(bar).toHaveTextContent("3 selected");
    fireEvent.change(within(bar).getByLabelText("Tags for selected assets"), {
      target: { value: "harbour, final" },
    });
    fireEvent.click(within(bar).getByRole("button", { name: "Tag" }));
    await waitFor(() => {
      const patches = authFetch.mock.calls.filter(([, init]) => init?.method === "PATCH");
      expect(patches.map(([url]) => String(url).split("/").pop())).toEqual(["a1", "a2", "a3"]);
      expect(JSON.parse(String(patches[0]?.[1]?.body))).toEqual({ addTags: ["harbour", "final"] });
    });
    fireEvent.click(within(bar).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(bar).getByRole("button", { name: "Delete 3" }));
    await waitFor(() => {
      const deletes = authFetch.mock.calls.filter(([, init]) => init?.method === "DELETE");
      expect(deletes.map(([url]) => String(url).split("/").pop())).toEqual(["a1", "a2", "a3"]);
    });
  });

  it("shows an upload call to action when the library is empty", async () => {
    pages = { first: { items: [], nextCursor: null } };
    renderLibrary();
    expect(await screen.findByText("Your library is empty.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload files" })).toBeInTheDocument();
  });

  it("marks pending and unavailable previews", async () => {
    pages = {
      first: {
        items: [
          item("p1", { thumb: null, derivativeState: null }),
          item("u1", {
            thumb: null,
            type: "video",
            derivativeState: "unavailable",
            derivativeNote: "ffmpeg not installed",
          }),
        ],
        nextCursor: null,
      },
    };
    renderLibrary();
    await screen.findByRole("listbox", { name: /Assets/ });
    expect(screen.getByTestId("thumb-pending")).toBeInTheDocument();
    expect(screen.getByTestId("thumb-unavailable")).toHaveAttribute(
      "title",
      "ffmpeg not installed",
    );
  });

  it("gives thumbnails alt text, lazy loading and intrinsic size", async () => {
    pages = { first: { items: [item("a1", { alt: null, caption: "red fox" })], nextCursor: null } };
    renderLibrary();
    const img = await screen.findByAltText("red fox");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute("decoding", "async");
    expect(img).toHaveAttribute("width", "64");
    expect(img).toHaveAttribute("height", "64");
  });
});
