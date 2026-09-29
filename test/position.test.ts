// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  attemptOpen,
  checkNoSelfHedge,
  computeRealizedPnl,
  kellySize,
  type OrderRecord,
  settleResolvedPositions,
} from "../src/engine/commands/position";
import { MarinaDB } from "../src/persistence/database";
import {
  clearCalibrationFinders,
  registerBuiltinCalibrationFinders,
  runCalibration,
} from "../src/resolvers/calibration";
import { type Entity, entityId } from "../src/types";
import { cleanupDb } from "./helpers";

const TEST_DB = "test_position.db";

let orderSeq = 0;
function seedOrder(
  db: MarinaDB,
  o: {
    ticker: string;
    side: "yes" | "no";
    action: "open" | "close";
    count: number;
    venue?: "kalshi" | "polymarket";
    price?: number;
  },
): void {
  let board = db.getBoardByName("paper-orders");
  if (!board) {
    db.createBoard({ id: "paper-orders", name: "paper-orders" });
    board = db.getBoardByName("paper-orders")!;
  }
  const rec: OrderRecord = {
    order_id: `o_${++orderSeq}`,
    venue: o.venue ?? "kalshi",
    ticker: o.ticker,
    side: o.side,
    action: o.action,
    count: o.count,
    price: o.price ?? 50,
    status: "paper",
    ts: 1000,
    by: "Alice",
  };
  db.createBoardPost({
    boardId: board.id,
    authorId: entityId("e_1"),
    authorName: "Alice",
    title: "order",
    body: JSON.stringify(rec),
  });
}

describe("position — risk invariants", () => {
  let db: MarinaDB;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
  });
  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  describe("checkNoSelfHedge", () => {
    it("allows the first open on a ticker (no existing position)", () => {
      expect(checkNoSelfHedge(db, "kalshi", "T1", "yes")).toBeNull();
    });

    it("refuses the opposite side while a position is open", () => {
      seedOrder(db, { ticker: "T1", side: "yes", action: "open", count: 10 });
      const refusal = checkNoSelfHedge(db, "kalshi", "T1", "no");
      expect(refusal).toContain("No-self-hedge");
    });

    it("allows sizing up the SAME side", () => {
      seedOrder(db, { ticker: "T1", side: "yes", action: "open", count: 10 });
      expect(checkNoSelfHedge(db, "kalshi", "T1", "yes")).toBeNull();
    });

    it("allows re-entry on either side once the ticker is fully closed (net 0)", () => {
      seedOrder(db, { ticker: "T1", side: "yes", action: "open", count: 10 });
      seedOrder(db, { ticker: "T1", side: "yes", action: "close", count: 10 });
      expect(checkNoSelfHedge(db, "kalshi", "T1", "yes")).toBeNull();
      expect(checkNoSelfHedge(db, "kalshi", "T1", "no")).toBeNull();
    });

    it("scopes the invariant per venue+ticker (different ticker is independent)", () => {
      seedOrder(db, { ticker: "T1", side: "yes", action: "open", count: 10 });
      expect(checkNoSelfHedge(db, "kalshi", "T2", "no")).toBeNull();
      expect(checkNoSelfHedge(db, "polymarket", "T1", "no")).toBeNull();
    });
  });

  describe("kellySize", () => {
    const state = { bankroll: 1000, kelly: 0.5, cap: 0, floor: 0 };

    it("sizes nothing when there is no edge (our prob ≤ side price)", () => {
      // YES price 60¢ → side price 0.6; our prob 0.5 < 0.6 → no edge.
      const out = kellySize({ ourProb: 0.5, marketPriceCents: 60, side: "yes", state });
      expect(out.fullKelly).toBe(0);
      expect(out.count).toBe(0);
    });

    it("stakes proportionally to edge × half-kelly × bankroll when uncapped", () => {
      // YES price 50¢ (0.5), our prob 0.9 → f* = (0.9-0.5)/(1-0.5) = 0.8.
      // stake = 1000 × 0.5 × 0.8 = 400; count = floor(400 / 0.5) = 800.
      const out = kellySize({ ourProb: 0.9, marketPriceCents: 50, side: "yes", state });
      expect(out.capApplied).toBe(false);
      expect(out.stakeUsd).toBeCloseTo(400, 5);
      expect(out.count).toBe(800);
    });

    it("clamps the stake to the per-position cap", () => {
      const out = kellySize({
        ourProb: 0.9,
        marketPriceCents: 50,
        side: "yes",
        state: { bankroll: 1000, kelly: 0.5, cap: 10, floor: 0 },
      });
      expect(out.capApplied).toBe(true);
      expect(out.stakeUsd).toBe(10);
      expect(out.count).toBe(20); // floor(10 / 0.5)
    });
  });

  describe("settlement on market resolution", () => {
    beforeEach(() => {
      clearCalibrationFinders();
      registerBuiltinCalibrationFinders();
    });
    afterEach(() => clearCalibrationFinders());

    const resolve = (id: string, outcome: "yes" | "no", ts = Date.now()) =>
      runCalibration(db, {
        kind: "resolving",
        id,
        ts,
        status: "resolved",
        value: { outcome },
        source: "t",
      });

    it("books a losing leg at 0¢ once, and frees the ticker", () => {
      seedOrder(db, { ticker: "T1", side: "yes", action: "open", count: 10, price: 40 });
      resolve("kalshi/T1", "no");
      expect(computeRealizedPnl(db, 0)).toBeCloseTo(-4, 9);
      // Idempotent: the leg now holds nothing, so a repeat resolution books nothing.
      resolve("kalshi/T1", "no");
      expect(computeRealizedPnl(db, 0)).toBeCloseTo(-4, 9);
      expect(checkNoSelfHedge(db, "kalshi", "T1", "no")).toBeNull();
      // Another venue's ticker of the same name is untouched.
      seedOrder(db, {
        ticker: "T2",
        side: "no",
        action: "open",
        count: 5,
        price: 30,
        venue: "polymarket",
      });
      resolve("kalshi/T2", "yes");
      expect(checkNoSelfHedge(db, "polymarket", "T2", "yes")).toContain("No-self-hedge");
    });

    it("books a winning leg at 100¢, net of partial closes", () => {
      seedOrder(db, { ticker: "T3", side: "no", action: "open", count: 10, price: 30 });
      seedOrder(db, { ticker: "T3", side: "no", action: "close", count: 4, price: 30 });
      const written = settleResolvedPositions(db, "kalshi", "T3", "no", 2000);
      expect(written.map((r) => [r.action, r.count, r.price])).toEqual([["settle", 6, 100]]);
      expect(computeRealizedPnl(db, 0)).toBeCloseTo((6 * (100 - 30)) / 100, 9);
    });

    it("counts settlement losses against the daily floor", async () => {
      for (const [key, value] of [
        ["bankroll", "1000"],
        ["cap", "500"],
        ["floor", "3"],
      ]) {
        db.setCoreMemory("Alice", key!, value!);
      }
      seedOrder(db, { ticker: "T4", side: "yes", action: "open", count: 10, price: 50 });
      resolve("kalshi/T4", "no");
      const alice = { name: "Alice" } as Entity;
      const refused = await attemptOpen(db, alice, {
        venue: "kalshi",
        ticker: "T5",
        side: "yes",
        count: 1,
        priceCents: 50,
      });
      expect(refused.ok).toBe(false);
      expect(refused.message).toContain("Daily loss floor reached");
    });
  });
});
