// ─── Kalshi Trading API Client ──────────────────────────────────────────────
//
// Typed REST wrapper around Kalshi's CFTC-regulated US prediction market API.
// Used by the `position` command for sizing and order placement.
//
// Design mirrors `tabh2o-client.ts`:
// - SSRF-safe via validateFetchUrl()
// - Timeout-safe via AbortController
// - Graceful degradation: returns typed result instead of throwing
// - Paper-mode toggle: when MARINA_TRADING_ENABLED is not "true", placeOrder
//   returns a synthetic "paper" response without hitting the API. This lets
//   the full pipeline run in dev without risk of real fills.
// - No retries, no queueing — caller is responsible for rate limiting.
//
// Live trading requirements (when toggling out of paper mode):
//   - KALSHI_API_KEY: API key ID (a UUID)
//   - KALSHI_API_SECRET: RSA-SHA256 private key (PEM, base64-encoded into env)
//   - MARINA_TRADING_ENABLED=true: explicit opt-in flag
//
// Kalshi REST docs: https://trading-api.readme.io/reference/getexchangestatus

import { CONNECTOR_HTTP_TIMEOUT_MS } from "../engine/constants";
import { guardedFetch, validateFetchUrl } from "./url-guard";

const DEFAULT_BASE = "https://api.elections.kalshi.com/trade-api/v2";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface KalshiMarket {
  ticker: string;
  title: string;
  yes_ask: number; // cents (0-100)
  yes_bid: number;
  no_ask: number;
  no_bid: number;
  volume: number;
  /** Lifecycle: "initialized" | "active" | "closed" | "settled" | "determined".
   *  Resolved markets are "settled" (or sometimes "determined"). */
  status: string;
  close_time: string;
  category: string;
  /** Final outcome once the market resolves: "yes" | "no". Absent on
   *  unresolved markets. Set together with status="settled". */
  result?: "yes" | "no";
  /** Settled value at expiration. Present when status reflects resolution. */
  expiration_value?: number;
  /** ISO timestamp at which the market expired / was settled. */
  expiration_time?: string;
}

export interface KalshiPosition {
  ticker: string;
  market_exposure: number; // cents
  position: number; // contract count, signed (positive = YES, negative = NO)
  realized_pnl: number;
  fees_paid: number;
  resting_orders_count: number;
}

export interface KalshiOrder {
  order_id: string;
  ticker: string;
  side: "yes" | "no";
  action: "buy" | "sell";
  type: "limit" | "market";
  count: number;
  yes_price?: number; // cents — for limit orders
  no_price?: number; // cents
  status: "resting" | "executed" | "cancelled" | "paper";
  created_ts: number;
}

export interface PlaceOrderRequest {
  ticker: string;
  side: "yes" | "no";
  action: "buy" | "sell";
  type: "limit" | "market";
  count: number;
  /** Limit price in cents (1-99). Required for type=limit. */
  yes_price?: number;
  no_price?: number;
  /** Optional client-supplied order_id for idempotency. */
  client_order_id?: string;
}

export type KalshiResult<T> =
  | { ok: true; response: T; paper: boolean }
  | { ok: false; error: string };

export interface KalshiClientOpts {
  apiKey?: string;
  apiSecret?: string;
  base?: string;
  timeoutMs?: number;
  /** Force paper mode regardless of env. Useful for tests. */
  paperMode?: boolean;
}

// ─── Configuration helpers ──────────────────────────────────────────────────

export function isKalshiConfigured(
  apiKey = process.env.KALSHI_API_KEY,
  apiSecret = process.env.KALSHI_API_SECRET,
): boolean {
  return Boolean(apiKey && apiSecret);
}

export function isLiveTradingEnabled(): boolean {
  return process.env.MARINA_TRADING_ENABLED === "true";
}

/**
 * Should we use paper mode? Defaults to true unless live trading is explicitly
 * enabled AND credentials are configured. Caller can override via opts.
 */
export function isPaperMode(opts: KalshiClientOpts = {}): boolean {
  if (opts.paperMode !== undefined) return opts.paperMode;
  return !(isLiveTradingEnabled() && isKalshiConfigured(opts.apiKey, opts.apiSecret));
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * List markets. In paper mode, returns the public read-only list (no auth
 * required for the public endpoint). In live mode, includes private fields.
 */
export async function getMarkets(
  filter: { status?: string; series?: string; limit?: number } = {},
  opts: KalshiClientOpts = {},
): Promise<KalshiResult<{ markets: KalshiMarket[]; cursor?: string }>> {
  const base = opts.base ?? process.env.KALSHI_BASE ?? DEFAULT_BASE;
  const params = new URLSearchParams();
  if (filter.status) params.set("status", filter.status);
  if (filter.series) params.set("series_ticker", filter.series);
  if (filter.limit) params.set("limit", String(filter.limit));
  const url = `${base}/markets${params.toString() ? `?${params}` : ""}`;

  return await jsonGet<{ markets: KalshiMarket[]; cursor?: string }>(url, opts);
}

export async function getMarket(
  ticker: string,
  opts: KalshiClientOpts = {},
): Promise<KalshiResult<{ market: KalshiMarket }>> {
  const base = opts.base ?? process.env.KALSHI_BASE ?? DEFAULT_BASE;
  return await jsonGet<{ market: KalshiMarket }>(
    `${base}/markets/${encodeURIComponent(ticker)}`,
    opts,
  );
}

/**
 * Place an order. In paper mode (default), returns a synthetic order
 * record with status="paper" instead of hitting the API. Callers should
 * persist the result to a board or notes for audit regardless of mode.
 */
export async function placeOrder(
  req: PlaceOrderRequest,
  opts: KalshiClientOpts = {},
): Promise<KalshiResult<KalshiOrder>> {
  const validation = validatePlaceOrder(req);
  if (validation) return { ok: false, error: validation };

  if (isPaperMode(opts)) {
    return {
      ok: true,
      paper: true,
      response: {
        order_id: `paper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ticker: req.ticker,
        side: req.side,
        action: req.action,
        type: req.type,
        count: req.count,
        yes_price: req.yes_price,
        no_price: req.no_price,
        status: "paper",
        created_ts: Date.now(),
      },
    };
  }

  const base = opts.base ?? process.env.KALSHI_BASE ?? DEFAULT_BASE;
  return await jsonPost<KalshiOrder>(`${base}/portfolio/orders`, req, opts);
}

export async function getPositions(
  opts: KalshiClientOpts = {},
): Promise<KalshiResult<{ positions: KalshiPosition[] }>> {
  if (isPaperMode(opts)) {
    // Paper mode has no live positions — caller pulls from board history.
    return { ok: true, paper: true, response: { positions: [] } };
  }
  const base = opts.base ?? process.env.KALSHI_BASE ?? DEFAULT_BASE;
  return await jsonGet<{ positions: KalshiPosition[] }>(`${base}/portfolio/positions`, opts);
}

export async function cancelOrder(
  orderId: string,
  opts: KalshiClientOpts = {},
): Promise<KalshiResult<{ order_id: string; status: string }>> {
  if (isPaperMode(opts)) {
    return {
      ok: true,
      paper: true,
      response: { order_id: orderId, status: "paper-cancelled" },
    };
  }
  const base = opts.base ?? process.env.KALSHI_BASE ?? DEFAULT_BASE;
  return await jsonDelete<{ order_id: string; status: string }>(
    `${base}/portfolio/orders/${encodeURIComponent(orderId)}`,
    opts,
  );
}

// ─── Validation ─────────────────────────────────────────────────────────────

function validatePlaceOrder(req: PlaceOrderRequest): string | null {
  if (!req.ticker || req.ticker.trim().length === 0) return "ticker is required";
  if (req.count < 1) return "count must be ≥ 1";
  if (req.count > 10_000) return "count > 10,000 — refusing as defense against typo";
  if (req.side !== "yes" && req.side !== "no") return `invalid side: ${req.side}`;
  if (req.action !== "buy" && req.action !== "sell") return `invalid action: ${req.action}`;
  if (req.type === "limit") {
    const price = req.side === "yes" ? req.yes_price : req.no_price;
    if (price === undefined) return `limit order requires ${req.side}_price`;
    if (price < 1 || price > 99) return `${req.side}_price must be 1-99 cents`;
  }
  return null;
}

// ─── Low-level HTTP ─────────────────────────────────────────────────────────

async function jsonGet<T>(url: string, opts: KalshiClientOpts): Promise<KalshiResult<T>> {
  const urlErr = await validateFetchUrl(url);
  if (urlErr) return { ok: false, error: `Kalshi endpoint rejected: ${urlErr}` };

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? CONNECTOR_HTTP_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = await authHeaders("GET", urlPath(url), opts);
    const res = await guardedFetch(url, { method: "GET", headers, signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        error: `Kalshi ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`,
      };
    }
    const json = (await res.json()) as T;
    return { ok: true, paper: false, response: json };
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === "AbortError") {
      return { ok: false, error: `Kalshi request timed out after ${timeoutMs}ms.` };
    }
    return { ok: false, error: `Kalshi request failed: ${(err as Error).message}` };
  }
}

async function jsonPost<T>(
  url: string,
  body: unknown,
  opts: KalshiClientOpts,
): Promise<KalshiResult<T>> {
  const urlErr = await validateFetchUrl(url);
  if (urlErr) return { ok: false, error: `Kalshi endpoint rejected: ${urlErr}` };

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? CONNECTOR_HTTP_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const bodyStr = JSON.stringify(body);

  try {
    const headers = await authHeaders("POST", urlPath(url), opts);
    headers["Content-Type"] = "application/json";
    const res = await guardedFetch(url, {
      method: "POST",
      headers,
      body: bodyStr,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        error: `Kalshi ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`,
      };
    }
    const json = (await res.json()) as T;
    return { ok: true, paper: false, response: json };
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === "AbortError") {
      return { ok: false, error: `Kalshi request timed out after ${timeoutMs}ms.` };
    }
    return { ok: false, error: `Kalshi request failed: ${(err as Error).message}` };
  }
}

async function jsonDelete<T>(url: string, opts: KalshiClientOpts): Promise<KalshiResult<T>> {
  const urlErr = await validateFetchUrl(url);
  if (urlErr) return { ok: false, error: `Kalshi endpoint rejected: ${urlErr}` };

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? CONNECTOR_HTTP_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = await authHeaders("DELETE", urlPath(url), opts);
    const res = await guardedFetch(url, { method: "DELETE", headers, signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        error: `Kalshi ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`,
      };
    }
    const json = (await res.json()) as T;
    return { ok: true, paper: false, response: json };
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === "AbortError") {
      return { ok: false, error: `Kalshi request timed out after ${timeoutMs}ms.` };
    }
    return { ok: false, error: `Kalshi request failed: ${(err as Error).message}` };
  }
}

// ─── Auth ───────────────────────────────────────────────────────────────────

/**
 * Kalshi uses RSA-SHA256 signed requests. Signature covers:
 *   `<timestamp_ms>` + `<METHOD>` + `<path>`
 * Headers required:
 *   KALSHI-ACCESS-KEY: <api_key_id>
 *   KALSHI-ACCESS-TIMESTAMP: <ms_since_epoch>
 *   KALSHI-ACCESS-SIGNATURE: base64(RSA-SHA256(secret, message))
 *
 * Public endpoints (markets, events) work without auth, so we omit headers
 * if no key is configured. Authenticated endpoints (orders, positions) will
 * get a 401 in that case — which is correct behavior, surface to caller.
 */
async function authHeaders(
  method: string,
  path: string,
  opts: KalshiClientOpts,
): Promise<Record<string, string>> {
  const apiKey = opts.apiKey ?? process.env.KALSHI_API_KEY;
  const apiSecret = opts.apiSecret ?? process.env.KALSHI_API_SECRET;
  if (!apiKey || !apiSecret) return {};

  const timestamp = Date.now().toString();
  const message = `${timestamp}${method}${path}`;
  const signature = await signRsa(message, apiSecret);

  return {
    "KALSHI-ACCESS-KEY": apiKey,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
    "KALSHI-ACCESS-SIGNATURE": signature,
  };
}

function urlPath(fullUrl: string): string {
  try {
    const u = new URL(fullUrl);
    return u.pathname + (u.search || "");
  } catch {
    return fullUrl;
  }
}

/**
 * RSA-SHA256 sign with a PEM private key. Uses Web Crypto. The secret env
 * var must be the PEM contents, including BEGIN/END lines, with newlines
 * escaped as `\n` (Node parses these correctly when env var is loaded).
 */
async function signRsa(message: string, pem: string): Promise<string> {
  // Normalize escaped newlines from env var to real newlines.
  const normalized = pem.replace(/\\n/g, "\n");
  const pemBody = normalized
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const keyBuffer = base64ToArrayBuffer(pemBody);

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const messageBuffer = new TextEncoder().encode(message);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    messageBuffer.buffer.slice(
      messageBuffer.byteOffset,
      messageBuffer.byteOffset + messageBuffer.byteLength,
    ) as ArrayBuffer,
  );
  return bytesToBase64(new Uint8Array(sig));
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}
