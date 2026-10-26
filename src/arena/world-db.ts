// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The world database the arena CLI reads and writes: `DB_PATH`, else
 * `marina.db` in the working directory. The submission ledger, shadow records
 * and resolved outcomes live there, so opening a database that does not exist
 * yet would answer from an empty ledger (`routes` with no evidence, `submit`
 * with no record of earlier filings). The CLI refuses that unless the operator
 * asks for a new database (`--new-db`).
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function arenaWorldDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.DB_PATH?.trim() || "marina.db";
}

/** Why the CLI must not open `path`, or undefined when it may. */
export function missingWorldDbRefusal(
  path: string,
  opts: { allowNew?: boolean; exists?: (path: string) => boolean } = {},
): string | undefined {
  if (path === ":memory:" || opts.allowNew) return undefined;
  if ((opts.exists ?? existsSync)(path)) return undefined;
  return `no world database at ${resolve(path)}: set DB_PATH to the world's database (the arena ledger lives there), or pass --new-db to start an empty one`;
}
