// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sliceHash } from "../src/engine/benchmark-ledger";
import {
  evaluateChallenge,
  getPromotedDefault,
  itemSplit,
  pairedDifferenceInterval,
  selectionOverlap,
} from "../src/engine/benchmark-promotion";
import { Engine } from "../src/engine/engine";
import { RETENTION_POLICIES } from "../src/engine/retention";
import { grant } from "../src/engine/safety-gates";
import type { BenchmarkItemRow, BenchmarkRunRow } from "../src/persistence/database";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const SLOT = "crew:answerer:formation";
const IDS = Array.from({ length: 200 }, (_, i) => `item-${i}`);

function runRow(id: string, extra: Partial<BenchmarkRunRow> = {}): BenchmarkRunRow {
  return {
    id,
    benchmark: "synthetic",
    config_hash: id,
    config_json: "{}",
    score: null,
    breakdown_json: null,
    answered: IDS.length,
    total: IDS.length,
    status: "completed",
    agent_id: null,
    started_at: 0,
    completed_at: 1,
    duration_ms: 1,
    judge: "judge/model",
    slice_hash: sliceHash(IDS),
    ...extra,
  };
}

function items(runId: string, correct: (id: string, i: number) => boolean): BenchmarkItemRow[] {
  return IDS.map((item_id, i) => ({
    id: i,
    run_id: runId,
    item_id,
    correct: correct(item_id, i) ? 1 : 0,
    score: null,
    latency_ms: null,
    cost_usd: 0.01,
    trace_id: null,
    participants_json: null,
    judge_verdict: null,
  }));
}

// Incumbent right on 40 % of items; a strong challenger right on 80 %; a twin ties it.
const incumbentRight = (_: string, i: number) => i % 5 < 2;
const strongRight = (_: string, i: number) => i % 5 < 4;

function evaluate(
  challenger: (id: string, i: number) => boolean,
  over: Partial<Parameters<typeof evaluateChallenge>[0]> = {},
) {
  return evaluateChallenge({
    slot: SLOT,
    holdoutFraction: 0.5,
    split: "holdout",
    challenger: runRow("C"),
    challengerItems: items("C", challenger),
    incumbent: runRow("I"),
    incumbentItems: items("I", incumbentRight),
    triedBefore: 0,
    ...over,
  });
}

describe("earned promotion — the rule", () => {
  it("splits items by a stable per-slot hash", () => {
    const holdout = IDS.filter((id) => itemSplit(SLOT, id, 0.5) === "holdout");
    expect(holdout.length).toBeGreaterThan(70);
    expect(holdout.length).toBeLessThan(130);
    expect(IDS.filter((id) => itemSplit(SLOT, id, 0.5) === "holdout")).toEqual(holdout);
    // Another slot draws a different holdout.
    expect(IDS.filter((id) => itemSplit("other:slot", id, 0.5) === "holdout")).not.toEqual(holdout);
  });

  it("puts the paired interval above zero only for a real win", () => {
    const win = pairedDifferenceInterval(30, 2, 100);
    expect(win.delta).toBeCloseTo(0.28);
    expect(win.low).toBeGreaterThan(0);
    const tie = pairedDifferenceInterval(5, 5, 100);
    expect(tie.low).toBeLessThan(0);
    expect(tie.high).toBeGreaterThan(0);
  });

  it("promotes a challenger that wins the holdout with interval and margin", () => {
    const e = evaluate(strongRight);
    expect(e.reasons).toEqual([]);
    expect(e.ok).toBe(true);
    expect(e.stats.split).toBe("holdout");
    expect(e.stats.low).toBeGreaterThan(0);
  });

  it("refuses a tie: the interval is not above zero", () => {
    const e = evaluate(incumbentRight);
    expect(e.ok).toBe(false);
    expect(e.reasons.join(" ")).toContain("not distinguishable from noise");
  });

  it("raises the bar with every earlier attempt (anti-fishing)", () => {
    // Right on 60 %: a clear win at the first try, short of the margin after many.
    const modest = (_: string, i: number) => i % 5 < 3;
    expect(evaluate(modest).ok).toBe(true);
    const many = evaluate(modest, { triedBefore: 2 ** 20 });
    expect(many.ok).toBe(false);
    expect(many.margin).toBeGreaterThan(evaluate(modest).margin);
    expect(many.reasons.join(" ")).toContain("every try raises the bar");
  });

  it("refuses evidence that overlaps the selection split", () => {
    const selection = IDS.filter((id) => itemSplit(SLOT, id, 0.5) === "selection");
    expect(selectionOverlap(SLOT, 0.5, selection.slice(0, 3))).toHaveLength(3);
    const e = evaluate(strongRight, { evidenceItemIds: [...IDS] });
    expect(e.ok).toBe(false);
    expect(e.reasons.join(" ")).toContain("overlaps the selection split");
  });

  it("never promotes on the selection split (the dry run)", () => {
    const e = evaluate(strongRight, { split: "selection" });
    expect(e.ok).toBe(false);
    expect(e.stats.split).toBe("selection");
  });

  it("refuses unlike pairings and over-budget challengers", () => {
    const judge = evaluate(strongRight, { challenger: runRow("C", { judge: "other/judge" }) });
    expect(judge.reasons.join(" ")).toContain("different judges");
    const slice = evaluate(strongRight, { challenger: runRow("C", { slice_hash: "zzz" }) });
    expect(slice.reasons.join(" ")).toContain("different item slices");
    const pricey = evaluate(strongRight, {
      challengerItems: items("C", strongRight).map((i) => ({ ...i, cost_usd: 0.05 })),
      maxCostRatio: 2,
    });
    expect(pricey.reasons.join(" ")).toContain("5.00× the incumbent");
  });

  it("never prunes the promotion record", () => {
    const kinds = Object.fromEntries(RETENTION_POLICIES.map((p) => [p.table, p.kind]));
    expect(kinds.benchmark_promotions).toBe("append-only");
    expect(kinds.benchmark_defaults).toBe("append-only");
  });
});

describe("earned promotion — store and commands", () => {
  let engine: Engine;
  let db: MarinaDB;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `/tmp/marina-promotion-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`;
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/lobby"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/lobby"), makeTestRoom({ short: "Lobby", long: "Lobby." }));
  });

  afterEach(() => {
    engine.stop();
    db.close();
    cleanupDb(dbPath);
  });

  function record(
    id: string,
    correct: (id: string, i: number) => boolean,
    extra: { agent_id?: string; model?: string } = {},
  ) {
    const outcome = items(id, correct);
    db.recordBenchmarkLedgerRun(
      {
        id,
        benchmark: "synthetic",
        config_hash: id,
        config_json: "{}",
        agent_id: extra.agent_id ?? null,
        started_at: 0,
        completed_at: 1,
        duration_ms: 1,
        score: outcome.filter((i) => i.correct).length / outcome.length,
        answered: outcome.length,
        total: outcome.length,
        cost_usd: null,
        n: outcome.length,
        ci_low: 0,
        ci_high: 1,
        seed: 1,
        slice_hash: sliceHash(IDS),
        judge: "judge/model",
        target_kind: "crew",
        target_json: JSON.stringify({ crew: "answerer", model: extra.model ?? `model-${id}` }),
        label: id,
        source: "import",
        content_hash: null,
      },
      outcome.map((i) => ({ ...i, correct: Boolean(i.correct) })),
    );
  }

  function login(name: string) {
    const conn = new MockConnection(`c-${name}`);
    engine.addConnection(conn);
    engine.login(conn.id, name);
    conn.clear();
    const send = (cmd: string): string => {
      conn.clear();
      engine.processCommand(conn.entity!, cmd);
      return stripAnsi(conn.allTextJoined());
    };
    return { conn, send };
  }

  it("refuses promotion without role.edit (and raises no write)", () => {
    record("base", incumbentRight);
    const viewer = login("Viewer");
    // A refusal raises a challenge (never a wall) and writes nothing.
    const reply = viewer.send(`benchmark promote ${SLOT} base`);
    expect(reply).toContain("change an existing role or trait");
    expect(reply).toContain("held: challenge");
    expect(db.listBenchmarkDefaults()).toHaveLength(0);
  });

  it("seeds, refuses a weak challenger, promotes an earned one — all recorded", () => {
    record("base", incumbentRight);
    record("twin", incumbentRight);
    record("strong", strongRight);
    const op = login("Operator");
    grant(db, op.conn.entity!, "role.edit");

    expect(op.send(`benchmark promote ${SLOT} base`)).toContain(`Seeded ${SLOT}`);
    expect(getPromotedDefault<{ model: string }>(db, SLOT)?.model).toBe("model-base");

    // The dry run shows the selection split only.
    const dry = op.send(`benchmark challenge ${SLOT} strong`);
    expect(dry).toContain("selection:");
    expect(dry).not.toContain("holdout:");

    expect(op.send(`benchmark promote ${SLOT} twin`)).toContain("Not promoted");
    expect(getPromotedDefault<{ model: string }>(db, SLOT)?.model).toBe("model-base");

    const won = op.send(`benchmark promote ${SLOT} strong`);
    expect(won).toContain("Promoted");
    expect(won).toContain("1 earlier attempt"); // the refused twin raised the bar
    expect(getPromotedDefault<{ model: string }>(db, SLOT)?.model).toBe("model-strong");

    const history = db.listBenchmarkPromotions(SLOT).map((h) => h.outcome);
    expect(history).toEqual(["seeded", "refused", "promoted"]);
    expect(op.send("benchmark defaults")).toContain(SLOT);
    expect(() =>
      (db as unknown as { db: { run: (s: string) => void } }).db.run(
        "UPDATE benchmark_promotions SET outcome = 'promoted'",
      ),
    ).toThrow(/append-only/);
  });

  it("never lets the author of a challenger promote it", () => {
    record("base", incumbentRight);
    const op = login("Author");
    grant(db, op.conn.entity!, "role.edit");
    record("mine", strongRight, { agent_id: op.conn.entity! });
    op.send(`benchmark promote ${SLOT} base`);
    expect(op.send(`benchmark promote ${SLOT} mine`)).toContain("self-attestation");
    expect(getPromotedDefault<{ model: string }>(db, SLOT)?.model).toBe("model-base");
  });

  it("fixes the holdout fraction once a slot exists", () => {
    record("base", incumbentRight);
    record("strong", strongRight);
    const op = login("Fixer");
    grant(db, op.conn.entity!, "role.edit");
    expect(op.send(`benchmark promote ${SLOT} base --holdout 0.4`)).toContain("holdout 40.0%");
    expect(op.send(`benchmark promote ${SLOT} strong --holdout 0.6`)).toContain(
      "fixed once a slot exists",
    );
    expect(db.getBenchmarkDefault(SLOT)?.holdout_fraction).toBe(0.4);
  });
});
