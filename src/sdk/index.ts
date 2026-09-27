// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// ─── Marina SDK ────────────────────────────────────────────────────────────

export type { ClientOptions, RoomView, SessionInfo } from "./client";
export { MarinaAgent, MarinaClient } from "./client";
export type * from "./extensions";
export { EXTENSION_API_VERSION } from "./extensions";
export type { DurableMemoryAPI, MemoryOperationRequest } from "./memory-operations";
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
