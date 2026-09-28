// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { RateLimiter } from "../src/auth/rate-limiter";
import { getTrustProfile, setTrustProfile } from "../src/engine/trust-profile";
import { scopeProcessState, scopeProperty } from "./process-state";

test("nested scopes restore prior profile, bypass and absent/empty environment values", () => {
  using _outer = scopeProcessState({
    trustProfile: "public",
    rateLimitBypass: true,
    env: { WS_HOST: "prior-host", MARINA_PROFILE: undefined, MARINA_AUTONOMY: "" },
  });
  {
    using _inner = scopeProcessState({
      trustProfile: "local",
      rateLimitBypass: false,
      env: { WS_HOST: undefined, MARINA_PROFILE: "shared", MARINA_AUTONOMY: "guarded" },
    });
    expect(getTrustProfile()).toBe("local");
    expect(RateLimiter.bypass).toBe(false);
    expect(process.env.WS_HOST).toBeUndefined();
    setTrustProfile("shared");
    RateLimiter.bypass = true;
  }
  expect(getTrustProfile()).toBe("public");
  expect(RateLimiter.bypass).toBe(true);
  expect(process.env.WS_HOST).toBe("prior-host");
  expect(process.env.MARINA_PROFILE).toBeUndefined();
  expect(process.env.MARINA_AUTONOMY).toBe("");
});

test("restores unresolved profile semantics instead of freezing the effective value", () => {
  using _outer = scopeProcessState({ trustProfile: null, env: { MARINA_PROFILE: "public" } });
  {
    using _inner = scopeProcessState({ trustProfile: "local" });
    expect(getTrustProfile({})).toBe("local");
  }
  expect(getTrustProfile()).toBe("public");
  expect(getTrustProfile({})).toBe("shared");
  process.env.MARINA_PROFILE = "local";
  expect(getTrustProfile()).toBe("local");
});

test("restores state when awaited work and teardown both throw", async () => {
  using _outer = scopeProcessState({
    trustProfile: "public",
    rateLimitBypass: false,
    env: { WS_HOST: "caller-host" },
  });
  const run = async () => {
    using _state = scopeProcessState({
      trustProfile: "local",
      rateLimitBypass: true,
      env: { WS_HOST: "127.0.0.1" },
    });
    using cleanup = new DisposableStack();
    cleanup.defer(() => {
      throw new Error("teardown failed");
    });
    await Promise.resolve();
    throw new Error("work failed");
  };
  await expect(run()).rejects.toMatchObject({
    name: "SuppressedError",
    error: { message: "teardown failed" },
    suppressed: { message: "work failed" },
  });
  expect(getTrustProfile()).toBe("public");
  expect(RateLimiter.bypass).toBe(false);
  expect(process.env.WS_HOST).toBe("caller-host");
});

test("partial scope construction rolls back applied overrides", () => {
  using _outer = scopeProcessState({ trustProfile: "public", rateLimitBypass: false });
  expect(() =>
    scopeProcessState({
      trustProfile: "local",
      rateLimitBypass: true,
      env: {
        get WS_HOST(): string {
          throw new Error("fixture options failed");
        },
      },
    }),
  ).toThrow("fixture options failed");
  expect(getTrustProfile()).toBe("public");
  expect(RateLimiter.bypass).toBe(false);
});

test("fixture ownership transfers only after successful setup and survives failed cleanup", () => {
  using _outer = scopeProcessState({ trustProfile: "public", rateLimitBypass: false });
  let state: DisposableStack | undefined;
  const setup = (fail: boolean) => {
    using pending = scopeProcessState({ trustProfile: "local", rateLimitBypass: true });
    if (fail) throw new Error("setup failed");
    state = pending.move();
  };
  expect(() => setup(true)).toThrow("setup failed");
  expect(state).toBeUndefined();
  expect(getTrustProfile()).toBe("public");
  expect(RateLimiter.bypass).toBe(false);
  setup(false);
  expect(getTrustProfile()).toBe("local");
  const teardown = () => {
    using _state = state;
    state = undefined;
    throw new Error("cleanup failed");
  };
  expect(teardown).toThrow("cleanup failed");
  expect(getTrustProfile()).toBe("public");
  expect(RateLimiter.bypass).toBe(false);
});

test("disposing twice cannot overwrite a later scope", () => {
  using _outer = scopeProcessState({ trustProfile: "public", rateLimitBypass: false });
  using first = scopeProcessState({ trustProfile: "local", rateLimitBypass: true });
  first.dispose();
  using _second = scopeProcessState({ trustProfile: "shared", rateLimitBypass: true });
  first.dispose();
  expect(getTrustProfile()).toBe("shared");
  expect(RateLimiter.bypass).toBe(true);
});

test("benchmark scopes override the limiter from the measured checkout only", () => {
  const candidate = { bypass: false };
  const baseline = { bypass: false };
  {
    using _scope = scopeProperty(baseline, "bypass", true);
    expect(baseline.bypass).toBe(true);
    expect(candidate.bypass).toBe(false);
  }
  expect(baseline.bypass).toBe(false);
});
