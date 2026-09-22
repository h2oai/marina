// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Continuous-hygiene ratio HISTORY (migration 115 `memory_hygiene_snapshots`):
 * the hourly hygiene tick and `POST /api/memory/hygiene/snapshot` each write
 * one operator-scope sample; `GET /api/memory/hygiene/history` returns them
 * oldest → newest inside a bounded window; retention prunes on write; the
 * series is privileged-only. No model is ever called.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine/engine";
import { runEngineMemoryHygiene } from "../src/engine/memory-hygiene";
import { resetTrustProfileForTests } from "../src/engine/trust-profile";
import {
  clampHistoryHours,
  HYGIENE_HISTORY_DEFAULT_HOURS,
  HYGIENE_HISTORY_MAX_HOURS,
  HYGIENE_HISTORY_RETENTION_MS,
  listHygieneSnapshots,
  recordHygieneSnapshot,
} from "../src/memory/hygiene-ratios";
import { handleDashboardApi } from "../src/net/dashboard-api";
import {
  memoryHygieneHistory,
  resetMemoryHygieneRatiosMemoForTests,
  snapshotMemoryHygiene,
} from "../src/net/memory-observability";
import type {
  MemoryHygieneHistory,
  MemoryHygieneSample,
} from "../src/net/memory-observability-types";
import { MarinaDB } from "../src/persistence/database";
import { EXPORT_TABLES } from "../src/persistence/export-import";
import { roomId } from "../src/types";
import { MockConnection, makeTestRoom } from "./helpers";

const RESIDENT = "Resident";
const DESKTOP_TOKEN = "desktop-capability-token-at-least-32-chars";

let directory: string;
let db: MarinaDB;
let engine: Engine;
let residentToken: string;
const prevOpenApi = process.env.MARINA_OPEN_API;
const prevDesktop = process.env.MARINA_DESKTOP_API_TOKEN;

async function api(
  path: string,
  opts: { method?: string; token?: string; desktop?: boolean } = {},
): Promise<{ status: number; body: unknown }> {
  const url = new URL(`http://localhost:3300${path}`);
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.desktop) headers["X-Marina-Desktop-Token"] = DESKTOP_TOKEN;
  const method = opts.method ?? "GET";
  const resp = await handleDashboardApi(
    new Request(url.toString(), { method, headers }),
    url,
    method,
    engine,
    db,
  );
  if (!resp) throw new Error(`no response for ${path}`);
  const text = await resp.text();
  return { status: resp.status, body: text ? (JSON.parse(text) as unknown) : undefined };
}

const raw = () => db.memoryRepository().raw;
const rowCount = () =>
  (raw().query("SELECT count(*) AS n FROM memory_hygiene_snapshots").get() as { n: number }).n;

beforeEach(() => {
  delete process.env.MARINA_OPEN_API;
  process.env.MARINA_DESKTOP_API_TOKEN = DESKTOP_TOKEN;
  resetTrustProfileForTests();
  resetMemoryHygieneRatiosMemoForTests();
  directory = mkdtempSync(join(tmpdir(), "marina-hygiene-history-"));
  db = new MarinaDB(join(directory, "world.db"));
  engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
  engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  const conn = new MockConnection("hist-1");
  engine.addConnection(conn);
  const result = engine.login(conn.id, RESIDENT);
  if ("error" in result) throw new Error(result.error);
  residentToken = result.token;
});

afterEach(() => {
  resetTrustProfileForTests();
  if (prevOpenApi === undefined) delete process.env.MARINA_OPEN_API;
  else process.env.MARINA_OPEN_API = prevOpenApi;
  if (prevDesktop === undefined) delete process.env.MARINA_DESKTOP_API_TOKEN;
  else process.env.MARINA_DESKTOP_API_TOKEN = prevDesktop;
  db.close();
  rmSync(directory, { recursive: true });
});

describe("hygiene ratio history", () => {
  it("is registered for export and starts empty with the default window", async () => {
    expect(EXPORT_TABLES).toContain("memory_hygiene_snapshots");
    const res = await api("/api/memory/hygiene/history", { desktop: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ scope: "all", hours: HYGIENE_HISTORY_DEFAULT_HOURS, samples: [] });
  });

  it("snapshot route writes one operator-scope sample; history returns samples oldest → newest", async () => {
    const first = await api("/api/memory/hygiene/snapshot", { method: "POST", desktop: true });
    expect(first.status).toBe(200);
    const sample = first.body as MemoryHygieneSample;
    expect(sample.ratios.scope).toBe("all");
    expect(sample.at).toBe(sample.ratios.computedAt);
    expect(sample.ratios.redundancy).toEqual({ value: null, numerator: 0, denominator: 0 });
    // A second, later sample lands after the first.
    const later = snapshotMemoryHygiene(engine, sample.at + 1);
    expect(later?.at).toBe(sample.at + 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const history = (await api("/api/memory/hygiene/history?hours=24", { desktop: true }))
      .body as MemoryHygieneHistory;
    expect(history.scope).toBe("all");
    expect(history.hours).toBe(24);
    expect(history.samples.map((s) => s.at)).toEqual([sample.at, later!.at]);
    expect(history.samples[1]!.ratios).toEqual(later!.ratios);
    // The snapshot also refreshed the privileged memo so the live ratios agree.
    const live = await api("/api/memory/hygiene", { desktop: true });
    expect((live.body as { computedAt: number }).computedAt).toBe(later!.at);
  });

  it("filters by the requested window and clamps hours to [1, 720] with a 168 h default", async () => {
    const now = Date.now();
    recordHygieneSnapshot(raw(), snapshotMemoryHygiene(engine, now)!.ratios, now - 10 * 3600_000);
    expect(rowCount()).toBe(2);
    const short = listHygieneSnapshots(raw(), { hours: 2, now });
    expect(short.samples.map((s) => s.at)).toEqual([now]);
    const wide = listHygieneSnapshots(raw(), { hours: 24, now });
    expect(wide.samples.map((s) => s.at)).toEqual([now - 10 * 3600_000, now]);
    expect(clampHistoryHours(undefined)).toBe(HYGIENE_HISTORY_DEFAULT_HOURS);
    expect(clampHistoryHours(0)).toBe(HYGIENE_HISTORY_DEFAULT_HOURS);
    expect(clampHistoryHours(-5)).toBe(HYGIENE_HISTORY_DEFAULT_HOURS);
    expect(clampHistoryHours(Number.NaN)).toBe(HYGIENE_HISTORY_DEFAULT_HOURS);
    expect(clampHistoryHours(12.9)).toBe(12);
    expect(clampHistoryHours(100_000)).toBe(HYGIENE_HISTORY_MAX_HOURS);
    const clamped = (await api("/api/memory/hygiene/history?hours=99999", { desktop: true }))
      .body as MemoryHygieneHistory;
    expect(clamped.hours).toBe(HYGIENE_HISTORY_MAX_HOURS);
    expect(memoryHygieneHistory(engine, 5000).hours).toBe(HYGIENE_HISTORY_MAX_HOURS);
    const garbage = (await api("/api/memory/hygiene/history?hours=abc", { desktop: true }))
      .body as MemoryHygieneHistory;
    expect(garbage.hours).toBe(HYGIENE_HISTORY_DEFAULT_HOURS);
  });

  it("prunes samples older than the 30-day retention on every write", () => {
    const now = Date.now();
    const ratios = snapshotMemoryHygiene(engine, now)!.ratios;
    // Directly plant an over-age row and a just-inside-retention row.
    raw()
      .query("INSERT INTO memory_hygiene_snapshots (at, scope, ratios) VALUES (?,?,?)")
      .run(now - HYGIENE_HISTORY_RETENTION_MS - 1, "all", JSON.stringify(ratios));
    raw()
      .query("INSERT INTO memory_hygiene_snapshots (at, scope, ratios) VALUES (?,?,?)")
      .run(now - HYGIENE_HISTORY_RETENTION_MS + 60_000, "all", JSON.stringify(ratios));
    expect(rowCount()).toBe(3);
    recordHygieneSnapshot(raw(), ratios, now + 1);
    const remaining = raw().query("SELECT at FROM memory_hygiene_snapshots ORDER BY at").all() as {
      at: number;
    }[];
    expect(remaining.map((r) => r.at)).toEqual([
      now - HYGIENE_HISTORY_RETENTION_MS + 60_000,
      now,
      now + 1,
    ]);
    // Window queries never reach past retention anyway: max 720 h = 30 d.
    expect(HYGIENE_HISTORY_MAX_HOURS * 3600_000).toBe(HYGIENE_HISTORY_RETENTION_MS);
  });

  it("the hourly hygiene run writes a sample even with no online residents to review", async () => {
    expect(rowCount()).toBe(0);
    await runEngineMemoryHygiene(engine);
    expect(rowCount()).toBe(1);
    const history = memoryHygieneHistory(engine);
    expect(history.samples).toHaveLength(1);
    expect(history.samples[0]!.ratios.scope).toBe("all");
  });

  it("skips a corrupt row instead of failing the series", () => {
    const now = Date.now();
    raw()
      .query("INSERT INTO memory_hygiene_snapshots (at, scope, ratios) VALUES (?,?,?)")
      .run(now - 1000, "all", "{not json");
    snapshotMemoryHygiene(engine, now);
    const history = listHygieneSnapshots(raw(), { now });
    expect(history.samples.map((s) => s.at)).toEqual([now]);
  });

  it("is operator-scoped: residents get 403 on both routes, anonymous 401, dev-open reads but cannot write", async () => {
    expect((await api("/api/memory/hygiene/history", { token: residentToken })).status).toBe(403);
    expect(
      (await api("/api/memory/hygiene/snapshot", { method: "POST", token: residentToken })).status,
    ).toBe(403);
    expect((await api("/api/memory/hygiene/history")).status).toBe(401);
    expect((await api("/api/memory/hygiene/snapshot", { method: "POST" })).status).toBe(401);
    expect(rowCount()).toBe(0);
    // A resident's LIVE ratios stay available — only the aggregate series is gated.
    const own = await api("/api/memory/hygiene", { token: residentToken });
    expect(own.status).toBe(200);
    expect((own.body as { scope: string }).scope).toBe("own");
    process.env.MARINA_OPEN_API = "true";
    expect((await api("/api/memory/hygiene/history")).status).toBe(200);
    expect((await api("/api/memory/hygiene/snapshot", { method: "POST" })).status).toBe(403);
    expect(rowCount()).toBe(0);
  });
});
