// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The causal envelope of every conversational message (`say`, `tell`, `re`,
 * `shout`, channel posts): a `cause` — the ref of the delivered message the
 * sender is answering — and a `depth` — the cause's depth + 1, or 0 when the
 * cause is unknown.
 *
 * Where the cause comes from (in this order):
 *  1. An explicit reply names it: `re` answers the tell it replies to.
 *  2. The command execution carries it: an ingress that knows which delivered
 *     message woke the input passes `CommandExecutionOptions.cause`, and every
 *     message the command (or a macro/`batch` expansion inside it) sends
 *     records that cause. The frame lives in `gate-context.ts`.
 *  3. Otherwise there is none: the message starts a thread at depth 0. A
 *     remote client's turn is opaque to the server, so its messages are depth
 *     0 unless it uses an explicit reply form.
 *  4. Except a `tell` between two agents: with no named cause it continues
 *     the pair's conversation (`deliverTell`, `src/engine/commands/tell.ts`)
 *     — one deeper than the other side's latest tell, the cause left unset —
 *     so attention can bound agent-only reply chains. A person's tell is
 *     always depth 0 and resets the chain.
 *
 * The envelope holds refs and numbers only, never message content.
 *
 * Message refs: `tell:<id>` (direct messages), `channel_msg:<id>` (channel
 * posts, the feed's existing ref), `say:<uuid>` / `shout:<uuid>` (unstored
 * room speech).
 */

import { getCurrentMessageCause, type MessageCause } from "./gate-context";

export type { MessageCause } from "./gate-context";

/** The envelope recorded on a stored message and carried on its perceptions. */
export interface MessageEnvelope {
  cause?: string;
  depth: number;
}

const REF = /^(tell|channel_msg|say|shout):[A-Za-z0-9-]{1,64}$/;

/** A well-formed cause, or undefined: refs are short and typed, depths finite. */
export function normalizeCause(cause: MessageCause | undefined): MessageCause | undefined {
  if (!cause || typeof cause.ref !== "string" || !REF.test(cause.ref)) return undefined;
  const depth = Number.isFinite(cause.depth) ? Math.max(0, Math.floor(cause.depth)) : 0;
  return { ref: cause.ref, depth };
}

/** The envelope of a message caused by `cause` (depth + 1), or a fresh one (depth 0). */
export function envelopeFor(cause: MessageCause | undefined): MessageEnvelope {
  const valid = normalizeCause(cause);
  return valid ? { cause: valid.ref, depth: valid.depth + 1 } : { depth: 0 };
}

/**
 * The envelope of a message `entityId` sends now: the explicit cause when the
 * send path names one, else the cause of the command execution running now.
 */
export function messageEnvelope(entityId: string, explicit?: MessageCause): MessageEnvelope {
  return envelopeFor(explicit ?? getCurrentMessageCause(entityId));
}

/** A fresh ref for a message that is not stored (room speech). */
export function mintMessageRef(kind: "say" | "shout"): string {
  return `${kind}:${crypto.randomUUID()}`;
}

/** Perception/event fields for an envelope: `cause` only when there is one. */
export function envelopeFields(envelope: MessageEnvelope): { cause?: string; depth: number } {
  return envelope.cause
    ? { cause: envelope.cause, depth: envelope.depth }
    : { depth: envelope.depth };
}
