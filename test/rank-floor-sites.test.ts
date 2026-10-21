// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Inline subcommand rank floors go through the one rule, `rankFloorRefusal`:
 * under a gated profile a refusal raises a challenge (a token the owner or an
 * operator can approve); the operator's local instance passes the floor.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { resetChallengesForTests } from "../src/engine/challenges";
import { resetGateContextForTests } from "../src/engine/gate-context";
import type { EntityId } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { stripAnsi } from "./helpers";
import { scopeProcessState } from "./process-state";

const tokenIn = (text: string) => text.match(/\b(ch_[0-9a-f]{12})\b/)?.[1];

const FLOORED: Array<{ input: string; refusal: string; rank: number }> = [
  { input: "bankroll set 100", refusal: "requires rank 5+", rank: 2 },
  { input: "position close ord_1", refusal: "requires rank 5+", rank: 2 },
  { input: "observe log Nobody", refusal: "steward rank (7)", rank: 2 },
  { input: "source connector nothing", refusal: "steward rank (7)", rank: 2 },
];

describe("inline rank floors use rankFloorRefusal", () => {
  afterEach(() => {
    resetChallengesForTests();
    resetGateContextForTests();
  });

  for (const site of FLOORED) {
    it(`\`${site.input.split(" ").slice(0, 2).join(" ")}\` raises a challenge under a gated profile`, async () => {
      using _state = scopeProcessState({
        trustProfile: "shared",
        env: { MARINA_AUTONOMY: undefined },
      });
      const fixture = createTestEngine();
      try {
        const { connection, entityId } = fixture.login("Floored");
        fixture.engine.entities.get(entityId as EntityId)!.properties.rank = site.rank;
        connection.clear();
        await fixture.engine.processCommand(entityId, site.input);
        const text = stripAnsi(connection.allText().join("\n"));
        expect(text).toContain(site.refusal);
        expect(tokenIn(text)).toBeDefined();
      } finally {
        await fixture.dispose();
      }
    });
  }

  it("the local operator's instance passes an inline floor", async () => {
    using _state = scopeProcessState({
      trustProfile: "local",
      env: { MARINA_AUTONOMY: undefined },
    });
    const fixture = createTestEngine();
    try {
      const { connection, entityId } = fixture.login("Local");
      fixture.engine.entities.get(entityId as EntityId)!.properties.rank = 2;
      connection.clear();
      await fixture.engine.processCommand(entityId, "bankroll set 100");
      const text = stripAnsi(connection.allText().join("\n"));
      expect(text).not.toContain("requires rank 5+");
      expect(text.toLowerCase()).toContain("bankroll");
    } finally {
      await fixture.dispose();
    }
  });
});
