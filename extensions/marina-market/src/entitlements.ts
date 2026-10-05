// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The on-chain entitlement verifier. It implements the core
 * `EntitlementVerifier` interface (`src/learned/entitlement.ts`) alongside the
 * core's offline token verifier, so a wallet proof and a publisher-signed
 * token produce the same kind of grant for the core importer.
 *
 * Proof: `{ kind: "evm-wallet", chain, message, signature }`. The licensee signs
 * the licence statement (`chain/evm.ts` `licenceStatement`) in THEIR OWN wallet;
 * Marina recovers the address and asks the configured chain, read-only,
 * whether that address holds the licence for every requested slice. Marina
 * never holds a wallet key.
 */

import type {
  EntitlementContext,
  EntitlementDecision,
  EntitlementVerifier,
} from "../../../src/learned/entitlement";
import type { ChainRegistry } from "./chain/adapter";
import { parseLicenceStatement, recoverPersonalSigner } from "./chain/evm";

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
    const p = proof as { chain?: unknown; message?: unknown; signature?: unknown } | null;
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
    const audience = ctx.purpose === "federation" ? ctx.audience : "import";
    if (statement.audience !== audience) return refuse("statement names a different audience");
    const missing = ctx.tiers.filter((t) => !statement.tiers.includes(t));
    if (missing.length) return refuse(`statement does not request: ${missing.join(", ")}`);
    const holding = await adapter.verifyEntitlement({
      holder: signer,
      artifactId: ctx.artifactId,
      tiers: ctx.tiers,
    });
    if (!holding.ok) return refuse(holding.reason);
    return {
      ok: true,
      grant: {
        verifier: this.kind,
        tiers: ctx.tiers,
        licensee: signer,
        expires_at: statement.expiresAt,
        evidence: { chain: p.chain, chain_id: adapter.chainId, block: holding.block },
      },
    };
  }
}
