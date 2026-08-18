// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// ─── Polymarket Trading API Client ──────────────────────────────────────────
//
// Typed wrapper around Polymarket's gamma (read) + CLOB (write) APIs. Mirrors
// the kalshi-client shape: SSRF-guarded, timeout-safe, paper-mode default,
// graceful degradation, opt-in live trading via MARINA_TRADING_ENABLED.
//
// Polymarket's CLOB requires EIP-712 signed orders authenticated by a wallet
// private key. For Phase 2 we ship the public/read endpoints + paper order
// placement. Live order placement is structured (CLOB request shape is
// correct) but the EIP-712 signing path is left as a TODO that will be filled
// in when we onboard a real wallet — gating the live flag is the operator's
// call. The paper path is fully functional and is where the bettor world
// runs by default.
//
// Live trading requirements (when toggling out of paper mode):
//   - POLYMARKET_API_KEY: API key
//   - POLYMARKET_API_SECRET: HMAC secret
//   - POLYMARKET_API_PASSPHRASE: passphrase set during key creation
//   - POLYMARKET_PRIVATE_KEY: EVM wallet key for EIP-712 signing
//   - MARINA_TRADING_ENABLED=true
//
// Polymarket docs:
//   - Gamma (read): https://gamma-api.polymarket.com
//   - CLOB (write): https://clob.polymarket.com

import { CONNECTOR_HTTP_TIMEOUT_MS } from "../engine/constants";
import { guardedFetch, validateFetchUrl } from "./url-guard";

const DEFAULT_GAMMA_BASE = "https://gamma-api.polymarket.com";
const _DEFAULT_CLOB_BASE = "https://clob.polymarket.com";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PolymarketEvent {
  id: string;
  title: string;
  slug: string;
  markets: PolymarketMarket[];
}

export interface PolymarketMarket {
  id: string;
  question: string;
  /** JSON-encoded "[\"0.65\",\"0.35\"]" — [yes_price, no_price] in dollar units.
   *  After resolution, the winning outcome's price approaches 1.0 and the
   *  other approaches 0.0. */
  outcomePrices: string;
  /** JSON-encoded "[\"Yes\",\"No\"]" — outcome labels paired with prices.
   *  Optional; gamma omits this on some legacy markets. We default to
   *  ["Yes","No"] when missing for binary markets. */
  outcomes?: string;
  /** Token IDs for CLOB ordering. JSON-encoded array. */
  clobTokenIds?: string;
  volume: number;
  active: boolean;
  closed: boolean;
}

// ─── Resolution parsing ─────────────────────────────────────────────────────

/**
 * Derive the YES/NO outcome of a binary market from its closed flag and
 * outcomePrices. Returns outcome=null for unresolved markets, malformed
 * prices, or non-binary events. Tolerant by design — a parse failure here
 * is a "no-change" signal to the resolver, never an error.
 */
export function parseResolution(market: PolymarketMarket): {
  outcome: "yes" | "no" | null;
  winningPrice?: number;
} {
  if (!market.closed) return { outcome: null };

  let prices: string[];
  try {
    prices = JSON.parse(market.outcomePrices) as string[];
  } catch {
    return { outcome: null };
  }
  if (!Array.isArray(prices) || prices.length < 2) return { outcome: null };

  let outcomes: string[] = ["Yes", "No"];
  if (market.outcomes) {
    try {
      const parsed = JSON.parse(market.outcomes) as string[];
      if (Array.isArray(parsed) && parsed.length === prices.length) outcomes = parsed;
    } catch {
      // fall through to default ["Yes", "No"]
    }
  }

  // Find the winning outcome — the one whose price is at-or-near 1.0.
  // Polymarket settles winners to exactly 1.0 / 0.0; threshold guards
  // against edge cases (rounding, mid-resolution snapshots).
  let winnerIdx = -1;
  let winnerPrice = 0;
  for (let i = 0; i < prices.length; i++) {
    const p = Number(prices[i]);
    if (Number.isFinite(p) && p > winnerPrice) {
      winnerPrice = p;
      winnerIdx = i;
    }
  }
  if (winnerIdx === -1 || winnerPrice < 0.99) return { outcome: null };

  const label = outcomes[winnerIdx]?.toLowerCase();
  if (label === "yes") return { outcome: "yes", winningPrice: winnerPrice };
  if (label === "no") return { outcome: "no", winningPrice: winnerPrice };

  // Closed binary market with non-Yes/No labels — unsupported for this
  // resolver. Caller sees no-change rather than a misleading outcome.
  return { outcome: null };
}

export interface PolymarketOrder {
  order_id: string;
  market: string;
  side: "BUY" | "SELL";
  /** Token ID in the CLOB — derived from market.clobTokenIds[0=yes, 1=no]. */
  token_id: string;
  price: number; // 0.01 - 0.99 in dollars
  size: number; // contract count
  status: "live" | "filled" | "cancelled" | "paper";
  created_ts: number;
}

export interface PlacePolymarketOrderRequest {
  /** Market id (event id from gamma). */
  market: string;
  /** Token id from market.clobTokenIds — caller resolves which side. */
  token_id: string;
  side: "BUY" | "SELL";
  /** Limit price 0.01-0.99 dollars. */
  price: number;
  /** Contract count. */
  size: number;
  client_order_id?: string;
}

export type PolymarketResult<T> =
  | { ok: true; response: T; paper: boolean }
  | { ok: false; error: string };

export interface PolymarketClientOpts {
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;
  privateKey?: string;
  gammaBase?: string;
  clobBase?: string;
  timeoutMs?: number;
  paperMode?: boolean;
}

// ─── Configuration ──────────────────────────────────────────────────────────

export function isPolymarketConfigured(
  apiKey = process.env.POLYMARKET_API_KEY,
  apiSecret = process.env.POLYMARKET_API_SECRET,
  privateKey = process.env.POLYMARKET_PRIVATE_KEY,
): boolean {
  return Boolean(apiKey && apiSecret && privateKey);
}

export function isLiveTradingEnabled(): boolean {
  return process.env.MARINA_TRADING_ENABLED === "true";
}

export function isPaperMode(opts: PolymarketClientOpts = {}): boolean {
  if (opts.paperMode !== undefined) return opts.paperMode;
  return !(
    isLiveTradingEnabled() && isPolymarketConfigured(opts.apiKey, opts.apiSecret, opts.privateKey)
  );
}

// ─── Public API (read endpoints — gamma) ────────────────────────────────────

export async function getEvents(
  filter: { active?: boolean; closed?: boolean; limit?: number } = {},
  opts: PolymarketClientOpts = {},
): Promise<PolymarketResult<PolymarketEvent[]>> {
  const base = opts.gammaBase ?? process.env.POLYMARKET_GAMMA_BASE ?? DEFAULT_GAMMA_BASE;
  const params = new URLSearchParams();
  if (filter.active !== undefined) params.set("active", String(filter.active));
  if (filter.closed !== undefined) params.set("closed", String(filter.closed));
  if (filter.limit) params.set("limit", String(filter.limit));
  const url = `${base}/events${params.toString() ? `?${params}` : ""}`;
  return await jsonGet<PolymarketEvent[]>(url, opts);
}

export async function getEvent(
  slugOrId: string,
  opts: PolymarketClientOpts = {},
): Promise<PolymarketResult<PolymarketEvent>> {
  const base = opts.gammaBase ?? process.env.POLYMARKET_GAMMA_BASE ?? DEFAULT_GAMMA_BASE;
  return await jsonGet<PolymarketEvent>(`${base}/events/${encodeURIComponent(slugOrId)}`, opts);
}

// ─── Public API (write endpoints — CLOB) ────────────────────────────────────

/**
 * Place an order. Paper mode (default) returns a synthetic order without
 * hitting the CLOB. Live mode requires EIP-712 wallet signing — currently
 * stubbed as `error: "live trading not yet implemented"` so the operator
 * has an explicit failure rather than a silent no-op when flipping the flag.
 */
export async function placeOrder(
  req: PlacePolymarketOrderRequest,
  opts: PolymarketClientOpts = {},
): Promise<PolymarketResult<PolymarketOrder>> {
  const validation = validatePlaceOrder(req);
  if (validation) return { ok: false, error: validation };

  if (isPaperMode(opts)) {
    return {
      ok: true,
      paper: true,
      response: {
        order_id: `paper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        market: req.market,
        side: req.side,
        token_id: req.token_id,
        price: req.price,
        size: req.size,
        status: "paper",
        created_ts: Date.now(),
      },
    };
  }

  // Live placement requires EIP-712 wallet signing. Until that path is
  // implemented + audited + operator-greenlit, return an explicit error.
  // This is intentional — operators flipping MARINA_TRADING_ENABLED=true
  // for Polymarket should hit a hard block until the signing layer is built.
  return {
    ok: false,
    error:
      "Polymarket live trading not yet implemented (CLOB EIP-712 signing pending operator approval). " +
      "Use paper mode or trade Kalshi instead.",
  };
}

export async function getOrders(
  opts: PolymarketClientOpts = {},
): Promise<PolymarketResult<{ orders: PolymarketOrder[] }>> {
  if (isPaperMode(opts)) {
    return { ok: true, paper: true, response: { orders: [] } };
  }
  return {
    ok: false,
    error: "Polymarket live trading not yet implemented — use paper mode.",
  };
}

export async function cancelOrder(
  orderId: string,
  opts: PolymarketClientOpts = {},
): Promise<PolymarketResult<{ order_id: string; status: string }>> {
  if (isPaperMode(opts)) {
    return {
      ok: true,
      paper: true,
      response: { order_id: orderId, status: "paper-cancelled" },
    };
  }
  return {
    ok: false,
    error: "Polymarket live trading not yet implemented — use paper mode.",
  };
}

// ─── Validation ─────────────────────────────────────────────────────────────

function validatePlaceOrder(req: PlacePolymarketOrderRequest): string | null {
  if (!req.market || req.market.trim().length === 0) return "market is required";
  if (!req.token_id || req.token_id.trim().length === 0) return "token_id is required";
  if (req.side !== "BUY" && req.side !== "SELL") return `invalid side: ${req.side}`;
  if (req.price < 0.01 || req.price > 0.99) return "price must be 0.01-0.99 dollars";
  if (req.size < 1) return "size must be ≥ 1";
  if (req.size > 10_000) return "size > 10,000 — refusing as defense against typo";
  return null;
}

// ─── Low-level HTTP ─────────────────────────────────────────────────────────

async function jsonGet<T>(url: string, opts: PolymarketClientOpts): Promise<PolymarketResult<T>> {
  const urlErr = await validateFetchUrl(url);
  if (urlErr) return { ok: false, error: `Polymarket endpoint rejected: ${urlErr}` };

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? CONNECTOR_HTTP_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await guardedFetch(url, { method: "GET", signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        error: `Polymarket ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`,
      };
    }
    const json = (await res.json()) as T;
    return { ok: true, paper: false, response: json };
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === "AbortError") {
      return { ok: false, error: `Polymarket request timed out after ${timeoutMs}ms.` };
    }
    return { ok: false, error: `Polymarket request failed: ${(err as Error).message}` };
  }
}
