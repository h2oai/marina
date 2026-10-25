// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { dirname, resolve } from "node:path";

// Replaced by build:native; ordinary Bun sources and bundles keep filesystem loading.
declare const MARINA_COMPILED: boolean | undefined;
export const IS_COMPILED = typeof MARINA_COMPILED !== "undefined" && MARINA_COMPILED;

/** Both src/ entry points and dist/ bundles sit one level below the package root. */
export const MARINA_ROOT = IS_COMPILED ? dirname(process.execPath) : resolve(import.meta.dir, "..");

/**
 * The Bun that runs a checkout script for this process (benchmark harness,
 * dataset downloader, reproduction kit): the running Bun itself, so a server
 * started by absolute path (desktop app, `marina` bin, a service manager with
 * a bare PATH) never depends on `bun` being on PATH. A compiled binary is not
 * a Bun CLI: it uses the `bun` on PATH.
 */
export function bunExecutable(): string {
  return IS_COMPILED ? (Bun.which("bun") ?? "bun") : process.execPath;
}

/**
 * Argv prefix for running a checkout script: `<bun> --no-env-file`. The child
 * inherits the server's environment explicitly; it must not also load the
 * `.env` of the checkout it runs in (the server may run from any directory
 * with its own instance settings), so it sees exactly the server's
 * configuration.
 */
export function bunScriptArgv(): string[] {
  return [bunExecutable(), "--no-env-file"];
}
