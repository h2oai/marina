// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Request-trace propagation across handoffs (span links).
 *
 * An agent working on a model request sends its commands with the request
 * traces its running prompt serves (`trace_links` on the WebSocket command).
 * The command executes inside `runWithTraceLinks()`, and every perception that
 * execution delivers to ANOTHER entity — a tell, a crew channel post, a task
 * notice — is stamped with those links (`data.traceLinks`). The recipient's
 * turns then link back to the original requests, transitively through further
 * handoffs, which is what benchmark participant attribution reads.
 *
 * Links are claims made by a client, so they are bounded: an entity may only
 * propagate a trace that Marina actually delivered to it (a `model_request`
 * perception carrying it, or a perception already stamped with it). A forged
 * link to a request the entity never saw is dropped.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { parseTraceLinks, traceParentFromPerception } from "../agent/execution-trace";
import type { Perception, TraceLink } from "../types";

interface TraceFrame {
  entityId: string;
  links: TraceLink[];
}

const frames = new AsyncLocalStorage<TraceFrame>();

/** Per entity: trace ids Marina delivered to it, newest last (bounded). */
const delivered = new Map<string, Map<string, TraceLink>>();
/** Traces remembered per entity — far more than one crew holds open at once. */
export const DELIVERED_TRACES_PER_ENTITY = 512;

/** Run `fn` with the request traces the calling entity's command serves. */
export function runWithTraceLinks<T>(
  entityId: string,
  links: readonly TraceLink[],
  fn: () => T,
): T {
  if (links.length === 0) return fn();
  return frames.run({ entityId, links: links.map((l) => ({ ...l })) }, fn);
}

/** Keep only the links whose trace Marina delivered to this entity. */
export function ownedTraceLinks(entityId: string, links: readonly TraceLink[]): TraceLink[] {
  const seen = delivered.get(entityId);
  if (!seen) return [];
  return links.filter((l) => seen.has(l.traceId)).map((l) => ({ ...l }));
}

function remember(entityId: string, links: readonly TraceLink[]): void {
  if (links.length === 0) return;
  let seen = delivered.get(entityId);
  if (!seen) {
    seen = new Map();
    delivered.set(entityId, seen);
  }
  for (const l of links) {
    seen.delete(l.traceId);
    seen.set(l.traceId, { traceId: l.traceId, spanId: l.spanId });
  }
  while (seen.size > DELIVERED_TRACES_PER_ENTITY) {
    const oldest = seen.keys().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
}

/** Every request trace a perception carries: a `model_request` body and stamped links. */
export function tracesInPerception(perception: Perception): TraceLink[] {
  const data = perception.data ?? {};
  const out = parseTraceLinks(data.traceLinks);
  for (const field of [data.text, data.content, data.message]) {
    if (typeof field !== "string") continue;
    const parent = traceParentFromPerception(field);
    if (parent && !out.some((l) => l.traceId === parent.traceId)) {
      out.push({ traceId: parent.traceId, spanId: parent.spanId });
    }
  }
  return out;
}

/**
 * The perception as delivered to `target`: stamped with the executing
 * command's links when it reaches another entity, and recorded as delivered
 * so the target may propagate those traces in turn.
 */
export function stampTraceLinks(target: string, perception: Perception): Perception {
  const frame = frames.getStore();
  let out = perception;
  if (frame && frame.entityId !== target && frame.links.length > 0) {
    const existing = parseTraceLinks(perception.data?.traceLinks);
    const merged = [...existing];
    for (const l of frame.links) {
      if (!merged.some((m) => m.traceId === l.traceId)) merged.push({ ...l });
    }
    out = { ...perception, data: { ...perception.data, traceLinks: merged } };
  }
  remember(target, tracesInPerception(out));
  return out;
}

/**
 * Forget an entity's delivered traces once it is removed (`EntityManager.remove`).
 * A transient disconnect keeps them, so a reconnecting entity can still propagate.
 */
export function forgetDeliveredTraces(entityId: string): void {
  delivered.delete(entityId);
}

/** Test seam. */
export function resetTraceContextForTests(): void {
  delivered.clear();
}
