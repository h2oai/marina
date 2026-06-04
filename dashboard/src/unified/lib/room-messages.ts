import { parseMessage } from "../../hooks/use-entity-activity";
import type { DashboardEvent } from "../../lib/types";

/** Kinds of messages that stay in the room they were spoken in. */
const IN_ROOM_KINDS: ReadonlySet<string> = new Set(["say", "emote"]);

/** How long a room-message pill is considered fresh. */
export const ROOM_MESSAGE_LIFETIME_MS = 6000;

export interface RoomMessage {
  /** The kind drives the pill color. */
  kind: "say" | "emote";
  /** Resolved sender name (entity id resolved upstream). */
  sender: string;
  /** Parsed body text without the verb prefix. */
  body: string;
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
): Record<string, RoomMessage> {
  const out: Record<string, RoomMessage> = {};
  const cutoff = now - lifetimeMs;

  for (const event of events) {
    if (event.timestamp < cutoff) break; // newest-first — nothing older qualifies
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
