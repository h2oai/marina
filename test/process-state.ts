// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { RateLimiter } from "../src/auth/rate-limiter";
import {
  preserveTrustProfileForTests,
  resetTrustProfileForTests,
  setTrustProfile,
  type TrustProfile,
} from "../src/engine/trust-profile";

/** Scope an override on an object from either checkout in a comparison benchmark. */
export function scopeProperty<T, K extends keyof T>(target: T, key: K, value: T[K]): Disposable {
  const previous = target[key];
  const scope = new DisposableStack();
  scope.defer(() => {
    target[key] = previous;
  });
  try {
    target[key] = value;
    return scope;
  } catch (error) {
    scope.dispose();
    throw error;
  }
}

/** Use with `using` around the entire fixture, including setup and async teardown.
 * Restores exact prior values on return/throw. This is process-wide state, so scopes
 * must be serial (or nested); concurrent worlds with different profiles need workers. */
export function scopeProcessState(
  options: {
    trustProfile?: TrustProfile | null;
    rateLimitBypass?: boolean;
    env?: Record<string, string | undefined>;
  } = {},
): DisposableStack {
  using scope = new DisposableStack();
  scope.use(preserveTrustProfileForTests());
  scope.use(scopeProperty(RateLimiter, "bypass", options.rateLimitBypass ?? RateLimiter.bypass));
  for (const [key, value] of Object.entries(options.env ?? {})) {
    const previous = process.env[key];
    scope.defer(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (options.trustProfile === null) resetTrustProfileForTests();
  else if (options.trustProfile !== undefined) setTrustProfile(options.trustProfile);
  return scope.move();
}
