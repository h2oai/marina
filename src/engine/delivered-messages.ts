// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Messages Marina delivered to each entity, by ref, so a client may name the
 * one it is answering (`cause` on a WebSocket command, used by the attention
 * bridge's final-reply relay — src/routing/attention-bridge.ts).
 *
 * A cause is a claim made by a client, so it is bounded the same way request
 * traces are (src/engine/trace-context.ts): only a ref Marina delivered to
 * this entity is accepted, and its depth is the depth Marina recorded, never
 * the client's. A forged or unknown ref is dropped and the command runs with
 * no cause (depth 0).
 */

import type { Perception } from "../types";
import type { MessageCause } from "./gate-context";
import { normalizeCause } from "./message-envelope";

const delivered = new Map<string, Map<string, number>>();
/** Refs remembered per entity, newest last. */
export const DELIVERED_MESSAGES_PER_ENTITY = 512;

/** Record the message ref a perception carries as delivered to `target`. */
export function rememberDeliveredMessage(target: string, perception: Perception): void {
  const data = perception.data;
  const ref = data?.messageRef;
  // A sender's own echo of what it sent (`delivery`) is not a message it received.
  if (typeof ref !== "string" || data.delivery !== undefined) return;
  const depth = typeof data.depth === "number" ? data.depth : 0;
  if (!normalizeCause({ ref, depth })) return;
  let seen = delivered.get(target);
  if (!seen) {
    seen = new Map();
    delivered.set(target, seen);
  }
  seen.delete(ref);
  seen.set(ref, depth);
  while (seen.size > DELIVERED_MESSAGES_PER_ENTITY) {
    const oldest = seen.keys().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
}

/** The cause for `ref` when Marina delivered it to this entity, else undefined. */
export function ownedMessageCause(entityId: string, ref: unknown): MessageCause | undefined {
  if (typeof ref !== "string") return undefined;
  const depth = delivered.get(entityId)?.get(ref);
  return depth === undefined ? undefined : { ref, depth };
}

/** Forget an entity's delivered refs once it is removed (`EntityManager.remove`). */
export function forgetDeliveredMessages(entityId: string): void {
  delivered.delete(entityId);
}

/** Test seam. */
export function resetDeliveredMessagesForTests(): void {
  delivered.clear();
}
