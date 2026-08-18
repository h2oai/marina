// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { Handle, type NodeProps, NodeResizer, Position } from "@xyflow/react";
import { resolveAuthor } from "../lib/node-fields";
import { NodeMeta } from "./NodeMeta";

/**
 * Structured asset preview written by the backend at publish time. Mirrors
 * `AssetPreview` in `src/engine/commands/canvas.ts`. Renders inline so users
 * see CSV column headers and text snippets without a second fetch.
 */
interface AssetPreview {
  kind: "csv" | "text" | "json" | "binary";
  filename: string;
  mime: string;
  size: number;
  rows?: string[];
  cols?: number;
  snippet?: string;
}

function PreviewBlock({ preview }: { preview: AssetPreview }) {
  if (preview.kind === "binary") {
    return (
      <div className="text-xs text-text-dim italic">
        Binary asset — {preview.mime}, {preview.size}B
      </div>
    );
  }
  if (preview.kind === "csv" && preview.rows && preview.rows.length > 0) {
    return (
      <div className="text-xs font-mono text-text space-y-0.5">
        <div className="text-text-dim">
          {preview.cols ?? 0} cols · {preview.size}B
        </div>
        {preview.rows.map((row, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: CSV row position is the row identity
            key={i}
            className={`truncate ${i === 0 ? "text-text-bright font-semibold" : "text-text"}`}
            title={row}
          >
            {row || "·"}
          </div>
        ))}
      </div>
    );
  }
  if (preview.snippet) {
    return (
      <pre className="text-xs font-mono text-text whitespace-pre-wrap break-words">
        {preview.snippet}
      </pre>
    );
  }
  return null;
}

/** Map feedType to a border accent colour class */
const FEED_BORDER: Record<string, string> = {
  board_post: "border-amber-800/50",
  pool_note: "border-purple-800/50",
  channel_message: "border-green-800/50",
  task_event: "border-blue-800/50",
  market_position: "border-primary/40",
  market_consensus: "border-teal-800/50",
  market_resolution: "border-red-800/50",
  intent_result: "border-emerald-800/50",
  canvas_intent: "border-violet-800/50",
  conversation: "border-violet-800/30",
  note_created: "border-sky-800/50",
  note_link_created: "border-indigo-800/50",
  rank_change: "border-yellow-800/50",
  manual: "border-border/60",
};

const FEED_LABEL: Record<string, string> = {
  intent_result: "Intent Result",
  canvas_intent: "Canvas Intent",
  conversation: "Message",
  board_post: "Board Post",
  pool_note: "Pool Note",
  channel_message: "Channel",
  task_event: "Task",
  market_position: "Market Position",
  market_consensus: "Market Consensus",
  market_resolution: "Market Resolution",
  note_created: "Note",
  note_link_created: "Note Link",
  rank_change: "Rank Change",
  manual: "Note",
};

/** Title-case an unknown feedType so users see "Some Event" instead of "some_event". */
export function friendlyFeedType(feedType: string): string {
  return feedType
    .split(/[_-]/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

/** Build display content from feed-publisher data or plain text fields. */
function resolveContent(data: Record<string, unknown>): string {
  // Direct content fields
  const direct = (data.content as string) ?? (data.text as string) ?? (data.body as string) ?? "";
  if (direct) return direct;

  // Feed-type structured content
  const feedType = data.feedType as string | undefined;
  if (!feedType) return "";

  const parts: string[] = [];
  if (data.title) parts.push(String(data.title));
  if (data.action) parts.push(`Action: ${data.action}`);
  if (data.question) parts.push(String(data.question));
  if (data.direction) parts.push(`Direction: ${data.direction}`);
  if (data.confidence != null) parts.push(`Confidence: ${data.confidence}`);
  if (data.reasoning) parts.push(String(data.reasoning));
  if (data.outcome) parts.push(`Outcome: ${data.outcome}`);
  if (data.yesPercent != null) parts.push(`Yes: ${data.yesPercent}%  No: ${data.noPercent}%`);
  return parts.join("\n");
}

export function TextNode({ data, selected }: NodeProps) {
  const content = resolveContent(data as Record<string, unknown>);
  const feedType = data.feedType as string | undefined;
  const label =
    (data.label as string) ??
    (feedType ? (FEED_LABEL[feedType] ?? friendlyFeedType(feedType)) : "") ??
    "";
  const author = resolveAuthor(data as Record<string, unknown>);
  const border = (feedType && FEED_BORDER[feedType]) ?? "border-border/60";
  // Reply context: when this node was published with reply:<parent>, surface a
  // small "in reply to" indicator so threading reads visually without having
  // to follow edges.
  const parentNodeId = data.parent_node_id as string | undefined;
  const preview = data.preview as AssetPreview | undefined;

  return (
    <div className={`rounded-lg bg-bg-card border ${border} shadow-lg p-3 h-full flex flex-col`}>
      <NodeResizer
        isVisible={!!selected}
        minWidth={120}
        minHeight={60}
        lineClassName="!border-text-dim/50"
        handleClassName="!w-2 !h-2 !bg-text-dim !border-text-dim"
      />
      <Handle type="target" position={Position.Top} className="!bg-text-dim" />
      {parentNodeId && (
        <div
          className="mb-1 text-[10px] text-violet-400/80 truncate"
          title={`Reply to ${parentNodeId}`}
        >
          ↩ in reply to {parentNodeId.slice(0, 8)}…
        </div>
      )}
      {/* Always show header with label + author when available */}
      {(label || author) && (
        <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
          {label && <span className="font-medium text-text truncate">{label}</span>}
          {author && <span className="text-text-dim shrink-0">by {author}</span>}
        </div>
      )}
      {selected && <NodeMeta filename={label} data={data} className="mb-1" />}
      <div className="flex-1 text-sm text-text-bright whitespace-pre-wrap overflow-auto">
        {content ? (
          content
        ) : preview ? (
          <PreviewBlock preview={preview} />
        ) : (
          <span className="text-text-dim italic">Empty</span>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-text-dim" />
    </div>
  );
}
