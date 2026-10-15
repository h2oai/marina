// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Upload UI shared by every surface: a file-picker button, a paste / drop
 * zone wrapper, and the per-file tray (progress, errors, cancel, and
 * "already in your library" for a deduplicated upload). The queue itself is
 * `useUploads` (hooks/use-uploads.ts).
 */

import { CheckCircle2, CircleAlert, Copy, Paperclip, Upload, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useRef, useState } from "react";
import type { UploadEntry } from "../../hooks/use-uploads";
import { formatBytes } from "../../lib/asset-library";
import { filesFromClipboard } from "../../lib/upload";

export function UploadButton({
  onFiles,
  label = "Upload",
  iconOnly,
  icon = "upload",
  accept,
  className,
  disabled,
}: {
  onFiles: (files: File[]) => void;
  label?: string;
  iconOnly?: boolean;
  icon?: "upload" | "attach";
  accept?: string;
  className?: string;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const Icon = icon === "attach" ? Paperclip : Upload;
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => input.current?.click()}
        aria-label={iconOnly ? label : undefined}
        title={iconOnly ? label : undefined}
        className={
          className ??
          "flex items-center gap-1 rounded border border-primary/50 bg-primary/10 px-2 py-1 text-[11px] text-primary hover:bg-primary/20 disabled:opacity-40"
        }
      >
        <Icon size={12} aria-hidden="true" />
        {!iconOnly && <span>{label}</span>}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={accept}
        data-testid="upload-input"
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? []);
          e.currentTarget.value = "";
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}

/**
 * Wraps a region so files can be dropped onto it or pasted into it
 * (Cmd/Ctrl+V while focus is inside). Text pastes pass through untouched.
 */
export function UploadDropZone({
  onFiles,
  children,
  className,
  label = "Drop files to upload",
}: {
  onFiles: (files: File[]) => void;
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  const [over, setOver] = useState(false);
  const hasFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes("Files");
  return (
    // A labelled region: drop and paste targets; the upload button is the keyboard path.
    <section
      aria-label="Upload area"
      className={`relative ${className ?? ""}`}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setOver(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setOver(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length) onFiles(files);
      }}
      onPaste={(e) => {
        const files = filesFromClipboard(e.clipboardData);
        if (files.length === 0) return;
        e.preventDefault();
        onFiles(files);
      }}
    >
      {children}
      {over && (
        <div className="pointer-events-none absolute inset-1 z-30 flex items-center justify-center rounded-lg border-2 border-dashed border-primary/60 bg-primary/10 text-[13px] font-medium text-primary">
          {label}
        </div>
      )}
    </section>
  );
}

const STATUS_TEXT: Record<UploadEntry["status"], string> = {
  queued: "Waiting",
  uploading: "Uploading",
  done: "Uploaded",
  duplicate: "Already in your library",
  error: "Failed",
  cancelled: "Cancelled",
};

export function UploadTray({
  entries,
  onCancel,
  onDismiss,
  onClearFinished,
  className,
}: {
  entries: readonly UploadEntry[];
  onCancel: (id: string) => void;
  onDismiss: (id: string) => void;
  onClearFinished?: () => void;
  className?: string;
}) {
  const reduce = useReducedMotion();
  if (entries.length === 0) return null;
  const finished = entries.filter((e) => e.status !== "queued" && e.status !== "uploading");
  return (
    <section
      aria-label="Uploads"
      className={
        className ?? "rounded border border-border bg-bg-card p-2 text-[11px] text-text shadow-lg"
      }
    >
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-[10px] uppercase tracking-wider text-text-dim">
          Uploads ({entries.length})
        </h3>
        {onClearFinished && finished.length > 0 && (
          <button
            type="button"
            className="text-[10px] text-text-dim hover:text-primary"
            onClick={onClearFinished}
          >
            Clear finished
          </button>
        )}
      </div>
      <ul className="max-h-48 space-y-1 overflow-auto">
        <AnimatePresence initial={false}>
          {entries.map((e) => {
            const live = e.status === "queued" || e.status === "uploading";
            return (
              <motion.li
                key={e.id}
                layout={!reduce}
                initial={reduce ? false : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
                className="rounded bg-bg px-2 py-1"
              >
                <div className="flex items-center gap-1.5">
                  {e.status === "done" && (
                    <CheckCircle2 size={12} className="shrink-0 text-success" aria-hidden="true" />
                  )}
                  {e.status === "duplicate" && (
                    <Copy size={12} className="shrink-0 text-primary" aria-hidden="true" />
                  )}
                  {e.status === "error" && (
                    <CircleAlert size={12} className="shrink-0 text-danger" aria-hidden="true" />
                  )}
                  <span className="min-w-0 flex-1 truncate" title={e.name}>
                    {e.name}
                  </span>
                  <span className="shrink-0 text-text-dim">{formatBytes(e.size)}</span>
                  <button
                    type="button"
                    className="shrink-0 rounded p-0.5 text-text-dim hover:text-danger"
                    aria-label={live ? `Cancel upload of ${e.name}` : `Dismiss ${e.name}`}
                    onClick={() => (live ? onCancel(e.id) : onDismiss(e.id))}
                  >
                    <X size={11} aria-hidden="true" />
                  </button>
                </div>
                {live && (
                  <div
                    role="progressbar"
                    aria-label={`Uploading ${e.name}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(e.progress * 100)}
                    className="mt-1 h-1 overflow-hidden rounded bg-bg-hover"
                  >
                    <div
                      className="h-full bg-primary motion-safe:transition-[width]"
                      style={{ width: `${Math.max(2, e.progress * 100)}%` }}
                    />
                  </div>
                )}
                <p
                  className={`mt-0.5 ${e.status === "error" ? "text-danger" : "text-text-dim"}`}
                  role={e.status === "error" ? "alert" : undefined}
                >
                  {e.status === "error" && e.error ? e.error : STATUS_TEXT[e.status]}
                  {e.status !== "error" && e.error ? ` — ${e.error}` : ""}
                </p>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
    </section>
  );
}
