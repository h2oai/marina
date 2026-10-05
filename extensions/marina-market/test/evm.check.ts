// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { preserveTrustProfileForTests, setTrustProfile } from "../../../src/engine/trust-profile";
import { type ChainConfig, createChainRegistry, validateChainConfig } from "../src/chain/adapter";
import {
  addressOfPublicKey,
  EvmChainAdapter,
  encodeAnchorArtifact,
  encodeBalanceOf,
  evmAdapterFactory,
  licenceStatement,
  licenseTokenId,
  personalSign,
  recoverPersonalSigner,
  SELECTORS,
  TRANSFER_SINGLE_TOPIC,
  toHex,
} from "../src/chain/evm";
import { httpRpc, type RpcTransport } from "../src/chain/rpc";
import { WalletLicenceVerifier } from "../src/entitlements";

const CONTRACT = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const ARTIFACT = `marina-world:sha256:${"ab".repeat(32)}/lab`;
const devnet: ChainConfig = {
  family: "evm",
  chain_id: 31337,
  rpc: "http://127.0.0.1:8545",
  license_contract: CONTRACT,
  confirmations: 0,
  network: "devnet",
};

function wallet() {
  const secret = secp256k1.utils.randomSecretKey();
  return { secret, address: addressOfPublicKey(secp256k1.getPublicKey(secret, false)) };
}

/** A fake chain: answers chainId/blockNumber and balanceOf from a table. */
function fakeChain(
  balances: Map<string, bigint>,
  chainId = 31337,
): { rpc: RpcTransport; calls: string[] } {
  const calls: string[] = [];
  const rpc: RpcTransport = async (method, params) => {
    calls.push(method);
    if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
    if (method === "eth_blockNumber") return "0x10";
    if (method === "eth_call") {
      const data = (params[0] as { data: string }).data;
      return `0x${(balances.get(data) ?? 0n).toString(16).padStart(64, "0")}`;
    }
    throw new Error(`unexpected ${method}`);
  };
  return { rpc, calls };
}

function proofFor(
  w: ReturnType<typeof wallet>,
  overrides: Partial<Parameters<typeof licenceStatement>[0]> = {},
) {
  const now = Date.now();
  const message = licenceStatement({
    artifactId: ARTIFACT,
    tiers: ["standard"],
    audience: "import",
    chainId: 31337,
    address: w.address,
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
    ...overrides,
  });
  return {
    kind: "evm-wallet",
    chain: "anvil",
    message,
    signature: personalSign(message, w.secret),
  };
}

const ctx = (tiers = ["standard"]) => ({
  publisherKeyId: "sha256:fixture",
  artifactId: ARTIFACT,
  version: "1.2.0",
  tiers,
  purpose: "import" as const,
  now: new Date(),
});

function castBin(): string | undefined {
  const local = join(homedir(), ".foundry/bin/cast");
  return existsSync(local) ? local : (Bun.which("cast") ?? undefined);
}

describe("EVM encoding", () => {
  it("uses the ERC-1155 balanceOf selector and TransferSingle topic", () => {
    expect(SELECTORS.balanceOf).toBe("00fdd58e");
    expect(TRANSFER_SINGLE_TOPIC).toBe(
      "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62",
    );
  });

  it("matches cast for calldata and personal_sign (golden check against Foundry)", () => {
    const cast = castBin();
    if (!cast) return; // Foundry absent: the anvil integration check is skipped too.
    const digest = "11".repeat(32);
    const expected = Bun.spawnSync([
      cast,
      "calldata",
      "anchorArtifact(string,string,bytes32)",
      ARTIFACT,
      "1.2.0",
      `0x${digest}`,
    ])
      .stdout.toString()
      .trim();
    expect(encodeAnchorArtifact(ARTIFACT, "1.2.0", digest)).toBe(expected);
    const balance = Bun.spawnSync([cast, "calldata", "balanceOf(address,uint256)", CONTRACT, "7"])
      .stdout.toString()
      .trim();
    expect(encodeBalanceOf(CONTRACT, 7n)).toBe(balance);

    const w = wallet();
    const message = "Marina licence proof\nfixture";
    const castSig = Bun.spawnSync([
      cast,
      "wallet",
      "sign",
      "--private-key",
      toHex(w.secret),
      message,
    ])
      .stdout.toString()
      .trim();
    expect(personalSign(message, w.secret)).toBe(castSig);
    expect(recoverPersonalSigner(message, castSig)).toBe(w.address);
  });

  it("derives distinct licence ids per tier and refuses NUL in ids", () => {
    expect(licenseTokenId(ARTIFACT, "standard")).not.toBe(licenseTokenId(ARTIFACT, "full"));
    expect(() => licenseTokenId(`${ARTIFACT}\u0000x`, "standard")).toThrow("NUL");
  });
});

describe("wallet licence verifier (read-only, mocked chain)", () => {
  function setup(holds: boolean, chainId = 31337) {
    const w = wallet();
    const balances = new Map<string, bigint>();
    if (holds) balances.set(encodeBalanceOf(w.address, licenseTokenId(ARTIFACT, "standard")), 1n);
    const fake = fakeChain(balances, chainId);
    const registry = new Map([["anvil", new EvmChainAdapter("anvil", devnet, fake.rpc)]]);
    return { w, verifier: new WalletLicenceVerifier(registry), calls: fake.calls };
  }

  it("grants when the signer holds the licence, using only read methods", async () => {
    const { w, verifier, calls } = setup(true);
    const decision = await verifier.verify(proofFor(w), ctx());
    expect(decision).toMatchObject({
      ok: true,
      grant: { licensee: w.address, verifier: "evm-wallet" },
    });
    expect(new Set(calls)).toEqual(new Set(["eth_chainId", "eth_blockNumber", "eth_call"]));
  });

  it("refuses without a balance, from another signer, or on the wrong chain", async () => {
    const empty = setup(false);
    expect(await empty.verifier.verify(proofFor(empty.w), ctx())).toMatchObject({
      ok: false,
      reason: "no licence held for tier standard",
    });
    const held = setup(true);
    const other = wallet();
    const forged = proofFor(held.w);
    forged.signature = personalSign(forged.message, other.secret);
    expect(await held.verifier.verify(forged, ctx())).toMatchObject({ ok: false });
    const wrongChain = setup(true, 8453);
    expect(await wrongChain.verifier.verify(proofFor(wrongChain.w), ctx())).toMatchObject({
      ok: false,
    });
  });

  it("refuses stale, long-lived, mis-scoped or wrong-audience statements", async () => {
    const { w, verifier } = setup(true);
    const now = Date.now();
    const cases = [
      proofFor(w, { expiresAt: new Date(now - 1).toISOString() }),
      proofFor(w, { expiresAt: new Date(now + 7 * 86_400_000).toISOString() }),
      proofFor(w, { tiers: ["full"] }),
      proofFor(w, { audience: "some-host" }),
      proofFor(w, { artifactId: `${ARTIFACT}x` }),
    ];
    for (const proof of cases) expect((await verifier.verify(proof, ctx())).ok).toBe(false);
  });
});

describe("chain configuration and transport", () => {
  it("refuses mainnet unless explicitly allowed, and mislabelled mainnets always", () => {
    const base = { ...devnet, chain_id: 8453, network: "mainnet" as const };
    expect(validateChainConfig("base", base, false)).toContain("disabled");
    expect(validateChainConfig("base", base, true)).toBeNull();
    expect(validateChainConfig("base", { ...base, network: "testnet" }, true)).toContain(
      "is a mainnet",
    );
    expect(() => createChainRegistry({ base }, { evm: evmAdapterFactory })).toThrow("disabled");
    expect(() =>
      createChainRegistry({ sol: { ...devnet, family: "solana" } }, { evm: evmAdapterFactory }),
    ).toThrow("no adapter for family solana");
  });

  it("the transport only sends read methods", async () => {
    await expect(httpRpc(devnet.rpc)("eth_sendTransaction", [])).rejects.toThrow("not allowed");
    await expect(httpRpc(devnet.rpc)("eth_sign", [])).rejects.toThrow("not allowed");
  });

  it("loopback RPC goes through the SSRF guard outside the local profile", async () => {
    using _profile = preserveTrustProfileForTests();
    setTrustProfile("shared");
    await expect(httpRpc("http://127.0.0.1:1/")("eth_chainId", [])).rejects.toThrow("SSRF");
    await expect(httpRpc("http://169.254.169.254/")("eth_chainId", [])).rejects.toThrow("SSRF");
  });

  it("resolves a settlement only from a successful, final mint to the licensee", async () => {
    const w = wallet();
    const id = licenseTokenId(ARTIFACT, "standard");
    const pad = (hex: string) => `0x${hex.replace(/^0x/, "").padStart(64, "0")}`;
    const log = {
      address: CONTRACT,
      topics: [TRANSFER_SINGLE_TOPIC, pad("01"), pad("00"), pad(w.address)],
      data: `0x${id.toString(16).padStart(64, "0")}${1n.toString(16).padStart(64, "0")}`,
    };
    let receipt: unknown = { status: "0x1", blockNumber: "0xa", logs: [log] };
    const rpc: RpcTransport = async (method) =>
      method === "eth_chainId" ? "0x7a69" : method === "eth_blockNumber" ? "0x10" : receipt;
    const adapter = new EvmChainAdapter("anvil", { ...devnet, confirmations: 3 }, rpc);
    const ref = {
      txHash: `0x${"aa".repeat(32)}`,
      licensee: w.address,
      artifactId: ARTIFACT,
      tier: "standard",
    };
    expect(await adapter.resolveSettlement(ref)).toMatchObject({ settled: true, confirmations: 7 });
    expect(await adapter.resolveSettlement({ ...ref, tier: "full" })).toMatchObject({
      settled: false,
    });
    receipt = { status: "0x0", blockNumber: "0xa", logs: [log] };
    expect(await adapter.resolveSettlement(ref)).toMatchObject({
      settled: false,
      reason: "transaction reverted",
    });
    receipt = { status: "0x1", blockNumber: "0x10", logs: [log] };
    expect(await adapter.resolveSettlement(ref)).toMatchObject({ settled: false });
  });

  it("anchor builds an unsigned transaction and never signs", async () => {
    const adapter = new EvmChainAdapter("anvil", devnet, fakeChain(new Map()).rpc);
    const tx = await adapter.anchor({
      artifactId: ARTIFACT,
      version: "1.2.0",
      manifestDigest: "22".repeat(32),
    });
    expect(tx).toMatchObject({ chain_id: 31337, to: CONTRACT, value: "0" });
    expect(tx.data.startsWith(`0x${SELECTORS.anchorArtifact}`)).toBe(true);
    expect(Object.keys(tx)).not.toContain("signature");
  });
});
