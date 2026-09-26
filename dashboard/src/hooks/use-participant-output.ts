// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from "react";
import type { MarinaRoutingClient } from "../../../src/sdk/routing-client";
import type { RoutingEvent } from "../../../src/sdk/routing-types";
import { mergeParticipantEvents } from "../lib/participant-activity";

/** Mounted per participant/account. Pausing the view preserves its cursor without polling. */
export function useParticipantOutput(
  client: MarinaRoutingClient,
  sessionId: string,
  lastSequence: number,
  active: boolean,
) {
  const cursor = useRef(Math.max(0, lastSequence - 100));
  const [events, setEvents] = useState<RoutingEvent[]>([]);
  const [gap, setGap] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [restart, setRestart] = useState(0);
  const [catchingUp, setCatchingUp] = useState(false);
  const replay = useCallback(() => {
    cursor.current = 0;
    setEvents([]);
    setGap(false);
    setLoaded(false);
    setError("");
    setRestart((value) => value + 1);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: restart explicitly replays retained history.
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const page = await client.events(sessionId, cursor.current, 100, controller.signal);
        if (controller.signal.aborted) return;
        cursor.current = page.nextCursor;
        setEvents((previous) => mergeParticipantEvents(previous, page.events));
        setGap((previous) => previous || page.gap);
        setCatchingUp(page.hasMore);
        setError("");
        setLoaded(true);
        timer = setTimeout(poll, page.hasMore ? 500 : 2000);
      } catch (cause) {
        if (controller.signal.aborted) return;
        // Remove previously fetched private content when access fails; retry is explicit.
        setEvents([]);
        setError(cause instanceof Error ? cause.message : "Could not load participant output");
        setCatchingUp(false);
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, sessionId, active, restart]);
  return { events, gap, error, loaded, catchingUp, replay };
}
