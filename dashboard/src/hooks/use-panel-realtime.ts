// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { type PanelChangeEvent, panelSourceAffected } from "../../../src/sdk/panel-events";
import { parsePanelSource } from "../../../src/sdk/panel-resources";
import { getToken } from "../lib/api";
import { useChatState } from "./use-chat-state";
import { useWorldState } from "./use-world-state";

const watchers = new WeakMap<QueryClient, Map<string, { users: number; close: () => void }>>();
/** Reuse the dashboard socket and query cache across repeated views. Coalescing does not
 * restart on every token, and an event during an in-flight read requires a subsequent read. */
export function watchPanelQueries(client: QueryClient, identity: string, token: string | null) {
  let registry = watchers.get(client);
  if (!registry) {
    registry = new Map();
    watchers.set(client, registry);
  }
  const key = JSON.stringify([identity, token]);
  let watcher = registry.get(key);
  if (!watcher) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Set<string>();
    const base = ["panel-source", identity, token];
    const schedule = () => {
      timer ??= setTimeout(flush, 120);
    };
    const flush = () => {
      timer = undefined;
      for (const query of client.getQueryCache().findAll({ queryKey: base })) {
        if (!pending.has(query.queryHash)) continue;
        if (!query.isActive()) {
          pending.delete(query.queryHash);
          continue;
        }
        if (query.state.fetchStatus === "fetching") continue;
        pending.delete(query.queryHash);
        void client.invalidateQueries(
          { queryKey: query.queryKey, exact: true },
          { cancelRefetch: false },
        );
      }
      // Deleted queries cannot leave a perpetual timer.
      for (const hash of pending) if (!client.getQueryCache().get(hash)) pending.delete(hash);
      if (pending.size) schedule();
    };
    const refresh = (events?: PanelChangeEvent[]) => {
      for (const query of client.getQueryCache().findAll({ queryKey: base })) {
        const source = parsePanelSource(query.queryKey[3]);
        if (source && (!events || events.some((event) => panelSourceAffected(source, event))))
          pending.add(query.queryHash);
      }
      if (pending.size) schedule();
    };
    const unsubscribe = useWorldState.subscribe((state, previous) => {
      if (state.connectionGeneration !== previous.connectionGeneration) {
        refresh();
        return;
      }
      if (state.eventFeed === previous.eventFeed) return;
      const end = previous.eventFeed[0] ? state.eventFeed.indexOf(previous.eventFeed[0]) : -1;
      refresh(state.eventFeed.slice(0, end < 0 ? undefined : end));
    });
    watcher = {
      users: 0,
      close: () => {
        unsubscribe();
        clearTimeout(timer);
        pending.clear();
      },
    };
    registry.set(key, watcher);
  }
  watcher.users++;
  return () => {
    if (--watcher.users === 0) {
      watcher.close();
      registry.delete(key);
    }
  };
}

export function usePanelRealtime(active: boolean) {
  const client = useQueryClient();
  const identity = useChatState((s) => `${s.loggedIn}:${s.entityName}`);
  const token = getToken();
  useEffect(
    () => (active ? watchPanelQueries(client, identity, token) : undefined),
    [client, identity, token, active],
  );
}
