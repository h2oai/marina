// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live (real-money) prediction-market orders ask a person (`trading.live`).
 *
 * - An order that would reach a live venue, by an entity without an operator
 *   grant, is held as a challenge and returns at once; nothing is sent.
 * - A person's `challenge approve <token> once` places that one order; an
 *   agent can't approve; an operator grant (`gate grant`) lets orders pass.
 * - `open` posture and the local profile do not lift it; `sovereign` does.
 * - Paper orders are never held.
 * - A market order (no limit) is costed at the worst case for the cap check.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { OPEN_POSTURE_CORE } from "../src/engine/autonomy";
import { resetChallengesForTests } from "../src/engine/challenges";
import { attemptOpen, setVenueClientsForTests } from "../src/engine/commands/position";
import { Engine } from "../src/engine/engine";
import { resetGateContextForTests } from "../src/engine/gate-context";
import { SAFETY_GATES } from "../src/engine/safety-gates";
import type { PlaceOrderRequest } from "../src/net/clients/kalshi-client";
import { MarinaDB } from "../src/persistence/database";
import { type Entity, type EntityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi, until } from "./helpers";
import { scopeProcessState } from "./process-state";

const tokenIn = (text: string) => text.match(/\b(ch_[0-9a-f]{12})\b/)?.[1];
const text = (c: MockConnection) => stripAnsi(c.allText().join("\n"));

interface Venue {
  placed: PlaceOrderRequest[];
  cancelled: string[];
  restore: () => void;
}

/** A Kalshi client with no network: live (or paper) by flag, records every call. */
function mockKalshi(live: boolean): Venue {
  const placed: PlaceOrderRequest[] = [];
  const cancelled: string[] = [];
  const restore = setVenueClientsForTests({
    kalshi: {
      isPaperMode: () => !live,
      placeOrder: async (req) => {
        placed.push(req);
        return {
          ok: true,
          paper: !live,
          response: {
            order_id: `${live ? "live" : "paper"}-${placed.length}`,
            ticker: req.ticker,
            side: req.side,
            action: req.action,
            type: req.type,
            count: req.count,
            yes_price: req.yes_price,
            no_price: req.no_price,
            status: live ? "resting" : "paper",
            created_ts: Date.now(),
          },
        };
      },
      cancelOrder: async (orderId) => {
        cancelled.push(orderId);
        return { ok: true, paper: !live, response: { order_id: orderId, status: "cancelled" } };
      },
    },
  });
  return { placed, cancelled, restore };
}

describe("trading.live gate registry", () => {
  it("is an operator-grant core gate the local profile does not lift", () => {
    const gate = SAFETY_GATES["trading.live"]!;
    expect(gate.operatorGrant).toBe(true);
    expect(gate.holdsUnderLocalProfile).toBe(true);
    expect(gate.minStanding).toBe(0);
    expect(gate.demoThreshold).toBe(0);
    expect(OPEN_POSTURE_CORE.has("trading.live")).toBe(true);
  });
});

describe("live orders ask a person (trading.live)", () => {
  const DB = `test_trading_live_${process.pid}.db`;
  let db: MarinaDB;
  let engine: Engine;
  let venue: Venue;
  let state: DisposableStack | undefined;
  let n = 0;

  const send = (c: MockConnection, raw: string) => engine.processCommand(c.entity!, raw);
  const join = (name: string, opts: { rank?: number; agent?: boolean } = {}) => {
    const c = new MockConnection(`${name}-${n++}`);
    if (opts.agent) (c as unknown as { agent: boolean }).agent = true;
    engine.addConnection(c);
    engine.spawnEntity(c.id, name);
    if (opts.rank !== undefined)
      engine.entities.get(c.entity as EntityId)!.properties.rank = opts.rank;
    c.clear();
    return c;
  };
  const trader = () => {
    const c = join("Trader", { rank: 5 });
    db.setCoreMemory("Trader", "bankroll", "1000");
    db.setCoreMemory("Trader", "cap", "500");
    db.setCoreMemory("Trader", "floor", "100");
    return c;
  };

  beforeEach(() => {
    using pending = scopeProcessState({
      trustProfile: null,
      env: { MARINA_AUTONOMY: undefined, MARINA_CHALLENGES: undefined },
    });
    state = pending.move();
    resetChallengesForTests();
    resetGateContextForTests();
    db = new MarinaDB(DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    venue = mockKalshi(true);
  });
  afterEach(() => {
    venue.restore();
    resetChallengesForTests();
    resetGateContextForTests();
    engine.stop();
    db.close();
    cleanupDb(DB);
    using _state = state;
    state = undefined;
  });

  it("holds a live order without a grant: nothing sent, returns at once", async () => {
    const t = trader();
    const root = join("Root", { rank: 9 });
    await send(t, "position open kalshi KXTEST yes 10 40");
    expect(venue.placed).toEqual([]);
    expect(text(t)).toContain("Live order held");
    expect(text(t)).toContain("Operator grant");
    const token = tokenIn(text(t));
    expect(token).toBeDefined();
    expect(text(root)).toContain(`challenge approve ${token}`);
    expect(engine.db?.getCompetence(t.entity!, "trading.live")).toBeUndefined();
  });

  it("a person's `once` approval places that one order; the next is held again", async () => {
    const t = trader();
    const root = join("Root", { rank: 9 });
    await send(t, "position open kalshi KXTEST yes 10 40");
    const token = tokenIn(text(t))!;
    await send(root, `challenge approve ${token} once`);
    await until(() => venue.placed.length === 1);
    expect(venue.placed[0]).toMatchObject({ ticker: "KXTEST", side: "yes", count: 10 });
    await until(() => text(t).includes("Position opened"));
    expect(text(t)).toContain("LIVE");
    // Approvals never build an operator-grant gate.
    expect(db.getCompetence(t.entity!, "trading.live")).toBeUndefined();

    t.clear();
    await send(t, "position open kalshi KXTEST yes 5 40");
    expect(venue.placed).toHaveLength(1);
    expect(tokenIn(text(t))).toBeDefined();
  });

  it("an agent can't approve a held live order, whatever its rank", async () => {
    const t = trader();
    const bot = join("Botty", { rank: 9, agent: true });
    await send(t, "position open kalshi KXTEST yes 10 40");
    const token = tokenIn(text(t))!;
    await send(bot, `challenge approve ${token} once`);
    expect(stripAnsi(bot.lastText())).toContain("agents don't");
    expect(venue.placed).toEqual([]);
  });

  it("an operator's grant lets live orders pass without a hold", async () => {
    const t = trader();
    const root = join("Root", { rank: 9 });
    await send(root, "gate grant Trader trading.live");
    expect(stripAnsi(root.lastText())).toContain("Granted trading.live");
    await send(t, "position open kalshi KXTEST yes 10 40");
    expect(venue.placed).toHaveLength(1);
    expect(tokenIn(text(t))).toBeUndefined();
  });

  it("`open` posture still holds live orders", async () => {
    using _open = scopeProcessState({ env: { MARINA_AUTONOMY: "open" } });
    const t = trader();
    await send(t, "position open kalshi KXTEST yes 10 40");
    expect(venue.placed).toEqual([]);
    expect(tokenIn(text(t))).toBeDefined();
  });

  it("the local profile still holds live orders; `sovereign` passes them", async () => {
    {
      using _local = scopeProcessState({ trustProfile: "local" });
      const t = trader();
      await send(t, "position open kalshi KXTEST yes 10 40");
      expect(venue.placed).toEqual([]);
      expect(text(t)).toContain("Live order held");
    }
    {
      using _sovereign = scopeProcessState({ env: { MARINA_AUTONOMY: "sovereign" } });
      const t = join("Solo", { rank: 5 });
      db.setCoreMemory("Solo", "bankroll", "1000");
      db.setCoreMemory("Solo", "cap", "500");
      db.setCoreMemory("Solo", "floor", "100");
      await send(t, "position open kalshi KXSOV yes 10 40");
      expect(venue.placed).toHaveLength(1);
      expect(text(t)).not.toContain("Live order held");
    }
  });

  it("a live close and a live proposal confirm are held too", async () => {
    const t = trader();
    const root = join("Root", { rank: 9 });
    await send(root, "gate grant Trader trading.live");
    await send(t, "position open kalshi KXCLOSE yes 10 40");
    expect(venue.placed).toHaveLength(1);
    await send(root, "gate revoke Trader trading.live");

    t.clear();
    await send(t, "position close live-1");
    expect(venue.cancelled).toEqual([]);
    expect(text(t)).toContain("Live order held");

    t.clear();
    await send(
      t,
      `position propose {"items":[{"venue":"kalshi","ticker":"KXP1","side":"yes","count":2,"price":30},{"venue":"kalshi","ticker":"KXP2","side":"no","count":3,"price":20}]}`,
    );
    const postId = text(t).match(/Proposal posted #(\d+)/)?.[1];
    expect(postId).toBeDefined();
    t.clear();
    await send(t, `position confirm ${postId}`);
    expect(venue.placed).toHaveLength(1);
    const token = tokenIn(text(t))!;
    expect(token).toBeDefined();
    // One approval runs the whole confirm, every leg.
    await send(root, `challenge approve ${token} once`);
    await until(() => venue.placed.length === 3);
  });

  it("paper orders are never held", async () => {
    venue.restore();
    venue = mockKalshi(false);
    const t = trader();
    await send(t, "position open kalshi KXPAPER yes 10 40");
    expect(venue.placed).toHaveLength(1);
    expect(text(t)).toContain("PAPER");
    expect(tokenIn(text(t))).toBeUndefined();
    t.clear();
    await send(t, "position close paper-1");
    expect(venue.cancelled).toEqual(["paper-1"]);
  });
});

describe("market-order stake cap", () => {
  const DB = `test_trading_cap_${process.pid}.db`;
  let db: MarinaDB;
  let venue: Venue;
  const entity = {
    id: "e_cap" as EntityId,
    name: "Capper",
    properties: { rank: 5 },
  } as unknown as Entity;

  beforeEach(() => {
    db = new MarinaDB(DB);
    db.setCoreMemory("Capper", "bankroll", "1000");
    db.setCoreMemory("Capper", "cap", "10");
    db.setCoreMemory("Capper", "floor", "100");
    venue = mockKalshi(false);
  });
  afterEach(() => {
    venue.restore();
    db.close();
    cleanupDb(DB);
  });

  it("costs a market order at the worst case (99¢) for the cap check", async () => {
    // 15 contracts: $7.50 at the 50¢ estimate, $14.85 at worst — over a $10 cap.
    const market = await attemptOpen(db, entity, {
      venue: "kalshi",
      ticker: "KXCAP",
      side: "yes",
      count: 15,
    });
    expect(market.ok).toBe(false);
    expect(market.message).toContain("$14.85");
    expect(market.message).toContain("worst case");
    expect(venue.placed).toEqual([]);

    // The same count with a 50¢ limit is $7.50 at most: inside the cap.
    const limit = await attemptOpen(db, entity, {
      venue: "kalshi",
      ticker: "KXCAP",
      side: "yes",
      count: 15,
      priceCents: 50,
    });
    expect(limit.ok).toBe(true);
    expect(limit.stakeUsd).toBeCloseTo(7.5, 5);

    // A market order whose worst case fits passes (10 × 99¢ = $9.90).
    const small = await attemptOpen(db, entity, {
      venue: "kalshi",
      ticker: "KXCAP",
      side: "yes",
      count: 10,
    });
    expect(small.ok).toBe(true);
  });
});
