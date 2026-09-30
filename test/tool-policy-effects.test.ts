// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { classifyCommandRisk } from "../src/agent/tool-policy";
import { describeCommand } from "../src/engine/command-manifest";
import { commandFormPrefix } from "../src/sdk/command-forms";
import { createTestEngine } from "./engine-fixture";

// The agent-side risk allowlist against the effects commands declare on their
// usage forms: the allowlist may be more cautious than a declaration, never less.
describe("tool risk vs declared command effects", () => {
  it("never reads a form a command declares as a write, delete or execution", async () => {
    const t = createTestEngine();
    try {
      let checked = 0;
      for (const def of t.engine.commands.allBuiltins()) {
        for (const form of describeCommand(def).forms ?? []) {
          if (form.effect !== "write" && form.effect !== "delete" && form.effect !== "execute") {
            continue;
          }
          const command = `${commandFormPrefix(form)} x y`;
          const risk = classifyCommandRisk(command);
          expect([command, risk === "read" || risk === "self"]).toEqual([command, false]);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(0);
    } finally {
      await t.dispose();
    }
  });
});
