// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Trusted local publication process. Input arrives over a private pipe, never a network endpoint. */
import { Database } from "bun:sqlite";
import { importMemoryBundle } from "../persistence/db-memory-bundles";
import { memoryStorageFailure } from "../persistence/db-memory-failures";
import { configureMemoryStorage } from "../persistence/db-memory-storage";
import { commitMemoryTransfer } from "../persistence/db-memory-transfer";
import type { MemoryImportRequest } from "./import-runner";
import { MemoryError } from "./service-types";

let db: Database | undefined;
try {
  const input = JSON.parse(await Bun.stdin.text()) as MemoryImportRequest & { path: string };
  db = new Database(input.path, { readwrite: true, create: false });
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA synchronous=FULL");
  db.exec("PRAGMA busy_timeout=1000");
  db.exec("PRAGMA cache_size=-64000");
  db.exec("PRAGMA temp_store=MEMORY");
  configureMemoryStorage(db, input.limits);
  const result =
    input.kind === "transfer"
      ? commitMemoryTransfer(db, input.actor, input.space, input.id, input.digest, input.key)
      : importMemoryBundle(db, input.actor, input.space, input.bundle, input.key);
  console.log(JSON.stringify({ ok: true, result }));
} catch (error) {
  const failure = memoryStorageFailure(error);
  console.log(
    JSON.stringify({
      ok: false,
      error:
        error instanceof MemoryError
          ? { status: error.status, code: error.code, message: error.message }
          : (failure ?? {
              status: 500,
              code: "import_failed",
              message: "Publication failed; inspect status and retry the same request key",
            }),
    }),
  );
} finally {
  db?.close();
}
