// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { useQuery } from "@tanstack/react-query";
import type { RuntimeState } from "../../../src/sdk/routing-runtime-types";
import type { RoutingOverview } from "../../../src/sdk/routing-types";
import { fetchApi, getToken } from "../lib/api";
import { useChatState } from "./use-chat-state";

export function runtimeState(value: unknown): RuntimeState | null {
  if (!value || typeof value !== "object") return null;
  const state = value as RuntimeState;
  if (
    !(
      state.version === 1 &&
      typeof state.updatedAt === "number" &&
      ["agent", "supervisor", "attachment"].includes(state.role) &&
      ["starting", "idle", "running", "waiting", "stopped", "failed", "disconnected"].includes(
        state.status,
      )
    )
  )
    return null;
  return {
    ...state,
    error: typeof state.error === "string" ? state.error : undefined,
    root: typeof state.root === "string" ? state.root : undefined,
    cwd: typeof state.cwd === "string" ? state.cwd : "",
    mode: state.mode === "attached" ? "attached" : "managed",
    adapters: Array.isArray(state.adapters)
      ? state.adapters.filter(
          (entry) => entry && typeof entry.id === "string" && typeof entry.label === "string",
        )
      : [],
    request:
      state.request &&
      typeof state.request === "object" &&
      typeof state.request.id === "string" &&
      typeof state.request.title === "string" &&
      ["permission", "question"].includes(state.request.kind)
        ? {
            ...state.request,
            choices: Array.isArray(state.request.choices)
              ? state.request.choices.filter((choice) => typeof choice === "string")
              : undefined,
          }
        : undefined,
  };
}

export function useRoutingOverview(attention = false, after = "", active = true) {
  const loggedIn = useChatState((state) => state.loggedIn);
  const identity = useChatState((state) => state.entityName);
  const token = getToken();
  const enabled = loggedIn && !!token && active;
  const query = useQuery({
    queryKey: ["routing-overview", identity, token, attention, after],
    queryFn: () =>
      fetchApi<RoutingOverview>(
        `/api/routing/overview?attention=${attention}&after=${encodeURIComponent(after)}&limit=100`,
      ),
    enabled,
    refetchInterval: enabled ? 5000 : false,
    staleTime: 2000,
    retry: false,
  });
  return { ...query, data: enabled && !query.isError ? query.data : undefined, enabled };
}
