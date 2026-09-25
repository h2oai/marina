// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ArenaData } from "../src/arena/data";
import type { ArenaPoint, ArenaRound } from "../src/arena/types";
import { arenaCommand } from "../src/engine/commands/arena";
import { resetArenaLabForTests } from "../src/engine/commands/arena-lab";
import { MarinaDB } from "../src/persistence/database";
import type { RoomContext } from "../src/types";
import { cleanupDb, stripAnsi } from "./helpers";

const weekly = (values: number[], start = "2026-01-02"): ArenaPoint[] =>
  values.map((value, i) => ({
    date: new Date(Date.parse(start) + i * 7 * 86_400_000).toISOString().slice(0, 10),
    value,
  }));

// Ten resolved weekly rounds of a series that rises by 1 a week (so `trend`
// beats persistence), plus one round still open, whose lock is tomorrow.
function fixture(): ArenaData {
  const rounds: ArenaRound[] = [];
  const files: Record<string, unknown> = {};
  const resolved: Record<string, { value: number }> = {};
  for (let w = 0; w < 11; w++) {
    const history = weekly(Array.from({ length: 20 + w }, (_, i) => i));
    const id = `demo-2026-w${10 + w}`;
    const open = w === 10;
    rounds.push({
      round_id: id,
      tracker: "demo",
      question: "?",
      target_type: "continuous_normal",
      lock_at: open
        ? new Date(Date.now() + 86_400_000).toISOString()
        : new Date(Date.parse("2026-06-01T14:00:00Z") + w * 7 * 86_400_000).toISOString(),
      release_at: new Date(Date.parse(history.at(-1)!.date) + 7 * 86_400_000).toISOString(),
    } as ArenaRound);
    files[`locks/${id}.json`] = { round_id: id, answer_history: history };
    if (!open) resolved[id] = { value: history.at(-1)!.value + 1 };
  }
  files["questions/season0.json"] = { rounds };
  files["resolutions/resolved.json"] = resolved;
  return new ArenaData("https://example.test", async (url) => {
    const path = url.replace("https://example.test/", "");
    return path in files ? Response.json(files[path]) : new Response("", { status: 404 });
  });
}

describe("arena — the measurement loop in-world", () => {
  const DB = `test_arena_command_${process.pid}.db`;
  let db: MarinaDB;
  let out: string[];
  let proposals = 0;
  let cmd: ReturnType<typeof arenaCommand>;
  const ctx = {
    send: (_e: string, text: string) => out.push(stripAnsi(text)),
  } as unknown as RoomContext;
  const run = async (line: string, entity = "e_1") => {
    out = [];
    const tokens = line.split(/\s+/).slice(1);
    await cmd.handler(ctx, { entity, tokens, args: tokens.join(" "), raw: line } as never);
    return out.join("\n");
  };

  beforeEach(() => {
    db = new MarinaDB(DB);
    proposals = 0;
    resetArenaLabForTests(["e_1", "e_2"]);
    cmd = arenaCommand({
      store: db,
      notes: db,
      data: fixture,
      propose: async () => {
        proposals++;
        return {
          reply: JSON.stringify({
            signals: [{ centre: "trend:6", spread: "scale:0.5", rationale: "it rises weekly" }],
          }),
          costUsd: 0.001,
        };
      },
    });
  });
  afterEach(() => {
    db.close();
    cleanupDb(DB);
  });

  it("discover promotes a winning signal, and signals lists it", async () => {
    const text = await run("arena discover tracker:demo");
    expect(proposals).toBe(1);
    expect(text).toContain("promoted");
    expect(text).toContain("trend:6/scale:0.5");
    expect(await run("arena signals tracker:demo")).toContain("promoted  trend:6/scale:0.5");
  });

  it("evaluate scores the discovered forecaster against the baseline on resolved rounds", async () => {
    await run("arena discover tracker:demo");
    const text = await run("arena evaluate discovered tracker:demo");
    expect(text).toContain("baseline vs discovered");
    const all = text.split("\n").find((l) => l.startsWith("ALL"))!;
    const [, , base, disc] = all.split(/\s+/);
    expect(Number(disc)).toBeGreaterThan(Number(base));
  });

  it("shadow run records the discovered signal, not a silent nowcast fallback", async () => {
    await run("arena discover tracker:demo");
    const text = await run("arena shadow run due forecaster:discovered");
    expect(text).toContain("demo-2026-w20 recorded");
    const [row] = db.listArenaShadow({ forecaster: "discovered" });
    // The series ends at 29 and rises by 1 a week: a trend forecast sits above the last value.
    const mean = (JSON.parse(row!.forecast) as { topline: { mean: number } }).topline.mean;
    expect(mean).toBeGreaterThan(29);
    expect(await run("arena shadow list")).toContain("demo-2026-w20");
    // Idempotent per round and forecaster.
    expect(await run("arena shadow run due forecaster:discovered")).toContain("already recorded");
  });

  it("refuses paid forecasters and points at the operator step", async () => {
    expect(await run("arena evaluate crew:openrouter/x")).toContain("operator step");
    expect(await run("arena shadow run due forecaster:research:openrouter/x")).toContain(
      "operator step",
    );
  });

  it("rate limits discovery per entity", async () => {
    await run("arena discover tracker:demo");
    await run("arena discover tracker:demo");
    expect(await run("arena discover tracker:demo")).toContain("rate limited");
    expect(proposals).toBe(2);
    // Another entity has its own budget.
    await run("arena discover tracker:demo", "e_2");
    expect(proposals).toBe(3);
  });
});
