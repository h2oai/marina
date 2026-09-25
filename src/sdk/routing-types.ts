// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Version 1: transport-neutral participants. Capabilities describe clients, not permissions. */
export interface RoutingJoin {
  clientKey: string;
  label: string;
  kind: string;
  groupId?: string;
  capabilities?: string[];
}
export interface RoutingSession {
  id: string;
  ownerId: string;
  clientKey: string;
  label: string;
  kind: string;
  groupId: string | null;
  capabilities: string[];
  state: "active" | "left";
  createdAt: number;
  lastSeenAt: number;
  lastSequence: number;
}
export interface RoutingEventInput {
  /** Stable producer id; reuse unchanged when retrying a batch. */
  id: string;
  kind: string;
  payload: unknown;
}
export interface RoutingEvent extends RoutingEventInput {
  sessionId: string;
  sequence: number;
  createdAt: number;
}
export interface RoutingEventPage {
  events: RoutingEvent[];
  nextCursor: number;
  lastSequence: number;
  hasMore: boolean;
  /** Requested history was pruned. Consumers must show this instead of implying completeness. */
  gap: boolean;
}
export interface RoutingSend {
  clientMessageId: string;
  targetId: string;
  kind: string;
  payload: unknown;
}
export interface RoutingMessage extends RoutingSend {
  id: string;
  sourceId: string;
  status: "queued" | "acknowledged";
  createdAt: number;
  acknowledgedAt: number | null;
}
export interface RoutingSessionPage {
  sessions: RoutingSession[];
  nextCursor: string | null;
}

/** References to Marina's existing channel_messages; this is not a second conversation log. */
export interface RoutingChannelMessage {
  id: number;
  channelId: string;
  senderId: string;
  senderName: string;
  content: string;
  createdAt: number;
}
export interface RoutingChannelPage {
  messages: RoutingChannelMessage[];
  nextCursor: number;
  hasMore: boolean;
}
export interface RoutingChannelReceipt {
  message: RoutingChannelMessage;
  duplicate: boolean;
}
