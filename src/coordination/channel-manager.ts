import { channel as fmtChannel } from "../net/ansi";
import type { ChannelRow, MarinaDB } from "../persistence/database";
import type { EntityId } from "../types";

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
    ) => void,
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

  send(channelId: string, senderId: string, senderName: string, content: string): void {
    this.db.addChannelMessage(channelId, senderId, senderName, content);

    // Deliver to online members
    const members = this.db.getChannelMembers(channelId);
    const channel = this.db.getChannel(channelId);
    const channelName = channel?.name ?? channelId;

    for (const member of members) {
      if (member.entity_id !== senderId && member.can_read) {
        this.sendToEntity(
          member.entity_id as EntityId,
          fmtChannel(channelName, senderName, content),
          channelName,
          { channel: channelName, senderName, content },
        );
      }
    }

    // Fire message listeners
    for (const listener of this.messageListeners) {
      try {
        listener(channelId, senderId, senderName, content);
      } catch (err) {
        console.warn("[channels] message listener threw:", (err as Error).message);
      }
    }
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
