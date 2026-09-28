// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ParticipantOrientation } from "../../../src/sdk/onboarding";
import type { ChatMessage, StoredPerception } from "../hooks/use-chat-state";
import { ANSI_RE, ansiToHtml } from "./webchat-format";

export interface ChatTransition {
  orientation?: ParticipantOrientation;
  login?: { loggedIn: boolean; name?: string };
  token?: string | null;
  message?: ChatMessage;
}

type PerceptionKind =
  | "room"
  | "message"
  | "broadcast"
  | "movement"
  | "error"
  | "auth_error"
  | "system";

interface Perception {
  kind: PerceptionKind;
  timestamp?: number;
  tag?: string;
  data?: {
    onboarding?: import("../../../src/sdk/onboarding").ParticipantOrientation;
    token?: string;
    entityId?: string;
    entityName?: string;
    from?: string;
    fromName?: string;
    name?: string;
    short?: string;
    long?: string;
    items?: Record<string, unknown>;
    entities?: { name?: string; short?: string }[];
    exits?: string[];
    text?: string;
    entity?: string;
    direction?: string;
    exit?: string;
    channel?: string;
    senderName?: string;
    content?: string;
  };
}

function message(
  text: string,
  kind: string,
  tag: string | undefined,
  perception: StoredPerception | undefined,
  now: number,
) {
  const storedPerception = perception
    ? {
        kind: perception.kind,
        tag: perception.tag,
        timestamp: perception.timestamp,
        data: perception.data,
      }
    : undefined;
  return {
    html: ansiToHtml(text),
    text: text.replace(ANSI_RE, ""),
    kind,
    tag,
    timestamp: storedPerception?.timestamp ?? now,
    perception: storedPerception,
  };
}

export function reduceChatPerception(raw: unknown, now = Date.now()): ChatTransition {
  if (!raw || typeof raw !== "object") return {};
  const internal = raw as {
    data?: {
      capabilities?: unknown;
      context_preview?: { request_id?: string };
      memory_service?: { request_id?: string };
    };
  };
  if (
    internal.data?.capabilities ||
    internal.data?.context_preview?.request_id ||
    internal.data?.memory_service?.request_id
  )
    return {};
  const p = raw as Perception;
  const transition: ChatTransition = {};
  if (p.data?.onboarding) transition.orientation = p.data.onboarding;
  if (p.kind === "auth_error") {
    return {
      ...transition,
      token: null,
      login: { loggedIn: false },
      message: message(p.data?.text ?? "Authentication failed.", "system", p.tag, p, now),
    };
  }
  if (p.data?.token) transition.token = p.data.token;
  if (p.data?.entityId) transition.login = { loggedIn: true, name: p.data.name };

  const kind = p.kind ?? "message";
  const tag = p.tag;
  if (kind === "room") {
    const d = p.data ?? {};
    let text = "";
    if (d.short) text += `${d.short}\n`;
    if (d.long) text += `${d.long}\n`;
    if (d.items && Object.keys(d.items).length > 0) {
      text += `\nObjects: ${Object.keys(d.items).join(", ")}\n`;
    }
    if (d.entities && d.entities.length > 0) {
      text += `Present: ${d.entities
        .map((e) => e.short || e.name)
        .filter(Boolean)
        .join(", ")}\n`;
    }
    if (d.exits && d.exits.length > 0) {
      text += `Exits: ${d.exits.join(", ")}\n`;
    }
    transition.message = message(text, "room", tag, p, now);
  } else if (kind === "movement") {
    const d = p.data ?? {};
    const name = (d.entityName as string) ?? (d.entity as string) ?? "Someone";
    const action =
      d.direction === "arrive"
        ? `${name} arrives.`
        : `${name} leaves${d.exit ? ` ${d.exit}` : ""}.`;
    transition.message = message(action, "movement", tag, p, now);
  } else {
    const fallback =
      typeof p.data?.text === "string" ? p.data.text : p.data ? JSON.stringify(p.data) : "";
    transition.message = message(fallback, kind, tag, p, now);
  }
  return transition;
}
