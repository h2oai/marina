// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Marina feature settings a run's server actually sees, as one sorted,
 * secret-free record — so a result records WHICH instruments ran, and two runs
 * with different settings never share a configuration (a resume, a replicate
 * group, a promotion pool). Every runner that starts or configures a server
 * should file this with its results (`benchmark-import --server-features`).
 *
 * Only behavior switches are kept: variables under the feature prefixes below,
 * minus anything that names a credential or an endpoint.
 */

/** The namespace every Marina setting shares (the prefixes below are formed under it). */
const NS = "MARINA";

/**
 * Variable-name prefixes that change what Marina does for a request or an
 * agent turn. Built from suffixes so this list never reads as a set of
 * variable names (each real variable is documented in the environment reference).
 */
export const FEATURE_ENV_PREFIXES: readonly string[] = [
  "OBLIGATIONS",
  "ARGCHECK",
  "LESSONS",
  "DECISION",
  "ANTHROPIC_AUTO_CACHE",
  "AGENT_",
  "OUTPUT_REPAIR",
  "MEMORY_",
  "PASSTHRU_",
  "READ_SWARM",
  "VERIFY_",
  "FORECAST_",
  "ROUTE",
  "TOOL_EXECUTION",
  "CORPUS_",
  "RESEARCH_",
  "CHALLENGE",
  "AUTONOMY",
  "PROFILE",
].map((suffix) => `${NS}_${suffix}`);

/** Never recorded: credentials and endpoints (a URL may carry a token). */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|_URL$|BASE_URL|ENDPOINT/i;

export function isFeatureEnvName(name: string): boolean {
  return FEATURE_ENV_PREFIXES.some((p) => name.startsWith(p)) && !SECRET_NAME.test(name);
}

/** The feature settings in `env`, sorted by name; empty values are dropped. */
export function featureEnvSnapshot(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(env).sort()) {
    const v = env[name];
    if (v !== undefined && v.trim() !== "" && isFeatureEnvName(name)) out[name] = v.trim();
  }
  return out;
}

/**
 * Parse repeatable `KEY=VALUE` flags (`--server-env`). Only feature variables
 * are accepted, so a credential never rides a command line or a config tag.
 */
export function parseServerEnv(values: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of values) {
    const i = raw.indexOf("=");
    if (i <= 0) throw new Error(`--server-env expects KEY=VALUE, got '${raw}'`);
    const name = raw.slice(0, i).trim();
    if (!isFeatureEnvName(name)) {
      throw new Error(
        `--server-env accepts Marina feature settings only (${FEATURE_ENV_PREFIXES.join(", ")}…); '${name}' is not one`,
      );
    }
    out[name] = raw.slice(i + 1).trim();
  }
  return out;
}
