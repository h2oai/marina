// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal JSON-RPC over HTTP, read-only by construction (the EVM adapter only
 * calls `eth_chainId`, `eth_blockNumber`, `eth_call`, `eth_getTransactionReceipt`;
 * see `READ_ONLY_METHODS`). Every request goes through Marina's SSRF guard:
 * `guardedFetch` (DNS-pinned, redirect re-validation) on shared/public
 * instances; under the `local` trust profile a loopback/LAN devnet (anvil) is
 * allowed through `validateOperatorLanUrl`, exactly as gateway peers are.
 */

import { isLocalProfile } from "../../../../src/engine/trust-profile";
import { guardedFetch, validateOperatorLanUrl } from "../../../../src/net/url-guard";

export type RpcTransport = (method: string, params: unknown[]) => Promise<unknown>;

/** The only methods any transport will send. Signing/sending methods are refused. */
export const READ_ONLY_METHODS = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_call",
  "eth_getTransactionReceipt",
]);

const MAX_RESPONSE_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10_000;

async function readBounded(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("RPC response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function httpRpc(url: string): RpcTransport {
  let id = 0;
  return async (method, params) => {
    if (!READ_ONLY_METHODS.has(method)) throw new Error(`RPC method not allowed: ${method}`);
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    };
    let response: Response;
    if (isLocalProfile()) {
      const problem = validateOperatorLanUrl(url);
      if (problem) throw new Error(`RPC URL refused: ${problem}`);
      response = await fetch(url, { ...init, redirect: "error" });
    } else {
      response = await guardedFetch(url, init, { maxHops: 0 });
    }
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const body = JSON.parse(await readBounded(response)) as {
      result?: unknown;
      error?: { message?: string };
    };
    if (body.error) throw new Error(`RPC error: ${String(body.error.message ?? "unknown")}`);
    return body.result;
  };
}
