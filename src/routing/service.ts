// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MarinaStores, RoutingStore } from "../persistence/interfaces";
import type {
  RoutingSyncInput,
  RoutingSyncResult,
  RuntimeControl,
} from "../sdk/routing-runtime-types";
import type {
  RoutingEventInput,
  RoutingJoin,
  RoutingSend,
  RoutingSession,
} from "../sdk/routing-types";
import { RoutingError } from "./errors";

type Store = RoutingStore &
  Pick<
    MarinaStores,
    "getUser" | "getGroupMember" | "getGroup" | "getChannel" | "getEntityChannels" | "transaction"
  >;
const encoder = new TextEncoder();
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RoutingError(400, "invalid_input", "Expected an object");
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, max = 128): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new RoutingError(
      400,
      "invalid_input",
      `${field} must be a nonempty string of at most ${max} characters`,
    );
  }
  return value;
}
function content(value: unknown): unknown {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new RoutingError(400, "invalid_input", "payload must be JSON serializable");
  }
  if (encoded === undefined || encoder.encode(encoded).length > 32_768) {
    throw new RoutingError(413, "payload_too_large", "payload must be JSON of at most 32 KiB");
  }
  // Canonical JSON representation prevents undefined fields/NaN from changing after a retry.
  return JSON.parse(encoded);
}
export function routingLimit(value: unknown, fallback = 100): number {
  const limit = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new RoutingError(400, "invalid_input", "limit must be an integer between 1 and 200");
  }
  return limit;
}

/** All mutations are attributed to a durable world account. No process control or command execution. */
export class RoutingService {
  constructor(
    private readonly db: Store,
    private readonly ownerId: string,
  ) {
    if (!db.getUser(ownerId))
      throw new RoutingError(
        403,
        "account_required",
        "Log in with a Marina account to use participant routing",
      );
  }
  private member(groupId: string): boolean {
    return !!this.db.getGroup(groupId) && !!this.db.getGroupMember(groupId, this.ownerId);
  }
  private read(id: string): RoutingSession {
    const session = this.db.getRoutingSession(id);
    if (
      !session ||
      (session.ownerId !== this.ownerId && (!session.groupId || !this.member(session.groupId)))
    ) {
      throw new RoutingError(404, "not_found", "Participant session not found");
    }
    return session;
  }
  private own(id: string, active = false): RoutingSession {
    const session = this.read(id);
    if (session.ownerId !== this.ownerId)
      throw new RoutingError(403, "not_owner", "Only the session owner may perform this action");
    if (active) {
      if (session.state !== "active")
        throw new RoutingError(
          409,
          "session_left",
          "Rejoin this session before publishing or sending",
        );
      if (session.groupId && !this.member(session.groupId))
        throw new RoutingError(403, "group_required", "Current group membership is required");
    }
    return session;
  }
  channels(id: string) {
    this.own(id, true);
    return this.db
      .getEntityChannels(this.ownerId)
      .filter((channel) => this.db.getRoutingChannelAccess(this.ownerId, channel.id).canRead);
  }
  channelEvents(id: string, channelId: string, after = 0, limit = 100) {
    this.own(id, true);
    if (!this.db.getRoutingChannelAccess(this.ownerId, channelId).canRead)
      throw new RoutingError(403, "channel_read_denied", "Channel read membership is required");
    if (!Number.isSafeInteger(after) || after < 0)
      throw new RoutingError(400, "invalid_input", "after must be a nonnegative integer cursor");
    return this.db.listRoutingChannelMessages(channelId, after, routingLimit(limit));
  }
  publishChannel(id: string, channelId: string, value: unknown) {
    const session = this.own(id, true);
    const access = this.db.getRoutingChannelAccess(this.ownerId, channelId);
    if (!access.canRead || !access.canWrite)
      throw new RoutingError(
        403,
        "channel_write_denied",
        "Channel read and write membership is required",
      );
    const input = object(value);
    const clientMessageId = text(input.clientMessageId, "clientMessageId");
    if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 8192) {
      throw new RoutingError(
        400,
        "invalid_input",
        "text must contain between 1 and 8192 characters",
      );
    }
    const message = input.text;
    const account = this.db.getUser(this.ownerId)!;
    // Attribute the world account and participant explicitly in the native conversation.
    return this.db.publishRoutingChannelMessage(
      id,
      clientMessageId,
      channelId,
      this.ownerId,
      account.name,
      `[${session.label} · ${session.id}] ${message}`,
    );
  }
  join(value: unknown): RoutingSession {
    const input = object(value);
    const join: RoutingJoin = {
      clientKey: text(input.clientKey, "clientKey"),
      label: text(input.label, "label"),
      kind: text(input.kind, "kind", 64),
    };
    if (input.groupId !== undefined) {
      join.groupId = text(input.groupId, "groupId");
      if (!this.member(join.groupId))
        throw new RoutingError(
          403,
          "group_required",
          "Join the Marina group before sharing a participant with it",
        );
    }
    if (input.capabilities !== undefined) {
      if (!Array.isArray(input.capabilities) || input.capabilities.length > 32)
        throw new RoutingError(
          400,
          "invalid_input",
          "capabilities must be an array of at most 32 strings",
        );
      join.capabilities = [
        ...new Set(input.capabilities.map((v) => text(v, "capability", 64))),
      ].sort();
    }
    return this.db.joinRoutingSession(this.ownerId, join);
  }
  list(after = "", limit = 100) {
    if (after.length > 128) throw new RoutingError(400, "invalid_input", "Invalid session cursor");
    return this.db.listRoutingSessions(this.ownerId, after, routingLimit(limit));
  }
  get(id: string) {
    return this.read(id);
  }
  heartbeat(id: string) {
    this.own(id, true);
    return this.db.setRoutingSessionState(id, "active");
  }
  leave(id: string) {
    this.own(id);
    return this.db.setRoutingSessionState(id, "left");
  }
  publish(id: string, value: unknown) {
    this.own(id, true);
    if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
      throw new RoutingError(400, "invalid_input", "events must contain between 1 and 100 events");
    }
    const events: RoutingEventInput[] = value.map((v) => {
      const event = object(v);
      return {
        id: text(event.id, "event.id"),
        kind: text(event.kind, "event.kind", 64),
        payload: content(event.payload),
      };
    });
    if (encoder.encode(JSON.stringify(events)).length > 262_144)
      throw new RoutingError(413, "payload_too_large", "Event batch exceeds 256 KiB");
    return this.db.appendRoutingEvents(id, events);
  }
  events(id: string, after = 0, limit = 100) {
    const session = this.read(id);
    if (!Number.isSafeInteger(after) || after < 0)
      throw new RoutingError(400, "invalid_input", "after must be a nonnegative integer cursor");
    if (after > session.lastSequence)
      throw new RoutingError(
        409,
        "cursor_ahead",
        "Cursor is ahead of this stream; restart replay after a restore",
      );
    return this.db.listRoutingEvents(id, after, routingLimit(limit));
  }
  runtime(id: string) {
    this.read(id);
    return this.db.getRoutingRuntimeState(id);
  }
  overview(after = "", limit = 100, attention = false) {
    if (after.length > 200) throw new RoutingError(400, "invalid_input", "Invalid overview cursor");
    return this.db.listRoutingOverview(this.ownerId, after, routingLimit(limit), attention);
  }
  control(id: string, value: unknown) {
    const source = this.own(id, true);
    const input = object(value);
    const target = this.own(text(input.targetId, "targetId"), true);
    if (source.ownerId !== target.ownerId)
      throw new RoutingError(403, "not_owner", "Controls require the same owner");
    const control = object(input.control);
    if (
      !["launch", "prompt", "interrupt", "stop", "resume", "detach", "respond"].includes(
        String(control.action),
      )
    )
      throw new RoutingError(400, "invalid_input", "Unknown runtime control");
    return this.db.sendRoutingMessage(id, {
      targetId: target.id,
      clientMessageId: text(input.clientMessageId, "clientMessageId"),
      kind: "marina.control",
      payload: content(control as unknown as RuntimeControl),
    });
  }
  sync(value: unknown): RoutingSyncResult {
    const input = object(value) as unknown as RoutingSyncInput;
    for (const field of [input.publications, input.acknowledgments, input.inboxes]) {
      if (field !== undefined && (!Array.isArray(field) || field.length > 100))
        throw new RoutingError(400, "invalid_input", "Sync lists must contain at most 100 entries");
    }
    return this.db.transaction(() => {
      for (const publication of input.publications ?? []) {
        const row = object(publication);
        this.publish(text(row.sessionId, "sessionId"), row.events);
      }
      for (const acknowledgment of input.acknowledgments ?? []) {
        const row = object(acknowledgment);
        this.acknowledge(text(row.sessionId, "sessionId"), text(row.messageId, "messageId"));
      }
      let budget = 131072;
      const inboxes: RoutingSyncResult["inboxes"] = [];
      for (const id of input.inboxes ?? []) {
        const sessionId = text(id, "sessionId");
        this.own(sessionId, true);
        const messages = this.db.listRoutingInbox(sessionId, 10, true);
        const bounded = [];
        for (const message of messages) {
          const bytes = encoder.encode(JSON.stringify(message)).length;
          if (bytes > budget) break;
          bounded.push(message);
          budget -= bytes;
        }
        inboxes.push({ sessionId, messages: bounded });
      }
      return { inboxes };
    });
  }
  send(id: string, value: unknown) {
    const source = this.own(id, true);
    const input = object(value);
    const send: RoutingSend = {
      clientMessageId: text(input.clientMessageId, "clientMessageId"),
      targetId: text(input.targetId, "targetId"),
      kind: text(input.kind, "kind", 64),
      payload: content(input.payload),
    };
    if (send.kind.startsWith("marina.control"))
      throw new RoutingError(403, "reserved_kind", "Use the authorized runtime control endpoint");
    const target = this.read(send.targetId);
    // A session must be in the same shared scope; owning sessions permits private routing.
    if (
      source.ownerId !== target.ownerId &&
      (!source.groupId ||
        source.groupId !== target.groupId ||
        !this.db.getGroupMember(target.groupId, target.ownerId))
    ) {
      throw new RoutingError(
        403,
        "scope_mismatch",
        "Participants must share a current Marina group",
      );
    }
    return this.db.sendRoutingMessage(id, send);
  }
  inbox(id: string, limit = 100) {
    this.own(id, true);
    return this.db.listRoutingInbox(id, routingLimit(limit));
  }
  deliveries(id: string, limit = 100) {
    this.own(id);
    return this.db.listRoutingDeliveries(id, routingLimit(limit));
  }
  receipt(id: string, messageId: string) {
    this.own(id);
    const message = this.db.getRoutingMessage(messageId);
    if (!message || (message.sourceId !== id && message.targetId !== id))
      throw new RoutingError(404, "not_found", "Message not found");
    return message;
  }
  acknowledge(id: string, messageId: string) {
    this.own(id, true);
    const message = this.db.acknowledgeRoutingMessage(id, messageId);
    if (!message) throw new RoutingError(404, "not_found", "Message not found in this inbox");
    return message;
  }
}
