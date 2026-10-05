#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator CLI for the optional marketplace extension. Every command is either
 * offline (keys, signing with a key FILE the operator controls, verification)
 * or a read-only chain query. Nothing here sends a transaction: `anchor-tx`
 * prints an unsigned transaction for the operator's own wallet.
 *
 *   bun run cli.ts keygen <out.pem>
 *   bun run cli.ts publish <payload-dir> <publish-spec.json> --key <publisher.pem>
 *   bun run cli.ts verify <bundle-dir>
 *   bun run cli.ts issue --key <pem> --artifact <id> --tiers a,b --licensee <label>
 *                        [--days 365] [--versions '^1.0.0'] [--audience host1,host2]
 *   bun run cli.ts plan-import <bundle-dir> [--slices core,standard] [--proof proof.json]
 *   bun run cli.ts statement --artifact <id> --tiers a,b --chain <name> --address 0x…
 *                        [--audience import|<host>] [--hours 1]
 *   bun run cli.ts anchor-tx <bundle-dir> --chain <name>
 *   bun run cli.ts read-anchor --chain <name> --artifact <id> --version <v>
 *   bun run cli.ts resolve-settlement --chain <name> --tx 0x… --licensee 0x… --artifact <id> --tier <t>
 *   bun run cli.ts audit-verify
 *
 * Config: `--config <file>` or `MARINA_MARKET_CONFIG`.
 */

import { generateKeyPairSync } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { verifyAuditLog } from "./src/audit";
import { licenceStatement } from "./src/chain/evm";
import { buildRuntime, type MarketRuntime, readPrivateJson } from "./src/config";
import { issueEntitlement } from "./src/entitlements";
import { keyIdOf, openBundle } from "./src/envelope";
import { applyPlan, planImport } from "./src/importer";
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

/** A private key file must be the operator's alone. Its contents are never printed. */
function readKeyFile(path: string): string {
  if (statSync(path).mode & 0o077) throw new Error(`${path} must be mode 600`);
  return readFileSync(path, "utf8");
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

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { positional, opts } = flags(rest);
  switch (command) {
    case "keygen": {
      const out = need(positional[0], "<out.pem>");
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      writeFileSync(out, privateKey.export({ format: "pem", type: "pkcs8" }), {
        mode: 0o600,
        flag: "wx",
      });
      const spki = Buffer.from(publicKey.export({ format: "der", type: "spki" })).toString(
        "base64",
      );
      // Only the PUBLIC key is printed: pin it in importers' configs.
      return print({ public_key: spki, key_id: keyIdOf(spki), private_key_file: out });
    }
    case "publish": {
      const spec = JSON.parse(
        readFileSync(need(positional[1], "<publish-spec.json>"), "utf8"),
      ) as WorldPublishSpec;
      const result = publishWorld(
        need(positional[0], "<payload-dir>"),
        spec,
        readKeyFile(need(opts.key, "--key")),
      );
      return print({
        artifact_id: result.manifest.artifact_id,
        version: result.manifest.version,
        manifest_digest: result.manifestDigest,
      });
    }
    case "verify": {
      const rt = runtime(opts);
      const bundle = openBundle(need(positional[0], "<bundle-dir>"), rt.pinned);
      rt.audit.append(
        "bundle.verify",
        "allowed",
        { digest: bundle.manifestDigest },
        bundle.manifest.artifact_id,
      );
      return print({
        artifact_id: bundle.manifest.artifact_id,
        version: bundle.manifest.version,
        publisher: bundle.manifest.publisher.name,
        license: bundle.manifest.license,
        slices: bundle.manifest.slices.map((s) => ({
          id: s.id,
          access: s.access ?? bundle.manifest.access.model,
        })),
        manifest_digest: bundle.manifestDigest,
      });
    }
    case "issue": {
      const days = Number(opts.days ?? 365);
      const token = issueEntitlement(
        {
          artifact_id: need(opts.artifact, "--artifact"),
          version_range: opts.versions ?? "*",
          tiers: need(opts.tiers, "--tiers").split(","),
          licensee: { label: need(opts.licensee, "--licensee") },
          audience: opts.audience ? opts.audience.split(",") : undefined,
          not_after: new Date(Date.now() + days * 86_400_000).toISOString(),
        },
        readKeyFile(need(opts.key, "--key")),
      );
      return print({ kind: "token", token });
    }
    case "plan-import": {
      const rt = runtime(opts);
      const proof = opts.proof ? readPrivateJson(opts.proof) : undefined;
      const dir = need(positional[0], "<bundle-dir>");
      const plan = await planImport(dir, { slices: opts.slices?.split(","), proof }, rt);
      print(plan);
      if (opts.apply === "true") print(await applyPlan(dir, plan, rt.audit));
      return;
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
      const bundle = openBundle(need(positional[0], "<bundle-dir>"), rt.pinned);
      const tx = await chain(rt, opts.chain).anchor({
        artifactId: bundle.manifest.artifact_id,
        version: bundle.manifest.version,
        manifestDigest: bundle.manifestDigest,
      });
      rt.audit.append(
        "anchor.prepare",
        "info",
        { chain: opts.chain, digest: bundle.manifestDigest },
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
        "usage: cli.ts keygen|publish|verify|issue|plan-import|statement|anchor-tx|read-anchor|resolve-settlement|audit-verify",
      );
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`marina-market: ${(error as Error).message}\n`);
    process.exit(1);
  });
}

export { main };
