// Copyright 2025-2026 Marina Contributors
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

export function parseSpeech(
  text: string | undefined,
  tag: string | undefined,
  perception?: StoredPerception,
): SpeechMeta | null {
  const data = perception?.data as Record<string, unknown> | undefined;
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (tag === "say") {
    const youMatch = trimmed.match(/^You say:\s*(.+)$/);
    if (youMatch) {
      return { speaker: "You", body: youMatch[1]!, perspective: "self" };
    }
    const otherMatch = trimmed.match(/^(.+?) says:\s*(.+)$/);
    if (otherMatch) {
      return { speaker: otherMatch[1]!, body: otherMatch[2]!, perspective: "other" };
    }
  }

  if (tag === "tell") {
    const fromMatch = trimmed.match(/^>\s+(.+?) tells you:\s*(.+)$/);
    if (fromMatch) {
      return { speaker: fromMatch[1]!, body: fromMatch[2]!, perspective: "other" };
    }
    const toMatch = trimmed.match(/^>\s+You tell (.+?):\s*(.+)$/);
    if (toMatch) {
      return { speaker: toMatch[1]!, body: toMatch[2]!, perspective: "self" };
    }
  }

  if (tag === "shout") {
    const selfMatch = trimmed.match(/^You shout:\s*(.+)$/i);
    if (selfMatch) {
      return { speaker: "You", body: selfMatch[1]!, perspective: "self", tone: "shout" };
    }
    const otherMatch = trimmed.match(/^(.+?) shouts:\s*(.+)$/i);
    if (otherMatch) {
      return { speaker: otherMatch[1]!, body: otherMatch[2]!, perspective: "other", tone: "shout" };
    }
  }

  if (tag === "emote") {
    const emoteMatch = trimmed.match(/^\*\s*(.+)$/);
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
