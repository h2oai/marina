// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentHandle } from "../../../agent/agent-types";
import type { CodePromptAnswerer, CodingAgentRuntime } from "../../../coding/code-session-driver";
import type { WorkspaceRuntime } from "../../../coding/local-workspace";
import type { WorkspaceRegistry } from "../../../coding/workspace-registry";
import type { ChannelManager } from "../../../coordination/channel-manager";
import type { CrewManager } from "../../../coordination/crew-manager";
import type { FlywheelToolBackend } from "../../../integrations/flywheel-manager";
import type { CodingArtifactRow, CodingSessionRow, MarinaDB } from "../../../persistence/database";
import type { Connection, ConnectionProtocol, Entity, EntityId, RoomContext } from "../../../types";
import { sanitizeEntityName } from "../../entity-name";

export const ACTIVE_SESSION_KEY = "coding_session_id";
export const ACTIVE_MODAL_KEY = "active_modal";
export const ACTIVE_TASK_KEY = "coding_task";
export const CODE_CONTEXT_KEY = "code_context";
export const CODE_PROFILE_KEY = "code_profile";
export const CODE_PROFILE_ALIASES_KEY = "code_profile_aliases";
export const CODE_WORKSPACE_KEY = "code_workspace_root";
export const DEFAULT_PUBLICATION_TTL_MS = 60 * 60 * 1000;

export type CodeProfileName = "marina" | "pi" | "claude" | "codex";
type CodingNoteKind = "decision" | "handoff" | "observation" | "plan" | "summary";
type CompatibilityGrade = "adapter" | "native" | "narrow" | "planned";

interface CodeMessageMetadata {
  artifactId?: string;
  artifactKind?: string;
  checks?: CodeCheckRow[];
  command?: string[];
  commands?: string[];
  content?: string;
  durationMs?: number;
  event: string;
  events?: CodeEventRow[];
  exitCode?: number;
  metadata?: Record<string, unknown>;
  modelTarget?: string;
  phase?: string;
  parentSessionId?: string;
  paths?: string[];
  query?: string;
  rows?: CodeDataRow[];
  sessionCreatedAt?: number;
  sessionId?: string;
  status?: string;
  timedOut?: boolean;
  title?: string;
  tree?: CodeTreeNode[];
  truncated?: boolean;
  type:
    | "artifact"
    | "command"
    | "diff"
    | "file"
    | "history"
    | "list"
    | "lifecycle"
    | "modal"
    | "model"
    | "note"
    | "patch"
    | "profile"
    | "readiness"
    | "search"
    | "session"
    | "skill"
    | "tree"
    | "verification";
  workspace?: string;
}

export interface CodeCheckRow {
  detail?: string;
  label: string;
  status: "fail" | "info" | "ok" | "warn";
}

export interface CodeDataRow {
  action?: string;
  canonical?: string;
  detail?: string;
  grade?: CompatibilityGrade;
  id?: string;
  kind?: string;
  line?: number;
  portability?: string;
  path?: string;
  size?: number;
  status?: string;
  text?: string;
  title?: string;
  type?: string;
}

interface CodeEventRow {
  actor: string;
  kind: string;
  payload?: string;
  timestamp: number;
}

interface CodeContextSnapshot {
  assignedAgent?: string;
  latestArtifactId?: string;
  latestArtifactKind?: string;
  latestArtifactLifecycle?: string;
  latestArtifactStatus?: string;
  modelTarget?: string;
  pendingPatches: number;
  profile: CodeProfileName;
  sessionId?: string;
  sessionMode?: string;
  sessionStatus?: string;
  sessionTitle?: string;
  workspace?: string;
  writer?: string;
}

export interface CodeTreeNode {
  active: boolean;
  children: CodeTreeNode[];
  id: string;
  status: string;
  title: string;
}

export interface CodeProfile {
  aliases: Record<string, string>;
  description: string;
  name: CodeProfileName;
  prompt: string;
  steering: string[];
}

export interface ProfileComparisonRow {
  action: string;
  behavior?: string;
  canonical: string;
  claude: string;
  codex: string;
  grade: CompatibilityGrade;
  marina: string;
  pi: string;
  portability: string;
  status: string;
}

export const CODE_PROFILES: Record<CodeProfileName, CodeProfile> = {
  marina: {
    name: "marina",
    prompt: "code",
    description: "Marina-native coding profile: explicit primitives, durable artifacts.",
    aliases: {
      cat: "read",
      decision: "decision",
      handoff: "handoff",
      ls: "files",
      new: "start",
      note: "steer",
      plan: "plan",
      propose: "patch",
      sessions: "list",
      summary: "summary",
      use: "resume",
    },
    steering: [
      "plan <direction>",
      "summary <notes>",
      "handoff <notes>",
      "decision <choice>",
      "note <direction>",
    ],
  },
  pi: {
    name: "pi",
    prompt: "pi",
    description: "Pi-style coding profile: light harness vocabulary over Marina primitives.",
    aliases: {
      accept: "apply",
      changes: "diff",
      decline: "reject",
      decision: "decision",
      exec: "run",
      follow: "steer",
      followup: "steer",
      grep: "search",
      handoff: "handoff",
      log: "history",
      note: "steer",
      open: "read",
      outputs: "artifacts",
      plan: "plan",
      proposal: "patch",
      summary: "summary",
      switch: "resume",
      tree: "tree",
    },
    steering: [
      "plan <direction>",
      "summary <notes>",
      "handoff <notes>",
      "decision <choice>",
      "follow up <direction>",
      "note <direction>",
    ],
  },
  claude: {
    name: "claude",
    prompt: "claude",
    description:
      "Claude Code-style profile: conversational project work, review, and compact steering.",
    aliases: {
      accept: "apply",
      bash: "run",
      compact: "summary",
      decision: "decision",
      edit: "patch",
      grep: "search",
      handoff: "handoff",
      note: "steer",
      open: "read",
      plan: "plan",
      review: "diff",
      shell: "run",
      summary: "summary",
      think: "steer",
    },
    steering: [
      "plan <direction>",
      "summary <notes>",
      "handoff <notes>",
      "decision <choice>",
      "think <direction>",
      "compact <summary preference>",
      "note <direction>",
    ],
  },
  codex: {
    name: "codex",
    prompt: "codex",
    description: "Codex-style profile: concise inspect, patch, run, and verify loop.",
    aliases: {
      accept: "apply",
      changes: "diff",
      check: "verify",
      decision: "decision",
      exec: "run",
      grep: "search",
      handoff: "handoff",
      inspect: "files",
      note: "steer",
      open: "read",
      plan: "plan",
      rg: "search",
      shell: "run",
      summary: "summary",
      view: "read",
    },
    steering: [
      "plan <direction>",
      "summary <notes>",
      "handoff <notes>",
      "decision <choice>",
      "note <direction>",
    ],
  },
};

export function sendCode(
  ctx: RoomContext,
  eid: EntityId,
  message: string,
  code: CodeMessageMetadata,
): void {
  ctx.send(eid, message, "code", { code });
}

// Subcommands that execute host processes or mutate the workspace. These are
// gated behind the `code.exec` safety gate (earned competence) so a freshly
// spawned, zero-standing agent cannot reach arbitrary host code execution via
// `code apply` + `code run`. Read/inspect/propose subcommands stay ungated.
export const CODE_EXEC_SUBCOMMANDS = new Set<string>([
  "run",
  "verify",
  "test",
  "lint",
  "typecheck",
  // `build` / `dashboard:build` spawn host processes (bun run build), so they
  // are host-execution and must be earned via the code.exec gate — closing a
  // pre-existing gap where they ran ungated.
  "build",
  "dashboard:build",
  "recipe",
  "apply",
  "revert",
  "service",
  "edit",
  "write",
]);

// Subcommands that touch the HOST working tree or spawn HOST processes against
// it — the set refused when no code root is configured (Finding 2), so we never
// mutate/execute in Marina's own process.cwd(). This is CODE_EXEC_SUBCOMMANDS
// minus the Flywheel-contained `service` (which routes to a sandbox, not the
// host root), plus patch/propose (host `git apply --check`). Sandbox/project
// lifecycle is likewise excluded — it has its own guest isolation.
export const HOST_ROOT_EXEC_SUBCOMMANDS = new Set<string>(
  [...CODE_EXEC_SUBCOMMANDS].filter((s) => s !== "service").concat(["patch", "propose"]),
);

// The full host-subprocess surface: every subcommand that can spawn a host
// process or mutate the working tree via a subprocess. Superset of
// CODE_EXEC_SUBCOMMANDS that also includes read-only host spawners that stay
// rank 0 (ungated per policy) yet still shell out to a subprocess, so they need
// the transport (telnet) deny WITHOUT the code.exec gate:
//   - `patch`/`propose` run `git apply --check`
//   - `diff`/`checkpoint` run `git diff` (checkpoint captures a diff snapshot)
//   - `search` runs `rg`
// Used only for the LAYER-0 telnet host-exec refusal so no telnet-origin caller
// can reach ANY host subprocess.
export const CODE_HOST_EXEC_SURFACE = new Set<string>([
  ...CODE_EXEC_SUBCOMMANDS,
  "patch",
  "propose",
  "diff",
  "search",
  "checkpoint",
  // Read-only host spawners that stay rank 0 yet shell out (`git status --short`):
  "doctor",
  "onboard",
  "setup",
]);

/** Single source of truth for the LAYER-0 telnet host-exec refusal message. */
export const TELNET_HOST_EXEC_DENY =
  "Host execution is not available over telnet (plaintext, unauthenticated). Use the local marina CLI or an authenticated WebSocket session.";

/**
 * Refusal when no code workspace root is configured (Finding 2). Marina must
 * never default the code root to its own process.cwd(), so host mutation /
 * execution is disabled until an operator points MARINA_CODE_ROOTS (or
 * MARINA_CODE_DEFAULT_ROOT) at a directory Marina may modify. Read-only inspect
 * verbs stay open. The `marina` folder-CLI sets these explicitly, so the local
 * desktop coding flow is unaffected.
 */
export const NO_CODE_ROOT_DENY =
  "Host code execution is disabled: no code workspace is configured. Set MARINA_CODE_ROOTS (or MARINA_CODE_DEFAULT_ROOT) to a directory Marina may modify — never the server's own source tree. Read-only inspect commands remain available.";

/**
 * LAYER-0 telnet-origin refusal for the agentic-dispatch verbs (`code do`,
 * `code crew`, `code assign`). These recruit/spawn a coding agent, grant it
 * code.exec, and drive host execution — so a telnet-origin dispatcher must be
 * refused BEFORE any session auto-start / ensureSessionAgent / crew spawn, just
 * like the explicit host-exec subcommands. Returns true when refused (caller
 * must return immediately). Read-only status/list views never call this.
 */
export function refuseTelnetDispatch(ctx: RoomContext, eid: EntityId, deps: CodeDeps): boolean {
  if (deps.getConnectionProtocol?.(eid) === "telnet") {
    ctx.send(eid, TELNET_HOST_EXEC_DENY);
    return true;
  }
  return false;
}

export interface CodeDeps {
  agentRuntime?: CodingAgentRuntime;
  answerPrompt?: CodePromptAnswerer;
  channelManager?: ChannelManager;
  crewManager?: CrewManager;
  flywheel?: FlywheelToolBackend;
  db?: MarinaDB;
  findAgentByName?: (name: string) => Entity | undefined;
  listAgents?: () => { name: string }[];
  workspace?: WorkspaceRuntime;
  workspaceRegistry?: WorkspaceRegistry;
  getEntity: (id: string) => Entity | undefined;
  /** Send a line to a specific entity's connection — used to stream a bound
   *  coding agent's live activity back to the human who dispatched the task. */
  notify?: (entityId: string, message: string, metadata?: Record<string, unknown>) => void;
  /** Transport of an entity's active connection — LAYER 0 telnet host-exec deny. */
  getConnectionProtocol?: (entityId: string) => ConnectionProtocol | undefined;
  /** Full connection for loopback verification of the interactive approver. */
  getConnection?: (entityId: string) => Connection | undefined;
  /** Resolve a (possibly human) entity by name — used to check the session creator. */
  findEntityByName?: (name: string) => Entity | undefined;
  /**
   * Resolve an entity by EXACT (case-insensitive) name — NEVER a fuzzy prefix
   * match. All exec-approval identity resolution (creator verification) uses
   * this so a low-privilege attacker whose name merely prefixes the sovereign's
   * cannot be resolved as the creator.
   */
  findEntityExact?: (name: string) => Entity | undefined;
  /** Entity ids/names permitted headless arbitrary exec (MARINA_CODE_EXEC_UNRESTRICTED). */
  execUnrestrictedAllow?: string[];
  /**
   * True when external identity verification is required for every login
   * (MARINA_AUTH=better-auth). Short-circuits headless identity trust; otherwise
   * trust is resolved per acting connection (loopback), never from WS_HOST.
   */
  authRequired?: boolean;
  /** Interactive-approval timeout override (MARINA_CODE_EXEC_APPROVAL_TIMEOUT_MS). */
  execApprovalTimeoutMs?: number;
  /**
   * Per-invocation: true when the ACTING caller is telnet-origin, so the resolved
   * workspace must refuse ALL host-process spawning (chokepoint backstop behind
   * the enumerated LAYER-0 deny). Computed once per command in `codeCommand`.
   */
  hostExecForbidden?: boolean;
}

/**
 * Single-writer guard for workspace-mutating paths. When `session.writer` is
 * non-null and the actor is not the holder, refuse and point at the transfer
 * commands. A null writer imposes NO restriction (solo sessions, existing
 * tests). Returns true when the caller may proceed.
 */
export function enforceWriteLock(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  session: CodingSessionRow,
): boolean {
  if (!session.writer || sameEntityName(session.writer, entity.name)) return true;
  ctx.send(
    eid,
    `${session.writer} holds the write lock for this session — request a handoff (code handoff <notes> to ${entity.name}) or have the owner reassign (code writer ${entity.name}).`,
  );
  return false;
}

export function resolveSession(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  db: MarinaDB,
  id?: string,
) {
  const sessionId = id || getActiveSessionId(entity);
  if (!sessionId) {
    ctx.send(
      eid,
      [
        "No active coding session.",
        'Start one with "code start", inspect readiness with "code onboard", or choose a workspace with "code workspace list".',
      ].join("\n"),
    );
    return null;
  }
  const session = db.getCodingSession(sessionId);
  if (!session) {
    ctx.send(eid, `Coding session not found: ${sessionId}`);
    return null;
  }
  return session;
}

export function getSessionModelTarget(db: MarinaDB, sessionId: string): string | undefined {
  const artifact = latestActiveArtifact(db, sessionId, "model_setting");
  if (!artifact) return undefined;
  const meta = parseJsonObject(artifact.metadata_json);
  return typeof meta.target === "string" ? meta.target : undefined;
}

export function modelTargetForAgentSpawn(target: string | undefined): string | undefined {
  if (!target) return undefined;
  const normalized = target.trim().toLowerCase();
  if (!normalized || ["agent", "crew", "direct", "default", "marina"].includes(normalized)) {
    return undefined;
  }
  return target;
}

export function parseSpawnRunArgs(args: string[]): { model?: string; name?: string; ref?: string } {
  const parsed: { model?: string; name?: string; ref?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    const key = token?.toLowerCase();
    if ((key === "name" || key === "as") && args[i + 1]) {
      parsed.name = sanitizeAgentName(args[i + 1] ?? "");
      i++;
      continue;
    }
    if (key === "model" && args[i + 1]) {
      parsed.model = args[i + 1];
      i++;
      continue;
    }
    if (!parsed.ref && token) parsed.ref = token;
  }
  return parsed;
}

function sanitizeAgentName(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * Identity comparison between a stored name (agent config name, session
 * writer/creator) and a live entity's name. Config names may contain dashes
 * ("code-coder-code_5") while login sanitizes the entity name to
 * "codecodercode_5" — normalize BOTH sides through the login sanitizer and
 * compare case-insensitively (entity names are unique case-insensitively).
 */
export function sameEntityName(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  return sanitizeEntityName(a).toLowerCase() === sanitizeEntityName(b).toLowerCase();
}

/**
 * Normalize a name to the form the login path will actually give its entity,
 * for storing in identity fields (session.writer). Falls back to the input
 * when sanitization would empty it — better a comparable-but-odd name than "".
 */
export function entityNameForm(name: string): string {
  return sanitizeEntityName(name) || name;
}

/**
 * Runtime handle lookup tolerant of config-name vs sanitized-entity-name drift
 * for recruited/legacy agents (spawned agents now use sanitizer-fixed-point
 * names, so the raw lookup hits first).
 */
export function getAgentHandle(deps: CodeDeps, name: string): AgentHandle | undefined {
  return deps.agentRuntime?.get?.(name) ?? deps.agentRuntime?.get?.(sanitizeEntityName(name));
}

export function uniqueSpawnAgentName(
  liveAgents: { name: string }[],
  role: string,
  sessionId: string,
): string {
  const live = new Set(liveAgents.map((agent) => agent.name.toLowerCase()));
  // Spawned names must be FIXED POINTS of the login sanitizer (alphanumeric +
  // underscore, ≤20 chars) so config name === entity name — otherwise every
  // identity comparison (writer lock, self-dispatch guard) silently misses.
  const session = sessionId.replace(/^code_session_?/, "").slice(0, 6);
  const raw =
    `code_${role}_${session}`.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "") ||
    "code_agent";
  const fit = (suffix: string) => sanitizeEntityName(raw.slice(0, 20 - suffix.length) + suffix);
  const base = sanitizeEntityName(raw);
  if (!live.has(base.toLowerCase())) return base;
  for (let i = 2; i < 50; i++) {
    const candidate = fit(`_${i}`);
    if (!live.has(candidate.toLowerCase())) return candidate;
  }
  return fit(`_${Date.now().toString(36).slice(-4)}`);
}

export function bindSpawnedAgentEntity(
  agent: { getStatus(): { entityId: string | null }; name: string },
  session: CodingSessionRow,
  profile: string,
  deps: CodeDeps & { db: MarinaDB },
): void {
  const entityId = agent.getStatus().entityId;
  if (!entityId) return;
  const spawned = deps.getEntity(entityId);
  if (!spawned) return;
  spawned.properties[ACTIVE_MODAL_KEY] = "code";
  spawned.properties[ACTIVE_SESSION_KEY] = session.id;
  spawned.properties[CODE_PROFILE_KEY] = profile;
  deps.db.saveEntity(spawned);
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: agent.name,
    kind: "code_agent_bound",
    payload: { agent: agent.name, entityId: spawned.id, profile },
  });
}

export function getActiveSessionId(entity: Entity): string | undefined {
  const value = entity.properties[ACTIVE_SESSION_KEY];
  return typeof value === "string" ? value : undefined;
}

export function updateCodeContext(entity: Entity, db: MarinaDB, session?: CodingSessionRow): void {
  const profile = getCodeProfile(entity);
  const artifacts = session ? db.listCodingArtifacts(session.id, 50) : [];
  const latestArtifact = artifacts[0];
  const latestMeta = latestArtifact ? parseArtifactMetadata(latestArtifact) : undefined;
  const pendingPatches = artifacts.filter(
    (artifact) => artifact.kind === "patch" && artifact.status === "pending",
  ).length;
  const assignment = artifacts.find((artifact) => artifact.kind === "agent_assignment");
  const assignmentMeta = assignment ? parseJsonObject(assignment.metadata_json) : {};
  const assignedAgent = typeof assignmentMeta.agent === "string" ? assignmentMeta.agent : undefined;
  const model = artifacts.find(
    (artifact) => artifact.kind === "model_setting" && artifact.status === "active",
  );
  const modelMeta = model ? parseJsonObject(model.metadata_json) : {};
  const modelTarget = typeof modelMeta.target === "string" ? modelMeta.target : undefined;
  const selectedWorkspace =
    typeof entity.properties[CODE_WORKSPACE_KEY] === "string"
      ? entity.properties[CODE_WORKSPACE_KEY]
      : undefined;
  const snapshot: CodeContextSnapshot = {
    assignedAgent,
    latestArtifactId: latestArtifact?.id,
    latestArtifactKind: latestArtifact?.kind,
    latestArtifactLifecycle: latestMeta?.lifecycle,
    latestArtifactStatus: latestArtifact?.status,
    modelTarget,
    pendingPatches,
    profile: profile.name,
    sessionId: session?.id,
    sessionMode: session?.mode,
    sessionStatus: session?.status,
    sessionTitle: session?.title,
    workspace: session?.workspace_root ?? selectedWorkspace,
    // Surface the single-writer lock holder so the UI chip renders without the
    // artifacts overlay open (the GET /api/coding/session/:id detail is a fallback).
    writer: session?.writer ?? undefined,
  };
  entity.properties[CODE_CONTEXT_KEY] = snapshot;
  db.saveEntity(entity);
}

export function getCodeProfile(entity: Entity): CodeProfile {
  const name = normalizeProfileName(entity.properties[CODE_PROFILE_KEY]);
  const base = CODE_PROFILES[name ?? "marina"];
  return { ...base, aliases: { ...base.aliases, ...getCustomProfileAliases(entity) } };
}

export function getCustomProfileAliases(entity: Entity): Record<string, string> {
  const raw = entity.properties[CODE_PROFILE_ALIASES_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const aliases: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && key.trim() && value.trim()) {
      aliases[key.toLowerCase()] = value.toLowerCase();
    }
  }
  return aliases;
}

export function normalizeProfileName(value: unknown): CodeProfileName | null {
  if (value === "marina" || value === "pi" || value === "claude" || value === "codex") {
    return value;
  }
  return null;
}

export function canonicalCodeSubcommand(profile: CodeProfile, sub: string): string {
  return profile.aliases[sub] ?? sub;
}

export function normalizeCodingNoteKind(value: string): CodingNoteKind | null {
  if (value === "decision" || value === "handoff" || value === "plan" || value === "summary") {
    return value;
  }
  return null;
}

export function formatCodingNoteTitle(kind: CodingNoteKind, text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const title = firstLine.length > 64 ? `${firstLine.slice(0, 61)}...` : firstLine;
  return `${capitalize(kind)}: ${title || "Untitled"}`;
}

export function formatCompletionTitle(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const title = firstLine.length > 64 ? `${firstLine.slice(0, 61)}...` : firstLine;
  return `Completion: ${title || "Session completed"}`;
}

export function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function normalizeSteeringArgs(args: string[]): string {
  const cleaned = args[0]?.toLowerCase() === "up" ? args.slice(1) : args;
  return cleaned.join(" ").trim();
}

export function restAfterSubcommand(args: string): string {
  const trimmed = args.trimStart();
  const match = trimmed.match(/^\S+\s*/);
  return match ? trimmed.slice(match[0].length) : "";
}

export function latestSessionArtifact(
  db: MarinaDB,
  sessionId: string,
  kind?: string,
): CodingArtifactRow | undefined {
  return db.listCodingArtifacts(sessionId, 50).find((artifact) => !kind || artifact.kind === kind);
}

export function latestFailureArtifact(
  db: MarinaDB,
  sessionId: string,
): CodingArtifactRow | undefined {
  return db.listCodingArtifacts(sessionId, 50).find((artifact) => isFailureArtifact(artifact));
}

export function latestActiveArtifact(
  db: MarinaDB,
  sessionId: string,
  kind: string,
): CodingArtifactRow | undefined {
  return db
    .listCodingArtifacts(sessionId, 50)
    .find((artifact) => artifact.kind === kind && artifact.status === "active");
}

export function parseEventPayload(event: { payload_json: string }): Record<string, unknown> {
  return parseJsonObject(event.payload_json);
}

export function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function isFailureArtifact(artifact: CodingArtifactRow): boolean {
  if (["failed", "denied"].includes(artifact.status)) return true;
  const meta = parseArtifactMetadata(artifact);
  return meta.timedOut === true || (typeof meta.exitCode === "number" && meta.exitCode !== 0);
}

export function parseArtifactMetadata(artifact: CodingArtifactRow): {
  command: string[];
  durationMs?: number;
  exitCode?: number;
  lifecycle?: string;
  lifecycleAt?: number;
  lifecycleBy?: string;
  paths: string[];
  timedOut?: boolean;
  truncated?: boolean;
} {
  try {
    const parsed = JSON.parse(artifact.metadata_json) as {
      command?: unknown;
      durationMs?: unknown;
      exitCode?: unknown;
      lifecycle?: unknown;
      lifecycleAt?: unknown;
      lifecycleBy?: unknown;
      paths?: unknown;
      timedOut?: unknown;
      truncated?: unknown;
    };
    return {
      command: Array.isArray(parsed.command) ? parsed.command.map(String) : [],
      durationMs: typeof parsed.durationMs === "number" ? parsed.durationMs : undefined,
      exitCode: typeof parsed.exitCode === "number" ? parsed.exitCode : undefined,
      lifecycle: typeof parsed.lifecycle === "string" ? parsed.lifecycle : undefined,
      lifecycleAt: typeof parsed.lifecycleAt === "number" ? parsed.lifecycleAt : undefined,
      lifecycleBy: typeof parsed.lifecycleBy === "string" ? parsed.lifecycleBy : undefined,
      paths: Array.isArray(parsed.paths) ? parsed.paths.map(String) : [],
      timedOut: typeof parsed.timedOut === "boolean" ? parsed.timedOut : undefined,
      truncated: typeof parsed.truncated === "boolean" ? parsed.truncated : undefined,
    };
  } catch {
    return { command: [], paths: [] };
  }
}

export function formatPaths(paths: string[]): string {
  return paths.length > 0 ? paths.join(", ") : "(no paths)";
}

export function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

export function formatArtifactMetaLine(meta: ReturnType<typeof parseArtifactMetadata>): string {
  const detail = formatArtifactMeta(meta);
  return detail ? `Details: ${detail}` : "Details: none";
}

export function formatArtifactMeta(meta: ReturnType<typeof parseArtifactMetadata>): string {
  const lifecycle = meta.lifecycle
    ? `lifecycle: ${meta.lifecycle}${meta.lifecycleBy ? ` by ${meta.lifecycleBy}` : ""}`
    : "";
  if (meta.paths.length > 0) {
    return [lifecycle, `paths: ${formatPaths(meta.paths)}`].filter(Boolean).join(", ");
  }
  if (meta.command.length > 0) {
    const parts = [`command: ${meta.command.join(" ")}`];
    if (meta.exitCode !== undefined) parts.push(`exit: ${meta.exitCode}`);
    if (meta.durationMs !== undefined) parts.push(`${meta.durationMs}ms`);
    if (meta.timedOut) parts.push("timed out");
    if (meta.truncated) parts.push("truncated");
    if (lifecycle) parts.push(lifecycle);
    return parts.join(", ");
  }
  return lifecycle;
}
