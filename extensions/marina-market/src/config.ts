// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator configuration, one JSON file named by `MARINA_MARKET_CONFIG` (or
 * `--config` for the CLI). Nothing is read from the network; no private key is
 * configured here — only PUBLIC publisher keys (added to the core's pinned
 * keys, `MARINA_LEARNED_PUBLISHER_KEYS`), chain endpoints to read from, and paths.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { readRevocationsFile, verifyBundle } from "../../../src/learned/bundle";
import {
  type EntitlementVerifier,
  OfflineTokenVerifier,
  revokedNonces,
} from "../../../src/learned/entitlement";
import type { Manifest } from "../../../src/learned/format";
import { type PinnedKey, parsePinnedKeys, pinnedPublisherKeys } from "../../../src/learned/sign";
import { AuditLog } from "./audit";
import { type ChainConfig, type ChainRegistry, createChainRegistry } from "./chain/adapter";
import { evmAdapterFactory } from "./chain/evm";
import { WalletLicenceVerifier } from "./entitlements";

export interface HostedWorldConfig {
  /** The hosted world's bundle directory (verified against the pinned keys at start). */
  bundle: string;
  /** Paid slices a joining gateway peer must hold (e.g. `tier:standard`). */
  tiers: string[];
  /** This host's world name; proofs must name it (anti-replay across hosts). */
  audience: string;
}

export interface MarketConfig {
  /** Extra pinned publishers: `{name, public_key}` (base64 SPKI). */
  publishers?: Array<{ name: string; public_key: string }>;
  audit_log: string;
  chains?: Record<string, ChainConfig>;
  allow_mainnet?: boolean;
  /** Signed revocation lists (core format) whose `entitlement_nonce` entries revoke tokens. */
  revocations?: string[];
  hosted_world?: HostedWorldConfig;
  /** Gateway name → proof JSON file presented when this instance joins a paid host. */
  gateway_proofs?: Record<string, string>;
  max_proof_age_hours?: number;
}

export interface HostedWorld {
  manifest: Manifest;
  tiers: string[];
  audience: string;
  revoked: Set<string>;
}

export interface MarketRuntime {
  config: MarketConfig;
  configDir: string;
  pinned: PinnedKey[];
  chains: ChainRegistry;
  revocations: unknown[];
  /** Verifiers for a manifest (token revocations are per publisher and artifact). */
  verifiersFor(manifest: Manifest): EntitlementVerifier[];
  hosted?: HostedWorld;
  audit: AuditLog;
}

export function loadConfig(path: string): MarketConfig {
  const config = JSON.parse(readFileSync(path, "utf8")) as MarketConfig;
  if (typeof config.audit_log !== "string") throw new Error("config: audit_log path required");
  for (const p of config.publishers ?? [])
    if (typeof p.name !== "string" || typeof p.public_key !== "string")
      throw new Error("config: each publisher needs name and public_key");
  const hosted = config.hosted_world;
  if (hosted && (!hosted.bundle || !hosted.audience || !hosted.tiers?.length))
    throw new Error("config: hosted_world needs bundle, audience and tiers");
  return config;
}

export function resolveFrom(base: string, path: string): string {
  return isAbsolute(path) ? path : resolve(base, path);
}

export function buildRuntime(configPath: string): MarketRuntime {
  const config = loadConfig(configPath);
  const configDir = dirname(resolve(configPath));
  const extra = parsePinnedKeys(
    (config.publishers ?? []).map((p) => `${p.name}=${p.public_key}`).join(","),
  );
  if (extra.length !== (config.publishers ?? []).length)
    throw new Error("config: a publisher public_key is not an Ed25519 SPKI key");
  const pinned = [...pinnedPublisherKeys(), ...extra];
  const chains = createChainRegistry(
    config.chains ?? {},
    { evm: evmAdapterFactory },
    config.allow_mainnet === true,
  );
  const revocations = (config.revocations ?? []).map((p) =>
    readRevocationsFile(resolveFrom(configDir, p)),
  );
  const maxAge = (config.max_proof_age_hours ?? 24) * 60 * 60 * 1000;
  const verifiersFor = (manifest: Manifest): EntitlementVerifier[] => {
    const list: EntitlementVerifier[] = [
      new OfflineTokenVerifier(
        pinned,
        revokedNonces(revocations, pinned, manifest.publisher.key_id, manifest.artifact_id),
      ),
    ];
    if (chains.size) list.push(new WalletLicenceVerifier(chains, maxAge));
    return list;
  };
  let hosted: HostedWorld | undefined;
  if (config.hosted_world) {
    // A paywall the operator believes is active must not silently disappear:
    // an unverifiable hosted bundle fails startup.
    const v = verifyBundle(resolveFrom(configDir, config.hosted_world.bundle), pinned);
    if (!v.ok) throw new Error(`hosted_world bundle refused: ${v.error}`);
    const m = v.bundle.manifest;
    for (const t of config.hosted_world.tiers)
      if (!m.slices.some((s) => s.id === t)) throw new Error(`hosted_world: no slice ${t}`);
    hosted = {
      manifest: m,
      tiers: config.hosted_world.tiers,
      audience: config.hosted_world.audience,
      revoked: revokedNonces(revocations, pinned, m.publisher.key_id, m.artifact_id),
    };
  }
  return {
    config,
    configDir,
    pinned,
    chains,
    revocations,
    verifiersFor,
    ...(hosted ? { hosted } : {}),
    audit: new AuditLog(resolveFrom(configDir, config.audit_log)),
  };
}

/** Proof files are bearer-like within their audience: refuse group/world-readable ones. */
export function readPrivateJson(path: string): unknown {
  const mode = statSync(path).mode & 0o077;
  if (mode) throw new Error(`${path} must not be group/world readable (chmod 600)`);
  return JSON.parse(readFileSync(path, "utf8"));
}
