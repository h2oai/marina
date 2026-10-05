#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator CLI for the optional marketplace extension. Bundle keys, signing,
 * verification and entitlement tokens are the core's (`bun run learned
 * keygen|entitle|verify`); this CLI adds what is marketplace-only:
 *
 *   bun run cli.ts publish <payload-dir> <out-dir> <publish-spec.json> --key-file <key>
 *   bun run cli.ts import <bundle-dir> [--slices a,b] [--proof proof.json]   (DB_PATH, MARINA_UPSTREAM=on)
 *   bun run cli.ts statement --chain <name> --artifact <id> --tiers a,b --address 0x…
 *                            [--audience import|<host>] [--hours 1]
 *   bun run cli.ts anchor-tx <bundle-dir> --chain <name>     (unsigned; sign in your own wallet)
 *   bun run cli.ts read-anchor --chain <name> --artifact <id> --version <v>
 *   bun run cli.ts resolve-settlement --chain <name> --tx 0x… --licensee 0x… --artifact <id> --tier <t>
 *   bun run cli.ts audit-verify
 *
 * Everything is offline or a read-only chain query; nothing here sends a
 * transaction. Config: `--config <file>` or `MARINA_MARKET_CONFIG`.
 */

import { readFileSync, statSync } from "node:fs";
import { verifyBundle } from "../../src/learned/bundle";
import { MarinaDB } from "../../src/persistence/database";
import { verifyAuditLog } from "./src/audit";
import { licenceStatement } from "./src/chain/evm";
import { buildRuntime, type MarketRuntime, readPrivateJson } from "./src/config";
import { importWithEntitlement } from "./src/importer";
import { publishWorld, type WorldPublishSpec } from "./src/world";

function flags(argv: string[]): { positional: string[]; opts: Record<string, string> } {
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=", 2);
      opts[key!] = inline ?? argv[++i] ?? "";
    } else positional.push(arg);
  }
  return { positional, opts };
}

function need(value: string | undefined, label: string): string {
  if (!value) throw new Error(`missing ${label}`);
  return value;
}

/** A signing-key file must be the operator's alone. Its contents are never printed. */
function readKeyFile(path: string): string {
  if (statSync(path).mode & 0o077) throw new Error(`${path} must be mode 600`);
  return readFileSync(path, "utf8").trim();
}

function runtime(opts: Record<string, string>): MarketRuntime {
  return buildRuntime(
    need(opts.config ?? process.env.MARINA_MARKET_CONFIG, "--config or MARINA_MARKET_CONFIG"),
  );
}

function chain(rt: MarketRuntime, name: string | undefined) {
  const adapter = rt.chains.get(need(name, "--chain"));
  if (!adapter) throw new Error(`chain ${name} is not configured`);
  return adapter;
}

function print(value: unknown): void {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

function verified(rt: MarketRuntime, dir: string) {
  const v = verifyBundle(dir, rt.pinned);
  if (!v.ok) throw new Error(`bundle refused: ${v.error}`);
  return v.bundle;
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { positional, opts } = flags(rest);
  switch (command) {
    case "publish": {
      const spec = JSON.parse(
        readFileSync(need(positional[2], "<publish-spec.json>"), "utf8"),
      ) as WorldPublishSpec;
      const result = publishWorld(
        need(positional[0], "<payload-dir>"),
        need(positional[1], "<out-dir>"),
        spec,
        readKeyFile(need(opts["key-file"], "--key-file")),
      );
      return print({
        artifact_id: result.manifest.artifact_id,
        version: result.manifest.version,
        manifest_digest: result.manifestDigest,
      });
    }
    case "import": {
      const rt = runtime(opts);
      const db = new MarinaDB(process.env.DB_PATH || "marina.db");
      try {
        const result = await importWithEntitlement(db, need(positional[0], "<bundle-dir>"), rt, {
          ...(opts.slices ? { slices: opts.slices.split(",") } : {}),
          ...(opts.proof ? { proof: readPrivateJson(opts.proof) } : {}),
          actor: opts.actor ?? "operator",
        });
        if (!result.ok) throw new Error(result.error);
        if (!result.outcome.ok) throw new Error(`import refused: ${result.outcome.error}`);
        const r = result.outcome.report;
        return print({
          artifact_id: r.artifactId,
          version: r.version,
          added: r.added,
          changed: r.changed,
          withheld: r.withheld.length,
          trust: "imported",
          entitlement: result.grant
            ? { verifier: result.grant.verifier, licensee: result.grant.licensee }
            : null,
          network_used: result.network_used,
        });
      } finally {
        db.close();
      }
    }
    case "statement": {
      const rt = runtime(opts);
      const adapter = chain(rt, opts.chain);
      const now = new Date();
      return print(
        licenceStatement({
          artifactId: need(opts.artifact, "--artifact"),
          tiers: need(opts.tiers, "--tiers").split(","),
          audience: opts.audience ?? "import",
          chainId: adapter.chainId,
          address: need(opts.address, "--address").toLowerCase(),
          issuedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + Number(opts.hours ?? 1) * 3_600_000).toISOString(),
        }),
      );
    }
    case "anchor-tx": {
      const rt = runtime(opts);
      const bundle = verified(rt, need(positional[0], "<bundle-dir>"));
      const digest = bundle.digest.replace(/^sha256:/, "");
      const tx = await chain(rt, opts.chain).anchor({
        artifactId: bundle.manifest.artifact_id,
        version: bundle.manifest.version,
        manifestDigest: digest,
      });
      rt.audit.append(
        "anchor.prepare",
        "info",
        { chain: opts.chain, digest },
        bundle.manifest.artifact_id,
      );
      return print(tx);
    }
    case "read-anchor": {
      const rt = runtime(opts);
      const digest = await chain(rt, opts.chain).readAnchor(
        need(opts.artifact, "--artifact"),
        need(opts.version, "--version"),
      );
      return print({ anchored: digest });
    }
    case "resolve-settlement": {
      const rt = runtime(opts);
      const result = await chain(rt, opts.chain).resolveSettlement({
        txHash: need(opts.tx, "--tx"),
        licensee: need(opts.licensee, "--licensee"),
        artifactId: need(opts.artifact, "--artifact"),
        tier: need(opts.tier, "--tier"),
      });
      rt.audit.append(
        "settlement.resolve",
        result.settled ? "allowed" : "refused",
        { chain: opts.chain, ...result },
        opts.artifact,
      );
      return print(result);
    }
    case "audit-verify": {
      const rt = runtime(opts);
      return print(verifyAuditLog(rt.audit.path));
    }
    default:
      throw new Error(
        "usage: cli.ts publish|import|statement|anchor-tx|read-anchor|resolve-settlement|audit-verify (keys, tokens and verify: bun run learned)",
      );
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`marina-market: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
