// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A persistent media card in the WebChat transcript: one of the viewer's own
 * assets (upload or generation) or media jobs, read from the durable library
 * and job records (lib/chat-media.ts), so it survives a reload. The preview
 * box has a fixed size from the asset's dimensions (no layout shift) and its
 * image loads only once the card nears the viewport. Activating the preview
 * opens the shared MediaViewer with the conversation's media as the
 * collection, so ←/→ move through it.
 */

import {
  AlertTriangle,
  File,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { type AssetType, assetAltText, type LibraryItem } from "../../lib/asset-library";
import { useSignedAssetUrl } from "../../lib/asset-url";
import type { ChatMediaEntry } from "../../lib/chat-media";
import type { MediaJob } from "../../lib/types";
import { useAssetViewer, type ViewableAsset, viewableFromItem } from "./MediaViewer";

const TYPE_ICON: Record<AssetType, LucideIcon> = {
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  pdf: FileText,
  document: FileText,
  other: File,
};

/** Preview box width; height follows the asset's aspect ratio within bounds. */
export const CARD_PREVIEW_WIDTH = 192;
const MIN_PREVIEW_HEIGHT = 96;
const MAX_PREVIEW_HEIGHT = 256;
const DEFAULT_PREVIEW_HEIGHT = 144;

/** Fixed preview box for known dimensions (reserved before any image loads). */
export function previewBox(
  width: number | null | undefined,
  height: number | null | undefined,
): { width: number; height: number } {
  if (!width || !height || width <= 0 || height <= 0)
    return { width: CARD_PREVIEW_WIDTH, height: DEFAULT_PREVIEW_HEIGHT };
  const h = Math.round((CARD_PREVIEW_WIDTH * height) / width);
  return {
    width: CARD_PREVIEW_WIDTH,
    height: Math.min(MAX_PREVIEW_HEIGHT, Math.max(MIN_PREVIEW_HEIGHT, h)),
  };
}

const JOB_STATUS: Record<MediaJob["status"], { label: string; token: string }> = {
  pending: { label: "Queued", token: "--color-warning" },
  running: { label: "Rendering", token: "--color-primary" },
  succeeded: { label: "Done", token: "--color-success" },
  failed: { label: "Failed", token: "--color-danger" },
  blocked: { label: "Blocked", token: "--color-coral" },
};

/** The viewer entry for a card, or null when there is nothing to open yet. */
export function viewableForEntry(entry: ChatMediaEntry): ViewableAsset | null {
  if (entry.type === "asset") {
    const v = viewableFromItem(entry.asset);
    return {
      ...v,
      prompt: v.prompt ?? entry.job?.prompt,
      model: v.model ?? entry.job?.model,
    };
  }
  if (entry.type === "job" && entry.job.assetUrl) {
    const job = entry.job;
    return {
      url: job.assetUrl as string,
      ...(job.assetId ? { id: job.assetId } : {}),
      kind: job.type,
      title: `${job.type} · ${job.model}`,
      prompt: job.prompt,
      model: job.model,
    };
  }
  return null;
}

/** True once `ref` has come within `margin` of the viewport (stays true). */
export function useNearViewport(ref: RefObject<Element | null>, margin = "300px"): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (near) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin: margin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near, ref, margin]);
  return near;
}

function cardTime(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (new Date(now).toDateString() === d.toDateString()) return time;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

function AssetPreview({
  item,
  box,
}: {
  item: LibraryItem;
  box: { width: number; height: number };
}) {
  const thumb = item.thumb;
  const src = useSignedAssetUrl(thumb?.url, thumb?.expiresAt);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const Icon = TYPE_ICON[item.type] ?? File;
  const pending = !thumb && item.derivativeState === null && item.type !== "other";
  return (
    <>
      {item.placeholder && !loaded && (
        <img
          src={item.placeholder}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 h-full w-full scale-110 object-cover blur-md"
        />
      )}
      {thumb && src && !failed && (
        <img
          src={src}
          alt={assetAltText(item)}
          width={box.width}
          height={box.height}
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className="relative h-full w-full object-cover motion-safe:transition-opacity motion-safe:duration-200"
          style={{ opacity: loaded ? 1 : 0 }}
        />
      )}
      {pending && (
        <span
          className="absolute inset-0 animate-pulse bg-gradient-to-r from-bg-hover via-bg-card to-bg-hover motion-reduce:animate-none"
          data-testid="chat-media-preview-pending"
        />
      )}
      {(!thumb || failed) && !pending && (
        <Icon size={28} className="relative text-text-dim" aria-hidden="true" />
      )}
    </>
  );
}

export interface ChatMediaCardProps {
  entry: Exclude<ChatMediaEntry, { type: "live" }>;
  /** The conversation's openable media, in transcript order. */
  collection: readonly ViewableAsset[];
  /** This card's index in `collection` (-1 / omitted when it is not openable yet). */
  index?: number;
}

export function ChatMediaCard({ entry, collection, index = -1 }: ChatMediaCardProps) {
  const { open } = useAssetViewer();
  const boxRef = useRef<HTMLDivElement>(null);
  const near = useNearViewport(boxRef);
  const viewable = viewableForEntry(entry);
  const asset = entry.type === "asset" ? entry.asset : null;
  const job = entry.job ?? null;
  const box = previewBox(asset?.width, asset?.height);
  const title = asset?.filename ?? (job ? `${job.type} · ${job.model}` : "media");
  const prompt = asset?.provenance?.prompt ?? job?.prompt;
  const model = asset?.provenance?.model ?? job?.model;
  const status = entry.type === "job" ? JOB_STATUS[entry.job.status] : null;
  const active = entry.type === "job" && ["pending", "running"].includes(entry.job.status);
  const progressRaw = (job?.metadata as Record<string, unknown> | null | undefined)?.progress;
  const progress =
    active && typeof progressRaw === "number" ? `${Math.round(progressRaw * 100)}%` : null;
  const kindLabel = asset
    ? asset.origin === "generated"
      ? `generated ${asset.type}`
      : asset.origin === "upload"
        ? `uploaded ${asset.type}`
        : asset.type
    : (job?.type ?? "media");

  const preview = (
    <div
      ref={boxRef}
      className="relative flex shrink-0 items-center justify-center overflow-hidden rounded bg-bg-hover"
      style={{ width: box.width, height: box.height }}
    >
      {asset && near ? (
        <AssetPreview item={asset} box={box} />
      ) : active ? (
        <Loader2
          size={22}
          className="text-text-dim motion-safe:animate-spin"
          aria-hidden="true"
          data-testid="chat-media-job-spinner"
        />
      ) : entry.type === "job" && entry.job.status !== "succeeded" ? (
        <AlertTriangle size={22} className="text-text-dim" aria-hidden="true" />
      ) : (
        <FileImage size={22} className="text-text-dim" aria-hidden="true" />
      )}
    </div>
  );

  return (
    <figure
      className="my-1 flex min-w-0 gap-3 rounded-md border border-border bg-bg/70 p-2 shadow-sm"
      data-testid="chat-media-card"
      data-media-key={entry.key}
    >
      {viewable ? (
        <button
          type="button"
          onClick={() =>
            open(viewable, index >= 0 ? { collection, index } : { collection: [viewable] })
          }
          aria-label={`Open ${title} in the media viewer`}
          className="shrink-0 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {preview}
        </button>
      ) : (
        preview
      )}
      <figcaption className="flex min-w-0 flex-1 flex-col gap-1 text-[11px] text-text-dim">
        <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide">
          <span className="truncate">{kindLabel}</span>
          <span className="shrink-0">{cardTime(entry.timestamp)}</span>
        </div>
        <span className="truncate text-[12px] text-text-bright" title={title}>
          {title}
        </span>
        {status && (
          <span className="flex items-center gap-1.5" role="status">
            <span
              className="rounded px-1 py-0.5 text-[10px] uppercase"
              style={{
                color: `var(${status.token})`,
                background: `color-mix(in srgb, var(${status.token}) 16%, transparent)`,
                border: `1px solid var(${status.token})`,
              }}
            >
              {status.label}
            </span>
            {progress && <span>{progress}</span>}
          </span>
        )}
        {prompt && (
          <span className="line-clamp-3 leading-snug text-text" title={prompt}>
            {prompt}
          </span>
        )}
        {model && <span className="truncate">{model}</span>}
        {entry.type === "job" && entry.job.error && (
          <span className="line-clamp-2 text-danger">{entry.job.error}</span>
        )}
        {asset?.caption && !prompt && <span className="line-clamp-2">{asset.caption}</span>}
      </figcaption>
    </figure>
  );
}
