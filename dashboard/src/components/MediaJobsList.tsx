// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { memo } from "react";
import type { MediaJob } from "../lib/types";
import { useAssetViewer } from "./AssetLightbox";

const STATUS_STYLE: Record<
  MediaJob["status"],
  { label: string; color: string; background: string }
> = {
  pending: { label: "Pending", color: "#f59e0b", background: "rgba(245,158,11,0.15)" },
  running: { label: "Rendering", color: "#3b82f6", background: "rgba(59,130,246,0.18)" },
  succeeded: { label: "Complete", color: "#22c55e", background: "rgba(34,197,94,0.18)" },
  failed: { label: "Failed", color: "#ef4444", background: "rgba(239,68,68,0.18)" },
  blocked: { label: "Blocked", color: "#f97316", background: "rgba(249,115,22,0.18)" },
};

export interface MediaJobsListProps {
  jobs: MediaJob[];
  max?: number;
  showEntity?: boolean;
  onRetry?: (job: MediaJob) => Promise<void> | void;
  onDeleteAsset?: (job: MediaJob) => Promise<void> | void;
  sendCommand?: (command: string) => void;
  emptyMessage?: string;
}

export const MediaJobsList = memo(function MediaJobsList({
  jobs,
  max = 10,
  showEntity = false,
  onRetry,
  onDeleteAsset,
  sendCommand,
  emptyMessage = "No media jobs yet.",
}: MediaJobsListProps) {
  if (!jobs || jobs.length === 0) {
    return (
      <div className="rounded border border-border bg-bg px-2 py-3 text-[11px] text-text-dim">
        {emptyMessage}
      </div>
    );
  }

  const visible = jobs.slice(0, max);
  return (
    <div className="space-y-3">
      {visible.map((job) => (
        <MediaJobItem
          key={job.id}
          job={job}
          showEntity={showEntity}
          onRetry={onRetry}
          onDeleteAsset={onDeleteAsset}
          sendCommand={sendCommand}
        />
      ))}
    </div>
  );
});

interface MediaJobItemProps {
  job: MediaJob;
  showEntity: boolean;
  onRetry?: (job: MediaJob) => Promise<void> | void;
  onDeleteAsset?: (job: MediaJob) => Promise<void> | void;
  sendCommand?: (command: string) => void;
}

const MediaJobItem = memo(function MediaJobItem({
  job,
  showEntity,
  onRetry,
  onDeleteAsset,
  sendCommand,
}: MediaJobItemProps) {
  const { open: openAsset } = useAssetViewer();
  const status = STATUS_STYLE[job.status];
  const metadata = job.metadata as Record<string, unknown> | null;
  const progressValue = metadata?.progress;
  const progress = typeof progressValue === "number" ? `${Math.round(progressValue * 100)}%` : null;
  const updated = formatRelativeTime(job.updatedAt);

  return (
    <div className="flex flex-col gap-2 border-b border-border/40 pb-3 last:border-none">
      <div className="flex items-center justify-between gap-2 text-[10px] uppercase">
        <span
          style={{
            color: status.color,
            background: status.background,
            border: `1px solid ${status.color}`,
            borderRadius: "2px",
            padding: "2px 4px",
            fontFamily: "'Press Start 2P', monospace",
          }}
        >
          {status.label}
        </span>
        <span className="text-text-dim">{updated}</span>
      </div>
      <div className="text-[12px] text-text-bright">
        {job.type.toUpperCase()} · {job.model} · {job.provider}
        {progress ? ` · ${progress}` : ""}
      </div>
      {showEntity && (
        <div className="text-[11px] text-text-dim">
          Requested by <span className="text-text">{job.entityName}</span>
        </div>
      )}
      <div className="text-[12px] text-text-dim leading-snug">
        {job.prompt.length > 200 ? `${job.prompt.slice(0, 200)}…` : job.prompt}
      </div>
      <div className="flex flex-wrap gap-3 text-[11px] text-text-dim">
        {job.costEstimate ? <span>~${job.costEstimate.toFixed(3)}</span> : null}
        {job.error && <span className="text-danger">{job.error}</span>}
      </div>
      <div className="flex flex-wrap gap-2">
        {(job.status === "failed" || job.status === "blocked") && (
          <button
            type="button"
            className="rounded border border-border/70 bg-bg px-2 py-0.5 text-[10px] text-text transition-colors hover:border-primary hover:text-primary"
            onClick={() => void onRetry?.(job)}
          >
            Retry
          </button>
        )}
        {job.assetUrl && (
          <button
            type="button"
            className="rounded border border-border/70 bg-bg px-2 py-0.5 text-[10px] text-text transition-colors hover:border-primary hover:text-primary"
            onClick={() =>
              openAsset({
                url: job.assetUrl ?? "",
                kind: job.type,
                title: `${job.type} · ${job.model}`,
                prompt: job.prompt,
                model: job.model,
              })
            }
          >
            Open
          </button>
        )}
        {job.assetId && onDeleteAsset && (
          <button
            type="button"
            className="rounded border border-border/70 bg-bg px-2 py-0.5 text-[10px] text-text transition-colors hover:border-danger hover:text-danger"
            onClick={() => void onDeleteAsset(job)}
          >
            Delete Asset
          </button>
        )}
        {sendCommand &&
          (() => {
            const command = buildMediaRetryCommand(job);
            if (!command) return null;
            return (
              <button
                type="button"
                className="rounded border border-border/70 bg-bg px-2 py-0.5 text-[10px] text-text transition-colors hover:border-primary hover:text-primary"
                onClick={() => sendCommand(command)}
              >
                Command
              </button>
            );
          })()}
      </div>
    </div>
  );
});

export function buildMediaRetryCommand(job: MediaJob): string | null {
  const options = job.options ?? {};
  const prefix = job.type === "image" ? "image generate" : "video generate";
  let command = `${prefix} ${job.prompt}`;
  if (job.model) command += ` --model ${job.model}`;
  if (job.type === "image") {
    if (typeof options.width === "number") command += ` --width ${options.width}`;
    if (typeof options.height === "number") command += ` --height ${options.height}`;
    if (typeof options.style === "string" && options.style) command += ` --style ${options.style}`;
  } else {
    if (typeof options.duration === "number") command += ` --duration ${options.duration}`;
    if (typeof options.fps === "number") command += ` --fps ${options.fps}`;
    if (typeof options.referenceImage === "string" && options.referenceImage)
      command += ` --reference ${options.referenceImage}`;
    if (typeof options.aspectRatio === "string" && options.aspectRatio)
      command += ` --aspect ${options.aspectRatio}`;
  }
  if (typeof options.canvasId === "string" && options.canvasId) {
    command += ` --canvas ${options.canvasId}`;
  }
  return command;
}

function formatRelativeTime(epochMs: number): string {
  const delta = Date.now() - epochMs;
  if (!Number.isFinite(delta)) return "";
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const minutes = Math.round(delta / 60_000);
  if (Math.abs(minutes) < 1) {
    const seconds = Math.max(Math.round(delta / 1_000), -1);
    return format.format(-seconds, "second");
  }
  if (Math.abs(minutes) < 60) {
    return format.format(-minutes, "minute");
  }
  const hours = Math.round(minutes / 60);
  return format.format(-hours, "hour");
}
