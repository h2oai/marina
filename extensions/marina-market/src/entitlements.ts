// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Entitlements: proof that a licensee may use the PAID tiers of an artifact.
 * Two interchangeable verifiers sit behind one interface:
 *
 *   - `token` (default, decision D-19): a publisher-signed `marina.entitlement.v1`
 *     document, verified offline against PINNED publisher keys. No chain, no
 *     network, works air-gapped.
 *   - `evm-wallet`: the licensee signs a short statement in THEIR OWN wallet
 *     (EIP-191 personal_sign); Marina recovers the address and asks a configured
 *     chain, read-only, whether that address holds the licence token. See
 *     `chain/`.
 *
 * Nothing here runs for open (free) tiers: callers check entitlements only when
 * a user chooses to import or join a paid tier. Marina never holds a wallet key.
 */

import { randomBytes } from "node:crypto";
import type { FederationSignature } from "../../../src/net/federation-crypto";
import type { ChainRegistry } from "./chain/adapter";
import { parseLicenceStatement, recoverPersonalSigner } from "./chain/evm";
import { keyIdOf, type PinnedKey, signWithKey, verifyPinned } from "./envelope";

export const ENTITLEMENT_SCHEMA = "marina.entitlement.v1";

export interface EntitlementToken {
  schema: typeof ENTITLEMENT_SCHEMA;
  artifact_id: string;
  /** Semver range of artifact versions covered (`^1.0.0`, `>=1.2.0 <2.0.0`, `*`). */
  version_range: string;
  /** Paid tiers (slice ids) granted. */
  tiers: string[];
  /** Who it is for. Labels only; never a human's private data. */
  licensee: { label: string; key_id?: string; address?: string };
  /** Host world names that may accept it for federation; absent ⇒ import only. */
  audience?: string[];
  issued_at: string;
  not_before?: string;
  not_after: string;
  /** Unique id, also the revocation handle. */
  nonce: string;
  signature?: FederationSignature;
}

export interface EntitlementContext {
  artifactId: string;
  version: string;
  /** The paid tiers being requested. */
  tiers: string[];
  purpose: "import" | "federation";
  /** For federation: this host's world name, which the proof must name. */
  audience?: string;
  now: Date;
  /** Extra issuer key ids the artifact manifest allows (`access.entitlement_issuers`). */
  allowedIssuers?: readonly string[];
}

export type EntitlementDecision =
  | {
      ok: true;
      verifier: string;
      tiers: string[];
      licensee: string;
      expiresAt?: string;
      evidence: Record<string, unknown>;
    }
  | { ok: false; verifier: string; reason: string };

export interface EntitlementVerifier {
  readonly kind: string;
  verify(proof: unknown, context: EntitlementContext): Promise<EntitlementDecision>;
}

/** The publisher key id is part of the artifact URN (`marina-world:<key id>/<name>`). */
export function publisherKeyIdOf(artifactId: string): string | null {
  const match = /^marina-(?:memory|world):(sha256:[0-9a-f]{64})\//.exec(artifactId);
  return match ? match[1]! : null;
}

function covers(granted: string[], requested: string[]): string[] {
  return requested.filter((tier) => !granted.includes(tier));
}

/** Issue a token (publisher-side tool; the key file is the operator's, used once). */
export function issueEntitlement(
  fields: Omit<EntitlementToken, "schema" | "signature" | "nonce" | "issued_at"> & {
    nonce?: string;
    issued_at?: string;
  },
  publisherKeyPem: string,
): EntitlementToken {
  const token: EntitlementToken = {
    schema: ENTITLEMENT_SCHEMA,
    ...fields,
    issued_at: fields.issued_at ?? new Date().toISOString(),
    nonce: fields.nonce ?? randomBytes(16).toString("hex"),
  };
  return {
    ...token,
    signature: signWithKey(token as unknown as Record<string, unknown>, publisherKeyPem),
  };
}

/** Offline, publisher-signed token verifier (D-19). Pure: no I/O. */
export class OfflineTokenVerifier implements EntitlementVerifier {
  readonly kind = "token";
  constructor(
    private readonly pinned: readonly PinnedKey[],
    private readonly revokedNonces: ReadonlySet<string> = new Set(),
  ) {}

  async verify(proof: unknown, ctx: EntitlementContext): Promise<EntitlementDecision> {
    const refuse = (reason: string): EntitlementDecision => ({
      ok: false,
      verifier: this.kind,
      reason,
    });
    const token = (proof as { token?: EntitlementToken })?.token;
    if (!token || token.schema !== ENTITLEMENT_SCHEMA)
      return refuse("not a marina.entitlement.v1 token");
    const { signature, ...unsigned } = token;
    const verified = verifyPinned(
      unsigned as unknown as Record<string, unknown>,
      signature,
      this.pinned,
    );
    if (!verified.ok) return refuse(`signature: ${verified.error}`);
    const publisherKey = publisherKeyIdOf(ctx.artifactId);
    const issuers = new Set([publisherKey, ...(ctx.allowedIssuers ?? [])]);
    if (!issuers.has(verified.keyId))
      return refuse("issuer is not the publisher or an allowed issuer");
    if (token.artifact_id !== ctx.artifactId) return refuse("token is for a different artifact");
    if (!Bun.semver.satisfies(ctx.version, token.version_range))
      return refuse(`version ${ctx.version} outside ${token.version_range}`);
    const missing = covers(token.tiers ?? [], ctx.tiers);
    if (missing.length) return refuse(`tiers not granted: ${missing.join(",")}`);
    const now = ctx.now.getTime();
    const notAfter = Date.parse(token.not_after);
    if (!Number.isFinite(notAfter) || now > notAfter) return refuse("token expired");
    if (token.not_before && now < Date.parse(token.not_before))
      return refuse("token not yet valid");
    if (this.revokedNonces.has(token.nonce)) return refuse("token revoked");
    if (ctx.purpose === "federation" && !(token.audience ?? []).includes(ctx.audience ?? "\u0000"))
      return refuse("token does not name this host as audience");
    return {
      ok: true,
      verifier: this.kind,
      tiers: token.tiers,
      licensee: token.licensee?.label ?? "unlabelled",
      expiresAt: token.not_after,
      evidence: { issuer: verified.keyId, nonce: token.nonce },
    };
  }
}

/**
 * Wallet-signed proof checked against an on-chain licence, read-only.
 * Proof: `{ kind: "evm-wallet", chain, message, signature }` where `message` is
 * the licence statement (see `chain/evm.ts` `licenceStatement`) the licensee
 * signed in their own wallet.
 */
export class WalletLicenceVerifier implements EntitlementVerifier {
  readonly kind = "evm-wallet";
  constructor(
    private readonly chains: ChainRegistry,
    private readonly maxProofAgeMs = 24 * 60 * 60 * 1000,
  ) {}

  async verify(proof: unknown, ctx: EntitlementContext): Promise<EntitlementDecision> {
    const refuse = (reason: string): EntitlementDecision => ({
      ok: false,
      verifier: this.kind,
      reason,
    });
    const p = proof as { chain?: unknown; message?: unknown; signature?: unknown };
    if (
      typeof p?.chain !== "string" ||
      typeof p.message !== "string" ||
      typeof p.signature !== "string"
    )
      return refuse("proof needs chain, message and signature");
    const adapter = this.chains.get(p.chain);
    if (!adapter) return refuse(`chain ${p.chain} is not configured`);
    const statement = parseLicenceStatement(p.message);
    if (!statement) return refuse("message is not a Marina licence statement");
    let signer: string;
    try {
      signer = recoverPersonalSigner(p.message, p.signature);
    } catch {
      return refuse("signature does not recover");
    }
    if (signer !== statement.address) return refuse("signature is not from the stated address");
    if (statement.artifactId !== ctx.artifactId)
      return refuse("statement is for a different artifact");
    if (String(statement.chainId) !== String(adapter.chainId))
      return refuse("statement names a different chain");
    const now = ctx.now.getTime();
    const issued = Date.parse(statement.issuedAt);
    const expires = Date.parse(statement.expiresAt);
    if (!(issued <= now && now <= expires) || expires - issued > this.maxProofAgeMs)
      return refuse("statement expired or its lifetime is too long");
    const purposeAudience = ctx.purpose === "federation" ? ctx.audience : "import";
    if (statement.audience !== purposeAudience)
      return refuse("statement names a different audience");
    const missing = covers(statement.tiers, ctx.tiers);
    if (missing.length) return refuse(`statement does not request tiers: ${missing.join(",")}`);
    const holding = await adapter.verifyEntitlement({
      holder: signer,
      artifactId: ctx.artifactId,
      tiers: ctx.tiers,
    });
    if (!holding.ok) return refuse(holding.reason);
    return {
      ok: true,
      verifier: this.kind,
      tiers: ctx.tiers,
      licensee: signer,
      expiresAt: statement.expiresAt,
      evidence: { chain: p.chain, chain_id: adapter.chainId, block: holding.block, holder: signer },
    };
  }
}

/** Dispatch a proof to the verifier for its kind (`token` | `evm-wallet`). */
export async function verifyEntitlement(
  proof: unknown,
  ctx: EntitlementContext,
  verifiers: readonly EntitlementVerifier[],
): Promise<EntitlementDecision> {
  const kind = (proof as { kind?: unknown })?.kind;
  const verifier = verifiers.find((v) => v.kind === kind);
  if (!verifier)
    return { ok: false, verifier: String(kind), reason: "no verifier for this proof kind" };
  try {
    return await verifier.verify(proof, ctx);
  } catch (error) {
    // Fail closed: a verifier fault never grants anything.
    return {
      ok: false,
      verifier: verifier.kind,
      reason: `verifier error: ${(error as Error).message}`,
    };
  }
}

export { keyIdOf };
