// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentRuntime } from "../agent/agent-runtime";
import { recomputeAll as recomputeStanding } from "../agent/standing";
import { runArenaAutopilot, runArenaShadow } from "../arena/service";
import type { BoardManager } from "../coordination/board-manager";
import type { ChannelManager } from "../coordination/channel-manager";
import type { TaskManager } from "../coordination/task-manager";
import type { FlywheelToolBackend } from "../integrations/flywheel-manager";
import { memoryObservabilityPollTicks, pollMemoryEvents } from "../net/memory-observability";
import { cleanupStaleConversationChannels } from "../net/model-api";
import type { MarinaDB } from "../persistence/database";
import { syncOperationalAlerts } from "./commands/ops";
import {
  AGENT_CLEANUP_INTERVAL,
  BOARD_ARCHIVE_AGE_DAYS,
  BOARD_ARCHIVE_INTERVAL,
  CHANNEL_PRUNE_INTERVAL,
  CONVERSATION_CLEANUP_INTERVAL,
  NOTE_IMPORTANCE_INTERVAL,
} from "./constants";
import type { Engine, EngineConfig } from "./engine";
import { tryLog } from "./errors";
import type { Logger } from "./logger";
import { MEMORY_ACCUMULATION_PHASE, runEngineAccumulationDispatch } from "./memory-dispatch";
import { MEMORY_HYGIENE_PHASE, runEngineMemoryHygiene } from "./memory-hygiene";
import { formatRetentionSummary, RETENTION_TICK_PHASE, runRetentionPass } from "./retention";
import type { TickScheduler } from "./tick-scheduler";

/** The autonomy pulse cadence (5 minutes, matching readiness's evidence window) in ticks. */
export const AUTONOMY_PULSE_MS = 5 * 60_000;
export function autonomyPulseTicks(tickIntervalMs: number): number {
  return Math.max(1, Math.round(AUTONOMY_PULSE_MS / Math.max(1, tickIntervalMs)));
}

/**
 * What the periodic jobs need from the engine. Every field is a getter on the
 * engine's side: `registerTickJobs` runs in the constructor, but collaborators
 * (`db`, the managers) may be assigned afterwards, so a job must read the
 * CURRENT value when it fires rather than the value captured at registration.
 */
export interface TickJobHost {
  /**
   * The engine itself, for the three collaborators that take it whole
   * (`runEngineMemoryHygiene`, `runEngineAccumulationDispatch`,
   * `pollMemoryEvents`). Everything else reads a narrow member below.
   */
  readonly engine: Engine;
  readonly db?: MarinaDB;
  readonly logger: Logger;
  readonly config: EngineConfig;
  readonly channelManager?: ChannelManager;
  readonly boardManager?: BoardManager;
  readonly taskManager?: TaskManager;
  readonly agentRuntime: AgentRuntime;
  readonly flywheel?: FlywheelToolBackend;
  /** `() => computeReadiness(engine)` — the alert sync needs the live report. */
  readonly readiness: () => ReturnType<typeof import("./readiness").computeReadiness>;
  cleanupOrphanedAgents(): void;
  applyRankProgression(db: MarinaDB): void;
}

/**
 * Declare the periodic maintenance jobs. Every job fires on
 * `tick % every === phase`; the scheduler rejects two jobs sharing a slot.
 * The hourly jobs share a 3600-tick interval but run at DISTINCT phases so
 * they never all land on the same tick — previously board-archive +
 * note-importance + alerts + standing + rank progression all fired together
 * on tick 3600, outside the tick budget. Optional collaborators
 * (`db`, managers) are checked when the job runs, not when it is declared.
 */
export function registerTickJobs(host: TickJobHost, s: TickScheduler): void {
  // Every ~5 minutes of wall clock: snapshot the autonomy numbers so
  // `readiness autonomy` can report a trend, not only the current window.
  const pulseEvery = autonomyPulseTicks(host.config.tickInterval);
  s.register({
    name: "autonomy-pulse",
    every: pulseEvery,
    // Phase 1, never 0: an equal interval must not collide with the phase-0
    // jobs (register() refuses a shared slot, which would fail boot).
    phase: pulseEvery > 1 ? 1 : 0,
    failureMessage: "Autonomy pulse snapshot failed",
    run: () => {
      if (!host.db) return;
      const d = host.readiness().demo;
      host.db.recordAutonomyPulse({
        at: Date.now(),
        activeAgents: d.activeAgents,
        primitiveActions: d.recentPrimitiveActions,
        communications: d.recentCommunications,
        toolCalls: d.marinaToolCalls,
        ...(d.medianResponseMs === undefined ? {} : { medianResponseMs: d.medianResponseMs }),
        qualified: d.autonomyQualified,
      });
    },
  });

  s.register({
    name: "board-archive",
    every: BOARD_ARCHIVE_INTERVAL,
    phase: 300,
    failureMessage: "Board auto-archive failed",
    run: () => {
      host.boardManager?.autoArchive(BOARD_ARCHIVE_AGE_DAYS, 0);
    },
  });

  // Channel prune + Flywheel workspace maintenance share the slot: the
  // prune runs inside the tick, the maintenance is fire-and-forget with its
  // own warning (category `flywheel`).
  s.register({
    name: "channel-prune",
    every: CHANNEL_PRUNE_INTERVAL,
    phase: 0,
    failureMessage: "Channel prune failed",
    run: () => {
      host.flywheel?.maintenance?.().catch((error: unknown) => {
        host.logger.warn("flywheel", "Workspace maintenance failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      host.channelManager?.pruneExpiredMessages();
    },
  });

  // Hourly: clean up stale model conversation channels
  // Hourly: file due Social Simulation Arena rounds (MARINA_ARENA_AUTOPILOT=on;
  // a no-op otherwise). Fire-and-forget — network and signing never touch the tick.
  s.register({
    name: "arena-autopilot",
    every: CONVERSATION_CLEANUP_INTERVAL,
    phase: 1500,
    failureMessage: "Arena autopilot failed",
    run: () => {
      const db = host.db;
      if (!db) return;
      return Promise.all([runArenaAutopilot(db), runArenaShadow(db)]).then(() => undefined);
    },
  });

  s.register({
    name: "conversation-cleanup",
    every: CONVERSATION_CLEANUP_INTERVAL,
    phase: 600,
    failureMessage: "Conversation cleanup failed",
    run: () => {
      if (host.channelManager) cleanupStaleConversationChannels(host.channelManager);
    },
  });

  // Hourly: adjust note importance based on recall patterns. Three
  // independent passes — one failing must not skip the others.
  s.register({
    name: "note-importance",
    every: NOTE_IMPORTANCE_INTERVAL,
    phase: 1200,
    run: () => {
      const db = host.db;
      if (!db) return;
      tryLog(host.logger, "tick", "Note importance adjustment failed", () =>
        db.adjustNoteImportance(),
      );
      tryLog(host.logger, "tick", "Memory confidence calibration failed", () =>
        db.calibrateMemoryConfidence(),
      );
      tryLog(host.logger, "tick", "Shared contradiction scan failed", () =>
        db.refreshContradictionCases(),
      );
    },
  });

  s.register({
    name: "operational-alerts",
    every: NOTE_IMPORTANCE_INTERVAL,
    phase: 1800,
    failureMessage: "Operational alert sync failed",
    run: () => {
      if (!host.db || !host.taskManager) return;
      syncOperationalAlerts({
        db: host.db,
        tasks: host.taskManager,
        runtime: host.agentRuntime,
        readiness: host.readiness,
      });
    },
  });

  // Hourly: refresh civic-standing rollup cache from the ledger.
  // Decay is real-valued; reads recompute on cache stale, but a periodic
  // pass keeps the leaderboard hot without waiting for a read on every
  // entity.
  s.register({
    name: "standing-recompute",
    every: NOTE_IMPORTANCE_INTERVAL,
    phase: 2400,
    failureMessage: "Standing recompute failed",
    run: () => {
      if (host.db) recomputeStanding(host.db);
    },
  });

  // Hourly: memory hygiene — count the durable review queue (stale /
  // competing) + legacy note findings per online resident, write one
  // process-tier `[hygiene]` line, and (local profile) file an evaluator
  // review when the queue is deep enough. Async: the review/assist calls go
  // through the resident memory client, so this is fire-and-forget under
  // tryLogAsync rather than blocking the tick budget.
  s.register({
    name: "memory-hygiene",
    every: NOTE_IMPORTANCE_INTERVAL,
    phase: MEMORY_HYGIENE_PHASE,
    failureMessage: "Memory hygiene failed",
    run: async () => {
      if (!host.db) return;
      await runEngineMemoryHygiene(host.engine);
    },
  });

  // Hourly (own phase): accumulation → reflector. Per online resident, ≥ N
  // fact-like notes on one topic inside the 24h window file ONE reflector
  // job to consolidate them into a cited lesson (memory-dispatch.ts).
  // Same fire-and-forget shape as hygiene — durable calls never block the tick.
  s.register({
    name: "memory-accumulation",
    every: NOTE_IMPORTANCE_INTERVAL,
    phase: MEMORY_ACCUMULATION_PHASE,
    failureMessage: "Memory accumulation dispatch failed",
    run: async () => {
      if (!host.db) return;
      await runEngineAccumulationDispatch(host.engine);
    },
  });

  // ~2 s: memory observability poller. Reads `memory_service_events` past
  // the last seen seq (indexed, O(new rows), capped per call) and emits
  // `memory_job` / `memory_service_event` for dashboard clients. Sync SQL —
  // never awaits; the first call only primes the cursor.
  s.register({
    name: "memory-observability-poll",
    every: memoryObservabilityPollTicks(host.config.tickInterval),
    phase: 0,
    failureMessage: "Memory observability poll failed",
    run: () => {
      if (host.db) pollMemoryEvents(host.engine);
    },
  });

  // Hourly (own phase): declarative row retention — event_log (row-bounded,
  // MARINA_EVENT_RETENTION), telemetry / ledger / audit tables by age, in
  // ≤ 5k-row batches (src/engine/retention.ts, MARINA_RETENTION_OVERRIDES).
  // Without this the append-only tables grow for the life of the deployment
  // and every scan over them (traces, activity, expiry) degrades linearly.
  s.register({
    name: "retention",
    every: NOTE_IMPORTANCE_INTERVAL,
    phase: RETENTION_TICK_PHASE,
    failureMessage: "Retention pass failed",
    run: async () => {
      const db = host.db;
      if (!db) return;
      const result = runRetentionPass(db);
      if (result.skipped.length) {
        host.logger.debug("retention", "Skipped tables missing from this schema", {
          tables: result.skipped,
        });
      }
      if (result.rejectedOverrides.length) {
        host.logger.warn("retention", "Ignored MARINA_RETENTION_OVERRIDES entries", {
          entries: result.rejectedOverrides,
        });
      }
      if (Object.keys(result.deleted).length > 0) {
        host.logger.info("retention", `Pruned ${formatRetentionSummary(result)}`);
      }
    },
  });

  // Periodic: clean up orphaned agents (entities without active connections).
  // Critical: ran unwrapped before the extraction, so a throw reaches the
  // tick error counter instead of a warning.
  s.register({
    name: "agent-cleanup",
    every: AGENT_CLEANUP_INTERVAL,
    phase: 0,
    critical: true,
    run: () => host.cleanupOrphanedAgents(),
  });

  // Hourly: check rank progression for all online entities (critical for the
  // same reason as agent-cleanup; each entity is already guarded individually).
  s.register({
    name: "rank-progression",
    every: NOTE_IMPORTANCE_INTERVAL,
    phase: 3000,
    critical: true,
    run: () => {
      if (host.db) host.applyRankProgression(host.db);
    },
  });
}
