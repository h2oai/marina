// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type * as associationsDb from "../db-associations";
import type { ExactKeys } from "./exact-keys";

/** Generalized associations (`db-associations.ts`). */
export interface AssociationsStore {
  createAssociation(
    input: Parameters<typeof associationsDb.createAssociation>[1],
  ): ReturnType<typeof associationsDb.createAssociation>;
  getAssociation(id: string): ReturnType<typeof associationsDb.getAssociation>;
  listAssociations(limit?: number): ReturnType<typeof associationsDb.listAssociations>;
  appendAssociationEvent(
    input: Parameters<typeof associationsDb.appendAssociationEvent>[1],
  ): ReturnType<typeof associationsDb.appendAssociationEvent>;
  listAssociationEvents(
    associationId: string,
  ): ReturnType<typeof associationsDb.listAssociationEvents>;
  declareAssociationRelation(
    input: Parameters<typeof associationsDb.declareAssociationRelation>[1],
  ): ReturnType<typeof associationsDb.declareAssociationRelation>;
  listAssociationRelations(
    associationId: string,
  ): ReturnType<typeof associationsDb.listAssociationRelations>;
  getAssociationRelation(id: string): ReturnType<typeof associationsDb.getAssociationRelation>;
  findAssociationsBySelector(
    selector: string,
  ): ReturnType<typeof associationsDb.findAssociationsBySelector>;
  linkAssociation(
    input: Parameters<typeof associationsDb.linkAssociation>[1],
  ): ReturnType<typeof associationsDb.linkAssociation>;
  listAssociationLinks(
    associationId: string,
  ): ReturnType<typeof associationsDb.listAssociationLinks>;
  projectAssociation(associationId: string): ReturnType<typeof associationsDb.projectAssociation>;
  verifyAssociationEvent(
    row: associationsDb.AssociationEventRow,
  ): ReturnType<typeof associationsDb.verifyAssociationEvent>;
  verifyAssociationRelation(
    row: associationsDb.AssociationRelationRow,
  ): ReturnType<typeof associationsDb.verifyAssociationRelation>;
  verifyAssociationLink(
    row: associationsDb.AssociationLinkRow,
  ): ReturnType<typeof associationsDb.verifyAssociationLink>;
}

/** Runtime mirror of `AssociationsStore`'s method names — the drift test compares it to the facade. */
export const ASSOCIATIONS_STORE_METHODS = [
  "createAssociation",
  "getAssociation",
  "listAssociations",
  "appendAssociationEvent",
  "listAssociationEvents",
  "declareAssociationRelation",
  "listAssociationRelations",
  "getAssociationRelation",
  "findAssociationsBySelector",
  "linkAssociation",
  "listAssociationLinks",
  "projectAssociation",
  "verifyAssociationEvent",
  "verifyAssociationRelation",
  "verifyAssociationLink",
] as const satisfies readonly (keyof AssociationsStore)[];

export const ASSOCIATIONS_STORE_COMPLETE: ExactKeys<
  AssociationsStore,
  typeof ASSOCIATIONS_STORE_METHODS
> = true;
