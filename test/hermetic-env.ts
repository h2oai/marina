// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The backend suite runs in a hermetic environment: Bun auto-loads the
 * repository's `.env` into `bun test`, and a developer's shell may export the
 * same settings. Either would turn on live providers, harness decisions (which
 * can then call a running local Marina), spend caps or other server behaviour
 * that CI never sees. `test/preload.ts` calls {@link scrubTestEnvironment}
 * before any test file loads.
 *
 * Removed: every `MARINA_*` variable, every server variable in
 * `config/environment.reference`, every provider credential and local-runtime
 * setting named by model discovery, and every key defined in a `.env` file Bun
 * loads for tests. Kept: `MARINA_TEST_*` (explicit opt-ins for local checks
 * such as `MARINA_TEST_CONTAINER_IMAGE`), `NODE_ENV`, and proxy settings.
 * `MARINA_TEST_KEEP_ENV=1` keeps the whole environment for deliberate live
 * checks. A test that needs a setting scopes it with `scopeProcessState()`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  environmentCatalog,
  parseEnvironment,
  readEnvironmentReference,
} from "../src/config/environment";
import {
  CLOUD_PROVIDER_KEY_ENVS,
  HUGGINGFACE_ENV_KEYS,
  LOCAL_PROVIDERS,
} from "../src/net/model/model-discovery";
import { MARINA_ROOT } from "../src/runtime-paths";

/** Opt-out: keep the caller's environment (live checks only). */
export const KEEP_ENV_VAR = "MARINA_TEST_KEEP_ENV";

/** `.env` files Bun auto-loads under `bun test` (NODE_ENV=test). */
const DOTENV_FILES = [".env", ".env.test", ".env.local", ".env.test.local"];

const KEPT = new Set([
  "NODE_ENV",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

/** Provider credentials and local-runtime settings, from model discovery. */
export function providerEnvironmentKeys(): string[] {
  return [
    ...CLOUD_PROVIDER_KEY_ENVS.map((p) => p.envKey),
    ...HUGGINGFACE_ENV_KEYS,
    ...Object.values(LOCAL_PROVIDERS).flatMap((p) => [p.baseUrlEnv, p.keyEnv, p.contextWindowEnv]),
  ];
}

/** True when `key` must not reach a test from `.env` or the shell. */
export function isScrubbedKey(key: string, named: ReadonlySet<string>): boolean {
  if (KEPT.has(key) || key.startsWith("MARINA_TEST_")) return false;
  return key.startsWith("MARINA_") || named.has(key);
}

/** Every variable name the scrub removes when present, besides `MARINA_*`. */
export function scrubbedKeyNames(dotenvContents: readonly string[]): Set<string> {
  const named = new Set(providerEnvironmentKeys());
  for (const setting of environmentCatalog(readEnvironmentReference(MARINA_ROOT))) {
    named.add(setting.key);
  }
  for (const content of dotenvContents) {
    for (const key of Object.keys(parseEnvironment(content))) named.add(key);
  }
  return named;
}

/** Delete leaked configuration from `env`; returns the removed names (never values). */
export function scrubTestEnvironment(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): string[] {
  if (env[KEEP_ENV_VAR] === "1") return [];
  const dotenv = DOTENV_FILES.map((name) => join(cwd, name))
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path, "utf8"));
  const named = scrubbedKeyNames(dotenv);
  const removed: string[] = [];
  for (const key of Object.keys(env)) {
    if (!isScrubbedKey(key, named)) continue;
    delete env[key];
    removed.push(key);
  }
  return removed;
}

/** `scopeProcessState({ env })` entries that unset every provider credential. */
export function noProviderEnv(): Record<string, undefined> {
  return Object.fromEntries(providerEnvironmentKeys().map((key) => [key, undefined]));
}
