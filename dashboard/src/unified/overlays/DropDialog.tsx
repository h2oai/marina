// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * DropDialog -- Modal that opens after a drag-and-drop file upload, prompting
 * the user for an intent (what should an agent do with this?) and an
 * optional quick action.
 *
 * The dialog walks through one dropped file at a time. Each step lets the
 * user accept the MIME-suggested intent, type a custom one, or skip and
 * leave the node intent-less. On accept, the node is patched with
 * `data.intent = { prompt, status: "pending" }` — agents discover it via
 * `canvas intent list` / brief and claim it like any other intent.
 */

import { motion } from "motion/react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { authFetch } from "../../lib/api";
import type { DroppedFileResult } from "../hooks/use-canvas-integration";

const API_BASE = window.location.origin;

/** MIME-prefix-keyed default intent suggestions. Order matters: specific first. */
const MIME_INTENT_SUGGESTIONS: [string, string][] = [
  ["application/pdf", "Summarize the key points of this document"],
  ["application/json", "Analyze the structure and key data in this JSON"],
  ["text/csv", "Parse this data and describe the key findings"],
  ["text/markdown", "Read this and extract the main themes"],
  ["text/", "Read this file and summarize its contents"],
  ["image/", "Describe what you see in this image"],
  ["video/", "Describe the content of this video"],
  ["audio/", "Transcribe and summarize this audio"],
];

/** Quick-action chips offered alongside the intent textarea. */
const QUICK_ACTIONS: { label: string; prompt: string }[] = [
  { label: "Summarize", prompt: "Summarize the key points and takeaways" },
  { label: "Analyze", prompt: "Analyze the structure and content; flag anything noteworthy" },
  { label: "Extract data", prompt: "Extract structured data and present it as a table" },
  { label: "Critique", prompt: "Provide constructive feedback and suggest improvements" },
  { label: "Translate", prompt: "Translate to English; preserve meaning over literal wording" },
];

function suggestIntentForMime(mime: string): string {
  for (const [prefix, prompt] of MIME_INTENT_SUGGESTIONS) {
    if (mime.startsWith(prefix)) return prompt;
  }
  return "Inspect this file and report what you find";
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function shortMime(mime: string): string {
  if (!mime) return "unknown";
  if (mime === "application/octet-stream") return "binary";
  return mime;
}

export interface DropDialogProps {
  /** Files queued for prompting. The dialog walks them one at a time. */
  files: DroppedFileResult[];
  /** Called when the user finishes (or skips) every queued file. */
  onClose: () => void;
}

export const DropDialog = memo(function DropDialog({ files, onClose }: DropDialogProps) {
  const [index, setIndex] = useState(0);
  const current = files[index];
  const initialPrompt = useMemo(
    () => (current ? suggestIntentForMime(current.mime) : ""),
    [current],
  );
  const [prompt, setPrompt] = useState(initialPrompt);
  const [submitting, setSubmitting] = useState(false);

  // Reset prompt when the queue advances to the next file
  useEffect(() => {
    setPrompt(initialPrompt);
  }, [initialPrompt]);

  const advance = useCallback(() => {
    if (index + 1 < files.length) {
      setIndex(index + 1);
    } else {
      onClose();
    }
  }, [index, files.length, onClose]);

  const setIntent = useCallback(
    async (intentPrompt: string) => {
      if (!current) return;
      setSubmitting(true);
      try {
        // Fetch current node data first so we don't clobber other fields.
        const fetchRes = await authFetch(
          `${API_BASE}/api/canvases/${current.canvasId}/nodes/${current.nodeId}`,
        );
        const node = fetchRes.ok ? await fetchRes.json() : { data: {} };
        const existingData =
          typeof node.data === "string" ? JSON.parse(node.data) : (node.data ?? {});
        await authFetch(`${API_BASE}/api/canvases/${current.canvasId}/nodes/${current.nodeId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            data: {
              ...existingData,
              intent: { prompt: intentPrompt, status: "pending" },
            },
          }),
        });
      } finally {
        setSubmitting(false);
        advance();
      }
    },
    [current, advance],
  );

  // Keyboard: Esc to skip, Cmd/Ctrl+Enter to submit
  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        advance();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && prompt.trim()) {
        e.preventDefault();
        setIntent(prompt.trim());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, prompt, advance, setIntent]);

  if (!current) return null;

  const isImage = current.mime.startsWith("image/");

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.7)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        backdropFilter: "blur(2px)",
      }}
      onClick={(e) => {
        // Click outside the dialog skips this file (escape hatch).
        if (e.target === e.currentTarget) advance();
      }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.94, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ type: "spring", stiffness: 320, damping: 30 }}
        style={{
          width: "min(560px, 92vw)",
          maxHeight: "90vh",
          overflow: "auto",
          background: "rgba(10, 10, 16, 0.98)",
          border: "1px solid var(--color-border)",
          borderRadius: 4,
          color: "var(--color-text)",
          fontFamily: "'VT323', monospace",
          padding: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "12px 16px",
            borderBottom: "1px solid var(--color-border)",
            background: "rgba(255, 255, 255, 0.03)",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
            <div
              style={{
                fontFamily: "'Press Start 2P', monospace",
                fontSize: "clamp(8px, 0.75vw, 11px)",
                color: "var(--color-primary)",
                letterSpacing: "1px",
              }}
            >
              FILE DROPPED · WHAT NEXT?
            </div>
            <div
              style={{
                fontSize: "clamp(14px, 1vw, 18px)",
                color: "var(--color-text)",
                marginTop: 4,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={current.filename}
            >
              {current.filename}
            </div>
            <div
              style={{
                fontSize: "12px",
                color: "var(--color-text-dim)",
                marginTop: 2,
              }}
            >
              {shortMime(current.mime)} · {humanSize(current.size)}
              {files.length > 1 && (
                <span style={{ marginLeft: 8, color: "var(--color-accent)" }}>
                  · {index + 1} of {files.length}
                </span>
              )}
            </div>
          </div>
          {isImage && (
            <img
              src={`${API_BASE}/api/canvases/${current.canvasId}/nodes/${current.nodeId}/preview`}
              alt={current.filename}
              style={{
                width: 64,
                height: 64,
                objectFit: "cover",
                borderRadius: 2,
                border: "1px solid var(--color-border)",
                flexShrink: 0,
              }}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          )}
        </div>

        {/* Body */}
        <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Quick actions */}
          <div>
            <div
              style={{
                fontFamily: "'Press Start 2P', monospace",
                fontSize: "clamp(7px, 0.65vw, 9px)",
                color: "var(--color-text-dim)",
                marginBottom: 8,
                letterSpacing: "1px",
              }}
            >
              QUICK ACTIONS
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {QUICK_ACTIONS.map((qa) => (
                <button
                  key={qa.label}
                  type="button"
                  onClick={() => setPrompt(qa.prompt)}
                  disabled={submitting}
                  style={{
                    padding: "4px 10px",
                    background:
                      prompt === qa.prompt
                        ? "color-mix(in srgb, var(--color-primary) 22%, transparent)"
                        : "rgba(255,255,255,0.04)",
                    border:
                      prompt === qa.prompt
                        ? "1px solid var(--color-primary)"
                        : "1px solid var(--color-border)",
                    color: prompt === qa.prompt ? "var(--color-primary)" : "var(--color-text-dim)",
                    fontFamily: "'VT323', monospace",
                    fontSize: 14,
                    cursor: submitting ? "wait" : "pointer",
                    borderRadius: 2,
                  }}
                >
                  {qa.label}
                </button>
              ))}
            </div>
          </div>

          {/* Intent textarea */}
          <div>
            <label
              htmlFor="drop-dialog-intent"
              style={{
                display: "block",
                fontFamily: "'Press Start 2P', monospace",
                fontSize: "clamp(7px, 0.65vw, 9px)",
                color: "var(--color-text-dim)",
                marginBottom: 6,
                letterSpacing: "1px",
              }}
            >
              INTENT FOR AGENTS
            </label>
            <textarea
              id="drop-dialog-intent"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What should an agent do with this?"
              rows={3}
              disabled={submitting}
              style={{
                width: "100%",
                background: "rgba(0,0,0,0.4)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text)",
                fontFamily: "'VT323', monospace",
                fontSize: 16,
                padding: "8px 10px",
                resize: "vertical",
                outline: "none",
                borderRadius: 2,
              }}
            />
            <div
              style={{
                fontSize: 11,
                color: "var(--color-text-dim)",
                marginTop: 4,
              }}
            >
              The intent is queued as <code>pending</code>; the next available agent claims and
              fulfills it. Cmd/Ctrl-Enter to submit, Esc to skip.
            </div>
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "12px 16px",
            borderTop: "1px solid var(--color-border)",
            background: "rgba(255, 255, 255, 0.02)",
          }}
        >
          <button
            type="button"
            onClick={advance}
            disabled={submitting}
            style={{
              padding: "5px 14px",
              background: "transparent",
              border: "1px solid var(--color-border)",
              color: "var(--color-text-dim)",
              fontFamily: "'VT323', monospace",
              fontSize: 14,
              cursor: submitting ? "wait" : "pointer",
              borderRadius: 2,
            }}
          >
            Skip — leave it on canvas
          </button>
          <button
            type="button"
            onClick={() => setIntent(prompt.trim())}
            disabled={submitting || !prompt.trim()}
            style={{
              padding: "5px 14px",
              background: "color-mix(in srgb, var(--color-primary) 18%, transparent)",
              border: "1px solid var(--color-primary)",
              color: "var(--color-primary)",
              fontFamily: "'Press Start 2P', monospace",
              fontSize: "clamp(8px, 0.7vw, 10px)",
              letterSpacing: "1px",
              cursor: submitting || !prompt.trim() ? "not-allowed" : "pointer",
              opacity: submitting || !prompt.trim() ? 0.5 : 1,
              borderRadius: 2,
            }}
          >
            {submitting ? "SETTING…" : "SET INTENT"}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
});
