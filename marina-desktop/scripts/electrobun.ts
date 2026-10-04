// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";

// The npm package is a CLI bootstrap in v2, not the runtime SDK. Run it with
// our build Bun and pass its absolute executable to the Cottontail build hook.
const project = resolve(import.meta.dir, "..");
const child = Bun.spawn(
  [
    process.execPath,
    resolve(project, "node_modules/electrobun/bin/electrobun.cjs"),
    ...process.argv.slice(2),
  ],
  {
    cwd: project,
    env: { ...process.env, MARINA_DESKTOP_BUN_EXECUTABLE: process.execPath },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exit(await child.exited);
