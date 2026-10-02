// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { useMemo, useRef, useState } from "react";
import { parsePanelOperation } from "../../../src/sdk/panel-actions";
import { validatePanelDocument } from "../../../src/sdk/panel-document";
import { resolvePanelBindings } from "../../../src/sdk/panel-resources";
import { A2UIRenderer } from "../canvas/nodes/a2ui/A2UIRenderer";
import type { A2UIAction, A2UINodeData } from "../canvas/nodes/a2ui/types";
import { useCanvasNode } from "../hooks/use-canvas-node";
import { useChatState } from "../hooks/use-chat-state";
import { authFetch } from "../lib/api";
import { type PanelActionDraft, PanelActionReview } from "./PanelActionReview";
import { PanelResource, usePanelSources } from "./panel-resources";

/** Same content/action boundary in Canvas, chat and workspace panels. */
export function InteractivePanel(props: InteractivePanelProps) {
  const identity = useChatState((state) => `${state.loggedIn}:${state.entityName}`);
  return <PanelContent key={identity} {...props} />;
}
interface InteractivePanelProps {
  canvasId?: string;
  nodeId: string;
  data: Record<string, unknown>;
  active?: boolean;
  ancestors?: string[];
}
function PanelContent({
  canvasId,
  nodeId,
  data,
  active = true,
  ancestors = [],
}: InteractivePanelProps) {
  const key = `${canvasId}/${nodeId}`;
  const limited = ancestors.includes(key) || ancestors.length >= 4;
  const fields = useRef<Record<string, string | boolean>>({});
  const [review, setReview] = useState<PanelActionDraft>();
  const needsDocument = !Array.isArray(data.components);
  const query = useCanvasNode(
    needsDocument ? canvasId : undefined,
    needsDocument ? nodeId : undefined,
    active && !limited,
  );
  const document = needsDocument ? (query.isError ? undefined : query.data?.data) : data;
  const validated = useMemo(() => validatePanelDocument(document), [document]);
  const parsed = validated.ok ? validated.document : null;
  const sources = usePanelSources(parsed?.sources ?? {}, active && !limited);
  const display = parsed ? resolvePanelBindings(parsed, sources) : document;
  const nested = [...ancestors, key];
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [pending, setPending] = useState(0);
  const action = async (input: A2UIAction) => {
    if (!canvasId || !document?.panelRevision) return;
    const component = parsed?.components.find((c) => c.id === input.componentId);
    const operation = parsePanelOperation(component?.operation);
    if (operation && input.componentId) {
      const resolved = validatePanelDocument(display);
      const defaults = Object.fromEntries(
        (resolved.ok ? resolved.document.components : [])
          .filter((c) => ["TextField", "DateTimeInput", "CheckBox"].includes(c.component))
          .map((c) => [c.id, c.component === "CheckBox" ? (c.checked ?? false) : (c.value ?? "")]),
      );
      setReview({
        componentId: input.componentId,
        operation,
        revision: String(document.panelRevision),
        fields: { ...defaults, ...fields.current } as Record<string, string | boolean>,
        requestId: crypto.randomUUID(),
      });
      return;
    }
    // Operational forms keep drafts local. Legacy field_change notifications keep their old contract.
    if (input.event.name === "field_change" && parsed?.components.some((c) => c.operation)) return;
    setPending((n) => n + 1);
    try {
      const response = await authFetch(
        `/api/canvases/${encodeURIComponent(canvasId)}/nodes/${encodeURIComponent(nodeId)}/interaction`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            revision: document.panelRevision,
            componentId: input.componentId,
            value: input.event.payload?.value,
          }),
        },
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? `Interaction failed (${response.status}).`);
      setNotice({ error: false, text: "Interaction saved." });
    } catch (error) {
      setNotice({
        error: true,
        text: error instanceof Error ? error.message : "Interaction could not be saved.",
      });
    } finally {
      setPending((n) => n - 1);
    }
  };
  if (limited)
    return <p role="status">Nested panel limit reached. Open this reference as its own panel.</p>;
  if (needsDocument && query.isPending) return <p role="status">Loading panel…</p>;
  if (!document || document.panelError)
    return (
      <p role="alert">
        Panel unavailable: {String(document?.panelError ?? "Content could not be loaded.")}
      </p>
    );
  return (
    <div className="nodrag nowheel nopan space-y-2">
      <A2UIRenderer
        nodeData={display as unknown as A2UINodeData}
        onFieldChange={(id, value) => {
          fields.current[id] = value;
        }}
        renderResource={(component) => (
          <PanelResource
            reference={component.reference}
            active={active}
            renderNested={(canvasId, nodeId, data) => (
              <InteractivePanel
                canvasId={canvasId}
                nodeId={nodeId}
                data={data}
                active={active}
                ancestors={nested}
              />
            )}
          />
        )}
        onAction={canvasId && document.panelRevision ? action : undefined}
      />
      {review && canvasId && (
        <PanelActionReview
          draft={review}
          canvasId={canvasId}
          nodeId={nodeId}
          revision={document.panelRevision}
          onClose={() => setReview(undefined)}
        />
      )}
      <div className="h-12 overflow-auto" aria-live="polite">
        {pending > 0 && (
          <p role="status" className="text-xs text-text-dim">
            Saving interaction…
          </p>
        )}
        {notice && (
          <p role={notice.error ? "alert" : "status"} className="text-xs">
            {notice.text}
          </p>
        )}
      </div>
    </div>
  );
}
