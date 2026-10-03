// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { useQuery } from "@tanstack/react-query";
import { type PanelSource, resolvePanelSource } from "../../../src/sdk/panel-resources";
import { authFetch, getToken } from "../lib/api";
import { requestResidentMemory } from "../lib/memory-service";
import { useChatState } from "./use-chat-state";
import { usePanelRealtime } from "./use-panel-realtime";
export function panelSourceOptions(source: PanelSource, identity: string, active: boolean) {
  return {
    queryKey: ["panel-source", identity, getToken(), source],
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      resolvePanelSource(
        source,
        async (path) => {
          const response = await authFetch(path, { signal });
          if (!response.ok) throw new Error("Source unavailable or access denied.");
          return response.json();
        },
        (id, spaceId) => requestResidentMemory({ operation: "get", id, space_id: spaceId }, signal),
      ),
    enabled: active,
    staleTime: 2000,
    refetchInterval: active ? 5000 : (false as const),
    retry: false,
  };
}
export function usePanelSource<T = unknown>(source: PanelSource, active: boolean) {
  const identity = useChatState((s) => `${s.loggedIn}:${s.entityName}`);
  usePanelRealtime(active);
  return useQuery({ ...panelSourceOptions(source, identity, active), select: (data) => data as T });
}
