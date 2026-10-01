// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Who worked on a benchmark item: the agents (and models) behind one model-API
 * request, resolved from the engine's trace and event log.
 *
 * Every model-API request mints `{runId, traceId, spanId}` with
 * `traceId === requestId` and returns it as `x-request-id`; the harness records
 * that id per item. Two kinds of evidence exist, and each participant says which
 * one put it there (`via`):
 *
 * - `trace` — an `agent_turn_end` carrying the request's traceId. Only the agent
 *   that received the `model_request` perception inherits the trace
 *   (`traceParentFromPerception`), so this names the answering agent with its
 *   model and cost exactly. A passthru request is one traced model call: the
 *   participant is the upstream model itself.
 * - `window` — turns of the routed agent's crew-mates that ended inside the
 *   request's received→completed window and carry no trace of their own.
 *   Delegation (tells, crew channel) does not propagate the trace, so this is
 *   the best available evidence — and it is only exclusive when no other
 *   request to the same crew overlapped the window. When one did, those
 *   participants are marked `shared: true` and their cost is NOT charged to
 *   the item.
 *
 * An item whose request left no lifecycle events (pruned event log, a direct
 * provider call that never touched Marina) resolves to `attribution: "none"`.
 */

import type { EngineEvent } from "../types";

type Lifecycle = Extract<EngineEvent, { type: "model_request_lifecycle" }>;

/**
 * How far either side of a window to look for overlapping requests: longer
 * than the model-API request timeout, so a request that spans the whole window
 * is still found.
 */
export const OVERLAP_PAD_MS = 30 * 60_000;

export interface ResolvedParticipant {
  agent?: string;
  model?: string;
  via: "trace" | "window";
  turns: number;
  costUsd?: number;
  /** Window evidence shared with an overlapping request: not exclusive, cost not charged. */
  shared?: boolean;
}

export type AttributionKind = "trace" | "trace+window" | "window" | "none";

export interface ItemAttribution {
  attribution: AttributionKind;
  participants: ResolvedParticipant[];
  /** Cost charged to the item: traced turns plus exclusive window turns (null if none priced). */
  costUsd: number | null;
  /** Other requests to the same crew whose windows overlapped this one. */
  overlapping: number;
  target?: string;
  routeKind?: Lifecycle["routeKind"];
}

export interface AttributionInput {
  traceId: string;
  /** Events carrying this traceId (lifecycle + agent spans). */
  traceEvents: readonly EngineEvent[];
  /** `agent_turn_end` events inside the request window. */
  windowTurns: readonly EngineEvent[];
  /**
   * `model_request_lifecycle` events of OTHER requests near the window (padded
   * by `OVERLAP_PAD_MS` each side, so a request that started before and ended
   * after this one is still seen); overlap is decided on their intervals.
   */
  nearbyRequests: readonly EngineEvent[];
  /** Crew-mates of an agent (including itself), or undefined when it is in no crew. */
  crewOf: (agent: string) => readonly string[] | undefined;
}

interface Acc {
  agent?: string;
  model?: string;
  via: "trace" | "window";
  turns: number;
  cost: number;
  priced: boolean;
  shared: boolean;
}

/** The request window from its lifecycle events, or undefined when it has none. */
export function requestWindow(
  traceEvents: readonly EngineEvent[],
): { from: number; to: number; target?: string; routeKind?: Lifecycle["routeKind"] } | undefined {
  const lifecycle = traceEvents.filter((e): e is Lifecycle => e.type === "model_request_lifecycle");
  if (lifecycle.length === 0) return undefined;
  const from = Math.min(...lifecycle.map((e) => e.timestamp));
  const end = lifecycle.find((e) => e.phase === "completed" || e.phase === "failed");
  const to = end?.timestamp ?? Math.max(...lifecycle.map((e) => e.timestamp));
  const routed = lifecycle.find((e) => e.target !== undefined);
  const responder = lifecycle.find((e) => e.respondedBy !== undefined)?.respondedBy;
  const kind = lifecycle.find((e) => e.routeKind !== undefined)?.routeKind;
  return {
    from,
    to,
    ...(responder || routed?.target ? { target: responder ?? routed?.target } : {}),
    ...(kind ? { routeKind: kind } : {}),
  };
}

/** Resolve one request's participants. Pure: the caller supplies the events. */
export function attributeRequest(input: AttributionInput): ItemAttribution {
  const window = requestWindow(input.traceEvents);
  if (!window) return { attribution: "none", participants: [], costUsd: null, overlapping: 0 };

  const acc = new Map<string, Acc>();
  const add = (key: string, p: Omit<Acc, "turns" | "cost" | "priced">, cost?: number) => {
    const e = acc.get(key) ?? { ...p, turns: 0, cost: 0, priced: false };
    e.turns++;
    if (typeof cost === "number") {
      e.cost += cost;
      e.priced = true;
    }
    if (!e.model && p.model) e.model = p.model;
    acc.set(key, e);
  };

  // Traced turns: exact.
  for (const e of input.traceEvents) {
    if (e.type !== "agent_turn_end" || e.traceId !== input.traceId) continue;
    add(
      `trace:${e.name}`,
      { agent: e.name, model: e.model, via: "trace", shared: false },
      e.costUsd,
    );
  }
  // A passthru request is a single traced model call: the upstream model participated.
  if (acc.size === 0 && window.routeKind === "passthru" && window.target) {
    acc.set(`trace:model:${window.target}`, {
      model: window.target,
      via: "trace",
      turns: 1,
      cost: 0,
      priced: false,
      shared: false,
    });
  }

  // Window evidence: the routed agent's crew-mates, untraced turns only.
  const crew = window.target ? input.crewOf(window.target) : undefined;
  let overlapping = 0;
  if (crew && crew.length > 0) {
    const members = new Set(crew);
    const spans = new Map<string, { from: number; to: number; crew: boolean }>();
    for (const e of input.nearbyRequests) {
      if (e.type !== "model_request_lifecycle") continue;
      if (!e.traceId || e.traceId === input.traceId) continue;
      const s = spans.get(e.traceId) ?? { from: e.timestamp, to: e.timestamp, crew: false };
      s.from = Math.min(s.from, e.timestamp);
      s.to = Math.max(s.to, e.timestamp);
      if ((e.target && members.has(e.target)) || (e.respondedBy && members.has(e.respondedBy))) {
        s.crew = true;
      }
      spans.set(e.traceId, s);
    }
    for (const s of spans.values()) {
      if (s.crew && s.from <= window.to && s.to >= window.from) overlapping++;
    }
    const shared = overlapping > 0;
    for (const e of input.windowTurns) {
      if (e.type !== "agent_turn_end" || !members.has(e.name)) continue;
      if (e.timestamp < window.from || e.timestamp > window.to) continue;
      if (e.traceId) continue; // its own (possibly another request's) trace — not window evidence
      if (acc.has(`trace:${e.name}`)) {
        // Already a traced participant: its untraced turns in the window are the
        // same agent's follow-up work for this crew; count them only if exclusive.
        if (!shared) add(`trace:${e.name}`, { agent: e.name, via: "trace", shared }, e.costUsd);
        continue;
      }
      add(`window:${e.name}`, { agent: e.name, model: e.model, via: "window", shared }, e.costUsd);
    }
  }

  const participants: ResolvedParticipant[] = [...acc.values()].map((e) => ({
    ...(e.agent ? { agent: e.agent } : {}),
    ...(e.model ? { model: e.model } : {}),
    via: e.via,
    turns: e.turns,
    ...(e.priced ? { costUsd: e.cost } : {}),
    ...(e.shared ? { shared: true } : {}),
  }));
  const traced = participants.some((p) => p.via === "trace");
  const windowed = participants.some((p) => p.via === "window");
  const attribution: AttributionKind = traced
    ? windowed
      ? "trace+window"
      : "trace"
    : windowed
      ? "window"
      : "none";
  const charged = participants.filter((p) => !p.shared && typeof p.costUsd === "number");
  return {
    attribution,
    participants,
    costUsd: charged.length > 0 ? charged.reduce((s, p) => s + (p.costUsd as number), 0) : null,
    overlapping,
    ...(window.target ? { target: window.target } : {}),
    ...(window.routeKind ? { routeKind: window.routeKind } : {}),
  };
}

/** The store slice attribution reads. */
export interface ParticipantSource {
  getTraceEventsByTraceIds(traceIds: readonly string[]): EngineEvent[];
  getEventsBetween(
    types: readonly string[],
    fromTs: number,
    toTs: number,
    limit?: number,
  ): EngineEvent[];
  getAllCrews(): { id: string }[];
  getCrewMembers(crewId: string): { agent_name: string }[];
}

/** Resolve many request ids at once against the live store. */
export function resolveParticipants(
  db: ParticipantSource,
  traceIds: readonly string[],
): Map<string, ItemAttribution> {
  const out = new Map<string, ItemAttribution>();
  const ids = [...new Set(traceIds.filter((t) => typeof t === "string" && t.length > 0))];
  if (ids.length === 0) return out;

  const byTrace = new Map<string, EngineEvent[]>();
  for (const e of db.getTraceEventsByTraceIds(ids)) {
    const t = "traceId" in e ? e.traceId : undefined;
    if (!t) continue;
    const list = byTrace.get(t) ?? [];
    list.push(e);
    byTrace.set(t, list);
  }

  const crewByMember = new Map<string, string[]>();
  for (const crew of db.getAllCrews()) {
    const members = db.getCrewMembers(crew.id).map((m) => m.agent_name);
    for (const m of members) crewByMember.set(m, members);
  }
  const crewOf = (agent: string) => crewByMember.get(agent);

  for (const id of ids) {
    const traceEvents = byTrace.get(id) ?? [];
    const window = requestWindow(traceEvents);
    const windowTurns = window
      ? db.getEventsBetween(["agent_turn_end"], window.from, window.to, 20_000)
      : [];
    const nearbyRequests = window
      ? db.getEventsBetween(
          ["model_request_lifecycle"],
          window.from - OVERLAP_PAD_MS,
          window.to + OVERLAP_PAD_MS,
          20_000,
        )
      : [];
    out.set(
      id,
      attributeRequest({ traceId: id, traceEvents, windowTurns, nearbyRequests, crewOf }),
    );
  }
  return out;
}
