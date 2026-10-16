// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MarinaInvestigationClient } from "../../../src/sdk/investigation-client";
import {
  type InvestigationEvent,
  investigationTerminal,
} from "../../../src/sdk/investigation-types";
import { getToken } from "../lib/api";
import { apiOrigin } from "../lib/api-origin";
import { useChatState } from "./use-chat-state";

export const investigations = new MarinaInvestigationClient({
  url: apiOrigin(),
  token: () => getToken() ?? "",
});

export function useInvestigationList(active = true) {
  const name = useChatState((s) => (s.loggedIn ? s.entityName : null));
  return useQuery({
    queryKey: ["investigations", name, "list"],
    queryFn: ({ signal }) => investigations.list(undefined, signal),
    enabled: !!name && active,
    retry: false,
    refetchInterval: active ? 15_000 : false,
  });
}

export function useInvestigation(caseId?: string, attemptId?: string, active = true) {
  const name = useChatState((s) => (s.loggedIn ? s.entityName : null));
  return useQuery({
    queryKey: ["investigations", name, "case", caseId, attemptId],
    queryFn: ({ signal }) => investigations.get(caseId!, attemptId, signal),
    enabled: !!name && !!caseId && active,
    retry: false,
    refetchInterval: (query) =>
      !active
        ? false
        : !query.state.data ||
            !investigationTerminal(query.state.data.attempt.state) ||
            query.state.data.attempt.accounting.outstanding > 0
          ? 2000
          : 15_000,
  });
}

interface EventHistory {
  events: InvestigationEvent[];
  cursor: number;
  more: boolean;
}

/** Incremental replay, bounded by the server's journal cap; no repeated full-history polling. */
export function useInvestigationEvents(attemptId?: string, active = true) {
  const name = useChatState((s) => (s.loggedIn ? s.entityName : null));
  const cache = useQueryClient();
  const key = ["investigations", name, "events", attemptId];
  return useQuery({
    queryKey: key,
    enabled: !!name && !!attemptId && active,
    retry: false,
    queryFn: async ({ signal }): Promise<EventHistory> => {
      const previous = cache.getQueryData<EventHistory>(key);
      let events = previous?.events ?? [];
      let cursor = previous?.cursor ?? 0;
      let more = false;
      for (let page = 0; page < 5; page++) {
        const next = await investigations.events(attemptId!, cursor, signal);
        if (next.reset) {
          events = [];
          cursor = 0;
          more = true;
          continue;
        }
        events = [...events, ...next.events.filter((event) => event.sequence > cursor)].slice(
          -10_500,
        );
        cursor = next.cursor;
        more = next.more;
        if (!more) break;
      }
      return { events, cursor, more };
    },
    refetchInterval: (query) => (!active ? false : query.state.data?.more ? 1000 : 3000),
  });
}
