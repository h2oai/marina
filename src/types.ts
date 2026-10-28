// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CrewFormationName } from "./orchestration/formations/catalogue";
import type { CommandForm, CommandUsage } from "./sdk/command-forms";
import type { CodingCommandTarget } from "./sdk/command-target";
import type { DurableMemoryAPI } from "./sdk/memory-operations";

import type { Entity, EntityId, EntityRank, Perception, RoomId } from "./sdk/protocol";

export * from "./sdk/protocol";

// ─── Rooms ───────────────────────────────────────────────────────────────────

export interface RoomModule {
  short: string;
  long: string | ((ctx: RoomContext, viewer: EntityId) => string);
  items?: Record<string, string | ((ctx: RoomContext, viewer: EntityId) => string)>;
  exits?: Record<string, RoomId>;
  commands?: Record<string, CommandHandler>;
  onEnter?: (ctx: RoomContext, entity: EntityId) => void;
  onLeave?: (ctx: RoomContext, entity: EntityId) => void;
  // May be async. The engine captures rejections so they don't escape as
  // unhandled rejections, but work after the first `await` is NOT counted
  // toward the 200ms tick budget (which guards the synchronous portion).
  onTick?: (ctx: RoomContext) => void | Promise<void>;
  canEnter?: (ctx: RoomContext, entity: EntityId) => true | string;
  /**
   * The room's turn rule (`debate`, `chorus`, `verification`): after each `say`
   * the formation mediator posts one structural line naming the next actor
   * (src/coordination/room-formations.ts). Unset = no turn rule.
   */
  formation?: string;
}

// ─── Commands ────────────────────────────────────────────────────────────────

export interface CommandInput {
  raw: string;
  verb: string;
  args: string;
  tokens: string[];
  entity: EntityId;
  room: RoomId;
}

export type CommandHandler = (ctx: RoomContext, input: CommandInput) => void | Promise<void>;

export interface CommandDef {
  /** Published compatibility payloads; ordinary usage is the command-line grammar. */
  namedTools?: CommandForm[];
  name: string;
  aliases?: string[];
  help: string;
  /** Canonical grammar and optional action metadata used by every interface. */
  usage?: CommandUsage[];
  handler: CommandHandler;
  minRank?: EntityRank;
  /**
   * Display group shared by help and discovery. Builtins must declare a category;
   * opaque extensions without one appear in "Other".
   */
  category?: string;
  /**
   * Safety gate id (see src/engine/safety-gates.ts SAFETY_GATES). When set, the
   * command phase (`CommandPhaseCoordinator`) calls
   * `checkGateForExecution(db, entityId, gate)` INSTEAD of the `minRank` check
   * and `recordGateExecution` on a pass. It authorizes unsupervised
   * competence, a person's approval of this held run (a challenge), the
   * `local` trust profile, `open` posture for earnable gates, or (under
   * `earned` posture) an optimistic run recorded as a pending demonstration;
   * otherwise the run is held for approval. Unsupervised competence comes only
   * from an operator grant, rank promotion (`grantGatesForRank`), or approved
   * runs — never from the router self-recording a demonstration.
   */
  gate?: string;
  /**
   * Read-only forms of a ranked or gated command (`world list`, `position
   * list`, `admin decisions`): when this returns true for the parsed input,
   * the router applies neither `minRank` nor `gate`. The write forms stay
   * behind both; the handler's own inline checks still apply.
   */
  readOnlyForm?: (input: CommandInput) => boolean;
  /**
   * Subcommands whose arguments carry credentials (`key add`, `connect auth`).
   * The recorded `command` event keeps only `<verb> <subcommand> [redacted]`
   * for these; `"*"` covers every form. See src/engine/command-redaction.ts.
   */
  sensitiveSubcommands?: readonly string[];
  /**
   * Plumbing subcommands a runtime issues on every agent turn (`memory api`
   * checkpoints): they record no `command` event at all, so the row-bounded
   * event log keeps the world's actions instead of its bookkeeping. Usage is
   * still counted. See `isUnloggedForm` in src/engine/command-redaction.ts.
   */
  unloggedSubcommands?: readonly string[];
}

// ─── Room Context (injected into room modules) ──────────────────────────────

export interface RoomContext {
  /** Explicit destination for this command only; code handlers validate access before use. */
  readonly codingTarget?: CodingCommandTarget;
  /** All entities currently in this room */
  entities: Entity[];

  /** Send a message to a specific entity */
  send(target: EntityId, message: string, tag?: string, metadata?: Record<string, unknown>): void;

  /** Broadcast a message to all entities in the room */
  broadcast(message: string, tag?: string): void;

  /** Broadcast to all except one entity */
  broadcastExcept(
    exclude: EntityId,
    message: string,
    tag?: string,
    metadata?: Record<string, unknown>,
  ): void;

  /** Get an entity by ID (if in this room) */
  getEntity(id: EntityId): Entity | undefined;

  /** Find entity by name (partial match, in this room) */
  findEntity(name: string): Entity | undefined;

  /** Room-scoped persistent key-value store */
  store: KeyValueStore;

  /** Spawn an NPC in this room */
  spawn(opts: {
    name: string;
    short: string;
    long: string;
    properties?: Record<string, unknown>;
  }): EntityId;

  /** Remove an NPC from this room */
  despawn(entityId: EntityId): boolean;

  /** Board API (available when db-backed) */
  boards?: RoomBoardAPI;

  /** Channel API (available when db-backed) */
  channels?: RoomChannelAPI;

  /** Rate-limited HTTP GET (max 1 req/10s per room, 5s timeout, GET only) */
  fetch?(url: string): Promise<{ status: number; body: string } | { error: string }>;

  /** The current room's ID */
  roomId: RoomId;

  /** Send a brief orientation to an entity */
  brief?: (entityId: EntityId) => void;

  /** Emit an engine event (for feed/canvas propagation from room modules) */
  logEvent?(event: EngineEvent): void;

  /**
   * Write a Sample (point-in-time observation) — triggers the calibration
   * loop, links to a watch spec if one is supplied, and emits a feed event
   * for resolved/changed statuses. Lets room handlers participate in the
   * resolver substrate without holding a db reference. See
   * src/resolvers/sample-writer.ts for the underlying writer.
   */
  writeSample?(params: {
    sample: import("./resolvers/types").Sample;
    authorName?: string;
    watchSpecNoteId?: number;
    previousSampleNoteId?: number;
  }): { noteId: number; emittedFeedEvent: boolean };

  /**
   * File a resident's in-world forecast on the one outcome path
   * (`fileResidentForecast` in src/outcomes/filing.ts): it resolves with its
   * Sample, earns standing and teaches lessons. Returns the answer id, or
   * undefined when nothing was filed (no database, or the write failed).
   */
  fileForecast?(params: import("./outcomes/filing").ResidentForecast): number | undefined;

  /** Spawn an AI agent (available when agent runtime is active) */
  spawnAgent?(config: {
    name: string;
    model?: string;
    role?: string;
    goal?: string;
  }): Promise<{ name: string; entityId: string | null } | null>;

  /** Spawn an LLM-connected room agent (falls back gracefully if no API keys) */
  spawnRoomAgent?(config: {
    name: string;
    role?: string;
    goal?: string;
    model?: string;
  }): Promise<{ entityId: string | null } | null>;
}

// ─── Command Context (extended context for dynamic commands) ─────────────────

export interface McpAPI {
  /** Call a tool on an MCP server */
  call(server: string, tool: string, args: Record<string, unknown>): Promise<unknown>;
  /** List tools available on a server */
  listTools(server: string): Promise<{ name: string; description?: string }[]>;
  /** List registered MCP servers */
  listServers(): string[];
}

export interface HttpAPI {
  /** HTTP GET (rate-limited, 10s timeout) */
  get(url: string): Promise<{ status: number; body: string } | { error: string }>;
  /** HTTP POST (rate-limited, 10s timeout) */
  post(url: string, body: string): Promise<{ status: number; body: string } | { error: string }>;
}

export interface NotesAPI {
  /** Scored retrieval of notes */
  recall(query: string): { id: number; content: string; importance: number; score: number }[];
  /** Full-text search of notes */
  search(query: string): { id: number; content: string; importance: number }[];
  /** @deprecated New features use durableMemory.run({ operation: "remember", ... }).
   * Numeric notes remain a compatibility surface. */
  add(content: string, importance?: number, noteType?: string): number;
}

export interface MemoryAPI {
  /** Get a core memory value */
  get(key: string): string | undefined;
  /** Set a core memory value */
  set(key: string, value: string): void;
  /** List all core memory entries */
  list(): { key: string; value: string }[];
}

export interface PoolAPI {
  /** Recall notes from a pool */
  recall(poolName: string, query: string): { id: number; content: string; score: number }[];
  /** Add a note to a pool */
  add(poolName: string, content: string, importance?: number): void;
}

export interface CommandContext extends RoomContext {
  /** MCP connector API (call external MCP servers) */
  mcp: McpAPI;
  /** HTTP API (rate-limited GET/POST) */
  http: HttpAPI;
  /** Canonical durable record API, scoped to the calling world account. */
  durableMemory: DurableMemoryAPI;
  /** Legacy numeric notes (scoped to calling entity). New features use durableMemory. */
  notes: NotesAPI;
  /** Core memory API (scoped to calling entity) */
  memory: MemoryAPI;
  /** Pool API (shared memory pools) */
  pool: PoolAPI;
  /** Information about the calling entity */
  caller: { id: EntityId; name: string; rank: number };
}

// ─── Room Board API (subset exposed to room modules) ────────────────────────

export interface RoomBoardAPI {
  /** Get a board by name */
  getBoard(name: string): { id: string; name: string } | undefined;

  /** List posts on a board */
  listPosts(
    boardId: string,
    limit?: number,
  ): {
    id: number;
    title: string;
    body: string;
    authorName: string;
    createdAt: number;
  }[];

  /** Create a post on a board */
  post(boardId: string, authorId: string, authorName: string, title: string, body: string): number;

  /** Search posts on a board */
  search(
    boardId: string,
    query: string,
  ): {
    id: number;
    title: string;
    body: string;
    authorName: string;
  }[];
}

// ─── Room Channel API (subset exposed to room modules) ──────────────────────

export interface RoomChannelAPI {
  /** Send a message to a named channel */
  send(channelName: string, senderId: string, senderName: string, content: string): void;

  /** Get recent history from a channel, including the server-recorded sender identity. */
  history(
    channelName: string,
    limit?: number,
  ): {
    senderId?: string;
    senderName: string;
    content: string;
    createdAt: number;
  }[];

  /**
   * Subscribe to messages sent to a named channel.
   * Returns an unsubscribe function — call it to remove the listener.
   * Register once per room (guard with ctx.store to avoid re-registering on every tick).
   */
  onMessage(
    channelName: string,
    handler: (senderId: string, senderName: string, content: string) => void,
  ): () => void;
}

// ─── Key-Value Store ─────────────────────────────────────────────────────────

export interface KeyValueStore {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
  delete(key: string): boolean;
  keys(): string[];
}

// ─── Perceptions (what gets delivered to connections) ────────────────────────

// ─── Connection ──────────────────────────────────────────────────────────────

export type ConnectionProtocol = "websocket" | "telnet" | "mcp";

export interface Connection {
  id: string;
  protocol: ConnectionProtocol;
  entity: EntityId | null;
  connectedAt: number;
  /** Client IP when known (WebSocket/telnet); undefined for MCP/in-process. Header-derived (X-Forwarded-For / X-Real-IP) for WebSocket — SPOOFABLE. Use ONLY for rate-limiting/display, NEVER as a trust anchor. */
  ip?: string;
  /**
   * Real, unspoofable socket peer address (WebSocket `server.requestIP`, telnet `socket.remoteAddress`,
   * or a loopback sentinel for genuinely in-process/internal transports). Unlike `ip`, this is NEVER
   * derived from client-controlled headers. This is the ONLY field permitted as an exec/loopback TRUST
   * anchor (see `isLoopbackConnection`). Undefined when the real peer address could not be determined —
   * treat undefined as untrusted (fail closed), never as loopback.
   */
  peerIp?: string;
  /** True for internal room/crew agent connections (exempt from instance login limits). */
  internal?: boolean;
  /**
   * The client declared itself an agent (SDK `principal: "agent"`, the
   * default for `MarinaClient`). Self-declared, so it can only REMOVE
   * authority — people answer challenges, agents never do — never add it.
   */
  agent?: boolean;
  /** An in-process connection whose arrival and departure are not announced to the room (a scheduled run). */
  quiet?: boolean;
  send(perception: Perception): void;
  close(): void;
}

// ─── Ranks ──────────────────────────────────────────────────────────────────

export const RANK_NAMES: Record<EntityRank, string> = {
  0: "newcomer",
  1: "canvas",
  2: "coordinator",
  3: "organizer",
  4: "builder",
  5: "architect",
  6: "engineer",
  7: "steward",
  8: "guardian",
  9: "sovereign",
};

// ─── Crews ───────────────────────────────────────────────────────────────────

/** Opaque branded id for crews — `crew-<8hex>`. */
export type CrewId = string & { readonly __brand: "CrewId" };

export function crewId(id: string): CrewId {
  return id as CrewId;
}

/**
 * A crew runs a formation from the catalogue
 * (src/orchestration/formations/catalogue.ts): every entry with `crew: true`.
 * `freeform` is the no-protocol default — bound members, no prescribed
 * coordination shape.
 */
export type CrewFormation = CrewFormationName;

/**
 * Ephemeral crews live only in memory and GC on idle. Persisted crews survive
 * restarts (DB-backed) and get a dedicated memory pool. Default = ephemeral —
 * runtime-favored, autonomous, emergent. Upgrade with `crew persist`.
 */
export type CrewLifetime = "ephemeral" | "persisted";

export type CrewState = "assembling" | "active" | "completing" | "dissolved";

export interface CrewMember {
  /** Agent name as registered in `AgentRuntime` (matches `AgentHandle.name`). */
  agentName: string;
  /** Role within the crew — lead | specialist | reviewer | observer | (custom). */
  role: string;
  joinedAt: number;
}

export interface CrewInvitation {
  crewId: CrewId;
  crewName: string;
  agentName: string;
  role: string;
  invitedBy: string;
  status: "pending" | "accepted" | "declined" | "expired" | "revoked";
  createdAt: number;
  expiresAt: number;
  respondedAt?: number;
}

export interface CrewResult {
  summary: string;
  noteIds: number[];
  at: number;
}

export interface Crew {
  id: CrewId;
  /** Human-friendly, unique per engine. */
  name: string;
  goal: string;
  formation: CrewFormation;
  lifetime: CrewLifetime;
  /** Creator / dispatcher — used for default rank gating + result deposit. */
  ownerId: EntityId;
  members: CrewMember[];
  /** Lazily provisioned `crew:<id>` channel. Undefined until first dispatch. */
  channelId?: string;
  /** Persisted crews only — `crew:<name>` memory pool id. */
  poolId?: string;
  state: CrewState;
  createdAt: number;
  /** Updated on dispatch / member churn / channel traffic — drives idle GC. */
  lastActivityAt: number;
  result?: CrewResult;
  /** False: an internal crew (Code Mode) with no `model-<name>` endpoint. Unset: it serves. */
  serves?: false;
}

// ─── Events (internal engine events) ─────────────────────────────────────────

/**
 * A span link: one more trace an agent span worked on besides its parent
 * (OpenTelemetry-style). A turn that handles two requests at once, or that
 * acts on work handed over from a request, links every originating trace.
 */
export interface TraceLink {
  traceId: string;
  spanId: string;
}

export type EngineEvent =
  | { type: "command"; entity: EntityId; input: string; timestamp: number }
  | { type: "tick"; timestamp: number }
  | { type: "connect"; connectionId: string; protocol: ConnectionProtocol; timestamp: number }
  | { type: "disconnect"; connectionId: string; timestamp: number }
  /** `name` is the entity's display name at the time, so a reader can name someone already gone. */
  | { type: "entity_enter"; entity: EntityId; name?: string; room: RoomId; timestamp: number }
  | { type: "entity_leave"; entity: EntityId; name?: string; room: RoomId; timestamp: number }
  | { type: "task_claimed"; entity: EntityId; taskId: number; timestamp: number }
  | { type: "task_submitted"; entity: EntityId; taskId: number; timestamp: number }
  | {
      type: "task_approved";
      entity: EntityId;
      taskId: number;
      /** The claimant whose submission was approved (lessons from work). */
      claimantName?: string;
      timestamp: number;
    }
  | {
      type: "task_rejected";
      entity: EntityId;
      taskId: number;
      /** The claimant whose submission was rejected (lessons from work). */
      claimantName?: string;
      timestamp: number;
    }
  | {
      type: "task_released";
      entity: EntityId;
      taskId: number;
      reason: "lease_expired";
      timestamp: number;
    }
  | {
      type: "canvas_publish";
      entity: EntityId;
      canvasId: string;
      nodeId: string;
      timestamp: number;
    }
  | {
      type: "canvas_node_updated";
      entity: EntityId;
      canvasId: string;
      nodeId: string;
      timestamp: number;
    }
  | {
      type: "canvas_intent";
      entity: EntityId;
      canvasId: string;
      nodeId: string;
      prompt: string;
      status: "pending" | "active" | "done" | "failed";
      timestamp: number;
    }
  | {
      type: "board_post";
      entity: EntityId;
      postId: number;
      boardId: string;
      boardName: string;
      title: string;
      body: string;
      parentId?: number;
      timestamp: number;
    }
  | {
      type: "pool_note";
      entity: EntityId;
      noteId: number;
      poolName: string;
      content: string;
      importance: number;
      timestamp: number;
    }
  | {
      type: "channel_message";
      entity: EntityId;
      /** The stored `channel_messages.id` (feed ref `channel_msg:<id>`). */
      messageId: number;
      channelName: string;
      content: string;
      /** Causal envelope (`src/engine/message-envelope.ts`). */
      cause?: string;
      depth?: number;
      timestamp: number;
    }
  /**
   * Room speech was delivered. Content-free by design: names, refs and the
   * causal envelope only (`src/engine/message-envelope.ts`); the words stay in
   * the perceptions of those present.
   */
  | {
      type: "say_sent";
      entity: EntityId;
      /** Sender name. */
      from: string;
      room: RoomId;
      messageRef: string;
      cause?: string;
      depth: number;
      timestamp: number;
    }
  /**
   * A supervised resident's attention bridge kept a world perception
   * (src/routing/attention-bridge.ts): `now` woke or steered it, `next` and
   * `context` wait for its next digest. Names and reasons only.
   */
  | {
      type: "attention_wake";
      name: string;
      source: string;
      decision: "now" | "next" | "context";
      steered: boolean;
      timestamp: number;
    }
  /** A supervised resident's presence changed (idle, running, waiting for its owner…). */
  | {
      type: "agent_status";
      name: string;
      status: "starting" | "idle" | "running" | "waiting" | "stopped" | "failed" | "disconnected";
      /** How world messages reach it while it works. */
      steer: "mid-turn" | "next-turn" | "none";
      timestamp: number;
    }
  /**
   * A room formation's mediator posted its structural line
   * (src/coordination/room-formations.ts). Names only: who is now owed.
   */
  | {
      type: "room_formation_turn";
      room: RoomId;
      formation: string;
      phase: "open" | "turn" | "close" | "closed";
      next: string[];
      timestamp: number;
    }
  /** A direct message (`tell` / `re`) was delivered. Content-free, like `say_sent`. */
  | {
      type: "tell_sent";
      entity: EntityId;
      /** Sender name. */
      from: string;
      /** Recipient name. */
      to: string;
      messageRef: string;
      cause?: string;
      depth: number;
      timestamp: number;
    }
  /**
   * Code review lifecycle (`code review request|verdict|approve|reject`).
   * Content-free: names, ids and outcomes only; the diff, claims and findings
   * stay in the review's artifacts.
   */
  | {
      type: "review_requested";
      entity: EntityId;
      reviewId: string;
      author: string;
      reviewer: string;
      round: number;
      /** How the reviewer was chosen: named, or `auto`'s tier. */
      basis: string;
      timestamp: number;
    }
  | {
      type: "review_verdict";
      entity: EntityId;
      reviewId: string;
      author: string;
      reviewer: string;
      verdict: "approve" | "rework";
      round: number;
      timestamp: number;
    }
  | {
      type: "review_closed";
      entity: EntityId;
      reviewId: string;
      author: string;
      outcome: "merged" | "rejected";
      /** The closing person decided against (or without) the reviewer's verdict. */
      override: boolean;
      timestamp: number;
    }
  | {
      type: "market_position";
      entity: EntityId;
      room: RoomId;
      question: string;
      direction: "yes" | "no";
      confidence: number;
      reasoning: string;
      updated: boolean;
      timestamp: number;
    }
  | {
      type: "market_consensus";
      entity: EntityId;
      room: RoomId;
      question: string;
      yesPercent: number;
      noPercent: number;
      participants: number;
      agreement: number;
      timestamp: number;
    }
  | {
      type: "agent_spawn";
      entity: EntityId;
      name: string;
      model: string;
      role: string;
      timestamp: number;
    }
  | {
      type: "agent_stop";
      entity: EntityId;
      name: string;
      reason: string;
      timestamp: number;
    }
  | {
      type: "agent_error";
      name: string;
      error: string;
      timestamp: number;
    }
  // Harness decision (src/decisions): route / gate / verify verdict with the
  // decision model's numbers. Carries the tool NAME only, never arguments.
  | {
      type: "agent_decision";
      name: string;
      stage:
        | "gate"
        | "route"
        | "verify"
        | "check"
        | "choose"
        | "repair"
        | "argcheck"
        | "media_verify";
      verdict: string;
      subject: string;
      reason: string;
      signals: Record<string, number | string>;
      provider?: string;
      model?: string;
      latencyMs?: number;
      costUsd?: number;
      error?: string;
      /** Gate on `marina/auto`: whether a second opinion was asked for, and its fate. */
      escalated?: boolean;
      secondOpinion?: "used" | "partial" | "timeout" | "failed" | "outage";
      timestamp: number;
    }
  // A default resolved through `resolveDefault` (src/engine/default-resolution.ts):
  // which layer answered (env / local slot / family slot / upstream seed /
  // built-in), from which key, and why earlier layers did not. Names and ids
  // only — never question or answer content.
  | {
      type: "default_resolved";
      slot: string;
      surface?: string;
      source: "env" | "slot" | "family" | "upstream" | "builtin";
      key: string;
      value: string;
      incumbentRunId?: string;
      /** Upstream model seeds withheld pending local approval (`<slot>@upstream:<version>`). */
      withheld?: string[];
      reason: string;
      timestamp: number;
    }
  // Lifecycle state transition (connected → autonomous → stopped, etc.).
  // Fires at milestones only (not per turn), so observers can refresh an
  // agent's displayed state live without polling.
  | {
      type: "agent_state_change";
      name: string;
      state: "starting" | "connected" | "autonomous" | "idle" | "stopping" | "stopped" | "error";
      timestamp: number;
    }
  // Per-agent LLM lifecycle — observers (dashboard, MCP, gateway peers)
  // use these to render "agent is mid-thought" state, streaming thought,
  // and turn boundaries.
  | {
      type: "agent_turn_start";
      memoryReceipt?: string;
      name: string;
      runId?: string;
      traceId?: string;
      spanId?: string;
      parentSpanId?: string;
      /** Other request traces this span also served (span links, never parents). */
      links?: TraceLink[];
      origin?: "autonomous" | "request";
      model?: string;
      // Prompt-budget metrics (bytes, never text): total continuation prompt,
      // one entry per section in assembly order with whether the section was
      // deferred (re-queued past the budget), plus the fixed system-prompt and
      // resident tool-schema sizes of this turn. Aggregated by
      // `trace stats` / `/api/ops/overview` (`prompt.sections`).
      promptBytes?: number;
      promptSections?: Array<{ name: string; bytes: number; deferred: boolean }>;
      systemPromptBytes?: number;
      residentSchemaBytes?: number;
      timestamp: number;
    }
  | {
      type: "agent_turn_end";
      name: string;
      runId?: string;
      traceId?: string;
      spanId?: string;
      parentSpanId?: string;
      /** Other request traces this span also served (span links, never parents). */
      links?: TraceLink[];
      origin?: "autonomous" | "request";
      model?: string;
      hadToolCalls: boolean;
      toolCount: number;
      durationMs?: number;
      ttftMs?: number;
      inputTokens?: number;
      outputTokens?: number;
      /** Hidden reasoning (thinking) tokens the provider reported — a share of `outputTokens`. */
      reasoningTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      costUsd?: number;
      timestamp: number;
    }
  | {
      type: "agent_tool_call";
      name: string;
      toolName: string;
      runId?: string;
      traceId?: string;
      spanId?: string;
      parentSpanId?: string;
      /** Other request traces this span also served (span links, never parents). */
      links?: TraceLink[];
      risk?: "read" | "self" | "communicate" | "egress" | "mutate" | "consequential";
      trustSources?: string[];
      timestamp: number;
    }
  | {
      type: "agent_tool_result";
      name: string;
      toolName: string;
      runId?: string;
      traceId?: string;
      spanId?: string;
      parentSpanId?: string;
      /** Other request traces this span also served (span links, never parents). */
      links?: TraceLink[];
      isError: boolean;
      /** `autonomous` (the agent's own cycle) or `request` (serving a caller); from the tracer. */
      origin?: "autonomous" | "request";
      /**
       * A mechanical class of a failed result (`classifyToolError`: `not-found`,
       * `invalid-args`, …), also set for a soft failure a command tool reported
       * as text (`softFailureClass`). The label only — never the result text.
       */
      errorClass?: string;
      timestamp: number;
    }
  | {
      type: "agent_text_delta";
      name: string;
      delta: string;
      runId?: string;
      traceId?: string;
      spanId?: string;
      parentSpanId?: string;
      /** Other request traces this span also served (span links, never parents). */
      links?: TraceLink[];
      timestamp: number;
    }
  | {
      type: "agent_thinking_delta";
      name: string;
      delta: string;
      runId?: string;
      traceId?: string;
      spanId?: string;
      parentSpanId?: string;
      /** Other request traces this span also served (span links, never parents). */
      links?: TraceLink[];
      timestamp: number;
    }
  // Request-level lifecycle for causal demo timelines. These deliberately sit
  // above token/turn events: one request may span several agents and turns.
  | {
      type: "model_request_lifecycle";
      phase: "received" | "routed" | "fast_path" | "completed" | "failed";
      requestId: string;
      /** User-visible execution identity. Equal to requestId for the first
       * traced model-request path; kept explicit so later multi-request runs
       * can retain one stable run identity. */
      runId?: string;
      /** Causal trace identity propagated to child agent/tool spans. */
      traceId?: string;
      /** Root request span. Lifecycle events for one request share this id. */
      spanId?: string;
      model: string;
      target?: string;
      /** Channel member whose correlated reply fulfilled the request, when it
       * was not the routed `target`. Absent when the target answered. */
      respondedBy?: string;
      routeStrategy?: "round-robin" | "least-busy" | "adaptive";
      candidateCount?: number;
      routeAdviceMode?: "pareto" | "explore" | "insufficient";
      routeReason?: string;
      /** Execution path selected at the model endpoint boundary. `direct`: an
       * in-process library call through `src/model` (forecast, lessons, …). */
      routeKind?: "agent" | "passthru" | "fallback" | "synthesis" | "direct";
      /** Parent span when the call belongs to a larger traced unit of work. */
      parentSpanId?: string;
      /** What a `direct` call was for (`src/model/purpose.ts`): forecast, lessons, … */
      purpose?: string;
      /** Caller-supplied trace context of a `direct` call: caller, task, round, question. */
      traceContext?: Record<string, string>;
      /** Resolved passthru identity for per-caller attribution (light
       * governance). Absent on anonymous/internal-routed requests. */
      entityId?: string;
      /** JSON `marina.memory.receipt.v1` — which memory tiers/ids were injected
       * into a proxied request (`src/net/memory-receipt.ts`). Passthru only. */
      memoryReceipt?: string;
      /** Protocol surface the passthru request arrived on
       * (`InjectionFormat`, `src/net/passthru-context.ts`), NOT the route
       * kind. Ollama `/api/chat` is OpenAI-shaped and reports `openai`. */
      surface?: "openai" | "anthropic" | "ollama-generate" | "responses";
      durationMs?: number;
      ttftMs?: number;
      inputTokens?: number;
      outputTokens?: number;
      /** Reasoning (thinking) tokens the upstream reported, a share of
       * `outputTokens` (`usage.completion_tokens_details.reasoning_tokens`,
       * Anthropic `output_tokens_details.thinking_tokens`). Absent when the
       * upstream reported none. */
      reasoningTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      costUsd?: number;
      /** The output cap Marina applied (the cheap tier's default, when the
       * caller set none — `src/net/model/tier-output-cap.ts`). */
      outputCap?: number;
      /** True when the reply ended on that cap (`finish_reason: length`). */
      outputCapHit?: boolean;
      errorKind?:
        | "auth"
        | "quota"
        | "rate_limit"
        | "timeout"
        | "network"
        | "provider"
        | "cancelled"
        | "unavailable"
        | "unknown";
      detail?: string;
      timestamp: number;
    }
  | {
      type: "key_change";
      provider: string;
      action: "set" | "delete";
      actor: EntityId;
      timestamp: number;
    }
  | {
      type: "rank_change";
      entity: EntityId;
      name: string;
      oldRank: number;
      newRank: number;
      direction: "promoted" | "demoted";
      timestamp: number;
    }
  | {
      type: "adapter_change";
      platform: string;
      action: "enable" | "disable";
      actor: EntityId;
      timestamp: number;
    }
  | {
      type: "note_created";
      entity: EntityId;
      noteId: number;
      authorName: string;
      content: string;
      importance: number;
      noteType: string;
      roomId?: RoomId;
      poolId?: string;
      timestamp: number;
    }
  | {
      type: "note_deleted";
      entity: EntityId;
      noteId: number;
      timestamp: number;
    }
  | {
      type: "note_link_created";
      entity: EntityId;
      sourceId: number;
      targetId: number;
      relationship: string;
      timestamp: number;
    }
  | {
      type: "note_link_deleted";
      entity: EntityId;
      sourceId: number;
      targetId: number;
      relationship: string;
      timestamp: number;
    }
  | {
      type: "recall_trace";
      entity: EntityId;
      query: string;
      seedNoteIds: number[];
      activatedNoteIds: number[];
      timestamp: number;
    }
  | {
      type: "feed_event";
      kind: string;
      entity?: EntityId;
      ref?: string;
      summary: string;
      payload?: Record<string, unknown>;
      timestamp: number;
    }
  // Asset record lifecycle (src/engine/media/asset-library.ts). Ids, owner
  // name and MIME only — never captions, prompts or bytes; viewers reread the
  // asset under their own credential. Delivered to the owner and operators.
  | {
      type: "asset_created" | "asset_updated" | "asset_deleted";
      entity?: EntityId;
      assetId: string;
      owner: string;
      mime: string;
      timestamp: number;
    }
  | {
      type: "canvas_edge_created";
      entity: EntityId;
      canvasId: string;
      edgeId: string;
      sourceId: string;
      targetId: string;
      relationship: string;
      timestamp: number;
    }
  | {
      type: "canvas_edge_deleted";
      entity: EntityId;
      canvasId: string;
      edgeId: string;
      timestamp: number;
    }
  | {
      type: "canvas_deleted";
      entity: EntityId;
      canvasId: string;
      name: string;
      timestamp: number;
    }
  | {
      type: "crew_created";
      crew: CrewId;
      name: string;
      owner: EntityId;
      formation: CrewFormation;
      lifetime: CrewLifetime;
      timestamp: number;
    }
  | {
      type: "crew_member_joined";
      crew: CrewId;
      agentName: string;
      role: string;
      timestamp: number;
    }
  | {
      type: "crew_member_left";
      crew: CrewId;
      agentName: string;
      reason: "left" | "stopped" | "kicked";
      timestamp: number;
    }
  | {
      type: "crew_state_changed";
      crew: CrewId;
      from: CrewState;
      to: CrewState;
      timestamp: number;
    }
  | {
      type: "crew_completed";
      crew: CrewId;
      resultNoteId?: number;
      timestamp: number;
    }
  | {
      type: "crew_dissolved";
      crew: CrewId;
      reason: string;
      timestamp: number;
    }
  | {
      type: "crew_member_stalled";
      crew: CrewId;
      agentName: string;
      reason: string;
      offenseCount: number;
      timestamp: number;
    }
  | {
      type: "crew_stage_completed";
      crew: CrewId;
      stage: string;
      agentName: string;
      timestamp: number;
    }
  | {
      type: "crew_artifact_deposited";
      crew: CrewId;
      agentName: string;
      artifactRef: string;
      kind: "map" | "reduce" | "synthesis" | "draft";
      timestamp: number;
    }
  // Content-free hints. Readers fetch fresh, caller-authorized resource snapshots.
  | { type: "resource_changed"; resource: "coding" | "participant"; id?: string; timestamp: number }
  // Memory observability (src/net/memory-observability.ts): polled from the
  // durable service's `memory_service_events` and broadcast to dashboard
  // clients. Both carry ids, names and states ONLY — never task/answer text or
  // record content; content is fetched per-principal over REST.
  | {
      type: "memory_job";
      job: Omit<
        import("./net/memory/memory-observability-types").MemoryJobView,
        "task" | "answer" | "citations"
      >;
      timestamp: number;
    }
  | {
      type: "memory_service_event";
      kind: string;
      spaceId: string;
      spaceName?: string;
      ownerName?: string;
      referenceId?: string;
      version?: number;
      actorName?: string;
      seq: number;
      timestamp: number;
    }
  // Lifecycle of a coordination container (project / group / channel / pool /
  // board / connector / command). These resources have no high-frequency
  // content event of their own (unlike board_post / channel_message), so the
  // dashboard's Coordination panel had no way to refresh their lists live on
  // create/update/delete — it sat on the 30s poll. One generic event keeps the
  // event surface small while letting every list graduate to realtime.
  | {
      type: "coordination_change";
      resource:
        | "project"
        | "group"
        | "channel"
        | "pool"
        | "board"
        | "connector"
        | "command"
        | "room";
      action: "create" | "update" | "delete";
      entity: EntityId;
      name?: string;
      timestamp: number;
    };
