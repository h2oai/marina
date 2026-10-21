// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { engines, version } from "../package.json";

/** Embedded by both bundle builds and standalone compilation. */
export const MARINA_VERSION = version;

/** The Bun range this checkout supports (`engines.bun`). */
export const REQUIRED_BUN = engines.bun;

/**
 * Why this Bun cannot run Marina from source, or null when it can. An older
 * runtime fails in ways that look like Marina bugs (empty proxied responses,
 * missing image handling), so callers name the version instead.
 */
export function bunVersionRefusal(running: string = Bun.version): string | null {
  if (Bun.semver.satisfies(running, REQUIRED_BUN)) return null;
  return `Bun ${running} is too old: Marina needs Bun ${REQUIRED_BUN} (see .bun-version). Run \`bun upgrade\`, or check which bun is first on PATH.`;
}
