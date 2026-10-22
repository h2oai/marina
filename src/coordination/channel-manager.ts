// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Logger } from "../engine/logger";
import { channel as fmtChannel } from "../net/ansi";
import type { ChannelRow, MarinaDB } from "../persistence/database";
import type { EntityId } from "../types";

/** Module logger. */
const logger = new Logger();

export interface Channel {
  id: string;
  type: string;
  name: string;
  ownerId: string | null;
  persistence: string;
  retentionHours: number | null;
  createdAt: number;
}

export interface ChannelMessage {
  id: number;
  channelId: string;
  senderId: string;
  senderName: string;
  content: string;
  createdAt: number;
  /** Causal envelope (`src/engine/message-envelope.ts`); absent = depth 0. */
  cause?: string;
  depth?: number;
}

/** The envelope a channel post records: refs and numbers only. */
export interface ChannelEnvelope {
  cause?: string;
  depth: number;
}

function rowToChannel(row: ChannelRow): Channel {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    ownerId: row.owner_id,
    persistence: row.persistence,
    retentionHours: row.retention_hours,
    createdAt: row.created_at,
  };
}

export type ChannelMessageListener = (
  channelId: string,
  senderId: string,
  senderName: string,
  content: string,
) => void;

export class ChannelManager {
  private messageListeners: ChannelMessageListener[] = [];

  constructor(
    private db: MarinaDB,
    private sendToEntity: (
      target: EntityId,
      message: string,
      tag?: string,
      metadata?: Record<string, unknown>,
      // `false` = the target has no live connection (the perception was not
      // delivered); any other return counts as delivered.
    ) => unknown,
  ) {}

  /** Register a listener invoked on every send(). Returns an unsubscribe function. */
  onMessage(listener: ChannelMessageListener): () => void {
    this.messageListeners.push(listener);
    return () => {
      const idx = this.messageListeners.indexOf(listener);
      if (idx >= 0) this.messageListeners.splice(idx, 1);
    };
  }

  createChannel(opts: {
    type: string;
    name: string;
    ownerId?: string;
    persistence?: string;
    retentionHours?: number;
  }): Channel {
    const id =
      opts.type === "room"
        ? `room:${opts.name}`
        : opts.type === "direct"
          ? `dm:${opts.name}`
          : opts.type === "crew"
            ? `crew:${opts.name}`
            : `ch:${opts.name}`;

    this.db.createChannel({
      id,
      type: opts.type,
      name: opts.name,
      ownerId: opts.ownerId,
      persistence: opts.persistence,
      retentionHours: opts.retentionHours,
    });

    return {
      id,
      type: opts.type,
      name: opts.name,
      ownerId: opts.ownerId ?? null,
      persistence: opts.persistence ?? "permanent",
      retentionHours: opts.retentionHours ?? null,
      createdAt: Date.now(),
    };
  }

  deleteChannel(id: string): void {
    this.db.deleteChannel(id);
  }

  getChannel(id: string): Channel | undefined {
    const row = this.db.getChannel(id);
    return row ? rowToChannel(row) : undefined;
  }

  getChannelByName(name: string): Channel | undefined {
    const row = this.db.getChannelByName(name);
    return row ? rowToChannel(row) : undefined;
  }

  getAllChannels(): Channel[] {
    return this.db.getAllChannels().map(rowToChannel);
  }

  addMember(channelId: string, entityId: string, canRead = true, canWrite = true): void {
    this.db.addChannelMember(channelId, entityId, canRead, canWrite);
  }

  removeMember(channelId: string, entityId: string): void {
    this.db.removeChannelMember(channelId, entityId);
  }

  getMembers(channelId: string): string[] {
    return this.db.getChannelMembers(channelId).map((m) => m.entity_id);
  }

  isMember(channelId: string, entityId: string): boolean {
    return this.db.isChannelMember(channelId, entityId);
  }

  getEntityChannels(entityId: string): Channel[] {
    return this.db.getEntityChannels(entityId).map(rowToChannel);
  }

  send(
    channelId: string,
    senderId: string,
    senderName: string,
    content: string,
    extraMeta?: Record<string, unknown>,
  ): EntityId[] {
    return this.post(channelId, senderId, senderName, content, { extraMeta }).missed;
  }

  /**
   * Store and deliver one post. Returns the stored message (its id is the
   * feed ref `channel_msg:<id>`) and the readers it could not reach.
   */
  post(
    channelId: string,
    senderId: string,
    senderName: string,
    content: string,
    opts: { extraMeta?: Record<string, unknown>; envelope?: ChannelEnvelope } = {},
  ): { message: ChannelMessage; missed: EntityId[] } {
    const { envelope } = opts;
    const id = this.db.addChannelMessage(channelId, senderId, senderName, content, envelope);
    const message: ChannelMessage = {
      id,
      channelId,
      senderId,
      senderName,
      content,
      createdAt: Date.now(),
      ...(envelope?.cause ? { cause: envelope.cause } : {}),
      ...(envelope ? { depth: envelope.depth } : {}),
    };
    return { message, missed: this.deliverStored(message, opts.extraMeta) };
  }

  /**
   * Deliver an already committed canonical channel message without recording
   * it twice. Returns the readers it could not reach (no live connection), so a
   * caller whose message must not be missed can deliver it again later.
   */
  deliverStored(message: ChannelMessage, extraMeta?: Record<string, unknown>): EntityId[] {
    const { channelId, senderId, senderName, content } = message;
    const missed: EntityId[] = [];
    const channelName = this.db.getChannel(channelId)?.name ?? channelId;

    // Deliver to online members
    for (const member of this.db.getChannelMembers(channelId)) {
      if (member.entity_id !== senderId && member.can_read) {
        const target = member.entity_id as EntityId;
        if (!this.deliverFormatted(target, channelName, message, extraMeta)) missed.push(target);
      }
    }

    // Fire message listeners
    for (const listener of this.messageListeners) {
      try {
        listener(channelId, senderId, senderName, content);
      } catch (err) {
        logger.warn("channels", "message listener threw", { error: (err as Error).message });
      }
    }
    return missed;
  }

  /**
   * Deliver one stored message to one reader, formatted as a live channel
   * post. Fires no listeners and records nothing. Returns false when the
   * reader is not connected or no longer reads the channel.
   */
  deliverTo(
    target: EntityId,
    message: Pick<ChannelMessage, "channelId" | "senderName" | "content"> &
      Partial<Pick<ChannelMessage, "id" | "cause" | "depth">>,
    extraMeta?: Record<string, unknown>,
  ): boolean {
    const { channelId } = message;
    const reader = this.db.getChannelMembers(channelId).find((m) => m.entity_id === target);
    if (!reader?.can_read) return false;
    const channelName = this.db.getChannel(channelId)?.name ?? channelId;
    return this.deliverFormatted(target, channelName, message, extraMeta);
  }

  private deliverFormatted(
    target: EntityId,
    channelName: string,
    message: Pick<ChannelMessage, "senderName" | "content"> &
      Partial<Pick<ChannelMessage, "id" | "cause" | "depth">>,
    extraMeta?: Record<string, unknown>,
  ): boolean {
    const { senderName, content } = message;
    // The stored id and causal envelope ride along when known; a caller's
    // extraMeta can never stand in for them.
    const envelope =
      message.id !== undefined
        ? {
            messageId: message.id,
            messageRef: `channel_msg:${message.id}`,
            ...(message.cause ? { cause: message.cause } : {}),
            depth: message.depth ?? 0,
          }
        : {};
    const delivered = this.sendToEntity(
      target,
      fmtChannel(channelName, senderName, content),
      channelName,
      // extraMeta FIRST so the canonical channel/senderName/content below
      // always win — a caller cannot spoof the authoritative message fields.
      { ...extraMeta, channel: channelName, senderName, content, ...envelope },
    );
    return delivered !== false;
  }

  getHistory(channelId: string, limit = 20): ChannelMessage[] {
    return this.db
      .getChannelHistory(channelId, limit)
      .reverse()
      .map((row) => ({
        id: row.id,
        channelId: row.channel_id,
        senderId: row.sender_id,
        senderName: row.sender_name,
        content: row.content,
        createdAt: row.created_at,
        ...(row.cause ? { cause: row.cause } : {}),
        depth: row.depth ?? 0,
      }));
  }

  ensureRoomChannel(roomId: string): Channel {
    const id = `room:${roomId}`;
    const existing = this.getChannel(id);
    if (existing) return existing;
    return this.createChannel({
      type: "room",
      name: roomId,
      persistence: "permanent",
    });
  }

  getOrCreateDirect(entity1: string, entity2: string): Channel {
    const sorted = [entity1, entity2].sort();
    const name = `${sorted[0]}:${sorted[1]}`;
    const id = `dm:${name}`;
    const existing = this.getChannel(id);
    if (existing) return existing;
    const channel = this.createChannel({ type: "direct", name });
    this.addMember(channel.id, entity1);
    this.addMember(channel.id, entity2);
    return channel;
  }

  pruneExpiredMessages(): number {
    return this.db.pruneExpiredMessages(Date.now());
  }
}
