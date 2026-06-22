import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { checkNoSelfHedge, kellySize, type OrderRecord } from "../src/engine/commands/position";
import { MarinaDB } from "../src/persistence/database";
import { entityId } from "../src/types";
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
    price: 50,
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
});
