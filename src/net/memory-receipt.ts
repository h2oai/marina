// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Memory receipts — WHAT Marina injected into a proxied model request.
 *
 * Every passthru response that received memory injection (any of the four
 * proxy surfaces: `/v1/chat/completions`, `/v1/messages`, Ollama `/api/chat`
 * + `/api/generate`, `/v1/responses`) carries a compact receipt in the
 * `x-marina-memory-receipt` header and on its `model_request_lifecycle`
 * trace span, so a client — or an operator running `trace show <id>` — can
 * see exactly which tiers, ids and versions shaped the upstream prompt.
 *
 * The receipt is an audit artifact, never a permission: it stays on in every
 * trust profile (see `trust-profile.ts`), and the response cache pins the
 * record/source ids it lists so a revised premise invalidates reuse.
 */

export const MEMORY_RECEIPT_SCHEMA = "marina.memory.receipt.v1" as const;
export const MEMORY_RECEIPT_HEADER = "x-marina-memory-receipt";
/** Header budget; a larger receipt degrades to a stub and lives on the trace. */
export const MEMORY_RECEIPT_HEADER_MAX_BYTES = 2048;

export interface MemoryReceiptRef {
  id: string;
  /** Durable record version (records only) — the response cache pins it. */
  version?: number;
  /** Source content hash (captured sources only) — the response cache pins it. */
  hash?: string;
}

export interface MemoryReceiptTier {
  /** Unified tier (`skill|trusted|evidence|proposal|unverified`) or a world section (`pool|channel|chronicle`). */
  tier: string;
  ids: MemoryReceiptRef[];
  /** UTF-8 bytes this tier contributed to the injected addendum. */
  bytes: number;
}

export interface MemoryReceipt {
  schema: typeof MEMORY_RECEIPT_SCHEMA;
  requestId: string;
  entity: string;
  tiers: MemoryReceiptTier[];
  /** Total injection budget for this identity (`MARINA_PASSTHRU_INJECT_BYTES` / `passthruInjectBytes`). */
  budgetBytes: number;
  /** Bytes actually injected (framing lines included). */
  usedBytes: number;
  /** True when any item was cut or dropped for budget. */
  truncated: boolean;
  /** `tier:code` entries for tiers that could not be read (e.g. `evidence:world_identity_required`). */
  degraded: string[];
}

/** A receipt built before the request id is known; `finalizeMemoryReceipt` completes it. */
export type MemoryReceiptDraft = Omit<MemoryReceipt, "requestId">;

/** Header payload when the full receipt exceeds `MEMORY_RECEIPT_HEADER_MAX_BYTES`. */
export interface MemoryReceiptHeaderStub {
  schema: typeof MEMORY_RECEIPT_SCHEMA;
  requestId: string;
  truncatedHeader: true;
}

const encoder = new TextEncoder();

export function finalizeMemoryReceipt(draft: MemoryReceiptDraft, requestId: string): MemoryReceipt {
  return { ...draft, requestId };
}

/**
 * Compact JSON for the response header. Falls back to a stub carrying only the
 * schema + request id when the full receipt would not fit; the full receipt is
 * always on the trace (`trace show <requestId>`).
 */
export function encodeMemoryReceiptHeader(receipt: MemoryReceipt): string {
  const full = JSON.stringify(receipt);
  if (encoder.encode(full).length <= MEMORY_RECEIPT_HEADER_MAX_BYTES) return full;
  const stub: MemoryReceiptHeaderStub = {
    schema: MEMORY_RECEIPT_SCHEMA,
    requestId: receipt.requestId,
    truncatedHeader: true,
  };
  return JSON.stringify(stub);
}

/** JSON string for the `model_request_lifecycle` event / span attribute. */
export function encodeMemoryReceiptAttribute(receipt: MemoryReceipt): string {
  return JSON.stringify(receipt);
}

/** Structural guard for receipts that crossed a transport (header, event attribute, cache value). */
export function parseMemoryReceipt(value: unknown): MemoryReceipt | undefined {
  let candidate: unknown = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return undefined;
    }
  }
  if (!candidate || typeof candidate !== "object") return undefined;
  const v = candidate as Partial<MemoryReceipt>;
  if (
    v.schema !== MEMORY_RECEIPT_SCHEMA ||
    typeof v.requestId !== "string" ||
    typeof v.entity !== "string" ||
    typeof v.budgetBytes !== "number" ||
    typeof v.usedBytes !== "number" ||
    typeof v.truncated !== "boolean" ||
    !Array.isArray(v.tiers) ||
    !Array.isArray(v.degraded)
  ) {
    return undefined;
  }
  for (const tier of v.tiers) {
    if (
      !tier ||
      typeof tier !== "object" ||
      typeof tier.tier !== "string" ||
      typeof tier.bytes !== "number" ||
      !Array.isArray(tier.ids) ||
      !tier.ids.every((ref) => ref && typeof ref === "object" && typeof ref.id === "string")
    ) {
      return undefined;
    }
  }
  return v as MemoryReceipt;
}

/**
 * Pins the durable cache primitive can verify: evidence records by version and
 * captured sources by content hash. Legacy notes, proposals and world sections
 * are not pinnable (the service knows nothing about them) and are skipped.
 */
export function memoryReceiptPins(receipt: MemoryReceipt): {
  records: { id: string; version: number }[];
  sources: { id: string; content_hash: string }[];
} {
  const records: { id: string; version: number }[] = [];
  const sources: { id: string; content_hash: string }[] = [];
  const seen = new Set<string>();
  for (const tier of receipt.tiers) {
    if (tier.tier !== "evidence") continue;
    for (const ref of tier.ids) {
      if (seen.has(ref.id)) continue;
      if (typeof ref.version === "number" && Number.isInteger(ref.version) && ref.version >= 1) {
        records.push({ id: ref.id, version: ref.version });
        seen.add(ref.id);
      } else if (typeof ref.hash === "string" && ref.hash) {
        sources.push({ id: ref.id, content_hash: ref.hash });
        seen.add(ref.id);
      }
    }
  }
  return { records, sources };
}

/** Human-readable lines for `trace show` — one summary line, then one per tier. */
export function renderMemoryReceiptLines(receipt: MemoryReceipt): string[] {
  const summary = [
    `Memory: entity=${receipt.entity}`,
    `budget=${receipt.budgetBytes}B`,
    `used=${receipt.usedBytes}B`,
    receipt.truncated ? "truncated" : "complete",
  ];
  if (receipt.degraded.length > 0) summary.push(`degraded=${receipt.degraded.join(",")}`);
  const lines = [summary.join(" · ")];
  for (const tier of receipt.tiers) {
    if (tier.ids.length === 0 && tier.bytes === 0) continue;
    const ids = tier.ids
      .map((ref) => (ref.version === undefined ? ref.id : `${ref.id} v${ref.version}`))
      .join(", ");
    lines.push(`  [${tier.tier}] ${ids || "—"} (${tier.bytes}B)`);
  }
  return lines;
}
