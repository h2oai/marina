// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Chain-agnostic adapter boundary. Marina has NO token of its own and NO bridge:
 * a licence lives on whichever single chain its publisher chose, and every
 * operation here is either a read-only query or the construction of an
 * UNSIGNED transaction for the operator's own wallet to sign. No adapter ever
 * holds, receives or asks for a private key.
 *
 * One EVM adapter (`evm.ts`) covers any EVM chain by configuration. A non-EVM
 * family (Solana, …) plugs in by implementing this interface and registering a
 * factory for its `family` in `createChainRegistry` — nothing else changes.
 */

export type Network = "devnet" | "testnet" | "mainnet";

export interface ChainConfig {
  /** Adapter family, e.g. `evm`. */
  family: string;
  /** Chain id as the family defines it (EVM: the EIP-155 integer). */
  chain_id: number | string;
  /** Public RPC endpoint (http/https). Fetched through `src/net/url-guard.ts`. */
  rpc: string;
  /** Licence contract (EVM: ERC-1155 `MarinaLicense`). */
  license_contract: string;
  /** Blocks behind head to read at (finality margin). */
  confirmations: number;
  /** Declared network class; `mainnet` needs an explicit operator opt-in. */
  network: Network;
}

export interface ChainEntitlementQuery {
  holder: string;
  artifactId: string;
  tiers: string[];
}

export type ChainEntitlementResult =
  | { ok: true; block: number; balances: Record<string, string> }
  | { ok: false; reason: string };

export interface AnchorRequest {
  artifactId: string;
  version: string;
  /** sha256 hex (no 0x) of the canonical manifest. */
  manifestDigest: string;
}

/** An unsigned transaction for the operator to sign in their own wallet. */
export interface UnsignedTransaction {
  chain_id: number | string;
  to: string;
  data: string;
  value: "0";
  description: string;
}

export interface SettlementRef {
  /** Transaction that issued the licence (a checkout or marketplace did it). */
  txHash: string;
  licensee: string;
  artifactId: string;
  tier: string;
}

export type SettlementResolution =
  | { settled: true; block: number; confirmations: number; tokenId: string; amount: string }
  | { settled: false; reason: string };

export interface ChainAdapter {
  readonly family: string;
  readonly name: string;
  readonly chainId: number | string;
  /** Read-only: does `holder` hold a licence for every requested tier? */
  verifyEntitlement(query: ChainEntitlementQuery): Promise<ChainEntitlementResult>;
  /** Build (never sign or send) the transaction that anchors a manifest digest. */
  anchor(request: AnchorRequest): Promise<UnsignedTransaction>;
  /** Read-only: the anchored digest for an artifact version, or null. */
  readAnchor(artifactId: string, version: string): Promise<string | null>;
  /**
   * Read-only: confirm that an external payment flow settled — the referenced
   * transaction succeeded, is final enough, and issued the licence to the
   * licensee. Payment itself happens outside Marina (decision D-19).
   */
  resolveSettlement(ref: SettlementRef): Promise<SettlementResolution>;
}

export type ChainRegistry = ReadonlyMap<string, ChainAdapter>;
export type AdapterFactory = (name: string, config: ChainConfig) => ChainAdapter;

/**
 * Chain ids of well-known MAINNETS. A config entry naming one of these while
 * declaring itself `devnet`/`testnet` is a misconfiguration and is refused.
 */
export const KNOWN_EVM_MAINNETS = new Set([1, 10, 56, 137, 8453, 42161, 43114, 59144, 534352]);

export function validateChainConfig(
  name: string,
  config: ChainConfig,
  allowMainnet: boolean,
): string | null {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) return `chain name invalid: ${name}`;
  if (!["devnet", "testnet", "mainnet"].includes(config.network))
    return `${name}: network must be devnet|testnet|mainnet`;
  if (config.network === "mainnet" && !allowMainnet)
    return `${name}: mainnet chains are disabled (set allow_mainnet only with an explicit go)`;
  if (
    config.family === "evm" &&
    KNOWN_EVM_MAINNETS.has(Number(config.chain_id)) &&
    config.network !== "mainnet"
  )
    return `${name}: chain id ${config.chain_id} is a mainnet; declare it as such`;
  if (
    !Number.isInteger(config.confirmations) ||
    config.confirmations < 0 ||
    config.confirmations > 1000
  )
    return `${name}: confirmations must be an integer 0..1000`;
  if (typeof config.rpc !== "string" || !/^https?:\/\//.test(config.rpc))
    return `${name}: rpc must be http(s)`;
  return null;
}

export function createChainRegistry(
  configs: Record<string, ChainConfig>,
  factories: Record<string, AdapterFactory>,
  allowMainnet = false,
): ChainRegistry {
  const registry = new Map<string, ChainAdapter>();
  for (const [name, config] of Object.entries(configs)) {
    const problem = validateChainConfig(name, config, allowMainnet);
    if (problem) throw new Error(problem);
    const factory = factories[config.family];
    if (!factory) throw new Error(`${name}: no adapter for family ${config.family}`);
    registry.set(name, factory(name, config));
  }
  return registry;
}
