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
  name: string;
  aliases?: string[];
  help: string;
  handler: CommandHandler;
  minRank?: EntityRank;
  /**
   * Display group for `help`. When set, it wins over the name→category map
   * in help.ts, letting a command document its own category instead of
   * relying on that hand-maintained list. Commands with neither a `category`
   * nor a map entry fall into "Other" — a state the help-coverage test
   * forbids, so every primitive stays documented.
   */
  category?: string;
  /**
   * Safety gate id (see src/engine/safety-gates.ts SAFETY_GATES). When
   * set, the command-router checks `checkGate(db, entityId, gate)` after
   * the standard `minRank` check. A failed gate refuses the command with
   * the gate's reason; a supervised-only result also runs the handler but
   * expects the handler to record a demonstration via
   * `recordDemonstration()` on success.
   */
  gate?: string;
}

// ─── Room Context (injected into room modules) ──────────────────────────────

export interface RoomContext {
  /** All entities currently in this room */
  entities: Entity[];

  /** Send a message to a specific entity */
  send(target: EntityId, message: string, tag?: string, metadata?: Record<string, unknown>): void;

  /** Broadcast a message to all entities in the room */
  broadcast(message: string, tag?: string): void;

  /** Broadcast to all except one entity */
  broadcastExcept(exclude: EntityId, message: string, tag?: string): void;

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
  /** Add a note */
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
  /** Notes API (scoped to calling entity) */
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

  /** Get recent history from a channel */
  history(
    channelName: string,
    limit?: number,
  ): {
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

// ─── Connection ──────────────────────────────────────────────────────────────

export type ConnectionProtocol = "websocket" | "telnet" | "mcp";

export interface Connection {
  id: string;
  protocol: ConnectionProtocol;
  entity: EntityId | null;
  connectedAt: number;
  /** Client IP when known (WebSocket/telnet); undefined for MCP/in-process. */
  ip?: string;
  /** True for internal room/crew agent connections (exempt from instance login limits). */
  internal?: boolean;
  send(perception: Perception): void;
  close(): void;
}

// ─── Ranks ──────────────────────────────────────────────────────────────────

export type EntityRank = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

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
 * Crew formations are the runtime form of the 10 orchestration patterns
 * (src/world/templates/orchestration.ts). `freeform` is the no-formation
 * default — bound members, no prescribed coordination shape.
 */
export type CrewFormation =
  | "nsed"
  | "chorus"
  | "foundry"
  | "swarm"
  | "pipeline"
  | "debate"
  | "mapreduce"
  | "blackboard"
  | "symbiosis"
  | "research"
  | "freeform";

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
}

// ─── Events (internal engine events) ─────────────────────────────────────────

export type EngineEvent =
  | { type: "command"; entity: EntityId; input: string; timestamp: number }
  | { type: "tick"; timestamp: number }
  | { type: "connect"; connectionId: string; protocol: ConnectionProtocol; timestamp: number }
  | { type: "disconnect"; connectionId: string; timestamp: number }
  | { type: "entity_enter"; entity: EntityId; room: RoomId; timestamp: number }
  | { type: "entity_leave"; entity: EntityId; room: RoomId; timestamp: number }
  | { type: "task_claimed"; entity: EntityId; taskId: number; timestamp: number }
  | { type: "task_submitted"; entity: EntityId; taskId: number; timestamp: number }
  | { type: "task_approved"; entity: EntityId; taskId: number; timestamp: number }
  | { type: "task_rejected"; entity: EntityId; taskId: number; timestamp: number }
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
      messageId: number;
      channelName: string;
      content: string;
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
      name: string;
      timestamp: number;
    }
  | {
      type: "agent_turn_end";
      name: string;
      hadToolCalls: boolean;
      toolCount: number;
      timestamp: number;
    }
  | {
      type: "agent_text_delta";
      name: string;
      delta: string;
      timestamp: number;
    }
  | {
      type: "agent_thinking_delta";
      name: string;
      delta: string;
      timestamp: number;
    }
  // Request-level lifecycle for causal demo timelines. These deliberately sit
  // above token/turn events: one request may span several agents and turns.
  | {
      type: "model_request_lifecycle";
      phase: "received" | "routed" | "fast_path" | "completed" | "failed";
      requestId: string;
      model: string;
      target?: string;
      durationMs?: number;
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
  // Lifecycle of a coordination container (project / group / channel / pool /
  // board / connector / command). These resources have no high-frequency
  // content event of their own (unlike board_post / channel_message), so the
  // dashboard's Coordination panel had no way to refresh their lists live on
  // create/update/delete — it sat on the 30s poll. One generic event keeps the
  // event surface small while letting every list graduate to realtime.
  | {
      type: "coordination_change";
      resource: "project" | "group" | "channel" | "pool" | "board" | "connector" | "command";
      action: "create" | "update" | "delete";
      entity: EntityId;
      name?: string;
      timestamp: number;
    };
