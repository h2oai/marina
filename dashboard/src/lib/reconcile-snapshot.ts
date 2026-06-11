// Structural sharing for the 2-second world snapshot.
//
// The server resends the FULL world every snapshot, so a naive
// `entities: data.entities` hands every subscriber a brand-new array reference
// each tick — re-rendering the roster, world map, and canvas every 2s even when
// nothing changed. These helpers reuse the previous references whenever the
// user-visible content is identical, so zustand's reference comparison short-
// circuits the re-render. Only when something actually changed does a new
// reference flow through.
//
// `agentStatus.uptime` is deliberately excluded from the comparison: it advances
// every tick but is low-signal (rendered at minute granularity, only in the
// expanded agent panel). Freezing it between meaningful changes is the accepted
// trade-off for not re-rendering the world every 2s.

import type { AgentStatusInfo, WorldSnapshot } from "./types";

export type SnapshotEntity = WorldSnapshot["entities"][number];
export type SnapshotRoom = WorldSnapshot["rooms"][number];

function agentStatusEqual(a: AgentStatusInfo | undefined, b: AgentStatusInfo | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.state === b.state &&
    a.model === b.model &&
    a.role === b.role &&
    a.focus === b.focus &&
    a.toolCalls === b.toolCalls &&
    a.errors === b.errors &&
    a.errorReason === b.errorReason &&
    supportsEqual(a.supports, b.supports)
    // uptime intentionally omitted — see file header.
  );
}

function supportsEqual(a: AgentStatusInfo["supports"], b: AgentStatusInfo["supports"]): boolean {
  return (
    a.text === b.text &&
    Boolean(a.image) === Boolean(b.image) &&
    Boolean(a.video) === Boolean(b.video)
  );
}

function entityEqual(a: SnapshotEntity, b: SnapshotEntity): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.kind === b.kind &&
    a.room === b.room &&
    agentStatusEqual(a.agentStatus, b.agentStatus)
  );
}

function exitsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  for (const k of ak) if (a[k] !== b[k]) return false;
  return true;
}

function roomEqual(a: SnapshotRoom, b: SnapshotRoom): boolean {
  return (
    a.id === b.id &&
    a.short === b.short &&
    a.district === b.district &&
    exitsEqual(a.exits, b.exits)
  );
}

/**
 * Generic reconcile: returns `prev` unchanged if every item is content-equal AND
 * in the same order; otherwise returns a new array that reuses unchanged item
 * references (so memoized child rows still skip re-render). Items are matched by
 * id so reordering reuses refs.
 */
function reconcileList<T extends { id: string }>(
  prev: T[],
  next: T[],
  equal: (a: T, b: T) => boolean,
): T[] {
  const prevById = new Map(prev.map((p) => [p.id, p]));
  let changed = prev.length !== next.length;
  const out = next.map((n, i) => {
    const p = prevById.get(n.id);
    if (p && equal(p, n)) {
      if (prev[i] !== p) changed = true; // same content, different position
      return p; // reuse reference
    }
    changed = true;
    return n;
  });
  return changed ? out : prev;
}

export function reconcileEntities(
  prev: SnapshotEntity[],
  next: SnapshotEntity[],
): SnapshotEntity[] {
  return reconcileList(prev, next, entityEqual);
}

export function reconcileRooms(prev: SnapshotRoom[], next: SnapshotRoom[]): SnapshotRoom[] {
  return reconcileList(prev, next, roomEqual);
}

/** Returns `prev` if the two number maps are shallow-equal, else `next`. */
export function reconcileNumberRecord(
  prev: Record<string, number>,
  next: Record<string, number>,
): Record<string, number> {
  const pk = Object.keys(prev);
  if (pk.length !== Object.keys(next).length) return next;
  for (const k of pk) if (prev[k] !== next[k]) return next;
  return prev;
}
