// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { EntityId } from "../../types";
import type {
  CodingProjectRow,
  CodingServiceProbeRow,
  CodingServiceRow,
  FlywheelBindingRow,
  FlywheelBindingState,
  FlywheelCredentialBindingRow,
  FlywheelOperationSummary,
} from "../db-flywheel";
import type { ExactKeys } from "./exact-keys";

/** Flywheel bindings, sandbox projects, services, probes and credential bindings (`db-flywheel.ts`). */
export interface FlywheelStore {
  saveFlywheelBinding(opts: {
    entityId: EntityId;
    sessionId: string;
    sandboxId: string;
    image: string;
    keepAlive: boolean;
    state: FlywheelBindingState;
    lifecycleExpiresAt?: number;
  }): void;
  // flywheel_bindings / coding_projects / coding_services are keyed by the
  // durable account id (migration 117). Reads project the live entity id back
  // so `row.entity_id === entity.id` comparisons in callers keep working.
  listFlywheelBindings(): FlywheelBindingRow[];
  /** The binding owned by this entity's account (indexed PK lookup, not a scan). */
  getFlywheelBinding(entityId: EntityId): FlywheelBindingRow | undefined;
  updateFlywheelBinding(
    entityId: EntityId,
    fields: {
      state?: FlywheelBindingState;
      publishedUrl?: string | null;
      lastError?: string | null;
      reconciledAt?: number | null;
      activeProjectId?: string | null;
      guestCwd?: string | null;
      networkProfile?: string;
      networkProfileEnforced?: boolean;
      lastActivityAt?: number;
      lifecycleExpiresAt?: number | null;
      hibernatedReason?: string | null;
    },
  ): void;
  deleteFlywheelBinding(entityId: EntityId): void;
  createCodingProject(project: {
    id: string;
    entityId: EntityId;
    sandboxId: string;
    name: string;
    sourceType: "empty" | "git" | "archive";
    sourceLocator?: string;
    guestPath: string;
    activeBranch?: string;
    baseRevision?: string;
  }): CodingProjectRow;
  getCodingProject(id: string): CodingProjectRow | null;
  getCodingProjectForEntity(entityId: EntityId, selector: string): CodingProjectRow | null;
  listCodingProjects(entityId: EntityId): CodingProjectRow[];
  deleteCodingProjectsForSandbox(entityId: EntityId, sandboxId: string): void;
  deleteCodingProject(entityId: EntityId, projectId: string, sandboxId: string): void;
  updateCodingProject(
    id: string,
    fields: Partial<{
      activeBranch: string | null;
      baseRevision: string | null;
      dirty: boolean;
      hasUnexportedChanges: boolean;
      exportedFingerprint: string | null;
      lastStatusAt: number | null;
      lastExportedAt: number | null;
    }>,
  ): void;
  createCodingService(service: {
    id: string;
    entityId: EntityId;
    sandboxId: string;
    projectId?: string;
    sessionId: string;
    name: string;
    command: string[];
    guestCwd: string;
    logPath: string;
    pid: number;
    processIdentity: string;
    port?: number;
  }): CodingServiceRow;
  getCodingService(id: string): CodingServiceRow | null;
  getCodingServiceForEntity(entityId: EntityId, selector: string): CodingServiceRow | null;
  listCodingServices(entityId: EntityId): CodingServiceRow[];
  listExpiredCodingServicePublications(now?: number): CodingServiceRow[];
  hasRunningCodingServices(entityId: EntityId, sandboxId: string): boolean;
  recordFlywheelOperation(operation: {
    entityId?: EntityId;
    operation: string;
    outcome: "success" | "failure" | "blocked";
    durationMs: number;
    byteCount?: number;
    detail?: string;
  }): void;
  pruneFlywheelOperations(before: number): number;
  getFlywheelOperationSummary(since?: number): FlywheelOperationSummary[];
  updateCodingService(
    id: string,
    fields: Partial<{
      pid: number | null;
      processIdentity: string | null;
      status: string;
      publishedUrl: string | null;
      publishedSubdomain: string | null;
      publicationExpiresAt: number | null;
      lastError: string | null;
      startedAt: number | null;
      stoppedAt: number | null;
    }>,
  ): void;
  stopCodingServicesForSandbox(entityId: EntityId, sandboxId: string, reason: string): void;
  markCodingServicesUnknownForSandbox(entityId: EntityId, sandboxId: string, reason: string): void;
  createCodingServiceProbe(probe: {
    serviceId: string;
    entityId: EntityId;
    sandboxId: string;
    path: string;
    httpStatus?: number;
    durationMs: number;
    success: boolean;
    error?: string;
  }): CodingServiceProbeRow;
  listCodingServiceProbes(serviceId: string, limit?: number): CodingServiceProbeRow[];
  saveFlywheelCredentialBinding(binding: {
    id: string;
    entityId: EntityId;
    sandboxId: string;
    profileName: string;
    purpose: string;
    state: string;
    expiresAt?: number;
    lastError?: string;
  }): void;
  listFlywheelCredentialBindings(entityId: EntityId): FlywheelCredentialBindingRow[];
}

/** Runtime mirror of `FlywheelStore`'s method names — the drift test compares it to the facade. */
export const FLYWHEEL_STORE_METHODS = [
  "saveFlywheelBinding",
  "listFlywheelBindings",
  "getFlywheelBinding",
  "updateFlywheelBinding",
  "deleteFlywheelBinding",
  "createCodingProject",
  "getCodingProject",
  "getCodingProjectForEntity",
  "listCodingProjects",
  "deleteCodingProjectsForSandbox",
  "deleteCodingProject",
  "updateCodingProject",
  "createCodingService",
  "getCodingService",
  "getCodingServiceForEntity",
  "listCodingServices",
  "listExpiredCodingServicePublications",
  "hasRunningCodingServices",
  "recordFlywheelOperation",
  "pruneFlywheelOperations",
  "getFlywheelOperationSummary",
  "updateCodingService",
  "stopCodingServicesForSandbox",
  "markCodingServicesUnknownForSandbox",
  "createCodingServiceProbe",
  "listCodingServiceProbes",
  "saveFlywheelCredentialBinding",
  "listFlywheelCredentialBindings",
] as const satisfies readonly (keyof FlywheelStore)[];

export const FLYWHEEL_STORE_COMPLETE: ExactKeys<FlywheelStore, typeof FLYWHEEL_STORE_METHODS> =
  true;
