// `resolving` resolver — did a binary prediction-market event settle?
//
// Polls Kalshi and Polymarket for a specific market's resolution. Returns
// status:resolved with {outcome:"yes"|"no", resolvedAt} when the venue
// reports settlement, status:no-change while the market is still open, and
// status:error on auth/network failures.
//
// Closure: resolves once and retires — the calibration loop pairs the
// resulting Sample with whatever forecast notes referenced this market.
//
// Voice-friendly identifier per natural-language-commands convention:
// "resolving" reads cleanly via TTS. Args are key:value pairs, no hyphens
// in the values the user types.

import * as kalshi from "../net/kalshi-client";
import * as polymarket from "../net/polymarket-client";
import type { ArgParseResult, Resolver, ResolverOutput } from "./types";

// ─── Args ───────────────────────────────────────────────────────────────────

export type ResolvingArgs = {
  venue: "kalshi" | "polymarket";
  /** Kalshi: market ticker (e.g. "KXFED-26MAR"). Polymarket: event slug. */
  ticker: string;
};

function parseArgs(raw: Record<string, string>): ArgParseResult<ResolvingArgs> {
  const venue = raw.venue?.toLowerCase();
  if (venue !== "kalshi" && venue !== "polymarket") {
    return { ok: false, error: 'venue must be "kalshi" or "polymarket"' };
  }
  const ticker = raw.ticker?.trim();
  if (!ticker) {
    return { ok: false, error: "ticker is required" };
  }
  return { ok: true, args: { venue, ticker } };
}

// ─── Dependency injection ───────────────────────────────────────────────────
//
// Production resolvers pull from the imported clients; tests pass mocks via
// createResolvingResolver(deps) without going near HTTP or the SSRF guard.

export interface ResolvingDeps {
  kalshiGetMarket: typeof kalshi.getMarket;
  polymarketGetEvent: typeof polymarket.getEvent;
  /** Override the canonical source URL for the Sample. Tests use this so
   *  the Sample's source field reflects the mock origin instead of the
   *  hardcoded production endpoint. Production leaves undefined. */
  sourceUrl?: (args: ResolvingArgs) => string;
}

const PROD_DEPS: ResolvingDeps = {
  kalshiGetMarket: kalshi.getMarket,
  polymarketGetEvent: polymarket.getEvent,
};

function defaultSourceUrl(args: ResolvingArgs): string {
  if (args.venue === "kalshi") {
    return `https://api.elections.kalshi.com/trade-api/v2/markets/${args.ticker}`;
  }
  return `https://gamma-api.polymarket.com/events/${args.ticker}`;
}

// ─── Resolver factory ───────────────────────────────────────────────────────

export function createResolvingResolver(
  deps: Partial<ResolvingDeps> = {},
): Resolver<ResolvingArgs> {
  const kalshiGet = deps.kalshiGetMarket ?? PROD_DEPS.kalshiGetMarket;
  const polymarketGet = deps.polymarketGetEvent ?? PROD_DEPS.polymarketGetEvent;
  const source = deps.sourceUrl ?? defaultSourceUrl;

  return {
    kind: "resolving",
    description:
      "Did a Kalshi or Polymarket binary market resolve? Args: venue:<kalshi|polymarket> ticker:<id>",
    parseArgs,
    idFromArgs: (args) => `${args.venue}/${args.ticker}`,
    closesOn: ["resolved"],
    async resolve({ args }): Promise<ResolverOutput> {
      const sourceUrl = source(args);
      if (args.venue === "kalshi") {
        return await resolveKalshi(args, kalshiGet, sourceUrl);
      }
      return await resolvePolymarket(args, polymarketGet, sourceUrl);
    },
  };
}

// ─── Per-venue logic ────────────────────────────────────────────────────────

async function resolveKalshi(
  args: ResolvingArgs,
  getMarket: ResolvingDeps["kalshiGetMarket"],
  sourceUrl: string,
): Promise<ResolverOutput> {
  const result = await getMarket(args.ticker);
  if (!result.ok) {
    return { status: "error", reason: `kalshi: ${result.error}`, retryAfter: 60_000 };
  }
  const market = result.response.market;
  // Resolution signal: `result` field present + status indicates settlement.
  // We accept either the field directly OR status="settled"/"determined".
  const outcome = market.result;
  const settled =
    outcome === "yes" ||
    outcome === "no" ||
    market.status === "settled" ||
    market.status === "determined";
  if (!settled || (outcome !== "yes" && outcome !== "no")) {
    return { status: "no-change", source: sourceUrl };
  }
  return {
    status: "resolved",
    value: {
      outcome,
      resolvedAt: market.expiration_time ?? null,
      expirationValue: market.expiration_value ?? null,
      ticker: market.ticker,
      title: market.title,
    },
    source: sourceUrl,
  };
}

async function resolvePolymarket(
  args: ResolvingArgs,
  getEvent: ResolvingDeps["polymarketGetEvent"],
  sourceUrl: string,
): Promise<ResolverOutput> {
  const result = await getEvent(args.ticker);
  if (!result.ok) {
    return { status: "error", reason: `polymarket: ${result.error}`, retryAfter: 60_000 };
  }
  const event = result.response;
  // Take the first market — binary events typically have exactly one. Multi-
  // market events are not supported by this v1 resolver; the resolver returns
  // no-change and the caller can drop down to a more specific kind later.
  const market = event.markets?.[0];
  if (!market) {
    return { status: "no-change", source: sourceUrl };
  }
  const parsed = polymarket.parseResolution(market);
  if (!parsed.outcome) {
    return { status: "no-change", source: sourceUrl };
  }
  return {
    status: "resolved",
    value: {
      outcome: parsed.outcome,
      winningPrice: parsed.winningPrice ?? null,
      eventId: event.id,
      eventTitle: event.title,
      marketId: market.id,
      marketQuestion: market.question,
    },
    source: sourceUrl,
  };
}
