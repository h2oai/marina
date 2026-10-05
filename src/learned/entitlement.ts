// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Entitlements for paid (`token`) and private slices of a `marina.learned.v1`
 * bundle. Free and open: the token format and its verifier ship in the core.
 *
 *   - A publisher (or an issuer the manifest lists) signs a
 *     `marina.entitlement.v1` token with its learned-bundle key. It is verified
 *     OFFLINE against the same pinned publisher keys as bundles
 *     (`pinnedPublisherKeys`), so a paid import works air-gapped. Payment
 *     happens outside Marina (an external checkout issues the token).
 *   - A verifier turns a proof into an `EntitlementGrant`. The importer writes a
 *     `token` item only under a grant that covers one of its slices, and a
 *     `private` item only under a grant or the operator's `own` assertion.
 *     `open` items never need one, and checking them makes no network call.
 *   - Other verifiers (an on-chain licence, in an optional extension) implement
 *     the same `EntitlementVerifier` interface.
 *
 * A token is revoked by its publisher through a signed revocation list entry
 * carrying `entitlement_nonce`.
 */

import { randomBytes } from "node:crypto";
import type { FederationSignature } from "../net/federation-crypto";
import { verifyRevocations } from "./bundle";
import type { Manifest } from "./format";
import { type PinnedKey, signLearned, verifyAgainstPinned } from "./sign";

export const ENTITLEMENT_SCHEMA = "marina.entitlement.v1";
/** The grant verifier name for an operator importing their own private pack. */
export const OWN_VERIFIER = "own";

export interface EntitlementToken {
  schema: typeof ENTITLEMENT_SCHEMA;
  artifact_id: string;
  /** Semver range of covered versions (`^1.0.0`, `>=1.2.0 <2.0.0`, `*`). */
  version_range: string;
  /** Slice ids granted (`tier:standard`, `domain:forecast`, …). */
  tiers: string[];
  /** Who it is for: a label, optionally a key id or chain address. Never personal data. */
  licensee: { label: string; key_id?: string; address?: string };
  /** Host world names that may accept it over federation; absent ⇒ import only. */
  audience?: string[];
  issued_at: string;
  not_before?: string;
  not_after: string;
  /** Unique id, also the revocation handle. */
  nonce: string;
  signature?: FederationSignature;
}

/** What the importer needs to write gated items. Produced by a verifier, never by hand. */
export interface EntitlementGrant {
  verifier: string;
  /** Slice ids covered. */
  tiers: string[];
  licensee: string;
  expires_at?: string;
  /** Token nonce, checked again against the publisher's revocation lists at import. */
  nonce?: string;
  evidence?: Record<string, unknown>;
}

export interface EntitlementContext {
  artifactId: string;
  version: string;
  /** The publisher's key id (`manifest.publisher.key_id`). */
  publisherKeyId: string;
  /** `manifest.access.entitlement_issuers`. */
  allowedIssuers?: readonly string[];
  /** The gated slices being requested. */
  tiers: string[];
  purpose: "import" | "federation";
  /** For federation: this host's world name, which the proof must name. */
  audience?: string;
  now: Date;
}

export type EntitlementDecision =
  | { ok: true; grant: EntitlementGrant }
  | { ok: false; verifier: string; reason: string };

export interface EntitlementVerifier {
  readonly kind: string;
  verify(proof: unknown, context: EntitlementContext): Promise<EntitlementDecision>;
}

/** Context for importing `tiers` of a verified manifest. */
export function importContext(manifest: Manifest, tiers: string[], now = new Date()) {
  return {
    artifactId: manifest.artifact_id,
    version: manifest.version,
    publisherKeyId: manifest.publisher.key_id,
    allowedIssuers: manifest.access?.entitlement_issuers ?? [],
    tiers,
    purpose: "import" as const,
    now,
  };
}

/** Issue a token (publisher side; `signingKey` is the learned-bundle key, used once). */
export function issueEntitlement(
  fields: Omit<EntitlementToken, "schema" | "signature" | "nonce" | "issued_at"> & {
    nonce?: string;
    issued_at?: string;
  },
  signingKey: string,
): EntitlementToken {
  const token: EntitlementToken = {
    schema: ENTITLEMENT_SCHEMA,
    ...fields,
    issued_at: fields.issued_at ?? new Date().toISOString(),
    nonce: fields.nonce ?? randomBytes(16).toString("hex"),
  };
  return {
    ...token,
    signature: signLearned(token as unknown as Record<string, unknown>, signingKey),
  };
}

/** Nonces revoked by the publisher's verified revocation lists (unverifiable lists are ignored). */
export function revokedNonces(
  docs: readonly unknown[],
  pinned: readonly PinnedKey[],
  publisherKeyId: string,
  artifactId: string,
): Set<string> {
  const out = new Set<string>();
  for (const raw of docs) {
    const v = verifyRevocations(raw, pinned);
    if (!v.ok || v.keyId !== publisherKeyId) continue;
    for (const e of v.revocations.entries)
      if (e.artifact_id === artifactId && e.entitlement_nonce) out.add(e.entitlement_nonce);
  }
  return out;
}

/** The offline, publisher-signed token verifier. Pure: no I/O. Proof: `{ kind: "token", token }`. */
export class OfflineTokenVerifier implements EntitlementVerifier {
  readonly kind = "token";
  constructor(
    private readonly pinned: readonly PinnedKey[],
    private readonly revoked: ReadonlySet<string> = new Set(),
  ) {}

  async verify(proof: unknown, ctx: EntitlementContext): Promise<EntitlementDecision> {
    const refuse = (reason: string): EntitlementDecision => ({
      ok: false,
      verifier: this.kind,
      reason,
    });
    const token = (proof as { token?: EntitlementToken } | null)?.token;
    if (!token || token.schema !== ENTITLEMENT_SCHEMA)
      return refuse(`not a ${ENTITLEMENT_SCHEMA} token`);
    const { signature, ...unsigned } = token;
    const v = verifyAgainstPinned(
      unsigned as unknown as Record<string, unknown>,
      signature,
      this.pinned,
    );
    if (!v.ok) return refuse(`signature: ${v.error}`);
    const issuers = new Set([ctx.publisherKeyId, ...(ctx.allowedIssuers ?? [])]);
    if (!issuers.has(v.keyId)) return refuse("issuer is not the publisher or a listed issuer");
    if (token.artifact_id !== ctx.artifactId) return refuse("token is for a different artifact");
    if (
      typeof token.version_range !== "string" ||
      !Bun.semver.satisfies(ctx.version, token.version_range)
    )
      return refuse(`version ${ctx.version} is outside ${token.version_range}`);
    const granted = Array.isArray(token.tiers) ? token.tiers : [];
    const missing = ctx.tiers.filter((t) => !granted.includes(t));
    if (missing.length) return refuse(`slices not granted: ${missing.join(", ")}`);
    const now = ctx.now.getTime();
    const notAfter = Date.parse(token.not_after);
    if (!Number.isFinite(notAfter) || now > notAfter) return refuse("token expired");
    if (token.not_before && !(now >= Date.parse(token.not_before)))
      return refuse("token not yet valid");
    if (typeof token.nonce !== "string" || !token.nonce) return refuse("token has no nonce");
    if (this.revoked.has(token.nonce)) return refuse("token revoked by its publisher");
    if (ctx.purpose === "federation" && !(token.audience ?? []).includes(ctx.audience ?? "\u0000"))
      return refuse("token does not name this host as audience");
    return {
      ok: true,
      grant: {
        verifier: this.kind,
        tiers: granted,
        licensee: token.licensee?.label ?? "unlabelled",
        expires_at: token.not_after,
        nonce: token.nonce,
        evidence: { issuer: v.keyId },
      },
    };
  }
}

/** Dispatch a proof to the verifier for its `kind`. A verifier fault refuses (fails closed). */
export async function verifyEntitlement(
  proof: unknown,
  ctx: EntitlementContext,
  verifiers: readonly EntitlementVerifier[],
): Promise<EntitlementDecision> {
  const kind = (proof as { kind?: unknown } | null)?.kind;
  const verifier = verifiers.find((v) => v.kind === kind);
  if (!verifier)
    return { ok: false, verifier: String(kind), reason: "no verifier for this proof kind" };
  try {
    return await verifier.verify(proof, ctx);
  } catch (err) {
    return {
      ok: false,
      verifier: verifier.kind,
      reason: `verifier error: ${(err as Error).message}`,
    };
  }
}

/**
 * The operator's explicit assertion that a `private` bundle is their own
 * (an internal move or backup). It never covers a `token` slice.
 */
export function ownBundleGrant(actor: string): EntitlementGrant {
  return { verifier: OWN_VERIFIER, tiers: [], licensee: actor };
}
