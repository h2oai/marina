// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * What a reference in a message points to, as a short key a preview can
 * fetch: `task:12`, `channel:general`, `board:notes`, `post:general:3041`,
 * `tell:9`, or `any:12[:channel]` for a bare `#12`, which may name more than
 * one thing and is resolved by asking what exists. Keys come only from the
 * parsed message (`src/sdk/message-format.ts`) and the server's own channel
 * name, never from markup.
 */

import type { Span } from "../../../src/sdk/message-format";

export type ReferenceTarget =
  | { kind: "task"; id: number }
  | { kind: "channel"; name: string }
  | { kind: "board"; name: string }
  | { kind: "post"; channel: string; id: number }
  | { kind: "tell"; id: number }
  | { kind: "any"; id: number; channel?: string };

const NAME = /^[\w:-]{1,64}$/;

/** Where a reference is read: the channel a message was posted in, when known. */
export interface ReferenceContext {
  channel?: string;
}

/** The preview key for a span, or undefined when it has no preview. */
export function referenceKey(span: Span, context: ReferenceContext = {}): string | undefined {
  const channel = context.channel && NAME.test(context.channel) ? context.channel : undefined;
  if (span.kind === "channel") return NAME.test(span.name) ? `channel:${span.name}` : undefined;
  if (span.kind !== "ref" || !/^\d{1,9}$/.test(span.id)) return undefined;
  const [kind, name] = (span.refKind ?? "").split(" ");
  switch (kind) {
    case "task":
    case "tasks":
      return `task:${span.id}`;
    case "post":
    case "channel_msg":
      return channel ? `post:${channel}:${span.id}` : undefined;
    case "tell":
      return `tell:${span.id}`;
    case "board":
      return name && NAME.test(name) ? `board:${name}` : undefined;
    case "":
      return channel ? `any:${span.id}:${channel}` : `any:${span.id}`;
    default:
      return undefined;
  }
}

/** A key back to its target; undefined for anything malformed. */
export function parseReferenceKey(key: string): ReferenceTarget | undefined {
  const parts = key.split(":");
  const id = Number(parts[1]);
  const positive = Number.isSafeInteger(id) && id > 0;
  switch (parts[0]) {
    case "task":
      return parts.length === 2 && positive ? { kind: "task", id } : undefined;
    case "tell":
      return parts.length === 2 && positive ? { kind: "tell", id } : undefined;
    case "channel":
    case "board": {
      const name = parts.slice(1).join(":");
      return NAME.test(name) ? { kind: parts[0], name } : undefined;
    }
    case "post": {
      const postId = Number(parts.at(-1));
      const channel = parts.slice(1, -1).join(":");
      return NAME.test(channel) && Number.isSafeInteger(postId) && postId > 0
        ? { kind: "post", channel, id: postId }
        : undefined;
    }
    case "any": {
      if (!positive) return undefined;
      const channel = parts.slice(2).join(":");
      if (channel && !NAME.test(channel)) return undefined;
      return channel ? { kind: "any", id, channel } : { kind: "any", id };
    }
    default:
      return undefined;
  }
}

/** Where a click on the target opens in the dashboard (the inspector), when it has a page. */
export function referenceTargetHref(target: ReferenceTarget): string | undefined {
  switch (target.kind) {
    case "task":
      return `/dashboard?inspect=task:${target.id}`;
    case "channel":
      return `/dashboard?inspect=channel:${encodeURIComponent(target.name)}`;
    case "board":
      return `/dashboard?inspect=board:${encodeURIComponent(target.name)}`;
    case "post":
      return `/dashboard?inspect=channel:${encodeURIComponent(target.channel)}`;
    default:
      return undefined;
  }
}
