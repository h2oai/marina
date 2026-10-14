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
 * `MARINA_AUTONOMY=sovereign` is the explicit all-gates-off switch for a
 * sovereign, self-hosted Marina with no guests: permissions are ungated in
 * EVERY profile (gates incl. the core, rank floors, holds), exactly as under
 * local-ungated, while the profile keeps choosing the performance defaults.
 * A non-loopback bind needs MARINA_ALLOW_INSECURE_PUBLIC=true: every
 * signed-in principal gets every capability, so sign-in alone is not enough.
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
 * operator can reach the process. `local` ungates every permission check for
 * every signed-in principal, so sign-in (MARINA_AUTH) does NOT make a
 * non-loopback bind safe — only an explicit MARINA_ALLOW_INSECURE_PUBLIC=true
 * does. Throws a descriptive error otherwise.
 */
export function assertTrustProfileSafe(input: {
  profile: TrustProfile;
  loopbackOnlyBind: boolean;
  authEnabled: boolean;
  insecurePublicAck: boolean;
  bindHost: string;
  /** `MARINA_AUTONOMY=sovereign`: ungated in every profile, same bind rule. */
  sovereign?: boolean;
}): void {
  if (input.loopbackOnlyBind || input.insecurePublicAck) return;
  if (input.sovereign) {
    throw new Error(
      `FATAL: MARINA_AUTONOMY=sovereign (every gate off) combined with a NON-LOOPBACK bind ` +
        `("${input.bindHost}"). Every principal that can log in would get every capability, ` +
        `signed in or not.\n` +
        `Fix ONE of:\n` +
        `  • keep it local: unset WS_HOST/MARINA_HOST/MARINA_PUBLIC, or\n` +
        `  • keep the gates: unset MARINA_AUTONOMY (or set guarded|earned|open), or\n` +
        `  • declare a network with no guests: set MARINA_ALLOW_INSECURE_PUBLIC=true.`,
    );
  }
  if (input.profile !== "local") return;
  const authNote = input.authEnabled
    ? `Sign-in (MARINA_AUTH) is on, but it does not help: \`local\` ungates every gate for ` +
      `every signed-in user, so any remote account would get every capability.\n`
    : `With passwordless login, anyone who can reach this host would get every capability.\n`;
  throw new Error(
    `FATAL: MARINA_PROFILE=local (ungated) combined with a NON-LOOPBACK bind ` +
      `("${input.bindHost}"). ${authNote}` +
      `Fix ONE of:\n` +
      `  • keep it local: unset WS_HOST/MARINA_HOST/MARINA_PUBLIC, or\n` +
      `  • use a gated profile: set MARINA_PROFILE=shared (with MARINA_AUTH=better-auth) or public, or\n` +
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

/** Preserve the resolved override, including the unset/env-derived state.
 * Test scopes must run serially within a process and dispose in reverse order. */
export function preserveTrustProfileForTests(): Disposable {
  const previous = resolved;
  let disposed = false;
  return {
    [Symbol.dispose]() {
      if (disposed) return;
      disposed = true;
      resolved = previous;
    },
  };
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

/** `MARINA_AUTONOMY=sovereign` — the explicit all-gates-off switch. */
export function isSovereign(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MARINA_AUTONOMY?.trim().toLowerCase() === "sovereign";
}

/** True when PERMISSIONS are ungated: gates (core included), rank floors,
 *  holds, exec prompts, skill-import confinement. Two ways in: a LOCAL
 *  instance whose autonomy is not `guarded` (an admin who wants the gates back
 *  on a personal instance sets `MARINA_AUTONOMY=guarded` — that single line
 *  re-enforces every permission check while the local performance defaults
 *  stay), or `MARINA_AUTONOMY=sovereign` in any profile. */
export function isLocalUngated(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isSovereign(env)) return true;
  return isLocalProfile(env) && env.MARINA_AUTONOMY?.trim().toLowerCase() !== "guarded";
}

/** `MARINA_OPEN_API=true` — the dev-only unauthenticated-API switch. Env-only by
 *  design and the single read every HTTP surface consults: only the exact string
 *  `"true"` enables it. */
export function isOpenApiMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MARINA_OPEN_API === "true";
}

export function describeTrustProfile(
  profile: TrustProfile = getTrustProfile(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (isSovereign(env)) {
    return `${profile.toUpperCase()} + SOVEREIGN — MARINA_AUTONOMY=sovereign: every gate (core included), rank floor and hold is off for every principal; audit stays on (unset it to re-enable gates)`;
  }
  switch (profile) {
    case "local":
      // `MARINA_AUTONOMY=guarded` re-enables every permission check (isLocalUngated).
      if (env.MARINA_AUTONOMY?.trim().toLowerCase() === "guarded") {
        return "LOCAL (gated) — MARINA_AUTONOMY=guarded: gates, witnesses and rank floors are enforced; local performance defaults (rate limits, budgets, durability) stay";
      }
      return "LOCAL — ungated: gates, witnesses, rank floors, rate limits and budgets are off for this operator; audit stays on (set MARINA_AUTONOMY=guarded or MARINA_PROFILE=shared to re-enable gates)";
    case "shared":
      return "SHARED — gates, ranks and limits enforced; sign-in identifies people";
    case "public":
      return "PUBLIC — everything enforced; passwordless names carry no authority";
  }
}
