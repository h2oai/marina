// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
/** Bun's native SQLite tests run through Stryker's supported command runner. */
export default {
  $schema: "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  mutate: ["src/memory/context-cache.ts", "src/net/mcp-admission.ts"],
  testRunner: "command",
  commandRunner: {
    command:
      "bun --env-file=/dev/null test test/context-cache-contract.test.ts test/context-cache.test.ts test/mcp-session.test.ts --timeout 10000",
  },
  // Bun transpiles directly; TS 7 has no legacy JS compiler API for Stryker to rewrite.
  tsconfigFile: "tsconfig.stryker-unused.json",
  coverageAnalysis: "off",
  concurrency: 2,
  timeoutMS: 15000,
  timeoutFactor: 2,
  dryRunTimeoutMinutes: 2,
  thresholds: { high: 100, low: 100, break: 100 },
  reporters: ["clear-text", "json"],
  jsonReporter: { fileName: "/tmp/marina-mutation/mutation.json" },
  ignorePatterns: [
    "/dashboard",
    "/site",
    "/marina-desktop",
    "/examples",
    "/extensions",
    "/data",
    "/dist",
    "/.env",
    "/benchmarks/results",
  ],
};
