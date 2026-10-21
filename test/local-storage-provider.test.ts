// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorageProvider } from "../src/storage/local-provider";

describe("LocalStorageProvider keeps every key inside its directory", () => {
  let base: string;
  let provider: LocalStorageProvider;

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), "marina-local-storage-"));
    provider = new LocalStorageProvider(join(base, "assets"));
    await provider.init();
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("stores, reads and deletes nested keys", async () => {
    await provider.put("ab/cd.png", new Uint8Array([1, 2, 3]), "image/png");
    expect((await provider.get("ab/cd.png"))?.data).toEqual(new Uint8Array([1, 2, 3]));
    expect(await provider.delete("ab/cd.png")).toBe(true);
    expect(await provider.get("ab/cd.png")).toBeNull();
  });

  for (const key of ["../outside.txt", "ab/../../outside.txt", "/tmp/outside.txt", ".", ""]) {
    it(`refuses the key ${JSON.stringify(key)}`, async () => {
      await expect(provider.put(key, new Uint8Array([1]), "text/plain")).rejects.toThrow(
        /outside the asset directory/,
      );
      expect(await provider.get(key)).toBeNull();
      await expect(provider.delete(key)).rejects.toThrow(/outside the asset directory/);
    });
  }

  it("never writes or reads outside the directory", async () => {
    await provider.put("../outside.txt", new Uint8Array([1]), "text/plain").catch(() => undefined);
    expect(existsSync(join(base, "outside.txt"))).toBe(false);
    await Bun.write(join(base, "secret.txt"), "s");
    expect(await provider.get("../secret.txt")).toBeNull();
  });
});
