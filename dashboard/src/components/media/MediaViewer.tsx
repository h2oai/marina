// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The one media viewer. `MediaViewerProvider` is mounted once at the app root
 * (main.tsx); any surface opens it with `useAssetViewer().open(asset, {
 * collection, index })` — the Library passes its current result set, a canvas
 * its media nodes, chat its media jobs — and ←/→ move through that
 * collection. It is a modal dialog (role="dialog", aria-modal, focus trap,
 * Esc, focus restored on close) with zoom/pan for images, poster + native
 * controls for video, a decoded waveform for audio, pdf.js paging for PDFs,
 * and an info panel (facts, provenance, lineage, canvases, owner edits).
 *
 * Outside a provider (isolated tests, alternate roots) `open` falls back to
 * a new tab with a signed URL, as before.
 */

import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileQuestion,
  Info,
  Link2,
  MessageSquare,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  createContext,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useChatState } from "../../hooks/use-chat-state";
import { useFocusTrap } from "../../hooks/use-focus-trap";
import { apiOrigin } from "../../lib/api-origin";
import {
  assetAltText,
  assetDetailKey,
  assetIdFromUrl,
  deleteAsset,
  fetchAssetDetail,
  type LibraryDetail,
  type LibraryItem,
  plainAssetUrl,
  useAssetDetail,
} from "../../lib/asset-library";
import { resolveAssetUrl, useSignedAssetUrl } from "../../lib/asset-url";
import { draftCommand } from "../../lib/command-discovery";
import { AddToCanvasMenu } from "./AddToCanvasMenu";
import { AssetInfoPanel } from "./AssetInfoPanel";
import { AudioWaveform } from "./AudioWaveform";
import { ZoomableImage, type ZoomableImageHandle, ZoomControls } from "./ZoomableImage";

// pdf.js (and its bundled worker URL) loads only when a PDF is opened.
const PdfPages = lazy(() => import("./PdfPages").then((m) => ({ default: m.PdfPages })));

export interface ViewableAsset {
  url: string;
  /** image | video | audio | pdf | document | embed | text — inferred if omitted. */
  kind?: string;
  title?: string;
  prompt?: string;
  model?: string;
  mime?: string;
  /** Asset id (else derived from an `/assets/<id>.<ext>` url). */
  id?: string;
  /** Unix seconds when a server-signed `url` expires (null/undefined = plain). */
  urlExpiresAt?: number | null;
  alt?: string | null;
  caption?: string | null;
  placeholder?: string | null;
  poster?: { url: string; expiresAt: number | null } | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  owner?: string;
}

export interface OpenOptions {
  /** The surrounding collection ←/→ moves through (must contain `asset`). */
  collection?: readonly ViewableAsset[];
  /** Index of `asset` in `collection` (found by url/id when omitted). */
  index?: number;
}

interface AssetViewerCtx {
  open: (asset: ViewableAsset, opts?: OpenOptions) => void;
  close: () => void;
}

const fallback: AssetViewerCtx = {
  open: (a) => {
    if (typeof window === "undefined") return;
    // A private asset needs a signed URL for a remote viewer.
    void resolveAssetUrl(a.url).then((url) => window.open(url, "_blank", "noopener"));
  },
  close: () => {},
};

const Ctx = createContext<AssetViewerCtx>(fallback);

/** Open the media viewer (or fall back to a new tab outside a provider). */
export function useAssetViewer(): AssetViewerCtx {
  return useContext(Ctx);
}

/** Normalize a node/job kind + mime + url into a viewer kind. */
export function inferKind(asset: ViewableAsset): string {
  if (asset.kind && asset.kind !== "document" && asset.kind !== "other")
    return asset.kind === "pdf" ? "pdf" : asset.kind;
  const mime = (asset.mime ?? "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  const path = (asset.url.split("?")[0] ?? "").toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|avif)$/.test(path)) return "image";
  if (/\.(mp4|webm|mov|m4v)$/.test(path)) return "video";
  if (/\.(mp3|wav|ogg|m4a|flac|aac)$/.test(path)) return "audio";
  if (/\.pdf$/.test(path)) return "pdf";
  return asset.kind === "other" ? "other" : (asset.kind ?? "document");
}

/** A library item as a viewer entry. */
export function viewableFromItem(item: LibraryItem): ViewableAsset {
  return {
    id: item.id,
    url: item.url,
    urlExpiresAt: item.urlExpiresAt,
    kind: item.type,
    mime: item.mime,
    title: item.filename,
    alt: item.alt,
    caption: item.caption,
    placeholder: item.placeholder,
    poster: item.thumbs.poster ?? null,
    width: item.width,
    height: item.height,
    durationMs: item.durationMs,
    owner: item.owner,
    prompt: item.provenance?.prompt,
    model: item.provenance?.model,
  };
}

function viewerRoot(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  let el = document.getElementById("asset-viewer-root");
  if (!el) {
    el = document.createElement("div");
    el.id = "asset-viewer-root";
    document.body.appendChild(el);
  }
  return el;
}

const sameAsset = (a: ViewableAsset, b: ViewableAsset) =>
  (a.id && b.id ? a.id === b.id : false) || plainAssetUrl(a.url) === plainAssetUrl(b.url);

interface ViewerState {
  items: readonly ViewableAsset[];
  index: number;
}

export function MediaViewerProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ViewerState | null>(null);
  const value = useMemo<AssetViewerCtx>(
    () => ({
      open: (asset, opts) => {
        const collection = opts?.collection?.length ? [...opts.collection] : [asset];
        let index = opts?.index ?? collection.findIndex((c) => sameAsset(c, asset));
        if (index < 0 || index >= collection.length) {
          collection.unshift(asset);
          index = 0;
        }
        setState({ items: collection, index });
      },
      close: () => setState(null),
    }),
    [],
  );
  const root = viewerRoot();
  return (
    <Ctx.Provider value={value}>
      {children}
      {root &&
        createPortal(
          <AnimatePresence>
            {state && (
              <MediaViewerDialog
                key="media-viewer"
                items={state.items}
                index={state.index}
                onIndex={(index) => setState((s) => (s ? { ...s, index } : s))}
                onOpenAsset={(asset) =>
                  setState((s) => {
                    const items = s ? [...s.items] : [];
                    const at = items.findIndex((c) => sameAsset(c, asset));
                    if (at >= 0) return { items, index: at };
                    const insert = (s?.index ?? -1) + 1;
                    items.splice(insert, 0, asset);
                    return { items, index: insert };
                  })
                }
                onRemoved={(asset) =>
                  setState((s) => {
                    if (!s) return s;
                    const items = s.items.filter((c) => !sameAsset(c, asset));
                    if (items.length === 0) return null;
                    return { items, index: Math.min(s.index, items.length - 1) };
                  })
                }
                onClose={() => setState(null)}
              />
            )}
          </AnimatePresence>,
          root,
        )}
    </Ctx.Provider>
  );
}

/** @deprecated Use MediaViewerProvider (kept for existing imports). */
export const AssetViewerProvider = MediaViewerProvider;

const INFO_PREF = "marina:media-viewer-info";
function loadInfoPref(): boolean {
  try {
    return localStorage.getItem(INFO_PREF) === "1";
  } catch {
    return false;
  }
}

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    !!target.closest(
      "input, textarea, select, [contenteditable='true'], [role='slider'], [role='menu'], video, audio",
    )
  );
}

export function MediaViewerDialog({
  items,
  index,
  onIndex,
  onOpenAsset,
  onRemoved,
  onClose,
}: {
  items: readonly ViewableAsset[];
  index: number;
  onIndex: (index: number) => void;
  onOpenAsset: (asset: ViewableAsset) => void;
  onRemoved: (asset: ViewableAsset) => void;
  onClose: () => void;
}) {
  const asset = items[index] as ViewableAsset;
  const reduce = useReducedMotion();
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, true);
  const [infoOpen, setInfoOpen] = useState(loadInfoPref);
  const [confirming, setConfirming] = useState(false);
  const [status, setStatus] = useState("");
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [scale, setScale] = useState(1);
  const zoomRef = useRef<ZoomableImageHandle>(null);
  const qc = useQueryClient();
  const me = useChatState((s) => s.entityName);

  const assetId = asset.id ?? assetIdFromUrl(asset.url);
  const { data: detail } = useAssetDetail(assetId);
  const kind = inferKind({ ...asset, mime: asset.mime ?? detail?.mime });
  const title = asset.title ?? detail?.filename ?? "Asset";
  const alt = assetAltText({
    alt: asset.alt ?? detail?.alt,
    caption: asset.caption ?? detail?.caption,
    filename: title,
  });
  const owner = asset.owner ?? detail?.owner;
  const isOwner = !!me && !!owner && me.toLowerCase() === owner.toLowerCase();
  const src = useSignedAssetUrl(asset.url, asset.urlExpiresAt);
  const posterSrc = useSignedAssetUrl(
    asset.poster?.url ?? detail?.thumbs.poster?.url,
    asset.poster?.expiresAt ?? detail?.thumbs.poster?.expiresAt,
  );
  const many = items.length > 1;

  // A new item starts clean.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset per item.
  useEffect(() => {
    setConfirming(false);
    setLoadError(false);
    setStatus("");
    setScale(1);
  }, [index, asset.url]);

  const go = useCallback(
    (delta: number) => {
      if (!many) return;
      onIndex((index + delta + items.length) % items.length);
    },
    [many, index, items.length, onIndex],
  );

  const toggleInfo = useCallback(() => {
    setInfoOpen((open) => {
      try {
        localStorage.setItem(INFO_PREF, open ? "0" : "1");
      } catch {
        // allow-empty-catch: preference persistence is best-effort.
      }
      return !open;
    });
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (confirming) setConfirming(false);
      else onClose();
      return;
    }
    if (isTypingTarget(e.target) || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      go(1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(-1);
    } else if (e.key === "i") {
      toggleInfo();
    } else if (kind === "image" && (e.key === "+" || e.key === "=")) {
      zoomRef.current?.zoomIn();
    } else if (kind === "image" && e.key === "-") {
      zoomRef.current?.zoomOut();
    } else if (kind === "image" && e.key === "0") {
      zoomRef.current?.fit();
    }
  };

  const copyLink = async () => {
    const plain = plainAssetUrl(asset.url);
    const absolute = plain.startsWith("/") ? `${apiOrigin()}${plain}` : plain;
    try {
      await navigator.clipboard.writeText(absolute);
      setStatus("Link copied.");
    } catch {
      setStatus("Could not copy the link.");
    }
  };

  const remove = async () => {
    if (!assetId) return;
    try {
      await deleteAsset(assetId);
      setConfirming(false);
      void qc.invalidateQueries({ queryKey: ["assets"] });
      onRemoved(asset);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
      setConfirming(false);
    }
  };

  /** Open a lineage relative (its detail carries the URL and facts). */
  const openById = async (id: string) => {
    try {
      const d = await qc.fetchQuery({
        queryKey: assetDetailKey(id),
        queryFn: () => fetchAssetDetail(id),
      });
      onOpenAsset(viewableFromItem(d));
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const canEdit = useCallback(
    (d: LibraryDetail) => !!me && me.toLowerCase() === d.owner.toLowerCase(),
    [me],
  );

  const action =
    "flex min-h-[24px] min-w-[24px] items-center justify-center gap-1 rounded px-1.5 py-1 text-[11px] text-text-dim transition-colors hover:bg-bg-hover hover:text-primary";

  return (
    <motion.div
      className="fixed inset-0 z-[1100] flex items-center justify-center p-2 sm:p-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduce ? 0 : 0.16 }}
    >
      <div
        className="absolute inset-0 bg-bg/85 backdrop-blur-sm"
        aria-hidden="true"
        onClick={onClose}
      />
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="media-viewer-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="relative z-[1101] flex h-[min(92vh,1000px)] w-[min(1400px,97vw)] flex-col overflow-hidden rounded-md border border-border bg-bg shadow-2xl outline-none"
        initial={reduce ? false : { scale: 0.97, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={reduce ? { opacity: 0 } : { scale: 0.97, opacity: 0 }}
        transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 280, damping: 26 }}
      >
        <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
          <h2
            id="media-viewer-title"
            className="min-w-0 flex-1 truncate text-[12px] font-semibold text-text-bright"
            title={title}
          >
            {title}
            {asset.model && (
              <span className="ml-2 rounded bg-bg-hover px-1 text-[9px] uppercase text-text-dim">
                {asset.model}
              </span>
            )}
          </h2>
          {many && (
            <span className="text-[10px] tabular-nums text-text-dim" aria-live="polite">
              {index + 1} / {items.length}
            </span>
          )}
          {kind === "image" && !loadError && (
            <ZoomControls
              scale={scale}
              onZoomIn={() => zoomRef.current?.zoomIn()}
              onZoomOut={() => zoomRef.current?.zoomOut()}
              onFit={() => zoomRef.current?.fit()}
              onActual={() => zoomRef.current?.actual()}
            />
          )}
          <div className="flex flex-wrap items-center gap-0.5">
            {src && (
              <a href={src} download={title} className={action} aria-label="Download">
                <Download size={12} aria-hidden="true" />
              </a>
            )}
            {src && (
              <a
                href={src}
                target="_blank"
                rel="noreferrer"
                className={action}
                aria-label="Open original in a new tab"
              >
                <ExternalLink size={12} aria-hidden="true" />
              </a>
            )}
            <button type="button" className={action} onClick={copyLink} aria-label="Copy link">
              <Link2 size={12} aria-hidden="true" />
            </button>
            {assetId && (
              <AddToCanvasMenu
                compact
                assets={[
                  {
                    id: assetId,
                    url: asset.url,
                    filename: title,
                    mime: asset.mime ?? detail?.mime ?? "application/octet-stream",
                  },
                ]}
                onDone={(message) => setStatus(message)}
              />
            )}
            {assetId && (
              <button
                type="button"
                className={action}
                aria-label="Ask an agent about this asset"
                onClick={() => {
                  draftCommand(`asset show ${assetId}`);
                  onClose();
                }}
              >
                <MessageSquare size={12} aria-hidden="true" />
              </button>
            )}
            {assetId && isOwner && (
              <button
                type="button"
                className={`${action} hover:text-danger`}
                aria-label="Delete asset"
                onClick={() => setConfirming(true)}
              >
                <Trash2 size={12} aria-hidden="true" />
              </button>
            )}
            {assetId && (
              <button
                type="button"
                className={`${action} ${infoOpen ? "text-primary" : ""}`}
                aria-label="Details"
                aria-pressed={infoOpen}
                onClick={toggleInfo}
              >
                <Info size={12} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className={action}
              aria-label="Close viewer"
              data-autofocus
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        </header>

        {confirming && (
          <div
            role="alertdialog"
            aria-label="Confirm delete"
            className="flex flex-wrap items-center gap-2 border-b border-danger/40 bg-danger/10 px-3 py-2 text-[11px] text-text"
          >
            <span className="flex-1">
              Delete <strong>{title}</strong>? This removes the file and its previews everywhere it
              is shown. It cannot be undone.
            </span>
            <button
              type="button"
              className="rounded border border-danger px-2 py-0.5 text-danger"
              onClick={() => void remove()}
            >
              Delete
            </button>
            <button
              type="button"
              className="rounded border border-border px-2 py-0.5 text-text-dim"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          <div className="relative flex min-w-0 flex-1 items-center justify-center bg-bg-card/60 p-2">
            {many && (
              <button
                type="button"
                onClick={() => go(-1)}
                className="absolute left-2 top-1/2 z-10 -translate-y-1/2 rounded-full border border-border bg-bg/80 p-2 text-text-dim hover:text-primary"
                aria-label="Previous asset"
              >
                <ChevronLeft size={16} aria-hidden="true" />
              </button>
            )}
            <motion.div
              key={`${asset.url}#${attempt}`}
              className="flex h-full w-full items-center justify-center"
              initial={reduce ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: reduce ? 0 : 0.15 }}
            >
              {loadError ? (
                <div
                  role="alert"
                  className="flex flex-col items-center gap-2 text-[12px] text-text-dim"
                >
                  <FileQuestion size={28} aria-hidden="true" />
                  <span>This file could not be loaded.</span>
                  <button
                    type="button"
                    className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-text hover:text-primary"
                    onClick={() => {
                      setLoadError(false);
                      setAttempt((a) => a + 1);
                    }}
                  >
                    <RotateCcw size={12} aria-hidden="true" /> Retry
                  </button>
                </div>
              ) : (
                <MediaBody
                  kind={kind}
                  asset={asset}
                  src={src}
                  posterSrc={posterSrc}
                  alt={alt}
                  title={title}
                  durationMs={asset.durationMs ?? detail?.durationMs}
                  zoomRef={zoomRef}
                  onZoom={setScale}
                  onError={() => setLoadError(true)}
                />
              )}
            </motion.div>
            {many && (
              <button
                type="button"
                onClick={() => go(1)}
                className="absolute right-2 top-1/2 z-10 -translate-y-1/2 rounded-full border border-border bg-bg/80 p-2 text-text-dim hover:text-primary"
                aria-label="Next asset"
              >
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            )}
          </div>
          {infoOpen && assetId && (
            <AssetInfoPanel
              assetId={assetId}
              canEdit={canEdit}
              onOpenAsset={(id) => void openById(id)}
              onClose={toggleInfo}
            />
          )}
        </div>

        {(asset.prompt || asset.caption) && kind !== "text" && (
          <footer className="border-t border-border px-3 py-1.5 text-[11px] text-text-dim">
            {asset.caption ?? <>prompt: {asset.prompt}</>}
          </footer>
        )}
        <p className="sr-only" role="status" aria-live="polite">
          {status}
        </p>
        {status && (
          <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded border border-border bg-bg-card px-3 py-1 text-[11px] text-text shadow">
            {status}
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}

function MediaBody({
  kind,
  asset,
  src,
  posterSrc,
  alt,
  title,
  durationMs,
  zoomRef,
  onZoom,
  onError,
}: {
  kind: string;
  asset: ViewableAsset;
  src: string | undefined;
  posterSrc: string | undefined;
  alt: string;
  title: string;
  durationMs?: number | null;
  zoomRef: React.RefObject<ZoomableImageHandle | null>;
  onZoom: (scale: number) => void;
  onError: () => void;
}) {
  if (kind === "text")
    return (
      <div className="max-h-full w-full overflow-auto whitespace-pre-wrap p-3 text-[12px] text-text">
        {asset.prompt ?? asset.title}
      </div>
    );
  if (!src && kind !== "image")
    return (
      <div
        role="status"
        className="h-1/2 w-1/2 animate-pulse rounded bg-bg-hover motion-reduce:animate-none"
      >
        <span className="sr-only">Loading…</span>
      </div>
    );
  switch (kind) {
    case "image":
      return (
        <ZoomableImage
          ref={zoomRef}
          src={src}
          alt={alt}
          placeholder={asset.placeholder}
          onError={onError}
          onZoomChange={(z) => onZoom(z.scale)}
        />
      );
    case "video":
      return (
        <video
          src={src}
          poster={posterSrc}
          controls
          preload="metadata"
          className="max-h-full max-w-full"
          onError={onError}
          aria-label={title}
        >
          <track kind="captions" />
        </video>
      );
    case "audio":
      return <AudioWaveform src={src} title={title} durationMs={durationMs} />;
    case "pdf":
      return (
        <Suspense
          fallback={
            <p role="status" className="text-[11px] text-text-dim">
              Loading PDF viewer…
            </p>
          }
        >
          <PdfPages url={src as string} title={title} />
        </Suspense>
      );
    case "document":
    case "embed":
      return (
        <iframe
          src={src}
          title={title}
          className="h-full w-full rounded border border-border bg-white"
          sandbox="allow-scripts allow-same-origin allow-popups"
        />
      );
    default:
      return (
        <div className="flex flex-col items-center gap-2 text-[12px] text-text-dim">
          <FileQuestion size={28} aria-hidden="true" />
          <span>No preview for this file type.</span>
          <a href={src} download={title} className="text-primary underline">
            Download {title}
          </a>
        </div>
      );
  }
}
