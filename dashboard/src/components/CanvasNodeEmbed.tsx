import { ExternalLink, Loader2, RefreshCcw, TriangleAlert, Video, Volume2 } from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CanvasNodeData } from "../canvas/lib/types";
import { A2UIRenderer } from "../canvas/nodes/a2ui/A2UIRenderer";
import type { A2UIAction, A2UINodeData } from "../canvas/nodes/a2ui/types";
import { useCanvasNode } from "../hooks/use-canvas-node";
import { authFetch } from "../lib/api";
import { formatTime } from "../lib/utils";

const API_BASE = window.location.origin;

interface CanvasNodeEmbedProps {
  canvasId: string;
  nodeId: string;
  actor?: string | null;
  summary?: string;
  kind?: string;
  timestamp?: number;
}

type NodeData = Record<string, unknown>;

export function CanvasNodeEmbed({
  canvasId,
  nodeId,
  actor,
  summary,
  kind,
  timestamp,
}: CanvasNodeEmbedProps) {
  const { data, isLoading, isError, refetch } = useCanvasNode(canvasId, nodeId);
  const [localData, setLocalData] = useState<NodeData | null>(null);

  useEffect(() => {
    if (data) {
      setLocalData(data.data);
    }
  }, [data]);

  const node = useMemo(() => {
    if (!data) return null;
    return { ...data, data: localData ?? data.data };
  }, [data, localData]);

  const handleA2UIAction = useCallback(
    async (action: A2UIAction) => {
      if (!node) return;
      try {
        const updated = {
          ...node.data,
          lastAction: {
            name: action.event.name,
            payload: action.event.payload,
            timestamp: Date.now(),
          },
        };
        await authFetch(`${API_BASE}/api/canvases/${canvasId}/nodes/${nodeId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: updated }),
        });
        setLocalData(updated);
      } catch {
        // ignore — the canvas view will still reflect the change if it succeeded
      }
    },
    [canvasId, node, nodeId],
  );

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
        {renderNodePreview(node, handleA2UIAction)}
      </div>
    );
  }

  return (
    <div className="group relative my-1.5 rounded-md border border-border bg-bg/80 p-2 shadow-sm">
      {nodeHeader}
      {body}
      <div className="mt-2 flex items-center gap-2 text-[10px] text-text-dim">
        <a
          href={`/canvas`}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 text-text-dim hover:text-primary transition-colors"
        >
          <ExternalLink size={11} />
          Open canvas
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
  onA2UIAction: (action: A2UIAction) => void,
): ReactElement {
  const data = node.data ?? {};
  const title = (data.title as string) ?? (data.name as string) ?? node.type;

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
          <img src={url} alt={title} className="max-h-48 w-full object-cover" />
          <figcaption className="bg-bg/80 px-2 py-1 text-[10px] text-text-dim">{title}</figcaption>
        </figure>
      );
    }
    case "video": {
      const url = (data.url as string) ?? (data.preview_url as string);
      if (!url) return placeholder("Video asset not available.");
      return (
        <div className="flex items-center justify-between rounded border border-border/70 bg-bg px-2 py-2">
          <div className="flex items-center gap-2 text-text">
            <Video size={14} className="text-primary" />
            <span className="truncate text-[11px] text-text-bright">{title}</span>
          </div>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="text-[10px] text-primary hover:underline"
          >
            Open video
          </a>
        </div>
      );
    }
    case "audio": {
      const url = (data.url as string) ?? (data.preview_url as string);
      if (!url) return placeholder("Audio asset not available.");
      return (
        <div className="flex items-center justify-between rounded border border-border/70 bg-bg px-2 py-2">
          <div className="flex items-center gap-2 text-text">
            <Volume2 size={14} className="text-primary" />
            <span className="truncate text-[11px] text-text-bright">{title}</span>
          </div>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="text-[10px] text-primary hover:underline"
          >
            Play audio
          </a>
        </div>
      );
    }
    case "pdf":
    case "document": {
      const url = (data.url as string) ?? (data.preview_url as string);
      const filename = (data.filename as string) ?? title;
      if (!url) return placeholder("Document asset not available.");
      return (
        <div className="rounded border border-border bg-bg px-2 py-2">
          <div className="text-[11px] font-semibold text-text-bright">{filename}</div>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-[10px] text-primary hover:underline"
          >
            <ExternalLink size={11} />
            View document
          </a>
        </div>
      );
    }
    case "embed": {
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
    case "a2ui": {
      const components = (data.components as A2UINodeData["components"]) ?? [];
      const nodeData: A2UINodeData = {
        components,
        rootId: (data.rootId as string) ?? undefined,
        dataModel: (data.dataModel as Record<string, unknown>) ?? undefined,
      };
      return (
        <div className="rounded border border-indigo-800/40 bg-indigo-950/30 p-2 text-[11px] text-text">
          <div className="mb-2 text-[11px] font-semibold text-indigo-200">{title}</div>
          <A2UIRenderer nodeData={nodeData} onAction={onA2UIAction} />
        </div>
      );
    }
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
