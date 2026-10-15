// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * WebChat persistent media: derivation (persisted assets/jobs merged in
 * transcript order, deduped against live feed events, live fallback only in
 * its window), the viewer-scoped fetch parameters, the card states, and the
 * transcript wiring (cards come back after a "reload" with no live events).
 */

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatMediaCard, previewBox, viewableForEntry } from "../components/media/ChatMediaCard";
import { type LibraryItem, libraryQueryString } from "../lib/asset-library";
import {
  CHAT_MEDIA_FILTERS,
  CHAT_MEDIA_PAGE_SIZE,
  type ChatMediaEntry,
  chatMediaJobsPath,
  deriveChatMedia,
  hasActiveJob,
  LIVE_FALLBACK_WINDOW_MS,
  mergeByTimestamp,
} from "../lib/chat-media";
import type { FeedEvent, MediaJob } from "../lib/types";
import { renderWithProviders } from "./test-utils";

const open = vi.fn();
vi.mock("../components/media/MediaViewer", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAssetViewer: () => ({ open, close: vi.fn() }),
}));

const authFetch = vi.fn();
const fetchApi = vi.fn();
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  authFetch: (...args: unknown[]) => authFetch(...args),
  fetchApi: (...args: unknown[]) => fetchApi(...args),
}));

const T0 = 1_760_000_000_000;

function item(id: string, over: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id,
    filename: `${id}.png`,
    mime: "image/png",
    type: "image",
    size: 2048,
    owner: "Ada",
    origin: "upload",
    createdAt: T0,
    updatedAt: T0,
    sha256: null,
    width: 800,
    height: 400,
    durationMs: null,
    pages: null,
    caption: null,
    alt: null,
    tags: [],
    provenance: null,
    url: `/assets/${id}.png`,
    urlExpiresAt: null,
    thumbs: {},
    thumb: { url: `/assets/${id}-t.webp`, expiresAt: null, width: 256, height: 128 },
    placeholder: null,
    derivativeState: "done",
    derivativeNote: null,
    derivedFrom: null,
    ...over,
  };
}

function job(id: string, over: Partial<MediaJob> = {}): MediaJob {
  return {
    id,
    type: "image",
    status: "pending",
    provider: "openai",
    model: "openai/gpt-image-1",
    prompt: `prompt ${id}`,
    entityName: "Ada",
    costEstimate: null,
    error: null,
    assetId: null,
    assetUrl: null,
    options: {},
    metadata: {},
    createdAt: T0,
    updatedAt: T0,
    completedAt: null,
    ...over,
  };
}

function feed(
  id: number,
  over: Partial<FeedEvent> & { payload?: Record<string, unknown> },
): FeedEvent {
  return {
    id,
    kind: "image_generated",
    entity: "e_bob",
    ref: null,
    summary: `event ${id}`,
    payload: null,
    timestamp: T0,
    ...over,
  };
}

describe("deriveChatMedia", () => {
  it("orders persisted assets and jobs by time; a generated asset sits where its job was requested", () => {
    const entries = deriveChatMedia({
      assets: [
        item("up", { createdAt: T0 + 5_000 }),
        item("gen", { createdAt: T0 + 9_000, origin: "generated" }),
      ],
      jobs: [
        job("j-gen", {
          status: "succeeded",
          assetId: "gen",
          assetUrl: "/assets/gen.png",
          createdAt: T0 + 1_000,
        }),
        job("j-run", { status: "running", createdAt: T0 + 7_000 }),
      ],
      feed: [],
      now: T0 + 10_000,
    });
    expect(entries.map((e) => e.key)).toEqual(["asset-gen", "asset-up", "job-j-run"]);
    const gen = entries[0] as Extract<ChatMediaEntry, { type: "asset" }>;
    expect(gen.job?.id).toBe("j-gen");
    expect(gen.timestamp).toBe(T0 + 1_000);
  });

  it("dedupes overlapping pages and repeated jobs", () => {
    const entries = deriveChatMedia({
      assets: [item("a"), item("a"), item("b", { createdAt: T0 + 1 })],
      jobs: [job("j1"), job("j1")],
      feed: [],
      now: T0,
    });
    expect(entries.map((e) => e.key)).toEqual(["asset-a", "job-j1", "asset-b"]);
  });

  it("keeps a finished job whose asset is not loaded yet, drops one whose asset is gone", () => {
    const entries = deriveChatMedia({
      assets: [],
      jobs: [
        job("done", { status: "succeeded", assetId: "x", assetUrl: "/assets/x.png" }),
        job("deleted", { status: "succeeded", assetId: "y", assetUrl: null }),
        job("failed", { status: "failed", error: "boom" }),
      ],
      feed: [],
      now: T0,
    });
    expect(entries.map((e) => e.key).sort()).toEqual(["job-done", "job-failed"]);
  });

  it("drops live feed events a persisted card already covers (by asset or job id)", () => {
    const entries = deriveChatMedia({
      assets: [item("gen")],
      jobs: [job("j-run", { status: "running" })],
      feed: [
        feed(1, { payload: { canvasId: "c", nodeId: "n1", assetId: "gen" } }),
        feed(2, { kind: "media_complete", ref: "j-run", payload: { canvasId: "c", nodeId: "n2" } }),
        feed(3, { payload: { canvasId: "c", nodeId: "n3", assetId: "other" } }),
        feed(4, { payload: { canvasId: "c" } }),
      ],
      now: T0 + 1_000,
    });
    expect(entries.filter((e) => e.type === "live").map((e) => e.key)).toEqual(["live-3-n3"]);
  });

  it("shows live fallback events only inside the window", () => {
    const now = T0 + LIVE_FALLBACK_WINDOW_MS + 10;
    const entries = deriveChatMedia({
      assets: [],
      jobs: [],
      feed: [
        feed(1, { timestamp: T0, payload: { canvasId: "c", nodeId: "old" } }),
        feed(2, { timestamp: now - 5, payload: { canvasId: "c", nodeId: "new" } }),
      ],
      now,
    });
    expect(entries.map((e) => e.key)).toEqual(["live-2-new"]);
  });

  it("persisted cards do not age out (no window applies to them)", () => {
    const entries = deriveChatMedia({
      assets: [item("old", { createdAt: T0 - 30 * 86_400_000 })],
      jobs: [],
      feed: [],
      now: T0,
    });
    expect(entries).toHaveLength(1);
  });
});

describe("chat media helpers", () => {
  it("merges media into messages by timestamp, messages first on ties, message order kept", () => {
    const merged = mergeByTimestamp(
      [
        { id: "m1", timestamp: 10 },
        { id: "m2", timestamp: 30 },
      ],
      [
        { id: "c0", timestamp: 5 },
        { id: "c1", timestamp: 10 },
        { id: "c2", timestamp: 40 },
      ],
    );
    expect(merged.map((x) => x.id)).toEqual(["c0", "m1", "c1", "m2", "c2"]);
  });

  it("asks for the conversation scope, never naming entities (resolved server-side)", () => {
    const q = new URLSearchParams(
      libraryQueryString(CHAT_MEDIA_FILTERS, { limit: CHAT_MEDIA_PAGE_SIZE }),
    );
    expect(q.get("scope")).toBe("chat");
    expect(q.get("owner")).toBeNull();
    expect(q.get("view")).toBe("library");
    expect(q.get("limit")).toBe(String(CHAT_MEDIA_PAGE_SIZE));
    expect(chatMediaJobsPath()).toBe("/api/media-jobs?scope=chat&limit=20");
  });

  it("knows when a job is still moving", () => {
    expect(hasActiveJob([job("a", { status: "failed" })])).toBe(false);
    expect(hasActiveJob([job("a", { status: "running" })])).toBe(true);
    expect(hasActiveJob(undefined)).toBe(false);
  });

  it("reserves the preview box from the asset's dimensions", () => {
    expect(previewBox(800, 400)).toEqual({ width: 192, height: 96 });
    expect(previewBox(400, 4000)).toEqual({ width: 192, height: 256 });
    expect(previewBox(null, null)).toEqual({ width: 192, height: 144 });
  });
});

describe("ChatMediaCard", () => {
  beforeEach(() => open.mockReset());

  it("an asset card opens the viewer with the conversation's collection", () => {
    const a = { type: "asset", key: "asset-a", timestamp: T0, asset: item("a") } as const;
    const b = {
      type: "asset",
      key: "asset-b",
      timestamp: T0 + 1,
      asset: item("b", { origin: "generated", provenance: { prompt: "a harbour", model: "m1" } }),
    } as const;
    const collection = [viewableForEntry(a)!, viewableForEntry(b)!];
    renderWithProviders(<ChatMediaCard entry={b} collection={collection} index={1} />);
    expect(screen.getByText("a harbour")).toBeInTheDocument();
    expect(screen.getByText("m1")).toBeInTheDocument();
    expect(screen.getByText(/generated image/i)).toBeInTheDocument();
    const img = screen.getByRole("img", { name: "b.png" });
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute("width", "192");
    expect(img).toHaveAttribute("height", "96");
    fireEvent.click(screen.getByRole("button", { name: "Open b.png in the media viewer" }));
    expect(open).toHaveBeenCalledTimes(1);
    const [asset, opts] = open.mock.calls[0]!;
    expect(asset.id).toBe("b");
    expect(opts).toEqual({ collection, index: 1 });
  });

  it("names the author of media the viewer did not make (its agent, a room agent)", () => {
    const entry = {
      type: "asset",
      key: "asset-p",
      timestamp: T0,
      asset: item("p", { owner: "Painter", origin: "generated" }),
    } as const;
    const { rerender } = renderWithProviders(
      <ChatMediaCard entry={entry} collection={[]} viewer="Ada" />,
    );
    expect(screen.getByText(/by Painter/)).toBeInTheDocument();
    rerender(<ChatMediaCard entry={{ ...entry, asset: item("p") }} collection={[]} viewer="ada" />);
    expect(screen.queryByText(/ by /)).toBeNull();
  });

  it("a pending or rendering job shows its status and nothing to open", () => {
    const { rerender } = renderWithProviders(
      <ChatMediaCard
        entry={{ type: "job", key: "job-1", timestamp: T0, job: job("1") }}
        collection={[]}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Queued");
    expect(screen.getByText("prompt 1")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    rerender(
      <ChatMediaCard
        entry={{
          type: "job",
          key: "job-1",
          timestamp: T0,
          job: job("1", { status: "running", metadata: { progress: 0.4 } }),
        }}
        collection={[]}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Rendering");
    expect(screen.getByRole("status")).toHaveTextContent("40%");
    expect(screen.getByTestId("chat-media-job-spinner")).toBeInTheDocument();
  });

  it("a failed job shows the error; a finished job opens its asset", () => {
    renderWithProviders(
      <>
        <ChatMediaCard
          entry={{
            type: "job",
            key: "job-f",
            timestamp: T0,
            job: job("f", { status: "failed", error: "provider refused" }),
          }}
          collection={[]}
        />
        <ChatMediaCard
          entry={{
            type: "job",
            key: "job-d",
            timestamp: T0,
            job: job("d", { status: "succeeded", assetId: "x", assetUrl: "/assets/x.png" }),
          }}
          collection={[]}
        />
      </>,
    );
    expect(screen.getByText("provider refused")).toBeInTheDocument();
    const [failedStatus, doneStatus] = screen.getAllByRole("status");
    expect(failedStatus).toHaveTextContent("Failed");
    expect(doneStatus).toHaveTextContent("Done");
    fireEvent.click(screen.getByRole("button", { name: /Open image · openai\/gpt-image-1/ }));
    expect(open.mock.calls[0]![0]).toMatchObject({ id: "x", url: "/assets/x.png" });
  });
});

describe("ChatMessageList persisted media", () => {
  beforeEach(async () => {
    open.mockReset();
    authFetch.mockReset();
    fetchApi.mockReset();
    const { useChatState } = await import("../hooks/use-chat-state");
    const { useFeedState } = await import("../hooks/use-feed-state");
    useChatState.setState({ loggedIn: true, entityName: "Ada", messages: [] });
    useFeedState.setState({ events: [] });
  });

  it("re-renders the viewer's media after a reload (no live events), in transcript order", async () => {
    const { ChatMessageList } = await import("../components/ChatMessageList");
    authFetch.mockImplementation(async (url: string) => {
      expect(url).toContain("scope=chat");
      return new Response(
        JSON.stringify({
          items: [
            item("late", { createdAt: T0 + 20_000 }),
            item("early", { createdAt: T0 + 1_000 }),
          ],
          nextCursor: "next",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    fetchApi.mockImplementation(async (path: string) => {
      expect(path).toBe("/api/media-jobs?scope=chat&limit=20");
      return [job("r", { status: "running", createdAt: T0 + 30_000 })];
    });
    const messages = [{ html: "hello", text: "hello", kind: "message", timestamp: T0 + 10_000 }];
    const { container } = renderWithProviders(
      <ChatMessageList
        messages={messages}
        viewMode="rich"
        copy={async () => {}}
        copied={null}
        sendCommandWithOverlay={() => true}
      />,
    );
    await waitFor(() => expect(screen.getAllByTestId("chat-media-card")).toHaveLength(3));
    const order = [...container.querySelectorAll("[data-testid='chat-media-card'], .group")].map(
      (el) => el.getAttribute("data-media-key") ?? el.textContent?.trim().slice(0, 5),
    );
    expect(order).toEqual(["asset-early", "hello", "asset-late", "job-r"]);
    expect(screen.getByRole("button", { name: "Show earlier media" })).toBeInTheDocument();
    // ←/→ move through the conversation's openable media (the job has none yet).
    const late = screen.getAllByTestId("chat-media-card")[1]!;
    await act(async () => {
      fireEvent.click(within(late).getByRole("button", { name: /Open late\.png/ }));
    });
    const [, opts] = open.mock.calls[0]!;
    expect(opts.index).toBe(1);
    expect(opts.collection.map((v: { id?: string }) => v.id)).toEqual(["early", "late"]);
  });

  it("reads nothing before login", async () => {
    const { useChatState } = await import("../hooks/use-chat-state");
    useChatState.setState({ loggedIn: false, entityName: null });
    const { ChatMessageList } = await import("../components/ChatMessageList");
    renderWithProviders(
      <ChatMessageList
        messages={[]}
        viewMode="rich"
        copy={async () => {}}
        copied={null}
        sendCommandWithOverlay={() => true}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(authFetch).not.toHaveBeenCalled();
    expect(fetchApi).not.toHaveBeenCalled();
  });
});
