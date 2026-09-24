// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { useQuery } from "@tanstack/react-query";
import type { EntityPreview } from "../../../src/net/discovery-types";
import { useChatState } from "../hooks/use-chat-state";
import { useWorldState } from "../hooks/use-world-state";
import { fetchApi } from "../lib/api";
import { AgentPanel } from "./AgentPanel";
import { EntityExpandedDetail } from "./EntityRoster";

export function EntityInspector({ name }: { name: string }) {
  const viewer = useChatState((s) => s.entityName);
  const entity = useWorldState((s) => s.entities.find((e) => e.name === name));
  const preview = useQuery({
    queryKey: ["entity-preview", viewer, name],
    queryFn: () => fetchApi<EntityPreview>(`/api/entities/${encodeURIComponent(name)}/preview`),
    refetchInterval: 10_000,
  });
  return (
    <div className="space-y-3 p-3 text-sm">
      <h3 className="font-semibold text-primary">{name}</h3>
      {preview.isPending && <p role="status">Loading agent…</p>}
      {preview.isError && (
        <p role="alert">
          Details unavailable.{" "}
          <button type="button" onClick={() => void preview.refetch()} className="text-primary">
            Retry
          </button>
        </p>
      )}
      {preview.data && (
        <>
          <p>
            Rank {preview.data.rank} · Standing {preview.data.standing ?? "unavailable"}
          </p>
          {entity && (
            <button
              type="button"
              onClick={() => useWorldState.getState().selectRoom(entity.room)}
              className="text-primary"
            >
              Room: {entity.room}
            </button>
          )}
          {preview.data.privateVisible ? (
            <>
              <dl className="space-y-1">
                <dt className="text-text-dim">Inventory</dt>
                <dd>{preview.data.inventory?.join(", ") || "Empty"}</dd>
                <dt className="text-text-dim">Current task</dt>
                <dd>{preview.data.task ?? "None"}</dd>
                <dt className="text-text-dim">Active crew</dt>
                <dd>{preview.data.crew ?? "None"}</dd>
              </dl>
              {entity?.agentStatus && <AgentPanel name={name} status={entity.agentStatus} />}
              {entity && (
                <EntityExpandedDetail
                  name={name}
                  room={entity.room}
                  onRoomClick={() => useWorldState.getState().selectRoom(entity.room)}
                />
              )}
            </>
          ) : (
            <p className="text-text-dim">Inventory, work details, and memory are private.</p>
          )}
        </>
      )}
    </div>
  );
}
