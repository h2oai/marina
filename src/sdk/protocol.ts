// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// ─── Identity ────────────────────────────────────────────────────────────────

/** Opaque branded string for entity IDs */
export type EntityId = string & { readonly __brand: "EntityId" };

/** Opaque branded string for room IDs (path-based, e.g. "hub/plaza") */
export type RoomId = string & { readonly __brand: "RoomId" };

export function entityId(id: string): EntityId {
  return id as EntityId;
}

export function roomId(id: string): RoomId {
  return id as RoomId;
}

// ─── Entities ────────────────────────────────────────────────────────────────

/**
 * Entity kinds:
 * - "agent": LLM-connected entities (user-spawned or room agents). Have WebSocket connections, autonomous loops, memory.
 * - "npc": Static room entities spawned as fallback when no LLM keys configured. Limited to hardcoded properties.
 * - "object": Inert items (not currently used for standalone entities, but reserved).
 */
export type EntityKind = "agent" | "npc" | "object";

/**
 * Typed optional fields for well-known Entity.properties keys.
 * Extends Record<string, unknown> so arbitrary keys still work.
 */
export interface KnownProperties extends Record<string, unknown> {
  // ─── Core ───────────────────────────────────────────────────────────────────
  rank?: number;
  role?: string;
  title?: string;
  _isFirstLogin?: boolean;
  _owner?: EntityId;

  // ─── Misc ───────────────────────────────────────────────────────────────────
  active_modal?: string;
  code_profile?: string;
  coding_session_id?: string;
  /** Active task text for a session-bound coding agent — set on assign, cleared on stop/completion. */
  coding_task?: string;
  fragment?: string;

  // ─── Social ─────────────────────────────────────────────────────────────────
  ignore_list?: string[];
  /** Name of the last entity to send this one a `tell` — powers the `re` reply command. */
  last_tell_from?: string;
  /** Durable receipt id for acknowledgement/correlation when replying. */
  last_tell_id?: number;
  bookmarks?: { room: RoomId; note?: string }[];

  // ─── Quest state ────────────────────────────────────────────────────────────
  active_quest?: string;
  completed_quests?: string[];
  quest_sectors?: string[];
  quest_note_count?: number;
  quest_look?: boolean;
  quest_move?: boolean;
  quest_say?: boolean;
  quest_examine?: boolean;
  quest_memory_set?: boolean;
  quest_note?: boolean;
  quest_recall?: boolean;
  quest_reflect?: boolean;
  quest_project_join?: boolean;
  quest_task_claim?: boolean;
  quest_task_submit?: boolean;
  quest_pool_add?: boolean;
  quest_channel_send?: boolean;
  quest_channel_join?: boolean;
  quest_predict?: boolean;
  quest_consensus?: boolean;
  quest_build?: boolean;
  quest_note_link?: boolean;

  // ─── Demo quest flags ───────────────────────────────────────────────────────
  quest_entered_workshop?: boolean;
  quest_agent_spawned?: boolean;
  quest_room_built?: boolean;
  quest_visited_creation?: boolean;
  quest_entered_bridge?: boolean;
  quest_gateway_added?: boolean;
  quest_channel_bridged?: boolean;
  quest_cross_message?: boolean;

  // ─── Markets ────────────────────────────────────────────────────────────────
  markets_traded?: number;
  markets_resolved?: number;
  avg_brier?: number;

  // ─── Benchmark best scores ──────────────────────────────────────────────────
  bench_navigation_best?: number;
  bench_retrieval_best?: number;
  bench_codegen_best?: number;
  bench_coordination_best?: number;
  bench_adaptation_best?: number;
  bench_memory_best?: number;
  bench_selfmod_best?: number;
  bench_collaboration_best?: number;
}

export interface Entity {
  id: EntityId;
  kind: EntityKind;
  name: string;
  short: string;
  long: string;
  room: RoomId;
  properties: KnownProperties;
  inventory: EntityId[];
  createdAt: number;
}

export type PerceptionKind =
  | "room" // full room description (from look)
  | "message" // directed message
  | "broadcast" // room-wide message
  | "movement" // someone entered/left
  | "error" // error feedback (gameplay, rate limits, bad commands)
  | "auth_error" // login or token-reconnect rejected — client should clear token
  | "system"; // system notification

export interface Perception {
  kind: PerceptionKind;
  timestamp: number;
  tag?: string;
  data: Record<string, unknown>;
}

/**
 * Payload carried on `data.execApproval` of a perception sent to a coding
 * session's creator when an arbitrary (non-allowlisted) host command needs
 * interactive approval. The human replies with `code exec-approve <token>` or
 * `code exec-deny <token> [reason]`. See src/coding/exec-approver.ts.
 */
export interface ExecApprovalPrompt {
  token: string;
  argv: string[];
  cwd: string;
  rendered: string;
}

export interface RoomPerception extends Perception {
  kind: "room";
  data: {
    id: RoomId;
    short: string;
    long: string;
    items: Record<string, string>;
    exits: string[];
    entities: { id: EntityId; name: string; short: string }[];
  };
}

export interface MessagePerception extends Perception {
  kind: "message";
  data: {
    from: EntityId;
    fromName: string;
    text: string;
  };
}

export interface BroadcastPerception extends Perception {
  kind: "broadcast";
  data: {
    text: string;
  };
}

export interface MovementPerception extends Perception {
  kind: "movement";
  data: {
    entity: EntityId;
    entityName: string;
    direction: "arrive" | "depart";
    exit?: string;
  };
}

export interface ErrorPerception extends Perception {
  kind: "error";
  data: {
    text: string;
  };
}

export interface SystemPerception extends Perception {
  kind: "system";
  data: {
    text: string;
  };
}

export type EntityRank = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
