// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { experimentalHelp } from "../../config/feature-status";
import { bold, dim, status as fmtStatus, header, separator } from "../../net/ansi";
import * as kalshi from "../../net/clients/kalshi-client";
import * as polymarket from "../../net/clients/polymarket-client";
import { isTabH2OConfigured, type TabH2ORow, tabh2oPredict } from "../../net/clients/tabh2o-client";
import type { MarinaDB, MarketRow } from "../../persistence/database";
import type { CommandDef, EngineEvent, Entity, RoomContext } from "../../types";
import { refuseCommand } from "../command-response";
import { canonicalSub, unknownSubcommand } from "../parse-input";
import { parseDuration } from "./format-duration";

const HELP =
  "Prediction market discovery and leaderboards.\nUsage: market list [open|resolved] | market search <query> | market show <id> (also view/info) | market live <venue> [duration] [limit] | market leaderboard | market score [entity] | market forecast <id>\n\nExamples:\n  market list\n  market list resolved\n  market search inflation\n  market show market:tech\n  market live kalshi 7d 25\n  market live polymarket 1mo\n  market leaderboard\n  market score Alice\n  market forecast market:tech";

const MARKET_SUBS = ["list", "search", "live", "show", "leaderboard", "lb", "score", "forecast"];

/**
 * Parse a market-window duration into milliseconds. Voice-friendly: "7d",
 * "24h", "1w", "1mo", "30d". Returns 0 if unparseable.
 *
 * Shares the platform duration grammar (`parseDuration`: `m` = minutes,
 * `mo` = months) but a live-market window is day-scale, so sub-hour units are
 * rejected — `1m` is refused rather than silently read as one minute, which
 * is the behaviour this command has always documented.
 */
export function parseDurationMs(s: string): number {
  return parseDuration(s, { minUnit: "h" }) ?? 0;
}

const DEFAULT_LIVE_LIMIT = 25;
const DEFAULT_LIVE_WINDOW_MS = 30 * 86_400_000; // 30 days

export function marketCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  db: MarinaDB;
  logEvent?: (event: EngineEvent) => void;
}): CommandDef {
  const { db } = deps;
  return {
    category: "Markets & Forecasting",
    usage: [
      { syntax: "market forecast <id>", effect: "write" },
      { syntax: "market leaderboard", effect: "read" },
      { syntax: "market list", effect: "read" },
      { syntax: "market list open", effect: "read" },
      { syntax: "market list resolved", effect: "read" },
      { syntax: "market live <kalshi|polymarket> [duration] [limit]", effect: "read" },
      { syntax: "market live <venue> [duration] [limit]", effect: "read" },
      { syntax: "market score [entity]", effect: "read" },
      { syntax: "market search <query>", effect: "read" },
      { syntax: "market show <id>", effect: "read" },
    ],
    name: "market",
    aliases: ["mk"],
    help: experimentalHelp(HELP),
    handler: async (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const tokens = input.tokens;
      const sub = canonicalSub(tokens[0], MARKET_SUBS) ?? "list";

      switch (sub) {
        case "list": {
          const filter = tokens[1]?.toLowerCase();
          const markets = db.listMarkets(
            filter === "open" || filter === "resolved" || filter === "closed"
              ? { status: filter }
              : undefined,
          );
          if (markets.length === 0) {
            ctx.send(input.entity, "No markets found.");
            return;
          }
          const lines = markets.map((m) => {
            const positions = db.getMarketPositions(m.id);
            const st =
              m.status === "open"
                ? fmtStatus("OPEN", "active")
                : m.status === "resolved"
                  ? fmtStatus(`RESOLVED: ${(m.outcome ?? "?").toUpperCase()}`, "done")
                  : fmtStatus("CLOSED", "warn");
            let consensus = "";
            if (positions.length > 0) {
              const yesW = positions
                .filter((p) => p.direction === "yes")
                .reduce((s, p) => s + p.confidence, 0);
              const noW = positions
                .filter((p) => p.direction === "no")
                .reduce((s, p) => s + p.confidence, 0);
              const total = yesW + noW;
              if (total > 0) consensus = ` YES:${Math.round((yesW / total) * 100)}%`;
            }
            return `  ${bold(m.id.padEnd(14))} ${st}  ${dim(`${positions.length} pos${consensus}`)}  ${m.question.slice(0, 50)}`;
          });
          ctx.send(
            input.entity,
            `${header("Prediction Markets")}\n${separator(80)}\n${lines.join("\n")}`,
          );
          return;
        }

        case "search": {
          const query = tokens.slice(1).join(" ");
          if (!query) {
            refuseCommand(ctx, input.entity, "Usage: market search <query>");
            return;
          }
          const results = db.searchMarkets(query);
          if (results.length === 0) {
            ctx.send(input.entity, `No markets matching "${query}".`);
            return;
          }
          const lines = results.map(
            (m) => `  ${bold(m.id.padEnd(14))} [${m.status}] ${m.question.slice(0, 60)}`,
          );
          ctx.send(
            input.entity,
            `${header(`Markets matching "${query}"`)}\n${separator(80)}\n${lines.join("\n")}`,
          );
          return;
        }

        case "live": {
          const venueRaw = tokens[1]?.toLowerCase();
          if (venueRaw !== "kalshi" && venueRaw !== "polymarket") {
            refuseCommand(
              ctx,
              input.entity,
              "Usage: market live <kalshi|polymarket> [duration] [limit]\nExamples:\n  market live kalshi 7d 25\n  market live polymarket 1w",
            );
            return;
          }
          // Optional positional args: duration, limit. Either order recognized.
          let windowMs = DEFAULT_LIVE_WINDOW_MS;
          let limit = DEFAULT_LIVE_LIMIT;
          for (const arg of tokens.slice(2)) {
            const asDuration = parseDurationMs(arg);
            if (asDuration > 0) {
              windowMs = asDuration;
              continue;
            }
            const asNum = Number(arg);
            if (Number.isFinite(asNum) && asNum > 0 && asNum <= 500) {
              limit = Math.floor(asNum);
            }
          }

          const cutoffMs = Date.now() + windowMs;
          await renderLiveFeed(ctx, input.entity, venueRaw, cutoffMs, limit);
          return;
        }

        case "show": {
          // `market view <id>` and `market info <id>` normalize here.
          const marketId = tokens[1];
          if (!marketId) {
            refuseCommand(ctx, input.entity, "Usage: market show <id>   (also view/info)");
            return;
          }
          const market = db.getMarket(marketId);
          if (!market) {
            refuseCommand(ctx, input.entity, `Market "${marketId}" not found.`);
            return;
          }
          const positions = db.getMarketPositions(market.id);
          const posLines =
            positions.length > 0
              ? positions.map(
                  (p) =>
                    `    ${p.entity_name.padEnd(16)} ${p.direction.toUpperCase().padEnd(4)} ${String(p.confidence).padStart(3)}%  ${p.reasoning.slice(0, 50)}`,
                )
              : ["    (no positions yet)"];

          let scoreSection = "";
          if (market.status === "resolved") {
            scoreSection =
              `\n  ${bold("Outcome:")} ${(market.outcome ?? "?").toUpperCase()}\n` +
              `  ${bold("Resolved by:")} ${market.resolved_by ?? "unknown"}\n`;
          }

          ctx.send(
            input.entity,
            `${header("Market Detail")}\n${separator(60)}\n` +
              `  ${bold("ID:")} ${market.id}\n` +
              `  ${bold("Question:")} ${market.question}\n` +
              `  ${bold("Category:")} ${market.category || "—"}\n` +
              `  ${bold("Status:")} ${market.status}\n` +
              `  ${bold("Room:")} ${market.room_id}${scoreSection}\n` +
              `  ${bold("Positions")} (${positions.length}):\n${posLines.join("\n")}`,
          );
          return;
        }

        case "leaderboard":
        case "lb": {
          const leaders = db.getCalibrationLeaderboard(20);
          if (leaders.length === 0) {
            ctx.send(
              input.entity,
              "No calibration data yet. Resolve markets to build the leaderboard.",
            );
            return;
          }
          const lines = leaders.map(
            (l, i) =>
              `  ${String(i + 1).padStart(2)}. ${bold(l.entity_name.padEnd(16))} Brier: ${l.avg_brier.toFixed(3)}  Markets: ${l.markets_scored}  Correct: ${l.correct_count}`,
          );
          ctx.send(
            input.entity,
            `${header("Calibration Leaderboard")}\n${separator(70)}\n  ${dim("Lower Brier = better calibration (0 = perfect, 0.25 = coin flip)")}\n${lines.join("\n")}`,
          );
          return;
        }

        case "score": {
          const targetName = tokens[1] ?? entity.name;
          const score = db.getEntityMarketScore(targetName);
          if (!score || score.markets_scored === 0) {
            ctx.send(input.entity, `No calibration data for ${targetName}.`);
            return;
          }
          ctx.send(
            input.entity,
            `${header(`Calibration: ${targetName}`)}\n${separator(40)}\n` +
              `  Avg Brier: ${score.avg_brier.toFixed(3)}\n` +
              `  Markets:   ${score.markets_scored}\n` +
              `  Correct:   ${score.correct_count}`,
          );
          return;
        }

        case "forecast": {
          const marketId = tokens[1];
          if (!marketId) {
            refuseCommand(ctx, input.entity, "Usage: market forecast <id>");
            return;
          }
          const target = db.getMarket(marketId);
          if (!target) {
            refuseCommand(ctx, input.entity, `Market "${marketId}" not found.`);
            return;
          }
          if (target.status === "resolved") {
            refuseCommand(
              ctx,
              input.entity,
              `Market ${target.id} is already resolved (${(target.outcome ?? "?").toUpperCase()}). Nothing to forecast.`,
            );
            return;
          }
          if (!isTabH2OConfigured()) {
            refuseCommand(
              ctx,
              input.entity,
              "TabH2O is not configured on this instance — ask an admin to set TABH2O_API_KEY.",
            );
            return;
          }

          // Build training set from past resolved markets. Prefer same category,
          // fall back to all resolved if we don't have enough.
          const allResolved = db.listMarkets({ status: "resolved", limit: 500 });
          const sameCategory = allResolved.filter(
            (m) => m.category === target.category && m.outcome,
          );
          const training =
            sameCategory.length >= MIN_TRAINING_ROWS
              ? sameCategory
              : allResolved.filter((m) => m.outcome);

          if (training.length < MIN_TRAINING_ROWS) {
            ctx.send(
              input.entity,
              `Not enough resolved markets to forecast (${training.length} available, need ${MIN_TRAINING_ROWS}). Resolve more markets first.`,
            );
            return;
          }

          const trainingRows = training.map((m) => buildMarketFeatureRow(db, m, m.outcome!));
          const targetRow = buildMarketFeatureRow(db, target);

          const result = await tabh2oPredict({
            task: "classification",
            training: trainingRows,
            predict_on: [targetRow],
            target_column: "outcome",
          });

          if (!result.ok) {
            ctx.send(input.entity, `TabH2O forecast failed: ${result.error}`);
            return;
          }

          const pred = result.response.predictions[0];
          if (!pred) {
            ctx.send(input.entity, "TabH2O returned no predictions.");
            return;
          }

          const yesProb = pred.probabilities?.yes ?? (pred.prediction === "yes" ? 1 : 0);
          const yesPct = Math.round(yesProb * 100);
          const noPct = 100 - yesPct;
          const modelVersion = result.response.model_version ?? "tabh2o";
          const runtime = result.response.runtime_ms ?? 0;
          const sameCatLabel =
            sameCategory.length >= MIN_TRAINING_ROWS ? "same category" : "all resolved";

          // Provenance note — so successor agents can re-run and reason about
          // the forecast. Type "inference" + high importance so recall surfaces
          // it when later agents revisit this market.
          const noteContent =
            `[TabH2O forecast ${target.id}] YES ${yesPct}% NO ${noPct}% — ${target.question}. ` +
            `Trained on ${trainingRows.length} resolved markets (${sameCatLabel}). ` +
            `Model: ${modelVersion}, ${runtime}ms.`;
          try {
            const noteId = db.createNote(entity.name, noteContent, input.room, {
              importance: 7,
              noteType: "inference",
            });
            deps.logEvent?.({
              type: "note_created",
              entity: input.entity,
              noteId,
              authorName: entity.name,
              content: noteContent,
              importance: 7,
              noteType: "inference",
              roomId: input.room,
              timestamp: Date.now(),
            });
          } catch {
            // Provenance write is best-effort — forecast result still returned
          }

          const bar =
            "█".repeat(Math.round(yesProb * 20)) + "░".repeat(20 - Math.round(yesProb * 20));
          const lines = [
            header(`TabH2O Forecast: ${target.id}`),
            separator(70),
            `  ${bold("Question:")} ${target.question}`,
            `  ${bold("Category:")} ${target.category}`,
            "",
            `  ${bold("YES")}  ${String(yesPct).padStart(3)}%  ${bar}`,
            `  ${bold("NO")}   ${String(noPct).padStart(3)}%`,
            "",
            `  ${dim(`trained on ${trainingRows.length} resolved markets (${sameCatLabel})`)}`,
            `  ${dim(`model: ${modelVersion} · ${runtime}ms`)}`,
            "",
            `  ${dim("forecast saved as an inference note — use 'recall' to revisit it.")}`,
            `  ${dim("take a position with 'predict yes|no <confidence> <reasoning>' in the market room.")}`,
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        default:
          ctx.send(input.entity, unknownSubcommand("market", tokens[0], HELP));
      }
    },
  };
}

// ─── Feature extraction ─────────────────────────────────────────────────────

/** Minimum training rows TabH2O needs to produce a usable classification. */
const MIN_TRAINING_ROWS = 5;

const DAY_MS = 86_400_000;

/**
 * Shape a market as a feature row for TabH2O. `outcome` is included as the
 * training label for resolved markets; omit it for the target row.
 *
 * Keep features bounded and typed — TabH2O handles mixed numeric + categorical
 * but we still want stable schemas across rows.
 */
function buildMarketFeatureRow(db: MarinaDB, m: MarketRow, label?: string | null): TabH2ORow {
  const positions = db.getMarketPositions(m.id);
  const yesPositions = positions.filter((p) => p.direction === "yes");
  const noPositions = positions.filter((p) => p.direction === "no");
  const yesShare = positions.length > 0 ? yesPositions.length / positions.length : 0.5;
  const avgYesConf =
    yesPositions.length > 0
      ? yesPositions.reduce((s, p) => s + p.confidence, 0) / yesPositions.length
      : 0;
  const avgNoConf =
    noPositions.length > 0
      ? noPositions.reduce((s, p) => s + p.confidence, 0) / noPositions.length
      : 0;
  const ageDays = Math.round((Date.now() - m.created_at) / DAY_MS);
  const resolveLatencyDays =
    m.resolved_at && m.resolved_at > m.created_at
      ? Math.round((m.resolved_at - m.created_at) / DAY_MS)
      : null;

  const row: TabH2ORow = {
    category: m.category || "unknown",
    question_length: m.question.length,
    age_days: ageDays,
    resolve_latency_days: resolveLatencyDays,
    position_count: positions.length,
    yes_share: Math.round(yesShare * 1000) / 1000,
    avg_yes_confidence: Math.round(avgYesConf),
    avg_no_confidence: Math.round(avgNoConf),
  };
  if (label) row.outcome = label;
  return row;
}

// ─── Live feed rendering ─────────────────────────────────────────────────────

const HOUR_MS = 3_600_000;

/** "19h" under two days, else "3d". */
function closesIn(ms: number): string {
  const h = Math.max(0, ms) / HOUR_MS;
  return h < 48 ? `${Math.max(1, Math.round(h))}h` : `${Math.round(h / 24)}d`;
}

/** A 0–1 price as whole cents, or "—" when unknown. */
function cents(price: number): string {
  return Number.isFinite(price) ? `${Math.round(price * 100)}¢` : "—";
}

/**
 * Kalshi markets closing inside (now, cutoff], combos (parlays) left out,
 * most traded in the last 24 h first. The venue filters too; this keeps the
 * window and the combo rule even when it ignores a parameter.
 */
export function selectKalshiLive(
  markets: readonly kalshi.KalshiMarket[],
  now: number,
  cutoffMs: number,
  limit: number,
): kalshi.KalshiMarket[] {
  const volume = (m: kalshi.KalshiMarket) => {
    const v = Number(m.volume_24h_fp);
    return Number.isFinite(v) ? v : 0;
  };
  return markets
    .filter((m) => {
      if (m.mve_collection_ticker || m.ticker.startsWith("KXMVE")) return false;
      const close = Date.parse(m.close_time);
      return Number.isFinite(close) && close > now && close <= cutoffMs;
    })
    .sort((a, b) => volume(b) - volume(a) || Date.parse(a.close_time) - Date.parse(b.close_time))
    .slice(0, limit);
}

/**
 * Polymarket events ending inside (now, cutoff], most traded in the last 24 h
 * first, each with its open markets most traded first.
 */
export function selectPolymarketLive(
  events: readonly polymarket.PolymarketEvent[],
  now: number,
  cutoffMs: number,
  limit: number,
): polymarket.PolymarketEvent[] {
  const marketVolume = (m: polymarket.PolymarketMarket) => m.volume24hr ?? (Number(m.volume) || 0);
  return events
    .filter((e) => {
      const end = Date.parse(e.endDate ?? "");
      return Number.isFinite(end) && end > now && end <= cutoffMs;
    })
    .map((e) => ({
      ...e,
      markets: (e.markets ?? [])
        .filter((m) => !m.closed)
        .sort((a, b) => marketVolume(b) - marketVolume(a)),
    }))
    .filter((e) => e.markets.length > 0)
    .sort((a, b) => (b.volume24hr ?? 0) - (a.volume24hr ?? 0))
    .slice(0, limit);
}

/** The yes price of a Polymarket market, 0–1, or NaN when it cannot be read. */
function polymarketYes(m: polymarket.PolymarketMarket): number {
  try {
    const prices = JSON.parse(m.outcomePrices ?? "[]");
    const yes = Number.parseFloat(prices[0]);
    return Number.isFinite(yes) ? yes : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

/**
 * Pull live markets from a venue (Kalshi or Polymarket) and render those
 * resolving within the window, most traded first. Used by forecasters and
 * the bettor agent to find candidate markets that resolve soon.
 *
 * No auth required — both venues' read endpoints are public. Falls back
 * gracefully when the venue is unreachable.
 */
async function renderLiveFeed(
  ctx: RoomContext,
  eid: Entity["id"],
  venue: "kalshi" | "polymarket",
  cutoffMs: number,
  limit: number,
): Promise<void> {
  const now = Date.now();
  const window = closesIn(cutoffMs - now);
  if (venue === "kalshi") {
    const res = await kalshi.getMarkets({
      status: "open",
      limit: 200,
      minCloseTs: Math.floor(now / 1000),
      maxCloseTs: Math.floor(cutoffMs / 1000),
      excludeMultivariate: true,
    });
    if (!res.ok) {
      ctx.send(eid, `Kalshi unreachable: ${res.error}`);
      return;
    }
    const filtered = selectKalshiLive(res.response.markets, now, cutoffMs, limit);
    if (filtered.length === 0) {
      ctx.send(
        eid,
        `${header(`Kalshi — markets resolving within ${window}`)}\n${separator(80)}\n${dim("None found in window.")}`,
      );
      return;
    }
    const lines = filtered.map((m) => {
      const yes = cents(kalshi.kalshiPrice(m.yes_ask_dollars, m.yes_ask));
      const close = closesIn(Date.parse(m.close_time) - now);
      return `  ${bold(m.ticker.padEnd(28))} ${yes.padStart(4)}  ${close.padStart(4)}  ${m.title.slice(0, 60)}`;
    });
    ctx.send(
      eid,
      `${header(`Kalshi — ${filtered.length} markets resolving within ${window}, most traded first`)}\n${separator(80)}\n  ${dim("TICKER".padEnd(28))} ${dim(" YES")}  ${dim("CLOSE")} ${dim("QUESTION")}\n${lines.join("\n")}`,
    );
    return;
  }

  // Polymarket
  const res = await polymarket.getEvents({
    active: true,
    closed: false,
    limit: 100,
    endDateMin: new Date(now).toISOString(),
    endDateMax: new Date(cutoffMs).toISOString(),
    order: "volume24hr",
  });
  if (!res.ok) {
    ctx.send(eid, `Polymarket unreachable: ${res.error}`);
    return;
  }
  const top = selectPolymarketLive(res.response, now, cutoffMs, limit);
  if (top.length === 0) {
    ctx.send(
      eid,
      `${header(`Polymarket — events resolving within ${window}`)}\n${separator(80)}\n${dim("None found in window.")}`,
    );
    return;
  }
  const lines = top.flatMap((evt) => {
    const close = closesIn(Date.parse(evt.endDate ?? "") - now);
    const head = `  ${bold(evt.id.slice(0, 14).padEnd(14))} ${close.padStart(4)}  ${evt.title.slice(0, 64)}`;
    const sub = evt.markets.slice(0, 2).map((m) => {
      return `    ${dim(m.id.slice(0, 12).padEnd(12))} ${cents(polymarketYes(m)).padStart(4)}  ${m.question.slice(0, 60)}`;
    });
    return [head, ...sub];
  });
  ctx.send(
    eid,
    `${header(`Polymarket — ${top.length} events resolving within ${window}, most traded first`)}\n${separator(80)}\n${lines.join("\n")}`,
  );
}
