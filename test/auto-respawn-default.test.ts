// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * AGENT_AUTORESPAWN default: on for a local install with a usable provider,
 * off otherwise; an explicit value always wins. The workbench preset no
 * longer pins agents off; the cost-controlled presets still do.
 */

import { describe, expect, it } from "bun:test";
import { spendCapNotice } from "../scripts/init";
import { configurationPreset } from "../src/config/presets";
import { autoRespawnEnabled } from "../src/engine/auto-respawn";
import { setTrustProfile } from "../src/engine/trust-profile";
import { scopeProcessState } from "./process-state";

describe("autoRespawnEnabled", () => {
  it("unset: local + provider ⇒ on; no provider or non-local ⇒ off", () => {
    using _state = scopeProcessState();
    setTrustProfile("local");
    expect(autoRespawnEnabled(true, {})).toBe(true);
    expect(autoRespawnEnabled(false, {})).toBe(false);
    setTrustProfile("shared");
    expect(autoRespawnEnabled(true, {})).toBe(false);
    setTrustProfile("public");
    expect(autoRespawnEnabled(true, {})).toBe(false);
  });

  it("an explicit value wins in every profile", () => {
    using _state = scopeProcessState();
    setTrustProfile("local");
    expect(autoRespawnEnabled(true, { AGENT_AUTORESPAWN: "false" })).toBe(false);
    expect(autoRespawnEnabled(true, { AGENT_AUTORESPAWN: "nope" })).toBe(false);
    setTrustProfile("public");
    expect(autoRespawnEnabled(false, { AGENT_AUTORESPAWN: "true" })).toBe(true);
  });
});

describe("presets", () => {
  it("workbench leaves agents to the runtime defaults; minimal and shared-team pin them off", () => {
    const workbench = configurationPreset("workbench");
    expect(workbench.MARINA_ROOM_AGENTS).toBeUndefined();
    expect(workbench.AGENT_AUTORESPAWN).toBeUndefined();
    for (const name of ["minimal", "shared-team"]) {
      expect(configurationPreset(name).MARINA_ROOM_AGENTS).toBe("false");
      expect(configurationPreset(name).AGENT_AUTORESPAWN).toBe("false");
    }
  });

  it("init tells the operator about the spend cap", () => {
    expect(spendCapNotice({})).toContain("$50 per UTC day (default)");
    expect(spendCapNotice({ MARINA_DAILY_SPEND_CAP_USD: "5" })).toContain("$5 per UTC day;");
    expect(spendCapNotice({ MARINA_DAILY_SPEND_CAP_USD: "0" })).toContain("UNCAPPED");
    expect(spendCapNotice({})).toContain("AGENT_AUTORESPAWN=false");
  });
});
