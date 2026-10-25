// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentRuntime } from "../agent/agent-runtime";
import { recomputeAll as recomputeStanding } from "../agent/standing";
import { runArenaAutopilot, runArenaFilingWatch, runArenaShadow } from "../arena/service";
import type { SandboxProviders } from "../coding/sandbox-provider";
import type { BoardManager } from "../coordination/board-manager";
import type { ChannelManager } from "../coordination/channel-manager";
import type { TaskManager } from "../coordination/task-manager";
import { flushWorkLessons } from "../learning/work";
import { memoryObservabilityPollTicks, pollMemoryEvents } from "../net/memory/memory-observability";
import { cleanupStaleConversationChannels } from "../net/model/model-api";
import { autoresolveLinked } from "../outcomes/autoresolve";
import { settleBenchmarkRuns } from "../outcomes/benchmark";
import { deliverOutcomes } from "../outcomes/deliver";
import { judgeWaitingWork } from "../outcomes/judge-quality";
import { judgeOpenResolutions } from "../outcomes/judge-resolution";
import type { MarinaDB } from "../persistence/database";
import { backfillMemoryKnownAt } from "../persistence/db-memory-known-at";
import { refreshDeadlines, runDueSchedules } from "../schedules/runner";
import {
  ASSISTANCE_EXPIRY_PHASE,
  engineAssistanceExpiryDeps,
  formatAssistanceExpiry,
  runAssistanceExpiry,
} from "./assistance-expiry";
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
import { getErrorMessage, tryLog } from "./errors";
import { runLivePromotionPass } from "./live-promotion";
import type { Logger } from "./logger";
import { backfillAssets } from "./media/asset-library";
import { engineAssetDescriber, runAssetMemoryPass } from "./media/asset-memory";
import type { MediaManager } from "./media/manager";
import { MEMORY_ACCUMULATION_PHASE, runEngineAccumulationDispatch } from "./memory-dispatch";
import { MEMORY_HYGIENE_PHASE, runEngineMemoryHygiene } from "./memory-hygiene";
import {
  formatRetentionSummary,
  pruneRequestImageBlobs,
  RETENTION_TICK_PHASE,
  runRetentionPass,
} from "./retention";
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
  readonly sandboxes?: SandboxProviders;
  readonly mediaManager?: Pick<MediaManager, "pollRunningVideoJobs">;
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
      for (const provider of host.sandboxes?.list() ?? []) {
        provider.maintenance?.().catch((error: unknown) => {
          host.logger.warn("flywheel", "Workspace maintenance failed", {
            provider: provider.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
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

  // Every ~10 min: watch the arena filings of rounds locking within 24 h
  // (src/arena/filing-watch.ts). Read-only — filing stays the operator's act
  // outside the world; this raises an alert when that runner fails or stalls.
  // A no-op with no entrant configured.
  s.register({
    name: "arena-filing-watch",
    every: ARENA_FILING_WATCH_INTERVAL,
    phase: ARENA_FILING_WATCH_PHASE,
    failureMessage: "Arena filing watch failed",
    run: () => {
      const db = host.db;
      if (!db) return;
      return runArenaFilingWatch(db).then(() => undefined);
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

  // Hourly (own phase): close memory-assistance jobs nobody can work any more
  // — deadline passed, or the worker's account has no running agent or live
  // connection (src/engine/assistance-expiry.ts). State `expired` + one memory
  // event per job; nothing is deleted, `ops assistance restore <id>` reopens.
  s.register({
    name: "assistance-expiry",
    every: NOTE_IMPORTANCE_INTERVAL,
    phase: ASSISTANCE_EXPIRY_PHASE,
    failureMessage: "Assistance-job expiry failed",
    run: () => {
      const db = host.db;
      if (!db) return;
      const report = runAssistanceExpiry(engineAssistanceExpiryDeps(host.engine, db));
      if (report.expired.length > 0)
        host.logger.info("memory", `Assistance jobs ${formatAssistanceExpiry(report)}`);
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
      // Staged request images: bytes first, so the row pass never orphans a blob.
      await pruneRequestImageBlobs(db, host.engine.storage);
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

  // Hourly (own phase): lessons from work (MARINA_LESSONS_FROM_WORK; unset:
  // on with a model provider, else observe). The aggregated tool-work patterns become judged lessons (on) or a
  // counts-only log line (observe). Async and self-bounded (MAX_PER_FLUSH,
  // daily spend cap); never overlaps itself.
  s.register({
    name: "lessons-from-work",
    every: NOTE_IMPORTANCE_INTERVAL,
    phase: LESSONS_FROM_WORK_PHASE,
    failureMessage: "Lessons from work failed",
    run: async () => {
      if (!host.db) return;
      await flushWorkLessons(host.db);
    },
  });

  // Every five minutes: deliver recorded outcomes still pending (src/outcomes/).
  // Producers schedule delivery as they record; this pass catches what waited
  // for the lesson budget or a verdict, and what a restart interrupted.
  s.register({
    name: "outcome-delivery",
    every: OUTCOME_DELIVERY_INTERVAL,
    phase: OUTCOME_DELIVERY_PHASE,
    failureMessage: "Outcome delivery failed",
    run: async () => {
      if (!host.db) return;
      await deliverOutcomes(host.db);
    },
  });

  // Every ~5 s: poll the `running` video jobs in the database (the only video
  // polling path). Durable: a restart resumes them on its first pass, and each
  // job fails past MARINA_VIDEO_JOB_TIMEOUT_MIN. Async — the scheduler never
  // overlaps it with itself and shutdown drains it before the DB closes.
  const mediaPollEvery = mediaVideoPollTicks(host.config.tickInterval);
  s.register({
    name: "media-video-poll",
    every: mediaPollEvery,
    phase: mediaVideoPollPhase(mediaPollEvery),
    failureMessage: "Video job poll failed",
    run: async () => {
      await host.mediaManager?.pollRunningVideoJobs();
    },
  });

  // Every ~10 s: run due schedules (src/schedules/runner.ts). Next-run times
  // are wall-clock and durable, so a restart or a slow tick never shifts them;
  // each run is detached, so a slow command never delays the others.
  s.register({
    name: "schedules",
    every: SCHEDULES_INTERVAL,
    phase: SCHEDULES_PHASE,
    failureMessage: "Schedule pass failed",
    run: () => {
      runDueSchedules(host.engine);
      // Referenced deadlines are re-read at most every 10 minutes, detached.
      void host.engine.trackBackground(
        refreshDeadlines(host.engine).catch((error: unknown) =>
          host.logger.warn("schedules", `deadline refresh failed: ${getErrorMessage(error)}`),
        ),
      );
    },
  });

  // Hourly: check the markets that open answers are linked to; a resolved one
  // settles them through the calibration finder (MARINA_OUTCOME_AUTORESOLVE).
  // Also records every completed benchmark run with no outcome yet — runs a
  // CLI importer wrote from another process, and the backlog from before
  // benchmark runs were recorded (src/outcomes/benchmark.ts; a no-op after).
  s.register({
    name: "outcome-autoresolve",
    every: NOTE_IMPORTANCE_INTERVAL,
    phase: OUTCOME_AUTORESOLVE_PHASE,
    failureMessage: "Automatic outcome resolution failed",
    run: async () => {
      if (!host.db) return;
      const db = host.db;
      tryLog(host.logger, "tick", "Benchmark outcome sweep failed", () => {
        settleBenchmarkRuns(db);
      });
      await autoresolveLinked(host.db);
    },
  });

  // Hourly: past-end answers no market settles get a judged resolution
  // (MARINA_OUTCOME_JUDGE; unset: on with a model provider, else off): observe
  // records it; on also settles when the judge has earned agreement. Bounded
  // and spend-capped.
  s.register({
    name: "outcome-judge",
    every: NOTE_IMPORTANCE_INTERVAL,
    phase: OUTCOME_JUDGE_PHASE,
    failureMessage: "Judged outcome resolution failed",
    run: async () => {
      if (!host.db) return;
      await judgeOpenResolutions(host.db);
      await judgeWaitingWork(host.db);
    },
  });

  // Every 6 h: judge role-model:<role> slots on shared live work. Records
  // refused attempts and raises one ops-inbox proposal per passing candidate;
  // never files a promotion (a person holding role.edit does that).
  s.register({
    name: "live-promotion",
    every: LIVE_PROMOTION_INTERVAL,
    phase: LIVE_PROMOTION_PHASE,
    failureMessage: "Live promotion pass failed",
    run: () => {
      if (!host.db) return;
      runLivePromotionPass(host.db);
    },
  });

  // Every ~30 s: fill sha256/dimensions and derivatives (thumbnails, posters,
  // previews) for a few assets that lack them — rows from before migration
  // 168 and writers that skip the library. Bounded per pass; boot never waits.
  const assetEvery = assetBackfillTicks(host.config.tickInterval);
  s.register({
    name: "asset-backfill",
    every: assetEvery,
    phase: assetBackfillPhase(assetEvery),
    failureMessage: "Asset backfill failed",
    run: async () => {
      if (!host.db) return;
      await backfillAssets(host.engine);
      // Then memory over media (MARINA_MEDIA_MEMORY): a few assets' text into
      // their owners' canonical memory, and deleted assets' records retired.
      await runAssetMemoryPass(host.engine, {
        describe: engineAssetDescriber(host.engine),
      }).catch((error: unknown) =>
        host.logger.warn("media", `asset memory pass failed: ${getErrorMessage(error)}`),
      );
    },
  });

  // Every 10 ticks (phase 5, clear of schedules' 3): copy the dates of the
  // memory events that predate migration 172 onto their version, source and
  // proposal rows (src/persistence/db-memory-known-at.ts) — a few short
  // seq-range batches per pass; boot never waits, and a finished backfill
  // costs one row read.
  s.register({
    name: "memory-known-at-backfill",
    every: KNOWN_AT_BACKFILL_INTERVAL,
    phase: KNOWN_AT_BACKFILL_PHASE,
    failureMessage: "Memory known-at backfill failed",
    run: () => {
      if (host.db) backfillMemoryKnownAt(host.db.memoryRepository().raw);
    },
  });
}

/** The known-at backfill's interval (ticks) and phase. */
export const KNOWN_AT_BACKFILL_INTERVAL = 10;
export const KNOWN_AT_BACKFILL_PHASE = 5;

/** Wall-clock cadence of the asset backfill. */
export const ASSET_BACKFILL_MS = 30_000;
/** The asset backfill's interval in ticks (at least 2). */
export function assetBackfillTicks(tickIntervalMs: number): number {
  return Math.max(2, Math.round(ASSET_BACKFILL_MS / Math.max(1, tickIntervalMs)));
}
/** Its phase: 7 when the interval allows, else 0 (clear of the video poller's 1 and 4). */
export function assetBackfillPhase(every: number): number {
  return every > 7 ? 7 : 0;
}

/** Wall-clock cadence of the durable video-job poller. */
export const MEDIA_VIDEO_POLL_MS = 5_000;
/** The video poller's interval in ticks (at least 2, so it can take a phase of its own). */
export function mediaVideoPollTicks(tickIntervalMs: number): number {
  return Math.max(2, Math.round(MEDIA_VIDEO_POLL_MS / Math.max(1, tickIntervalMs)));
}
/** Its phase: 4 when the interval allows (clear of the schedules job's 3), else 1. */
export function mediaVideoPollPhase(every: number): number {
  return every > 4 ? 4 : 1;
}

/** The hourly phase of judged resolution of unlinked answers (src/outcomes/judge-resolution.ts). */
export const OUTCOME_JUDGE_PHASE = 3150;

/** The hourly phase of automatic resolution of market-linked answers (src/outcomes/autoresolve.ts). */
export const OUTCOME_AUTORESOLVE_PHASE = 3450;

/** Ticks between arena filing-watch passes (src/arena/filing-watch.ts). */
export const ARENA_FILING_WATCH_INTERVAL = 600;
/** Its phase within that interval. */
export const ARENA_FILING_WATCH_PHASE = 420;

/** Ticks between schedule passes (src/schedules/runner.ts). */
export const SCHEDULES_INTERVAL = 10;
/** Its phase within that interval. */
export const SCHEDULES_PHASE = 3;

/** Ticks between outcome-delivery passes (src/outcomes/deliver.ts). */
export const OUTCOME_DELIVERY_INTERVAL = 300;
/** Its phase within that interval. */
export const OUTCOME_DELIVERY_PHASE = 150;

/** Ticks between live-promotion passes (src/engine/live-promotion.ts): 6 h at the default tick. */
export const LIVE_PROMOTION_INTERVAL = 6 * NOTE_IMPORTANCE_INTERVAL;
/** Its phase within that interval (no other job shares the interval). */
export const LIVE_PROMOTION_PHASE = 4200;

/** The hourly phase of the lessons-from-work flush (distinct from every other hourly job). */
export const LESSONS_FROM_WORK_PHASE = 3300;
