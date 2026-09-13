// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { MarinaDB } from "../persistence/database";
import type { MemoryActor } from "../persistence/db-principals";
import type { MemoryReceipt, MemoryStorageAmounts } from "../sdk/memory-types";
import { MemoryError } from "./service-types";

export type MemoryImportRequest = {
  actor: MemoryActor;
  space: string;
  key: string;
  limits: MemoryStorageAmounts;
} & ({ kind: "transfer"; id: string; digest: string } | { kind: "bundle"; bundle: unknown });

/** One atomic writer in a separate process. Cancellation kills the process and
 * awaits exit before releasing admission; a lost success acknowledgment stays recoverable. */
export async function runMemoryImport(
  db: MarinaDB,
  request: MemoryImportRequest,
  signal?: AbortSignal,
): Promise<MemoryReceipt> {
  signal?.throwIfAborted();
  const entry = [
    new URL("./import-process.ts", import.meta.url),
    new URL("./memory-import.js", import.meta.url),
  ]
    .map((url) => fileURLToPath(url))
    .find(existsSync);
  if (!entry)
    throw new MemoryError(
      503,
      "import_process_unavailable",
      "Memory import executable is missing; rebuild the server",
    );
  const admission = db.admitMemoryImport();
  try {
    const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", entry], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "" },
    });
    let timedOut = false;
    const stop = () => child.kill("SIGKILL");
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, 120000);
    signal?.addEventListener("abort", stop, { once: true });
    try {
      signal?.throwIfAborted();
      child.stdin.write(JSON.stringify({ ...request, path: admission.path }));
      const sent = child.stdin.end();
      const [stdout, , code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
        sent,
      ]);
      signal?.throwIfAborted();
      if (timedOut)
        throw new MemoryError(
          503,
          "import_timeout",
          "Publication time budget reached; inspect status and recover with the same key",
        );
      if (code !== 0)
        throw new MemoryError(
          503,
          "import_process_failed",
          "Publication process stopped; inspect status and retry the same key",
        );
      const result = JSON.parse(stdout) as {
        ok: boolean;
        result: MemoryReceipt;
        error: { status: number; code: string; message: string };
      };
      if (!result.ok)
        throw new MemoryError(result.error.status, result.error.code, result.error.message);
      return result.result;
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      if (child.exitCode === null) {
        stop();
        await child.exited;
      }
    }
  } finally {
    admission.release();
  }
}
