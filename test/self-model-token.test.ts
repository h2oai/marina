// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// The bearer for this Marina's own /v1: the in-process token inside the
// server, a key the server accepts from any other process (an operator CLI).

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getInternalModelToken } from "../src/agent/agent-runtime";
import {
  markServingProcess,
  resetServingProcessForTests,
  selfModelToken,
} from "../src/net/self-model-token";

describe("selfModelToken", () => {
  const dir = mkdtempSync(join(tmpdir(), "self-token-"));
  afterEach(() => resetServingProcessForTests());

  it("uses the operator's first key secret from a separate process", async () => {
    expect(await selfModelToken({ MODEL_API_KEYS: " sk-one:alice, sk-two" })).toBe("sk-one");
    expect(await selfModelToken({ MODEL_API_KEYS: "sk-plain" })).toBe("sk-plain");
  });

  it("falls back to the local profile's key, read and never created", async () => {
    const db = join(dir, "world.db");
    expect(await selfModelToken({ DB_PATH: db })).toBe(getInternalModelToken());
    const key = `mk_local_${"a".repeat(32)}`;
    writeFileSync(`${db}.local-api-key`, `${key}\n`);
    expect(await selfModelToken({ DB_PATH: db })).toBe(key);
    expect(await selfModelToken({ MARINA_LOCAL_API_KEY: "mk_local_env" })).toBe("mk_local_env");
    writeFileSync(`${db}.local-api-key`, "junk\n");
    expect(await selfModelToken({ DB_PATH: db })).toBe(getInternalModelToken());
  });

  it("keeps the in-process token inside the serving process", async () => {
    markServingProcess();
    expect(await selfModelToken({ MODEL_API_KEYS: "sk-one" })).toBe(getInternalModelToken());
  });

  it("cleans up", () => rmSync(dir, { recursive: true, force: true }));
});
