/**
 * Asset lightbox — an in-app popout viewer for generated/uploaded media and
 * docs. Provided once (AssetViewerProvider) and triggered from anywhere via
 * `useAssetViewer().open(asset)` — the Rich-view canvas embeds and the Media
 * Jobs list both use it, so clicking an image/video/doc views it full-size
 * instead of bouncing to a new browser tab.
 *
 * Used outside a provider, the hook falls back to `window.open` so embeds that
 * live in other surfaces (e.g. the unified context panel) still work.
 */

import { Download, ExternalLink, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

export interface ViewableAsset {
  url: string;
  /** image | video | audio | pdf | document | embed | text — inferred if omitted. */
  kind?: string;
  title?: string;
  prompt?: string;
  model?: string;
  mime?: string;
}

interface AssetViewerCtx {
  open: (asset: ViewableAsset) => void;
}

const fallback: AssetViewerCtx = {
  open: (a) => {
    if (typeof window !== "undefined") window.open(a.url, "_blank", "noopener");
  },
};

const Ctx = createContext<AssetViewerCtx>(fallback);

/** Open the asset lightbox (or fall back to a new tab outside a provider). */
export function useAssetViewer(): AssetViewerCtx {
  return useContext(Ctx);
}

/** Normalize a node/job kind + mime + url into a viewer kind. */
export function inferKind(asset: ViewableAsset): string {
  if (asset.kind && asset.kind !== "document") return asset.kind === "pdf" ? "pdf" : asset.kind;
  const mime = (asset.mime ?? "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  const path = (asset.url.split("?")[0] ?? "").toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|avif)$/.test(path)) return "image";
  if (/\.(mp4|webm|mov|m4v)$/.test(path)) return "video";
  if (/\.(mp3|wav|ogg|m4a)$/.test(path)) return "audio";
  if (/\.pdf$/.test(path)) return "pdf";
  return asset.kind ?? "document";
}

const root =
  typeof window !== "undefined"
    ? (document.getElementById("asset-viewer-root") ??
      (() => {
        const el = document.createElement("div");
        el.id = "asset-viewer-root";
        document.body.appendChild(el);
        return el;
      })())
    : null;

export function AssetViewerProvider({ children }: { children: ReactNode }) {
  const [asset, setAsset] = useState<ViewableAsset | null>(null);
  const value = useMemo<AssetViewerCtx>(() => ({ open: setAsset }), []);
  return (
    <Ctx.Provider value={value}>
      {children}
      <AssetLightbox asset={asset} onClose={() => setAsset(null)} />
    </Ctx.Provider>
  );
}

function AssetLightbox({ asset, onClose }: { asset: ViewableAsset | null; onClose: () => void }) {
  useEffect(() => {
    if (!asset) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [asset, onClose]);

  if (!root) return null;
  const kind = asset ? inferKind(asset) : "";

  return createPortal(
    <AnimatePresence>
      {asset && (
        <motion.div
          className="fixed inset-0 z-[1100] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <button
            type="button"
            className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            aria-label="Close viewer"
            onClick={onClose}
          />
          <motion.div
            className="relative z-[1101] flex max-h-[92vh] w-[min(1100px,95vw)] flex-col overflow-hidden rounded-md border border-border bg-bg/95 shadow-2xl shadow-black/50"
            initial={{ scale: 0.96, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.96, opacity: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 24 }}
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-2">
              <span className="truncate text-[12px] font-semibold text-text-bright">
                {asset.title ?? "Asset"}
                {asset.model && (
                  <span className="ml-2 rounded bg-border px-1 text-[9px] uppercase text-text-dim">
                    {asset.model}
                  </span>
                )}
              </span>
              <div className="flex items-center gap-2">
                <a
                  href={asset.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 text-[10px] text-text-dim transition-colors hover:text-primary"
                  title="Open original in a new tab"
                >
                  <ExternalLink size={12} /> Open
                </a>
                <a
                  href={asset.url}
                  download
                  className="flex items-center gap-1 text-[10px] text-text-dim transition-colors hover:text-primary"
                  title="Download"
                >
                  <Download size={12} /> Download
                </a>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded p-1 text-text-dim transition-colors hover:text-primary"
                  aria-label="Close viewer"
                >
                  <X size={14} />
                </button>
              </div>
            </div>

            <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/30 p-2">
              {kind === "image" && (
                <img
                  src={asset.url}
                  alt={asset.title ?? "image"}
                  className="mx-auto max-h-[78vh] w-auto object-contain"
                />
              )}
              {kind === "video" && (
                <video src={asset.url} controls autoPlay className="mx-auto max-h-[78vh] w-auto">
                  <track kind="captions" />
                </video>
              )}
              {kind === "audio" && (
                <audio src={asset.url} controls className="w-[min(640px,90%)]" />
              )}
              {(kind === "pdf" || kind === "document" || kind === "embed") && (
                <iframe
                  src={asset.url}
                  title={asset.title ?? "document"}
                  className="h-[78vh] w-full rounded border border-border bg-white"
                  sandbox="allow-scripts allow-same-origin allow-popups"
                />
              )}
              {kind === "text" && (
                <div className="max-h-[78vh] w-full overflow-auto whitespace-pre-wrap p-3 text-[12px] text-text">
                  {asset.prompt ?? asset.title}
                </div>
              )}
            </div>

            {asset.prompt && kind !== "text" && (
              <div className="border-t border-border bg-bg/80 px-4 py-2 text-[11px] text-text-dim">
                <span className="text-text-dim">prompt:</span> {asset.prompt}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    root,
  );
}
