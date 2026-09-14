// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  encodeMemoryReceiptHeader,
  finalizeMemoryReceipt,
  MEMORY_RECEIPT_HEADER_MAX_BYTES,
  MEMORY_RECEIPT_SCHEMA,
  type MemoryReceipt,
  type MemoryReceiptDraft,
  memoryReceiptPins,
  parseMemoryReceipt,
  renderMemoryReceiptLines,
} from "../src/net/memory-receipt";

function draft(over: Partial<MemoryReceiptDraft> = {}): MemoryReceiptDraft {
  return {
    schema: MEMORY_RECEIPT_SCHEMA,
    entity: "Ada",
    tiers: [
      { tier: "trusted", ids: [{ id: "12" }], bytes: 90 },
      {
        tier: "evidence",
        ids: [
          { id: "r_1", version: 2 },
          { id: "s_1", hash: "abc123" },
        ],
        bytes: 140,
      },
      { tier: "unverified", ids: [{ id: "13" }], bytes: 60 },
    ],
    budgetBytes: 2048,
    usedBytes: 410,
    truncated: false,
    degraded: [],
    ...over,
  };
}

describe("memory receipt", () => {
  it("finalizes a draft with the request id and round-trips through parse", () => {
    const receipt = finalizeMemoryReceipt(draft(), "req-1");
    expect(receipt.requestId).toBe("req-1");
    expect(parseMemoryReceipt(JSON.stringify(receipt))).toEqual(receipt);
    expect(parseMemoryReceipt(receipt)).toEqual(receipt);
  });

  it("rejects malformed receipts", () => {
    expect(parseMemoryReceipt(undefined)).toBeUndefined();
    expect(parseMemoryReceipt("not json")).toBeUndefined();
    expect(parseMemoryReceipt({ schema: "other" })).toBeUndefined();
    expect(
      parseMemoryReceipt({ ...finalizeMemoryReceipt(draft(), "r"), tiers: [{ tier: 1 }] }),
    ).toBeUndefined();
  });

  it("encodes the header as full JSON when it fits, else a schema+requestId stub", () => {
    const small = finalizeMemoryReceipt(draft(), "req-small");
    expect(JSON.parse(encodeMemoryReceiptHeader(small))).toEqual(small);

    const big: MemoryReceipt = finalizeMemoryReceipt(
      draft({
        tiers: [
          {
            tier: "unverified",
            ids: Array.from({ length: 400 }, (_, i) => ({ id: `note-${i}` })),
            bytes: 1,
          },
        ],
      }),
      "req-big",
    );
    const header = encodeMemoryReceiptHeader(big);
    expect(new TextEncoder().encode(header).length).toBeLessThanOrEqual(
      MEMORY_RECEIPT_HEADER_MAX_BYTES,
    );
    expect(JSON.parse(header)).toEqual({
      schema: MEMORY_RECEIPT_SCHEMA,
      requestId: "req-big",
      truncatedHeader: true,
    });
  });

  it("derives cache pins from durable evidence only (records by version, sources by hash)", () => {
    const pins = memoryReceiptPins(finalizeMemoryReceipt(draft(), "r"));
    expect(pins.records).toEqual([{ id: "r_1", version: 2 }]);
    expect(pins.sources).toEqual([{ id: "s_1", content_hash: "abc123" }]);
    // Legacy tiers carry no pins at all.
    const none = memoryReceiptPins(
      finalizeMemoryReceipt(
        draft({ tiers: [{ tier: "trusted", ids: [{ id: "1" }, { id: "2" }], bytes: 10 }] }),
        "r",
      ),
    );
    expect(none.records).toEqual([]);
    expect(none.sources).toEqual([]);
  });

  it("renders a Memory section: one summary line then one line per tier", () => {
    const lines = renderMemoryReceiptLines(
      finalizeMemoryReceipt(
        draft({ truncated: true, degraded: ["proposal:world_identity_required"] }),
        "r",
      ),
    );
    expect(lines[0]).toContain("Memory: entity=Ada");
    expect(lines[0]).toContain("budget=2048B");
    expect(lines[0]).toContain("used=410B");
    expect(lines[0]).toContain("truncated");
    expect(lines[0]).toContain("degraded=proposal:world_identity_required");
    expect(lines).toContain("  [trusted] 12 (90B)");
    expect(lines).toContain("  [evidence] r_1 v2, s_1 (140B)");
    expect(lines).toContain("  [unverified] 13 (60B)");
  });
});
