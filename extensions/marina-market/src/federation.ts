// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Entitlement-gated federation for HOSTED PAID worlds, through the core's
 * optional gateway hooks. Free worlds register nothing, so their handshake is
 * byte-for-byte unchanged; `GATEWAY_SECRET` is always checked first by the core
 * and keeps its meaning. Like the secret, this gates the gateway handshake only;
 * a hard boundary also needs `MARINA_AUTH=better-auth` without open login.
 */

import type { GatewayAdmissionCheck, GatewayProofProvider } from "../../../src/sdk/extensions";
import { nonceHandle } from "./audit";
import { type MarketRuntime, readPrivateJson, resolveFrom } from "./config";
import { verifyEntitlement } from "./entitlements";

export function createGatewayAdmission(runtime: MarketRuntime): GatewayAdmissionCheck | undefined {
  const hosted = runtime.config.hosted_world;
  if (!hosted) return undefined;
  return async ({ proof }) => {
    const decision = await verifyEntitlement(
      proof,
      {
        artifactId: hosted.artifact_id,
        version: hosted.version,
        tiers: hosted.tiers,
        purpose: "federation",
        audience: hosted.audience,
        now: new Date(),
        allowedIssuers: hosted.entitlement_issuers,
      },
      runtime.verifiers,
    );
    const nonce = nonceHandle((proof as { token?: { nonce?: unknown } })?.token?.nonce);
    if (!decision.ok) {
      runtime.audit.append(
        "gateway.admit",
        "refused",
        { verifier: decision.verifier, reason: decision.reason, nonce },
        hosted.artifact_id,
      );
      return { admit: false, reason: decision.reason };
    }
    runtime.audit.append(
      "gateway.admit",
      "allowed",
      { verifier: decision.verifier, licensee: decision.licensee, nonce },
      hosted.artifact_id,
    );
    return { admit: true, label: decision.licensee };
  };
}

export function createGatewayProofProvider(
  runtime: MarketRuntime,
): GatewayProofProvider | undefined {
  const proofs = runtime.config.gateway_proofs;
  if (!proofs || !Object.keys(proofs).length) return undefined;
  return ({ name }) => {
    const path = Object.hasOwn(proofs, name) ? proofs[name] : undefined;
    if (!path) return undefined;
    return readPrivateJson(resolveFrom(runtime.configDir, path));
  };
}
