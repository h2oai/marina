// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { parseMessage } from "../../hooks/use-entity-activity";
import type { DashboardEvent } from "../../lib/types";

/** Kinds of messages that stay in the room they were spoken in. */
const IN_ROOM_KINDS: ReadonlySet<string> = new Set(["say", "emote"]);

/** How long a room-message pill is considered fresh. */
export const ROOM_MESSAGE_LIFETIME_MS = 6000;

export interface RoomMessage {
  /** The kind drives the pill color. */
  kind: "say" | "emote" | "tell";
  /** Resolved sender name (entity id resolved upstream). */
  sender: string;
  /** A tell's recipient. */
  recipient?: string;
  /**
   * Parsed body text without the verb prefix. Empty for the typed message
   * envelopes (`say_sent` / `tell_sent`), which never carry words.
   */
  body: string;
  /** Reply depth from the message envelope: 0 starts a thread, N answers N hops in. */
  depth?: number;
  timestamp: number;
}

/**
 * Pick the newest in-room message per room from the WS event feed.
 *
 * In-room kinds are `say` and `emote` — utterances whose audience is
 * everyone currently in the same room. Cross-room kinds (`tell`, `shout`,
 * `broadcast`) are rendered on arcs instead. Expired messages (older
 * than `lifetimeMs`) are dropped so the map breathes with the
 * conversation rather than accumulating stale text.
 *
 * The event feed is newest-first, so a single scan with "write if
 * missing" gives us the newest-per-room in one pass. Sender is already
 * the resolved entity name here — the DashboardEvent's `entity` field
 * is the id, and the caller must resolve it before we run.
 */
export function latestRoomMessages(
  events: readonly DashboardEvent[],
  resolveEntityName: (id: string) => string | undefined,
  now: number,
  lifetimeMs: number = ROOM_MESSAGE_LIFETIME_MS,
  roomOf?: (name: string) => string | undefined,
): Record<string, RoomMessage> {
  const out: Record<string, RoomMessage> = {};
  const cutoff = now - lifetimeMs;

  for (const event of events) {
    if (event.timestamp < cutoff) break; // newest-first — nothing older qualifies
    const envelope = messageEnvelope(event, roomOf);
    if (envelope) {
      if (!out[envelope.room]) out[envelope.room] = envelope.message;
      continue;
    }
    if (!IN_ROOM_KINDS.has(event.type)) continue;
    if (!event.room || !event.entity) continue;
    if (out[event.room]) continue; // already have a newer one for this room

    const { body } = parseMessage(event.type, event.input);
    if (!body) continue;
    const sender = resolveEntityName(event.entity) ?? event.entity;

    out[event.room] = {
      kind: event.type as "say" | "emote",
      sender,
      body,
      timestamp: event.timestamp,
    };
  }

  return out;
}

/**
 * A typed, content-free message envelope as a room message: `say_sent` in its
 * room, a `tell_sent` in the sender's room when both parties share it (a tell
 * across rooms is drawn as an arc instead). Names and depth only, no words.
 */
function messageEnvelope(
  event: DashboardEvent,
  roomOf?: (name: string) => string | undefined,
): { room: string; message: RoomMessage } | null {
  if (event.type === "say_sent" && event.from && event.room)
    return {
      room: event.room,
      message: {
        kind: "say",
        sender: event.from,
        body: "",
        depth: event.depth ?? 0,
        timestamp: event.timestamp,
      },
    };
  if (event.type === "tell_sent" && event.from && event.to && roomOf) {
    const room = roomOf(event.from);
    if (!room || room !== roomOf(event.to)) return null;
    return {
      room,
      message: {
        kind: "tell",
        sender: event.from,
        recipient: event.to,
        body: "",
        depth: event.depth ?? 0,
        timestamp: event.timestamp,
      },
    };
  }
  return null;
}

/** True if any room-message in the map is still within its lifetime window. */
export function hasLiveRoomMessage(
  messages: Record<string, RoomMessage>,
  now: number,
  lifetimeMs: number = ROOM_MESSAGE_LIFETIME_MS,
): boolean {
  const cutoff = now - lifetimeMs;
  for (const key in messages) {
    if (messages[key]!.timestamp > cutoff) return true;
  }
  return false;
}

/**
 * Structural equality for two room-message maps — same rooms, each with the
 * same message timestamp/kind/sender/body. Lets a derived-state hook keep the
 * previous object (and skip a re-render) when a feed update carried nothing
 * new for the pills.
 */
export function sameRoomMessages(
  a: Record<string, RoomMessage>,
  b: Record<string, RoomMessage>,
): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) {
    const x = a[key];
    const y = b[key];
    if (!y || !x) return false;
    if (x.timestamp !== y.timestamp || x.kind !== y.kind) return false;
    if (x.sender !== y.sender || x.body !== y.body) return false;
    if (x.recipient !== y.recipient || x.depth !== y.depth) return false;
  }
  return true;
}

export const PILL_FADE_HOLD = 0.65; // portion of lifetime before fade starts

/** Opacity keyframes for a pill whose message is `ageMs` old: hold at full
 *  opacity until PILL_FADE_HOLD of the lifetime, then fade linearly to 0.
 *  Returns null once the message has outlived ROOM_MESSAGE_LIFETIME_MS. */
export function pillFade(
  ageMs: number,
): { remainingMs: number; opacity: number[]; times: number[] } | null {
  const age = Math.max(0, ageMs);
  const remainingMs = ROOM_MESSAGE_LIFETIME_MS - age;
  if (remainingMs <= 0) return null;
  const holdEnd = ROOM_MESSAGE_LIFETIME_MS * PILL_FADE_HOLD;
  if (age < holdEnd) {
    return { remainingMs, opacity: [1, 1, 0], times: [0, (holdEnd - age) / remainingMs, 1] };
  }
  const t = age / ROOM_MESSAGE_LIFETIME_MS;
  const start = Math.max(0, 1 - (t - PILL_FADE_HOLD) / (1 - PILL_FADE_HOLD));
  return { remainingMs, opacity: [start, 0], times: [0, 1] };
}
