#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { basename, resolve } from "node:path";
import { getErrorMessage } from "../src/engine/errors";
import { rotateMemoryBackups } from "../src/persistence/db-memory-backups";
import { snapshotMemoryDatabase } from "../src/persistence/db-memory-maintenance";

try {
  const [operation, source, destination] = process.argv.slice(2);
  if (!source || !destination || !["backup", "restore"].includes(operation ?? ""))
    throw new Error("Usage: bun scripts/backup.ts backup DB DIRECTORY | restore BACKUP NEW_DB");
  if (operation === "restore") {
    const receipt = await snapshotMemoryDatabase(source, destination);
    console.log(JSON.stringify(receipt));
    console.log(
      "Verified restore created. Stop Marina before selecting this new DB_PATH; retain the old database for rollback.",
    );
  } else {
    const receipt = await rotateMemoryBackups(source, destination, 10);
    if (process.env.S3_BUCKET) {
      const upload = Bun.spawn(
        [
          "aws",
          "s3",
          "cp",
          receipt.snapshot.destination,
          `s3://${process.env.S3_BUCKET}/marina/${basename(receipt.snapshot.destination)}`,
        ],
        { stdout: "inherit", stderr: "inherit" },
      );
      if ((await upload.exited) !== 0)
        throw new Error(`Upload failed; verified local backup retained in ${resolve(destination)}`);
    }
    console.log(JSON.stringify(receipt));
  }
} catch (error) {
  console.error(getErrorMessage(error));
  process.exitCode = 1;
}
