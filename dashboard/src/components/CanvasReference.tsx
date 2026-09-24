// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { Pin } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { fetchCanvases } from "../canvas/hooks/use-canvas";
import { useChatState } from "../hooks/use-chat-state";
import { type CanvasReference, openCanvas, useWorkspaceState } from "../hooks/use-workspace-state";
import { fetchApi, getToken, postApi } from "../lib/api";

export function parseCanvasReference(value: unknown): CanvasReference | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id || r.id.length > 200) return null;
  if ((r.kind === "task" || r.kind === "note") && /^\d+$/.test(r.id))
    return { kind: r.kind, id: r.id };
  if (r.kind === "artifact" && typeof r.sessionId === "string" && r.sessionId.length <= 200)
    return { kind: r.kind, id: r.id, sessionId: r.sessionId };
  return null;
}

interface SourceRecord {
  title?: string;
  content?: string;
  content_text?: string;
  status?: string;
  note_type?: string;
  description?: string;
}
export async function resolveCanvasReference(reference: CanvasReference): Promise<SourceRecord> {
  if (reference.kind === "artifact") {
    const result = await fetchApi<{ artifacts: Array<SourceRecord & { id: string }> }>(
      `/api/coding/session/${encodeURIComponent(reference.sessionId)}`,
    );
    const artifact = result.artifacts.find((a) => a.id === reference.id);
    if (!artifact) throw new Error("Artifact is unavailable.");
    return artifact;
  }
  const result = await fetchApi<SourceRecord & { note?: SourceRecord; task?: SourceRecord }>(
    reference.kind === "note"
      ? `/api/notes/${reference.id}`
      : `/api/coordination/tasks/${reference.id}`,
  );
  return result.note ?? result.task ?? result;
}

export function PinToCanvas({ reference }: { reference: CanvasReference }) {
  return (
    <button
      type="button"
      onClick={() => useWorkspaceState.setState({ pendingPin: reference })}
      className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-primary"
      title="Pin a live reference to canvas"
    >
      <Pin size={12} /> Pin to canvas
    </button>
  );
}

export function ReferenceContent({
  reference,
  compact = false,
}: {
  reference: CanvasReference;
  compact?: boolean;
}) {
  const viewer = useChatState((s) => s.entityName);
  const query = useQuery({
    queryKey: ["canvas-reference", viewer, getToken(), reference],
    queryFn: () => resolveCanvasReference(reference),
    refetchInterval: 10_000,
  });
  if (query.isPending) return <p role="status">Loading {reference.kind}…</p>;
  if (query.isError)
    return (
      <div role="alert">
        <p>This {reference.kind} is unavailable or you do not have access.</p>
        <button type="button" onClick={() => void query.refetch()} className="text-primary">
          Retry
        </button>
      </div>
    );
  const record = query.data;
  return (
    <div className="space-y-2 text-sm">
      <div className="text-xs text-primary">
        Live {reference.kind} · {record.status ?? record.note_type ?? reference.id}
      </div>
      <h3 className="font-semibold text-text-bright">
        {record.title ?? `${reference.kind} ${reference.id}`}
      </h3>
      <p
        className={compact ? "line-clamp-5 whitespace-pre-wrap" : "whitespace-pre-wrap break-words"}
      >
        {record.content_text ?? record.content ?? record.description}
      </p>
      {compact ? (
        <button
          type="button"
          className="nodrag text-primary"
          onClick={() => useWorkspaceState.getState().inspect({ type: "reference", reference })}
        >
          Inspect source
        </button>
      ) : (
        <PinToCanvas reference={reference} />
      )}
    </div>
  );
}

export function PinToCanvasDialog() {
  const reference = useWorkspaceState((s) => s.pendingPin);
  return reference ? <PinDialog key={JSON.stringify(reference)} reference={reference} /> : null;
}
function PinDialog({ reference }: { reference: CanvasReference }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const canvases = useQuery({ queryKey: ["pin-canvases", getToken()], queryFn: fetchCanvases });
  const [canvasId, setCanvasId] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const close = () => useWorkspaceState.setState({ pendingPin: null });
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const selected = canvasId || canvases.data?.[0]?.id || "";
  return (
    <dialog
      ref={dialog}
      onCancel={close}
      onClose={close}
      className="w-[min(440px,90vw)] rounded-xl border border-border bg-bg-card p-5 text-text backdrop:bg-black/60"
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          setError("");
          try {
            const node = await postApi<{ id: string }>(
              `/api/canvases/${encodeURIComponent(selected)}/nodes`,
              { type: "embed", x: 0, y: 0, width: 320, height: 240, data: { reference } },
            );
            close();
            openCanvas(selected, node.id);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setSaving(false);
          }
        }}
        className="space-y-4"
      >
        <h2 className="text-lg font-semibold">Pin {reference.kind} to canvas</h2>
        <p className="text-sm text-text-dim">
          This card shows the current source to viewers who can access it. Only its reference is
          saved on the canvas.
        </p>
        <label className="block">
          Canvas
          <select
            aria-label="Destination canvas"
            value={selected}
            onChange={(e) => setCanvasId(e.target.value)}
            className="mt-1 w-full rounded border border-border bg-bg p-2"
          >
            {canvases.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        {canvases.isError && (
          <button type="button" onClick={() => void canvases.refetch()}>
            Could not load canvases. Retry
          </button>
        )}
        {canvases.data?.length === 0 && <p>Create a canvas from the Canvas tab first.</p>}
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-3">
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={!selected || saving}
            className="rounded bg-primary/20 px-3 py-2 text-primary disabled:opacity-40"
          >
            {saving ? "Pinning…" : "Pin reference"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
