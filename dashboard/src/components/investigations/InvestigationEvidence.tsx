// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { Background, Controls, type Edge, type Node, ReactFlow } from "@xyflow/react";
import { useMemo, useState } from "react";
import type { InvestigationEvent } from "../../../../src/sdk/investigation-types";
import { useChatState } from "../../hooks/use-chat-state";
import { investigations } from "../../hooks/use-investigations";
import "@xyflow/react/dist/style.css";

/** Edges denote captured input/output only; no invented causal or entailment relationships. */
export function evidenceGraph(events: InvestigationEvent[]): { nodes: Node[]; edges: Edge[] } {
  const starts = events.filter((event) => event.kind === "stage_started").slice(-80);
  const byStage = new Map(
    events
      .filter((event) => event.stageId && event.kind !== "stage_started")
      .map((event) => [event.stageId!, event]),
  );
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  starts.forEach((event, index) => {
    const end = byStage.get(event.stageId!);
    const id = event.stageId!;
    const style = {
      background: "var(--color-surface)",
      color: "var(--color-text)",
      borderColor: "var(--color-border)",
      borderRadius: 12,
      width: 190,
      padding: 14,
      fontSize: 12,
    };
    nodes.push({
      id,
      position: { x: 235, y: index * 104 },
      data: {
        label: `${event.actor}\n${event.message ?? "Work"}\n${end?.kind === "stage_completed" ? "Completed" : end?.kind === "stage_failed" ? "Failed" : "No completion recorded"}`,
      },
      style,
    });
    if (event.inputId) {
      nodes.push({
        id: event.inputId,
        position: { x: 0, y: index * 104 },
        data: { label: "Captured input", contentId: event.inputId },
        style,
      });
      edges.push({
        id: `${id}:input`,
        source: event.inputId,
        target: id,
        label: "supplied",
        style: { stroke: "var(--color-primary)" },
      });
    }
    if (end?.outputId) {
      nodes.push({
        id: end.outputId,
        position: { x: 470, y: index * 104 },
        data: { label: "Returned output", contentId: end.outputId },
        style,
      });
      edges.push({
        id: `${id}:output`,
        source: id,
        target: end.outputId,
        label: "returned",
        style: { stroke: "var(--color-primary)" },
      });
    }
  });
  return { nodes, edges };
}

export function InvestigationEvidence({ events }: { events: InvestigationEvent[] }) {
  const graph = useMemo(() => evidenceGraph(events), [events]);
  const [contentId, setContentId] = useState<string>();
  const name = useChatState((s) => (s.loggedIn ? s.entityName : null));
  const content = useQuery({
    queryKey: ["investigations", name, "content", contentId],
    queryFn: ({ signal }) => investigations.content(contentId!, signal),
    enabled: !!name && !!contentId,
    retry: false,
    staleTime: 0,
  });
  return (
    <div className="space-y-3">
      <p className="text-sm text-text-secondary">
        Follow the actual inputs and outputs. Select a document to inspect the captured bytes.
        Connections mean “supplied” or “returned”, not proof that a source supports a claim.
      </p>
      {graph.nodes.length ? (
        <div
          className="h-[420px] overflow-hidden rounded-xl border border-border bg-bg"
          role="region"
          aria-label="Evidence canvas"
        >
          <ReactFlow
            nodes={graph.nodes}
            edges={graph.edges}
            fitView
            minZoom={0.1}
            nodesDraggable={false}
            nodesConnectable={false}
            onNodeClick={(_event, node) => {
              if (typeof node.data.contentId === "string") setContentId(node.data.contentId);
            }}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      ) : (
        <p className="py-8 text-center text-sm text-text-dim">
          Captured stages will appear here as work begins.
        </p>
      )}
      <details className="rounded-lg border border-border p-3 text-sm">
        <summary className="cursor-pointer">Browse captured documents as a list</summary>
        <ul className="mt-3 space-y-2">
          {events
            .filter((event) => event.inputId || event.outputId)
            .map((event) => (
              <li key={event.sequence} className="flex flex-wrap gap-2">
                <span className="text-text-secondary">
                  {event.sequence}. {event.actor} · {event.message}
                </span>
                {event.inputId && (
                  <button
                    className="text-primary underline"
                    type="button"
                    onClick={() => setContentId(event.inputId)}
                  >
                    Input
                  </button>
                )}
                {event.outputId && (
                  <button
                    className="text-primary underline"
                    type="button"
                    onClick={() => setContentId(event.outputId)}
                  >
                    Output
                  </button>
                )}
              </li>
            ))}
        </ul>
      </details>
      {contentId && (
        <section
          className="rounded-xl border border-primary/30 bg-surface p-4"
          aria-label="Captured document"
        >
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="font-medium">{content.data?.label ?? "Captured document"}</h3>
            <button
              type="button"
              className="text-sm text-primary"
              onClick={() => setContentId(undefined)}
            >
              Close
            </button>
          </div>
          {content.isError ? (
            <p role="alert">Document unavailable, expired or no longer authorized.</p>
          ) : content.data ? (
            <>
              <p className="mb-2 break-all font-mono text-[10px] text-text-dim">
                {content.data.bytes.toLocaleString()} bytes · SHA-256 {content.data.hash}
              </p>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs text-text-secondary">
                {JSON.stringify(content.data.value, null, 2)}
              </pre>
            </>
          ) : (
            <p role="status">Loading document…</p>
          )}
        </section>
      )}
    </div>
  );
}
