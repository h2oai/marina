// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { useQuery } from "@tanstack/react-query";
import type { EntityPreview } from "../../../src/net/discovery-types";
import { useChatState } from "../hooks/use-chat-state";
import { fetchApi } from "../lib/api";
import { draftCommand } from "../lib/command-discovery";

export function MyInventory() {
  const name = useChatState((s) => s.entityName);
  const query = useQuery({
    queryKey: ["entity-preview", name, name],
    queryFn: () => fetchApi<EntityPreview>(`/api/entities/${encodeURIComponent(name!)}/preview`),
    enabled: !!name,
    refetchInterval: 5_000,
  });
  return (
    <section aria-label="My inventory" className="shrink-0 border-b border-border p-3 text-sm">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="font-semibold text-primary">My inventory</h3>
        <button
          type="button"
          onClick={() => name && void query.refetch()}
          disabled={!name}
          className="text-xs text-text-dim"
        >
          Refresh
        </button>
      </div>
      {!name ? (
        <p className="text-xs text-text-dim">Connect in Chat to see what you’re carrying.</p>
      ) : query.isPending ? (
        <p role="status">Loading inventory…</p>
      ) : query.isError ? (
        <p role="alert">
          Could not load inventory.{" "}
          <button type="button" onClick={() => void query.refetch()}>
            Retry
          </button>
        </p>
      ) : !query.data.privateVisible ? (
        <p>Inventory is private.</p>
      ) : !query.data.inventory?.length ? (
        <p className="text-text-dim">You’re carrying nothing.</p>
      ) : (
        <ul className="max-h-32 space-y-1 overflow-auto">
          {query.data.inventory.map((item) => (
            <li key={item} className="flex items-center justify-between gap-2">
              <span className="truncate">{item}</span>
              <button
                type="button"
                onClick={() => draftCommand(`look ${item}`)}
                className="text-xs text-primary"
              >
                Inspect
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
