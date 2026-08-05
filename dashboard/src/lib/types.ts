// API response types

/** A page of `items` out of `total` rows — backs the "load more" lists. */
export interface Paged<T> {
  items: T[];
  total: number;
}

export interface RoomSummary {
  id: string;
  short: string;
  district: string;
  exits: Record<string, string>;
  entityCount: number;
}

export interface EntitySummary {
  id: string;
  name: string;
  kind: "agent" | "npc" | "object";
  room: string;
  rank: number;
}

export interface WorldData {
  worldName?: string;
  startRoom?: string;
  rooms: RoomSummary[];
  entities: EntitySummary[];
}

export interface RoomDetail {
  id: string;
  short: string;
  long: string;
  exits: Record<string, string>;
  items: Record<string, string>;
  entities: { id: string; name: string; kind: string }[];
  source?: string;
}

export interface EntityDetail {
  id: string;
  name: string;
  kind: string;
  room: string;
  rank: number;
  properties: Record<string, unknown>;
  inventory: string[];
  coreMemory?: CoreMemoryEntry[];
  notes?: NoteEntry[];
  recentActivity?: ActivityEntry[];
  standing?: number;
}

export interface CoreMemoryEntry {
  entity_name: string;
  key: string;
  value: string;
  version: number;
  updated_at: number;
}

export interface NoteEntry {
  id: number;
  entity_name: string;
  content: string;
  importance: number;
  note_type: string;
  created_at: number;
}

export interface ActivityEntry {
  type: string;
  input?: string;
  timestamp: number;
}

export interface BoardEntry {
  id: string;
  name: string;
  scope_type: string;
  postCount: number;
  created_at: number;
}

export interface TaskEntry {
  id: number;
  title: string;
  status: string;
  creator_name: string;
  created_at: number;
}

export interface ChannelEntry {
  id: string;
  name: string;
  type: string;
  messageCount: string;
}

export interface GroupEntry {
  id: string;
  name: string;
  description: string;
  leader_id: string;
  memberCount: number;
}

export interface MemoryPool {
  id: string;
  name: string;
  group_id: string | null;
  created_by: string;
}

// --- Drill-down detail types ---

export interface ProjectEntry {
  id: string;
  name: string;
  description: string;
  orchestration: string;
  memory_arch: string;
  status: string;
  bundle_id: number | null;
  pool_id: string | null;
  group_id: string | null;
  created_by: string;
  bundleProgress?: { total: number; done: number };
}

export interface ConnectorEntry {
  id: string;
  name: string;
  transport: string;
  url: string | null;
  status: string;
  auth_type: string | null;
  created_by: string;
}

export interface DynamicCommandEntry {
  id: string;
  name: string;
  version: number;
  valid: number;
  created_by: string;
  created_at: number;
}

export interface TaskDetail extends TaskEntry {
  description: string;
  parent_task_id: number | null;
  assignee_name?: string;
  children?: TaskEntry[];
}

export interface BoardPostEntry {
  id: number;
  title: string;
  body: string;
  author_name: string;
  score?: number;
  created_at: number;
}

export interface BoardDetail extends BoardEntry {
  posts: BoardPostEntry[];
}

export interface GroupDetail extends GroupEntry {
  members: { entity_id: string; rank: number; joined_at: number }[];
}

export interface ChannelMessage {
  sender_name: string;
  content: string;
  created_at: number;
}

export interface ChannelDetail extends ChannelEntry {
  messages: ChannelMessage[];
}

export interface SystemData {
  status: string;
  uptime: number;
  connections: number;
  rooms: number;
  entities: { total: number; agents: number; npcs: number };
  memory: { heapUsed: number; rss: number };
  tasks?: { open: number; claimed: number; submitted: number; completed: number };
  projectCount?: number;
  connectorCount?: number;
  commandCount?: number;
}

// WebSocket message types

export interface DashboardEvent {
  type: string;
  entity?: string;
  input?: string;
  connectionId?: string;
  protocol?: string;
  room?: string;
  taskId?: number;
  name?: string;
  error?: string;
  // Knowledge graph event fields (note_created, note_updated, note_deleted,
  // note_link_created, note_link_deleted, recall_trace)
  noteId?: number;
  authorName?: string;
  content?: string;
  importance?: number;
  noteType?: string;
  roomId?: string;
  poolId?: string;
  lastAccessed?: number;
  sourceId?: number;
  targetId?: number;
  relationship?: string;
  query?: string;
  seedNoteIds?: number[];
  activatedNoteIds?: number[];
  // Feed event fields (feed_event)
  kind?: string;
  ref?: string;
  summary?: string;
  payload?: Record<string, unknown>;
  // Agent streaming fields (agent_turn_start, agent_turn_end,
  // agent_text_delta, agent_thinking_delta, rank_change, agent_state_change)
  state?: string;
  hadToolCalls?: boolean;
  toolCount?: number;
  delta?: string;
  oldRank?: number;
  newRank?: number;
  direction?: "promoted" | "demoted";
  // Crew lifecycle event fields (crew_created, crew_member_joined,
  // crew_member_left, crew_state_changed, crew_completed, crew_dissolved,
  // crew_member_stalled, crew_stage_completed, crew_artifact_deposited)
  crew?: string;
  agentName?: string;
  role?: string;
  formation?: string;
  lifetime?: string;
  from?: string;
  to?: string;
  reason?: string;
  offenseCount?: number;
  stage?: string;
  artifactRef?: string;
  resultNoteId?: number;
  owner?: string;
  // Coordination container lifecycle (coordination_change): project / group /
  // channel / pool / board / connector / command create / update / delete.
  resource?: "project" | "group" | "channel" | "pool" | "board" | "connector" | "command";
  action?: "create" | "update" | "delete";
  timestamp: number;
}

// ─── Knowledge Graph (live from WS + /api/graph snapshot) ───────────────────

export interface GraphNote {
  id: number;
  entityName: string;
  content: string;
  importance: number;
  noteType: string;
  createdAt: number;
  lastAccessed: number | null;
  roomId: string | null;
  poolId: string | null;
}

export interface GraphLink {
  sourceId: number;
  targetId: number;
  relationship: string;
}

export interface GraphSnapshot {
  notes: GraphNote[];
  links: GraphLink[];
}

export interface RecallTrace {
  entity: string;
  query: string;
  seedNoteIds: number[];
  activatedNoteIds: number[];
  timestamp: number;
}

// ─── Feed events (live timeline, primed from /api/feed) ─────────────────────

export interface FeedEvent {
  id: number;
  kind: string;
  entity: string | null;
  ref: string | null;
  summary: string;
  payload: Record<string, unknown> | null;
  timestamp: number;
}

export interface SetupStatus {
  instanceName: string;
  hasLlmKey: boolean;
  world: string;
  agentCount: number;
  entityCount: number;
}

export interface OperationalAlert {
  id: number;
  alert_key: string;
  severity: "critical" | "warning" | "info";
  category: string;
  title: string;
  detail: string;
  remedy: string;
  status: "open" | "acknowledged" | "resolved";
  occurrences: number;
  first_seen_at: number;
  last_seen_at: number;
}

export interface ReadinessCheck {
  id: string;
  label: string;
  status: "ok" | "degraded" | "off";
  detail: string;
  remediation?: string;
}

export interface ReadinessReport {
  instanceName: string;
  world: string;
  generatedAt: number;
  checks: ReadinessCheck[];
  demo: {
    score: number;
    status: "ready" | "warming" | "degraded";
    warmAgents: number;
    expectedAgents: number;
    recentMeaningfulEvents: number;
    recentPrimitiveActions: number;
    activeParticipants: number;
    activeAgents: number;
    recentCommunications: number;
    medianResponseMs?: number;
  };
}

export interface ProductivitySummary {
  entityName: string | null;
  outcomes: number;
  successes: number;
  failures: number;
  successRate: number;
  averageDurationMs: number;
  medianDurationMs: number;
  averageToolCalls: number;
  averageHandoffs: number;
  outcomesLast7d: number;
}

export interface ProductivityTrendPoint {
  date: string;
  outcomes: number;
  successes: number;
  averageDurationMs: number;
  averageToolCalls: number;
  averageHandoffs: number;
}

export interface PrimitiveUsageSummary {
  entityName: string | null;
  commands: number;
  meaningfulActions: number;
  meaningfulRate: number;
  worldActions: number;
  communications: number;
  primitiveDiversity: number;
  activeParticipants: number;
  activeAgents: number;
  toolCalls: number;
  marinaToolCalls: number;
  reasoningOnlyCalls: number;
  lastActionAt: number | null;
  outcomeSessions: number;
  approvedMeaningfulAverage: number;
  failedMeaningfulAverage: number;
  topPrimitives: Array<{ primitive: string; count: number }>;
}

export interface ProductivityResponse {
  summary: ProductivitySummary;
  leaderboard: ProductivitySummary[];
  trend: ProductivityTrendPoint[];
  primitiveUsage: PrimitiveUsageSummary;
  primitiveLeaderboard: PrimitiveUsageSummary[];
}

export interface MemoryQualitySummary {
  total: number;
  unverified: number;
  disputed: number;
  superseded: number;
  staleSources: number;
  contradictions: number;
}

export interface ContradictionNote {
  id: number;
  entity_name: string;
  content: string;
  confidence: number;
  verification_status: string;
  pool_id: string | null;
}

export interface ContradictionCase {
  id: number;
  scope_type: "global" | "pool";
  scope_id: string | null;
  status: "open" | "resolved";
  resolution: "left" | "right" | "both" | "neither" | null;
  rationale: string | null;
  resolved_by: string | null;
  created_at: number;
  updated_at: number;
  left: ContradictionNote | null;
  right: ContradictionNote | null;
}

export interface WorldSnapshot {
  timestamp: number;
  instanceName?: string;
  worldName?: string;
  startRoom?: string;
  entities: {
    id: string;
    name: string;
    kind: string;
    room: string;
    properties?: Record<string, unknown>;
    agentStatus?: AgentStatusInfo;
    /** AgentConfig.spawned_by for agent entities: "system" (world-seeded),
     *  "operator" (launched from the dashboard/CLI), or a spawning agent's
     *  name (crew sub-agent). Absent for humans / externally-connected agents.
     *  Drives the origin grouping in the Entities roster. */
    spawnedBy?: string;
  }[];
  roomPopulations: Record<string, number>;
  rooms: {
    id: string;
    short: string;
    district: string;
    exits: Record<string, string>;
  }[];
  connections: number;
  memory: { heapUsed: number; rss: number };
  gridPositions?: Record<string, { row: number; col: number }>;
}

// ─── Agent Types ────────────────────────────────────────────────────────────

export interface AgentSupports {
  text: boolean;
  image?: boolean;
  video?: boolean;
}

export interface AgentStatusInfo {
  state: string;
  model: string;
  role: string;
  focus: string | null;
  uptime: number;
  toolCalls: number;
  errors: number;
  errorReason: string | null;
  supports: AgentSupports;
  /** ms-since-epoch of last activity — drives the roster liveness dot. */
  lastActivity?: number;
  /** EMA of LLM turn latency (ms) — surfaced so a slow model is visible. */
  avgTurnMs?: number;
  /** Consecutive zero-tool-call turns — the "stuck" signal. */
  silentTurns?: number;
}

export interface AgentStatusFull {
  name: string;
  entityId: string | null;
  state: string;
  model: string;
  role: string;
  focus: string | null;
  goal: string | null;
  uptime: number;
  toolCalls: number;
  errors: number;
  errorReason: string | null;
  lastActivity: number;
  supports: AgentSupports;
  /** Nominal model context window (tokens). */
  contextWindow?: number;
  /** Working window the compactor budgets against (drops below nominal under pressure). */
  effectiveContextWindow?: number;
  /** Output (completion) token cap per turn. */
  maxOutputTokens?: number;
  /** Highest real prompt-token count the server has accepted. */
  peakInputTokens?: number;
}

export interface MediaJob {
  id: string;
  type: "image" | "video";
  status: "pending" | "running" | "succeeded" | "failed" | "blocked";
  provider: string;
  model: string;
  prompt: string;
  entityName: string;
  costEstimate?: number | null;
  error?: string | null;
  assetId?: string | null;
  assetUrl?: string | null;
  options?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface KeyStatus {
  name: string;
  provider: string;
  masked: string;
  setBy: string;
  updatedAt: number;
}

export interface ModelEntry {
  value: string;
  label: string;
  contextLength?: number;
  description?: string;
  capabilities?: {
    text: boolean;
    image?: boolean;
    video?: boolean;
    audio?: boolean;
  };
}

export interface ProviderGroup {
  provider: string;
  error: string | null;
  keySource: "db" | "env" | null;
  models: ModelEntry[];
}

export interface ModelsResponse {
  groups: ProviderGroup[];
  fetchedAt: number;
  cached: boolean;
}

export interface AdapterStatus {
  platform: string;
  config: string;
  status: string;
  set_by: string;
  source: "db" | "env";
  envVar?: string;
  running: boolean;
  created_at: number;
  updated_at: number;
}

export interface EnvVar {
  key: string;
  value: string;
  description: string;
  category: string;
  isSecret: boolean;
  isSet: boolean;
  /** False when set via the live process environment (shell/docker) rather than
   * the managed .env file — the panel can't override it, so it's read-only. */
  editable?: boolean;
  source?: "env" | "file" | "unset";
}

export interface McpToolInfo {
  name: string;
  description: string;
}

export interface McpInfo {
  url: string;
  port: number;
  tools: Record<string, McpToolInfo[]>;
}

export interface RoleEntry {
  name: string;
  description: string;
  traits: string;
  guidelines: string;
  focus: string;
  tone: string;
  origin: string;
  created_by: string;
  created_at: number;
}

export interface TraitEntry {
  name: string;
  category: string;
  prompt: string;
  created_by: string;
  created_at: number;
}

// ─── Knowledge Graph & Brief Types ──────────────────────────────────────────

export interface NoteGraphEntry {
  noteId: number;
  content: string;
  importance: number;
  noteType: string;
  links: { targetId: number; relationship: string }[];
}

export interface BriefData {
  onlineCount: number;
  projectCount: number;
  openTaskCount: number;
  claimedTaskCount: number;
  pendingIntents: number;
  poolCount: number;
  memoryCount: number;
  goal: string | null;
  focus: string | null;
  topTask: { id: number; title: string; progress: number } | null;
}

export type WorkItemKind =
  | "quest_step"
  | "claimed_task"
  | "review_task"
  | "crew_active"
  | "crew_idle"
  | "canvas_intent"
  | "goal_missing"
  | "bounty"
  | "open_task"
  | "social"
  | "channel_join"
  | "memory_seed"
  | "explore"
  | "canvas_contribute"
  | "default";

export interface WorkItem {
  kind: WorkItemKind;
  title: string;
  detail?: string;
  action: string;
  priority: number;
  ref?: string;
}

export interface EntityWorkResponse {
  items: WorkItem[];
}

// ─── Room Templates, Macros, Experiments, Markets, Benchmarks ──────────────

export interface RoomTemplateEntry {
  name: string;
  source: string;
  author_id: string;
  author_name: string;
  description: string;
  created_at: number;
}

export interface MacroEntry {
  id: number;
  name: string;
  author_id: string;
  command: string;
  created_at: number;
  updated_at: number;
}

export interface ExperimentEntry {
  id: number;
  name: string;
  description: string;
  config: string;
  status: string;
  creator_name: string;
  required_agents: number;
  time_limit: number | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

export interface MarketEntry {
  id: string;
  room_id: string;
  question: string;
  category: string;
  status: string;
  outcome: string | null;
  resolved_at: number | null;
  resolved_by: string | null;
  created_at: number;
}

export interface BenchmarkEntry {
  entity: string;
  scores: Record<string, number>;
}

export interface RecipeEntry {
  name: string;
  description: string;
  orchestration: string;
  taskCount: number;
  agentCount: number;
  agentRole: string | null;
}

// ─── Web Coding Sessions ────────────────────────────────────────────────────

export interface CodingSessionEntry {
  id: string;
  title: string;
  workspace_root: string;
  status: string;
  mode: string;
  /** Single-writer lock holder (agent name), or null when the session is open. */
  writer: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface CodingArtifactEntry {
  id: string;
  session_id: string;
  kind: string;
  title: string;
  status: string;
  content_text: string;
  metadata_json: string;
  created_by: string;
  applied_by: string | null;
  created_at: number;
  updated_at: number;
  applied_at: number | null;
}

export interface CodingEventEntry {
  id: string;
  session_id: string;
  actor: string;
  kind: string;
  payload_json: string;
  created_at: number;
}

export interface CodingSessionDetail {
  session: CodingSessionEntry;
  events: CodingEventEntry[];
  artifacts: CodingArtifactEntry[];
}

export type WSMessage =
  | { type: "snapshot"; data: WorldSnapshot }
  | { type: "state"; data: WorldSnapshot }
  | { type: "event"; data: DashboardEvent };
