import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type {
  KalshiMarket,
  KalshiResult,
  getMarket as kalshiGetMarketFn,
} from "../src/net/kalshi-client";
import {
  type PolymarketEvent,
  type PolymarketMarket,
  type PolymarketResult,
  parseResolution,
  type getEvent as polymarketGetEventFn,
} from "../src/net/polymarket-client";
import { MarinaDB } from "../src/persistence/database";
import { createResolvingResolver } from "../src/resolvers/resolving";
import type { ResolverContext } from "../src/resolvers/types";
import { cleanupDb } from "./helpers";

// Resolver doesn't touch the db, but ResolverContext requires one. Use a
// single shared file across the suite to avoid per-test setup/teardown cost.
const TEST_DB = `/tmp/marina-resolving-${process.pid}.db`;
let sharedDb: MarinaDB;

beforeAll(() => {
  cleanupDb(TEST_DB);
  sharedDb = new MarinaDB(TEST_DB);
});

afterAll(() => {
  sharedDb.close();
  cleanupDb(TEST_DB);
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeKalshiMarket(overrides: Partial<KalshiMarket> = {}): KalshiMarket {
  return {
    ticker: "KXFED-26MAR",
    title: "Will the Fed cut rates in March?",
    yes_ask: 42,
    yes_bid: 41,
    no_ask: 59,
    no_bid: 58,
    volume: 1000,
    status: "active",
    close_time: "2026-03-19T18:00:00Z",
    category: "Economics",
    ...overrides,
  };
}

function makePolymarketEvent(market: Partial<PolymarketMarket> = {}): PolymarketEvent {
  return {
    id: "event-1",
    title: "Will BTC close above $100k Friday?",
    slug: "btc-100k-friday",
    markets: [
      {
        id: "market-1",
        question: "Will BTC close above $100k Friday?",
        outcomePrices: '["0.45","0.55"]',
        outcomes: '["Yes","No"]',
        volume: 5000,
        active: true,
        closed: false,
        ...market,
      },
    ],
  };
}

function ok<T>(response: T): { ok: true; response: T; paper: false } {
  return { ok: true, response, paper: false };
}

function err(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

const ctx: ResolverContext = {
  get db() {
    return sharedDb;
  },
} as ResolverContext;

// ─── parseResolution (polymarket helper) ────────────────────────────────────

describe("parseResolution (polymarket)", () => {
  it("returns null for an open market", () => {
    expect(parseResolution(makePolymarketEvent().markets[0]!).outcome).toBe(null);
  });

  it("returns yes when prices=[1.0,0.0] and outcomes=[Yes,No]", () => {
    const m = makePolymarketEvent({
      closed: true,
      outcomePrices: '["1.0","0.0"]',
      outcomes: '["Yes","No"]',
    }).markets[0]!;
    const r = parseResolution(m);
    expect(r.outcome).toBe("yes");
    expect(r.winningPrice).toBe(1.0);
  });

  it("returns no when prices=[0.0,1.0] and outcomes=[Yes,No]", () => {
    const m = makePolymarketEvent({
      closed: true,
      outcomePrices: '["0.0","1.0"]',
    }).markets[0]!;
    expect(parseResolution(m).outcome).toBe("no");
  });

  it("respects outcome label order — prices=[1.0,0.0] outcomes=[No,Yes] → no wins", () => {
    const m = makePolymarketEvent({
      closed: true,
      outcomePrices: '["1.0","0.0"]',
      outcomes: '["No","Yes"]',
    }).markets[0]!;
    expect(parseResolution(m).outcome).toBe("no");
  });

  it("defaults outcomes to [Yes, No] when the field is absent", () => {
    const m = makePolymarketEvent({
      closed: true,
      outcomePrices: '["1.0","0.0"]',
      outcomes: undefined,
    }).markets[0]!;
    expect(parseResolution(m).outcome).toBe("yes");
  });

  it("returns null for malformed outcomePrices JSON", () => {
    const m = makePolymarketEvent({
      closed: true,
      outcomePrices: "not-json",
    }).markets[0]!;
    expect(parseResolution(m).outcome).toBe(null);
  });

  it("returns null when no price reaches the resolution threshold (0.99)", () => {
    const m = makePolymarketEvent({
      closed: true,
      outcomePrices: '["0.55","0.45"]',
    }).markets[0]!;
    expect(parseResolution(m).outcome).toBe(null);
  });

  it("returns null when outcomes are non-binary (e.g. multi-outcome event)", () => {
    const m = makePolymarketEvent({
      closed: true,
      outcomePrices: '["1.0","0.0","0.0"]',
      outcomes: '["Trump","Biden","Other"]',
    }).markets[0]!;
    expect(parseResolution(m).outcome).toBe(null);
  });
});

// ─── Resolver — Kalshi ──────────────────────────────────────────────────────

describe("resolving resolver — kalshi", () => {
  it("returns resolved when market.result is 'yes'", async () => {
    const resolver = createResolvingResolver({
      kalshiGetMarket: (async () =>
        ok({
          market: makeKalshiMarket({
            status: "settled",
            result: "yes",
            expiration_time: "2026-03-19T18:00:00Z",
            expiration_value: 100,
          }),
        })) as typeof kalshiGetMarketFn,
    });
    const out = await resolver.resolve({
      args: { venue: "kalshi", ticker: "KXFED-26MAR" },
      ctx,
    });
    expect(out.status).toBe("resolved");
    if (out.status === "resolved") {
      expect((out.value as { outcome: string }).outcome).toBe("yes");
      expect(out.source).toContain("kalshi.com");
    }
  });

  it("returns resolved with outcome=no", async () => {
    const resolver = createResolvingResolver({
      kalshiGetMarket: (async () =>
        ok({
          market: makeKalshiMarket({ status: "settled", result: "no" }),
        })) as typeof kalshiGetMarketFn,
    });
    const out = await resolver.resolve({
      args: { venue: "kalshi", ticker: "KXFED-26MAR" },
      ctx,
    });
    expect(out.status).toBe("resolved");
    if (out.status === "resolved") {
      expect((out.value as { outcome: string }).outcome).toBe("no");
    }
  });

  it("returns no-change for an open market", async () => {
    const resolver = createResolvingResolver({
      kalshiGetMarket: (async () =>
        ok({ market: makeKalshiMarket({ status: "active" }) })) as typeof kalshiGetMarketFn,
    });
    const out = await resolver.resolve({
      args: { venue: "kalshi", ticker: "KXFED-26MAR" },
      ctx,
    });
    expect(out.status).toBe("no-change");
  });

  it("returns no-change when status='settled' but result is missing (defensive)", async () => {
    const resolver = createResolvingResolver({
      kalshiGetMarket: (async () =>
        ok({
          market: makeKalshiMarket({ status: "settled", result: undefined }),
        })) as typeof kalshiGetMarketFn,
    });
    const out = await resolver.resolve({
      args: { venue: "kalshi", ticker: "KXFED-26MAR" },
      ctx,
    });
    expect(out.status).toBe("no-change");
  });

  it("returns error with retryAfter when the client fails", async () => {
    const resolver = createResolvingResolver({
      kalshiGetMarket: (async () => err("503 Service Unavailable")) as typeof kalshiGetMarketFn,
    });
    const out = await resolver.resolve({
      args: { venue: "kalshi", ticker: "KXFED-26MAR" },
      ctx,
    });
    expect(out.status).toBe("error");
    if (out.status === "error") {
      expect(out.reason).toContain("kalshi");
      expect(out.reason).toContain("503");
      expect(out.retryAfter).toBe(60_000);
    }
  });
});

// ─── Resolver — Polymarket ──────────────────────────────────────────────────

describe("resolving resolver — polymarket", () => {
  it("returns resolved when the first market closed at YES", async () => {
    const resolver = createResolvingResolver({
      polymarketGetEvent: (async () =>
        ok(
          makePolymarketEvent({
            closed: true,
            outcomePrices: '["1.0","0.0"]',
          }),
        )) as typeof polymarketGetEventFn,
    });
    const out = await resolver.resolve({
      args: { venue: "polymarket", ticker: "btc-100k-friday" },
      ctx,
    });
    expect(out.status).toBe("resolved");
    if (out.status === "resolved") {
      expect((out.value as { outcome: string }).outcome).toBe("yes");
      expect(out.source).toContain("polymarket.com");
    }
  });

  it("returns resolved with outcome=no", async () => {
    const resolver = createResolvingResolver({
      polymarketGetEvent: (async () =>
        ok(
          makePolymarketEvent({
            closed: true,
            outcomePrices: '["0.0","1.0"]',
          }),
        )) as typeof polymarketGetEventFn,
    });
    const out = await resolver.resolve({
      args: { venue: "polymarket", ticker: "btc-100k-friday" },
      ctx,
    });
    expect(out.status).toBe("resolved");
    if (out.status === "resolved") {
      expect((out.value as { outcome: string }).outcome).toBe("no");
    }
  });

  it("returns no-change for an open event", async () => {
    const resolver = createResolvingResolver({
      polymarketGetEvent: (async () => ok(makePolymarketEvent())) as typeof polymarketGetEventFn,
    });
    const out = await resolver.resolve({
      args: { venue: "polymarket", ticker: "btc-100k-friday" },
      ctx,
    });
    expect(out.status).toBe("no-change");
  });

  it("returns no-change when the event has no markets", async () => {
    const resolver = createResolvingResolver({
      polymarketGetEvent: (async () =>
        ok({
          id: "ghost",
          title: "Ghost event",
          slug: "ghost",
          markets: [] as PolymarketMarket[],
        })) as typeof polymarketGetEventFn,
    });
    const out = await resolver.resolve({
      args: { venue: "polymarket", ticker: "ghost" },
      ctx,
    });
    expect(out.status).toBe("no-change");
  });

  it("returns error when the client fails", async () => {
    const resolver = createResolvingResolver({
      polymarketGetEvent: (async () => err("gamma 404")) as typeof polymarketGetEventFn,
    });
    const out = await resolver.resolve({
      args: { venue: "polymarket", ticker: "btc-100k-friday" },
      ctx,
    });
    expect(out.status).toBe("error");
    if (out.status === "error") {
      expect(out.reason).toContain("polymarket");
    }
  });
});

// ─── Resolver — args + identity ─────────────────────────────────────────────

describe("resolving resolver — args + identity", () => {
  const resolver = createResolvingResolver();

  it("parseArgs requires venue and ticker", () => {
    expect(resolver.parseArgs({}).ok).toBe(false);
    expect(resolver.parseArgs({ venue: "kalshi" }).ok).toBe(false);
    expect(resolver.parseArgs({ ticker: "X" }).ok).toBe(false);
  });

  it("parseArgs rejects unknown venues", () => {
    const r = resolver.parseArgs({ venue: "manifold", ticker: "X" });
    expect(r.ok).toBe(false);
  });

  it("parseArgs accepts kalshi + polymarket", () => {
    expect(resolver.parseArgs({ venue: "kalshi", ticker: "K-X" }).ok).toBe(true);
    expect(resolver.parseArgs({ venue: "Polymarket", ticker: "evt" }).ok).toBe(true); // case-insensitive
  });

  it("idFromArgs is venue-prefixed and stable", () => {
    expect(resolver.idFromArgs({ venue: "kalshi", ticker: "K-X" })).toBe("kalshi/K-X");
    expect(resolver.idFromArgs({ venue: "polymarket", ticker: "evt" })).toBe("polymarket/evt");
  });

  it("closesOn=['resolved'] — watches with retirement=resolved retire on first resolution", () => {
    expect(resolver.closesOn).toEqual(["resolved"]);
  });

  it("kind is 'resolving' (single-word gerund per voice convention)", () => {
    expect(resolver.kind).toBe("resolving");
    expect(resolver.kind).not.toMatch(/[-_]/);
  });
});

// ─── Helper local types ─────────────────────────────────────────────────────
// These intentionally aren't imported — they're satisfied by the `ok`/`err`
// helpers and Bun's structural typing. Including the import line keeps the
// type-only references above honest at the typecheck layer.
type _AvoidUnusedImports = KalshiResult<unknown> | PolymarketResult<unknown>;
