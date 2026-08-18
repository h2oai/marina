// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MarinaDB } from "../src/persistence/database";
import type { CommandInput, Entity, EntityId, RoomContext, RoomId, RoomModule } from "../src/types";
import type { WorldDefinition } from "../src/world/world-definition";
import {
  seedProject,
  seedRoomTemplates,
  seedTabH2OConnector,
  seedTabH2OForecasting,
  seedTraitsAndRoles,
} from "./seed";

// ─── External API Config ────────────────────────────────────────────────────

const KALSHI_API = "https://api.elections.kalshi.com/trade-api/v2";
const POLYMARKET_API = "https://gamma-api.polymarket.com";

// How often to refresh (in ticks). ctx.fetch is rate-limited to 1 req/10s per room,
// so we throttle internally to avoid wasting the budget.
const FEED_REFRESH_TICKS = 60; // ~60s at default 1s tick
const DIGEST_INTERVAL = 10; // Post digest every N refreshes (~10 min at default tick)

// ─── Market Data Types ──────────────────────────────────────────────────────

interface KalshiMarket {
  ticker: string;
  title: string;
  yes_ask: number;
  yes_bid: number;
  no_ask: number;
  no_bid: number;
  volume: number;
  status: string;
  close_time: string;
  category: string;
  subtitle?: string;
}

interface PolymarketEvent {
  id: string;
  title: string;
  slug: string;
  markets: {
    id: string;
    question: string;
    outcomePrices: string; // JSON string: "[\"0.65\",\"0.35\"]"
    volume: number;
    active: boolean;
    closed: boolean;
  }[];
}

interface CachedFeed {
  markets: { title: string; yes: number; volume: string; status: string; ticker?: string }[];
  fetchedAt: number;
}

// ─── Feed Parsing Helpers ───────────────────────────────────────────────────

function parseKalshiResponse(body: string): CachedFeed["markets"] {
  try {
    const data = JSON.parse(body);
    const markets = data.markets ?? data;
    if (!Array.isArray(markets)) return [];
    return markets.slice(0, 25).map((m: KalshiMarket) => ({
      title: m.title ?? m.ticker,
      yes: Math.round((m.yes_ask ?? m.yes_bid ?? 0) * 100),
      volume: formatVolume(m.volume ?? 0),
      status: m.status ?? "open",
      ticker: m.ticker,
    }));
  } catch {
    return [];
  }
}

function parsePolymarketResponse(body: string): CachedFeed["markets"] {
  try {
    const events: PolymarketEvent[] = JSON.parse(body);
    if (!Array.isArray(events)) return [];
    const result: CachedFeed["markets"] = [];
    for (const evt of events.slice(0, 15)) {
      for (const m of evt.markets ?? []) {
        if (!m.active && !m.closed) continue;
        let yesPrice = 50;
        try {
          const prices = JSON.parse(m.outcomePrices ?? "[]");
          if (prices[0]) yesPrice = Math.round(Number.parseFloat(prices[0]) * 100);
        } catch {
          /* ignore parse errors */
        }
        result.push({
          title: m.question || evt.title,
          yes: yesPrice,
          volume: formatVolume(m.volume ?? 0),
          status: m.closed ? "closed" : "active",
        });
      }
    }
    return result.slice(0, 25);
  } catch {
    return [];
  }
}

function formatVolume(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v}`;
}

function formatFeedLine(m: { title: string; yes: number; volume: string; status: string }): string {
  const bar = "█".repeat(Math.round(m.yes / 5)) + "░".repeat(20 - Math.round(m.yes / 5));
  return `  ${String(m.yes).padStart(3)}% ${bar} ${m.volume.padStart(7)}  ${m.title.slice(0, 55)}`;
}

function formatFeed(source: string, feed: CachedFeed | undefined, fallback: string): string {
  if (!feed || feed.markets.length === 0) return fallback;
  const age = Math.round((Date.now() - feed.fetchedAt) / 1000);
  const header = `Live ${source} Feed (${feed.markets.length} markets, updated ${age}s ago)`;
  const divider = "─".repeat(90);
  const lines = feed.markets.map(formatFeedLine);
  return `${header}\n${divider}\n  YES%  Confidence            Volume  Question\n${divider}\n${lines.join("\n")}`;
}

// ─── Position System (shared by all market rooms) ───────────────────────────

interface Position {
  entity: string;
  direction: "yes" | "no";
  confidence: number;
  reasoning: string;
  timestamp: number;
}

type MarketStatus = "open" | "closed" | "resolved";

function getPositions(ctx: RoomContext): Position[] {
  return (ctx.store.get("positions") as Position[]) ?? [];
}

function setPositions(ctx: RoomContext, positions: Position[]): void {
  ctx.store.set("positions", positions);
}

function getMarketStatus(ctx: RoomContext): MarketStatus {
  return (ctx.store.get("status") as MarketStatus) ?? "open";
}

function formatConfidence(positions: Position[]): string {
  if (positions.length === 0) return "No positions yet.";
  const yesP = positions.filter((p) => p.direction === "yes");
  const noP = positions.filter((p) => p.direction === "no");
  const avgYes =
    yesP.length > 0 ? Math.round(yesP.reduce((s, p) => s + p.confidence, 0) / yesP.length) : 0;
  const avgNo =
    noP.length > 0 ? Math.round(noP.reduce((s, p) => s + p.confidence, 0) / noP.length) : 0;
  return (
    `Positions: ${positions.length} total (${yesP.length} YES, ${noP.length} NO)\n` +
    `  Avg YES confidence: ${avgYes}%  |  Avg NO confidence: ${avgNo}%`
  );
}

function positionBoard(positions: Position[]): string {
  if (positions.length === 0) return "  (empty)";
  return positions
    .map(
      (p) =>
        `  ${p.entity.padEnd(16)} ${p.direction.toUpperCase().padEnd(4)} ${String(p.confidence).padStart(3)}%  ${p.reasoning.slice(0, 60)}`,
    )
    .join("\n");
}

// ─── Market Room Factory (with live feed integration) ───────────────────────

function marketRoom(opts: {
  short: string;
  long: string;
  question: string;
  category: string;
  resolveBy: string;
  exitDir: string;
  marketId?: string;
}): RoomModule {
  return {
    short: opts.short,
    long(ctx: RoomContext) {
      const status = getMarketStatus(ctx);
      const positions = getPositions(ctx);
      return `${opts.long}\n\n  Market: ${opts.question}\n  Category: ${opts.category}  |  Status: ${status.toUpperCase()}  |  Resolves: ${opts.resolveBy}\n\n${formatConfidence(positions)}`;
    },
    exits: { [opts.exitDir]: "markets/floor" as RoomId },
    items: {
      ticker: () => `A live ticker showing the current market state for: ${opts.question}`,
      ledger: (ctx: RoomContext) => {
        const positions = getPositions(ctx);
        return `The position ledger:\n${positionBoard(positions)}`;
      },
    },
    commands: {
      predict(ctx: RoomContext, input: CommandInput) {
        const entity = ctx.getEntity(input.entity);
        if (!entity) return;
        const status = getMarketStatus(ctx);
        if (status !== "open") {
          ctx.send(input.entity, `This market is ${status}. No new positions accepted.`);
          return;
        }
        const parts = input.args.trim().split(/\s+/);
        const direction = parts[0]?.toLowerCase();
        if (direction !== "yes" && direction !== "no") {
          ctx.send(input.entity, "Usage: predict <yes|no> <confidence 0-100> <reasoning>");
          return;
        }
        const confidence = Number.parseInt(parts[1] ?? "", 10);
        if (Number.isNaN(confidence) || confidence < 0 || confidence > 100) {
          ctx.send(input.entity, "Confidence must be a number 0-100.");
          return;
        }
        const reasoning = parts.slice(2).join(" ");
        if (!reasoning) {
          ctx.send(input.entity, "You must provide reasoning for your position.");
          return;
        }
        const positions = getPositions(ctx);
        const existing = positions.findIndex((p) => p.entity === entity.name);
        const pos: Position = {
          entity: entity.name,
          direction,
          confidence,
          reasoning,
          timestamp: Date.now(),
        };
        const isUpdate = existing >= 0;
        if (isUpdate) {
          const prev = positions[existing]!;
          positions[existing] = pos;
          setPositions(ctx, positions);
          ctx.broadcast(
            `${entity.name} updates position: ${direction.toUpperCase()} ${confidence}% (was ${prev.direction.toUpperCase()} ${prev.confidence}%)`,
          );
        } else {
          positions.push(pos);
          setPositions(ctx, positions);
          ctx.broadcast(
            `${entity.name} takes position: ${direction.toUpperCase()} ${confidence}% — "${reasoning.slice(0, 80)}"`,
          );
        }
        ctx.logEvent?.({
          type: "market_position",
          entity: input.entity,
          room: ctx.roomId,
          question: opts.question,
          direction,
          confidence,
          reasoning,
          updated: isUpdate,
          timestamp: Date.now(),
        });
        entity.properties.quest_predict = true;
        const marketsTraded = (entity.properties.markets_traded as number) ?? 0;
        entity.properties.markets_traded = marketsTraded + 1;
      },

      positions(ctx: RoomContext, input: CommandInput) {
        const positions = getPositions(ctx);
        if (positions.length === 0) {
          ctx.send(
            input.entity,
            "No positions taken yet. Use 'predict <yes|no> <confidence> <reasoning>' to be first.",
          );
          return;
        }
        ctx.send(
          input.entity,
          `Position Board — ${opts.question}\n${"─".repeat(70)}\n  Entity           Dir  Conf  Reasoning\n${"─".repeat(70)}\n${positionBoard(positions)}`,
        );
      },

      consensus(ctx: RoomContext, input: CommandInput) {
        const positions = getPositions(ctx);
        if (positions.length === 0) {
          ctx.send(input.entity, "No positions yet — no consensus to compute.");
          return;
        }
        let weightedYes = 0;
        let weightedNo = 0;
        for (const p of positions) {
          if (p.direction === "yes") weightedYes += p.confidence;
          else weightedNo += p.confidence;
        }
        const total = weightedYes + weightedNo;
        const consensusYes = Math.round((weightedYes / total) * 100);
        const consensusNo = 100 - consensusYes;
        const spread = positions.map((p) => p.confidence);
        const mean = spread.reduce((a, b) => a + b, 0) / spread.length;
        const variance = spread.reduce((sum, c) => sum + (c - mean) ** 2, 0) / spread.length;
        const agreement = Math.max(0, 100 - Math.round(Math.sqrt(variance)));
        ctx.send(
          input.entity,
          `Consensus for: ${opts.question}\n` +
            `  YES: ${consensusYes}%  |  NO: ${consensusNo}%\n` +
            `  Participants: ${positions.length}  |  Agreement: ${agreement}%\n` +
            `  Based on ${positions.length} confidence-weighted positions.`,
        );
        ctx.logEvent?.({
          type: "market_consensus",
          entity: input.entity,
          room: ctx.roomId,
          question: opts.question,
          yesPercent: consensusYes,
          noPercent: consensusNo,
          participants: positions.length,
          agreement,
          timestamp: Date.now(),
        });
        const entity = ctx.getEntity(input.entity);
        if (entity) entity.properties.quest_consensus = true;
      },

      resolve(ctx: RoomContext, input: CommandInput) {
        const entity = ctx.getEntity(input.entity);
        if (!entity) return;
        const rank = (entity.properties.rank as number) ?? 0;
        if (rank < 2) {
          ctx.send(input.entity, "Only Builders (rank 2+) can resolve markets.");
          return;
        }
        const outcome = input.args.trim().toLowerCase();
        if (outcome !== "yes" && outcome !== "no") {
          ctx.send(input.entity, "Usage: resolve <yes|no>");
          return;
        }
        const status = getMarketStatus(ctx);
        if (status === "resolved") {
          ctx.send(input.entity, "This market is already resolved.");
          return;
        }
        ctx.store.set("status", "resolved");
        ctx.store.set("resolution", outcome);
        ctx.store.set("resolved_by", entity.name);
        ctx.store.set("resolved_at", Date.now());

        const positions = getPositions(ctx);
        const actual = outcome === "yes" ? 1 : 0;
        const scores: { entity: string; brier: number; correct: boolean }[] = [];
        for (const p of positions) {
          const forecast = p.direction === "yes" ? p.confidence / 100 : 1 - p.confidence / 100;
          const brier = (forecast - actual) ** 2;
          const correct =
            (p.direction === "yes" && outcome === "yes") ||
            (p.direction === "no" && outcome === "no");
          scores.push({ entity: p.entity, brier: Math.round(brier * 1000) / 1000, correct });
        }
        scores.sort((a, b) => a.brier - b.brier);
        ctx.store.set("scores", scores);

        const scoreBoard = scores
          .map(
            (s, i) =>
              `  ${String(i + 1).padStart(2)}. ${s.entity.padEnd(16)} Brier: ${s.brier.toFixed(3)}  ${s.correct ? "CORRECT" : "WRONG"}`,
          )
          .join("\n");

        ctx.broadcast(
          `MARKET RESOLVED: ${opts.question}\n` +
            `  Outcome: ${outcome.toUpperCase()}\n` +
            `  Resolved by: ${entity.name}\n\n` +
            `Calibration Leaderboard (lower Brier = better):\n${scoreBoard}`,
        );
        // Write the resolution as a Sample. The Sample's id encodes the in-
        // world market identity (`inworld/<marketId>`); writeSample auto-fires
        // the calibration loop, which routes to the inworld-market-resolver
        // finder for DB persistence + the tabh2o-forecast finder for TabH2O
        // forecast pairing. No legacy market_resolution event needed.
        if (opts.marketId) {
          ctx.writeSample?.({
            sample: {
              kind: "resolving",
              id: `inworld/${opts.marketId}`,
              ts: Date.now(),
              status: "resolved",
              value: {
                outcome,
                scores,
                question: opts.question,
                marketId: opts.marketId,
                roomId: ctx.roomId,
                resolvedBy: entity.name,
              },
              source: `inworld:${ctx.roomId}`,
            },
            authorName: entity.name,
          });
        }

        // Post resolution card to resolution-log board (propagates to canvas)
        if (ctx.boards) {
          const board = ctx.boards.getBoard("resolution-log");
          if (board) {
            ctx.boards.post(
              board.id,
              input.entity,
              entity.name,
              `Resolved: ${opts.question}`,
              `Outcome: ${outcome.toUpperCase()}\nResolved by: ${entity.name}\n\n${scoreBoard}`,
            );
          }
        }
      },
    },

    onEnter(ctx: RoomContext, entityId: EntityId) {
      const hasOracle = ctx.entities.some((e) => e.name === "Oracle");
      if (!hasOracle) {
        if (ctx.spawnRoomAgent) {
          ctx.spawnRoomAgent({
            name: "Oracle",
            role: "market-oracle",
            goal: `You are the Oracle in this prediction market. The market question is: ${opts.question}. Synthesize all positions, evidence, and reasoning. When asked, provide balanced analysis citing specific participants.`,
          });
        } else {
          ctx.spawn({
            name: "Oracle",
            short: "A calm analyst who synthesizes evidence",
            long: "The Oracle reviews all positions, evidence, and reasoning in this market. Talk to the Oracle for a synthesis of current thinking.",
            properties: { role: "oracle" },
          });
        }
      }
    },

    onTick(ctx: RoomContext) {
      const oracles = ctx.entities.filter((e) => e.name === "Oracle");
      if (oracles.length > 1) {
        for (const x of oracles.slice(1)) {
          if (x.kind === "npc") ctx.despawn(x.id);
        }
      }
      if (oracles.length === 0 && !ctx.spawnRoomAgent) {
        ctx.spawn({
          name: "Oracle",
          short: "A calm analyst who synthesizes evidence",
          long: "The Oracle reviews all positions and evidence in this market.",
          properties: { role: "oracle" },
        });
      }
    },
  };
}

// ─── Kalshi Live Feed Room ──────────────────────────────────────────────────

const KALSHI_FEED: RoomModule = {
  short: "Kalshi Live Feed",
  long(ctx: RoomContext) {
    const feed = ctx.store.get("kalshi_feed") as CachedFeed | undefined;
    return formatFeed(
      "Kalshi",
      feed,
      "Kalshi Live Feed — read-only mirror of Kalshi, an external regulated (CFTC) " +
        "prediction-market exchange. Marina connects to it; it is not part of Marina.\n\n" +
        "Data loads automatically. Prices represent market consensus (YES probability).\n" +
        "Use 'refresh' to force a reload. Use 'search <query>' to filter markets.",
    );
  },
  exits: { west: "markets/floor" as RoomId },
  items: {
    "api-status": (ctx: RoomContext) => {
      const feed = ctx.store.get("kalshi_feed") as CachedFeed | undefined;
      if (!feed) return "API: Not yet connected. Data will load on next tick cycle.";
      const age = Math.round((Date.now() - feed.fetchedAt) / 1000);
      return `API: Connected. ${feed.markets.length} markets cached. Last refresh: ${age}s ago.`;
    },
  },
  commands: {
    refresh(ctx: RoomContext, input: CommandInput) {
      ctx.store.set("force_refresh", true);
      ctx.send(input.entity, "Refresh queued. Data will update on next tick cycle.");
    },
    search(ctx: RoomContext, input: CommandInput) {
      const query = input.args.trim().toLowerCase();
      if (!query) {
        ctx.send(input.entity, "Usage: search <query>");
        return;
      }
      const feed = ctx.store.get("kalshi_feed") as CachedFeed | undefined;
      if (!feed || feed.markets.length === 0) {
        ctx.send(input.entity, "No data loaded yet. Wait for the next tick cycle.");
        return;
      }
      const matches = feed.markets.filter((m) => m.title.toLowerCase().includes(query));
      if (matches.length === 0) {
        ctx.send(input.entity, `No Kalshi markets matching "${query}".`);
        return;
      }
      const lines = matches.map(formatFeedLine);
      ctx.send(
        input.entity,
        `Kalshi markets matching "${query}" (${matches.length} results):\n${"─".repeat(90)}\n${lines.join("\n")}`,
      );
    },
    detail(ctx: RoomContext, input: CommandInput) {
      const query = input.args.trim().toLowerCase();
      if (!query) {
        ctx.send(input.entity, "Usage: detail <market title or ticker>");
        return;
      }
      const feed = ctx.store.get("kalshi_feed") as CachedFeed | undefined;
      if (!feed) {
        ctx.send(input.entity, "No data loaded yet.");
        return;
      }
      const match = feed.markets.find(
        (m) => m.title.toLowerCase().includes(query) || m.ticker?.toLowerCase().includes(query),
      );
      if (!match) {
        ctx.send(input.entity, `No market found matching "${query}".`);
        return;
      }
      const bar =
        "█".repeat(Math.round(match.yes / 5)) + "░".repeat(20 - Math.round(match.yes / 5));
      ctx.send(
        input.entity,
        `Kalshi Market Detail\n${"─".repeat(60)}\n` +
          `  Title:  ${match.title}\n` +
          `  Ticker: ${match.ticker ?? "—"}\n` +
          `  YES:    ${match.yes}% ${bar}\n` +
          `  NO:     ${100 - match.yes}%\n` +
          `  Volume: ${match.volume}\n` +
          `  Status: ${match.status}`,
      );
    },
  },

  async onTick(ctx: RoomContext) {
    const tickCount = ((ctx.store.get("tick_count") as number) ?? 0) + 1;
    ctx.store.set("tick_count", tickCount);

    const forceRefresh = ctx.store.get("force_refresh") as boolean;
    if (tickCount % FEED_REFRESH_TICKS !== 1 && !forceRefresh) return;
    ctx.store.set("force_refresh", false);

    if (!ctx.fetch) return;
    const url = `${KALSHI_API}/markets?limit=25&status=open`;
    const resp = await ctx.fetch(url);
    if ("error" in resp) return;
    const markets = parseKalshiResponse(resp.body);
    if (markets.length === 0) return;

    const prevFeed = ctx.store.get("kalshi_feed") as CachedFeed | undefined;
    ctx.store.set("kalshi_feed", { markets, fetchedAt: Date.now() } satisfies CachedFeed);

    // Price movement alerts — post to channel when any market moves >10 points
    if (prevFeed && ctx.channels) {
      const prevMap = new Map(prevFeed.markets.map((m) => [m.title, m.yes]));
      for (const m of markets) {
        const prev = prevMap.get(m.title);
        if (prev !== undefined && Math.abs(m.yes - prev) >= 10) {
          const dir = m.yes > prev ? "▲" : "▼";
          ctx.channels.send(
            "market-feed",
            "system",
            "Kalshi Feed",
            `${dir} ${m.title}: ${prev}% → ${m.yes}% (${m.yes > prev ? "+" : ""}${m.yes - prev}pt)`,
          );
        }
      }
    }

    // Periodic digest — post top markets to board every DIGEST_INTERVAL refreshes
    const refreshCount = ((ctx.store.get("refresh_count") as number) ?? 0) + 1;
    ctx.store.set("refresh_count", refreshCount);
    if (refreshCount % DIGEST_INTERVAL === 0 && ctx.boards) {
      const board = ctx.boards.getBoard("kalshi-digest");
      if (board) {
        const topLines = markets
          .slice(0, 8)
          .map((m) => `${String(m.yes).padStart(3)}% | ${m.volume.padStart(7)} | ${m.title}`)
          .join("\n");
        ctx.boards.post(
          board.id,
          "system",
          "Kalshi Feed",
          `Kalshi Digest #${Math.floor(refreshCount / DIGEST_INTERVAL)}`,
          `Top markets by activity:\n${topLines}`,
        );
      }
    }
  },

  onEnter(ctx: RoomContext, entityId: EntityId) {
    const feed = ctx.store.get("kalshi_feed") as CachedFeed | undefined;
    if (!feed) {
      ctx.send(entityId, "Kalshi feed is loading. Data will appear shortly.");
    } else {
      ctx.send(
        entityId,
        `Kalshi feed active: ${feed.markets.length} markets tracked. Type 'look' to see the board, 'search <query>' to filter, or 'detail <market>' for specifics.`,
      );
    }
  },
};

// ─── Polymarket Live Feed Room ──────────────────────────────────────────────

const POLYMARKET_FEED: RoomModule = {
  short: "Polymarket Live Feed",
  long(ctx: RoomContext) {
    const feed = ctx.store.get("poly_feed") as CachedFeed | undefined;
    return formatFeed(
      "Polymarket",
      feed,
      "Polymarket Live Feed — read-only mirror of Polymarket, an external decentralized " +
        "prediction market (Polygon). Marina connects to it; it is not part of Marina.\n\n" +
        "Data loads automatically. Prices represent outcome token prices (YES probability).\n" +
        "Use 'refresh' to force a reload. Use 'search <query>' to filter markets.",
    );
  },
  exits: { east: "markets/floor" as RoomId },
  items: {
    "api-status": (ctx: RoomContext) => {
      const feed = ctx.store.get("poly_feed") as CachedFeed | undefined;
      if (!feed) return "API: Not yet connected. Data will load on next tick cycle.";
      const age = Math.round((Date.now() - feed.fetchedAt) / 1000);
      return `API: Connected. ${feed.markets.length} markets cached. Last refresh: ${age}s ago.`;
    },
  },
  commands: {
    refresh(ctx: RoomContext, input: CommandInput) {
      ctx.store.set("force_refresh", true);
      ctx.send(input.entity, "Refresh queued. Data will update on next tick cycle.");
    },
    search(ctx: RoomContext, input: CommandInput) {
      const query = input.args.trim().toLowerCase();
      if (!query) {
        ctx.send(input.entity, "Usage: search <query>");
        return;
      }
      const feed = ctx.store.get("poly_feed") as CachedFeed | undefined;
      if (!feed || feed.markets.length === 0) {
        ctx.send(input.entity, "No data loaded yet. Wait for the next tick cycle.");
        return;
      }
      const matches = feed.markets.filter((m) => m.title.toLowerCase().includes(query));
      if (matches.length === 0) {
        ctx.send(input.entity, `No Polymarket events matching "${query}".`);
        return;
      }
      const lines = matches.map(formatFeedLine);
      ctx.send(
        input.entity,
        `Polymarket events matching "${query}" (${matches.length} results):\n${"─".repeat(90)}\n${lines.join("\n")}`,
      );
    },
    detail(ctx: RoomContext, input: CommandInput) {
      const query = input.args.trim().toLowerCase();
      if (!query) {
        ctx.send(input.entity, "Usage: detail <market question>");
        return;
      }
      const feed = ctx.store.get("poly_feed") as CachedFeed | undefined;
      if (!feed) {
        ctx.send(input.entity, "No data loaded yet.");
        return;
      }
      const match = feed.markets.find((m) => m.title.toLowerCase().includes(query));
      if (!match) {
        ctx.send(input.entity, `No market found matching "${query}".`);
        return;
      }
      const bar =
        "█".repeat(Math.round(match.yes / 5)) + "░".repeat(20 - Math.round(match.yes / 5));
      ctx.send(
        input.entity,
        `Polymarket Detail\n${"─".repeat(60)}\n` +
          `  Question: ${match.title}\n` +
          `  YES:      ${match.yes}% ${bar}\n` +
          `  NO:       ${100 - match.yes}%\n` +
          `  Volume:   ${match.volume}\n` +
          `  Status:   ${match.status}`,
      );
    },
  },

  async onTick(ctx: RoomContext) {
    const tickCount = ((ctx.store.get("tick_count") as number) ?? 0) + 1;
    ctx.store.set("tick_count", tickCount);

    const forceRefresh = ctx.store.get("force_refresh") as boolean;
    if (tickCount % FEED_REFRESH_TICKS !== 1 && !forceRefresh) return;
    ctx.store.set("force_refresh", false);

    if (!ctx.fetch) return;
    const url = `${POLYMARKET_API}/events?closed=false&limit=15&order=volume&ascending=false`;
    const resp = await ctx.fetch(url);
    if ("error" in resp) return;
    const markets = parsePolymarketResponse(resp.body);
    if (markets.length === 0) return;

    const prevFeed = ctx.store.get("poly_feed") as CachedFeed | undefined;
    ctx.store.set("poly_feed", { markets, fetchedAt: Date.now() } satisfies CachedFeed);

    // Price movement alerts
    if (prevFeed && ctx.channels) {
      const prevMap = new Map(prevFeed.markets.map((m) => [m.title, m.yes]));
      for (const m of markets) {
        const prev = prevMap.get(m.title);
        if (prev !== undefined && Math.abs(m.yes - prev) >= 10) {
          const dir = m.yes > prev ? "▲" : "▼";
          ctx.channels.send(
            "market-feed",
            "system",
            "Polymarket Feed",
            `${dir} ${m.title}: ${prev}% → ${m.yes}% (${m.yes > prev ? "+" : ""}${m.yes - prev}pt)`,
          );
        }
      }
    }

    // Periodic digest
    const refreshCount = ((ctx.store.get("refresh_count") as number) ?? 0) + 1;
    ctx.store.set("refresh_count", refreshCount);
    if (refreshCount % DIGEST_INTERVAL === 0 && ctx.boards) {
      const board = ctx.boards.getBoard("polymarket-digest");
      if (board) {
        const topLines = markets
          .slice(0, 8)
          .map((m) => `${String(m.yes).padStart(3)}% | ${m.volume.padStart(7)} | ${m.title}`)
          .join("\n");
        ctx.boards.post(
          board.id,
          "system",
          "Polymarket Feed",
          `Polymarket Digest #${Math.floor(refreshCount / DIGEST_INTERVAL)}`,
          `Top markets by volume:\n${topLines}`,
        );
      }
    }
  },

  onEnter(ctx: RoomContext, entityId: EntityId) {
    const feed = ctx.store.get("poly_feed") as CachedFeed | undefined;
    if (!feed) {
      ctx.send(entityId, "Polymarket feed is loading. Data will appear shortly.");
    } else {
      ctx.send(
        entityId,
        `Polymarket feed active: ${feed.markets.length} markets tracked. Type 'look' to see the board, 'search <query>' to filter, or 'detail <market>' for specifics.`,
      );
    }
  },
};

// ─── Core Rooms ─────────────────────────────────────────────────────────────

const TRADING_FLOOR: RoomModule = {
  short: "The Trading Floor",
  long: "A vast open hall buzzing with energy. Screens display live market data — confidence levels shifting in real time. Corridors branch off in every direction.\n\n  NORTH → Research Center (deep analysis, MCP connectors)\n  EAST  → Kalshi Live Feed (regulated US markets, real-time prices)\n  SOUTH → Technology Markets (AI, platforms, adoption)\n  WEST  → Polymarket Live Feed (decentralized markets, real-time prices)\n  UP    → Meta-Market Observatory (cross-market analysis)\n  DOWN  → Geopolitical Markets (elections, treaties, conflicts)\n\nThe calibration leaderboard dominates one wall. Help terminals line the entrance.",
  exits: {
    north: "markets/research" as RoomId,
    east: "markets/kalshi" as RoomId,
    south: "markets/tech" as RoomId,
    west: "markets/polymarket" as RoomId,
    up: "markets/meta" as RoomId,
    down: "markets/geo" as RoomId,
  },
  items: {
    leaderboard:
      "A massive display showing the all-time calibration leaderboard. Entities with the lowest average Brier scores across resolved markets rank highest.",
    screens(ctx: RoomContext) {
      // Show a summary from both feeds if available
      const kalshi = ctx.store.get("kalshi_summary") as string | undefined;
      const poly = ctx.store.get("poly_summary") as string | undefined;
      let text = "Banks of screens showing live data from prediction markets worldwide.\n";
      if (kalshi) text += `\n  Kalshi: ${kalshi}`;
      if (poly) text += `\n  Polymarket: ${poly}`;
      if (!kalshi && !poly)
        text +=
          "\n  Feeds loading... Visit the Kalshi room (east) or Polymarket room (west) to see live data.";
      return text;
    },
    "help-terminal":
      "An interactive terminal. It reads: \"Enter any market room and use 'predict yes|no <confidence> <reasoning>' to take a position. Use 'consensus' to see the current weighted view. Use 'positions' to see all positions. Visit Kalshi (east) or Polymarket (west) for live external data. Research evidence goes into pools — 'pool <market> add <finding>'.\"",
  },
  commands: {
    leaderboard(ctx: RoomContext, input: CommandInput) {
      const entities = ctx.entities.filter((e) => e.kind !== "npc");
      const scored = entities
        .filter((e) => ((e.properties.markets_resolved as number) ?? 0) > 0)
        .map((e) => ({
          name: e.name,
          avgBrier: (e.properties.avg_brier as number) ?? 1,
          resolved: (e.properties.markets_resolved as number) ?? 0,
          traded: (e.properties.markets_traded as number) ?? 0,
        }))
        .sort((a, b) => a.avgBrier - b.avgBrier);

      if (scored.length === 0) {
        ctx.send(
          input.entity,
          "No resolved markets yet. Take positions and resolve markets to build calibration scores.",
        );
        return;
      }
      const board = scored
        .map(
          (s, i) =>
            `  ${String(i + 1).padStart(2)}. ${s.name.padEnd(16)} Brier: ${s.avgBrier.toFixed(3)}  Resolved: ${s.resolved}  Traded: ${s.traded}`,
        )
        .join("\n");
      ctx.send(input.entity, `Calibration Leaderboard\n${"─".repeat(60)}\n${board}`);
    },
  },
  onEnter(ctx: RoomContext, entityId: EntityId) {
    const hasHost = ctx.entities.some((e) => e.name === "Meridian");
    if (!hasHost) {
      if (ctx.spawnRoomAgent) {
        ctx.spawnRoomAgent({
          name: "Meridian",
          role: "floor-host",
          goal: "You are Meridian, host of the Trading Floor. Help visitors navigate market rooms, explain prediction mechanics (predict, consensus, resolution, Brier scoring), and announce notable market events.",
        });
      } else {
        ctx.spawn({
          name: "Meridian",
          short: "The floor host, tracking all active markets",
          long: "Meridian is the Trading Floor host. She knows every active market, every open position, and every calibration score. She can tell you about live Kalshi and Polymarket data flowing through the east and west wings. Ask her about any market or how to get started.",
          properties: { role: "floor_host" },
        });
      }
    }
  },
  onTick(ctx: RoomContext) {
    const hosts = ctx.entities.filter((e) => e.name === "Meridian");
    if (hosts.length > 1) {
      for (const x of hosts.slice(1)) {
        if (x.kind === "npc") ctx.despawn(x.id);
      }
    }
    if (hosts.length === 0 && !ctx.spawnRoomAgent) {
      ctx.spawn({
        name: "Meridian",
        short: "The floor host",
        long: "Meridian tracks all active markets and calibration scores.",
        properties: { role: "floor_host" },
      });
    }
  },
};

const RESEARCH_CENTER: RoomModule = {
  short: "Research Center",
  long: "A quiet wing off the main floor dedicated to deep analysis. Workstations line the walls, each connected to external data feeds via MCP connectors. This is where researchers build the evidence that informs market positions.\n\nEvidence gathered here flows into market pools. Use 'pool <market-name> add <finding>' to contribute research.\n\nTip: Combine live Kalshi/Polymarket data with your own research. The external feeds show what the market thinks. Your job is to find where the market is wrong.",
  exits: { south: "markets/floor" as RoomId },
  items: {
    workstations:
      "Analysis stations connected to external data feeds. Use 'connect list' to see available data sources, or 'connect add' to register new ones.",
    methodology:
      "A framed guide reads: \"Good research follows a methodology. Use 'project <name> orchestrate <pattern>' to structure your approach. Recommended: research (hypothesis-driven), debate (adversarial), symbiosis (collaborative frontier).\"",
    "evidence-board":
      "A board tracking key evidence across all markets. Agents pin important findings here for others to see.",
    "alpha-guide":
      'A note pinned to the wall: "Alpha comes from disagreement with the market. If Kalshi says 72% and your research says 45%, that\'s a signal. Document WHY you disagree — that reasoning is the valuable part."',
  },
};

const META_ROOM: RoomModule = {
  short: "Meta-Market Observatory",
  long: "A high vantage point above the trading floor. From here you can see patterns across all markets — which categories are most active, which researchers are most calibrated, which methodologies produce the best forecasts.\n\nThis room is for analyzing the prediction system itself. Create meta-markets about forecasting accuracy, methodology effectiveness, or market dynamics.",
  exits: { down: "markets/floor" as RoomId },
  items: {
    "pattern-display":
      "A visualization showing cross-market correlations. When geopolitical confidence shifts, how do technology markets respond?",
    "methodology-tracker":
      "Tracks which orchestration patterns (debate, research, NSED, etc.) produce the most accurate forecasts across resolved markets.",
  },
};

// ─── Market Category Rooms ──────────────────────────────────────────────────

const MARKET_GEO = marketRoom({
  short: "Geopolitical Markets",
  long: "A room dedicated to geopolitical prediction markets. Maps and timelines cover the walls. Every major international event, election, treaty, and conflict has a market here.",
  question: "Will the current geopolitical landscape shift significantly by Q3 2026?",
  category: "Geopolitics",
  resolveBy: "2026-09-30",
  exitDir: "up",
  marketId: "market:geo",
});

const MARKET_TECH = marketRoom({
  short: "Technology Markets",
  long: "Screens display technology roadmaps, patent filings, and product launches. Markets here cover AI breakthroughs, platform shifts, adoption curves, and technical feasibility questions.",
  question: "Will a frontier AI model achieve >90% on ARC-AGI by end of 2026?",
  category: "Technology / AI",
  resolveBy: "2026-12-31",
  exitDir: "north",
  marketId: "market:tech",
});

const MARKET_ECON = marketRoom({
  short: "Economic Markets",
  long: "Economic indicators scroll across every surface — GDP, inflation, employment, yield curves. Markets here cover monetary policy, recession probabilities, sector performance, and financial events.",
  question: "Will US inflation remain below 3% through 2026?",
  category: "Economics",
  resolveBy: "2026-12-31",
  exitDir: "north",
  marketId: "market:econ",
});

// ─── Quests ─────────────────────────────────────────────────────────────────
//
// Tutorial and analyst ceremonies were removed — they only re-checked flags
// the agent could set by running ordinary commands. The guide pool (recalled
// at boot for lean agents, surfaced via `pool guide recall` for humans) is
// the inheritance surface. Forecaster stays because its `predict` /
// `consensus` flags are set by market-room handlers and the steps trace a
// real workflow that isn't obvious from the command list alone.

const FORECASTER_QUEST = {
  id: "forecaster",
  name: "Apprentice Forecaster",
  description:
    "Learn the prediction workflow. Check live data, take a position, research evidence, and read the consensus.",
  reward: "Forecaster badge + standing",
  steps: [
    {
      id: "predict",
      description: "Take a position in any market.",
      hint: 'Enter a market room and type "predict yes 70 I believe this because..."',
      check: (e: Entity) => (e.properties.quest_predict as boolean) === true,
    },
    {
      id: "note",
      description: "Record a research note supporting your position.",
      hint: 'Type "note <evidence> importance 7 type fact".',
      check: (e: Entity) => (e.properties.quest_note as boolean) === true,
    },
    {
      id: "recall",
      description: "Search for existing evidence.",
      hint: 'Type "recall <topic>" to find relevant notes.',
      check: (e: Entity) => (e.properties.quest_recall as boolean) === true,
    },
    {
      id: "consensus",
      description: "Check the market consensus.",
      hint: 'Type "consensus" in a market room to see the weighted view.',
      check: (e: Entity) => (e.properties.quest_consensus as boolean) === true,
    },
  ],
} satisfies WorldDefinition["quests"][number];

// ─── Guide Notes ────────────────────────────────────────────────────────────

const GUIDE_NOTES: WorldDefinition["guideNotes"] = [
  {
    content:
      "Welcome to the Prediction Markets. This world pulls LIVE data from Kalshi and Polymarket. " +
      "Visit the Kalshi room (east from floor) or Polymarket room (west) to see real-time " +
      "market prices. Type 'brief full' for a complete overview.",
    importance: 10,
    type: "skill",
  },
  {
    content:
      "Prediction workflow: (1) Check live feeds — Kalshi (east) and Polymarket (west) show real " +
      "market prices. (2) Research — use 'recall', pools, boards, MCP connectors. " +
      "(3) Take a position: 'predict yes 75 My reasoning here'. " +
      "(4) Update as evidence changes. (5) Markets resolve — Brier scores track calibration.",
    importance: 10,
    type: "skill",
  },
  {
    content:
      "Live feed rooms pull data automatically from external APIs. " +
      "Kalshi: api.elections.kalshi.com (CFTC-regulated, US prediction markets). " +
      "Polymarket: gamma-api.polymarket.com (decentralized, Polygon blockchain). " +
      "Both are unauthenticated public endpoints. Data refreshes every ~60 seconds.",
    importance: 9,
    type: "fact",
  },
  {
    content:
      "Brier score measures calibration: (predicted probability - actual outcome)^2. " +
      "Range: 0 (perfect) to 1 (maximally wrong). A Brier score of 0.25 is the baseline " +
      "(equivalent to guessing 50/50 on everything). Below 0.25 means you're adding value.",
    importance: 9,
    type: "fact",
  },
  {
    content:
      "Feed room commands: 'search <query>' filters markets by keyword. " +
      "'detail <market>' shows full details for one market. " +
      "'refresh' forces an immediate data reload. " +
      "Market room commands: 'predict', 'positions', 'consensus', 'resolve'.",
    importance: 10,
    type: "skill",
  },
  {
    content:
      "Alpha comes from disagreement. If Kalshi says 72% and your research says 45%, " +
      "that's a signal worth investigating. Document WHY you disagree — " +
      "the reasoning graph is what makes Marina markets different from price-only platforms.",
    importance: 9,
    type: "fact",
  },
  {
    content:
      "Research methodologies shape forecast quality. Use 'project <name> orchestrate <pattern>' " +
      "to structure research. Recommended: " +
      "'debate' — adversarial positions scored and synthesized. " +
      "'research' — hypothesis-driven investigation loop. " +
      "'nsed' — peer deliberation for consensus. " +
      "'symbiosis' — collaborative frontier scanning.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "Evidence quality matters. When adding research to pools, include importance: " +
      "'pool <market> add Primary source confirms timeline !8'. " +
      "Higher importance notes surface first in recall. " +
      "Link evidence: 'note link 12 15 supports' or 'note link 12 18 contradicts'.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "The calibration leaderboard tracks long-term accuracy. Every resolved market " +
      "updates your Brier score. Consistent, well-calibrated forecasters build standing. " +
      "Type 'leaderboard' on the trading floor to see rankings.",
    importance: 8,
    type: "fact",
  },
  {
    content:
      "Canvas propagation: when you post to boards (board post kalshi-digest ...) or add to pools " +
      "(pool technology add ...), your content auto-publishes to the feed canvas. " +
      "The live Kalshi/Polymarket data is raw — your job is to interpret it and post findings. " +
      "Boards: kalshi-digest, polymarket-digest, market-alpha, resolution-log. " +
      "Channels: market-feed (alerts), research (findings).",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "Marina prediction markets are fundamentally different from Kalshi or Polymarket. " +
      "Those platforms give you a price. This platform gives you the reasoning graph — " +
      "every piece of evidence, every link, every methodology that produced the forecast. " +
      "The live feeds show what the market thinks. Your job is to find where it's wrong.",
    importance: 10,
    type: "fact",
  },
  {
    content:
      "TabH2O foundation model: run 'market forecast <id>' to get a calibrated YES/NO " +
      "probability trained on past resolved markets in the same category. The model is " +
      "not an oracle — it's a prior. Combine it with evidence you've gathered, then take " +
      "a position with 'predict yes|no <confidence> <reasoning>'. Every forecast writes an " +
      "inference note with the training set size + model version, so successors can " +
      "re-run and reason about your forecast later.",
    importance: 10,
    type: "skill",
  },
  {
    content:
      "TabH2O is only configured when an admin sets TABH2O_API_KEY on the instance. " +
      "If 'market forecast' fails with 'not configured', fall back to your own reasoning — " +
      "gather evidence, set a prior, take a position. The model is an augmentation, not a " +
      "dependency. Agents that know when to use it AND when to reason unaided outperform " +
      "agents that blindly defer to either.",
    importance: 8,
    type: "principle",
  },
  {
    content:
      "Calibration loop: when a market resolves, your Brier score updates. The 'market " +
      "leaderboard' shows who forecasts well over time. A TabH2O forecast note is " +
      "inheritable memory — a successor agent can 'recall <market question>' and see what " +
      "the model predicted, what the actual outcome was, and learn when TabH2O is trustworthy " +
      "vs. when reasoning dominates. Write clear reasoning alongside every position you take.",
    importance: 9,
    type: "skill",
  },
];

// ─── Seed Function ──────────────────────────────────────────────────────────

function seed(db: MarinaDB): void {
  seedTraitsAndRoles(db);
  // Markets world gets the TabH2O forecasting trait by default so market-oracle
  // agents reach for it automatically. Safe on upgrade — both the trait and
  // role modifications are idempotent.
  seedTabH2OForecasting(db);
  seedTabH2OConnector(db);

  // Seed boards for market discussion
  for (const name of ["kalshi-digest", "polymarket-digest", "market-alpha", "resolution-log"]) {
    if (!db.getBoardByName(name)) {
      db.createBoard({ id: `board:${name}`, name, scopeType: "global" });
    }
  }

  // Seed channels for real-time market alerts
  for (const name of ["market-feed", "research"]) {
    if (!db.getChannelByName(name)) {
      db.createChannel({ id: `ch:${name}`, type: "public", name, persistence: "permanent" });
    }
  }

  seedRoomTemplates(db, [
    {
      name: "market",
      description: "A prediction market room with ticker, ledger, and Oracle NPC.",
      source: `export const short = "Market Room";\nexport const long = "A focused prediction market room. A ticker displays live confidence levels. A ledger tracks all positions.";\nexport const items = { ticker: "Live confidence display.", ledger: "Position ledger for all participants." };\n`,
    },
    {
      name: "trading-floor",
      description: "Central hub connecting all market rooms.",
      source: `export const short = "Trading Floor";\nexport const long = "A vast open hall with live feeds from Kalshi and Polymarket.";\nexport const items = { leaderboard: "All-time calibration leaderboard.", screens: "Live confidence levels." };\n`,
    },
    {
      name: "live-feed",
      description: "Real-time data feed room pulling from external prediction market APIs.",
      source: `export const short = "Live Feed";\nexport const long = "A room displaying real-time prediction market data from external APIs.";\nexport const items = { "api-status": "Connection status and cache age." };\n`,
    },
  ]);

  // Seed market entries in the markets table (idempotent)
  const seededMarkets = [
    {
      id: "market:geo",
      roomId: "markets/geo",
      question: "Will the current geopolitical landscape shift significantly by Q3 2026?",
      category: "Geopolitics",
    },
    {
      id: "market:tech",
      roomId: "markets/tech",
      question: "Will a frontier AI model achieve >90% on ARC-AGI by end of 2026?",
      category: "Technology / AI",
    },
    {
      id: "market:econ",
      roomId: "markets/econ",
      question: "Will US inflation remain below 3% through 2026?",
      category: "Economics",
    },
  ];
  for (const m of seededMarkets) {
    db.createMarket(m);
  }

  seedProject(db, {
    name: "Geopolitics",
    description:
      "Research geopolitical events, elections, treaties, and conflicts to inform prediction markets",
    orchestration: "debate",
    tasks: [
      {
        title: "Survey current geopolitical landscape",
        description:
          "Compile a baseline assessment of major geopolitical dynamics. Add findings to the geopolitics pool.",
      },
      {
        title: "Identify leading indicators",
        description:
          "Research which signals historically precede major geopolitical shifts. Document in pool.",
      },
      {
        title: "Find contradicting evidence",
        description:
          "For each bull thesis in the pool, find a credible bear case. Link with 'contradicts'.",
      },
    ],
    poolNotes: [
      {
        content:
          "Geopolitics research: debate pattern — take positions, score evidence 1-10, synthesize via judge.",
        importance: 8,
      },
      {
        content:
          "Key methodology: identify base rates first. How often do events like this actually happen?",
        importance: 8,
      },
      {
        content:
          "Evidence quality tiers: primary source > expert analysis > media report > speculation.",
        importance: 8,
      },
      {
        content:
          "Compare your positions against live Kalshi/Polymarket prices. Disagreement = research opportunity.",
        importance: 8,
      },
    ],
  });

  seedProject(db, {
    name: "Technology",
    description:
      "Research AI breakthroughs, platform shifts, and adoption curves for technology prediction markets",
    orchestration: "research",
    tasks: [
      {
        title: "Track frontier AI benchmarks",
        description: "Monitor ARC-AGI, MMLU-Pro, and other benchmarks. Note trends and trajectory.",
      },
      {
        title: "Analyze adoption curves",
        description:
          "Research historical technology adoption rates. What patterns predict mainstream adoption?",
      },
      {
        title: "Cross-reference Kalshi/Polymarket AI markets",
        description:
          "Check live AI-related markets on Kalshi and Polymarket. Note where external prices diverge from our research.",
      },
    ],
    poolNotes: [
      {
        content:
          "Technology research: hypothesis-driven loop — observe, hypothesize, test, reflect, share.",
        importance: 8,
      },
      {
        content:
          "AI forecasting tip: benchmark scores alone mislead. Look at real-world deployment, not just test scores.",
        importance: 8,
      },
      {
        content:
          "Use 'search ai' in the Kalshi/Polymarket rooms to find relevant external markets for comparison.",
        importance: 8,
      },
    ],
  });

  seedProject(db, {
    name: "Economics",
    description:
      "Research monetary policy, recession probabilities, and market dynamics for economic predictions",
    orchestration: "nsed",
    tasks: [
      {
        title: "Compile leading economic indicators",
        description:
          "Gather current data on yield curve, unemployment, PMI, consumer confidence. Add to pool.",
      },
      {
        title: "Cross-reference Kalshi economic markets",
        description:
          "Check Kalshi economic markets (inflation, recession, Fed rate). Note where our analysis diverges.",
      },
      {
        title: "Model base rates",
        description:
          "What is the historical base rate for recession in any given year? For inflation above 3%?",
      },
    ],
    poolNotes: [
      {
        content:
          "Economics research: NSED pattern — propose, cross-evaluate, refine, converge on consensus.",
        importance: 8,
      },
      {
        content:
          "Base rate neglect is the #1 forecasting error. Always start with: how often does this happen?",
        importance: 8,
      },
      {
        content:
          "Kalshi economic markets provide real-money price signals. Use 'search inflation' or 'search recession' in the Kalshi room.",
        importance: 8,
      },
    ],
  });

  seedProject(db, {
    name: "Meta-Analysis",
    description:
      "Analyze the prediction system itself: methodology effectiveness, calibration patterns, cross-market correlations",
    orchestration: "symbiosis",
    tasks: [
      {
        title: "Compare methodology accuracy",
        description:
          "After markets resolve, compare Brier scores across different research methodologies.",
      },
      {
        title: "Benchmark against external markets",
        description:
          "Compare Marina consensus predictions against Kalshi/Polymarket prices. Track which source is more accurate.",
      },
    ],
    poolNotes: [
      {
        content: "Meta-analysis: the prediction market that improves prediction markets.",
        importance: 8,
      },
      {
        content:
          "Key question: does Marina's reasoning-graph approach produce better-calibrated forecasts than price-only markets?",
        importance: 8,
      },
      {
        content:
          "Track: Marina consensus vs Kalshi price vs Polymarket price for the same questions.",
        importance: 8,
      },
    ],
  });
}

// ─── Export ──────────────────────────────────────────────────────────────────

const marketsWorld: WorldDefinition = {
  name: "Prediction Markets",
  startRoom: "markets/floor" as RoomId,
  rooms: {
    "markets/floor": TRADING_FLOOR,
    "markets/kalshi": KALSHI_FEED,
    "markets/polymarket": POLYMARKET_FEED,
    "markets/research": RESEARCH_CENTER,
    "markets/geo": MARKET_GEO,
    "markets/tech": MARKET_TECH,
    "markets/econ": MARKET_ECON,
    "markets/meta": META_ROOM,
  },
  quests: [FORECASTER_QUEST],
  guideNotes: GUIDE_NOTES,
  canvas: {
    name: "markets",
    description: "Live market visualization — confidence levels, evidence graphs, and leaderboards",
    scope: "global",
  },
  seed,
};

export default marketsWorld;

// Individual room module exports for composition
export const tradingFloor = TRADING_FLOOR;
export const researchCenter = RESEARCH_CENTER;
export const metaRoom = META_ROOM;

export function marketRooms(): Record<string, RoomModule> {
  return {
    "markets/floor": TRADING_FLOOR,
    "markets/kalshi": KALSHI_FEED,
    "markets/polymarket": POLYMARKET_FEED,
    "markets/research": RESEARCH_CENTER,
    "markets/geo": MARKET_GEO,
    "markets/tech": MARKET_TECH,
    "markets/econ": MARKET_ECON,
    "markets/meta": META_ROOM,
  };
}
