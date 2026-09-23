// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Structural parity between the backend ops contract (`src/net/ops-types.ts`)
 * and the dashboard module that consumes it. The module re-exports the wire
 * types, so what is pinned here is the DERIVED vocabulary (named aliases and
 * the label/color maps the components key on) — the places a future "let me
 * just inline this union" edit would silently fork the contract.
 *
 * `expectTypeOf` assertions are type-level (fail `tsc --noEmit`); the runtime
 * `expect`s cover the value-level maps so the vitest run also catches a pause
 * kind or retention kind the visual vocabulary forgot.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import type * as Backend from "../../../src/net/ops-types";
import {
  PAUSE_KIND_CLASS,
  PAUSE_KIND_LABEL,
  PROVIDER_VERDICT_CLASS,
  RETENTION_KIND_CLASS,
  TOOL_PROFILE_ORDER,
} from "../components/ops/format";
import type * as Lib from "../lib/ops-types";

describe("ops-types (dashboard lib) matches the backend contract", () => {
  it("re-exports every shared view type unchanged", () => {
    expectTypeOf<Lib.AgentOperatorRow>().toEqualTypeOf<Backend.AgentOperatorRow>();
    expectTypeOf<Lib.OpsSpend>().toEqualTypeOf<Backend.OpsSpend>();
    expectTypeOf<Lib.OpsRetention>().toEqualTypeOf<Backend.OpsRetention>();
    expectTypeOf<Lib.OpsRetentionPolicy>().toEqualTypeOf<Backend.OpsRetentionPolicy>();
    expectTypeOf<Lib.OpsRetentionReport>().toEqualTypeOf<Backend.OpsRetentionReport>();
    expectTypeOf<Lib.OpsPrompt>().toEqualTypeOf<Backend.OpsPrompt>();
    expectTypeOf<Lib.ProviderProbeSummary>().toEqualTypeOf<Backend.ProviderProbeSummary>();
    expectTypeOf<Lib.OpsSecurity>().toEqualTypeOf<Backend.OpsSecurity>();
    expectTypeOf<Lib.OpsLimiter>().toEqualTypeOf<Backend.OpsLimiter>();
    expectTypeOf<Lib.OpsOverview>().toEqualTypeOf<Backend.OpsOverview>();
    expectTypeOf<Lib.OpsAgentStopResponse>().toEqualTypeOf<Backend.OpsAgentStopResponse>();
    expectTypeOf<Lib.OpsToolProfile>().toEqualTypeOf<Backend.OpsToolProfile>();
    expectTypeOf<Lib.OpsAgentPauseKind>().toEqualTypeOf<Backend.OpsAgentPauseKind>();
  });

  it("derives the named aliases from the contract's inline unions", () => {
    expectTypeOf<Lib.OpsScope>().toEqualTypeOf<Backend.OpsOverview["scope"]>();
    expectTypeOf<Lib.OpsRetentionKind>().toEqualTypeOf<Backend.OpsRetentionPolicy["kind"]>();
    expectTypeOf<Lib.AgentPause>().toEqualTypeOf<NonNullable<Backend.AgentOperatorRow["paused"]>>();
    expectTypeOf<"privileged" | "resident">().toEqualTypeOf<Lib.OpsScope>();
    expectTypeOf<
      "budget" | "spend-cap" | "upstream-errors"
    >().toEqualTypeOf<Lib.OpsAgentPauseKind>();
    expectTypeOf<"full" | "crew" | "minimal">().toEqualTypeOf<Lib.OpsToolProfile>();
  });

  // `Record<Union, true>` fails to compile when a member is missing or invented,
  // so these literals are the checked list; the runtime asserts compare the maps.
  const PAUSE_KINDS: Record<Lib.OpsAgentPauseKind, true> = {
    budget: true,
    "spend-cap": true,
    "upstream-errors": true,
  };
  const RETENTION_KINDS: Record<Lib.OpsRetentionKind, true> = {
    telemetry: true,
    ledger: true,
    audit: true,
    "append-only": true,
  };
  const TOOL_PROFILES: Record<Lib.OpsToolProfile, true> = { full: true, crew: true, minimal: true };

  it("pause labels and colors cover exactly the contract's pause kinds", () => {
    expect(Object.keys(PAUSE_KIND_LABEL).sort()).toEqual(Object.keys(PAUSE_KINDS).sort());
    expect(Object.keys(PAUSE_KIND_CLASS).sort()).toEqual(Object.keys(PAUSE_KINDS).sort());
  });

  it("retention kind colors cover exactly the contract's kinds", () => {
    expect(Object.keys(RETENTION_KIND_CLASS).sort()).toEqual(Object.keys(RETENTION_KINDS).sort());
  });

  it("the profile bars render every tool profile once", () => {
    expect([...TOOL_PROFILE_ORDER].sort()).toEqual(Object.keys(TOOL_PROFILES).sort());
    expect(new Set(TOOL_PROFILE_ORDER).size).toBe(TOOL_PROFILE_ORDER.length);
  });

  it("every provider verdict has a chip style", () => {
    expect(Object.keys(PROVIDER_VERDICT_CLASS).sort()).toEqual(
      ["ok", "fallback", "tools", "text", "error"].sort(),
    );
  });
});
