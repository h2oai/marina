// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { ExternalLink, Loader2, RefreshCcw, TriangleAlert, Video, Volume2 } from "lucide-react";
import type { ReactElement } from "react";
import { useMemo } from "react";
import { canvasPermalink } from "../canvas/lib/canvas-links";
import type { CanvasNodeData } from "../canvas/lib/types";
import { useCanvasNode } from "../hooks/use-canvas-node";
import { openBoundPanel } from "../lib/panel-bindings";
import { formatTime } from "../lib/utils";
import { useAssetViewer, type ViewableAsset } from "./AssetLightbox";

import { parseCanvasReference, ReferenceContent } from "./CanvasReference";
import { InteractivePanel } from "./InteractivePanel";

interface CanvasNodeEmbedProps {
  canvasId: string;
  nodeId: string;
  actor?: string | null;
  summary?: string;
  kind?: string;
  timestamp?: number;
  active?: boolean;
}

export function CanvasNodeEmbed({
  canvasId,
  nodeId,
  actor,
  summary,
  kind,
  timestamp,
  active = true,
}: CanvasNodeEmbedProps) {
  const { data, isLoading, isError, refetch } = useCanvasNode(canvasId, nodeId, active);
  const { open: openAsset } = useAssetViewer();
  const node = useMemo(() => (isError ? null : (data ?? null)), [data, isError]);

  const nodeHeader = (
    <div className="flex items-center justify-between text-[10px] uppercase text-text-dim">
      <span className="truncate">{actor ?? "system"}</span>
      <span className="flex items-center gap-1">
        {kind && <span className="rounded bg-border px-1 text-[9px] uppercase">{kind}</span>}
        {timestamp != null && <span>{formatTime(timestamp)}</span>}
      </span>
    </div>
  );

  let body: ReactElement;

  if (isLoading || !node) {
    body = (
      <div className="flex items-center gap-2 py-4 text-text-dim">
        {isLoading ? (
          <>
            <Loader2 size={14} className="animate-spin" />
            <span>Loading canvas node…</span>
          </>
        ) : isError ? (
          <>
            <TriangleAlert size={14} className="text-danger" />
            <span>Unable to load canvas node.</span>
          </>
        ) : (
          <span>No node data yet.</span>
        )}
      </div>
    );
  } else {
    body = (
      <div className="mt-2 space-y-2">
        {summary && <div className="text-[12px] text-text-bright">{summary}</div>}
        {renderNodePreview(node, openAsset, active)}
      </div>
    );
  }

  return (
    <div className="group relative my-1.5 rounded-md border border-border bg-bg/80 p-2 shadow-sm">
      {nodeHeader}
      {body}
      <div className="mt-2 flex items-center gap-2 text-[10px] text-text-dim">
        <button
          type="button"
          className="text-primary"
          onClick={() => openBoundPanel({ kind: "canvas-node", canvasId, nodeId })}
        >
          Open as panel
        </button>
        <a
          href={canvasPermalink({ canvasId, nodeId }, window.location.href)}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 text-text-dim hover:text-primary transition-colors"
        >
          <ExternalLink size={11} />
          Edit in canvas
        </a>
        <button
          type="button"
          onClick={() => refetch()}
          className="flex items-center gap-1 text-text-dim hover:text-primary transition-colors"
        >
          <RefreshCcw size={11} />
          Refresh
        </button>
      </div>
    </div>
  );
}

function renderNodePreview(
  node: CanvasNodeData & { data: Record<string, unknown> },
  openAsset: (asset: ViewableAsset) => void,
  active: boolean,
): ReactElement {
  const data = node.data ?? {};
  const title = (data.title as string) ?? (data.name as string) ?? node.type;
  const viewable = (url: string): ViewableAsset => ({
    url,
    kind: node.type,
    title,
    prompt: data.prompt as string | undefined,
    model: data.model as string | undefined,
    mime: data.mime as string | undefined,
  });

  switch (node.type) {
    case "text": {
      const content = (data.content as string) ?? "";
      return (
        <div className="rounded border border-border bg-bg px-2 py-2">
          <div className="text-[11px] font-semibold text-text-bright">{title}</div>
          <div className="mt-1 whitespace-pre-wrap text-[11px] text-text">{content}</div>
        </div>
      );
    }
    case "image": {
      const url = (data.url as string) ?? (data.preview_url as string);
      if (!url) return placeholder("Image asset not available.");
      return (
        <figure className="overflow-hidden rounded border border-border/70">
          <button
            type="button"
            onClick={() => openAsset(viewable(url))}
            className="block w-full cursor-zoom-in"
            title="Click to view full size"
          >
            <img src={url} alt={title} className="max-h-48 w-full object-cover" />
          </button>
          <figcaption className="bg-bg/80 px-2 py-1 text-[10px] text-text-dim">{title}</figcaption>
        </figure>
      );
    }
    case "video": {
      const url = (data.url as string) ?? (data.preview_url as string);
      if (!url) return placeholder("Video asset not available.");
      return (
        <button
          type="button"
          onClick={() => openAsset(viewable(url))}
          className="flex w-full items-center justify-between rounded border border-border/70 bg-bg px-2 py-2 text-left transition-colors hover:border-primary"
          title="Click to play"
        >
          <div className="flex items-center gap-2 text-text">
            <Video size={14} className="text-primary" />
            <span className="truncate text-[11px] text-text-bright">{title}</span>
          </div>
          <span className="text-[10px] text-primary">Play ▸</span>
        </button>
      );
    }
    case "audio": {
      const url = (data.url as string) ?? (data.preview_url as string);
      if (!url) return placeholder("Audio asset not available.");
      return (
        <button
          type="button"
          onClick={() => openAsset(viewable(url))}
          className="flex w-full items-center justify-between rounded border border-border/70 bg-bg px-2 py-2 text-left transition-colors hover:border-primary"
          title="Click to play"
        >
          <div className="flex items-center gap-2 text-text">
            <Volume2 size={14} className="text-primary" />
            <span className="truncate text-[11px] text-text-bright">{title}</span>
          </div>
          <span className="text-[10px] text-primary">Play ▸</span>
        </button>
      );
    }
    case "pdf":
    case "document": {
      const url = (data.url as string) ?? (data.preview_url as string);
      const filename = (data.filename as string) ?? title;
      if (!url) return placeholder("Document asset not available.");
      return (
        <button
          type="button"
          onClick={() => openAsset(viewable(url))}
          className="flex w-full items-center gap-1 rounded border border-border bg-bg px-2 py-2 text-left transition-colors hover:border-primary"
          title="Click to view"
        >
          <ExternalLink size={11} className="shrink-0 text-primary" />
          <span className="truncate text-[11px] font-semibold text-text-bright">{filename}</span>
        </button>
      );
    }
    case "embed": {
      const reference = parseCanvasReference(data.reference);
      if (reference) return <ReferenceContent reference={reference} active={active} />;
      const url = data.url as string | undefined;
      if (!url) return placeholder("Embed URL not available.");
      return (
        <iframe
          src={url}
          title={title}
          className="h-48 w-full rounded border border-border"
          sandbox="allow-scripts allow-same-origin allow-popups"
        />
      );
    }
    case "frame": {
      const content = (data.content as string) ?? "";
      return (
        <div className="rounded border border-primary/40 bg-primary/5 px-2 py-2">
          <div className="text-[11px] font-semibold text-primary">{title}</div>
          <div className="mt-1 whitespace-pre-wrap text-[11px] text-text">{content}</div>
        </div>
      );
    }
    case "a2ui":
      return (
        <InteractivePanel active={active} canvasId={node.canvas_id} nodeId={node.id} data={data} />
      );

    default:
      return placeholder(`Preview for node type "${node.type}" is not available.`);
  }
}

function placeholder(text: string): ReactElement {
  return (
    <div className="rounded border border-border bg-bg px-2 py-2 text-[10px] text-text-dim">
      {text}
    </div>
  );
}
