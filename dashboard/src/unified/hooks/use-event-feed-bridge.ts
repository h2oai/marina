// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Non-reactive bridges from the world-state `eventFeed` into the unified
 * canvas.
 *
 * PERFORMANCE CONTRACT: nothing here calls `useWorldState((s) => s.eventFeed)`.
 * The store replaces that 200-item array on every WebSocket event, and a
 * reactive selector re-rendered the whole ~2,900-line UnifiedCanvas per event.
 * Both hooks read the feed imperatively (`getState()`) and attach a
 * non-rendering `subscribe` listener — the pattern WorldMap.tsx documents —
 * so the canvas only re-renders when something it actually displays changes
 * (a fresh in-room message pill), never for the feed array identity alone.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { parseMessage } from "../../hooks/use-entity-activity";
import { useWorldState } from "../../hooks/use-world-state";
import type { DashboardEvent, WorldSnapshot } from "../../lib/types";
import { latestRoomMessages, type RoomMessage, sameRoomMessages } from "../lib/room-messages";

type InteractionKind =
  | "say"
  | "tell"
  | "shout"
  | "emote"
  | "broadcast"
  | "connect"
  | "disconnect"
  | "command";

export type AddInteraction = (
  from: string,
  to: string,
  kind: InteractionKind,
  fromRoom?: string,
  toRoom?: string,
  meta?: { body?: string; recipient?: string },
) => void;

export type LogActivity = (entity: string, room: string, type: string) => void;

/**
 * Project new feed events into the activity store and the interaction-arc
 * store. Processes each event once (by timestamp watermark), reads the
 * current entity roster through a ref so a roster change never re-subscribes,
 * and re-renders NOTHING — both targets are external stores.
 */
export function useEventFeedActivity(
  logActivity: LogActivity,
  addInteraction: AddInteraction,
  entities: WorldSnapshot["entities"],
): void {
  const entitiesRef = useRef(entities);
  entitiesRef.current = entities;
  const lastProcessedRef = useRef(0);

  useEffect(() => {
    const process = (eventFeed: DashboardEvent[]) => {
      if (eventFeed.length === 0) return;
      const entities = entitiesRef.current;
      const newEvents = eventFeed.filter((e) => e.timestamp > lastProcessedRef.current);
      for (const event of newEvents) {
        if (event.entity && event.room) {
          logActivity(event.entity, event.room, event.type);
        }

        // Dashboard events drive visual activity (arcs, metrics) but NOT the
        // command shell — the shell only shows the user's own commands and
        // server responses via the game WebSocket perception handler.

        // ── Create visual interaction arcs for all event types ────────
        if (event.entity && event.room) {
          if (event.type === "say") {
            // Say reaches everyone in the same room. The arc carries the
            // actual utterance so the map shows what was said, not just
            // that something was said.
            const { body } = parseMessage("say", event.input);
            const roomEntities = entities.filter(
              (e) => e.room === event.room && e.name !== event.entity,
            );
            for (const target of roomEntities.slice(0, 3)) {
              addInteraction(event.entity, target.name, "say", undefined, undefined, { body });
            }
          } else if (event.type === "tell" && event.input) {
            const { body, recipient } = parseMessage("tell", event.input);
            if (recipient) {
              addInteraction(event.entity, recipient, "tell", undefined, undefined, {
                body,
                recipient,
              });
            }
          } else if (event.type === "shout") {
            const { body } = parseMessage("shout", event.input);
            const nearbyEntities = entities.filter(
              (e) => e.name !== event.entity && e.room !== event.room,
            );
            for (const target of nearbyEntities.slice(0, 4)) {
              addInteraction(event.entity, target.name, "shout", undefined, undefined, { body });
            }
          } else if (event.type === "emote") {
            const { body } = parseMessage("emote", event.input);
            const roomEntities = entities.filter(
              (e) => e.room === event.room && e.name !== event.entity,
            );
            for (const target of roomEntities.slice(0, 2)) {
              addInteraction(event.entity, target.name, "emote", undefined, undefined, { body });
            }
          } else if (event.type === "broadcast") {
            const { body } = parseMessage("broadcast", event.input);
            const others = entities.filter((e) => e.name !== event.entity);
            for (const target of others.slice(0, 5)) {
              addInteraction(event.entity, target.name, "broadcast", undefined, undefined, {
                body,
              });
            }
          } else if (event.type === "connect" && event.entity) {
            // Connect: show arc from entity to their room. Transport-level
            // connects carry no entity (and are dropped server-side); only
            // render an interaction when one is actually present.
            addInteraction(event.entity, event.entity, "connect", undefined, event.room);
          } else if (event.type === "disconnect" && event.entity) {
            addInteraction(event.entity, event.entity, "disconnect", event.room, undefined);
          } else if (
            event.type === "command" &&
            event.input &&
            !event.input.startsWith("look") &&
            !event.input.startsWith("brief")
          ) {
            // Non-trivial commands — show the entity doing something
            const roomEntities = entities.filter(
              (e) => e.room === event.room && e.name !== event.entity,
            );
            if (roomEntities.length > 0) {
              addInteraction(event.entity, roomEntities[0]!.name, "command");
            }
          }
        }
      }
      if (newEvents.length > 0) {
        lastProcessedRef.current = newEvents[0]!.timestamp;
      }
    };

    process(useWorldState.getState().eventFeed);
    return useWorldState.subscribe((state, prev) => {
      if (state.eventFeed !== prev.eventFeed) process(state.eventFeed);
    });
  }, [logActivity, addInteraction]);
}

/**
 * Per-room latest in-room message (say / emote), derived from the feed
 * without a reactive selector. Recomputes on a batched rAF after feed
 * changes and, while any pill is live, every 300 ms so expired pills fade;
 * state only updates when the derived map actually differs.
 */
export function useLatestRoomMessages(
  resolveEntityName: (id: string) => string | undefined,
): Record<string, RoomMessage> {
  const resolveRef = useRef(resolveEntityName);
  resolveRef.current = resolveEntityName;
  const [latest, setLatest] = useState<Record<string, RoomMessage>>({});
  // Compare against a ref BEFORE calling setState: `setState(prev => prev)`
  // still schedules a (bail-out) render of the host component, and the host
  // here is the ~2,900-line canvas — an unrelated event must schedule nothing.
  const latestRef = useRef(latest);

  const recompute = useCallback(() => {
    const next = latestRoomMessages(
      useWorldState.getState().eventFeed,
      resolveRef.current,
      Date.now(),
    );
    if (sameRoomMessages(latestRef.current, next)) return;
    latestRef.current = next;
    setLatest(next);
  }, []);

  useEffect(() => {
    // `pending` (not the rAF id) is the guard: a synchronous rAF (tests) would
    // otherwise run the callback before the id is assigned and wedge the gate.
    let pending = false;
    let frame = 0;
    recompute();
    const unsubscribe = useWorldState.subscribe((state, prev) => {
      if (state.eventFeed === prev.eventFeed || pending) return;
      pending = true;
      frame = requestAnimationFrame(() => {
        pending = false;
        recompute();
      });
    });
    return () => {
      unsubscribe();
      if (pending) cancelAnimationFrame(frame);
    };
  }, [recompute]);

  // Freshness tick so pills fade naturally; only while something is live.
  const anyLive = Object.keys(latest).length > 0;
  useEffect(() => {
    if (!anyLive) return;
    const interval = setInterval(recompute, 300);
    return () => clearInterval(interval);
  }, [anyLive, recompute]);

  return latest;
}
