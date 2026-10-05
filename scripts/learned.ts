#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Learned bundles (`marina.learned.v1`, docs/guides/learned-bundles.md) — an
 * operator script; reading and writing bundle files is never an in-world act.
 *
 *   DB_PATH=marina.db bun run learned export --out <dir> --name <name> --publisher <name>
 *       [--profile internal|public] [--version X.Y.Z] [--parent <dir>] [--description T]
 *       [--publisher-url U] [--open] [--open-slice tier:core]... [--terms-url U]
 *       [--terms-file F] [--family name=bench1,bench2]... [--bench-corpus <path>]...
 *       [--instance-token T]... [--key-file F]
 *   DB_PATH=marina.db bun run learned import <dir> [--revocations <file>]... [--actor A]
 *       [--bench-corpus <path>]... [--slices id,id] [--entitlement <token.json>] [--own]
 *   bun run learned entitle --artifact <id> --tiers <slice,slice> --licensee <label>
 *       [--versions <range>] [--days N] [--audience host,host] [--key-file F]
 *                                        sign an entitlement token (publisher key)
 *   bun run learned verify <dir> [--revocations <file>]...
 *   bun run learned diff <old-dir> <new-dir>
 *   bun run learned keygen <path>        a new Ed25519 key (0600) for YOUR instance; prints
 *                                        the public half to pin elsewhere
 *
 * Signing uses the dedicated MARINA_LEARNED_SIGNING_KEY (or --key-file), never
 * the federation or arena key. Verification uses only pinned publisher keys
 * (MARINA_LEARNED_PUBLISHER_KEYS plus the keys pinned in source). Import needs
 * MARINA_UPSTREAM=on. Licence: proprietary unless --open (whole bundle,
 * CC-BY-4.0) or --open-slice (e.g. the core tier only).
 *
 * Access at import: open slices need nothing. A paid (`token`) slice needs
 * --entitlement, a publisher-signed token verified offline against the pinned
 * keys. A `private` slice needs a token or --own (the operator's assertion that
 * the pack is their own). Without either, only open items are written.
 */

import { closeSync, existsSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { version as MARINA_VERSION } from "../package.json";
import { verifyBundle, verifyRevocations } from "../src/learned/bundle";
import {
  type EntitlementGrant,
  importContext,
  issueEntitlement,
  OfflineTokenVerifier,
  ownBundleGrant,
  revokedNonces,
  verifyEntitlement,
} from "../src/learned/entitlement";
import { exportLearnedBundle } from "../src/learned/export";
import { diffItems, renderDiff, sha256Hex } from "../src/learned/format";
import { importLearnedBundle } from "../src/learned/import";
import { BenchmarkTextIndex, DEFAULT_BENCHMARK_CORPORA } from "../src/learned/scan";
import { generateLearnedKeyPair, pinnedPublisherKeys } from "../src/learned/sign";
import { MarinaDB } from "../src/persistence/database";

const REPO_ROOT = join(import.meta.dir, "..");

function usage(): never {
  console.error(
    "usage: bun run learned export|import|entitle|verify|diff|keygen … (see scripts/learned.ts)",
  );
  process.exit(2);
}

function signingKey(keyFile: string | undefined): string {
  if (keyFile) return readFileSync(keyFile, "utf8").trim();
  const key = process.env.MARINA_LEARNED_SIGNING_KEY?.trim();
  if (!key) throw new Error("set MARINA_LEARNED_SIGNING_KEY (or pass --key-file) to sign");
  return key;
}

function benchmarkIndex(paths: readonly string[] | undefined): BenchmarkTextIndex {
  const index = new BenchmarkTextIndex();
  const list = paths?.length ? paths : DEFAULT_BENCHMARK_CORPORA.map((p) => join(REPO_ROOT, p));
  for (const p of list) index.addPath(p);
  return index;
}

function families(entries: readonly string[] | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const e of entries ?? []) {
    const eq = e.indexOf("=");
    if (eq <= 0) throw new Error(`--family wants name=bench1,bench2 (got ${e})`);
    out[e.slice(0, eq)] = e
      .slice(eq + 1)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return out;
}

function readRevocations(paths: readonly string[] | undefined): unknown[] {
  return (paths ?? []).map((p) => JSON.parse(readFileSync(p, "utf8")) as unknown);
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      out: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      version: { type: "string" },
      profile: { type: "string" },
      publisher: { type: "string" },
      "publisher-url": { type: "string" },
      parent: { type: "string" },
      open: { type: "boolean" },
      "open-slice": { type: "string", multiple: true },
      "terms-url": { type: "string" },
      "terms-file": { type: "string" },
      family: { type: "string", multiple: true },
      "bench-corpus": { type: "string", multiple: true },
      "instance-token": { type: "string", multiple: true },
      "key-file": { type: "string" },
      revocations: { type: "string", multiple: true },
      actor: { type: "string" },
      slices: { type: "string" },
      entitlement: { type: "string" },
      own: { type: "boolean" },
      artifact: { type: "string" },
      tiers: { type: "string" },
      licensee: { type: "string" },
      versions: { type: "string" },
      days: { type: "string" },
      audience: { type: "string" },
    },
  });
  const [cmd, a, b] = positionals;
  const dbPath = process.env.DB_PATH || "marina.db";
  switch (cmd) {
    case "export": {
      if (!values.out || !values.name || !values.publisher)
        throw new Error("export needs --out, --name and --publisher");
      const profile = values.profile ?? "internal";
      if (profile !== "internal" && profile !== "public")
        throw new Error("--profile is internal or public");
      if (existsSync(join(values.out, "manifest.json")))
        throw new Error(`${values.out} already holds a bundle — export to a new directory`);
      const index = benchmarkIndex(values["bench-corpus"]);
      if (index.corpora === 0)
        console.error(
          "warning: no benchmark dataset cache found — the benchmark-text scan has nothing to compare against (pass --bench-corpus)",
        );
      const db = new MarinaDB(dbPath);
      try {
        const result = exportLearnedBundle(db, {
          outDir: values.out,
          name: values.name,
          ...(values.description ? { description: values.description } : {}),
          ...(values.version ? { version: values.version } : {}),
          profile,
          publisher: {
            name: values.publisher,
            ...(values["publisher-url"] ? { url: values["publisher-url"] } : {}),
          },
          signingKey: signingKey(values["key-file"]),
          ...(values.parent ? { parentDir: values.parent } : {}),
          open: values.open === true,
          openSlices: values["open-slice"] ?? [],
          terms: {
            url: values["terms-url"] ?? null,
            sha256: values["terms-file"]
              ? `sha256:${sha256Hex(readFileSync(values["terms-file"]))}`
              : null,
          },
          benchmarkIndex: index,
          instanceTokens: values["instance-token"] ?? [],
          families: families(values.family),
          marinaVersion: MARINA_VERSION,
        });
        const m = result.manifest;
        console.log(
          `Exported ${m.artifact_id}@${m.version} (generation ${m.generation}, ${m.profile}, ${m.license}) to ${values.out}`,
        );
        console.log(
          `  items: ${Object.entries(m.counts)
            .map(([k, n]) => `${k} ${n}`)
            .join(", ")}`,
        );
        console.log(`  ${renderDiff(result.diff).split("\n")[0]}`);
        if (result.dropped.length) {
          console.log(`  dropped ${result.dropped.length} (never redacted):`);
          for (const d of result.dropped)
            console.log(`    ${d.reason.padEnd(14)} ${d.kind} ${d.item_key}`);
        }
      } finally {
        db.close();
      }
      return 0;
    }
    case "import": {
      if (!a) usage();
      const slices = values.slices
        ?.split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      const revocations = readRevocations(values.revocations);
      let entitlement: EntitlementGrant | undefined;
      if (values.entitlement) {
        const pinned = pinnedPublisherKeys();
        const v = verifyBundle(a, pinned);
        if (!v.ok) {
          console.error(`Refused: ${v.error}`);
          return 1;
        }
        const m = v.bundle.manifest;
        const proof = JSON.parse(readFileSync(values.entitlement, "utf8")) as unknown;
        const gated = (slices ?? m.slices.map((x) => x.id)).filter(
          (id) => m.slices.find((x) => x.id === id)?.access === "token",
        );
        const decision = await verifyEntitlement(proof, importContext(m, gated), [
          new OfflineTokenVerifier(
            pinned,
            revokedNonces(revocations, pinned, m.publisher.key_id, m.artifact_id),
          ),
        ]);
        if (!decision.ok) {
          console.error(`Refused: entitlement ${decision.verifier}: ${decision.reason}`);
          return 1;
        }
        entitlement = decision.grant;
      } else if (values.own) entitlement = ownBundleGrant(values.actor ?? "operator");
      const db = new MarinaDB(dbPath);
      try {
        const outcome = await importLearnedBundle(db, a, {
          revocations,
          ...(slices?.length ? { slices } : {}),
          ...(entitlement ? { entitlement } : {}),
          ...(values["bench-corpus"]?.length
            ? { benchmarkIndex: benchmarkIndex(values["bench-corpus"]) }
            : {}),
          actor: values.actor ?? "operator",
        });
        if (!outcome.ok) {
          console.error(`Refused: ${outcome.error}`);
          return 1;
        }
        const r = outcome.report;
        console.log(
          `Imported ${r.artifactId}@${r.version} (generation ${r.generation}): ${r.added} added, ${r.changed} changed, ${r.unchanged} unchanged, ${r.retired} retired, ${r.revoked} revoked`,
        );
        console.log(
          `  trust: imported (unconfirmed until local outcomes confirm); seeded ${r.seeded.length} empty slot(s); ${r.priors} prior(s); ${r.rolesCreated.length} role(s) created`,
        );
        for (const d of r.dropped) console.log(`  dropped ${d.item_key}: ${d.reason}`);
        if (r.withheld.length)
          console.log(
            `  withheld ${r.withheld.length} item(s): entitlement required (--entitlement, or --own for your own private pack)`,
          );
        for (const s of r.skipped) console.log(`  skipped ${s.item_key}: ${s.reason}`);
      } finally {
        db.close();
      }
      return 0;
    }
    case "entitle": {
      if (!values.artifact || !values.tiers || !values.licensee)
        throw new Error("entitle needs --artifact, --tiers and --licensee");
      const days = Number(values.days ?? 365);
      if (!(days > 0)) throw new Error("--days must be positive");
      const token = issueEntitlement(
        {
          artifact_id: values.artifact,
          version_range: values.versions ?? "*",
          tiers: values.tiers
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
          licensee: { label: values.licensee },
          ...(values.audience ? { audience: values.audience.split(",") } : {}),
          not_after: new Date(Date.now() + days * 86_400_000).toISOString(),
        },
        signingKey(values["key-file"]),
      );
      console.log(JSON.stringify({ kind: "token", token }, null, 2));
      return 0;
    }
    case "verify": {
      if (!a) usage();
      const pinned = pinnedPublisherKeys();
      const v = verifyBundle(a, pinned);
      if (!v.ok) {
        console.error(`INVALID: ${v.error}`);
        return 1;
      }
      for (const raw of readRevocations(values.revocations)) {
        const r = verifyRevocations(raw, pinned);
        if (!r.ok) {
          console.error(`INVALID revocations: ${r.error}`);
          return 1;
        }
        const hit = r.revocations.entries.find(
          (e) =>
            e.artifact_id === v.bundle.manifest.artifact_id &&
            !e.item_key &&
            (!e.version || e.version === v.bundle.manifest.version),
        );
        if (hit) {
          console.error(`REVOKED: ${hit.reason}`);
          return 1;
        }
      }
      const m = v.bundle.manifest;
      console.log(`OK ${m.artifact_id}@${m.version} generation ${m.generation}`);
      console.log(
        `  publisher ${m.publisher.name} (${v.bundle.publisherLabel}, ${m.publisher.key_id})`,
      );
      console.log(
        `  license ${m.license}; redistribution ${m.redistribution}; commercial use ${m.commercial_use}; access ${m.access.model}`,
      );
      console.log(`  ${v.bundle.items.length} items; digest ${v.bundle.digest}`);
      return 0;
    }
    case "diff": {
      if (!a || !b) usage();
      const pinned = pinnedPublisherKeys();
      const before = verifyBundle(a, pinned);
      if (!before.ok) throw new Error(`${a}: ${before.error}`);
      const after = verifyBundle(b, pinned);
      if (!after.ok) throw new Error(`${b}: ${after.error}`);
      console.log(
        renderDiff(
          diffItems(before.bundle.items, after.bundle.items),
          before.bundle.manifest.version,
          after.bundle.manifest.version,
        ),
      );
      return 0;
    }
    case "keygen": {
      if (!a) usage();
      const key = generateLearnedKeyPair();
      // O_EXCL: never overwrite an existing key; 0600: only this user can read it.
      const fd = openSync(a, "wx", 0o600);
      writeSync(fd, `${key.privateKey}\n`);
      closeSync(fd);
      console.log(`Wrote ${a} (mode 600). Keep it private.`);
      console.log(`Public key (pin it where bundles are verified): ${key.publicKey}`);
      console.log(`Sign with: MARINA_LEARNED_SIGNING_KEY=$(cat ${a}) or --key-file ${a}`);
      return 0;
    }
    default:
      usage();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error((err as Error).message);
    process.exit(1);
  },
);
