// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { useQueries } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { type PanelSource, parsePanelSource } from "../../../src/sdk/panel-resources";
import type { RoutingEvent, RoutingSession } from "../../../src/sdk/routing-types";
import { useChatState } from "../hooks/use-chat-state";
import { usePanelRealtime } from "../hooks/use-panel-realtime";
import { panelSourceOptions, usePanelSource } from "../hooks/use-panel-source";
import { openBoundPanel } from "../lib/panel-bindings";
import type { TaskDetail } from "../lib/types";
import { CodingDeskResource } from "./CodingDeskResource";
import { ParticipantActivity } from "./ParticipantActivity";
import { TaskEvidence } from "./TaskEvidence";

export function usePanelSources(sources: Record<string, PanelSource>, active: boolean) {
  usePanelRealtime(active && Object.keys(sources).length > 0);
  const identity = useChatState((s) => `${s.loggedIn}:${s.entityName}`);
  const entries = Object.entries(sources);
  const queries = useQueries({
    queries: entries.map(([, source]) => panelSourceOptions(source, identity, active)),
  });
  return Object.fromEntries(
    entries.map(([name], i) => [name, queries[i]!.isError ? undefined : queries[i]!.data]),
  );
}

export function PanelResource({
  reference,
  active,
  renderNested = () => null,
}: {
  reference: unknown;
  active: boolean;
  renderNested?: (canvasId: string, nodeId: string, data: Record<string, unknown>) => ReactNode;
}) {
  const source = parsePanelSource(reference);
  return source ? (
    <Resource source={source} active={active} renderNested={renderNested} />
  ) : (
    <p role="alert">Invalid resource reference.</p>
  );
}
function Resource({
  source,
  active,
  renderNested,
}: {
  source: PanelSource;
  active: boolean;
  renderNested: (canvasId: string, nodeId: string, data: Record<string, unknown>) => ReactNode;
}) {
  const query = usePanelSource(source, active);
  const [expanded, setExpanded] = useState(false);
  if (query.isError)
    return <p role="alert">This {source.kind} is unavailable or you do not have access.</p>;
  if (query.isPending) return <p role="status">Loading {source.kind}…</p>;
  if (source.kind === "resource")
    return (
      <section
        aria-label={source.resource}
        className="max-h-80 overflow-auto rounded border border-border p-2 text-sm"
      >
        <h3>{source.resource}</h3>
        <pre className="whitespace-pre-wrap break-words">{JSON.stringify(query.data, null, 2)}</pre>
      </section>
    );
  const value = query.data as Record<string, unknown>;
  if (source.kind === "coding") return <CodingDeskResource value={value} />;
  if (source.kind === "canvas") {
    const data = value.data as Record<string, unknown>;
    return (
      <section className="space-y-2 rounded border border-border p-2">
        <span className="text-sm">{String(data.title ?? "Referenced panel")}</span>
        <button
          type="button"
          className="ml-2 text-primary"
          onClick={() =>
            openBoundPanel({ kind: "canvas-node", canvasId: source.canvasId, nodeId: source.id })
          }
        >
          Open as panel
        </button>
        <button
          type="button"
          aria-expanded={expanded}
          className="ml-2 text-primary"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Collapse" : "Expand here"}
        </button>
        {expanded && renderNested(source.canvasId, source.id, data)}
      </section>
    );
  }
  if (source.kind === "participant")
    return (
      <section
        aria-label="Participant output"
        className="max-h-80 overflow-auto rounded border border-border p-2"
      >
        <p>{(value.session as RoutingSession).label}</p>
        {value.gap === true && (
          <p role="status">Earlier output expired; this history is incomplete.</p>
        )}
        <ParticipantActivity
          events={value.events as RoutingEvent[]}
          adapter={(value.session as RoutingSession).kind}
        />
        <button
          type="button"
          className="text-primary"
          onClick={() => openBoundPanel({ kind: "participant", id: source.id })}
        >
          Open participant beside my work
        </button>
      </section>
    );
  if (source.kind === "task")
    return (
      <section className="rounded border border-border p-2">
        <h3 className="font-semibold">{String(value.title ?? `Task ${source.id}`)}</h3>
        <p>{String(value.status ?? "")}</p>
        <p className="whitespace-pre-wrap">{String(value.description ?? "")}</p>
        {active && <TaskEvidence task={value as unknown as TaskDetail} active={active} />}
      </section>
    );
  if (source.kind === "feed")
    return (
      <ol className="max-h-80 overflow-auto space-y-2">
        {(query.data as Array<{ id: number; summary: string }>).map((event) => (
          <li key={event.id} className="border-b border-border p-1 text-sm">
            {event.summary}
          </li>
        ))}
      </ol>
    );
  return (
    <section className="max-h-80 overflow-auto rounded border border-border p-2 text-sm">
      <h3>{String(value.subject ?? value.title ?? source.kind)}</h3>
      <p className="whitespace-pre-wrap">
        {String(value.content ?? value.content_text ?? JSON.stringify(value, null, 2))}
      </p>
    </section>
  );
}
