// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AdapterLinkRow, AdapterUserMappingRow, BanRow, UserRow } from "../db-users";
import type { ExactKeys } from "./exact-keys";

/** World accounts, bans, adapter links and adapter user mappings (`db-users.ts`). */
export interface UsersStore {
  createUser(user: { id: string; name: string; rank?: number }): void;
  getUser(id: string): UserRow | undefined;
  getUserByName(name: string): UserRow | undefined;
  /** All user rows, name-ordered. For maintenance/admin tooling. */
  listUsers(): UserRow[];
  updateUserLastLogin(id: string): void;
  updateUserRank(id: string, rank: number): void;
  /** Look up the named user bound to a verified external-identity subject. */
  getUserByAuthSubject(subject: string): UserRow | undefined;
  /** Bind a verified identity (subject + email) to an existing named user. */
  bindAuthSubject(id: string, subject: string, email: string): void;
  updateUserProperties(id: string, properties: Record<string, unknown>): void;
  deleteUser(id: string): void;
  addBan(name: string, bannedBy: string, reason?: string): void;
  removeBan(name: string): boolean;
  isBanned(name: string): boolean;
  getBan(name: string): BanRow | undefined;
  listBans(): BanRow[];
  linkAdapter(adapter: string, externalId: string, userId: string): void;
  getLinkedUser(adapter: string, externalId: string): AdapterLinkRow | undefined;
  getUserLinks(userId: string): AdapterLinkRow[];
  unlinkAdapter(adapter: string, externalId: string): boolean;
  saveAdapterUserMapping(platform: string, platformUserId: string, entityName: string): void;
  getAdapterUserMapping(
    platform: string,
    platformUserId: string,
  ): AdapterUserMappingRow | undefined;
  getAdapterUserMappings(platform: string): AdapterUserMappingRow[];
  deleteAdapterUserMapping(platform: string, platformUserId: string): boolean;
}

/** Runtime mirror of `UsersStore`'s method names — the drift test compares it to the facade. */
export const USERS_STORE_METHODS = [
  "createUser",
  "getUser",
  "getUserByName",
  "listUsers",
  "updateUserLastLogin",
  "updateUserRank",
  "getUserByAuthSubject",
  "bindAuthSubject",
  "updateUserProperties",
  "deleteUser",
  "addBan",
  "removeBan",
  "isBanned",
  "getBan",
  "listBans",
  "linkAdapter",
  "getLinkedUser",
  "getUserLinks",
  "unlinkAdapter",
  "saveAdapterUserMapping",
  "getAdapterUserMapping",
  "getAdapterUserMappings",
  "deleteAdapterUserMapping",
] as const satisfies readonly (keyof UsersStore)[];

export const USERS_STORE_COMPLETE: ExactKeys<UsersStore, typeof USERS_STORE_METHODS> = true;
