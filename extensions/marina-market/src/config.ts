// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator configuration, one JSON file named by `MARINA_MARKET_CONFIG` (or
 * `--config` for the CLI). Nothing is read from the network; no key material
 * is configured here — only PUBLIC publisher keys to pin, chain endpoints to
 * read from, and paths.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { AuditLog } from "./audit";
import { type ChainConfig, type ChainRegistry, createChainRegistry } from "./chain/adapter";
import { evmAdapterFactory } from "./chain/evm";
import {
  type EntitlementVerifier,
  OfflineTokenVerifier,
  WalletLicenceVerifier,
} from "./entitlements";
import { keyIdOf, type PinnedKey } from "./envelope";

export interface HostedWorldConfig {
  artifact_id: string;
  version: string;
  /** Paid tiers a joining gateway peer must hold. */
  tiers: string[];
  /** This host's world name; proofs must name it (anti-replay across hosts). */
  audience: string;
  entitlement_issuers?: string[];
}

export interface MarketConfig {
  publishers: PinnedKey[];
  audit_log: string;
  chains?: Record<string, ChainConfig>;
  allow_mainnet?: boolean;
  revoked_nonces?: string[];
  hosted_world?: HostedWorldConfig;
  /** Gateway name → proof JSON file presented when this instance joins a paid host. */
  gateway_proofs?: Record<string, string>;
  max_proof_age_hours?: number;
}

export interface MarketRuntime {
  config: MarketConfig;
  configDir: string;
  pinned: PinnedKey[];
  chains: ChainRegistry;
  verifiers: EntitlementVerifier[];
  audit: AuditLog;
}

export function loadConfig(path: string): MarketConfig {
  const config = JSON.parse(readFileSync(path, "utf8")) as MarketConfig;
  if (!Array.isArray(config.publishers)) throw new Error("config: publishers[] required");
  for (const key of config.publishers) {
    if (typeof key.name !== "string" || typeof key.public_key !== "string")
      throw new Error("config: each publisher needs name and public_key");
    keyIdOf(key.public_key);
  }
  if (typeof config.audit_log !== "string") throw new Error("config: audit_log path required");
  const hosted = config.hosted_world;
  if (
    hosted &&
    (!hosted.artifact_id || !hosted.version || !hosted.audience || !hosted.tiers?.length)
  )
    throw new Error("config: hosted_world needs artifact_id, version, audience and tiers");
  return config;
}

export function resolveFrom(base: string, path: string): string {
  return isAbsolute(path) ? path : resolve(base, path);
}

export function buildRuntime(configPath: string): MarketRuntime {
  const config = loadConfig(configPath);
  const configDir = dirname(resolve(configPath));
  const chains = createChainRegistry(
    config.chains ?? {},
    { evm: evmAdapterFactory },
    config.allow_mainnet === true,
  );
  const verifiers: EntitlementVerifier[] = [
    new OfflineTokenVerifier(config.publishers, new Set(config.revoked_nonces ?? [])),
  ];
  if (chains.size)
    verifiers.push(
      new WalletLicenceVerifier(chains, (config.max_proof_age_hours ?? 24) * 60 * 60 * 1000),
    );
  return {
    config,
    configDir,
    pinned: config.publishers,
    chains,
    verifiers,
    audit: new AuditLog(resolveFrom(configDir, config.audit_log)),
  };
}

/** Proof files are bearer-like within their audience: refuse group/world-readable ones. */
export function readPrivateJson(path: string): unknown {
  const mode = statSync(path).mode & 0o077;
  if (mode) throw new Error(`${path} must not be group/world readable (chmod 600)`);
  return JSON.parse(readFileSync(path, "utf8"));
}
