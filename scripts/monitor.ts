// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Outside monitor: is this Marina server up? Run from OUTSIDE the server
 * process — a systemd timer, cron, another host — so it still reports when the
 * server is down, crash-looping, or hung. It never imports the engine.
 *
 *   bun run monitor                       # one check of the local server
 *   bun run monitor --url https://marina.example/health --desktop
 *   bun run monitor --every 1m            # keep checking
 *
 * A check reads `/health`: down = no answer, an error status, or `stalled`
 * (the tick loop stopped). State is kept in a small file so one-shot runs
 * from a timer alert once per outage, not once per check:
 *
 * - `--failures N` consecutive failed checks (default 2) raise the alert;
 * - while down, the alert repeats every `--remind` (default 1h);
 * - the first healthy check after an alert sends "recovered".
 *
 * Where alerts go (any combination):
 * - `--desktop`: a desktop notification (`notify-send`);
 * - `MARINA_MONITOR_WEBHOOK`: a JSON POST with `text` and `content`, so a Slack
 *   or Discord incoming webhook takes it as is;
 * - `MARINA_MONITOR_HEARTBEAT_URL`: pinged on every healthy check — a
 *   dead-man's switch (healthchecks.io and similar) that alerts when the pings
 *   stop, so it also catches the machine itself being off.
 *
 * The URLs come from the environment (they often embed a token), and are never
 * printed. Exit code: 0 healthy, 1 down.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { localHttpBase } from "../src/net/listen-ports";

export interface ProbeResult {
  ok: boolean;
  /** One line: why it is down, or what it reported. */
  detail: string;
}

export interface MonitorState {
  status: "up" | "down";
  /** When the current status began (ms). */
  since: number;
  /** Consecutive failed checks. */
  failures: number;
  /** When the last down alert went out (0 = none for this outage). */
  alertedAt: number;
}

export interface MonitorOptions {
  failures: number;
  remindMs: number;
}

export type MonitorAlert =
  | { kind: "down"; message: string }
  | { kind: "still-down"; message: string }
  | { kind: "recovered"; message: string };

export const INITIAL_STATE: MonitorState = { status: "up", since: 0, failures: 0, alertedAt: 0 };

/** Probe one `/health` URL. */
export async function probe(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = (await res.json().catch(() => null)) as {
      status?: unknown;
      tick?: { agoMs?: unknown };
    } | null;
    if (body?.status === "stalled")
      return {
        ok: false,
        detail: `tick loop stalled (last tick ${Math.round(Number(body.tick?.agoMs ?? 0) / 1000)} s ago)`,
      };
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    if (body?.status !== "ok") return { ok: false, detail: "unexpected /health reply" };
    return { ok: true, detail: "ok" };
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === "TimeoutError" || name === "AbortError")
      return { ok: false, detail: `no answer within ${Math.round(timeoutMs / 1000)} s (hung?)` };
    return { ok: false, detail: `unreachable (${(err as Error)?.message ?? String(err)})` };
  }
}

function ago(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "under a minute";
  if (m < 120) return `${m} min`;
  return `${(m / 60).toFixed(1)} h`;
}

/** The next state after one check, and the alert to send, if any. */
export function step(
  prev: MonitorState,
  result: ProbeResult,
  now: number,
  opts: MonitorOptions,
  name: string,
): { state: MonitorState; alert?: MonitorAlert } {
  if (result.ok) {
    const state: MonitorState = {
      status: "up",
      since: prev.status === "up" ? prev.since || now : now,
      failures: 0,
      alertedAt: 0,
    };
    if (prev.alertedAt > 0)
      return {
        state,
        alert: { kind: "recovered", message: `${name} is back up (down ${ago(now - prev.since)})` },
      };
    return { state };
  }
  const failures = prev.failures + 1;
  const since = prev.status === "down" ? prev.since : now;
  const state: MonitorState = { status: "down", since, failures, alertedAt: prev.alertedAt };
  if (failures < opts.failures) return { state };
  if (prev.alertedAt === 0) {
    state.alertedAt = now;
    return { state, alert: { kind: "down", message: `${name} is DOWN: ${result.detail}` } };
  }
  if (now - prev.alertedAt >= opts.remindMs) {
    state.alertedAt = now;
    return {
      state,
      alert: {
        kind: "still-down",
        message: `${name} still DOWN after ${ago(now - since)}: ${result.detail}`,
      },
    };
  }
  return { state };
}

/** Parse `30s` / `5m` / `1h` / `2d` (bare numbers are seconds). */
export function parseDurationMs(raw: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/.exec(raw.trim());
  if (!m) return undefined;
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] ?? "s"] as number;
  const ms = Number(m[1]) * unit;
  return ms > 0 ? ms : undefined;
}

function readState(path: string): MonitorState {
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as MonitorState;
    if (s && (s.status === "up" || s.status === "down")) return s;
  } catch {
    // allow-empty-catch: no state yet (first run) or an unreadable file starts fresh
  }
  return { ...INITIAL_STATE };
}

function writeState(path: string, state: MonitorState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

async function deliver(alert: MonitorAlert, desktop: boolean): Promise<void> {
  console.log(`[monitor] ${alert.message}`);
  if (desktop) {
    try {
      Bun.spawnSync([
        "notify-send",
        "--app-name=Marina",
        `--urgency=${alert.kind === "recovered" ? "normal" : "critical"}`,
        "Marina monitor",
        alert.message,
      ]);
    } catch (err) {
      console.error(`[monitor] desktop notification failed: ${(err as Error).message}`);
    }
  }
  const hook = process.env.MARINA_MONITOR_WEBHOOK?.trim();
  if (hook) {
    try {
      const res = await fetch(hook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: alert.message, content: alert.message, kind: alert.kind }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) console.error(`[monitor] webhook answered HTTP ${res.status}`);
    } catch (err) {
      console.error(`[monitor] webhook failed: ${(err as Error).message}`);
    }
  }
}

async function heartbeat(): Promise<void> {
  const url = process.env.MARINA_MONITOR_HEARTBEAT_URL?.trim();
  if (!url) return;
  try {
    await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    console.error(`[monitor] heartbeat failed: ${(err as Error).message}`);
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      name: { type: "string" },
      every: { type: "string" },
      failures: { type: "string" },
      remind: { type: "string" },
      timeout: { type: "string" },
      state: { type: "string" },
      desktop: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(
      "bun run monitor [--url <health url>] [--name N] [--every 1m] [--failures 2] [--remind 1h] [--timeout 10s] [--state <file>] [--desktop]\n" +
        "Alerts: --desktop, MARINA_MONITOR_WEBHOOK (JSON POST), MARINA_MONITOR_HEARTBEAT_URL (pinged while healthy).",
    );
    return 0;
  }
  const url = values.url ?? `${localHttpBase()}/health`;
  const name = values.name ?? `Marina (${new URL(url).host})`;
  const failures = Number(values.failures ?? 2);
  const opts: MonitorOptions = {
    failures: Number.isInteger(failures) && failures >= 1 ? failures : 2,
    remindMs: parseDurationMs(values.remind ?? "1h") ?? 3_600_000,
  };
  const timeoutMs = parseDurationMs(values.timeout ?? "10s") ?? 10_000;
  const everyMs = values.every ? parseDurationMs(values.every) : undefined;
  if (values.every && !everyMs) {
    console.error(`--every: not a duration (${values.every})`);
    return 2;
  }
  const statePath =
    values.state ??
    join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "marina-monitor.json");

  for (;;) {
    const result = await probe(url, timeoutMs);
    const { state, alert } = step(readState(statePath), result, Date.now(), opts, name);
    writeState(statePath, state);
    if (result.ok) await heartbeat();
    if (alert) await deliver(alert, values.desktop === true);
    if (!everyMs) return result.ok ? 0 : 1;
    await Bun.sleep(everyMs);
  }
}

if (import.meta.main) process.exit(await main());
