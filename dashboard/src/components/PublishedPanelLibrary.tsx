// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { panelOperationLabel, parsePanelOperation } from "../../../src/sdk/panel-actions";
import { MarinaPanelClient } from "../../../src/sdk/panel-client";
import { validatePanelDocument } from "../../../src/sdk/panel-document";
import { useChatState } from "../hooks/use-chat-state";
import { getToken } from "../lib/api";
import { apiOrigin } from "../lib/api-origin";
import { openBoundPanel } from "../lib/panel-bindings";
import { CodingDeskPublisher } from "./CodingDeskPublisher";
import { PanelResourceCatalog } from "./PanelResourceCatalog";

export function PublishedPanelLibrary() {
  const [open, setOpen] = useState(false);
  const [canvas, setCanvas] = useState("");
  const [search, setSearch] = useState("");
  const identity = useChatState((s) => `${s.loggedIn}:${s.entityName}`);
  const client = new MarinaPanelClient({
    url: apiOrigin(),
    token: () => getToken() ?? undefined,
  });
  const canvases = useQuery({
    queryKey: ["published-canvases", identity, getToken()],
    queryFn: ({ signal }) => client.canvases(signal),
    enabled: open,
    retry: false,
  });
  const nodes = useQuery({
    queryKey: ["published-panels", identity, getToken(), canvas],
    queryFn: ({ signal }) => client.list(canvas, signal),
    enabled: open && !!canvas,
    refetchInterval: open ? 15000 : false,
    retry: false,
  });
  return (
    <div className="relative">
      <button
        type="button"
        className="text-xs text-primary"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Published panels
      </button>
      {open && (
        <section
          aria-label="Published panels"
          className="absolute right-0 top-7 z-50 w-80 max-h-96 overflow-auto rounded border border-border bg-bg p-3 shadow-xl space-y-3"
        >
          <PanelResourceCatalog client={client} identity={identity} />
          <label className="block text-sm">
            Canvas
            <select
              className="mission-field"
              value={canvas}
              onChange={(e) => setCanvas(e.target.value)}
            >
              <option value="">Choose a canvas…</option>
              {!canvases.isError &&
                canvases.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
          {canvas && (
            <CodingDeskPublisher
              canvasId={canvas}
              client={client}
              onPublished={() => {
                void nodes.refetch();
                setOpen(false);
              }}
            />
          )}
          <input
            aria-label="Find a published panel"
            className="mission-field"
            placeholder="Find a panel…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {(canvases.isError || nodes.isError) && (
            <p role="alert">Publications unavailable or access denied.</p>
          )}
          {!nodes.isError &&
            nodes.data
              ?.filter((n) =>
                String(n.data.title ?? n.id)
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              )
              .slice(0, 100)
              .map((node) => {
                const parsed = validatePanelDocument(node.data);
                return (
                  <article
                    key={node.id}
                    className="rounded border border-border p-2 space-y-2 text-sm"
                  >
                    <h3 className="font-semibold">
                      {String(node.data.title ?? "Published panel")}
                    </h3>
                    <p className="text-xs">By {node.creator_name}</p>
                    <details>
                      <summary>Sources and actions</summary>
                      <p className="break-all text-xs">
                        Revision {node.data.panelRevision ?? "Load to inspect"}
                      </p>
                      {parsed.ok && (
                        <>
                          <pre className="text-xs whitespace-pre-wrap">
                            {JSON.stringify(parsed.document.sources ?? {}, null, 2)}
                          </pre>
                          {parsed.document.components.map((c) => {
                            const op = parsePanelOperation(c.operation);
                            return op ? (
                              <p key={c.id} className="text-xs">
                                {panelOperationLabel(op)}
                              </p>
                            ) : null;
                          })}
                        </>
                      )}
                    </details>
                    <button
                      type="button"
                      className="text-primary"
                      onClick={() => {
                        openBoundPanel({ kind: "canvas-node", canvasId: canvas, nodeId: node.id });
                        setOpen(false);
                      }}
                    >
                      Open beside my work
                    </button>
                  </article>
                );
              })}
          {nodes.data?.length === 0 && <p>No published panels on this canvas yet.</p>}
          <button type="button" className="text-primary" onClick={() => setOpen(false)}>
            Close library
          </button>
        </section>
      )}
    </div>
  );
}
