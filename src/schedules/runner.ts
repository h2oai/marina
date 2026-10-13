// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runs due schedules (`schedules` tick job). Each run is the owner's own
 * command, admitted through the owner's FIFO slot exactly as if typed: rank,
 * safety gates, challenges, spend caps and audit all apply, so a schedule can
 * never do what its owner could not.
 *
 * - Owner connected (a person online, or a running agent): the command runs on
 *   that live entity; its output reaches the owner's own session.
 * - A person offline: a quiet in-process connection attaches to the account
 *   (`Engine.attachScheduled`) for the run, then detaches.
 * - An agent that is not running: `owner-absent`. A stopped agent's intent does
 *   not keep acting in the world; its schedules wait and alert.
 *
 * History is append-only (`schedule_runs`). After {@link ALERT_AFTER_FAILURES}
 * consecutive failures, or when the owner is absent, an operational alert is
 * raised; the next good run resolves it.
 */

import { randomUUID } from "node:crypto";
import { correlateCommandPerception, withCommandResponse } from "../engine/command-response";
import type { Engine } from "../engine/engine";
import { sanitizeEntityName } from "../engine/entity-name";
import { getErrorMessage } from "../engine/errors";
import type { ScheduleRow } from "../persistence/db-schedules";
import type { Connection, EntityId, Perception } from "../types";
import { decideDue, type Trigger } from "./trigger";

export type RunStatus =
  | "ok"
  | "failed"
  | "refused"
  | "spend-cap"
  | "overloaded"
  | "owner-absent"
  | "skipped-overlap"
  | "missed";

/** Consecutive failed runs before the owner and operators are alerted. */
export const ALERT_AFTER_FAILURES = 2;
/** Due schedules started per pass. */
const PASS_LIMIT = 50;
/** Stored error text is clamped (it is the owner's own command output). */
const ERROR_MAX_CHARS = 300;

/** `MARINA_SCHEDULES=off` stores schedules but never runs them. Default on. */
export function schedulesMode(env: NodeJS.ProcessEnv = process.env): "on" | "off" {
  return env.MARINA_SCHEDULES?.trim().toLowerCase() === "off" ? "off" : "on";
}

const inFlight = new WeakMap<Engine, Set<number>>();
function flying(engine: Engine): Set<number> {
  let s = inFlight.get(engine);
  if (!s) {
    s = new Set();
    inFlight.set(engine, s);
  }
  return s;
}

/** The schedules running right now (for overlap checks and tests). */
export function runningSchedules(engine: Engine): number[] {
  return [...flying(engine)];
}

/**
 * Start every due schedule. Runs are detached (`trackBackground`), so a slow
 * command never delays other schedules; a schedule still running when it comes
 * due again records `skipped-overlap`. Returns the number of runs started.
 */
export function runDueSchedules(engine: Engine, now = Date.now()): number {
  const db = engine.db;
  if (!db || schedulesMode() === "off") return 0;
  const running = flying(engine);
  let started = 0;
  for (const row of db.dueSchedules(now, PASS_LIMIT)) {
    const trigger = parseStored(row);
    if (!trigger || row.next_run_at === null) {
      db.updateScheduleState(row.id, { nextRunAt: null, enabled: false, lastStatus: "failed" });
      continue;
    }
    const dueAt = row.next_run_at;
    const decision = decideDue(trigger, dueAt, now, row.catch_up);
    const reachedMax = row.max_runs !== null && row.runs + 1 >= row.max_runs;
    if (running.has(row.id)) {
      record(engine, row, dueAt, now, now, "skipped-overlap");
      db.updateScheduleState(row.id, { nextRunAt: decision.next, lastStatus: "skipped-overlap" });
      continue;
    }
    if (!decision.run) {
      record(engine, row, dueAt, now, now, "missed");
      db.updateScheduleState(row.id, {
        nextRunAt: decision.next,
        ...(decision.next === null ? { enabled: false } : {}),
        lastStatus: "missed",
      });
      continue;
    }
    // Claim the slot before running, so the next pass never starts it twice.
    db.updateScheduleState(row.id, {
      nextRunAt: reachedMax ? null : decision.next,
      ...(reachedMax || decision.next === null ? { enabled: false } : {}),
    });
    running.add(row.id);
    started++;
    void engine.trackBackground(
      executeRun(engine, row)
        .then((result) => finishRun(engine, row, dueAt, now, result))
        .catch((error: unknown) =>
          engine.logger.warn(
            "schedules",
            `schedule ${row.id} run failed: ${getErrorMessage(error)}`,
          ),
        )
        .finally(() => running.delete(row.id)),
    );
  }
  return started;
}

function parseStored(row: ScheduleRow): Trigger | undefined {
  try {
    return JSON.parse(row.trigger_json) as Trigger;
  } catch {
    return undefined;
  }
}

interface RunResult {
  status: RunStatus;
  errorClass?: string;
  error?: string;
}

/** Is this account a world agent (an agent config or an agent principal)? */
function isAgentAccount(engine: Engine, name: string): boolean {
  const db = engine.db;
  return !!db && (!!db.getAgentConfig(name) || !!db.getPrincipal("agent", name));
}

/** Run one schedule's command as its owner. */
export async function executeRun(engine: Engine, row: ScheduleRow): Promise<RunResult> {
  const name = sanitizeEntityName(row.owner_name);
  const live = engine.entities.findAgentByName(name);
  const conn = live ? engine.getConnectionForEntity(live.id) : undefined;
  if (live && conn) {
    engine.sendToEntity(live.id, `[schedule ${row.name}] ${row.command}`);
    return runCaptured(engine, live.id, conn.id, row.command);
  }
  if (isAgentAccount(engine, name)) {
    return {
      status: "owner-absent",
      errorClass: "agent-stopped",
      error: "the agent is not running",
    };
  }
  const connId = `sched_${randomUUID().slice(0, 8)}`;
  const headless: Connection = {
    id: connId,
    protocol: "websocket",
    entity: null,
    connectedAt: Date.now(),
    quiet: true,
    // Error perceptions mark the run failed, as on a WebSocket.
    send(p: Perception) {
      correlateCommandPerception(connId, p);
    },
    close() {
      engine.removeConnection(connId);
    },
  };
  engine.addConnection(headless);
  try {
    const attached = engine.attachScheduled(connId, name);
    if ("error" in attached) {
      return { status: "owner-absent", errorClass: "account", error: attached.error };
    }
    return await runCaptured(engine, attached.entityId, connId, row.command);
  } finally {
    engine.removeConnection(connId);
  }
}

/** Admit `command` through the owner's FIFO slot and capture whether it failed. */
function runCaptured(
  engine: Engine,
  entityId: EntityId,
  connId: string,
  command: string,
): Promise<RunResult> {
  const done = Promise.withResolvers<RunResult>();
  const requestId = `schedule-${randomUUID().slice(0, 8)}`;
  let error: string | undefined;
  const admitted = engine.submitCommand(entityId, command, async () => {
    try {
      await withCommandResponse(
        connId,
        requestId,
        () => engine.processCommand(entityId, command),
        (p) => {
          const result = (p.data as { command_result?: { ok?: boolean; error?: string } })
            .command_result;
          if (result && result.ok === false) error = result.error ?? "command failed";
        },
      );
    } catch (e) {
      error = getErrorMessage(e);
    }
    done.resolve(error === undefined ? { status: "ok" } : classify(error));
  });
  if (!admitted) done.resolve({ status: "overloaded", errorClass: "capacity" });
  return done.promise;
}

/** A failure's class and status from its message (never its arguments). */
export function classify(error: string): RunResult {
  const text = error.slice(0, ERROR_MAX_CHARS);
  if (/^rank \d+ required/i.test(error))
    return { status: "refused", errorClass: "rank", error: text };
  if (/\bgate\b|challenge|approval/i.test(error))
    return { status: "refused", errorClass: "gate", error: text };
  if (/spend[ _]cap/i.test(error))
    return { status: "spend-cap", errorClass: "spend-cap", error: text };
  if (/^unknown command/i.test(error))
    return { status: "failed", errorClass: "unknown-command", error: text };
  return { status: "failed", errorClass: "error", error: text };
}

function record(
  engine: Engine,
  row: ScheduleRow,
  dueAt: number,
  startedAt: number,
  finishedAt: number,
  status: RunStatus,
  result?: RunResult,
): void {
  engine.db?.recordScheduleRun({
    schedule_id: row.id,
    owner_key: row.owner_key,
    due_at: dueAt,
    started_at: startedAt,
    finished_at: finishedAt,
    status,
    error_class: result?.errorClass ?? null,
    error: result?.error ?? null,
    duration_ms: Math.max(0, finishedAt - startedAt),
  });
}

function finishRun(
  engine: Engine,
  row: ScheduleRow,
  dueAt: number,
  startedAt: number,
  result: RunResult,
): void {
  const db = engine.db;
  if (!db) return;
  const finishedAt = Date.now();
  record(engine, row, dueAt, startedAt, finishedAt, result.status, result);
  const current = db.getSchedule(row.id);
  if (!current) return; // removed while it ran
  const failed = result.status !== "ok";
  const failures = failed ? current.consecutive_failures + 1 : 0;
  db.updateScheduleState(row.id, {
    nextRunAt: current.next_run_at,
    ran: true,
    lastStatus: result.status,
    lastRunAt: finishedAt,
    consecutiveFailures: failures,
  });
  const key = `schedule:${row.id}`;
  if (failed && (failures >= ALERT_AFTER_FAILURES || result.status === "owner-absent")) {
    db.upsertOperationalAlert({
      key,
      severity: "warning",
      category: "schedule",
      title: `Schedule ${row.owner_name}/${row.name} is not running cleanly`,
      detail: `${failures} consecutive ${result.status} run(s)${result.errorClass ? ` (${result.errorClass})` : ""}`,
      remedy: `schedule show ${row.name} (as ${row.owner_name}); fix the command, or schedule pause ${row.name}`,
      targetEntity: row.owner_name,
      metadata: {
        scheduleId: row.id,
        status: result.status,
        errorClass: result.errorClass ?? null,
      },
    });
  }
  if (!failed && row.consecutive_failures > 0) resolveAlert(engine, key);
  const live = engine.entities.findAgentByName(sanitizeEntityName(row.owner_name));
  if (failed && live && engine.getConnectionForEntity(live.id)) {
    engine.sendToEntity(
      live.id,
      `[schedule ${row.name}] ${result.status}${result.error ? `: ${result.error}` : ""}`,
    );
  }
}

/** Resolve one schedule's open alert (the next good run cleared it). */
export function resolveAlert(engine: Engine, key: string): void {
  const db = engine.db;
  if (!db) return;
  for (const status of ["open", "acknowledged"] as const)
    for (const alert of db.listOperationalAlerts(status, 500))
      if (alert.alert_key === key) db.setOperationalAlertStatus(alert.id, "resolved");
}
