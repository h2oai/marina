import { Handle, type NodeProps, NodeResizer, Position } from "@xyflow/react";
import { useEffect, useRef, useState } from "react";
import { emptyAssetLabel } from "../lib/node-fields";
import { NodeMeta } from "./NodeMeta";

export default function PdfNode({ data, selected }: NodeProps) {
  const url = (data.url as string) ?? "";
  const filename = (data.filename as string) ?? "Document.pdf";
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pageNum, setPageNum] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pdfDocRef = useRef<unknown>(null);

  useEffect(() => {
    if (!url) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setError(null);

    async function renderPage(pdf: { getPage: (n: number) => Promise<unknown> }, num: number) {
      const page = (await pdf.getPage(num)) as {
        getViewport: (opts: { scale: number }) => { width: number; height: number };
        render: (ctx: {
          canvasContext: CanvasRenderingContext2D;
          viewport: { width: number; height: number };
        }) => { promise: Promise<void> };
      };
      const canvas = canvasRef.current;
      if (!canvas || cancelled) return;
      const viewport = page.getViewport({ scale: 1.2 });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d")!;
      await page.render({ canvasContext: ctx, viewport }).promise;
    }

    async function loadPdf() {
      try {
        const pdfjsLib = await import("pdfjs-dist");
        pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

        const pdf = await pdfjsLib.getDocument({ url }).promise;
        if (cancelled) return;
        pdfDocRef.current = pdf;
        setNumPages(pdf.numPages);
        setLoading(false);
        renderPage(pdf, 1);
      } catch (err) {
        if (cancelled) return;
        setError((err as Error)?.message ?? "Failed to load PDF");
        setLoading(false);
      }
    }

    loadPdf();
    return () => {
      cancelled = true;
    };
  }, [url]);

  useEffect(() => {
    if (!pdfDocRef.current || pageNum < 1) return;
    const pdf = pdfDocRef.current as {
      getPage: (n: number) => Promise<unknown>;
    };
    const canvas = canvasRef.current;
    if (!canvas) return;

    (async () => {
      const page = (await pdf.getPage(pageNum)) as {
        getViewport: (opts: { scale: number }) => { width: number; height: number };
        render: (ctx: {
          canvasContext: CanvasRenderingContext2D;
          viewport: { width: number; height: number };
        }) => { promise: Promise<void> };
      };
      const viewport = page.getViewport({ scale: 1.2 });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d")!;
      await page.render({ canvasContext: ctx, viewport }).promise;
    })();
  }, [pageNum]);

  return (
    <div className="rounded-lg overflow-hidden bg-bg-card border border-red-800/50 shadow-lg shadow-red-900/20 flex flex-col h-full">
      <NodeResizer
        isVisible={!!selected}
        minWidth={200}
        minHeight={250}
        lineClassName="!border-red-500/50"
        handleClassName="!w-2 !h-2 !bg-red-500 !border-red-400"
      />
      <Handle type="target" position={Position.Top} className="!bg-red-500" />
      {selected && (
        <div className="nodrag px-3 py-1.5 bg-red-900/30 text-xs text-red-300 font-medium truncate flex items-center justify-between">
          <NodeMeta filename={filename} data={data} />
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-red-400 hover:text-red-300 ml-2 shrink-0"
            >
              Open
            </a>
          )}
        </div>
      )}
      <div className="flex-1 relative p-2 min-h-[200px] overflow-auto">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center z-10 bg-bg-card/80">
            <span className="text-text-dim text-sm animate-pulse">Loading PDF...</span>
          </div>
        )}
        {!loading && !url && (
          <div className="flex items-center justify-center h-full text-text-dim text-sm">
            {emptyAssetLabel("pdf", false)}
          </div>
        )}
        {!loading && error && (
          <div className="flex flex-col items-center justify-center h-full text-red-400 text-sm gap-1 px-4 text-center">
            <span>{emptyAssetLabel("pdf", true)}</span>
            <span className="text-xs text-red-500/70 truncate max-w-full" title={error}>
              {error}
            </span>
          </div>
        )}
        <canvas
          ref={canvasRef}
          className={`max-w-full ${loading || !url || error ? "invisible" : ""}`}
        />
      </div>
      {numPages > 1 && (
        <div className="nodrag flex items-center justify-center gap-2 py-1.5 bg-bg-hover/50 text-xs text-text">
          <button
            type="button"
            onClick={() => setPageNum((p) => Math.max(1, p - 1))}
            disabled={pageNum <= 1}
            className="px-2 py-0.5 bg-bg-hover rounded hover:bg-bg-hover disabled:opacity-30"
          >
            Prev
          </button>
          <span>
            {pageNum} / {numPages}
          </span>
          <button
            type="button"
            onClick={() => setPageNum((p) => Math.min(numPages, p + 1))}
            disabled={pageNum >= numPages}
            className="px-2 py-0.5 bg-bg-hover rounded hover:bg-bg-hover disabled:opacity-30"
          >
            Next
          </button>
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-red-500" />
    </div>
  );
}
