#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getErrorMessage } from "../src/engine/errors";
import { unlockStoppedDatabase } from "../src/persistence/database-lease";
import { createRecoveryBundle, restoreRecoveryBundle } from "../src/persistence/recovery-bundle";

try {
  const [operation, source, destination] = process.argv.slice(2);
  if (operation === "unlock" && source) unlockStoppedDatabase(source);
  else if (operation === "create" && source && destination) {
    createRecoveryBundle(
      JSON.parse(readFileSync(source, "utf8")),
      destination,
      dirname(resolve(source)),
    );
    console.log(`Private recovery bundle created: ${destination}`);
  } else if (operation === "restore" && source && destination) {
    restoreRecoveryBundle(source, destination);
    console.log(
      `Verified recovery files restored: ${destination}. Review configuration paths before starting the recovered instance.`,
    );
  } else
    throw new Error(
      "Usage: recovery create SPEC.json NEW_DIRECTORY | restore BUNDLE NEW_DIRECTORY | unlock STOPPED_DB",
    );
} catch (error) {
  console.error(getErrorMessage(error));
  process.exitCode = 1;
}
