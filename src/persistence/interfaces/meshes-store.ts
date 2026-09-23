// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type * as meshesDb from "../db-meshes";
import type { ExactKeys } from "./exact-keys";

/** Transparent meshes (`db-meshes.ts`). */
export interface MeshesStore {
  createMesh(
    input: Parameters<typeof meshesDb.createMesh>[1],
  ): ReturnType<typeof meshesDb.createMesh>;
  getMesh(id: string): ReturnType<typeof meshesDb.getMesh>;
  listMeshes(limit?: number): ReturnType<typeof meshesDb.listMeshes>;
  findMeshesBySelector(selector: string): ReturnType<typeof meshesDb.findMeshesBySelector>;
  appendMeshMembershipEvent(
    input: Parameters<typeof meshesDb.appendMeshMembershipEvent>[1],
  ): ReturnType<typeof meshesDb.appendMeshMembershipEvent>;
  listMeshMembershipEvents(id: string): ReturnType<typeof meshesDb.listMeshMembershipEvents>;
  appendMeshEvent(
    input: Parameters<typeof meshesDb.appendMeshEvent>[1],
  ): ReturnType<typeof meshesDb.appendMeshEvent>;
  listMeshEvents(id: string, limit?: number): ReturnType<typeof meshesDb.listMeshEvents>;
  getMeshEvent(id: string): ReturnType<typeof meshesDb.getMeshEvent>;
  countMeshEvents(id: string): ReturnType<typeof meshesDb.countMeshEvents>;
  witnessMeshEvent(
    input: Parameters<typeof meshesDb.witnessMeshEvent>[1],
  ): ReturnType<typeof meshesDb.witnessMeshEvent>;
  listMeshWitnesses(id: string, limit?: number): ReturnType<typeof meshesDb.listMeshWitnesses>;
  countMeshWitnesses(id: string): ReturnType<typeof meshesDb.countMeshWitnesses>;
  createMeshTranslation(
    input: Parameters<typeof meshesDb.createMeshTranslation>[1],
  ): ReturnType<typeof meshesDb.createMeshTranslation>;
  listMeshTranslations(id: string): ReturnType<typeof meshesDb.listMeshTranslations>;
  verifyMeshEvent(row: meshesDb.MeshEventRow): ReturnType<typeof meshesDb.verifyMeshEvent>;
  exportMeshEvent(row: meshesDb.MeshEventRow): ReturnType<typeof meshesDb.exportMeshEvent>;
  importMeshEvent(
    token: string,
    opts?: { expectedMeshId?: string },
  ): ReturnType<typeof meshesDb.importMeshEvent>;
}

/** Runtime mirror of `MeshesStore`'s method names — the drift test compares it to the facade. */
export const MESHES_STORE_METHODS = [
  "createMesh",
  "getMesh",
  "listMeshes",
  "findMeshesBySelector",
  "appendMeshMembershipEvent",
  "listMeshMembershipEvents",
  "appendMeshEvent",
  "listMeshEvents",
  "getMeshEvent",
  "countMeshEvents",
  "witnessMeshEvent",
  "listMeshWitnesses",
  "countMeshWitnesses",
  "createMeshTranslation",
  "listMeshTranslations",
  "verifyMeshEvent",
  "exportMeshEvent",
  "importMeshEvent",
] as const satisfies readonly (keyof MeshesStore)[];

export const MESHES_STORE_COMPLETE: ExactKeys<MeshesStore, typeof MESHES_STORE_METHODS> = true;
