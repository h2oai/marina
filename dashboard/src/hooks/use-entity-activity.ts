// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { create } from "zustand";
import type { DashboardEvent } from "../lib/types";

/**
 * Per-entity live activity — what an agent is thinking, saying, telling,
 * shouting, emoting, broadcasting. One store, one `kind` discriminator,
 * both dashboards read. This is the sink for the streaming delta events
 * (`agent_text_delta`, `agent_thinking_delta`) that previously had none,
 * plus message-bearing command events whose bodies were being dropped.
 *
 * Content over motion: components that render motion for these kinds
 * must carry the body or a snippet of it. Motion without information is
 * out of scope for the redesign.
 */
export type ActivityKind = "thought" | "text" | "say" | "tell" | "shout" | "emote" | "broadcast";

export interface ActivityItem {
  kind: ActivityKind;
  body: string;
  /** For `tell`: the recipient name. Undefined for broadcast kinds. */
  recipient?: string;
  /** For `say`/`shout`/`emote`: the room the utterance originated in. */
  room?: string;
  timestamp: number;
}

export interface StreamingBuffer {
  /** Accumulated `agent_thinking_delta` between turn_start and turn_end. */
  thought: string;
  /** Accumulated `agent_text_delta` between turn_start and turn_end. */
  text: string;
  turnStartedAt: number;
}

export const ACTIVITY_EVENT_TYPES = new Set([
  "agent_turn_start",
  "agent_turn_end",
  "agent_text_delta",
  "agent_thinking_delta",
  "agent_stop",
  "say",
  "tell",
  "shout",
  "emote",
  "broadcast",
]);

const MAX_RECENT_PER_ENTITY = 20;

interface EntityActivityState {
  /** Completed items per entity name, newest first, capped. */
  recent: Record<string, ActivityItem[]>;
  /** Currently streaming deltas per entity name. */
  streaming: Record<string, StreamingBuffer>;

  applyEvent: (event: DashboardEvent) => void;
  /** Drop all activity for an entity — called when an agent stops. */
  clearEntity: (name: string) => void;
  reset: () => void;
}

/**
 * Parse a message body out of a command-shaped event's `input` field.
 *
 * Tolerance policy:
 * - Raw input that's just the verb (or verb + whitespace) → empty body.
 *   The engine doesn't deliver bodyless commands in practice, but we
 *   drop defensively rather than storing "say" as a user-visible body.
 * - Raw input with no recognizable verb prefix → returned as-is. Don't
 *   silently drop real content just because the shape is unexpected.
 *
 * Exported so other consumers (e.g. ActivityFeed) extract bodies the
 * same way the store does — single source of truth for parsing.
 */
export function parseMessage(
  type: string,
  input: string | undefined,
): { body: string; recipient?: string } {
  const raw = input?.trim() ?? "";
  if (!raw) return { body: "" };

  if (type === "tell") {
    // Expected: "tell <target> <message...>"
    const match = raw.match(/^tell\s+(\S+)\s+(.+)$/i);
    if (match) return { recipient: match[1], body: match[2]!.trim() };
    // "tell" or "tell alice" with no body — drop.
    if (/^tell(\s+\S*)?$/i.test(raw)) return { body: "" };
    return { body: raw };
  }

  // Verb-only (possibly with trailing whitespace) — drop.
  if (new RegExp(`^${type}\\s*$`, "i").test(raw)) return { body: "" };
  // Verb with a body — strip the prefix.
  const prefix = new RegExp(`^${type}\\s+`, "i");
  if (prefix.test(raw)) return { body: raw.replace(prefix, "").trim() };
  // Unknown shape — tolerate and preserve the raw content.
  return { body: raw };
}

function pushRecent(
  recent: Record<string, ActivityItem[]>,
  name: string,
  item: ActivityItem,
): Record<string, ActivityItem[]> {
  const existing = recent[name] ?? [];
  return {
    ...recent,
    [name]: [item, ...existing].slice(0, MAX_RECENT_PER_ENTITY),
  };
}

export const useEntityActivity = create<EntityActivityState>((set) => ({
  recent: {},
  streaming: {},

  applyEvent: (event) =>
    set((state) => {
      // ── Streaming deltas (agent_thinking_delta, agent_text_delta) ──
      // These arrive between agent_turn_start and agent_turn_end. We
      // accumulate them into a per-entity buffer and flush on turn_end.
      if (event.type === "agent_turn_start" && event.name) {
        return {
          streaming: {
            ...state.streaming,
            [event.name]: { thought: "", text: "", turnStartedAt: event.timestamp },
          },
        };
      }

      if (event.type === "agent_thinking_delta" && event.name && event.delta) {
        const buf = state.streaming[event.name];
        if (!buf) return state;
        return {
          streaming: {
            ...state.streaming,
            [event.name]: { ...buf, thought: buf.thought + event.delta },
          },
        };
      }

      if (event.type === "agent_text_delta" && event.name && event.delta) {
        const buf = state.streaming[event.name];
        if (!buf) return state;
        return {
          streaming: {
            ...state.streaming,
            [event.name]: { ...buf, text: buf.text + event.delta },
          },
        };
      }

      if (event.type === "agent_turn_end" && event.name) {
        const buf = state.streaming[event.name];
        const nextStreaming = { ...state.streaming };
        delete nextStreaming[event.name];
        if (!buf || (!buf.thought && !buf.text)) {
          return { streaming: nextStreaming };
        }
        let nextRecent = state.recent;
        if (buf.thought) {
          nextRecent = pushRecent(nextRecent, event.name, {
            kind: "thought",
            body: buf.thought,
            timestamp: event.timestamp,
          });
        }
        if (buf.text) {
          nextRecent = pushRecent(nextRecent, event.name, {
            kind: "text",
            body: buf.text,
            timestamp: event.timestamp,
          });
        }
        return { streaming: nextStreaming, recent: nextRecent };
      }

      // ── Agent lifecycle: agent_stop drops all activity for the
      //    agent so its streaming buffer + recent list don't leak in
      //    worlds where many short-lived agents come and go.
      if (event.type === "agent_stop" && event.name) {
        if (!(event.name in state.recent) && !(event.name in state.streaming)) return state;
        const nextRecent = { ...state.recent };
        delete nextRecent[event.name];
        const nextStreaming = { ...state.streaming };
        delete nextStreaming[event.name];
        return { recent: nextRecent, streaming: nextStreaming };
      }

      // ── Message-bearing command events ──
      // say / tell / shout / emote / broadcast arrive with the full
      // command in `input`. Body extraction is tolerant; raw input is
      // used as a fallback so nothing is silently dropped.
      if (
        (event.type === "say" ||
          event.type === "tell" ||
          event.type === "shout" ||
          event.type === "emote" ||
          event.type === "broadcast") &&
        event.entity
      ) {
        const { body, recipient } = parseMessage(event.type, event.input);
        if (!body) return state;
        const item: ActivityItem = {
          kind: event.type,
          body,
          recipient,
          room: event.room,
          timestamp: event.timestamp,
        };
        return { recent: pushRecent(state.recent, event.entity, item) };
      }

      return state;
    }),

  clearEntity: (name) =>
    set((state) => {
      const nextRecent = { ...state.recent };
      delete nextRecent[name];
      const nextStreaming = { ...state.streaming };
      delete nextStreaming[name];
      return { recent: nextRecent, streaming: nextStreaming };
    }),

  reset: () => set({ recent: {}, streaming: {} }),
}));
