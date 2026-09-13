// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Preserve reviewed source bytes before a live run, never environment/credentials. */
export function snapshotMemoryQualification(directory: string) {
  const output = resolve(directory);
  if (output === process.cwd() || output.startsWith(`${process.cwd()}/`))
    throw new Error("Qualification artifacts must be outside the public checkout");
  const patterns = [
    "src/memory/*.ts",
    "src/persistence/db-memory*.ts",
    "src/persistence/db-principals.ts",
    "src/persistence/schema.ts",
    "src/persistence/export-import.ts",
    "src/sdk/memory*.ts",
    "src/sdk/marina_memory.py",
    "src/net/memory-service-api.ts",
    "src/net/mcp-server.ts",
    "scripts/memory-mcp.ts",
    "scripts/research/memory-*-qualification.ts",
    "scripts/research/memory-live-runtime.ts",
    "scripts/research/memory-evaluation-budget.ts",
    "scripts/research/memory-qualification-sources.ts",
    "examples/memory-service/workflow-agent.ts",
  ];
  const paths = [
    ...new Set(
      patterns.flatMap((pattern) => [...new Bun.Glob(pattern).scanSync({ cwd: process.cwd() })]),
    ),
  ].sort();
  const hashes: Record<string, string> = {};
  for (const path of paths) {
    const bytes = readFileSync(path);
    const destination = `${output}/implementation/${path}`;
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, bytes, { mode: 0o600 });
    hashes[path] = createHash("sha256").update(bytes).digest("hex");
  }
  return hashes;
}
