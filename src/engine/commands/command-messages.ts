// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared message helpers for command handlers — keep dead-end messages
 * actionable: say why, and name the next command to run.
 */

/** A feature needs a database and this world is running without one. */
export function requiresPersistence(feature: string): string {
  return `This world is running without persistence, so ${feature} has nothing to read or write. Run \`readiness\` to see what's off, or restart with a database (DB_PATH).`;
}

/** A lookup missed — point at the listing command instead of a bare "not found". */
export function notFound(kind: string, listCmd: string): string {
  return `No matching ${kind}. \`${listCmd}\` lists what exists.`;
}
