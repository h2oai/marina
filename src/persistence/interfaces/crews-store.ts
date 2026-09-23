// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type * as crewsDb from "../db-crews";
import type { ExactKeys } from "./exact-keys";

/** Crews (`db-crews.ts`). */
export interface CrewsStore {
  saveCrew(c: Parameters<typeof crewsDb.saveCrew>[1]): void;
  getCrew(id: string): import("../db-crews").CrewRow | undefined;
  getCrewByName(name: string): import("../db-crews").CrewRow | undefined;
  getAllCrews(): import("../db-crews").CrewRow[];
  deleteCrew(id: string): void;
  addCrewMember(crewId: string, agentName: string, role: string, joinedAt: number): void;
  removeCrewMember(crewId: string, agentName: string): void;
  getCrewMembers(crewId: string): import("../db-crews").CrewMemberRow[];
  saveCrewInvitation(row: import("../db-crews").CrewInvitationRow): void;
  setCrewInvitationStatus(
    crewId: string,
    agentName: string,
    status: import("../db-crews").CrewInvitationRow["status"],
    respondedAt: number,
  ): void;
  deleteCrewInvitations(crewId: string): void;
  getOpenCrewInvitations(): import("../db-crews").CrewInvitationRow[];
}

/** Runtime mirror of `CrewsStore`'s method names — the drift test compares it to the facade. */
export const CREWS_STORE_METHODS = [
  "saveCrew",
  "getCrew",
  "getCrewByName",
  "getAllCrews",
  "deleteCrew",
  "addCrewMember",
  "removeCrewMember",
  "getCrewMembers",
  "saveCrewInvitation",
  "setCrewInvitationStatus",
  "deleteCrewInvitations",
  "getOpenCrewInvitations",
] as const satisfies readonly (keyof CrewsStore)[];

export const CREWS_STORE_COMPLETE: ExactKeys<CrewsStore, typeof CREWS_STORE_METHODS> = true;
