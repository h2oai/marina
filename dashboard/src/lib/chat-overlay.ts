// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

type OverlayType =
  | "tasks"
  | "boards"
  | "board-posts"
  | "channel-messages"
  | "channels"
  | "groups"
  | "media"
  | "coding-sessions"
  | "coding-artifacts";

export interface OverlayState {
  type: OverlayType;
  issuedFrom: string;
  params?: Record<string, unknown>;
}

export function overlayForCommand(rawCommand: string): OverlayState | null {
  const trimmed = rawCommand.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("task list")) {
    const tokens = lower.split(/\s+/);
    const scopeToken = tokens[2];
    const statuses = new Set(["open", "claimed", "completed", "cancelled"]);
    let scope: string | undefined;
    let group: string | undefined;
    if (scopeToken === "mine") {
      scope = "mine";
    } else if (scopeToken && statuses.has(scopeToken)) {
      scope = scopeToken;
    } else if (scopeToken) {
      group = scopeToken;
    }
    return {
      type: "tasks",
      issuedFrom: trimmed,
      params: { scope: scope ?? "open", group },
    };
  } else if (/^board read \S+$/.test(lower)) {
    return {
      type: "board-posts",
      issuedFrom: trimmed,
      params: { name: trimmed.split(/\s+/)[2] },
    };
  } else if (/^channel history \S+/.test(lower)) {
    return {
      type: "channel-messages",
      issuedFrom: trimmed,
      params: { name: trimmed.split(/\s+/)[2] },
    };
  } else if (lower.startsWith("board list")) {
    return { type: "boards", issuedFrom: trimmed };
  } else if (lower.startsWith("group list")) {
    return { type: "groups", issuedFrom: trimmed };
  } else if (lower.startsWith("channel list") || lower.startsWith("channels list")) {
    return { type: "channels", issuedFrom: trimmed };
  } else if (lower.startsWith("media jobs") || lower.startsWith("media status")) {
    const parts = trimmed.split(/\s+/);
    const entity = parts.length >= 3 ? parts.slice(2).join(" ").trim() || undefined : undefined;
    return {
      type: "media",
      issuedFrom: trimmed,
      params: entity ? { entityName: entity } : undefined,
    };
  } else if (lower === "code sessions" || lower === "code list") {
    return { type: "coding-sessions", issuedFrom: trimmed };
  } else if (lower === "code artifacts" || lower.startsWith("code artifacts ")) {
    return { type: "coding-artifacts", issuedFrom: trimmed };
  }
  return null;
}
