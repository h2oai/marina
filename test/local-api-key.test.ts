// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateLocalApiKey, localApiKeyPath } from "../src/net/local-api-key";

describe("local profile model-API key", () => {
  it("is created once (mode 600), reused on restart, and repaired if exposed or corrupt", () => {
    const dir = mkdtempSync(join(tmpdir(), "local-key-"));
    try {
      const path = localApiKeyPath(join(dir, "marina.db"));
      expect(path).toEndWith("marina.db.local-api-key");
      const first = loadOrCreateLocalApiKey(path);
      expect(first.created).toBe(true);
      expect(first.key).toMatch(/^mk_local_[A-Za-z0-9_-]{32,}$/);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const again = loadOrCreateLocalApiKey(path);
      expect(again).toEqual({ key: first.key, created: false });
      chmodSync(path, 0o644);
      loadOrCreateLocalApiKey(path);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      writeFileSync(path, "not a key");
      const fresh = loadOrCreateLocalApiKey(path);
      expect(fresh.created).toBe(true);
      expect(fresh.key).not.toBe(first.key);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
