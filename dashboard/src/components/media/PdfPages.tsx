// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * PDF pages in the media viewer, rendered by the bundled pdf.js worker (the
 * same local worker PdfNode uses — no CDN, works under `worker-src 'self'`).
 * pdf.js fetches the file itself and sends the session bearer for this
 * server's own assets, so a long read never outlives a signed URL.
 */

import { ChevronLeft, ChevronRight } from "lucide-react";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { assetAuthHeaders } from "../../lib/asset-url";

interface PdfPage {
  getViewport(opts: { scale: number }): { width: number; height: number };
  render(ctx: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }): { promise: Promise<void>; cancel?: () => void };
}
interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  destroy?: () => void;
}

export function PdfPages({
  url,
  title,
  onError,
}: {
  url: string;
  title: string;
  onError?: (message: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    let cancelled = false;
    let loaded: PdfDoc | null = null;
    setDoc(null);
    setPage(1);
    setError(null);
    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        const pdf = (await pdfjs.getDocument({ url, httpHeaders: assetAuthHeaders(url) })
          .promise) as unknown as PdfDoc;
        loaded = pdf;
        if (!cancelled) setDoc(pdf);
      } catch (err) {
        if (cancelled) return;
        const message = (err as Error)?.message ?? "Failed to load PDF";
        setError(message);
        onErrorRef.current?.(message);
      }
    })();
    return () => {
      cancelled = true;
      loaded?.destroy?.();
    };
  }, [url]);

  useEffect(() => {
    if (!doc) return;
    let task: { cancel?: () => void } | undefined;
    let cancelled = false;
    (async () => {
      const p = await doc.getPage(page);
      const canvas = canvasRef.current;
      if (!canvas || cancelled) return;
      const ratio = window.devicePixelRatio || 1;
      const viewport = p.getViewport({ scale: 1.5 * ratio });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const r = p.render({ canvasContext: ctx, viewport });
      task = r;
      await r.promise.catch(() => undefined);
    })();
    return () => {
      cancelled = true;
      task?.cancel?.();
    };
  }, [doc, page]);

  const pages = doc?.numPages ?? 0;
  const go = (n: number) => setPage((cur) => Math.min(Math.max(1, n), pages || cur));
  // PageUp/PageDown page while focus is on the page controls.
  const pageKeys = (e: KeyboardEvent) => {
    if (e.key === "PageDown") {
      e.preventDefault();
      go(page + 1);
    } else if (e.key === "PageUp") {
      e.preventDefault();
      go(page - 1);
    }
  };

  if (error)
    return (
      <p role="alert" className="text-[12px] text-danger">
        Could not render this PDF: {error}
      </p>
    );

  return (
    <div className="flex h-full w-full flex-col items-center gap-2">
      <div className="min-h-0 w-full flex-1 overflow-auto text-center">
        {!doc && (
          <div
            role="status"
            className="mx-auto h-full max-h-[70vh] w-[min(560px,90%)] animate-pulse rounded bg-bg-hover motion-reduce:animate-none"
          >
            <span className="sr-only">Loading PDF…</span>
          </div>
        )}
        <canvas
          ref={canvasRef}
          hidden={!doc}
          role="img"
          aria-label={`${title}, page ${page} of ${pages}`}
          className="mx-auto max-h-full max-w-full rounded bg-white shadow"
        />
      </div>
      {pages > 0 && (
        <nav aria-label="PDF pages" className="flex items-center gap-3 text-[11px] text-text-dim">
          <button
            type="button"
            className="rounded border border-border px-2 py-0.5 hover:text-primary disabled:opacity-40"
            onClick={() => go(page - 1)}
            onKeyDown={pageKeys}
            disabled={page <= 1}
            aria-label="Previous page"
          >
            <ChevronLeft size={12} aria-hidden="true" />
          </button>
          <span aria-live="polite">
            Page {page} of {pages}
          </span>
          <button
            type="button"
            className="rounded border border-border px-2 py-0.5 hover:text-primary disabled:opacity-40"
            onClick={() => go(page + 1)}
            onKeyDown={pageKeys}
            disabled={page >= pages}
            aria-label="Next page"
          >
            <ChevronRight size={12} aria-hidden="true" />
          </button>
        </nav>
      )}
    </div>
  );
}
