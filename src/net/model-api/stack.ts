// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// The passthru instrument stack: ONE parsed feature set for a `/v1` request
// instead of a header or prefix per instrument.
//
//   x-marina-stack: full | none | <members, comma-separated>
//   marina/full:<model>                     (the model-id form of `full`)
//
// Members: lessons, obligations, argcheck, verify, context, learn.
//
// Default (`MARINA_PASSTHRU_STACK`, default `identified`): an IDENTIFIED
// caller — a key bound to an entity, an authorized name-map, or any
// non-internal caller under the local trust profile — gets DEFAULT_STACK
// without asking. An anonymous or shared caller (a plain key, the open-API
// sentinel outside the local profile) gets nothing and stays byte-identical.
// Marina's own agents (internal token) are never given the passthru stack:
// their loops carry the same instruments through MARINA_OBLIGATIONS /
// MARINA_ARGCHECK / MARINA_LESSONS_*.
//
// An explicit list is exact: every member runs or the request is refused
// (400 `unsupported_parameter`) — never silently dropped. `full` expands to
// every member this caller and surface can honour and reports what it left
// out (`skipped=`) in the `x-marina-stack` response header.

import { isLocalProfile } from "../../engine/trust-profile";
import { isInternalCaller, type PassthruAuthResult, unsupportedParam } from "./shared";

/** Request: the instrument set (`full`, `none`, or a member list). Response: the effective set. */
export const STACK_HEADER = "x-marina-stack";

/** `marina/full:<model>` — the model-id form of `x-marina-stack: full`. */
export const FULL_MODEL_PREFIX = "marina/full:";

export const STACK_MEMBERS = [
  "lessons",
  "obligations",
  "argcheck",
  "verify",
  "context",
  "learn",
] as const;
export type StackMember = (typeof STACK_MEMBERS)[number];

/**
 * What an identified caller gets without asking. `verify` is left out (it
 * multiplies calls and refuses streaming); `context` keeps its own rules
 * (stored opt-in, `X-Marina-Context`, on under the local profile).
 */
export const DEFAULT_STACK: readonly StackMember[] = [
  "lessons",
  "obligations",
  "argcheck",
  "learn",
];

export type PassthruStackPolicy = "identified" | "all" | "off";

/** `MARINA_PASSTHRU_STACK=identified|all|off` (default `identified`; junk ⇒ default). */
export function passthruStackPolicy(env: NodeJS.ProcessEnv = process.env): PassthruStackPolicy {
  const v = env.MARINA_PASSTHRU_STACK?.trim().toLowerCase();
  if (v === "all" || v === "off" || v === "identified") return v;
  if (v === "none" || v === "false" || v === "0") return "off";
  return "identified";
}

export type StackRequest =
  | { kind: "full" }
  | { kind: "none" }
  | { kind: "list"; members: Set<StackMember> }
  | { kind: "error"; message: string };

/** Parse an `x-marina-stack` request value; undefined when absent or empty. */
export function parseStackHeader(raw: string | null | undefined): StackRequest | undefined {
  const v = raw?.trim().toLowerCase();
  if (!v) return undefined;
  if (v === "full" || v === "all" || v === "on") return { kind: "full" };
  if (v === "none" || v === "off") return { kind: "none" };
  const members = new Set<StackMember>();
  for (const part of v.split(",")) {
    const m = part.trim();
    if (!m) continue;
    if (!(STACK_MEMBERS as readonly string[]).includes(m)) {
      return {
        kind: "error",
        message: `Unknown ${STACK_HEADER} member "${m}" (expected full, none, or a list of ${STACK_MEMBERS.join(", ")}).`,
      };
    }
    members.add(m as StackMember);
  }
  return { kind: "list", members };
}

/**
 * An identified caller: not Marina's own agent, and either a distinct
 * identity (`distinct`, the same test as context injection — a bound key or
 * an authorized name-map) or any caller under the local trust profile.
 */
export function identifiedCaller(
  auth: PassthruAuthResult | undefined,
  distinct: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!auth || isInternalCaller(auth)) return false;
  return distinct || isLocalProfile(env);
}

/** The stack a request asked for (or was given by default), before surface checks. */
export interface PassthruStack {
  members: Set<StackMember>;
  /** Where the set came from. */
  source: "header" | "prefix" | "default" | "none";
  /** `full` was asked for: unavailable members are skipped and reported, not refused. */
  full: boolean;
  /** Members left out of `full`, with the reason (`verify(stream)`). */
  skipped: string[];
}

/**
 * Resolve a request's stack: the `x-marina-stack` header, else the
 * `marina/full:` model prefix (`fullPrefix`), else the operator default for
 * this caller. `distinct` is asked only when the default applies.
 */
export function resolvePassthruStack(
  req: { headers: Headers },
  auth: PassthruAuthResult | undefined,
  fullPrefix: boolean,
  distinct: () => boolean,
  env: NodeJS.ProcessEnv = process.env,
): PassthruStack | { error: string } {
  const asked = parseStackHeader(req.headers.get(STACK_HEADER));
  if (asked?.kind === "error") return { error: asked.message };
  if (asked?.kind === "none")
    return { members: new Set(), source: "header", full: false, skipped: [] };
  if (asked?.kind === "full")
    return { members: new Set(STACK_MEMBERS), source: "header", full: true, skipped: [] };
  if (asked?.kind === "list")
    return { members: asked.members, source: "header", full: false, skipped: [] };
  if (fullPrefix)
    return { members: new Set(STACK_MEMBERS), source: "prefix", full: true, skipped: [] };
  const policy = passthruStackPolicy(env);
  if (policy === "off" || !auth || isInternalCaller(auth))
    return { members: new Set(), source: "none", full: false, skipped: [] };
  if (policy === "all" || identifiedCaller(auth, distinct(), env))
    return { members: new Set(DEFAULT_STACK), source: "default", full: false, skipped: [] };
  return { members: new Set(), source: "none", full: false, skipped: [] };
}

/**
 * Drop a member the caller or surface cannot honour. Under `full` it is
 * recorded in `skipped`; for an explicitly listed member it is an error
 * (the request is refused). A member a default stack cannot honour is
 * simply not run (the caller asked for nothing).
 */
export function withoutMember(
  stack: PassthruStack,
  member: StackMember,
  reason: string,
): string | undefined {
  if (!stack.members.has(member)) return undefined;
  stack.members.delete(member);
  if (stack.full) {
    stack.skipped.push(`${member}(${reason})`);
    return undefined;
  }
  if (stack.source === "header")
    return `${STACK_HEADER} member "${member}" cannot run on this request: ${reason}.`;
  return undefined;
}

/** The `x-marina-stack` response value: the members that ran, the source, anything skipped. */
export function stackHeaderValue(members: Iterable<string>, stack: PassthruStack): string {
  const ran = [...members];
  return [
    ran.length ? ran.join(",") : "none",
    `source=${stack.source}`,
    ...(stack.skipped.length ? [`skipped=${stack.skipped.join(",")}`] : []),
  ].join("; ");
}

/** The per-instrument request headers the chat surfaces honour (besides `x-marina-stack`). */
const INSTRUMENT_HEADERS = [
  "x-marina-lessons",
  "x-marina-obligations",
  "x-marina-argcheck",
  "x-marina-review",
  "x-marina-learn",
] as const;

/**
 * A 400 `unsupported_parameter` when a request on a surface without the
 * instrument stack (`/v1/responses`, the Ollama routes) asks for any part of
 * it by header — never a silent drop. `off`/`none` values are accepted.
 */
export function rejectStackHeaders(req: { headers: Headers }, route: string): Response | undefined {
  const off = (v: string) => ["off", "none", "false", "0"].includes(v);
  for (const name of [STACK_HEADER, ...INSTRUMENT_HEADERS]) {
    const v = req.headers.get(name)?.trim().toLowerCase();
    if (v && !off(v))
      return unsupportedParam(
        name,
        `The ${name} header is honored only on /v1/chat/completions and /v1/messages; ${route} would ignore it.`,
      );
  }
  return undefined;
}
