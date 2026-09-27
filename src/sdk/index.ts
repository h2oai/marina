// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// ─── Marina SDK ────────────────────────────────────────────────────────────

export type { CapabilityManifest, CommandCatalogEntry } from "./capabilities";
export { renderCapabilityRoster } from "./capabilities";
export type { ClientOptions, RoomView, SessionInfo } from "./client";
export { MarinaAgent, MarinaClient } from "./client";
export type { CommandField, CommandForm, CommandUsage } from "./command-forms";
export {
  commandFormPrefix,
  compileCommandForms,
  composeCommand,
  matchCommandForm,
} from "./command-forms";
export { commandInputSchema } from "./command-schema";
export type * from "./extensions";
export { EXTENSION_API_VERSION } from "./extensions";
export type { UnifiedContextResult } from "./memory-context";
export type { DurableMemoryAPI, MemoryOperationRequest } from "./memory-operations";
export type { ParticipantOrientation } from "./onboarding";
// Re-export core types
export type {
  BroadcastPerception,
  Entity,
  EntityId,
  EntityKind,
  EntityRank,
  ErrorPerception,
  MessagePerception,
  MovementPerception,
  Perception,
  PerceptionKind,
  RoomId,
  RoomPerception,
  SystemPerception,
} from "./protocol";
export type { RoutingClientOptions } from "./routing-client";
export { MarinaRoutingClient, RoutingApiError } from "./routing-client";
export type * from "./routing-types";
