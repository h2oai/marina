// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Trust profile — WHO this Marina is for, derived from how it is bound.
 *
 * Friction (safety gates, the witness ladder, rank floors, rate limits,
 * admission budgets, exec approval prompts, full-fsync durability) is the
 * right default for a SHARED or PUBLIC instance. A LOCAL instance — one
 * operator on their own machine, loopback-only — runs completely ungated for
 * performance and usability, with the audit trail intact. YOLO applies to
 * permissions, never to records: the exec-decision audit, the cognitive
 * ledger, memory receipts, journaling, trusted/unverified labels and
 * untrusted-context framing stay on in every profile.
 *
 * Resolution (see `resolveTrustProfile`):
 *  - `MARINA_PROFILE=local|shared|public` wins when set.
 *  - Otherwise `local` when every listener binds loopback and no external
 *    auth is configured; `shared` when `MARINA_AUTH=better-auth` is on;
 *    `public` for any non-loopback bind without auth.
 *
 * `local` combined with a non-loopback bind and passwordless login is FATAL
 * at startup (`assertTrustProfileSafe`) unless the operator explicitly
 * acknowledges the risk — the same rule that already protects the `open`
 * autonomy posture. `MARINA_AUTONOMY=guarded` (or a `shared`/`public`
 * profile) re-enables every gate for admins who want them.
 *
 * Process default: until `main.ts` resolves and sets the profile, in-process
 * consumers (tests, embedded engines) see `shared` — i.e. legacy, fully
 * enforced behavior — unless `MARINA_PROFILE` is set explicitly.
 */

export type TrustProfile = "local" | "shared" | "public";

const PROFILES: ReadonlySet<string> = new Set(["local", "shared", "public"]);

let resolved: TrustProfile | undefined;

export interface TrustProfileResolution {
  profile: TrustProfile;
  /** True when derived from the bind/auth situation rather than set explicitly. */
  derived: boolean;
  reason: string;
}

function explicitProfile(env: NodeJS.ProcessEnv): TrustProfile | undefined {
  const raw = env.MARINA_PROFILE?.trim().toLowerCase();
  if (!raw) return undefined;
  if (!PROFILES.has(raw)) {
    throw new Error(`MARINA_PROFILE must be local, shared or public (got "${raw}")`);
  }
  return raw as TrustProfile;
}

/** Pure resolution from the operator's environment and the resolved bind. */
export function resolveTrustProfile(input: {
  env?: NodeJS.ProcessEnv;
  loopbackOnlyBind: boolean;
  authEnabled: boolean;
}): TrustProfileResolution {
  const env = input.env ?? process.env;
  const explicit = explicitProfile(env);
  if (explicit) {
    return { profile: explicit, derived: false, reason: `MARINA_PROFILE=${explicit}` };
  }
  if (input.authEnabled) {
    return {
      profile: "shared",
      derived: true,
      reason: "MARINA_AUTH=better-auth is on — sign-in implies more than one person",
    };
  }
  if (input.loopbackOnlyBind) {
    return {
      profile: "local",
      derived: true,
      reason: "every listener binds loopback and no external auth is configured",
    };
  }
  return { profile: "public", derived: true, reason: "non-loopback bind without sign-in" };
}

/**
 * Startup safety: a `local` profile only makes sense when nobody but the
 * operator can reach the process. Throws a descriptive error otherwise.
 */
export function assertTrustProfileSafe(input: {
  profile: TrustProfile;
  loopbackOnlyBind: boolean;
  authEnabled: boolean;
  insecurePublicAck: boolean;
  bindHost: string;
}): void {
  if (input.profile !== "local") return;
  if (input.loopbackOnlyBind || input.authEnabled || input.insecurePublicAck) return;
  throw new Error(
    `FATAL: MARINA_PROFILE=local (ungated) combined with a NON-LOOPBACK bind ` +
      `("${input.bindHost}") and passwordless login would hand every capability to anyone ` +
      `who can reach this host. Fix ONE of:\n` +
      `  • keep it local: unset WS_HOST/MARINA_HOST/MARINA_PUBLIC, or\n` +
      `  • use a gated profile: set MARINA_PROFILE=shared or public, or\n` +
      `  • require sign-in: set MARINA_AUTH=better-auth, or\n` +
      `  • accept the risk explicitly: set MARINA_ALLOW_INSECURE_PUBLIC=true.`,
  );
}

/** Record the profile `main.ts` resolved so every consumer agrees. */
export function setTrustProfile(profile: TrustProfile): void {
  resolved = profile;
}

/** Test hook: forget the resolved profile (falls back to env / `shared`). */
export function resetTrustProfileForTests(): void {
  resolved = undefined;
}

export function getTrustProfile(env: NodeJS.ProcessEnv = process.env): TrustProfile {
  if (resolved) return resolved;
  try {
    return explicitProfile(env) ?? "shared";
  } catch {
    return "shared";
  }
}

/** True when this instance is the single local operator's own (loopback-only).
 *  Drives the PERFORMANCE/usability defaults: rate limits, admission budgets,
 *  durability, archive fallback, passthru injection. */
export function isLocalProfile(env: NodeJS.ProcessEnv = process.env): boolean {
  return getTrustProfile(env) === "local";
}

/** True when a LOCAL instance also runs with PERMISSIONS ungated: gates,
 *  witnesses, rank floors, exec prompts, skill-import confinement. An admin who
 *  wants the gates back on a personal instance sets `MARINA_AUTONOMY=guarded`
 *  explicitly — that single line re-enforces every permission check while the
 *  local performance defaults stay in place. */
export function isLocalUngated(env: NodeJS.ProcessEnv = process.env): boolean {
  return isLocalProfile(env) && env.MARINA_AUTONOMY?.trim().toLowerCase() !== "guarded";
}

/** `MARINA_OPEN_API=true` — the dev-only unauthenticated-API switch. Env-only by
 *  design and the single read every HTTP surface consults: only the exact string
 *  `"true"` enables it. */
export function isOpenApiMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MARINA_OPEN_API === "true";
}

export function describeTrustProfile(profile: TrustProfile = getTrustProfile()): string {
  switch (profile) {
    case "local":
      return "LOCAL — ungated: gates, witnesses, rank floors, rate limits and budgets are off for this operator; audit stays on (set MARINA_AUTONOMY=guarded or MARINA_PROFILE=shared to re-enable gates)";
    case "shared":
      return "SHARED — gates, ranks and limits enforced; sign-in identifies people";
    case "public":
      return "PUBLIC — everything enforced; passwordless names carry no authority";
  }
}
