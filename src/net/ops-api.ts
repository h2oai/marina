// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator runtime surface — `GET /api/ops/overview` and
 * `POST /api/ops/agents/:name/stop`, registered from `dashboard-api.ts`.
 *
 * Read-only for residents and scoped like the memory observability API: a
 * privileged principal (desktop token, sovereign, operator gate, dev-open
 * sentinel) sees every running agent, the spend ledger, retention, prompt
 * budget, the last provider probe and the security posture; an ordinary
 * signed-in resident sees only the agents it spawned (or is) — spend sums
 * cover those rows alone and `providers` is null.
 *
 * Nothing here calls a model or mutates state except the stop route, which
 * cascades exactly like the in-world `agent stop` (children first) and emits
 * the same `agent_stop` lifecycle events so crews and dashboards observe it.
 */

import { inferCrewResponder } from "../agent/agent-runtime";
import { operatorStatusOf } from "../agent/lean-agent-adapter";
import type { PlatformMemoryBackend } from "../agent/memory-platform";
import { getLeanSystemPrompt, LEAN_SYSTEM_PROMPT_BYTE_CAP } from "../agent/prompts/lean-system";
import {
  createProfileToolset,
  deferredToolsEnabled,
  type ToolContext,
  type ToolProfile,
} from "../agent/tools";
import { RateLimiter } from "../auth/rate-limiter";
import { decisionConfigFromEnv, decisionGateEnabled } from "../decisions/config";
import { decisionHealth } from "../decisions/health";
import { decisionVerifyEnabled } from "../decisions/verify";
import { getAutonomyPosture } from "../engine/autonomy";
import { CONTINUATION_PROMPT_BUDGET_BYTES } from "../engine/constants";
import type { Engine } from "../engine/engine";
import { getErrorMessage } from "../engine/errors";
import { Logger } from "../engine/logger";
import { describeRetentionPolicies, getLastRetentionReport } from "../engine/retention";
import {
  aggregatePromptSections,
  type PromptTurnSample,
  promptTurnSampleFromEvent,
} from "../engine/trace-analytics";
import { getTrustProfile, isLocalUngated, isOpenApiMode } from "../engine/trust-profile";
import type { EngineEvent, EntityId } from "../types";
import { HTTP_RATE_LIMITS } from "./http-utils";
import { memoryObserver } from "./memory-visibility";
import { getLastProviderProbe } from "./model-api";
import type {
  AgentOperatorRow,
  OpsAgentStopResponse,
  OpsDecisionRow,
  OpsDecisions,
  OpsLimiter,
  OpsOverview,
  OpsPrompt,
  OpsPromptSection,
  OpsRetention,
  OpsSecurity,
  OpsSpend,
  OpsToolProfile,
  ProviderProbeSummary,
} from "./ops-types";

/** Module logger: ops HTTP route — measurement failures. */
const logger = new Logger();

// ─── Scope ──────────────────────────────────────────────────────────────────

export interface OpsObserverScope {
  privileged: boolean;
  /** The caller's in-world identity (absent for sentinels). */
  entityId?: EntityId;
  entityName?: string;
}

/**
 * Same privilege rule as the memory observability API (`memoryObserver`):
 * desktop operator token, sovereign (rank ≥ 9), unattended `admin.destructive`
 * holder, or a sentinel principal (dev-open / desktop).
 */
export function opsObserverScope(engine: Engine, principal?: string): OpsObserverScope {
  const observer = memoryObserver(engine, principal);
  return {
    privileged: observer.privilegedRead,
    entityId: observer.entity?.id,
    entityName: observer.entity?.name,
  };
}

// ─── Agents ─────────────────────────────────────────────────────────────────

/**
 * Mirrors `inferToolProfile` in agent-runtime.ts (module-private there): crew
 * responders and the compact roles run the `crew` profile, everything else
 * `full`. An explicit `AgentConfig.toolProfile` override is not exposed by the
 * runtime handle, so this is the inferred default, not a live read.
 */
const COMPACT_TOOL_ROLES = new Set([
  "general",
  "guide",
  "architect",
  "scholar",
  "chronicler",
  "coding-agent",
]);

export function inferToolProfileForRole(role: string | null | undefined): OpsToolProfile {
  const normalized = role?.trim().toLowerCase();
  if (!normalized) return "full";
  return inferCrewResponder(normalized) || COMPACT_TOOL_ROLES.has(normalized) ? "crew" : "full";
}

function agentRow(engine: Engine, name: string): AgentOperatorRow | null {
  const handle = engine.agentRuntime.get(name);
  const status = handle?.getStatus() ?? engine.agentRuntime.list().find((s) => s.name === name);
  if (!status) return null;
  const ops = handle ? operatorStatusOf(handle) : undefined;
  const config = engine.db?.getAgentConfig(status.name);
  return {
    name: status.name,
    entityId: status.entityId,
    state: status.state,
    health: status.healthState ?? null,
    role: status.role ?? "",
    model: status.model ?? "",
    toolProfile: inferToolProfileForRole(status.role),
    spawnedBy: config?.spawned_by || "system",
    uptimeMs: status.uptime ?? 0,
    toolCalls: status.toolCalls ?? 0,
    modelCalls: status.modelCalls ?? null,
    tokens: {
      input: ops?.totalInputTokens ?? status.totalInputTokens ?? 0,
      output: ops?.totalOutputTokens ?? status.totalOutputTokens ?? 0,
    },
    cost: {
      totalUsd: ops?.totalCostUsd ?? status.totalCostUsd ?? 0,
      lastHourUsd: ops?.costLastHourUsd ?? 0,
    },
    consecutiveErrors: ops?.consecutiveErrors ?? 0,
    lastError: ops?.lastError ?? null,
    paused: ops?.paused
      ? {
          kind: ops.paused.kind,
          reason: ops.paused.reason,
          since: ops.paused.since,
          until: ops.paused.until ?? null,
        }
      : null,
    nextTickInMs: ops?.nextTickInMs ?? null,
    operatorStatus: ops !== undefined,
  };
}

/** `name` and every running agent below it in the spawn lineage (children-first order). */
export function descendantAgents(engine: Engine, name: string): string[] {
  const runtime = engine.agentRuntime;
  const seen = new Set<string>();
  const out: string[] = [];
  const walk = (n: string) => {
    for (const child of runtime.childrenOf(n)) {
      if (seen.has(child)) continue;
      seen.add(child);
      walk(child);
      out.push(child);
    }
  };
  walk(name);
  return out;
}

/**
 * Rows visible to `scope`: everything when privileged, else the agents the
 * caller spawned — transitively, so a lead's crew counts (runtime lineage +
 * persisted `spawned_by`) — plus the caller's own handle when the caller IS a
 * running agent.
 */
export function listAgentRows(engine: Engine, scope: OpsObserverScope): AgentOperatorRow[] {
  const runtime = engine.agentRuntime;
  const names = runtime.list().map((s) => s.name);
  let visible: string[];
  if (scope.privileged) {
    visible = names;
  } else if (scope.entityName) {
    const own = new Set(descendantAgents(engine, scope.entityName));
    for (const name of names) {
      const handle = runtime.get(name);
      if (handle && scope.entityId && handle.getStatus().entityId === scope.entityId) own.add(name);
    }
    visible = names.filter((n) => own.has(n));
  } else {
    visible = [];
  }
  const rows: AgentOperatorRow[] = [];
  for (const name of visible) {
    const row = agentRow(engine, name);
    if (row) rows.push(row);
  }
  rows.sort((a, b) => b.cost.lastHourUsd - a.cost.lastHourUsd || a.name.localeCompare(b.name));
  return rows;
}

function spendOf(engine: Engine, rows: AgentOperatorRow[]): OpsSpend {
  const limits = engine.agentRuntime.getSpendLimits();
  let lastHourUsd = 0;
  let totalUsd = 0;
  for (const row of rows) {
    lastHourUsd += row.cost.lastHourUsd;
    totalUsd += row.cost.totalUsd;
  }
  return {
    lastHourUsd,
    totalUsd,
    caps: {
      perAgentUsd: limits.perAgentUsdPerHour ?? null,
      globalUsd: limits.globalUsdPerHour ?? null,
    },
  };
}

// ─── Retention ──────────────────────────────────────────────────────────────

function retentionOf(): OpsRetention {
  return {
    lastReport: getLastRetentionReport(),
    policies: describeRetentionPolicies().map((p) => ({
      table: p.table,
      kind: p.kind,
      keep: p.keep,
      overridden: p.overridden,
      ...(p.note ? { note: p.note } : {}),
    })),
  };
}

// ─── Prompt budget (memoized per minute) ────────────────────────────────────

const PROMPT_MEMO_MS = 60_000;
let promptMemo: OpsPromptBudget | null = null;

const serializedToolBytes = (
  tools: readonly { name: string; description: string; parameters: unknown }[],
) =>
  tools.reduce(
    (n, t) =>
      n +
      Buffer.byteLength(
        JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }),
        "utf8",
      ),
    0,
  );

/**
 * Tool schemas are measured with an inert context: `createProfileToolset`
 * only closes over `ctx` inside `execute`, which is never invoked here.
 */
function measureToolSchemas(): Pick<
  OpsPrompt,
  "residentSchemaBytesByProfile" | "deferredSchemaBytes" | "deferredToolCount"
> {
  const ctx = {
    client: {
      isConnected: () => false,
      command: async () => {
        throw new Error("inert measurement context");
      },
    },
    gameState: { handlePerception: () => {} },
  } as unknown as ToolContext;
  const memory = {} as unknown as PlatformMemoryBackend;
  const resident: Record<OpsToolProfile, number> = { full: 0, crew: 0, minimal: 0 };
  let deferredSchemaBytes = 0;
  let deferredToolCount = 0;
  for (const profile of ["full", "crew", "minimal"] as ToolProfile[]) {
    try {
      const set = createProfileToolset(ctx, memory, profile);
      resident[profile] = serializedToolBytes(set.resident);
      if (profile === "full") {
        deferredSchemaBytes = serializedToolBytes(set.deferred);
        deferredToolCount = set.deferred.length;
      }
    } catch (error) {
      logger.warn("ops", `tool schema measurement failed for ${profile}`, {
        profile,
        error: getErrorMessage(error),
      });
    }
  }
  return { residentSchemaBytesByProfile: resident, deferredSchemaBytes, deferredToolCount };
}

/** The static, per-process measurements of `OpsPrompt` (memoized); the event-derived sections are added per request. */
export type OpsPromptBudget = Omit<OpsPrompt, "sections" | "turnsSampled">;

export function promptBudget(now = Date.now()): OpsPromptBudget {
  if (promptMemo && now - promptMemo.computedAt < PROMPT_MEMO_MS) return promptMemo;
  let systemPromptBytes = 0;
  try {
    systemPromptBytes = Buffer.byteLength(getLeanSystemPrompt(null), "utf8");
  } catch (error) {
    logger.warn("ops", "system prompt measurement failed", { error: getErrorMessage(error) });
  }
  promptMemo = {
    deferredTools: deferredToolsEnabled(),
    systemPromptBytes,
    systemPromptCapBytes: LEAN_SYSTEM_PROMPT_BYTE_CAP,
    ...measureToolSchemas(),
    continuationBudgetBytes: CONTINUATION_PROMPT_BUDGET_BYTES,
    computedAt: now,
  };
  return promptMemo;
}

/** @internal test seam */
export function resetPromptBudgetMemoForTests(): void {
  promptMemo = null;
  promptSectionsMemo.clear();
}

// ─── Prompt sections (event log, last 24 h) ─────────────────────────────────

export const PROMPT_SECTIONS_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Bound on trace events read per aggregate (the event log's own trace window). */
const PROMPT_SECTIONS_EVENT_LIMIT = 5000;
/** Re-aggregate at most this often per scope while no new event has landed. */
const PROMPT_SECTIONS_MEMO_MS = 30_000;

type PromptSectionsView = Pick<OpsPrompt, "sections" | "turnsSampled">;
const promptSectionsMemo = new Map<
  string,
  { maxEventId: number; computedAt: number; view: PromptSectionsView }
>();

/**
 * `agent_turn_start` events of the last 24 h, in scope: every agent for a
 * privileged principal; for a resident only the turns of agents it can see in
 * the overview (`visibleAgents` — its lineage plus itself). Reads the durable
 * `event_log` (the same rows `trace` projects) and falls back to the in-memory
 * log when the engine runs without a database.
 */
function promptTurnSamplesInScope(
  engine: Engine,
  scope: OpsObserverScope,
  visibleAgents: readonly string[],
  now: number,
): PromptTurnSample[] {
  const events: EngineEvent[] = engine.db
    ? engine.db.getRecentTraceEvents(PROMPT_SECTIONS_EVENT_LIMIT).events
    : engine.getEventLog();
  const since = now - PROMPT_SECTIONS_WINDOW_MS;
  const allowed = new Set(visibleAgents);
  if (scope.entityName) allowed.add(scope.entityName);
  const samples: PromptTurnSample[] = [];
  for (const event of events) {
    if (event.type !== "agent_turn_start" || event.timestamp < since) continue;
    if (!scope.privileged && !allowed.has(event.name)) continue;
    const sample = promptTurnSampleFromEvent(event);
    if (sample) samples.push(sample);
  }
  return samples;
}

export function promptSectionsOverview(
  engine: Engine,
  scope: OpsObserverScope,
  visibleAgents: readonly string[],
  now = Date.now(),
): PromptSectionsView {
  const key = scope.privileged
    ? "*"
    : `r:${scope.entityName ?? ""}:${[...visibleAgents].sort().join(",")}`;
  const maxEventId = engine.db?.getMaxEventId() ?? -1;
  const cached = promptSectionsMemo.get(key);
  if (
    cached &&
    cached.maxEventId === maxEventId &&
    now - cached.computedAt < PROMPT_SECTIONS_MEMO_MS
  ) {
    return cached.view;
  }
  const aggregate = aggregatePromptSections(
    promptTurnSamplesInScope(engine, scope, visibleAgents, now),
  );
  const view: PromptSectionsView = {
    sections: aggregate.sections.map(
      (row): OpsPromptSection => ({
        name: row.name,
        turns: row.turns,
        meanBytes: row.meanBytes,
        p95Bytes: row.p95Bytes,
        deferralRate: row.deferralRate,
        share: row.share,
      }),
    ),
    turnsSampled: aggregate.turnsSampled,
  };
  promptSectionsMemo.set(key, { maxEventId, computedAt: now, view });
  if (promptSectionsMemo.size > 200) {
    const oldest = promptSectionsMemo.keys().next().value;
    if (oldest !== undefined) promptSectionsMemo.delete(oldest);
  }
  return view;
}

// ─── Providers ──────────────────────────────────────────────────────────────

export function providerProbeSummary(): ProviderProbeSummary[] | null {
  const last = getLastProviderProbe();
  if (!last) return null;
  return last.map((p) => ({
    provider: p.provider,
    model: p.model,
    ok: p.ok,
    status: p.status,
    latencyMs: p.latencyMs,
    textOk: p.textOk,
    systemHonored: p.systemHonored,
    toolCallOk: p.toolCallOk ?? null,
    toolCallError: p.toolCallError ?? null,
    servedBy: p.servedBy ?? null,
    error: p.error ?? null,
    checkedAt: p.checkedAt,
  }));
}

// ─── Security posture ───────────────────────────────────────────────────────

/**
 * Same resolution as `resolveWsBindHostname` + `isLoopbackHostname` in
 * websocket-server.ts, kept local so this module does not join the
 * websocket-server → dashboard-api import cycle.
 */
export function loopbackBindFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = (env.WS_HOST ?? env.MARINA_HOST ?? "").trim();
  const host = explicit
    ? explicit
    : (env.MARINA_PUBLIC ?? "").trim().toLowerCase() === "true"
      ? "0.0.0.0"
      : "127.0.0.1";
  const h = host.toLowerCase();
  return h === "localhost" || h === "::1" || h.startsWith("127.");
}

/**
 * Mirrors `mcpTransportAuthRequired` in mcp-server.ts: keys configured,
 * sign-in enabled, or a non-loopback bind turn the bearer requirement on.
 */
export function mcpAuthRequiredFromEnv(
  loopbackBind: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const secrets = (env.MODEL_API_KEYS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return secrets.length > 0 || env.MARINA_AUTH === "better-auth" || !loopbackBind;
}

const LIMITER_KEYING: Record<keyof typeof HTTP_RATE_LIMITS, OpsLimiter["keyedBy"]> = {
  dashboard: "principal",
  mutation: "principal",
  publicRead: "ip",
  mcpSession: "ip",
};

export function securityPosture(engine: Engine): OpsSecurity {
  const loopbackBind = loopbackBindFromEnv();
  return {
    trustProfile: getTrustProfile(),
    ungated: isLocalUngated(),
    autonomy: getAutonomyPosture(),
    mcpAuthRequired: mcpAuthRequiredFromEnv(loopbackBind),
    openApi: isOpenApiMode(),
    trustProxy: process.env.MARINA_TRUST_PROXY === "true",
    authRequired: !!engine.config.authRequired,
    loopbackBind,
    commandLimiterBypassed: RateLimiter.bypass,
    limiters: (Object.keys(HTTP_RATE_LIMITS) as (keyof typeof HTTP_RATE_LIMITS)[]).map((name) => ({
      name,
      maxTokens: HTTP_RATE_LIMITS[name].maxTokens,
      refillIntervalMs: HTTP_RATE_LIMITS[name].refillInterval,
      keyedBy: LIMITER_KEYING[name],
    })),
  };
}

// ─── Overview ───────────────────────────────────────────────────────────────

/** Window and cap for the Decisions section. */
export const DECISIONS_WINDOW_MS = 24 * 3_600_000;
export const DECISIONS_RECENT_MAX = 50;

/**
 * Harness decisions in scope: every agent for a privileged observer, else the
 * resident's own agents and the resident itself (a `verify` decision is filed
 * under the submitting entity). Read from the in-memory event log — this is a
 * recent-activity view, not an archive.
 */
export function decisionsOverview(
  engine: Engine,
  scope: OpsObserverScope,
  visibleAgents: readonly string[],
  now = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): OpsDecisions {
  const config = decisionConfigFromEnv(env);
  const allowed = new Set(visibleAgents);
  if (scope.entityName) allowed.add(scope.entityName);
  const since = now - DECISIONS_WINDOW_MS;
  const counts: Record<string, Record<string, number>> = {};
  const rows: OpsDecisionRow[] = [];
  for (const event of engine.getEventLog()) {
    if (event.type !== "agent_decision" || event.timestamp < since) continue;
    if (!scope.privileged && !allowed.has(event.name)) continue;
    const byVerdict = (counts[event.stage] ??= {});
    byVerdict[event.verdict] = (byVerdict[event.verdict] ?? 0) + 1;
    const { type: _type, ...row } = event;
    rows.push(row);
  }
  rows.sort((a, b) => b.timestamp - a.timestamp);
  return {
    configured: !!config,
    backend: config?.kind ?? null,
    model: config?.model ?? null,
    calibrated: config ? config.kind !== "chat-classifier" : null,
    gate: decisionGateEnabled(env),
    verify: decisionVerifyEnabled(env),
    windowMs: DECISIONS_WINDOW_MS,
    counts,
    recent: rows.slice(0, DECISIONS_RECENT_MAX),
    health: decisionsHealthFor(engine, scope, now),
  };
}

/** Backend health is world-wide (one backend serves everyone); the failure TEXT
 * may quote upstream error bodies, so only a privileged observer sees it. */
function decisionsHealthFor(engine: Engine, scope: OpsObserverScope, now: number) {
  const { status, total, errors, lastError } = decisionHealth(engine.getEventLog(), now);
  return {
    status,
    total,
    errors,
    ...(scope.privileged && lastError ? { lastError } : {}),
  };
}

export function buildOpsOverview(engine: Engine, scope: OpsObserverScope): OpsOverview {
  const agents = listAgentRows(engine, scope);
  return {
    generatedAt: Date.now(),
    scope: scope.privileged ? "privileged" : "resident",
    agents,
    spend: spendOf(engine, agents),
    retention: retentionOf(),
    prompt: {
      ...promptBudget(),
      ...promptSectionsOverview(
        engine,
        scope,
        agents.map((row) => row.name),
      ),
    },
    providers: scope.privileged ? providerProbeSummary() : null,
    security: securityPosture(engine),
    decisions: decisionsOverview(
      engine,
      scope,
      agents.map((row) => row.name),
    ),
  };
}

// ─── Stop (cascade) ─────────────────────────────────────────────────────────

/**
 * Stop `name` and the agents it spawned, children first, emitting one
 * `agent_stop` lifecycle event per stopped agent (the same event the in-world
 * `agent stop` logs, so `crewManager.onAgentStopped` and the dashboards see
 * the departure). Returns null when no such agent is running.
 */
export async function stopAgentCascade(
  engine: Engine,
  name: string,
): Promise<OpsAgentStopResponse | null> {
  const runtime = engine.agentRuntime;
  const root = runtime.get(name);
  if (!root) return null;
  // Snapshot entity ids before the handles go away.
  const entityIds = new Map<string, EntityId | null>();
  for (const n of [root.name, ...descendantAgents(engine, root.name)]) {
    const handle = runtime.get(n);
    if (handle) entityIds.set(handle.name, handle.getStatus().entityId);
  }
  const { stoppedChildren } = await runtime.stopWithReport(name);
  const stopped = root.name;
  for (const n of [...stoppedChildren, stopped]) {
    engine.logEvent({
      type: "agent_stop",
      entity: (entityIds.get(n) ?? "") as EntityId,
      name: n,
      reason: "manual",
      timestamp: Date.now(),
    });
  }
  return { stopped, stoppedChildren };
}
