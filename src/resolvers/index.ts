// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

// Resolver registration entrypoint. Called once per engine boot to register
// the built-in resolvers. Worlds and tests can register additional kinds via
// registerResolver() directly.

import { registerBuiltinCalibrationFinders } from "./calibration";
import { getResolver, registerResolver } from "./registry";
import { createResolvingResolver } from "./resolving";
import type { Resolver } from "./types";

export {
  type CalibrationFinder,
  clearCalibrationFinders,
  listCalibrationFinders,
  parseSampleId,
  registerCalibrationFinder,
  runCalibration,
} from "./calibration";
export { clearResolvers, getResolver, listResolvers, registerResolver } from "./registry";
export type { ResolvingArgs, ResolvingDeps } from "./resolving";
export { createResolvingResolver } from "./resolving";
export { findLatestSample, parseSampleFromContent, writeSample } from "./sample-writer";
export type {
  ArgParseResult,
  Resolver,
  ResolverContext,
  ResolverInput,
  ResolverOutput,
  Sample,
  SampleStatus,
} from "./types";

// ─── echoing — trivial test-fixture resolver ────────────────────────────────
//
// Accepts any args, echoes them back as the value. Used by the resolver
// framework's own tests and as a smoke-test endpoint for new probe surfaces
// (MCP, HTTP). Never gates on external state — every call returns "changed".

const echoing: Resolver<{ payload: string; tag?: string }> = {
  kind: "echoing",
  description: "Echo args back as the sample value. Test-fixture resolver.",
  parseArgs(raw) {
    const payload = raw.payload;
    if (!payload) return { ok: false, error: "echoing requires payload:<string>" };
    return { ok: true, args: { payload, tag: raw.tag } };
  },
  idFromArgs(args) {
    return args.tag ? `${args.tag}/${args.payload}` : args.payload;
  },
  closesOn: [],
  async resolve({ args }) {
    return {
      status: "changed",
      value: { echoed: args.payload, tag: args.tag },
      source: "echoing://local",
    };
  },
};

/** Idempotent — safe to call once per engine boot or repeatedly in tests
 *  that share a process. Registers a resolver only if its kind isn't
 *  already present, and registers the built-in calibration finders. */
export function registerBuiltinResolvers(): void {
  if (!getResolver("echoing")) registerResolver(echoing);
  if (!getResolver("resolving")) registerResolver(createResolvingResolver());
  registerBuiltinCalibrationFinders();
}
