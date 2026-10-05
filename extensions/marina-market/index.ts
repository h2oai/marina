// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `marina-market` server extension. Loaded only when an operator lists it in
 * `MARINA_PLUGINS`; Marina without it behaves exactly as before.
 *
 * In-world surface is READ-ONLY (`market status`, `market audit`): publishing,
 * issuing entitlements and import planning are operator acts through `cli.ts`,
 * mirroring `learned import` being an operator script. When the config names a
 * hosted paid world, the extension registers the core's gateway admission
 * hook; when it names gateway proofs, it registers the proof provider.
 */

import type { ExtensionContext, MarinaExtension } from "../../src/sdk/extensions";
import { verifyAuditLog } from "./src/audit";
import { buildRuntime, type MarketRuntime } from "./src/config";
import { createGatewayAdmission, createGatewayProofProvider } from "./src/federation";

function statusText(runtime: MarketRuntime | undefined, problem?: string): string {
  if (!runtime)
    return `market: not configured${problem ? ` (${problem})` : ""}. Set MARINA_MARKET_CONFIG to enable paid-artifact checks; free use needs nothing.`;
  const { config } = runtime;
  const head = runtime.audit.head();
  const lines = [
    "market: enabled (optional extension; the core never depends on it)",
    `pinned publishers: ${config.publishers.map((p) => p.name).join(", ") || "none"}`,
    `chains (read-only): ${[...runtime.chains.keys()].join(", ") || "none — offline tokens only"}`,
    `audit log: ${head.seq} entries, head ${head.hash.slice(0, 12)}`,
  ];
  if (config.hosted_world) {
    lines.push(
      `hosting paid world ${config.hosted_world.artifact_id}@${config.hosted_world.version} (tiers ${config.hosted_world.tiers.join(",")}): gateway peers need an entitlement`,
    );
    if (process.env.MARINA_AUTH !== "better-auth")
      lines.push(
        "warning: like GATEWAY_SECRET, this gates the gateway handshake only; with open name login a remote can still join as an ordinary entity. Set MARINA_AUTH=better-auth for a hard boundary.",
      );
  }
  return lines.join("\n");
}

const extension: MarinaExtension = {
  activate(context: ExtensionContext) {
    const configPath = process.env.MARINA_MARKET_CONFIG?.trim();
    let runtime: MarketRuntime | undefined;
    let problem: string | undefined;
    if (configPath) {
      // A broken config fails startup loudly rather than silently disabling a paywall
      // the operator believes is active.
      runtime = buildRuntime(configPath);
    } else problem = "MARINA_MARKET_CONFIG unset";

    context.registerCommand({
      name: "market",
      help: "Optional marketplace extension: entitlement and licence status (read-only).",
      category: "Extensions",
      minRank: 0,
      usage: [
        {
          syntax: "market status",
          effect: "read",
          description: "What this instance checks, and where it is audited",
        },
        {
          syntax: "market audit",
          effect: "read",
          description: "Verify the audit log hash chain (reveals no entries)",
        },
      ],
      run(ctx, args) {
        const sub = args.trim().split(/\s+/)[0] || "status";
        if (sub === "status") return ctx.reply(statusText(runtime, problem));
        if (sub === "audit") {
          if (!runtime) return ctx.reply(statusText(runtime, problem));
          const result = verifyAuditLog(runtime.audit.path);
          return ctx.reply(
            result.ok
              ? `market audit: chain intact (${result.entries} entries)`
              : `market audit: chain BROKEN at entry ${result.seq}`,
          );
        }
        ctx.reply("Usage: market status | market audit");
      },
    });

    if (!runtime) return;
    const admission = createGatewayAdmission(runtime);
    if (admission) {
      if (!context.registerGatewayAdmission)
        throw new Error("marina-market: this Marina build has no gateway admission hook");
      context.registerGatewayAdmission(admission);
    }
    const proofs = createGatewayProofProvider(runtime);
    if (proofs) context.registerGatewayProof?.(proofs);
  },
};

export default extension;
