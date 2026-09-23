// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Structural parity between the backend memory-observability contract
 * (`src/net/memory-observability-types.ts`) and the two dashboard modules that
 * consume it. Both modules re-export the wire types, so most of what is pinned
 * here is the DERIVED vocabulary (named aliases, the runtime kind/relationship
 * sets, the color maps) and the dashboard-only envelopes — the places a future
 * "let me just inline this union" edit would silently fork the contract.
 *
 * `expectTypeOf` assertions are type-level: they fail `tsc --noEmit`
 * (`bun run typecheck` in dashboard/, run by CI), not the vitest run. The
 * runtime `expect`s below cover the value-level sets so the vitest run also
 * catches a kind or relationship the visual vocabulary forgot.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import type * as Backend from "../../../src/net/memory-observability-types";
import type { MemoryReceipt } from "../../../src/net/memory-receipt";
import type * as Lib from "../lib/memory-observability-types";
import * as Unified from "../unified/lib/memory-map-types";

// ── src/lib/memory-observability-types (components/ half) ───────────────────

describe("memory-observability-types (dashboard lib) matches the backend contract", () => {
  it("re-exports every shared view type unchanged", () => {
    expectTypeOf<Lib.MemoryJobView>().toEqualTypeOf<Backend.MemoryJobView>();
    expectTypeOf<Lib.MemoryResolutionView>().toEqualTypeOf<Backend.MemoryResolutionView>();
    expectTypeOf<Lib.MemoryRatificationView>().toEqualTypeOf<Backend.MemoryRatificationView>();
    expectTypeOf<Lib.MemoryCreditView>().toEqualTypeOf<Backend.MemoryCreditView>();
    expectTypeOf<Lib.MemoryReceiptView>().toEqualTypeOf<Backend.MemoryReceiptView>();
    expectTypeOf<Lib.MemoryRatio>().toEqualTypeOf<Backend.MemoryRatio>();
    expectTypeOf<Lib.MemoryStorageBudgetView>().toEqualTypeOf<Backend.MemoryStorageBudgetView>();
    expectTypeOf<Lib.MemoryHygieneRatios>().toEqualTypeOf<Backend.MemoryHygieneRatios>();
    expectTypeOf<Lib.MemoryHygieneSample>().toEqualTypeOf<Backend.MemoryHygieneSample>();
    expectTypeOf<Lib.MemoryHygieneHistory>().toEqualTypeOf<Backend.MemoryHygieneHistory>();
    expectTypeOf<Lib.MemorySpaceHealth>().toEqualTypeOf<Backend.MemorySpaceHealth>();
    expectTypeOf<Lib.MemoryOverview>().toEqualTypeOf<Backend.MemoryOverview>();
  });

  it("derives the named aliases from the contract's inline unions", () => {
    expectTypeOf<Lib.MemoryJobState>().toEqualTypeOf<Backend.MemoryJobView["state"]>();
    expectTypeOf<Lib.MemoryJobRole>().toEqualTypeOf<Backend.MemoryJobView["role"]>();
    expectTypeOf<Lib.MemoryJobMarker>().toEqualTypeOf<
      NonNullable<Backend.MemoryJobView["marker"]>
    >();
    expectTypeOf<Lib.MemoryReceiptSurface>().toEqualTypeOf<Backend.MemoryReceiptView["surface"]>();
    // The literal members the components switch on must still be present.
    expectTypeOf<
      "pending" | "running" | "answered" | "abstained" | "cancelled"
    >().toEqualTypeOf<Lib.MemoryJobState>();
    expectTypeOf<
      "hygiene" | "accumulation" | "shared-write-review"
    >().toEqualTypeOf<Lib.MemoryJobMarker>();
    expectTypeOf<
      "openai" | "anthropic" | "ollama-generate" | "responses" | "unknown"
    >().toEqualTypeOf<Lib.MemoryReceiptSurface>();
  });

  it("keeps the dashboard-only envelopes assignable from what the server emits", () => {
    // `listJobs` returns `nextCursor: string | null`; the page type is the superset.
    expectTypeOf<{
      jobs: Backend.MemoryJobView[];
      nextCursor: string | null;
    }>().toMatchTypeOf<Lib.MemoryJobsResponse>();
    // The `memory_job` EngineEvent strips task/answer/citations before broadcast.
    expectTypeOf<{
      type: "memory_job";
      job: Omit<Backend.MemoryJobView, "task" | "answer" | "citations">;
      timestamp: number;
    }>().toMatchTypeOf<Lib.MemoryJobEvent>();
    // The receipt attribute is the backend receipt itself.
    expectTypeOf<Lib.MemoryReceiptAttribute>().toEqualTypeOf<MemoryReceipt>();
  });
});

// ── src/unified/lib/memory-map-types (unified canvas half) ──────────────────

describe("memory-map-types (unified) matches the backend graph contract", () => {
  it("re-exports the graph wire types and derives the kind/relationship unions", () => {
    expectTypeOf<Unified.MemoryGraph>().toEqualTypeOf<Backend.MemoryGraph>();
    expectTypeOf<Unified.MemoryGraphNode>().toEqualTypeOf<Backend.MemoryGraphNode>();
    expectTypeOf<Unified.MemoryGraphEdge>().toEqualTypeOf<Backend.MemoryGraphEdge>();
    expectTypeOf<Unified.MemoryGraphNodeKind>().toEqualTypeOf<Backend.MemoryGraphNode["kind"]>();
    expectTypeOf<Unified.MemoryGraphRelationship>().toEqualTypeOf<
      Backend.MemoryGraphEdge["relationship"]
    >();
    expectTypeOf<Unified.MemoryJobState>().toEqualTypeOf<Backend.MemoryJobView["state"]>();
    expectTypeOf<Unified.MemoryJobMarker>().toEqualTypeOf<
      NonNullable<Backend.MemoryJobView["marker"]>
    >();
    // The two dashboard halves agree with each other via the backend.
    expectTypeOf<Unified.MemoryJobState>().toEqualTypeOf<Lib.MemoryJobState>();
    expectTypeOf<Unified.MemoryJobMarker>().toEqualTypeOf<Lib.MemoryJobMarker>();
  });

  // `Record<Union, true>` fails to compile when a member is missing or invented,
  // so these literals are the checked list; the runtime asserts then compare the
  // value-level sets/maps against them.
  const NODE_KINDS: Record<Unified.MemoryGraphNodeKind, true> = {
    note: true,
    record: true,
    job: true,
    proposal: true,
    resolution: true,
    space: true,
    helper: true,
  };
  const RELATIONSHIPS: Record<Unified.MemoryGraphRelationship, true> = {
    twin: true,
    cites: true,
    derived_from: true,
    resolves: true,
    superseded_by: true,
    in_space: true,
    worker: true,
    requester: true,
    adopted_as: true,
    related_to: true,
    part_of: true,
    supersedes: true,
    contradicts: true,
  };
  const JOB_STATES: Record<Unified.MemoryJobState, true> = {
    pending: true,
    running: true,
    answered: true,
    abstained: true,
    cancelled: true,
  };
  const JOB_MARKERS: Record<Unified.MemoryJobMarker, true> = {
    hygiene: true,
    accumulation: true,
    "shared-write-review": true,
  };

  it("MEMORY_NODE_KINDS is exactly the contract's node kinds", () => {
    expect([...Unified.MEMORY_NODE_KINDS].sort()).toEqual(Object.keys(NODE_KINDS).sort());
    for (const kind of Object.keys(NODE_KINDS)) {
      expect(Unified.parseMemoryNodeId(`${kind}:x`)).toEqual({ kind, ref: "x" });
    }
  });

  it("every contract relationship has a renderer (memory edge style or legacy link)", () => {
    for (const rel of Object.keys(RELATIONSHIPS)) {
      const rendered =
        rel in Unified.MEMORY_EDGE_STYLES || Unified.LEGACY_LINK_RELATIONSHIPS.has(rel);
      expect(rendered, `relationship "${rel}" has no edge renderer`).toBe(true);
    }
    // And nothing is styled that the contract cannot send.
    for (const rel of [
      ...Object.keys(Unified.MEMORY_EDGE_STYLES),
      ...Unified.LEGACY_LINK_RELATIONSHIPS,
    ]) {
      expect(rel in RELATIONSHIPS, `styled relationship "${rel}" is not in the contract`).toBe(
        true,
      );
    }
  });

  it("job state colors and marker badges cover exactly the contract's members", () => {
    expect(Object.keys(Unified.JOB_STATE_COLORS).sort()).toEqual(Object.keys(JOB_STATES).sort());
    expect(Object.keys(Unified.JOB_MARKER_BADGES).sort()).toEqual(Object.keys(JOB_MARKERS).sort());
  });

  it("legend glyphs name only contract node kinds, one row each", () => {
    const kinds = Unified.MEMORY_GLYPHS.map((g) => g.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const kind of kinds) expect(kind in NODE_KINDS).toBe(true);
  });
});
