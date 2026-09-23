// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type * as witnessDb from "../db-witness";
import type { ExactKeys } from "./exact-keys";

/** Witness attestations (`db-witness.ts`); entity ids resolve to durable keys at the facade. */
export interface WitnessStore {
  createWitnessRow(
    input: Parameters<typeof witnessDb.createWitnessRow>[1],
  ): ReturnType<typeof witnessDb.createWitnessRow>;
  getWitnessRow(id: number): ReturnType<typeof witnessDb.getWitnessRow>;
  getOpenSupervisionWindow(
    entityId: string,
    gate: string,
    now?: number,
  ): ReturnType<typeof witnessDb.getOpenWindow>;
  consumeSupervisionWindow(
    entityId: string,
    gate: string,
    now?: number,
  ): ReturnType<typeof witnessDb.consumeWindow>;
  resolveWitnessRow(
    id: number,
    status: Parameters<typeof witnessDb.resolveWitnessRow>[2],
    input?: Parameters<typeof witnessDb.resolveWitnessRow>[3],
  ): ReturnType<typeof witnessDb.resolveWitnessRow>;
  listOpenWitnessRows(
    opts?: Parameters<typeof witnessDb.listOpenWitnessRows>[1],
  ): ReturnType<typeof witnessDb.listOpenWitnessRows>;
  countAttestedDemonstrations(
    entityId: string,
    gate: string,
  ): ReturnType<typeof witnessDb.countAttested>;
  revokeCompetence(entityId: string, gate: string): void;
}

/** Runtime mirror of `WitnessStore`'s method names — the drift test compares it to the facade. */
export const WITNESS_STORE_METHODS = [
  "createWitnessRow",
  "getWitnessRow",
  "getOpenSupervisionWindow",
  "consumeSupervisionWindow",
  "resolveWitnessRow",
  "listOpenWitnessRows",
  "countAttestedDemonstrations",
  "revokeCompetence",
] as const satisfies readonly (keyof WitnessStore)[];

export const WITNESS_STORE_COMPLETE: ExactKeys<WitnessStore, typeof WITNESS_STORE_METHODS> = true;
