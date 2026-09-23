// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type {
  BoardPostRow,
  BoardRow,
  BoardVoteRow,
  ChannelMemberRow,
  ChannelMessageRow,
  ChannelRow,
  GlobalSearchResult,
  GroupMemberRow,
  GroupRow,
} from "../db-channels";
import type { ExactKeys } from "./exact-keys";

/** Channels, boards, groups and global search (`db-channels.ts`). */
export interface ChannelsStore {
  createChannel(c: {
    id: string;
    type: string;
    name: string;
    ownerId?: string;
    persistence?: string;
    retentionHours?: number;
  }): void;
  getChannel(id: string): ChannelRow | undefined;
  getChannelByName(name: string): ChannelRow | undefined;
  getAllChannels(): ChannelRow[];
  deleteChannel(id: string): void;
  // Membership rows are keyed by the durable account id (migration 117);
  // callers keep passing entity ids and `getChannelMembers` projects the live
  // id back (`liveEntityIdSql`).
  addChannelMember(
    channelId: string,
    entityId: string,
    canRead?: boolean,
    canWrite?: boolean,
  ): void;
  removeChannelMember(channelId: string, entityId: string): void;
  getChannelMembers(channelId: string): ChannelMemberRow[];
  getEntityChannels(entityId: string): ChannelRow[];
  isChannelMember(channelId: string, entityId: string): boolean;
  addChannelMessage(
    channelId: string,
    senderId: string,
    senderName: string,
    content: string,
  ): number;
  getChannelHistory(channelId: string, limit?: number): ChannelMessageRow[];
  countChannelMessages(channelId: string): number;
  countBoardPosts(boardId: string, archived?: boolean): number;
  pruneExpiredMessages(now: number): number;
  createBoard(b: {
    id: string;
    name: string;
    scopeType?: string;
    scopeId?: string;
    readRank?: number;
    writeRank?: number;
    pinRank?: number;
  }): void;
  getBoard(id: string): BoardRow | undefined;
  raiseBoardRanks(boardId: string, ranks: { writeRank?: number; pinRank?: number }): void;
  getBoardByName(name: string): BoardRow | undefined;
  getBoardsForScope(scopeType: string, scopeId: string): BoardRow[];
  getAllBoards(): BoardRow[];
  deleteBoard(id: string): void;
  createBoardPost(post: {
    boardId: string;
    parentId?: number;
    authorId: string;
    authorName: string;
    title?: string;
    body: string;
    tags?: string[];
  }): number;
  getBoardPost(id: number): BoardPostRow | undefined;
  listBoardPosts(
    boardId: string,
    opts?: { offset?: number; limit?: number; archived?: boolean },
  ): BoardPostRow[];
  searchBoardPosts(boardId: string, query: string): BoardPostRow[];
  rebuildBoardSearchIndex(): void;
  pinBoardPost(postId: number): void;
  unpinBoardPost(postId: number): void;
  archiveBoardPost(postId: number): void;
  voteBoardPost(postId: number, entityId: string, value: number, score?: number): void;
  getBoardPostVoteCount(postId: number): number;
  autoArchiveBoardPosts(daysOld: number, minVotes: number): number;
  getBoardPostScores(postId: number): BoardVoteRow[];
  getScoreMatrix(boardId: string): BoardVoteRow[];
  createGroup(g: {
    id: string;
    name: string;
    description?: string;
    leaderId: string;
    channelId?: string;
    boardId?: string;
  }): void;
  getGroup(id: string): GroupRow | undefined;
  getGroupByName(name: string): GroupRow | undefined;
  getAllGroups(): GroupRow[];
  deleteGroup(id: string): void;
  updateGroupChannelAndBoard(groupId: string, channelId: string, boardId: string): void;
  // Durable-keyed (migration 117) — see the channel-member delegates above.
  addGroupMember(groupId: string, entityId: string, rank?: number): void;
  removeGroupMember(groupId: string, entityId: string): void;
  getGroupMembers(groupId: string): GroupMemberRow[];
  getGroupMember(groupId: string, entityId: string): GroupMemberRow | undefined;
  getEntityGroups(entityId: string): GroupRow[];
  updateGroupMemberRank(groupId: string, entityId: string, rank: number): void;
  globalSearch(query: string): GlobalSearchResult[];
}

/** Runtime mirror of `ChannelsStore`'s method names — the drift test compares it to the facade. */
export const CHANNELS_STORE_METHODS = [
  "createChannel",
  "getChannel",
  "getChannelByName",
  "getAllChannels",
  "deleteChannel",
  "addChannelMember",
  "removeChannelMember",
  "getChannelMembers",
  "getEntityChannels",
  "isChannelMember",
  "addChannelMessage",
  "getChannelHistory",
  "countChannelMessages",
  "countBoardPosts",
  "pruneExpiredMessages",
  "createBoard",
  "getBoard",
  "raiseBoardRanks",
  "getBoardByName",
  "getBoardsForScope",
  "getAllBoards",
  "deleteBoard",
  "createBoardPost",
  "getBoardPost",
  "listBoardPosts",
  "searchBoardPosts",
  "rebuildBoardSearchIndex",
  "pinBoardPost",
  "unpinBoardPost",
  "archiveBoardPost",
  "voteBoardPost",
  "getBoardPostVoteCount",
  "autoArchiveBoardPosts",
  "getBoardPostScores",
  "getScoreMatrix",
  "createGroup",
  "getGroup",
  "getGroupByName",
  "getAllGroups",
  "deleteGroup",
  "updateGroupChannelAndBoard",
  "addGroupMember",
  "removeGroupMember",
  "getGroupMembers",
  "getGroupMember",
  "getEntityGroups",
  "updateGroupMemberRank",
  "globalSearch",
] as const satisfies readonly (keyof ChannelsStore)[];

export const CHANNELS_STORE_COMPLETE: ExactKeys<ChannelsStore, typeof CHANNELS_STORE_METHODS> =
  true;
