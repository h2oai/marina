// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Node } from "@xyflow/react";
import { CheckCircle2, Hand, XCircle } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { authFetch } from "../../lib/api";
import { resolveAuthor, resolveTitle } from "../lib/node-fields";

const API_BASE = window.location.origin;

function formatTimestamp(ts: unknown): string {
  if (!ts) return "—";
  const d = new Date(typeof ts === "number" ? ts : Number(ts));
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Keys to skip in the "all fields" dump (shown elsewhere or not useful). */
const SKIP_KEYS = new Set([
  "canvas_id",
  "components",
  "rootId",
  "dataModel",
  "lastAction",
  "intent",
]);

interface IntentData {
  prompt: string;
  status: "pending" | "active" | "done" | "failed";
  claimedBy?: string;
  claimedAt?: number;
  result?: string;
  resultNodeId?: string;
  failReason?: string;
}

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  pending: { bg: "bg-amber-900/40", text: "text-amber-400", label: "Pending" },
  active: { bg: "bg-blue-900/40", text: "text-blue-400", label: "Active" },
  done: { bg: "bg-green-900/40", text: "text-green-400", label: "Done" },
  failed: { bg: "bg-red-900/40", text: "text-red-400", label: "Failed" },
};

interface Props {
  node: Node | null;
  onClose: () => void;
  canvasId: string | null;
  onSetIntent: (nodeId: string, data: Record<string, unknown>) => Promise<void>;
  onIntentActionResult?: (nodeId: string, data: Record<string, unknown>) => void;
  nodes: Node[];
  suggestedPrompt?: string;
}

export function NodeDetailPanel(props: Props) {
  return (
    <AnimatePresence>
      {props.node && <NodeDetailPanelInner {...props} node={props.node} />}
    </AnimatePresence>
  );
}

function NodeDetailPanelInner({
  node,
  onClose,
  canvasId,
  onSetIntent,
  onIntentActionResult,
  nodes,
  suggestedPrompt,
}: Props & { node: Node }) {
  const [promptText, setPromptText] = useState("");
  const [editText, setEditText] = useState("");
  const [chatText, setChatText] = useState("");
  const [completeText, setCompleteText] = useState("");
  const [failReason, setFailReason] = useState("");
  const [intentError, setIntentError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Pre-fill prompt from drop suggestion
  // biome-ignore lint/correctness/useExhaustiveDependencies: only refire on a new suggestion, not on every keystroke
  useEffect(() => {
    if (suggestedPrompt && !promptText) {
      setPromptText(suggestedPrompt);
    }
  }, [suggestedPrompt]);

  const d = node.data as Record<string, unknown>;
  const intent = d.intent as IntentData | undefined;

  const handleSubmitIntent = useCallback(async () => {
    if (!node || !promptText.trim() || !canvasId) return;
    setSubmitting(true);
    try {
      await onSetIntent(node.id, {
        ...d,
        intent: { prompt: promptText.trim(), status: "pending" },
      });
      setPromptText("");
    } finally {
      setSubmitting(false);
    }
  }, [node, promptText, canvasId, d, onSetIntent]);

  const handleUpdateIntent = useCallback(async () => {
    if (!node || !intent || !editText.trim() || !canvasId) return;
    if (editText.trim() === intent.prompt) return;
    setSubmitting(true);
    try {
      await onSetIntent(node.id, {
        ...d,
        intent: { ...intent, prompt: editText.trim() },
      });
    } finally {
      setSubmitting(false);
    }
  }, [node, intent, editText, canvasId, d, onSetIntent]);

  const handleClearIntent = useCallback(async () => {
    if (!node || !canvasId) return;
    setSubmitting(true);
    try {
      const cleaned = { ...d };
      cleaned.intent = undefined;
      await onSetIntent(node.id, cleaned);
    } finally {
      setSubmitting(false);
    }
  }, [node, canvasId, d, onSetIntent]);

  const handleIntentAction = useCallback(
    async (action: "claim" | "complete" | "fail") => {
      if (!node || !canvasId) return;
      setSubmitting(true);
      setIntentError(null);
      try {
        const body =
          action === "complete"
            ? { result: completeText.trim() }
            : action === "fail"
              ? { reason: failReason.trim() || "Unable to complete from dashboard" }
              : {};
        const res = await authFetch(
          `${API_BASE}/api/canvases/${encodeURIComponent(canvasId)}/nodes/${encodeURIComponent(
            node.id,
          )}/intent/${action}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        const payload = (await res.json().catch(() => ({}))) as {
          error?: string;
          node?: { data?: Record<string, unknown> };
        };
        if (!res.ok) throw new Error(payload.error ?? `Intent ${action} failed`);
        if (payload.node?.data) onIntentActionResult?.(node.id, payload.node.data);
        if (action === "complete") setCompleteText("");
        if (action === "fail") setFailReason("");
      } catch (err) {
        setIntentError(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmitting(false);
      }
    },
    [node, canvasId, completeText, failReason, onIntentActionResult],
  );

  const handleSendMessage = useCallback(async () => {
    if (!node || !chatText.trim() || !canvasId) return;
    setSubmitting(true);
    try {
      await authFetch(`${API_BASE}/api/canvases/${canvasId}/nodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "text",
          parent_node_id: node.id,
          creator_name: "user",
          data: {
            body: chatText.trim(),
            author: "user",
            feedType: "conversation",
          },
        }),
      });
      setChatText("");
    } finally {
      setSubmitting(false);
    }
  }, [node, chatText, canvasId]);

  const creator = resolveAuthor(d) || "unknown";
  const filename = resolveTitle(d) || "—";
  const createdAt = formatTimestamp(d.created_at);
  const updatedAt = formatTimestamp(d.updated_at);
  const assetId = (d.asset_id as string) ?? null;

  // Collect all non-skipped, non-null data fields for the detail view
  const fields = Object.entries(d).filter(([k, v]) => !SKIP_KEYS.has(k) && v != null && v !== "");

  const statusStyle = intent ? STATUS_STYLES[intent.status] : undefined;

  return (
    <motion.aside
      key="node-detail"
      initial={{ x: "100%", opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: "100%", opacity: 0 }}
      transition={{ type: "spring", stiffness: 320, damping: 32 }}
      className="fixed right-0 top-0 bottom-0 w-96 bg-bg-card border-l border-border shadow-2xl z-50 flex flex-col overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-bg-hover border-b border-border">
        <h2 className="text-sm font-bold text-primary truncate">Node Detail</h2>
        <motion.button
          type="button"
          onClick={onClose}
          whileHover={{ scale: 1.15, color: "rgb(229 231 235)" }}
          whileTap={{ scale: 0.92 }}
          className="text-text text-lg leading-none px-1"
        >
          &times;
        </motion.button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 text-sm">
        {/* Identity */}
        <section>
          <h3 className="text-[10px] uppercase tracking-widest text-text-dim mb-1">Identity</h3>
          <Row label="Name" value={filename} />
          <Row label="Type" value={node.type ?? "—"} />
          <Row label="ID" value={node.id} mono />
        </section>

        {/* Creator & Timestamps */}
        <section>
          <h3 className="text-[10px] uppercase tracking-widest text-text-dim mb-1">Provenance</h3>
          <Row label="Creator" value={creator} />
          <Row label="Created" value={createdAt} />
          <Row label="Updated" value={updatedAt} />
          {assetId && <Row label="Asset ID" value={assetId} mono />}
        </section>

        {/* Position & Size */}
        <section>
          <h3 className="text-[10px] uppercase tracking-widest text-text-dim mb-1">Layout</h3>
          <Row
            label="Position"
            value={`${Math.round(node.position.x)}, ${Math.round(node.position.y)}`}
          />
          {node.style?.width && (
            <Row label="Size" value={`${node.style.width} × ${node.style.height}`} />
          )}
        </section>

        {/* ── Intent Section ─────────────────────────────────────────── */}
        <section>
          <h3 className="text-[10px] uppercase tracking-widest text-text-dim mb-1">Intent</h3>

          {intent && statusStyle ? (
            <div className="space-y-2">
              {/* Status badge */}
              <div className={`rounded px-2 py-1.5 ${statusStyle.bg} flex items-center gap-2`}>
                <span
                  className={`inline-block w-2 h-2 rounded-full ${
                    intent.status === "pending"
                      ? "bg-amber-400 animate-pulse"
                      : intent.status === "active"
                        ? "bg-blue-400 animate-pulse"
                        : intent.status === "done"
                          ? "bg-green-400"
                          : "bg-red-400"
                  }`}
                />
                <span className={`text-xs font-medium ${statusStyle.text}`}>
                  {statusStyle.label}
                </span>
                {intent.claimedBy && (
                  <span className="text-xs text-text-dim ml-auto">by {intent.claimedBy}</span>
                )}
              </div>

              {/* Prompt — editable when pending */}
              {intent.status === "pending" ? (
                <div className="space-y-1.5">
                  <div className="text-[10px] uppercase text-text-dim">Prompt</div>
                  <textarea
                    value={editText || intent.prompt}
                    onChange={(e) => setEditText(e.target.value)}
                    onFocus={() => {
                      if (!editText) setEditText(intent.prompt);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleUpdateIntent();
                    }}
                    className="w-full bg-bg-hover border border-border rounded px-2 py-1.5 text-xs text-text-bright focus:outline-none focus:border-primary resize-none"
                    rows={3}
                  />
                  <button
                    type="button"
                    onClick={handleUpdateIntent}
                    disabled={submitting || !editText.trim() || editText.trim() === intent.prompt}
                    className="w-full bg-primary/20 hover:bg-primary/30 disabled:opacity-40 disabled:cursor-not-allowed text-primary text-xs font-medium rounded px-3 py-1.5 transition-colors"
                  >
                    {submitting ? "Updating..." : "Update Intent"}
                  </button>
                </div>
              ) : (
                <div className="rounded bg-bg-hover px-2 py-1.5">
                  <div className="text-[10px] uppercase text-text-dim mb-0.5">Prompt</div>
                  <div className="text-text text-xs whitespace-pre-wrap">{intent.prompt}</div>
                </div>
              )}

              {intent.status === "pending" && (
                <button
                  type="button"
                  onClick={() => handleIntentAction("claim")}
                  disabled={submitting}
                  className="flex w-full items-center justify-center gap-1.5 rounded bg-blue-900/30 px-3 py-1.5 text-xs font-medium text-blue-300 transition-colors hover:bg-blue-900/45 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Hand size={13} />
                  {submitting ? "Claiming..." : "Claim Intent"}
                </button>
              )}

              {intent.status === "active" && (
                <div className="space-y-2 rounded border border-border bg-bg/60 p-2">
                  <div>
                    <div className="mb-1 text-[10px] uppercase text-text-dim">Result</div>
                    <textarea
                      value={completeText}
                      onChange={(e) => setCompleteText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          handleIntentAction("complete");
                        }
                      }}
                      placeholder="Deliver the result for this intent..."
                      className="w-full resize-none rounded border border-border bg-bg-hover px-2 py-1.5 text-xs text-text-bright placeholder-text-dim focus:border-primary focus:outline-none"
                      rows={3}
                    />
                    <button
                      type="button"
                      onClick={() => handleIntentAction("complete")}
                      disabled={submitting || !completeText.trim()}
                      className="mt-1 flex w-full items-center justify-center gap-1.5 rounded bg-green-900/25 px-3 py-1.5 text-xs font-medium text-green-300 transition-colors hover:bg-green-900/40 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <CheckCircle2 size={13} />
                      {submitting ? "Completing..." : "Complete Intent"}
                    </button>
                  </div>

                  <div>
                    <div className="mb-1 text-[10px] uppercase text-text-dim">Failure reason</div>
                    <textarea
                      value={failReason}
                      onChange={(e) => setFailReason(e.target.value)}
                      placeholder="Why can this intent not be completed?"
                      className="w-full resize-none rounded border border-border bg-bg-hover px-2 py-1.5 text-xs text-text-bright placeholder-text-dim focus:border-red-500 focus:outline-none"
                      rows={2}
                    />
                    <button
                      type="button"
                      onClick={() => handleIntentAction("fail")}
                      disabled={submitting}
                      className="mt-1 flex w-full items-center justify-center gap-1.5 rounded bg-red-900/20 px-3 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-900/35 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <XCircle size={13} />
                      {submitting ? "Updating..." : "Fail Intent"}
                    </button>
                  </div>
                </div>
              )}

              {intentError && (
                <div className="rounded bg-red-900/20 px-2 py-1.5 text-xs text-red-300">
                  {intentError}
                </div>
              )}

              {/* Result */}
              {intent.result && (
                <div className="rounded bg-bg-hover px-2 py-1.5">
                  <div className="text-[10px] uppercase text-text-dim mb-0.5">Result</div>
                  <div className="text-text text-xs whitespace-pre-wrap max-h-48 overflow-auto">
                    {intent.result}
                  </div>
                </div>
              )}

              {/* Fail reason */}
              {intent.failReason && (
                <div className="rounded bg-red-900/20 px-2 py-1.5">
                  <div className="text-[10px] uppercase text-red-400/70 mb-0.5">Reason</div>
                  <div className="text-red-300 text-xs whitespace-pre-wrap">
                    {intent.failReason}
                  </div>
                </div>
              )}

              {/* Clear intent button */}
              <button
                type="button"
                onClick={handleClearIntent}
                disabled={submitting}
                className="text-xs text-text-dim hover:text-text-bright transition-colors"
              >
                Clear intent
              </button>
            </div>
          ) : (
            /* No intent — show prompt input */
            <div className="space-y-2">
              <textarea
                value={promptText}
                onChange={(e) => setPromptText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    handleSubmitIntent();
                  }
                }}
                placeholder="What should an agent do with this? e.g. 'Summarize this document' or 'Extract key data points'"
                className="w-full bg-bg-hover border border-border rounded px-2 py-1.5 text-xs text-text-bright placeholder-text-dim focus:outline-none focus:border-primary resize-none"
                rows={3}
              />
              <button
                type="button"
                onClick={handleSubmitIntent}
                disabled={!promptText.trim() || submitting}
                className="w-full bg-primary/20 hover:bg-primary/30 disabled:opacity-40 disabled:cursor-not-allowed text-primary text-xs font-medium rounded px-3 py-1.5 transition-colors"
              >
                {submitting ? "Setting intent..." : "Set Intent"}
              </button>
              <p className="text-[10px] text-text-dim">
                Ctrl+Enter to submit. An available agent will pick this up and deliver results.
              </p>
            </div>
          )}
        </section>

        {/* ── Conversation Thread ──────────────────────────────────── */}
        <section>
          <h3 className="text-[10px] uppercase tracking-widest text-text-dim mb-1">Conversation</h3>
          {(() => {
            const children = nodes
              .filter((n) => n.data.parent_node_id === node.id)
              .sort(
                (a, b) =>
                  ((a.data.created_at as number) ?? 0) - ((b.data.created_at as number) ?? 0),
              );
            return children.length > 0 ? (
              <div className="space-y-1.5 max-h-48 overflow-auto mb-2">
                {children.map((child) => {
                  const cd = child.data as Record<string, unknown>;
                  const author = resolveAuthor(cd) || "?";
                  const body = (cd.body as string) ?? (cd.content as string) ?? "";
                  const time = formatTimestamp(cd.created_at);
                  return (
                    <div key={child.id} className="rounded bg-bg-hover px-2 py-1 text-xs">
                      <div className="flex items-baseline justify-between gap-1 mb-0.5">
                        <span className="font-medium text-text">{author}</span>
                        <span className="text-[9px] text-text-dim">{time}</span>
                      </div>
                      <div className="text-text whitespace-pre-wrap">{body}</div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-[10px] text-text-dim mb-2">No messages yet.</p>
            );
          })()}
          <div className="flex gap-1.5">
            <textarea
              value={chatText}
              onChange={(e) => setChatText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSendMessage();
              }}
              placeholder="Say something about this node..."
              className="flex-1 bg-bg-hover border border-border rounded px-2 py-1 text-xs text-text-bright placeholder-text-dim focus:outline-none focus:border-violet-600 resize-none"
              rows={2}
            />
            <button
              type="button"
              onClick={handleSendMessage}
              disabled={!chatText.trim() || submitting}
              className="self-end bg-violet-900/50 hover:bg-violet-800/50 disabled:opacity-40 disabled:cursor-not-allowed text-violet-300 text-xs font-medium rounded px-2 py-1 transition-colors"
            >
              Send
            </button>
          </div>
          <p className="text-[10px] text-text-dim mt-1">
            Ctrl+Enter to send. Messages appear as child nodes with edges.
          </p>
        </section>

        {/* All data fields */}
        <section>
          <h3 className="text-[10px] uppercase tracking-widest text-text-dim mb-1">Data</h3>
          {fields.length === 0 && <span className="text-text-dim italic text-xs">No data</span>}
          {fields.map(([k, v]) => (
            <Row
              key={k}
              label={k}
              value={typeof v === "object" ? JSON.stringify(v, null, 2) : String(v)}
              pre={typeof v === "object"}
            />
          ))}
        </section>
      </div>
    </motion.aside>
  );
}

function Row({
  label,
  value,
  mono,
  pre,
}: {
  label: string;
  value: string;
  mono?: boolean;
  pre?: boolean;
}) {
  return (
    <div className="flex gap-2 py-0.5">
      <span className="text-text-dim shrink-0 w-20 text-right text-xs">{label}</span>
      {pre ? (
        <pre className="text-text text-xs whitespace-pre-wrap break-all font-mono flex-1 max-h-40 overflow-auto">
          {value}
        </pre>
      ) : (
        <span className={`text-text break-all flex-1 ${mono ? "font-mono text-[11px]" : ""}`}>
          {value}
        </span>
      )}
    </div>
  );
}
