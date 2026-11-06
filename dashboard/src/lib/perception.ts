// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { StoredPerception } from "../hooks/use-chat-state";

/**
 * Shared parser for chat/world perceptions. Extracted so WebChat (rich
 * rendering) and ConversationInsights (speaker stats) read from one source of
 * truth instead of two drifting regex copies. Parsing prefers the structured
 * perception `data` where available and falls back to the ANSI-stripped text.
 */

export interface SpeechMeta {
  speaker?: string;
  body: string;
  perspective: "self" | "other";
  channel?: string;
  tone?: "emote" | "shout" | "broadcast";
}

const SPEECH_TONES: Record<string, SpeechMeta["tone"]> = {
  shout: "shout",
  emote: "emote",
  broadcast: "broadcast",
};

/** Speech from the perception's own fields: another's message, or your own echo. */
function structuredSpeech(
  tag: string | undefined,
  data: Record<string, unknown> | undefined,
): SpeechMeta | null {
  if (!data) return null;
  const tone = SPEECH_TONES[tag ?? ""];
  const channel = typeof data.channel === "string" ? data.channel : undefined;
  const body =
    typeof data.message === "string"
      ? data.message
      : typeof data.content === "string"
        ? data.content
        : undefined;
  if (typeof data.senderName === "string" && body !== undefined && tag !== "emote") {
    return {
      speaker: data.senderName,
      body,
      perspective: data.senderName === "You" ? "self" : "other",
      ...(channel ? { channel } : {}),
      ...(tone ? { tone } : {}),
    };
  }
  const delivery = data.delivery as
    | { kind?: unknown; target?: unknown; message?: unknown }
    | undefined;
  if (delivery && typeof delivery.message === "string" && typeof delivery.kind === "string") {
    const target = typeof delivery.target === "string" ? delivery.target : undefined;
    if (delivery.kind === "tell")
      return { speaker: target, body: delivery.message, perspective: "self" };
    if (delivery.kind === "channel")
      return {
        speaker: "You",
        body: delivery.message,
        perspective: "self",
        ...(target ? { channel: target } : {}),
      };
    if (delivery.kind === "say" || delivery.kind === "shout")
      return {
        speaker: "You",
        body: delivery.message,
        perspective: "self",
        ...(delivery.kind === "shout" ? { tone: "shout" as const } : {}),
      };
  }
  return null;
}

export function parseSpeech(
  text: string | undefined,
  tag: string | undefined,
  perception?: StoredPerception,
): SpeechMeta | null {
  const data = perception?.data as Record<string, unknown> | undefined;
  // The server's structured fields first: they hold the body exactly as
  // written, line breaks included, which the text forms below cannot.
  const structured = structuredSpeech(tag, data);
  if (structured) return structured;
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (tag === "say") {
    const youMatch = trimmed.match(/^You say:\s*([\s\S]+)$/);
    if (youMatch) {
      return { speaker: "You", body: youMatch[1]!, perspective: "self" };
    }
    const otherMatch = trimmed.match(/^(.+?) says:\s*([\s\S]+)$/);
    if (otherMatch) {
      return { speaker: otherMatch[1]!, body: otherMatch[2]!, perspective: "other" };
    }
  }

  if (tag === "tell") {
    const fromMatch = trimmed.match(/^>\s+(.+?) tells you:\s*([\s\S]+)$/);
    if (fromMatch) {
      return { speaker: fromMatch[1]!, body: fromMatch[2]!, perspective: "other" };
    }
    const toMatch = trimmed.match(/^>\s+You tell (.+?):\s*([\s\S]+)$/);
    if (toMatch) {
      return { speaker: toMatch[1]!, body: toMatch[2]!, perspective: "self" };
    }
  }

  if (tag === "shout") {
    const selfMatch = trimmed.match(/^You shout:\s*([\s\S]+)$/i);
    if (selfMatch) {
      return { speaker: "You", body: selfMatch[1]!, perspective: "self", tone: "shout" };
    }
    const otherMatch = trimmed.match(/^(.+?) shouts:\s*([\s\S]+)$/i);
    if (otherMatch) {
      return { speaker: otherMatch[1]!, body: otherMatch[2]!, perspective: "other", tone: "shout" };
    }
  }

  if (tag === "emote") {
    const emoteMatch = trimmed.match(/^\*\s*([\s\S]+)$/);
    if (emoteMatch) {
      return { body: emoteMatch[1]!, perspective: "other", tone: "emote" };
    }
  }

  const channel = data && typeof data.channel === "string" ? (data.channel as string) : undefined;
  if (channel) {
    const sender =
      data && typeof data.senderName === "string" ? (data.senderName as string) : undefined;
    const content = data && typeof data.content === "string" ? (data.content as string) : trimmed;
    return {
      speaker: sender,
      body: content,
      perspective: sender === "You" ? "self" : "other",
      channel,
    };
  }

  if (perception?.kind === "broadcast") {
    return { body: trimmed, perspective: "other", tone: "broadcast" };
  }

  return { body: trimmed, perspective: "other" };
}

/**
 * Resolve the speaker name to attribute a message to, for "lead voices"
 * counting. Scoped to first-person/direct-address tags (say/tell/shout/emote)
 * plus the synthetic say-self/broadcast tags; returns null for anything else
 * (e.g. room text, command output) so non-dialogue lines aren't miscounted.
 */
export function speakerName(
  text: string | undefined,
  tag: string | undefined,
  perception?: StoredPerception,
): string | null {
  if (tag === "say-self") return "You";
  if (tag === "broadcast") return "System";
  if (tag === "emote") {
    const m = text?.trim().match(/^\*\s*(.+?)\b/);
    return m ? (m[1] ?? null) : null;
  }
  if (tag === "say" || tag === "tell" || tag === "shout") {
    const meta = parseSpeech(text, tag, perception);
    if (!meta) return null;
    // parseSpeech reports the recipient as `speaker` for an outbound tell
    // (perspective "self"); for "who spoke" counting that's the local user.
    return meta.perspective === "self" ? "You" : (meta.speaker ?? null);
  }
  return null;
}
