// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Who worked on a benchmark item: the agents (and models) behind one model-API
 * request, resolved from the engine's trace and event log.
 *
 * Every model-API request mints `{runId, traceId, spanId}` with
 * `traceId === requestId` and returns it as `x-request-id`; the harness records
 * that id per item. Each participant says which evidence put it there (`via`):
 *
 * - `trace` — an `agent_turn_end` serving the request's trace:
 *   - its own trace (the agent received the `model_request` while idle and
 *     the request parented the prompt), or
 *   - a span LINK to it (`links`): the request was steered into a prompt
 *     already running, the prompt served several requests at once, or the
 *     agent acted on work handed over from the request (a tell or crew post
 *     sent by an agent on it carries the trace — src/engine/trace-context.ts).
 *     Handoffs are transitive.
 *   A turn serving exactly one request is charged to it in full. A turn
 *   serving n requests is split: each gets 1/n of its cost, and the
 *   participant is marked `tracedShared` (evidence `traced-shared`).
 *   A passthru request is one traced model call: the participant is the
 *   upstream model itself.
 * - `window` — turns of the routed agent's crew-mates that ended inside the
 *   request's received→completed window and serve no request trace (neither
 *   their own nor a link). Only exclusive when no other request to the same
 *   crew overlapped the window; when one did, those participants are marked
 *   `shared: true` and their cost is NOT charged to the item.
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
  /**
   * Traced turns that served several requests at once (`traced-shared`):
   * each request was charged an equal split of their cost.
   */
  tracedShared?: boolean;
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
  /** `agent_turn_end` events that link this trace (span links). */
  linkedTurns?: readonly EngineEvent[];
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
  tracedShared?: boolean;
}

type TurnEnd = Extract<EngineEvent, { type: "agent_turn_end" }>;

/**
 * The request traces one turn served: its own (when a request parented it)
 * plus its links. An autonomous turn's own `agent-trace-…` id serves nothing.
 */
export function servedTraces(e: TurnEnd): Set<string> {
  const served = new Set<string>();
  const ownIsRequest =
    e.origin === "request" ||
    (e.origin === undefined && !!e.traceId && !e.traceId.startsWith("agent-trace-"));
  if (ownIsRequest && e.traceId) served.add(e.traceId);
  for (const l of e.links ?? []) served.add(l.traceId);
  return served;
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

  // Traced turns: the request's own spans and every turn linking it. A turn
  // serving n requests is charged 1/n to each.
  const seenTurns = new Set<string>();
  for (const e of [...input.traceEvents, ...(input.linkedTurns ?? [])]) {
    if (e.type !== "agent_turn_end") continue;
    const served = servedTraces(e);
    if (e.traceId === input.traceId) served.add(input.traceId);
    if (!served.has(input.traceId)) continue;
    const turnKey = `${e.name}:${e.spanId ?? e.timestamp}`;
    if (seenTurns.has(turnKey)) continue;
    seenTurns.add(turnKey);
    const split = served.size > 1;
    const cost = typeof e.costUsd === "number" ? e.costUsd / served.size : undefined;
    add(
      `${split ? "trace-shared" : "trace"}:${e.name}`,
      {
        agent: e.name,
        model: e.model,
        via: "trace",
        shared: false,
        ...(split ? { tracedShared: true } : {}),
      },
      cost,
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
      // A turn serving a request (its own trace or a link) is that request's
      // traced evidence — never window evidence. Autonomous turns always carry
      // their own `agent-trace-…` id, so the trace id alone decides nothing.
      if (servedTraces(e).size > 0) continue;
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
    ...(e.tracedShared ? { tracedShared: true } : {}),
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
  getTurnEndsLinkingTraceIds?(traceIds: readonly string[]): EngineEvent[];
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

  const wanted = new Set(ids);
  const linkedByTrace = new Map<string, EngineEvent[]>();
  for (const e of db.getTurnEndsLinkingTraceIds?.(ids) ?? []) {
    if (e.type !== "agent_turn_end") continue;
    for (const l of e.links ?? []) {
      if (!wanted.has(l.traceId)) continue;
      const list = linkedByTrace.get(l.traceId) ?? [];
      list.push(e);
      linkedByTrace.set(l.traceId, list);
    }
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
      attributeRequest({
        traceId: id,
        traceEvents,
        linkedTurns: linkedByTrace.get(id) ?? [],
        windowTurns,
        nearbyRequests,
        crewOf,
      }),
    );
  }
  return out;
}
