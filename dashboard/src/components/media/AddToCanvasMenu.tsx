// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * "Add to canvas": choose one of the canvases the viewer can see and show the
 * chosen assets on it as new nodes (the asset is referenced, not copied).
 */

import { LayoutGrid } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { addAssetToCanvas, useCanvasList } from "../../lib/asset-library";

export interface CanvasAsset {
  id: string;
  url: string;
  filename: string;
  mime: string;
}

export function AddToCanvasMenu({
  assets,
  onDone,
  className,
  compact,
}: {
  assets: readonly CanvasAsset[];
  onDone?: (message: string, ok: boolean) => void;
  className?: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { data: canvases, isLoading, error } = useCanvasList(open);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const add = async (canvasId: string, name: string) => {
    setBusy(true);
    let failed = 0;
    let firstError = "";
    for (const [i, asset] of assets.entries()) {
      try {
        await addAssetToCanvas(canvasId, asset, i);
      } catch (err) {
        failed++;
        firstError ||= err instanceof Error ? err.message : String(err);
      }
    }
    setBusy(false);
    setOpen(false);
    const added = assets.length - failed;
    onDone?.(
      failed
        ? `Added ${added} of ${assets.length} to ${name}: ${firstError}`
        : `Added ${added === 1 ? "1 asset" : `${added} assets`} to ${name}.`,
      failed === 0,
    );
  };

  return (
    <div ref={ref} className={`relative ${className ?? ""}`}>
      <button
        type="button"
        className="flex min-h-[24px] min-w-[24px] items-center justify-center gap-1 rounded px-1.5 py-1 text-[11px] text-text-dim transition-colors hover:bg-bg-hover hover:text-primary disabled:opacity-40"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={compact ? "Add to canvas" : undefined}
        disabled={busy || assets.length === 0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
      >
        <LayoutGrid size={12} aria-hidden="true" />
        {!compact && <span>Add to canvas</span>}
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Choose a canvas"
          className="absolute right-0 z-20 mt-1 max-h-64 w-56 overflow-auto rounded border border-border bg-bg-card p-1 shadow-xl"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          {isLoading && <p className="px-2 py-1 text-[11px] text-text-dim">Loading canvases…</p>}
          {error && <p className="px-2 py-1 text-[11px] text-danger">{error.message}</p>}
          {canvases?.length === 0 && (
            <p className="px-2 py-1 text-[11px] text-text-dim">No canvases yet.</p>
          )}
          {canvases?.map((c) => (
            <button
              key={c.id}
              type="button"
              role="menuitem"
              className="block w-full truncate rounded px-2 py-1 text-left text-[11px] text-text hover:bg-bg-hover hover:text-primary"
              onClick={() => void add(c.id, c.name)}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
