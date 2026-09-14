// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * use-memory-map -- Store + live sync for the MEMORY layer.
 *
 * `useMemoryMapState` (zustand) holds the memory graph for the current scope,
 * plus two small ephemeral maps that drive animation: `pulses` (node id → ts of
 * the last state transition) and `adoptions` (job id → when it became adopted,
 * and which record it became — the `layoutId` hand-off window).
 *
 * `useMemoryMapLive` wires it to the world:
 *   - fetches `/api/memory/graph?entity=<scope>&limit=400` when the layer is
 *     visible, on scope change, and on WebSocket (re)connect;
 *   - attaches its OWN `message` listener to the dashboard WebSocket (the
 *     shared hook in `src/hooks/use-websocket.ts` only routes the
 *     `{type:"event"}` envelope; the memory contract also allows top-level
 *     `memory_job` / `memory_service_event` frames — both shapes are handled);
 *   - applies `memory_job` in place; debounces a refetch (≥ 2 s) on
 *     `memory.resolved` / `assistance.adopted` / `memory.created`.
 */

import { useCallback, useEffect, useRef } from "react";
import { create } from "zustand";
import { fetchApi } from "../../lib/api";
import {
  applyMemoryJobEvent,
  looksLikeMemoryFrame,
  parseMemoryLiveMessage,
} from "../lib/memory-map-reducer";
import {
  EMPTY_MEMORY_GRAPH,
  MEMORY_GRAPH_LIMIT,
  MEMORY_REFETCH_DEBOUNCE_MS,
  MEMORY_REFETCH_KINDS,
  type MemoryGraph,
  type MemoryJobEvent,
} from "../lib/memory-map-types";

/** How long a state-transition pulse ring stays visible. */
export const MEMORY_PULSE_MS = 2000;
/** How long an adopted record carries the job's `layoutId` (shared-element hand-off). */
export const MEMORY_ADOPT_HANDOFF_MS = 6000;

export interface MemoryMapState {
  graph: MemoryGraph;
  /** Entity the current graph was fetched for (undefined = operator view). */
  scopeEntity: string | undefined;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  lastFetchedAt: number;
  pulses: Record<string, number>;
  adoptions: Record<string, { recordId?: string; at: number }>;

  setGraph: (graph: MemoryGraph, scopeEntity: string | undefined) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  applyJob: (event: MemoryJobEvent) => void;
  reset: () => void;
}

export const useMemoryMapState = create<MemoryMapState>((set) => ({
  graph: EMPTY_MEMORY_GRAPH,
  scopeEntity: undefined,
  loaded: false,
  loading: false,
  error: null,
  lastFetchedAt: 0,
  pulses: {},
  adoptions: {},

  setGraph: (graph, scopeEntity) =>
    set({
      graph,
      scopeEntity,
      loaded: true,
      loading: false,
      error: null,
      lastFetchedAt: Date.now(),
    }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error, loading: false }),

  applyJob: (event) =>
    set((state) => {
      const result = applyMemoryJobEvent(state.graph, event);
      const pulses = result.transitioned
        ? { ...state.pulses, [result.nodeId]: event.timestamp }
        : state.pulses;
      const adoptions = result.adopted
        ? {
            ...state.adoptions,
            [result.adopted.jobId]: { recordId: result.adopted.recordId, at: event.timestamp },
          }
        : state.adoptions;
      return { graph: result.graph, pulses, adoptions };
    }),

  reset: () =>
    set({
      graph: EMPTY_MEMORY_GRAPH,
      scopeEntity: undefined,
      loaded: false,
      loading: false,
      error: null,
      lastFetchedAt: 0,
      pulses: {},
      adoptions: {},
    }),
}));

/** Build the graph URL for a scope — exported so tests can assert the query shape. */
export function memoryGraphUrl(entity: string | undefined, limit = MEMORY_GRAPH_LIMIT): string {
  const params = new URLSearchParams();
  if (entity) params.set("entity", entity);
  params.set("limit", String(limit));
  return `/api/memory/graph?${params.toString()}`;
}

/** Runtime shape check — the backend may still be landing; never trust blindly. */
export function isMemoryGraph(v: unknown): v is MemoryGraph {
  if (typeof v !== "object" || v === null) return false;
  const g = v as Record<string, unknown>;
  return Array.isArray(g.nodes) && Array.isArray(g.edges);
}

export interface UseMemoryMapLiveOptions {
  /** Layer visible → fetch + listen. Hidden → idle (state retained). */
  enabled: boolean;
  /** Selected/focused entity name, or undefined for the operator view. */
  entityName: string | undefined;
  /** The dashboard WebSocket ref returned by `useDashboardWebSocket`. */
  wsRef: React.RefObject<WebSocket | null>;
  /** Connection flag from the same hook — flips on every (re)connect. */
  connected: boolean;
}

export function useMemoryMapLive({
  enabled,
  entityName,
  wsRef,
  connected,
}: UseMemoryMapLiveOptions) {
  const setGraph = useMemoryMapState((s) => s.setGraph);
  const setLoading = useMemoryMapState((s) => s.setLoading);
  const setError = useMemoryMapState((s) => s.setError);
  const applyJob = useMemoryMapState((s) => s.applyJob);

  const scopeRef = useRef(entityName);
  scopeRef.current = entityName;
  const inFlightRef = useRef<string | null>(null);

  const refetch = useCallback(async () => {
    const scope = scopeRef.current;
    const url = memoryGraphUrl(scope);
    if (inFlightRef.current === url) return;
    inFlightRef.current = url;
    setLoading(true);
    try {
      const data = await fetchApi<unknown>(url);
      // Scope may have changed while the request was in flight — drop stale results.
      if (scopeRef.current !== scope) return;
      if (!isMemoryGraph(data)) {
        setError("memory graph: unexpected response shape");
        return;
      }
      setGraph({ nodes: data.nodes, edges: data.edges, truncated: data.truncated === true }, scope);
    } catch (err) {
      if (scopeRef.current !== scope) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (inFlightRef.current === url) inFlightRef.current = null;
    }
  }, [setGraph, setLoading, setError]);

  // Fetch on enable / scope change / reconnect.
  // biome-ignore lint/correctness/useExhaustiveDependencies: entityName + connected are intentional re-fetch triggers (scope change, WS reconnect); refetch reads the scope from a ref
  useEffect(() => {
    if (!enabled) return;
    void refetch();
  }, [enabled, entityName, connected, refetch]);

  // Debounced refetch — trailing edge, collapses bursts into one request.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefetch = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void refetch();
    }, MEMORY_REFETCH_DEBOUNCE_MS);
  }, [refetch]);
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  // Own WebSocket listener for memory frames (both shapes).
  // biome-ignore lint/correctness/useExhaustiveDependencies: connected is an intentional re-attach trigger — wsRef.current is a new socket after every reconnect
  useEffect(() => {
    if (!enabled) return;
    const ws = wsRef.current;
    if (!ws) return;
    const handler = (e: MessageEvent) => {
      if (!looksLikeMemoryFrame(e.data)) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(e.data);
      } catch {
        return;
      }
      const live = parseMemoryLiveMessage(parsed);
      if (!live) return;
      if (live.type === "memory_job") {
        applyJob(live);
        if (live.job.adopted) scheduleRefetch();
        return;
      }
      if (MEMORY_REFETCH_KINDS.has(live.kind)) scheduleRefetch();
    };
    ws.addEventListener("message", handler);
    return () => ws.removeEventListener("message", handler);
  }, [enabled, connected, wsRef, applyJob, scheduleRefetch]);

  return { refetch };
}
