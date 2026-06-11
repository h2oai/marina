import type { GroupRow, MarinaDB } from "../persistence/database";
import type { EngineEvent, EntityId } from "../types";
import type { BoardManager } from "./board-manager";
import type { ChannelManager } from "./channel-manager";

export interface Group {
  id: string;
  name: string;
  description: string;
  leaderId: string;
  channelId: string | null;
  boardId: string | null;
  createdAt: number;
}

export interface GroupMember {
  groupId: string;
  entityId: string;
  rank: number;
  joinedAt: number;
}

function rowToGroup(row: GroupRow): Group {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    leaderId: row.leader_id,
    channelId: row.channel_id,
    boardId: row.board_id,
    createdAt: row.created_at,
  };
}

export class GroupManager {
  constructor(
    private db: MarinaDB,
    private channels: ChannelManager,
    private boards: BoardManager,
    private logEvent?: (event: EngineEvent) => void,
  ) {}

  private emitChange(
    action: "create" | "update" | "delete",
    group: { id: string; name: string; leaderId: string },
    actor?: string,
  ): void {
    this.logEvent?.({
      type: "coordination_change",
      resource: "group",
      action,
      entity: (actor ?? group.leaderId) as EntityId,
      name: group.name,
      timestamp: Date.now(),
    });
  }

  create(opts: { id: string; name: string; description?: string; leaderId: string }): Group {
    // Create group record first
    this.db.createGroup({
      id: opts.id,
      name: opts.name,
      description: opts.description,
      leaderId: opts.leaderId,
    });

    // Auto-create channel + board
    const channel = this.channels.createChannel({
      type: "group",
      name: `group:${opts.id}`,
      ownerId: opts.leaderId,
      persistence: "permanent",
    });

    const board = this.boards.createBoard({
      name: `group:${opts.id}`,
      scopeType: "group",
      scopeId: opts.id,
    });

    this.db.updateGroupChannelAndBoard(opts.id, channel.id, board.id);

    // Add leader as member with rank 2 (officer)
    this.db.addGroupMember(opts.id, opts.leaderId, 2);
    this.channels.addMember(channel.id, opts.leaderId);

    this.emitChange("create", { id: opts.id, name: opts.name, leaderId: opts.leaderId });

    return {
      id: opts.id,
      name: opts.name,
      description: opts.description ?? "",
      leaderId: opts.leaderId,
      channelId: channel.id,
      boardId: board.id,
      createdAt: Date.now(),
    };
  }

  delete(id: string): void {
    const group = this.get(id);
    if (!group) return;
    if (group.channelId) this.channels.deleteChannel(group.channelId);
    if (group.boardId) this.boards.deleteBoard(group.boardId);
    this.db.deleteGroup(id);
    this.emitChange("delete", group);
  }

  get(id: string): Group | undefined {
    const row = this.db.getGroup(id);
    return row ? rowToGroup(row) : undefined;
  }

  getByName(name: string): Group | undefined {
    const row = this.db.getGroupByName(name);
    return row ? rowToGroup(row) : undefined;
  }

  list(): Group[] {
    return this.db.getAllGroups().map(rowToGroup);
  }

  addMember(groupId: string, entityId: string, rank = 0): void {
    this.db.addGroupMember(groupId, entityId, rank);
    const group = this.get(groupId);
    if (group?.channelId) {
      this.channels.addMember(group.channelId, entityId);
    }
    if (group) this.emitChange("update", group, entityId);
  }

  removeMember(groupId: string, entityId: string): void {
    this.db.removeGroupMember(groupId, entityId);
    const group = this.get(groupId);
    if (group?.channelId) {
      this.channels.removeMember(group.channelId, entityId);
    }
    if (group) this.emitChange("update", group, entityId);
  }

  getMembers(groupId: string): GroupMember[] {
    return this.db.getGroupMembers(groupId).map((row) => ({
      groupId: row.group_id,
      entityId: row.entity_id,
      rank: row.rank,
      joinedAt: row.joined_at,
    }));
  }

  isMember(groupId: string, entityId: string): boolean {
    return this.db.getGroupMember(groupId, entityId) !== undefined;
  }

  getMemberRank(groupId: string, entityId: string): number {
    const member = this.db.getGroupMember(groupId, entityId);
    return member?.rank ?? -1;
  }

  getEntityGroups(entityId: string): Group[] {
    return this.db.getEntityGroups(entityId).map(rowToGroup);
  }

  promote(groupId: string, entityId: string): boolean {
    const member = this.db.getGroupMember(groupId, entityId);
    if (!member || member.rank >= 2) return false;
    this.db.updateGroupMemberRank(groupId, entityId, member.rank + 1);
    const group = this.get(groupId);
    if (group) this.emitChange("update", group, entityId);
    return true;
  }

  demote(groupId: string, entityId: string): boolean {
    const member = this.db.getGroupMember(groupId, entityId);
    if (!member || member.rank <= 0) return false;
    this.db.updateGroupMemberRank(groupId, entityId, member.rank - 1);
    const group = this.get(groupId);
    if (group) this.emitChange("update", group, entityId);
    return true;
  }

  canInvite(groupId: string, entityId: string): boolean {
    const group = this.get(groupId);
    if (!group) return false;
    if (group.leaderId === entityId) return true;
    return this.getMemberRank(groupId, entityId) >= 1;
  }

  canKick(groupId: string, entityId: string): boolean {
    const group = this.get(groupId);
    if (!group) return false;
    if (group.leaderId === entityId) return true;
    return this.getMemberRank(groupId, entityId) >= 2;
  }
}
