// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Renders src/protocol/wire.ts to protocol/marina.wire.v1.schema.json — the file
// SDKs and code generators read. `--check` fails when it is stale (docs:api runs it).

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { wireProtocolSchema } from "../src/protocol/wire";

export const PROTOCOL_SCHEMA_FILE = resolve(
  import.meta.dir,
  "../protocol/marina.wire.v1.schema.json",
);

export function renderProtocolSchema(): string {
  return `${JSON.stringify(wireProtocolSchema(), null, 2)}\n`;
}

export function generateProtocolSchema(check: boolean): void {
  const output = renderProtocolSchema();
  if (check) {
    let current = "";
    try {
      current = readFileSync(PROTOCOL_SCHEMA_FILE, "utf8");
    } catch {
      // allow-empty-catch: a missing file is stale, reported below
    }
    if (current !== output) throw new Error("Protocol schema is stale; run bun run docs:api.");
    return;
  }
  writeFileSync(PROTOCOL_SCHEMA_FILE, output);
}

if (import.meta.main) generateProtocolSchema(process.argv.includes("--check"));
