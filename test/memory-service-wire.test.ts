// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "bun:test";
import { qualifyMemoryService } from "../scripts/qualify-memory-service";

it("lets an external Python agent resume using only HTTP after the server is killed", async () => {
  const proof = await qualifyMemoryService();
  expect(proof.passed).toBe(true);
  expect(proof.resumed.artifact_integrity).toBe(true);
  expect(proof.resumed.revision_conflict).toBe(true);
  expect(proof.resumed.source_forgetting).toBe(true);
  expect(proof.revocation).toBe(true);
}, 30_000);
