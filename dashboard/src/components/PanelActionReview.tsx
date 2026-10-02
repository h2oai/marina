// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { CapabilityManifest } from "../../../src/sdk/capabilities";
import { type PanelOperation, panelOperationLabel } from "../../../src/sdk/panel-actions";
import type { RoutingOverview } from "../../../src/sdk/routing-types";
import { authFetch, fetchApi, getToken } from "../lib/api";
import { requestParticipant } from "../lib/memory-service";

export interface PanelActionDraft {
  componentId: string;
  revision: string;
  operation: PanelOperation;
  fields: Record<string, string | boolean>;
  requestId: string;
}
/** An explicit click captures the target and inputs. Remount/reconnect never submits. */
export function PanelActionReview({
  draft,
  canvasId,
  nodeId,
  revision,
  onClose,
}: {
  draft: PanelActionDraft;
  canvasId: string;
  nodeId: string;
  revision: unknown;
  onClose: () => void;
}) {
  const [sourceId, setSourceId] = useState("");
  const [pending, setPending] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [result, setResult] = useState<{ error: boolean; text: string; done?: boolean }>();
  const [frozenBody, setFrozenBody] = useState<Record<string, unknown>>();
  const overview = useQuery({
    queryKey: ["panel-senders", getToken()],
    queryFn: () => fetchApi<RoutingOverview>("/api/routing/overview?limit=100"),
    enabled: draft.operation.kind === "message",
    retry: false,
  });
  const capabilities = useQuery({
    queryKey: ["panel-action-capabilities", draft.requestId, getToken()],
    queryFn: () => requestParticipant<CapabilityManifest>("capabilities", {}),
    enabled: draft.operation.kind === "command",
    retry: false,
  });
  const senders =
    overview.data?.items.filter((item) => item.owned && item.session.state === "active") ?? [];
  const changed = draft.revision !== revision;
  async function submit() {
    if (pending || changed) return;
    const body = frozenBody ?? {
      revision: draft.revision,
      componentId: draft.componentId,
      fields: draft.fields,
      requestId: draft.requestId,
      sourceId,
      capabilityRevision: capabilities.data?.revision,
    };
    setFrozenBody(body);
    setAttempted(true);
    setPending(true);
    try {
      const response = await authFetch(
        `/api/canvases/${encodeURIComponent(canvasId)}/nodes/${encodeURIComponent(nodeId)}/interaction`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? `Action failed (${response.status})`);
      setResult({
        error: false,
        done: true,
        text: value.receipt
          ? `${value.status} · receipt ${value.receipt.id}. ${value.message}`
          : value.message,
      });
    } catch (error) {
      setResult({
        error: true,
        text: `${error instanceof Error ? error.message : "Connection interrupted."}${draft.operation.kind === "command" ? " Check world activity before submitting again; a lost response is not proof of failure." : " Retry keeps the same destination, values and delivery identity."}`,
      });
    } finally {
      setPending(false);
    }
  }
  return (
    <section
      aria-label="Review panel action"
      className="rounded border border-primary/40 bg-bg p-3 space-y-2 text-sm"
    >
      <h3 className="font-semibold">{panelOperationLabel(draft.operation)}</h3>
      <p>Runs as your current Marina resident.</p>
      <details>
        <summary>Destination and values</summary>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">
          {JSON.stringify({ operation: draft.operation, fields: draft.fields }, null, 2)}
        </pre>
      </details>
      {draft.operation.kind === "message" && (
        <label className="block">
          Send from your participant
          <select
            aria-label="Sending participant"
            value={sourceId}
            disabled={attempted}
            onChange={(e) => setSourceId(e.target.value)}
            className="mission-field"
          >
            <option value="">Choose a participant…</option>
            {senders.map(({ session }) => (
              <option key={session.id} value={session.id}>
                {session.label} · {session.id}
              </option>
            ))}
          </select>
          {!overview.isPending && !senders.length && (
            <p>No active sending participant. Join through Streams first.</p>
          )}
        </label>
      )}
      {(overview.isError || capabilities.isError) && (
        <p role="alert">Unable to load your current participants or capabilities.</p>
      )}
      {changed && (
        <p role="alert">
          Panel changed. Close this review and inspect the updated action; your draft is preserved.
        </p>
      )}
      {result && <p role={result.error ? "alert" : "status"}>{result.text}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          className="mission-primary"
          disabled={
            pending ||
            changed ||
            result?.done ||
            (draft.operation.kind === "message" && !sourceId) ||
            (draft.operation.kind === "command" && (!capabilities.data || attempted))
          }
          onClick={() => void submit()}
        >
          {pending ? "Submitting…" : attempted ? "Retry same delivery" : "Confirm action"}
        </button>
        <button type="button" className="mission-secondary" disabled={pending} onClick={onClose}>
          Close review
        </button>
      </div>
    </section>
  );
}
