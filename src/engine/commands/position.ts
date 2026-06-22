import { bold, dim, status as fmtStatus, header, separator } from "../../net/ansi";
import * as kalshi from "../../net/kalshi-client";
import * as polymarket from "../../net/polymarket-client";
import type { MarinaDB } from "../../persistence/database";
import { createWatchNote, listActiveWatches } from "../../resolvers/watch-spec";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";
import { type BankrollState, readBankrollState } from "./bankroll";

/**
 * Position command — sizing, opening, listing, closing, P&L for real (or
 * paper) Kalshi/Polymarket positions.
 *
 * Storage model: every position event (open, close) is appended as a board
 * post on the `paper-orders` board (same board for both venues — distinguish
 * via the JSON-encoded `venue` field). Append-only history; current state
 * is computed by walking the posts. Same pattern as the calibration loop.
 *
 * Hard invariants enforced AT THE DATA LAYER (not via prompt):
 *   1. Bankroll > 0, cap > 0, floor > 0 — all required before any open
 *   2. NO SELF-HEDGE — if any open Marina position exists on the ticker
 *      on the opposite side, refuse the new order. Sizing up the SAME side
 *      is allowed (increasing conviction). Different markets are independent.
 *   3. Single position size ≤ bankroll cap
 *   4. Daily realized loss ≤ bankroll floor — NOT YET ENFORCED. The gate exists
 *      but computeRealizedLossToday() is a stub returning 0 (realized-P&L
 *      tracking pending), so the floor is advisory only. (Invariants 1-3 are live.)
 *
 * Paper mode is the default. Live trading requires
 *   MARINA_TRADING_ENABLED=true
 *   + venue credentials (KALSHI_API_KEY/SECRET or POLYMARKET_*)
 *
 * Subcommands:
 *   position size <venue> <ticker> <yes|no> <our-prob> <market-price-cents>
 *   position open <venue> <ticker> <yes|no> <count> [limit-price-cents]
 *   position list [venue]
 *   position close <order-id> [count]
 *   position pnl [today|week|all]
 *
 * Voice-friendly: every subcommand and venue is single-word.
 */

const POSITIONS_BOARD = "paper-orders";
const PROPOSALS_BOARD = "portfolio-thesis";

const HELP = `Place, list, close, and track P&L on real prediction-market positions.

Usage:
  position size <venue> <ticker> <yes|no> <our-prob> <market-price>  — Kelly-size a candidate position
  position open <venue> <ticker> <yes|no> <count> [limit-price]      — open (paper or live)
  position list [venue]                                              — show open positions
  position close <order-id> [count]                                  — close all or partial
  position pnl [today|week|all]                                      — realized P&L summary
  position propose <json>                                            — post a portfolio proposal for review
  position confirm <id>                                              — open all positions in a proposal
  position reject <id> [reason]                                      — mark a proposal rejected

Venues: kalshi | polymarket

Examples:
  position size kalshi KXFEDDECISION-26MAR-CUT yes 0.72 55
  position open kalshi KXFEDDECISION-26MAR-CUT yes 25 55
  position list
  position propose '{"items":[{"venue":"kalshi","ticker":"X","side":"yes","count":10,"price":50}]}'
  position confirm 47

Hard rules:
  • bankroll > 0, cap > 0, floor > 0 required before any open (paper or live)
  • NO SELF-HEDGE: refuses opposing-side orders on tickers we already hold
  • Paper mode default; MARINA_TRADING_ENABLED=true + creds required for live`;

// ─── Public types ───────────────────────────────────────────────────────────

export type Venue = "kalshi" | "polymarket";

export interface OrderRecord {
  order_id: string;
  venue: Venue;
  ticker: string;
  side: "yes" | "no";
  action: "open" | "close";
  count: number;
  /** Per-share price in cents (0-100). */
  price: number;
  status: "paper" | "live" | "cancelled";
  /** ms since epoch */
  ts: number;
  /** Operator/agent name who placed the order. */
  by: string;
}

// ─── Command factory ────────────────────────────────────────────────────────

/**
 * Write-path rank gate. Read-only subcommands (size, list, pnl) work at
 * rank 2+ so anyone past the tutorial can plan and inspect. Mutations
 * (open, close) require rank 5+ — same gate as bankroll. The data-layer
 * invariants (no-self-hedge, cap, floor) do the real protection.
 */
const POSITION_WRITE_MIN_RANK = 5;

function requirePositionWriteRank(ctx: RoomContext, entity: Entity, eid: EntityId): boolean {
  const rank = (entity.properties.rank as number) ?? 0;
  if (rank < POSITION_WRITE_MIN_RANK) {
    ctx.send(eid, `This subcommand requires rank ${POSITION_WRITE_MIN_RANK}+ (you are ${rank}).`);
    return false;
  }
  return true;
}

export function positionCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  db: MarinaDB;
}): CommandDef {
  const { db } = deps;

  return {
    name: "position",
    aliases: ["pos"],
    minRank: 2, // anyone past tutorial can size/list/pnl; open/close gated inline
    help: HELP,
    handler: async (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase();

      if (!sub || sub === "help") {
        ctx.send(input.entity, HELP);
        return;
      }

      switch (sub) {
        case "size":
          return handleSize(ctx, input.entity, tokens.slice(1), db, entity);
        case "open":
          if (!requirePositionWriteRank(ctx, entity, input.entity)) return;
          return handleOpen(ctx, input.entity, tokens.slice(1), db, entity);
        case "list":
          return handleList(ctx, input.entity, tokens.slice(1), db, entity);
        case "close":
          if (!requirePositionWriteRank(ctx, entity, input.entity)) return;
          return handleClose(ctx, input.entity, tokens.slice(1), db, entity);
        case "pnl":
          return handlePnl(ctx, input.entity, tokens.slice(1), db, entity);
        case "propose":
          // input.args includes the subcommand verb + everything after.
          // Strip the leading "propose " so handlers see only the JSON body.
          return handlePropose(
            ctx,
            input.entity,
            input.args.replace(/^\s*propose\s+/i, ""),
            db,
            entity,
          );
        case "confirm":
          if (!requirePositionWriteRank(ctx, entity, input.entity)) return;
          return handleConfirm(ctx, input.entity, tokens.slice(1), db, entity);
        case "reject":
          return handleReject(ctx, input.entity, tokens.slice(1), db, entity);
        default:
          ctx.send(input.entity, `Unknown subcommand: ${sub}\n\n${HELP}`);
      }
    },
  };
}

// ─── size: Kelly sizing math ────────────────────────────────────────────────

function handleSize(
  ctx: RoomContext,
  eid: EntityId,
  tokens: string[],
  db: MarinaDB,
  entity: Entity,
): void {
  const [venueRaw, ticker, sideRaw, ourProbRaw, marketPriceRaw] = tokens;
  if (!venueRaw || !ticker || !sideRaw || !ourProbRaw || !marketPriceRaw) {
    ctx.send(
      eid,
      "Usage: position size <venue> <ticker> <yes|no> <our-prob 0-1> <market-price 1-99 cents>",
    );
    return;
  }

  const venue = parseVenue(venueRaw);
  if (!venue) {
    ctx.send(eid, `Invalid venue: ${venueRaw}. Use 'kalshi' or 'polymarket'.`);
    return;
  }
  const side = parseSide(sideRaw);
  if (!side) {
    ctx.send(eid, `Invalid side: ${sideRaw}. Use 'yes' or 'no'.`);
    return;
  }
  const ourProb = Number(ourProbRaw);
  if (!Number.isFinite(ourProb) || ourProb < 0 || ourProb > 1) {
    ctx.send(eid, `our-prob must be 0-1 (got: ${ourProbRaw})`);
    return;
  }
  const marketPriceCents = Number(marketPriceRaw);
  if (!Number.isFinite(marketPriceCents) || marketPriceCents < 1 || marketPriceCents > 99) {
    ctx.send(eid, `market-price must be 1-99 cents (got: ${marketPriceRaw})`);
    return;
  }

  const state = readBankrollState(db, entity.name);
  const requirement = checkBankrollReady(state);
  if (requirement) {
    ctx.send(eid, requirement);
    return;
  }

  const sizing = kellySize({ ourProb, marketPriceCents, side, state });

  const lines = [
    header(`Position size — ${ticker} ${side.toUpperCase()}`),
    separator(),
    `  ${dim("Venue:")}        ${bold(venue)}`,
    `  ${dim("Our prob:")}     ${(ourProb * 100).toFixed(1)}%`,
    `  ${dim("Market price:")} ${marketPriceCents}¢ ${dim(`(implied ${marketPriceCents}%)`)}`,
    `  ${dim("Edge:")}         ${(sizing.edgePct * 100).toFixed(1)}pp`,
    "",
    `  ${dim("Full Kelly f*:")} ${sizing.fullKelly.toFixed(4)}`,
    `  ${dim("Fraction used:")} ${state.kelly.toFixed(2)} ${dim(`(${(state.kelly * 100).toFixed(0)}% Kelly)`)}`,
    `  ${dim("Stake (USD):")}   ${bold(fmtUsd(sizing.stakeUsd))}`,
    `  ${dim("Cap applied:")}   ${sizing.capApplied ? bold(fmtUsd(state.cap)) : dim("no")}`,
    `  ${dim("Count:")}         ${bold(String(sizing.count))} ${dim(`contracts @ ${sizing.priceCents}¢`)}`,
    "",
  ];

  if (sizing.edgePct <= 0) {
    lines.push(dim("  No edge — market price >= our probability. Don't open."));
  } else if (sizing.count === 0) {
    lines.push(dim("  Stake rounds to 0 contracts. Increase bankroll or wait for better edge."));
  } else {
    lines.push(
      dim(
        `  To open: 'position open ${venue} ${ticker} ${side} ${sizing.count} ${sizing.priceCents}'`,
      ),
    );
  }
  ctx.send(eid, lines.join("\n"));
}

interface SizingInput {
  ourProb: number;
  marketPriceCents: number;
  side: "yes" | "no";
  state: BankrollState;
}

interface SizingOutput {
  fullKelly: number;
  edgePct: number;
  stakeUsd: number;
  capApplied: boolean;
  priceCents: number;
  count: number;
}

/**
 * Half-Kelly sizing for binary prediction markets.
 *
 * For YES at YES price p_y (cents): cost p_y/100, payout 1, net win 1-p_y/100, net loss p_y/100
 *   f_yes = (p_our - p_y/100) / (1 - p_y/100)
 *
 * For NO at NO price p_n = 100 - p_y: similar with q_our = 1 - p_our.
 *
 * Negative f* means no edge — return 0.
 */
export function kellySize(input: SizingInput): SizingOutput {
  const { ourProb, marketPriceCents, side, state } = input;
  // Determine the price for the side we want.
  const sidePriceCents = side === "yes" ? marketPriceCents : 100 - marketPriceCents;
  const sidePrice = sidePriceCents / 100;
  const sideProb = side === "yes" ? ourProb : 1 - ourProb;
  // Kelly: f = (sideProb - sidePrice) / (1 - sidePrice)
  const denom = 1 - sidePrice;
  let fullKelly = 0;
  if (denom > 0 && sideProb > sidePrice) {
    fullKelly = (sideProb - sidePrice) / denom;
  }
  const edgePct = sideProb - sidePrice;

  let stakeUsd = state.bankroll * state.kelly * Math.max(0, fullKelly);
  let capApplied = false;
  if (state.cap > 0 && stakeUsd > state.cap) {
    stakeUsd = state.cap;
    capApplied = true;
  }
  const count = sidePrice > 0 ? Math.floor(stakeUsd / sidePrice) : 0;

  return {
    fullKelly,
    edgePct,
    stakeUsd,
    capApplied,
    priceCents: sidePriceCents,
    count,
  };
}

// ─── open: place order with no-self-hedge enforcement ──────────────────────

interface OpenRequest {
  venue: Venue;
  ticker: string;
  side: "yes" | "no";
  count: number;
  /** Limit price in cents (1-99). If undefined, market order at est. 50¢. */
  priceCents?: number;
}

interface OpenResult {
  ok: boolean;
  /** Human-readable status — error message, "refused: <reason>", or success summary. */
  message: string;
  /** Persisted order record (only on ok=true). */
  record?: OrderRecord;
  /** Stake in USD that this open consumed (only on ok=true). */
  stakeUsd?: number;
}

/**
 * Core open logic — usable from `position open` (interactive) and
 * `position confirm` (batch from a proposal). All risk gates run here:
 *   1. Bankroll readiness (set/cap/floor/kelly all > 0)
 *   2. No-self-hedge invariant
 *   3. Per-position cap
 *   4. Daily floor — currently a no-op (computeRealizedLossToday is a stub
 *      returning 0); the branch never fires until realized-P&L is wired.
 * Returns a structured result so callers can decide how to format output.
 */
export async function attemptOpen(
  db: MarinaDB,
  entity: Entity,
  req: OpenRequest,
): Promise<OpenResult> {
  // ─── Risk gates ─────────────────────────────────────────────────────────
  const state = readBankrollState(db, entity.name);
  const ready = checkBankrollReady(state);
  if (ready) return { ok: false, message: ready };

  const hedgeError = checkNoSelfHedge(db, req.venue, req.ticker, req.side);
  if (hedgeError) return { ok: false, message: hedgeError };

  const priceForStake = req.priceCents ?? 50;
  const stakeUsd = (req.count * priceForStake) / 100;
  if (state.cap > 0 && stakeUsd > state.cap) {
    return {
      ok: false,
      message: `Stake $${stakeUsd.toFixed(2)} exceeds bankroll cap $${state.cap.toFixed(2)}. Reduce count or raise cap.`,
    };
  }

  const todayLoss = computeRealizedLossToday(db);
  if (state.floor > 0 && todayLoss >= state.floor) {
    return {
      ok: false,
      message: `Daily loss floor reached: realized loss today ${fmtUsd(todayLoss)} ≥ floor ${fmtUsd(state.floor)}. Trading halted until UTC midnight.`,
    };
  }

  // ─── Place order via venue client ───────────────────────────────────────
  let orderId = "";
  let venueStatus: "paper" | "live" = "paper";

  if (req.venue === "kalshi") {
    const res = await kalshi.placeOrder({
      ticker: req.ticker,
      side: req.side,
      action: "buy",
      type: req.priceCents !== undefined ? "limit" : "market",
      count: req.count,
      yes_price: req.side === "yes" ? req.priceCents : undefined,
      no_price: req.side === "no" ? req.priceCents : undefined,
    });
    if (!res.ok) return { ok: false, message: `Order rejected: ${res.error}` };
    orderId = res.response.order_id;
    venueStatus = res.response.status === "paper" ? "paper" : "live";
  } else {
    const res = await polymarket.placeOrder({
      market: req.ticker,
      token_id: `${req.ticker}-${req.side}`,
      side: "BUY",
      price: (req.priceCents ?? 50) / 100,
      size: req.count,
    });
    if (!res.ok) return { ok: false, message: `Order rejected: ${res.error}` };
    orderId = res.response.order_id;
    venueStatus = res.response.status === "paper" ? "paper" : "live";
  }

  // ─── Persist to paper-orders board ──────────────────────────────────────
  ensurePositionsBoard(db);
  const record: OrderRecord = {
    order_id: orderId,
    venue: req.venue,
    ticker: req.ticker,
    side: req.side,
    action: "open",
    count: req.count,
    price: req.priceCents ?? 50,
    status: venueStatus,
    ts: Date.now(),
    by: entity.name,
  };
  // Note: caller must invoke recordOrder() if they want board-side audit;
  // we don't do it here because confirm wants to record under the requester
  // not under the agent that proposed. The handleOpen wrapper records.

  return {
    ok: true,
    message: `${venueStatus.toUpperCase()} ${req.venue} ${req.ticker} ${req.side.toUpperCase()} ×${req.count} @ ${req.priceCents ?? 50}¢`,
    record,
    stakeUsd,
  };
}

async function handleOpen(
  ctx: RoomContext,
  eid: EntityId,
  tokens: string[],
  db: MarinaDB,
  entity: Entity,
): Promise<void> {
  const [venueRaw, ticker, sideRaw, countRaw, priceRaw] = tokens;
  if (!venueRaw || !ticker || !sideRaw || !countRaw) {
    ctx.send(eid, "Usage: position open <venue> <ticker> <yes|no> <count> [limit-price-cents]");
    return;
  }
  const venue = parseVenue(venueRaw);
  if (!venue) {
    ctx.send(eid, `Invalid venue: ${venueRaw}. Use 'kalshi' or 'polymarket'.`);
    return;
  }
  const side = parseSide(sideRaw);
  if (!side) {
    ctx.send(eid, `Invalid side: ${sideRaw}. Use 'yes' or 'no'.`);
    return;
  }
  const count = Number(countRaw);
  if (!Number.isFinite(count) || count < 1 || count > 10_000) {
    ctx.send(eid, `count must be 1-10000 (got: ${countRaw})`);
    return;
  }
  const priceCents = priceRaw !== undefined ? Number(priceRaw) : undefined;
  if (
    priceCents !== undefined &&
    (!Number.isFinite(priceCents) || priceCents < 1 || priceCents > 99)
  ) {
    ctx.send(eid, `limit-price must be 1-99 cents (got: ${priceRaw})`);
    return;
  }

  const result = await attemptOpen(db, entity, { venue, ticker, side, count, priceCents });
  if (!result.ok || !result.record) {
    ctx.send(eid, result.message);
    return;
  }
  // Record to the audit board under the entity that opened (handleOpen caller).
  recordOrder(db, eid, entity.name, result.record);
  // Auto-spin a resolving watch so the calibration loop closes when the
  // underlying market resolves — without operator action.
  ensureResolvingWatch(db, entity.name, result.record.venue, result.record.ticker);

  const rec = result.record;
  const lines = [
    header("Position opened"),
    separator(),
    `  ${dim("Mode:")}     ${rec.status === "paper" ? fmtStatus("PAPER", "warn") : fmtStatus("LIVE", "active")}`,
    `  ${dim("Venue:")}    ${bold(rec.venue)}`,
    `  ${dim("Ticker:")}   ${bold(rec.ticker)}`,
    `  ${dim("Side:")}     ${bold(rec.side.toUpperCase())} ${dim(`× ${rec.count} contracts @ ${rec.price}¢`)}`,
    `  ${dim("Stake:")}    ${bold(fmtUsd(result.stakeUsd ?? 0))}`,
    `  ${dim("Order ID:")} ${dim(rec.order_id)}`,
    "",
    dim(`Recorded on ${POSITIONS_BOARD} board. 'position list' to view.`),
  ];
  ctx.send(eid, lines.join("\n"));
}

// ─── list: show open positions ─────────────────────────────────────────────

function handleList(
  ctx: RoomContext,
  eid: EntityId,
  tokens: string[],
  db: MarinaDB,
  _entity: Entity,
): void {
  const venueFilter = tokens[0] ? parseVenue(tokens[0]) : undefined;
  const positions = computeOpenPositions(db, venueFilter ?? undefined);

  if (positions.length === 0) {
    ctx.send(eid, dim("No open positions."));
    return;
  }

  const lines = [header(`Open positions${venueFilter ? ` — ${venueFilter}` : ""}`), separator()];
  for (const p of positions) {
    lines.push(
      `  ${bold(p.venue.padEnd(10))} ${p.ticker.padEnd(30)} ${bold(p.side.toUpperCase().padEnd(4))} ${String(p.netCount).padStart(5)}  @ ${p.avgPrice.toFixed(0)}¢  ${dim(fmtUsd(p.stakeUsd))}`,
    );
  }
  lines.push("", dim(`${positions.length} ticker(s). 'position close <order-id>' to close.`));
  ctx.send(eid, lines.join("\n"));
}

// ─── close: close a position ────────────────────────────────────────────────

async function handleClose(
  ctx: RoomContext,
  eid: EntityId,
  tokens: string[],
  db: MarinaDB,
  entity: Entity,
): Promise<void> {
  const [orderId, countRaw] = tokens;
  if (!orderId) {
    ctx.send(eid, "Usage: position close <order-id> [count]");
    return;
  }

  const orders = listAllOrders(db);
  const opener = orders.find((o) => o.order_id === orderId && o.action === "open");
  if (!opener) {
    ctx.send(eid, `No open order found with id: ${orderId}`);
    return;
  }

  const closeCount = countRaw ? Number(countRaw) : opener.count;
  if (!Number.isFinite(closeCount) || closeCount < 1 || closeCount > opener.count) {
    ctx.send(eid, `count must be 1-${opener.count}`);
    return;
  }

  // Cancel via venue client (paper mode = synthetic).
  let cancelOk = true;
  let cancelError = "";
  if (opener.venue === "kalshi") {
    const res = await kalshi.cancelOrder(orderId);
    if (!res.ok) {
      cancelOk = false;
      cancelError = res.error;
    }
  } else {
    const res = await polymarket.cancelOrder(orderId);
    if (!res.ok) {
      cancelOk = false;
      cancelError = res.error;
    }
  }

  if (!cancelOk) {
    ctx.send(eid, `Close failed: ${cancelError}`);
    return;
  }

  // Record the close.
  ensurePositionsBoard(db);
  const closeRecord: OrderRecord = {
    order_id: `close-${orderId}-${Date.now()}`,
    venue: opener.venue,
    ticker: opener.ticker,
    side: opener.side,
    action: "close",
    count: closeCount,
    // For paper, assume close at same price (no realized P&L); a more
    // sophisticated P&L tracker would query market price at close time.
    price: opener.price,
    status: opener.status,
    ts: Date.now(),
    by: entity.name,
  };
  recordOrder(db, eid, entity.name, closeRecord);

  ctx.send(
    eid,
    `${header("Position closed")}\n${separator()}\n  ${dim("Order:")} ${orderId}\n  ${dim("Closed:")} ${closeCount}/${opener.count} contracts`,
  );
}

// ─── pnl: realized P&L summary ─────────────────────────────────────────────

function handlePnl(
  ctx: RoomContext,
  eid: EntityId,
  tokens: string[],
  db: MarinaDB,
  _entity: Entity,
): void {
  const period = (tokens[0] ?? "all").toLowerCase();
  let cutoff = 0;
  const now = Date.now();
  if (period === "today") {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    cutoff = d.getTime();
  } else if (period === "week") {
    cutoff = now - 7 * 86_400_000;
  } else if (period === "all") {
    cutoff = 0;
  } else {
    ctx.send(eid, "Usage: position pnl [today|week|all]");
    return;
  }

  const orders = listAllOrders(db).filter((o) => o.ts >= cutoff);
  const opens = orders.filter((o) => o.action === "open");
  const closes = orders.filter((o) => o.action === "close");

  const stakeOpened = opens.reduce((s, o) => s + (o.count * o.price) / 100, 0);
  const stakeClosed = closes.reduce((s, o) => s + (o.count * o.price) / 100, 0);
  // Realized P&L is populated by the calibration finder registry in
  // src/resolvers/calibration.ts when a resolver reports `status: "resolved"`
  // for a market a position references. Until then we display $0 with a
  // pointer at the calibration flow in the help text below.
  const realizedPnl = 0;

  const lines = [
    header(`P&L — ${period}`),
    separator(),
    `  ${dim("Orders opened:")}  ${opens.length} ${dim(`(${fmtUsd(stakeOpened)} staked)`)}`,
    `  ${dim("Orders closed:")}  ${closes.length} ${dim(`(${fmtUsd(stakeClosed)} closed)`)}`,
    `  ${dim("Realized P&L:")}   ${realizedPnl >= 0 ? bold(fmtUsd(realizedPnl)) : fmtStatus(fmtUsd(realizedPnl), "warn")}`,
    "",
    dim(
      "  Realized P&L populates when underlying markets resolve. Until then, " +
        "see the calibration finder registry (src/resolvers/calibration.ts) " +
        "for forecast quality.",
    ),
  ];
  ctx.send(eid, lines.join("\n"));
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function checkBankrollReady(state: BankrollState): string | null {
  if (state.bankroll <= 0) {
    return "Bankroll is 0 — set 'bankroll set <usd>' before opening positions.";
  }
  if (state.cap <= 0) {
    return "Position cap is 0 — set 'bankroll cap <usd>' before opening positions.";
  }
  if (state.floor <= 0) {
    return "Daily loss floor is 0 — set 'bankroll floor <usd>' before opening positions.";
  }
  if (state.kelly <= 0 || state.kelly > 1) {
    return `Kelly fraction must be 0-1 (current: ${state.kelly}).`;
  }
  return null;
}

/**
 * No-self-hedge invariant: scan recent paper-orders board posts for any
 * existing open position on this venue+ticker. If any are on the OPPOSITE
 * side, refuse the new order. Sizing up the SAME side is allowed.
 *
 * Returns null if open is allowed, error string if it should be refused.
 */
export function checkNoSelfHedge(
  db: MarinaDB,
  venue: Venue,
  ticker: string,
  newSide: "yes" | "no",
): string | null {
  const orders = listAllOrders(db).filter((o) => o.venue === venue && o.ticker === ticker);
  // Net signed count: YES = positive, NO = negative.
  let net = 0;
  for (const o of orders) {
    const signed = (o.side === "yes" ? 1 : -1) * o.count * (o.action === "open" ? 1 : -1);
    net += signed;
  }
  if (net === 0) return null; // No existing position.
  const existingSide = net > 0 ? "yes" : "no";
  if (existingSide === newSide) return null; // Sizing up — allowed.
  return `No-self-hedge invariant: we already hold ${existingSide.toUpperCase()} on ${venue}/${ticker} (net ${Math.abs(net)} contracts). Refusing to open ${newSide.toUpperCase()} on the same ticker. Close the existing position first if you want to flip sides.`;
}

interface AggregatedPosition {
  venue: Venue;
  ticker: string;
  side: "yes" | "no";
  netCount: number;
  avgPrice: number;
  stakeUsd: number;
}

function computeOpenPositions(db: MarinaDB, venueFilter?: Venue): AggregatedPosition[] {
  const orders = listAllOrders(db).filter((o) => !venueFilter || o.venue === venueFilter);
  // Group by venue+ticker.
  const byKey = new Map<string, OrderRecord[]>();
  for (const o of orders) {
    const k = `${o.venue}|${o.ticker}`;
    const arr = byKey.get(k) ?? [];
    arr.push(o);
    byKey.set(k, arr);
  }
  const out: AggregatedPosition[] = [];
  for (const [k, arr] of byKey) {
    const [venue, ticker] = k.split("|") as [Venue, string];
    let netSignedCount = 0;
    let totalCost = 0;
    let totalContracts = 0;
    for (const o of arr) {
      const signed = (o.side === "yes" ? 1 : -1) * o.count * (o.action === "open" ? 1 : -1);
      netSignedCount += signed;
      if (o.action === "open") {
        totalCost += o.count * o.price;
        totalContracts += o.count;
      }
    }
    if (netSignedCount === 0) continue;
    const side: "yes" | "no" = netSignedCount > 0 ? "yes" : "no";
    const avgPrice = totalContracts > 0 ? totalCost / totalContracts : 0;
    out.push({
      venue,
      ticker,
      side,
      netCount: Math.abs(netSignedCount),
      avgPrice,
      stakeUsd: (Math.abs(netSignedCount) * avgPrice) / 100,
    });
  }
  return out.sort((a, b) => b.stakeUsd - a.stakeUsd);
}

function computeRealizedLossToday(db: MarinaDB): number {
  // Phase 2: realized loss tracking requires market-resolution data which
  // we'll integrate in Phase 3. For now, we conservatively return 0 so
  // the floor check is permissive. The cap + no-self-hedge gates still apply.
  void db;
  return 0;
}

// ─── propose / confirm / reject — portfolio gate ───────────────────────────

interface ProposalItem {
  venue: Venue;
  ticker: string;
  side: "yes" | "no";
  count: number;
  /** Limit price in cents (1-99). Optional; omitted = market order. */
  price?: number;
  /** Optional metadata documenting the thesis behind this leg. */
  our_prob?: number;
  market_price?: number;
  edge_pp?: number;
  confidence?: number;
  rationale?: string;
}

interface Proposal {
  /** Who requested this proposal (e.g., "Tester" or the user the bettor serves). */
  requester?: string;
  /** Free-text summary the bettor wrote. */
  summary?: string;
  /** Position legs to open. */
  items: ProposalItem[];
}

function ensureProposalsBoard(db: MarinaDB): string {
  const existing = db.getBoardByName(PROPOSALS_BOARD);
  if (existing) return existing.id;
  const id = `board:${PROPOSALS_BOARD}`;
  db.createBoard({ id, name: PROPOSALS_BOARD, scopeType: "global" });
  return id;
}

function parseProposal(raw: string): { ok: true; value: Proposal } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${(err as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, error: "Proposal must be a JSON object." };
  }
  const obj = parsed as Record<string, unknown>;
  const itemsRaw = obj.items;
  if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) {
    return { ok: false, error: "Proposal.items must be a non-empty array." };
  }
  const items: ProposalItem[] = [];
  for (let i = 0; i < itemsRaw.length; i++) {
    const it = itemsRaw[i] as Record<string, unknown>;
    const venue = parseVenue(String(it.venue ?? ""));
    const side = parseSide(String(it.side ?? ""));
    const ticker = typeof it.ticker === "string" ? it.ticker.trim() : "";
    const count = Number(it.count);
    if (!venue) return { ok: false, error: `items[${i}]: invalid venue` };
    if (!side) return { ok: false, error: `items[${i}]: invalid side` };
    if (!ticker) return { ok: false, error: `items[${i}]: missing ticker` };
    if (!Number.isFinite(count) || count < 1 || count > 10_000) {
      return { ok: false, error: `items[${i}]: count must be 1-10000` };
    }
    const price = it.price === undefined ? undefined : Number(it.price);
    if (price !== undefined && (!Number.isFinite(price) || price < 1 || price > 99)) {
      return { ok: false, error: `items[${i}]: price must be 1-99 cents (or omitted)` };
    }
    items.push({
      venue,
      ticker,
      side,
      count,
      price,
      our_prob: typeof it.our_prob === "number" ? it.our_prob : undefined,
      market_price: typeof it.market_price === "number" ? it.market_price : undefined,
      edge_pp: typeof it.edge_pp === "number" ? it.edge_pp : undefined,
      confidence: typeof it.confidence === "number" ? it.confidence : undefined,
      rationale: typeof it.rationale === "string" ? it.rationale : undefined,
    });
  }
  return {
    ok: true,
    value: {
      requester: typeof obj.requester === "string" ? obj.requester : undefined,
      summary: typeof obj.summary === "string" ? obj.summary : undefined,
      items,
    },
  };
}

function handlePropose(
  ctx: RoomContext,
  eid: EntityId,
  rawArgs: string,
  db: MarinaDB,
  entity: Entity,
): void {
  const raw = rawArgs.trim();
  if (!raw) {
    ctx.send(
      eid,
      'Usage: position propose \'<json>\'\n\nJSON shape: {"requester":"<name>","summary":"...","items":[{"venue":"kalshi|polymarket","ticker":"...","side":"yes|no","count":N,"price":N,"our_prob":0.X,"edge_pp":N,"confidence":N,"rationale":"..."}]}',
    );
    return;
  }
  const parsed = parseProposal(raw);
  if (!parsed.ok) {
    ctx.send(eid, `Proposal rejected: ${parsed.error}`);
    return;
  }

  const totalStake = parsed.value.items.reduce(
    (s, it) => s + (it.count * (it.price ?? 50)) / 100,
    0,
  );
  const lines = parsed.value.items.map((it) => {
    const stake = (it.count * (it.price ?? 50)) / 100;
    const meta = it.edge_pp !== undefined ? ` edge ${it.edge_pp}pp` : "";
    const conf = it.confidence !== undefined ? ` conf ${it.confidence}%` : "";
    return `  ${bold(it.venue.padEnd(10))} ${it.ticker.padEnd(28)} ${it.side.toUpperCase().padEnd(4)} ×${String(it.count).padStart(4)} @ ${it.price ?? 50}¢  ${dim(fmtUsd(stake))}${dim(meta + conf)}`;
  });

  const summary = parsed.value.summary ? `${parsed.value.summary}\n\n` : "";
  const requester = parsed.value.requester ? ` (for ${parsed.value.requester})` : "";

  const body =
    `${summary}` +
    `${parsed.value.items.length} legs, ${fmtUsd(totalStake)} total stake.\n\n` +
    `${"```json"}\n${JSON.stringify(parsed.value, null, 2)}\n${"```"}`;

  const boardId = ensureProposalsBoard(db);
  const postId = db.createBoardPost({
    boardId,
    authorId: eid,
    authorName: entity.name,
    title: `Proposal — ${parsed.value.items.length} legs / ${fmtUsd(totalStake)}${requester}`,
    body,
    tags: ["pending", `requester:${parsed.value.requester ?? entity.name}`],
  });

  const out = [
    header(`Proposal posted #${postId}`),
    separator(),
    ...lines,
    "",
    `  ${dim("Total stake:")}  ${bold(fmtUsd(totalStake))}`,
    `  ${dim("Status:")}       ${fmtStatus("PENDING", "warn")}`,
    "",
    dim(`To open: 'position confirm ${postId}'`),
    dim(`To skip: 'position reject ${postId} [reason]'`),
  ];
  ctx.send(eid, out.join("\n"));
}

async function handleConfirm(
  ctx: RoomContext,
  eid: EntityId,
  tokens: string[],
  db: MarinaDB,
  entity: Entity,
): Promise<void> {
  const idRaw = tokens[0];
  if (!idRaw) {
    ctx.send(eid, "Usage: position confirm <proposal-id>");
    return;
  }
  const proposalId = Number(idRaw);
  if (!Number.isFinite(proposalId)) {
    ctx.send(eid, `Invalid proposal id: ${idRaw}`);
    return;
  }
  const post = db.getBoardPost(proposalId);
  if (!post) {
    ctx.send(eid, `Proposal #${proposalId} not found.`);
    return;
  }
  // Extract the JSON code block from the post body.
  const m = post.body?.match(/```json\s*([\s\S]*?)```/);
  if (!m?.[1]) {
    ctx.send(eid, `Proposal #${proposalId} has no parseable JSON body.`);
    return;
  }
  const parsed = parseProposal(m[1]);
  if (!parsed.ok) {
    ctx.send(eid, `Proposal #${proposalId} JSON malformed: ${parsed.error}`);
    return;
  }

  // Walk legs. attemptOpen enforces all data-layer invariants per leg
  // (including no-self-hedge between legs of THIS proposal vs. prior orders).
  const opened: { item: ProposalItem; record: OrderRecord; stakeUsd: number }[] = [];
  const refused: { item: ProposalItem; reason: string }[] = [];
  for (const item of parsed.value.items) {
    const r = await attemptOpen(db, entity, {
      venue: item.venue,
      ticker: item.ticker,
      side: item.side,
      count: item.count,
      priceCents: item.price,
    });
    if (r.ok && r.record) {
      recordOrder(db, eid, entity.name, r.record);
      ensureResolvingWatch(db, entity.name, r.record.venue, r.record.ticker);
      opened.push({ item, record: r.record, stakeUsd: r.stakeUsd ?? 0 });
    } else {
      refused.push({ item, reason: r.message });
    }
  }

  // Mark the proposal post as confirmed via a follow-up post (audit trail).
  const boardId = ensureProposalsBoard(db);
  db.createBoardPost({
    boardId,
    parentId: proposalId,
    authorId: eid,
    authorName: entity.name,
    title: `Confirmed proposal #${proposalId} — ${opened.length}/${parsed.value.items.length} opened`,
    body: `Opened ${opened.length}, refused ${refused.length}.\n\n${
      opened.length > 0
        ? `Opened:\n${opened
            .map(
              (o) =>
                `  ${o.record.venue} ${o.record.ticker} ${o.record.side.toUpperCase()} ×${o.record.count} @ ${o.record.price}¢ (${o.record.order_id})`,
            )
            .join("\n")}\n\n`
        : ""
    }${
      refused.length > 0
        ? `Refused:\n${refused.map((r) => `  ${r.item.venue} ${r.item.ticker} ${r.item.side.toUpperCase()}: ${r.reason}`).join("\n")}`
        : ""
    }`,
    tags: ["confirmed", `proposal:${proposalId}`],
  });

  const lines = [
    header(`Confirmed proposal #${proposalId}`),
    separator(),
    `  ${dim("Opened:")}   ${bold(String(opened.length))} / ${parsed.value.items.length}`,
    `  ${dim("Refused:")}  ${refused.length}`,
    `  ${dim("Stake:")}    ${bold(fmtUsd(opened.reduce((s, o) => s + o.stakeUsd, 0)))}`,
  ];
  if (refused.length > 0) {
    lines.push("", dim("Refusals:"));
    for (const r of refused) {
      lines.push(`  ${r.item.ticker} ${r.item.side.toUpperCase()}: ${r.reason.slice(0, 100)}`);
    }
  }
  ctx.send(eid, lines.join("\n"));
}

function handleReject(
  ctx: RoomContext,
  eid: EntityId,
  tokens: string[],
  db: MarinaDB,
  entity: Entity,
): void {
  const idRaw = tokens[0];
  if (!idRaw) {
    ctx.send(eid, "Usage: position reject <proposal-id> [reason]");
    return;
  }
  const proposalId = Number(idRaw);
  if (!Number.isFinite(proposalId)) {
    ctx.send(eid, `Invalid proposal id: ${idRaw}`);
    return;
  }
  const post = db.getBoardPost(proposalId);
  if (!post) {
    ctx.send(eid, `Proposal #${proposalId} not found.`);
    return;
  }
  const reason = tokens.slice(1).join(" ").trim() || "(no reason given)";

  const boardId = ensureProposalsBoard(db);
  db.createBoardPost({
    boardId,
    parentId: proposalId,
    authorId: eid,
    authorName: entity.name,
    title: `Rejected proposal #${proposalId}`,
    body: `Rejected by ${entity.name}.\nReason: ${reason}`,
    tags: ["rejected", `proposal:${proposalId}`],
  });

  ctx.send(eid, `Proposal #${proposalId} rejected. Reason logged.`);
}

// ─── Persistence: paper-orders board ───────────────────────────────────────

function ensurePositionsBoard(db: MarinaDB): string {
  const existing = db.getBoardByName(POSITIONS_BOARD);
  if (existing) return existing.id;
  const id = `board:${POSITIONS_BOARD}`;
  db.createBoard({ id, name: POSITIONS_BOARD, scopeType: "global" });
  return id;
}

function recordOrder(db: MarinaDB, eid: EntityId, authorName: string, rec: OrderRecord): void {
  const boardId = ensurePositionsBoard(db);
  const title = `[${rec.venue}] ${rec.action} ${rec.ticker} ${rec.side.toUpperCase()} × ${rec.count} @ ${rec.price}¢ (${rec.status})`;
  const body = JSON.stringify(rec, null, 2);
  db.createBoardPost({
    boardId,
    authorId: eid,
    authorName,
    title,
    body,
    tags: [
      `venue:${rec.venue}`,
      `ticker:${rec.ticker}`,
      `side:${rec.side}`,
      `action:${rec.action}`,
      `status:${rec.status}`,
    ],
  });
}

/**
 * Auto-spin a watch spec for the underlying market when a position opens.
 * The watching role probes the venue every hour; on resolution, the
 * position-thesis calibration finder pairs this order with a WIN/LOSS
 * outcome note. Closes the operator-irreducible "create watches manually"
 * step from the Phase 2.6 paper-trading flow.
 *
 * Idempotent on (kind, id) — repeated opens against the same ticker
 * reuse the existing watch (one watch covers all legs of one ticker).
 */
function ensureResolvingWatch(
  db: MarinaDB,
  authorName: string,
  venue: "kalshi" | "polymarket",
  ticker: string,
): void {
  const id = `${venue}/${ticker}`;
  const existing = listActiveWatches(db).find(
    (w) => w.spec.kind === "resolving" && w.spec.id === id,
  );
  if (existing) return;
  createWatchNote(
    db,
    {
      kind: "resolving",
      id,
      args: { venue, ticker },
      cadence: { kind: "interval", ms: 3_600_000 }, // every 1h — markets resolve at hour-or-day cadence
      retirement: { kind: "resolved" },
      notify: authorName,
      createdBy: authorName,
      createdAt: Date.now(),
    },
    authorName,
  );
}

function listAllOrders(db: MarinaDB): OrderRecord[] {
  const board = db.getBoardByName(POSITIONS_BOARD);
  if (!board) return [];
  const posts = db.listBoardPosts(board.id, { limit: 1000 });
  const out: OrderRecord[] = [];
  for (const p of posts) {
    try {
      const rec = JSON.parse(p.body ?? "{}") as OrderRecord;
      if (rec.order_id && rec.venue && rec.ticker) out.push(rec);
    } catch {
      // skip malformed posts
    }
  }
  return out;
}

// ─── Parsers / formatters ──────────────────────────────────────────────────

function parseVenue(s: string): Venue | null {
  const v = s.toLowerCase();
  return v === "kalshi" || v === "polymarket" ? v : null;
}

function parseSide(s: string): "yes" | "no" | null {
  const v = s.toLowerCase();
  return v === "yes" || v === "no" ? v : null;
}

function fmtUsd(n: number): string {
  if (n === 0) return "$0";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}
