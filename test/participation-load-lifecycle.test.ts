// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { qualifyParticipationLoad } from "../scripts/qualify-participation-load";
import { RateLimiter } from "../src/auth/rate-limiter";
import { Engine } from "../src/engine/engine";
import { getTrustProfile } from "../src/engine/trust-profile";
import { McpServerAdapter } from "../src/net/mcp-server";
import { MarinaDB } from "../src/persistence/database";
import { scopeProcessState } from "./process-state";

test("participation qualification restores caller state after setup fails", async () => {
  using _state = scopeProcessState({
    trustProfile: "public",
    rateLimitBypass: false,
    env: { WS_HOST: "caller-host" },
  });
  const directory = mkdtempSync(join(tmpdir(), "marina-load-setup-"));
  const close = spyOn(MarinaDB.prototype, "close");
  const register = spyOn(Engine.prototype, "registerRoom").mockImplementation(() => {
    expect(getTrustProfile()).toBe("local");
    expect(RateLimiter.bypass).toBe(true);
    expect(process.env.WS_HOST).toBe("127.0.0.1");
    throw new Error("fixture registration failed");
  });
  try {
    await expect(qualifyParticipationLoad({ directory })).rejects.toThrow(
      "fixture registration failed",
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(getTrustProfile()).toBe("public");
    expect(RateLimiter.bypass).toBe(false);
    expect(process.env.WS_HOST).toBe("caller-host");
  } finally {
    register.mockRestore();
    close.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("real MCP qualification restores unresolved profile and bypass after cleanup", async () => {
  using _state = scopeProcessState({
    trustProfile: null,
    rateLimitBypass: true,
    env: { WS_HOST: undefined, MARINA_PROFILE: "public" },
  });
  const directory = mkdtempSync(join(tmpdir(), "marina-load-lifecycle-"));
  try {
    const report = await qualifyParticipationLoad({
      directory,
      participants: 2,
      records: 2,
      operations: 2,
    });
    expect(report.passed).toBe(true);
    expect(report.revocation_checked).toBe(true);
    expect(getTrustProfile()).toBe("public");
    expect(getTrustProfile({})).toBe("shared");
    expect(RateLimiter.bypass).toBe(true);
    expect(process.env.WS_HOST).toBeUndefined();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("qualification closes the database and restores state when adapter cleanup fails", async () => {
  using _state = scopeProcessState({
    trustProfile: "public",
    rateLimitBypass: false,
    env: { WS_HOST: "caller-host" },
  });
  const directory = mkdtempSync(join(tmpdir(), "marina-load-cleanup-"));
  const originalStop = McpServerAdapter.prototype.stop;
  const close = spyOn(MarinaDB.prototype, "close");
  const stop = spyOn(McpServerAdapter.prototype, "stop").mockImplementation(async function (
    this: McpServerAdapter,
  ) {
    await originalStop.call(this);
    throw new Error("adapter cleanup failed");
  });
  try {
    await expect(
      qualifyParticipationLoad({ directory, participants: 2, records: 1, operations: 1 }),
    ).rejects.toThrow("adapter cleanup failed");
    expect(close).toHaveBeenCalledTimes(1);
    expect(getTrustProfile()).toBe("public");
    expect(RateLimiter.bypass).toBe(false);
    expect(process.env.WS_HOST).toBe("caller-host");
  } finally {
    stop.mockRestore();
    close.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
