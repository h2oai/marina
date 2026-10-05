// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The EVM `ChainAdapter`: one implementation for every EVM chain (Ethereum,
 * Base, Arbitrum, Optimism, Polygon, a local anvil devnet, …), selected purely
 * by configuration. It talks to the generic `MarinaLicense` ERC-1155 contract
 * (`contracts/src/MarinaLicense.sol`) with hand-encoded ABI calls, so there is
 * no web3 library in the trust path: keccak and secp256k1 come from the audited
 * `@noble/*` packages.
 *
 * Licence token id = uint256(keccak256(utf8(artifactId) ‖ 0x00 ‖ utf8(tier))),
 * mirrored by `MarinaLicense.licenseId`. Anchor key = the same over the version.
 */

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import type {
  AnchorRequest,
  ChainAdapter,
  ChainConfig,
  ChainEntitlementQuery,
  ChainEntitlementResult,
  SettlementRef,
  SettlementResolution,
  UnsignedTransaction,
} from "./adapter";
import { httpRpc, type RpcTransport } from "./rpc";

// ─── Encoding helpers ────────────────────────────────────────────────────────

export function toHex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 || !/^[0-9a-fA-F]*$/.test(clean)) throw new Error("invalid hex");
  return new Uint8Array(Buffer.from(clean, "hex"));
}

export function keccak256(data: Uint8Array | string): Uint8Array {
  return keccak_256(typeof data === "string" ? new TextEncoder().encode(data) : data);
}

export function selector(signature: string): string {
  return toHex(keccak256(signature).slice(0, 4)).slice(2);
}

function word(value: bigint): string {
  if (value < 0n || value >= 1n << 256n) throw new Error("uint256 out of range");
  return value.toString(16).padStart(64, "0");
}

function addressWord(address: string): string {
  if (!isAddress(address)) throw new Error(`invalid address: ${address}`);
  return address.slice(2).toLowerCase().padStart(64, "0");
}

function stringTail(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  const padded = Math.ceil(bytes.length / 32) * 32;
  return word(BigInt(bytes.length)) + bytes.toString("hex").padEnd(padded * 2, "0");
}

export function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function joinKey(a: string, b: string): Uint8Array {
  if (a.includes("\u0000") || b.includes("\u0000")) throw new Error("NUL not allowed in ids");
  return new Uint8Array(
    Buffer.concat([Buffer.from(a, "utf8"), Buffer.from([0]), Buffer.from(b, "utf8")]),
  );
}

/** ERC-1155 token id of a licence tier (mirrors `MarinaLicense.licenseId`). */
export function licenseTokenId(artifactId: string, tier: string): bigint {
  return BigInt(toHex(keccak256(joinKey(artifactId, tier))));
}

/** Anchor key of an artifact version (mirrors `MarinaLicense.anchorKey`). */
export function anchorKey(artifactId: string, version: string): string {
  return toHex(keccak256(joinKey(artifactId, version)));
}

export const SELECTORS = {
  balanceOf: selector("balanceOf(address,uint256)"),
  anchors: selector("anchors(bytes32)"),
  anchorArtifact: selector("anchorArtifact(string,string,bytes32)"),
};

export const TRANSFER_SINGLE_TOPIC = toHex(
  keccak256("TransferSingle(address,address,address,uint256,uint256)"),
);

export function encodeBalanceOf(holder: string, id: bigint): string {
  return `0x${SELECTORS.balanceOf}${addressWord(holder)}${word(id)}`;
}

export function encodeAnchorArtifact(
  artifactId: string,
  version: string,
  digestHex: string,
): string {
  const digest = digestHex.replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("digest must be 32 bytes of hex");
  const first = stringTail(artifactId);
  const second = stringTail(version);
  const head = word(96n) + word(BigInt(96 + first.length / 2)) + digest;
  return `0x${SELECTORS.anchorArtifact}${head}${first}${second}`;
}

// ─── Wallet statements (EIP-191 personal_sign) ───────────────────────────────

export interface LicenceStatement {
  artifactId: string;
  tiers: string[];
  /** Host world name for federation, or `import`. */
  audience: string;
  chainId: number | string;
  /** Lower-case 0x address. */
  address: string;
  issuedAt: string;
  expiresAt: string;
}

const STATEMENT_HEADER = "Marina licence proof";

/** The exact text a licensee signs in their own wallet. Human-readable on purpose. */
export function licenceStatement(s: LicenceStatement): string {
  return [
    STATEMENT_HEADER,
    `artifact: ${s.artifactId}`,
    `tiers: ${s.tiers.join(",")}`,
    `audience: ${s.audience}`,
    `chain: ${s.chainId}`,
    `address: ${s.address.toLowerCase()}`,
    `issued: ${s.issuedAt}`,
    `expires: ${s.expiresAt}`,
  ].join("\n");
}

export function parseLicenceStatement(text: string): LicenceStatement | null {
  const lines = text.split("\n");
  if (lines.length !== 8 || lines[0] !== STATEMENT_HEADER) return null;
  const fields: Record<string, string> = {};
  const keys = ["artifact", "tiers", "audience", "chain", "address", "issued", "expires"];
  for (let i = 1; i < lines.length; i++) {
    const match = /^([a-z]+): (\S.*)$/.exec(lines[i]!);
    if (!match || match[1] !== keys[i - 1]) return null;
    fields[match[1]!] = match[2]!;
  }
  if (!isAddress(fields.address!) || fields.address !== fields.address!.toLowerCase()) return null;
  const tiers = fields.tiers!.split(",").filter(Boolean);
  if (!tiers.length) return null;
  return {
    artifactId: fields.artifact!,
    tiers,
    audience: fields.audience!,
    chainId: fields.chain!,
    address: fields.address!,
    issuedAt: fields.issued!,
    expiresAt: fields.expires!,
  };
}

export function personalMessageHash(message: string): Uint8Array {
  const body = Buffer.from(message, "utf8");
  return keccak256(
    new Uint8Array(
      Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`, "utf8"), body]),
    ),
  );
}

export function addressOfPublicKey(uncompressed: Uint8Array): string {
  const key = uncompressed.length === 65 ? uncompressed.slice(1) : uncompressed;
  return toHex(keccak256(key).slice(12));
}

/** Recover the signer of an EIP-191 personal_sign signature (r ‖ s ‖ v, 65 bytes). */
export function recoverPersonalSigner(message: string, signatureHex: string): string {
  const sig = fromHex(signatureHex);
  if (sig.length !== 65) throw new Error("signature must be 65 bytes");
  let v = sig[64]!;
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) throw new Error("invalid recovery id");
  // noble's `recovered` format puts the recovery byte first.
  const recovered = new Uint8Array(65);
  recovered[0] = v;
  recovered.set(sig.slice(0, 64), 1);
  const publicKey = secp256k1.recoverPublicKey(recovered, personalMessageHash(message), {
    prehash: false,
  });
  const point = secp256k1.Point.fromBytes(publicKey);
  return addressOfPublicKey(point.toBytes(false));
}

/** Test/dev helper: sign like a wallet's personal_sign. Never used with real keys. */
export function personalSign(message: string, secretKey: Uint8Array): string {
  const recovered = secp256k1.sign(personalMessageHash(message), secretKey, {
    prehash: false,
    format: "recovered",
  });
  const out = new Uint8Array(65);
  out.set(recovered.slice(1), 0);
  out[64] = recovered[0]! + 27;
  return toHex(out);
}

// ─── The adapter ─────────────────────────────────────────────────────────────

function hexToNumber(value: unknown): number {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error("bad quantity");
  return Number.parseInt(value, 16);
}

export class EvmChainAdapter implements ChainAdapter {
  readonly family = "evm";
  readonly chainId: number;
  private chainChecked = false;

  constructor(
    readonly name: string,
    private readonly config: ChainConfig,
    private readonly rpc: RpcTransport = httpRpc(config.rpc),
  ) {
    this.chainId = Number(config.chain_id);
    if (!Number.isSafeInteger(this.chainId) || this.chainId <= 0)
      throw new Error(`${name}: bad chain id`);
    if (!isAddress(config.license_contract))
      throw new Error(`${name}: bad licence contract address`);
  }

  /** Refuse to read from an endpoint that serves a different chain than configured. */
  private async ensureChain(): Promise<void> {
    if (this.chainChecked) return;
    const remote = hexToNumber(await this.rpc("eth_chainId", []));
    if (remote !== this.chainId)
      throw new Error(`${this.name}: RPC serves chain ${remote}, configured ${this.chainId}`);
    this.chainChecked = true;
  }

  private async finalBlock(): Promise<number> {
    const head = hexToNumber(await this.rpc("eth_blockNumber", []));
    return Math.max(0, head - this.config.confirmations);
  }

  async verifyEntitlement(query: ChainEntitlementQuery): Promise<ChainEntitlementResult> {
    if (!isAddress(query.holder)) return { ok: false, reason: "holder is not an address" };
    if (!query.tiers.length) return { ok: false, reason: "no tiers requested" };
    try {
      await this.ensureChain();
      const block = await this.finalBlock();
      const balances: Record<string, string> = {};
      for (const tier of query.tiers) {
        const result = await this.rpc("eth_call", [
          {
            to: this.config.license_contract,
            data: encodeBalanceOf(query.holder, licenseTokenId(query.artifactId, tier)),
          },
          `0x${block.toString(16)}`,
        ]);
        const balance = BigInt(typeof result === "string" && result !== "0x" ? result : "0x0");
        balances[tier] = balance.toString();
        if (balance === 0n) return { ok: false, reason: `no licence held for tier ${tier}` };
      }
      return { ok: true, block, balances };
    } catch (error) {
      return { ok: false, reason: `chain read failed: ${(error as Error).message}` };
    }
  }

  async anchor(request: AnchorRequest): Promise<UnsignedTransaction> {
    return {
      chain_id: this.chainId,
      to: this.config.license_contract,
      data: encodeAnchorArtifact(request.artifactId, request.version, request.manifestDigest),
      value: "0",
      description: `anchorArtifact(${request.artifactId}, ${request.version}, sha256:${request.manifestDigest}) — sign in your own wallet`,
    };
  }

  async readAnchor(artifactId: string, version: string): Promise<string | null> {
    await this.ensureChain();
    const block = await this.finalBlock();
    const result = await this.rpc("eth_call", [
      {
        to: this.config.license_contract,
        data: `0x${SELECTORS.anchors}${anchorKey(artifactId, version).slice(2)}`,
      },
      `0x${block.toString(16)}`,
    ]);
    if (typeof result !== "string" || /^0x0*$/.test(result)) return null;
    return result.slice(2).padStart(64, "0").slice(-64);
  }

  async resolveSettlement(ref: SettlementRef): Promise<SettlementResolution> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(ref.txHash)) return { settled: false, reason: "bad tx hash" };
    if (!isAddress(ref.licensee)) return { settled: false, reason: "bad licensee address" };
    try {
      await this.ensureChain();
      const receipt = (await this.rpc("eth_getTransactionReceipt", [ref.txHash])) as {
        status?: string;
        blockNumber?: string;
        logs?: Array<{ address: string; topics: string[]; data: string }>;
      } | null;
      if (!receipt) return { settled: false, reason: "transaction not found or pending" };
      if (receipt.status !== "0x1") return { settled: false, reason: "transaction reverted" };
      const block = hexToNumber(receipt.blockNumber);
      const head = hexToNumber(await this.rpc("eth_blockNumber", []));
      const confirmations = head - block + 1;
      if (confirmations < Math.max(1, this.config.confirmations))
        return { settled: false, reason: `only ${confirmations} confirmations` };
      const tokenId = licenseTokenId(ref.artifactId, ref.tier);
      const zero = `0x${"0".repeat(64)}`;
      const to = `0x${addressWord(ref.licensee)}`;
      for (const log of receipt.logs ?? []) {
        if (log.address.toLowerCase() !== this.config.license_contract.toLowerCase()) continue;
        if (log.topics[0]?.toLowerCase() !== TRANSFER_SINGLE_TOPIC) continue;
        if (log.topics[2]?.toLowerCase() !== zero || log.topics[3]?.toLowerCase() !== to) continue;
        const data = log.data.slice(2);
        if (BigInt(`0x${data.slice(0, 64)}`) !== tokenId) continue;
        const amount = BigInt(`0x${data.slice(64, 128)}`);
        if (amount === 0n) continue;
        return {
          settled: true,
          block,
          confirmations,
          tokenId: tokenId.toString(),
          amount: amount.toString(),
        };
      }
      return { settled: false, reason: "no licence issuance to the licensee in this transaction" };
    } catch (error) {
      return { settled: false, reason: `chain read failed: ${(error as Error).message}` };
    }
  }
}

export const evmAdapterFactory = (name: string, config: ChainConfig) =>
  new EvmChainAdapter(name, config);
