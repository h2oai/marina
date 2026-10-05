// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end against a LOCAL devnet (anvil): deploy MarinaLicense with the
 * testnet-only script, define and issue a licence, anchor a real world
 * artifact, then verify everything through the read-only EVM adapter over the
 * SSRF-guarded transport. Ephemeral random keys only; no real keys, no funds.
 * Skipped when Foundry is not installed.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { preserveTrustProfileForTests, setTrustProfile } from "../../../src/engine/trust-profile";
import type { PinnedKey } from "../../../src/learned/sign";
import { MarinaDB } from "../../../src/persistence/database";
import { AuditLog } from "../src/audit";
import {
  addressOfPublicKey,
  EvmChainAdapter,
  licenceStatement,
  licenseTokenId,
  personalSign,
  toHex,
} from "../src/chain/evm";
import { WalletLicenceVerifier } from "../src/entitlements";
import { importWithEntitlement } from "../src/importer";
import { publishWorld } from "../src/world";
import { cleanupTemp, publisherKey, publishSpec, tempDir, writeWorldPayload } from "./fixtures";

const bin = (name: string) => {
  const local = join(homedir(), ".foundry/bin", name);
  return existsSync(local) ? local : (Bun.which(name) ?? undefined);
};
const anvil = bin("anvil");
const forge = bin("forge");
const cast = bin("cast");
const enabled = Boolean(anvil && forge && cast);
const CONTRACTS = join(import.meta.dir, "..", "contracts");

function run(cmd: string[], cwd = CONTRACTS): string {
  const out = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (out.exitCode !== 0)
    throw new Error(`${cmd[0]} ${cmd[1]} failed: ${out.stderr.toString().slice(0, 400)}`);
  return out.stdout.toString();
}

async function rawRpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return ((await response.json()) as { result: unknown }).result;
}

describe.skipIf(!enabled)("anvil devnet end-to-end", () => {
  let node: ReturnType<typeof Bun.spawn> | undefined;
  let url = "";
  let contract = "";
  let issueTx = "";
  const deployer = secp256k1.utils.randomSecretKey();
  const deployerKey = toHex(deployer);
  const buyer = secp256k1.utils.randomSecretKey();
  const buyerAddress = addressOfPublicKey(secp256k1.getPublicKey(buyer, false));
  const world = { dir: "", bundle: "", artifactId: "", digest: "", pinned: [] as PinnedKey[] };
  let profile: Disposable | undefined;

  beforeAll(async () => {
    profile = preserveTrustProfileForTests();
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    url = `http://127.0.0.1:${port}`;
    node = Bun.spawn([anvil!, "--port", String(port), "--silent"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await rawRpc(url, "eth_chainId", [])) === "0x7a69") break;
      } catch {
        // allow-empty-catch: anvil still starting
      }
      await Bun.sleep(100);
    }
    // Fund the ephemeral deployer on the devnet (test-only cheat; never on a real chain).
    const deployerAddress = addressOfPublicKey(secp256k1.getPublicKey(deployer, false));
    await rawRpc(url, "anvil_setBalance", [deployerAddress, "0x56BC75E2D63100000"]);

    const out = run([
      forge!,
      "script",
      "script/Deploy.s.sol",
      "--rpc-url",
      url,
      "--broadcast",
      "--private-key",
      deployerKey,
    ]);
    contract = /MarinaLicense deployed (0x[0-9a-fA-F]{40})/.exec(out)?.[1] ?? "";
    expect(contract).toMatch(/^0x/);

    const dir = tempDir();
    writeWorldPayload(dir);
    const pub = publisherKey();
    world.bundle = tempDir("anvil-bundle-");
    const published = publishWorld(dir, world.bundle, publishSpec(), pub.key);
    world.pinned = [pub.pinned];
    world.dir = dir;
    world.artifactId = published.manifest.artifact_id;
    world.digest = published.manifestDigest.replace(/^sha256:/, "");

    const send = (...args: string[]) =>
      run([
        cast!,
        "send",
        "--json",
        "--rpc-url",
        url,
        "--private-key",
        deployerKey,
        contract,
        ...args,
      ]);
    send(
      "defineLicense(string,string,bool,bool)",
      world.artifactId,
      "tier:standard",
      "false",
      "true",
    );
    const receipt = JSON.parse(
      send(
        "issue(address,uint256,uint256,bytes32)",
        buyerAddress,
        licenseTokenId(world.artifactId, "tier:standard").toString(),
        "1",
        `0x${"00".repeat(32)}`,
      ),
    ) as { transactionHash: string };
    issueTx = receipt.transactionHash;
  }, 120_000);

  afterAll(() => {
    node?.kill();
    profile?.[Symbol.dispose]();
    cleanupTemp();
  });

  function adapter() {
    return new EvmChainAdapter("anvil", {
      family: "evm",
      chain_id: 31337,
      rpc: url,
      license_contract: contract,
      confirmations: 0,
      network: "devnet",
    });
  }

  it("verifies a wallet-signed proof against the on-chain licence (read-only)", async () => {
    setTrustProfile("local"); // loopback devnet allowed only under the local profile
    const now = Date.now();
    const message = licenceStatement({
      artifactId: world.artifactId,
      tiers: ["tier:standard"],
      audience: "import",
      chainId: 31337,
      address: buyerAddress,
      issuedAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 600_000).toISOString(),
    });
    const verifier = new WalletLicenceVerifier(new Map([["anvil", adapter()]]));
    const proof = {
      kind: "evm-wallet",
      chain: "anvil",
      message,
      signature: personalSign(message, buyer),
    };
    const ctx = {
      artifactId: world.artifactId,
      version: "1.2.0",
      publisherKeyId: "sha256:fixture",
      purpose: "import" as const,
      now: new Date(),
    };
    expect(await verifier.verify(proof, { ...ctx, tiers: ["tier:standard"] })).toMatchObject({
      ok: true,
    });
    const full = await verifier.verify(proof, { ...ctx, tiers: ["tier:full"] });
    expect(full.ok).toBe(false);
  });

  it("a wallet proof unlocks the paid slice through the core importer", async () => {
    setTrustProfile("local");
    const now = Date.now();
    const message = licenceStatement({
      artifactId: world.artifactId,
      tiers: ["tier:standard"],
      audience: "import",
      chainId: 31337,
      address: buyerAddress,
      issuedAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 600_000).toISOString(),
    });
    const proof = {
      kind: "evm-wallet",
      chain: "anvil",
      message,
      signature: personalSign(message, buyer),
    };
    const db = new MarinaDB(join(tempDir("anvil-db-"), "m.db"));
    try {
      const r = await importWithEntitlement(
        db,
        world.bundle,
        {
          pinned: world.pinned,
          revocations: [],
          verifiersFor: () => [new WalletLicenceVerifier(new Map([["anvil", adapter()]]))],
          audit: new AuditLog(join(tempDir(), "audit.jsonl")),
        },
        { env: { MARINA_UPSTREAM: "on" } as NodeJS.ProcessEnv, slices: ["tier:standard"], proof },
      );
      if (!r.ok || !r.outcome.ok) throw new Error(r.ok ? "import refused" : r.error);
      expect(r.network_used).toBe(true);
      expect(r.grant).toMatchObject({ verifier: "evm-wallet", licensee: buyerAddress });
      expect(r.outcome.report.added).toBeGreaterThan(1);
      expect(r.outcome.report.withheld).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("anchors the manifest digest from an unsigned transaction the operator signs", async () => {
    setTrustProfile("local");
    const chain = adapter();
    expect(await chain.readAnchor(world.artifactId, "1.2.0")).toBeNull();
    const tx = await chain.anchor({
      artifactId: world.artifactId,
      version: "1.2.0",
      manifestDigest: world.digest,
    });
    run([cast!, "send", "--rpc-url", url, "--private-key", deployerKey, tx.to, tx.data]);
    expect(await chain.readAnchor(world.artifactId, "1.2.0")).toBe(world.digest);
  });

  it("resolves the issuance transaction as a settlement", async () => {
    setTrustProfile("local");
    const chain = adapter();
    const ref = {
      txHash: issueTx,
      licensee: buyerAddress,
      artifactId: world.artifactId,
      tier: "tier:standard",
    };
    expect(await chain.resolveSettlement(ref)).toMatchObject({ settled: true, amount: "1" });
    const stranger = addressOfPublicKey(
      secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), false),
    );
    expect(await chain.resolveSettlement({ ...ref, licensee: stranger })).toMatchObject({
      settled: false,
    });
  });

  it("refuses the same loopback devnet outside the local profile", async () => {
    setTrustProfile("shared");
    const result = await adapter().verifyEntitlement({
      holder: buyerAddress,
      artifactId: world.artifactId,
      tiers: ["tier:standard"],
    });
    expect(result).toMatchObject({ ok: false });
  });
});
