// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  inferKind,
  MediaViewerProvider,
  useAssetViewer,
  type ViewableAsset,
  viewableFromItem,
} from "../components/media/MediaViewer";
import { clampScale, FIT, MAX_SCALE, zoomAround } from "../components/media/ZoomableImage";
import { useChatState } from "../hooks/use-chat-state";
import type { LibraryItem } from "../lib/asset-library";
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
    size: 2048,
    owner: "Ada",
    origin: "upload",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    sha256: null,
    width: 800,
    height: 600,
    durationMs: null,
    pages: null,
    caption: null,
    alt: `alt ${id}`,
    tags: ["moodboard"],
    provenance: null,
    url: `/assets/${id}.png`,
    urlExpiresAt: null,
    thumbs: {},
    thumb: null,
    placeholder: null,
    derivativeState: "done",
    derivativeNote: null,
    derivedFrom: null,
    ...over,
  };
}

function detail(id: string, over: Partial<LibraryItem> = {}) {
  return { ...item(id, over), parents: [], children: [], usedIn: [] };
}

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

/** Renders a button that opens the viewer on `assets[index]` with `assets` as the collection. */
function Opener({ assets, index = 0 }: { assets: ViewableAsset[]; index?: number }) {
  const viewer = useAssetViewer();
  return (
    <button type="button" onClick={() => viewer.open(assets[index]!, { collection: assets })}>
      open viewer
    </button>
  );
}

function AutoOpen({ asset }: { asset: ViewableAsset }) {
  const viewer = useAssetViewer();
  // biome-ignore lint/correctness/useExhaustiveDependencies: open once.
  useEffect(() => viewer.open(asset), []);
  return null;
}

const three = ["a1", "a2", "a3"].map((id) => viewableFromItem(item(id)));

function renderViewer(assets = three, index = 0) {
  renderWithProviders(
    <MediaViewerProvider>
      <Opener assets={assets} index={index} />
    </MediaViewerProvider>,
  );
  const opener = screen.getByRole("button", { name: "open viewer" });
  opener.focus();
  fireEvent.click(opener);
  return { opener, dialog: screen.getByRole("dialog") };
}

beforeEach(() => {
  authFetch.mockReset();
  authFetch.mockImplementation((url: string) => {
    const id = /\/api\/assets\/([^/?]+)$/.exec(url)?.[1];
    return id ? json(detail(id)) : json({}, 404);
  });
  useChatState.setState({ entityName: "Ada" });
  localStorage.clear();
});

describe("media viewer", () => {
  it("is a labelled modal dialog that takes focus and restores it on Escape", async () => {
    const { opener, dialog } = renderViewer();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("a1.png");
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it("traps Tab inside the dialog", () => {
    const { dialog } = renderViewer();
    const buttons = within(dialog).getAllByRole("button");
    const last = buttons[buttons.length - 1]!;
    const first = within(dialog)
      .getAllByRole("link")
      .concat(buttons)
      .sort((a, b) =>
        a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
      )[0]!;
    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    first.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("moves through the collection with ←/→ and the arrow buttons", () => {
    const { dialog } = renderViewer();
    expect(within(dialog).getByText("1 / 3")).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(screen.getByRole("dialog")).toHaveAccessibleName("a2.png");
    expect(within(dialog).getByAltText("alt a2")).toHaveAttribute("src", "/assets/a2.png");
    fireEvent.click(within(dialog).getByRole("button", { name: "Next asset" }));
    expect(screen.getByRole("dialog")).toHaveAccessibleName("a3.png");
    // Wraps around.
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(screen.getByRole("dialog")).toHaveAccessibleName("a1.png");
    fireEvent.keyDown(dialog, { key: "ArrowLeft" });
    expect(screen.getByRole("dialog")).toHaveAccessibleName("a3.png");
  });

  it("zooms an image with the toolbar, keys and double-click", () => {
    const { dialog } = renderViewer([three[0]!]);
    const stage = within(dialog).getByTestId("zoom-stage");
    expect(stage).toHaveAttribute("data-scale", "1.000");
    expect(within(dialog).queryByRole("button", { name: "Next asset" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Zoom in" }));
    expect(stage).toHaveAttribute("data-scale", "1.500");
    expect(within(dialog).getByText("150%")).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: "0" });
    expect(stage).toHaveAttribute("data-scale", "1.000");
    fireEvent.doubleClick(stage);
    expect(Number(stage.getAttribute("data-scale"))).toBeGreaterThanOrEqual(2);
    fireEvent.doubleClick(stage);
    expect(stage).toHaveAttribute("data-scale", "1.000");
  });

  it("keeps zoom math anchored and clamped", () => {
    expect(zoomAround(FIT, 1, 10, 10)).toEqual(FIT);
    const z = zoomAround(FIT, 2, 100, 0);
    expect(z).toEqual({ scale: 2, x: -100, y: 0 });
    expect(clampScale(1000)).toBe(MAX_SCALE);
  });

  it("shows details with owner-only editing and saves a caption", async () => {
    const { dialog } = renderViewer([three[0]!]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Details" }));
    const panel = await within(dialog).findByRole("complementary", { name: "Asset details" });
    await within(panel).findByText("800 × 600");
    expect(within(panel).getByText("moodboard")).toBeInTheDocument();
    authFetch.mockImplementationOnce(() => json(detail("a1", { caption: "harbour" })));
    fireEvent.change(within(panel).getByLabelText("Caption"), { target: { value: "harbour" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save caption" }));
    await waitFor(() =>
      expect(authFetch).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/assets\/a1$/),
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ caption: "harbour" }) }),
      ),
    );
  });

  it("is read-only for someone else's asset (no delete, no editors)", async () => {
    useChatState.setState({ entityName: "Bob" });
    const { dialog } = renderViewer([three[0]!]);
    expect(within(dialog).queryByRole("button", { name: "Delete asset" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Details" }));
    const panel = await within(dialog).findByRole("complementary", { name: "Asset details" });
    await within(panel).findByText("800 × 600");
    expect(within(panel).queryByLabelText("Caption")).toBeNull();
    expect(within(panel).queryByRole("button", { name: /Remove tag/ })).toBeNull();
  });

  it("deletes after confirmation and closes when the collection empties", async () => {
    const { dialog } = renderViewer([three[0]!]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete asset" }));
    const confirm = within(dialog).getByRole("alertdialog", { name: "Confirm delete" });
    authFetch.mockImplementationOnce(() => json({ ok: true, id: "a1" }));
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(authFetch).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/assets\/a1$/),
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("asks an agent by drafting `asset show <id>` into chat", () => {
    const drafted = vi.fn();
    window.addEventListener("marina:draft-command", drafted);
    const { dialog } = renderViewer([three[1]!]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Ask an agent about this asset" }));
    expect((drafted.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      command: "asset show a2",
    });
    window.removeEventListener("marina:draft-command", drafted);
  });

  it("shows an error state with retry when the image fails", () => {
    const { dialog } = renderViewer([three[0]!]);
    fireEvent.error(within(dialog).getByAltText("alt a1"));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("could not be loaded");
    fireEvent.click(within(dialog).getByRole("button", { name: /Retry/ }));
    expect(within(dialog).getByAltText("alt a1")).toBeInTheDocument();
  });

  it("renders video with its poster and native controls", () => {
    renderWithProviders(
      <MediaViewerProvider>
        <AutoOpen
          asset={viewableFromItem(
            item("v1", {
              filename: "clip.mp4",
              mime: "video/mp4",
              type: "video",
              url: "/assets/v1.mp4",
              thumbs: {
                poster: { url: "/assets/v1-poster.webp", expiresAt: null, width: 1, height: 1 },
              },
            }),
          )}
        />
      </MediaViewerProvider>,
    );
    const video = screen.getByRole("dialog").querySelector("video");
    expect(video).toHaveAttribute("src", "/assets/v1.mp4");
    expect(video).toHaveAttribute("poster", "/assets/v1-poster.webp");
    expect(video).toHaveAttribute("controls");
  });

  it("falls back to a new tab outside a provider", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    renderWithProviders(<Opener assets={[three[0]!]} />);
    fireEvent.click(screen.getByRole("button", { name: "open viewer" }));
    await act(async () => {});
    expect(open).toHaveBeenCalledWith("/assets/a1.png", "_blank", "noopener");
    open.mockRestore();
  });

  it("infers kinds for library types", () => {
    expect(inferKind({ url: "x", kind: "other", mime: "application/zip" })).toBe("other");
    expect(inferKind({ url: "/assets/a.flac" })).toBe("audio");
  });
});
