import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MarinaDB } from "../src/persistence/database";
import {
  type CalibrationFinder,
  clearCalibrationFinders,
  inworldMarketResolverFinder,
  listCalibrationFinders,
  parseSampleId,
  positionThesisFinder,
  registerBuiltinCalibrationFinders,
  registerCalibrationFinder,
  runCalibration,
  tabh2oForecastFinder,
} from "../src/resolvers/calibration";
import { writeSample } from "../src/resolvers/sample-writer";
import type { Sample } from "../src/resolvers/types";
import { cleanupDb } from "./helpers";

const TEST_DB = "test_calibration.db";

function makeResolved(idSuffix: string, overrides: Partial<Sample> = {}): Sample {
  return {
    kind: "resolving",
    id: idSuffix,
    ts: Date.now(),
    status: "resolved",
    value: { outcome: "yes" },
    source: "test://",
    ...overrides,
  };
}

describe("parseSampleId", () => {
  it("splits on the first slash", () => {
    expect(parseSampleId("kalshi/KXFED-26MAR")).toEqual({
      venue: "kalshi",
      ticker: "KXFED-26MAR",
    });
    expect(parseSampleId("inworld/market:tech")).toEqual({
      venue: "inworld",
      ticker: "market:tech",
    });
  });

  it("returns undefined for malformed ids", () => {
    expect(parseSampleId("noseparator")).toBeUndefined();
    expect(parseSampleId("/leading")).toBeUndefined();
    expect(parseSampleId("trailing/")).toBeUndefined();
  });
});

describe("calibration registry", () => {
  beforeEach(() => clearCalibrationFinders());
  afterEach(() => clearCalibrationFinders());

  it("registerBuiltinCalibrationFinders adds the three built-ins", () => {
    registerBuiltinCalibrationFinders();
    const names = listCalibrationFinders().map((f) => f.name);
    expect(names).toContain("tabh2o-forecast");
    expect(names).toContain("position-thesis");
    expect(names).toContain("inworld-market-resolver");
  });

  it("re-registering a finder by name is idempotent (Map.set semantics)", () => {
    registerBuiltinCalibrationFinders();
    const first = listCalibrationFinders().length;
    registerBuiltinCalibrationFinders();
    expect(listCalibrationFinders().length).toBe(first);
  });

  it("runCalibration is a no-op for non-resolved samples", () => {
    let called = 0;
    const fixture: CalibrationFinder = {
      name: "fixture",
      calibrate: () => {
        called++;
      },
    };
    registerCalibrationFinder(fixture);
    runCalibration({} as MarinaDB, { ...makeResolved("x/y"), status: "no-change" });
    runCalibration({} as MarinaDB, { ...makeResolved("x/y"), status: "error", reason: "x" });
    runCalibration({} as MarinaDB, { ...makeResolved("x/y"), status: "changed" });
    expect(called).toBe(0);
  });

  it("runCalibration calls every finder for resolved samples even if one throws", () => {
    const called: string[] = [];
    registerCalibrationFinder({
      name: "throws",
      calibrate: () => {
        called.push("throws");
        throw new Error("boom");
      },
    });
    registerCalibrationFinder({
      name: "ok",
      calibrate: () => {
        called.push("ok");
      },
    });
    runCalibration({} as MarinaDB, makeResolved("x/y"));
    expect(called).toEqual(["throws", "ok"]);
  });
});

describe("tabh2o-forecast finder", () => {
  let db: MarinaDB;
  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    clearCalibrationFinders();
    registerCalibrationFinder(tabh2oForecastFinder);
  });
  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
    clearCalibrationFinders();
  });

  it("pairs a TabH2O forecast note with an outcome note when its inworld market resolves", () => {
    db.createNote(
      "alice",
      "[TabH2O forecast market:tech] YES 65% NO 35% — Will GPT-5 ship? Trained on 100 markets.",
      undefined,
      { importance: 7, noteType: "inference" },
    );
    runCalibration(db, makeResolved("inworld/market:tech", { value: { outcome: "yes" } }));
    const outcomes = db.searchAllNotes("TabH2O outcome market:tech", 5);
    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes[0]?.content).toContain("CORRECT");
    expect(outcomes[0]?.content).toContain("Brier");
  });

  it("classifies an incorrect prediction as MISS", () => {
    db.createNote("alice", "[TabH2O forecast market:tech] YES 70% NO 30% — Test.", undefined, {
      importance: 7,
      noteType: "inference",
    });
    runCalibration(db, makeResolved("inworld/market:tech", { value: { outcome: "no" } }));
    const outcomes = db.searchAllNotes("TabH2O outcome market:tech", 5);
    expect(outcomes[0]?.content).toContain("MISS");
  });

  it("ignores samples whose venue is not inworld", () => {
    db.createNote("alice", "[TabH2O forecast K-FED] YES 60% — Test.", undefined, {
      importance: 7,
      noteType: "inference",
    });
    runCalibration(db, makeResolved("kalshi/K-FED", { value: { outcome: "yes" } }));
    expect(db.searchAllNotes("TabH2O outcome", 5)).toHaveLength(0);
  });
});

describe("position-thesis finder", () => {
  let db: MarinaDB;
  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    clearCalibrationFinders();
    registerCalibrationFinder(positionThesisFinder);
  });
  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
    clearCalibrationFinders();
  });

  it("writes a position outcome note pairing a paper-orders open with the venue resolution", () => {
    db.createBoard({ id: "board:paper-orders", name: "paper-orders", scopeType: "global" });
    db.createBoardPost({
      boardId: "board:paper-orders",
      authorId: "e_alice",
      authorName: "alice",
      title: "open kalshi/KXFED-26MAR",
      body: JSON.stringify({
        order_id: "abc",
        venue: "kalshi",
        ticker: "KXFED-26MAR",
        side: "yes",
        action: "open",
        count: 5,
        price: 42,
      }),
      tags: ["venue:kalshi", "ticker:KXFED-26MAR"],
    });

    runCalibration(db, makeResolved("kalshi/KXFED-26MAR", { value: { outcome: "yes" } }));
    const outcomes = db.searchAllNotes("position outcome kalshi", 5);
    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes[0]?.content).toContain("WIN");
  });

  it("classifies an opposing-side position as LOSS", () => {
    db.createBoard({ id: "board:paper-orders", name: "paper-orders", scopeType: "global" });
    db.createBoardPost({
      boardId: "board:paper-orders",
      authorId: "e_alice",
      authorName: "alice",
      title: "open polymarket/btc-100k",
      body: JSON.stringify({
        venue: "polymarket",
        ticker: "btc-100k",
        side: "yes",
        action: "open",
        count: 1,
        price: 0.55,
      }),
      tags: ["venue:polymarket"],
    });
    runCalibration(db, makeResolved("polymarket/btc-100k", { value: { outcome: "no" } }));
    const outcomes = db.searchAllNotes("position outcome polymarket", 5);
    expect(outcomes[0]?.content).toContain("LOSS");
  });

  it("does nothing when no paper-orders board exists (bettor world not loaded)", () => {
    runCalibration(db, makeResolved("kalshi/X", { value: { outcome: "yes" } }));
    expect(db.searchAllNotes("position outcome", 5)).toHaveLength(0);
  });

  it("ignores inworld samples (those go to the inworld-market-resolver)", () => {
    db.createBoard({ id: "board:paper-orders", name: "paper-orders", scopeType: "global" });
    db.createBoardPost({
      boardId: "board:paper-orders",
      authorId: "e_alice",
      authorName: "alice",
      title: "open inworld",
      body: JSON.stringify({
        venue: "inworld",
        ticker: "market:tech",
        side: "yes",
        action: "open",
      }),
      tags: [],
    });
    runCalibration(db, makeResolved("inworld/market:tech", { value: { outcome: "yes" } }));
    expect(db.searchAllNotes("position outcome", 5)).toHaveLength(0);
  });
});

describe("inworld-market-resolver finder", () => {
  let db: MarinaDB;
  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    clearCalibrationFinders();
    registerCalibrationFinder(inworldMarketResolverFinder);
  });
  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
    clearCalibrationFinders();
  });

  it("propagates outcome + scores into the markets table on resolution", () => {
    db.createMarket({
      id: "market:test",
      roomId: "markets/test",
      question: "Will it rain?",
      category: "weather",
    });
    runCalibration(db, {
      ...makeResolved("inworld/market:test"),
      value: {
        outcome: "yes",
        scores: [{ entity: "alice", brier: 0.04, correct: true }],
        marketId: "market:test",
        resolvedBy: "alice",
      },
    });
    const market = db.getMarket("market:test");
    expect(market?.status).toBe("resolved");
    expect(market?.outcome).toBe("yes");
    expect(market?.resolved_by).toBe("alice");
  });

  it("ignores non-inworld venues", () => {
    db.createMarket({
      id: "market:test",
      roomId: "markets/test",
      question: "Will it rain?",
      category: "weather",
    });
    runCalibration(db, {
      ...makeResolved("kalshi/K-RAIN"),
      value: { outcome: "yes", marketId: "market:test" },
    });
    const market = db.getMarket("market:test");
    expect(market?.status).not.toBe("resolved");
  });
});

describe("end-to-end: writeSample triggers calibration", () => {
  let db: MarinaDB;
  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    clearCalibrationFinders();
    registerCalibrationFinder(tabh2oForecastFinder);
  });
  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
    clearCalibrationFinders();
  });

  it("writeSample with status=resolved auto-runs registered finders", () => {
    db.createNote("alice", "[TabH2O forecast market:test] YES 80% NO 20% — Test.", undefined, {
      importance: 7,
      noteType: "inference",
    });
    writeSample({
      db,
      sample: {
        kind: "resolving",
        id: "inworld/market:test",
        ts: Date.now(),
        status: "resolved",
        value: { outcome: "yes" },
        source: "test://",
      },
      authorName: "alice",
    });
    const outcomes = db.searchAllNotes("TabH2O outcome market:test", 5);
    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes[0]?.content).toContain("CORRECT");
  });

  it("writeSample with status=changed does NOT run calibration", () => {
    db.createNote("alice", "[TabH2O forecast market:test] YES 80% NO 20% — Test.", undefined, {
      importance: 7,
      noteType: "inference",
    });
    writeSample({
      db,
      sample: {
        kind: "resolving",
        id: "inworld/market:test",
        ts: Date.now(),
        status: "changed",
        value: { outcome: "yes" },
        source: "test://",
      },
      authorName: "alice",
    });
    expect(db.searchAllNotes("TabH2O outcome", 5)).toHaveLength(0);
  });
});
