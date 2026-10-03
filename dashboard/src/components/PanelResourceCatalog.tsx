// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { MarinaPanelClient } from "../../../src/sdk/panel-client";
import { getToken } from "../lib/api";

/** Authoring discovery uses the server catalog, so deployed adapters are visible to humans too. */
export function PanelResourceCatalog({
  client,
  identity,
}: {
  client: MarinaPanelClient;
  identity: string;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const query = useQuery({
    queryKey: ["panel-resource-catalog", identity, getToken()],
    queryFn: ({ signal }) => client.resources(signal),
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Compose a panel</summary>
      <p className="my-2 text-xs">
        Use these sources in a Resource component or bind their JSON fields to text, tables and
        timelines. Each reader uses their own permissions. Agents can discover the same catalog with
        canvas resources.
      </p>
      <label className="block text-sm">
        Find a data source
        <input
          className="mission-field"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="coding, memory, channels…"
        />
      </label>
      {query.isError && <p role="alert">Resource catalog unavailable.</p>}
      {open && query.isPending && <p role="status">Loading resources…</p>}
      {!query.isError &&
        query.data?.resources
          .filter((r) => r.id.includes(filter.toLowerCase()))
          .map((resource) => (
            <details key={resource.id} className="my-2 text-xs">
              <summary>{resource.id}</summary>
              <pre className="whitespace-pre-wrap break-words">
                {JSON.stringify(
                  {
                    kind: "resource",
                    resource: resource.id,
                    ...(resource.parameters.length
                      ? {
                          params: Object.fromEntries(
                            resource.parameters.map((key) => [key, `<${key}>`]),
                          ),
                        }
                      : {}),
                  },
                  null,
                  2,
                )}
              </pre>
              {resource.query.length > 0 && (
                <p>Optional query fields: {resource.query.join(", ")}</p>
              )}
            </details>
          ))}
    </details>
  );
}
