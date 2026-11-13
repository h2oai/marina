// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { IS_COMPILED, MARINA_ROOT } from "../runtime-paths";

/**
 * Whether `root` is the source tree this Marina server runs from: same real
 * path as the runtime MARINA_ROOT path, a git checkout, and not a compiled binary. Package
 * names, READMEs and remotes never count, so a fork, a second clone or a
 * linked worktree is an ordinary repository.
 */
export function isLiveMarinaCheckout(
  root: string,
  marinaRoot: string = MARINA_ROOT,
  compiled: boolean = IS_COMPILED,
): boolean {
  if (compiled) return false;
  try {
    return realpathSync(root) === realpathSync(marinaRoot) && existsSync(join(marinaRoot, ".git"));
  } catch {
    return false;
  }
}
