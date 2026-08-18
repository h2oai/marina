// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// ─── Marina SDK ────────────────────────────────────────────────────────────

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
} from "../types";
export type { ClientOptions, RoomView, SessionInfo } from "./client";
export { MarinaAgent, MarinaClient } from "./client";
