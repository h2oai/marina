// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type {
  RoutingChannelPage,
  RoutingChannelReceipt,
  RoutingEvent,
  RoutingEventInput,
  RoutingEventPage,
  RoutingJoin,
  RoutingMessage,
  RoutingOverview,
  RoutingSend,
  RoutingSession,
  RoutingSessionPage,
} from "../../sdk/routing-types";
import type { ExactKeys } from "./exact-keys";

export interface RoutingStore {
  listRoutingOverview(
    ownerId: string,
    after: string,
    limit: number,
    attention: boolean,
  ): RoutingOverview;
  getRoutingRuntimeState(sessionId: string): unknown | null;
  listRoutingDeliveries(sessionId: string, limit: number): RoutingMessage[];
  getRoutingChannelAccess(
    ownerId: string,
    channelId: string,
  ): { canRead: boolean; canWrite: boolean };
  listRoutingChannelMessages(channelId: string, after: number, limit: number): RoutingChannelPage;
  publishRoutingChannelMessage(
    sessionId: string,
    clientMessageId: string,
    channelId: string,
    senderId: string,
    senderName: string,
    content: string,
  ): RoutingChannelReceipt;

  joinRoutingSession(ownerId: string, input: RoutingJoin): RoutingSession;
  getRoutingSession(id: string): RoutingSession | null;
  listRoutingSessions(ownerId: string, after: string, limit: number): RoutingSessionPage;
  setRoutingSessionState(id: string, state: "active" | "left"): RoutingSession;
  appendRoutingEvents(sessionId: string, events: RoutingEventInput[]): RoutingEvent[];
  listRoutingEvents(sessionId: string, after: number, limit: number): RoutingEventPage;
  sendRoutingMessage(sourceId: string, input: RoutingSend): RoutingMessage;
  listRoutingInbox(sessionId: string, limit: number, controlsFirst?: boolean): RoutingMessage[];
  getRoutingMessage(id: string): RoutingMessage | null;
  acknowledgeRoutingMessage(sessionId: string, id: string): RoutingMessage | null;
}

export const ROUTING_STORE_METHODS = [
  "listRoutingOverview",
  "getRoutingRuntimeState",
  "listRoutingDeliveries",
  "getRoutingChannelAccess",
  "listRoutingChannelMessages",
  "publishRoutingChannelMessage",

  "joinRoutingSession",
  "getRoutingSession",
  "listRoutingSessions",
  "setRoutingSessionState",
  "appendRoutingEvents",
  "listRoutingEvents",
  "sendRoutingMessage",
  "listRoutingInbox",
  "getRoutingMessage",
  "acknowledgeRoutingMessage",
] as const satisfies readonly (keyof RoutingStore)[];
export const ROUTING_STORE_COMPLETE: ExactKeys<RoutingStore, typeof ROUTING_STORE_METHODS> = true;
