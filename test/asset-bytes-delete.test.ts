// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// A stored asset's row is dropped only once its bytes are gone: a failed blob
// delete keeps the row (retried, or reported) instead of orphaning the bytes.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetBytesError, removeAsset } from "../src/engine/media/asset-library";
import { pruneRequestImageBlobs, REQUEST_IMAGE_KEEP_MS } from "../src/engine/retention";
import { inlineScriptHashesFor } from "../src/net/websocket-server";
import { MarinaDB } from "../src/persistence/database";
import { LocalStorageProvider } from "../src/storage/local-provider";
import { cleanupDb, tempDbPath } from "./helpers";

const DAY = 86_400_000;
const path = tempDbPath("test_asset_bytes_delete.db");

describe("LocalStorageProvider.delete", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "marina-blobs-"));
  });
  afterEach(() => {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns false for bytes that are already gone, true once removed", async () => {
    const storage = new LocalStorageProvider(dir);
    writeFileSync(join(dir, "a.png"), "x");
    expect(await storage.delete("a.png")).toBe(true);
    expect(await storage.delete("a.png")).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)(
    "throws when stored bytes could not be removed (root ignores directory permissions)",
    async () => {
      const storage = new LocalStorageProvider(dir);
      writeFileSync(join(dir, "kept.png"), "x");
      chmodSync(dir, 0o555); // no write permission on the directory: unlink fails with EACCES
      await expect(storage.delete("kept.png")).rejects.toThrow();
      chmodSync(dir, 0o755);
      expect(existsSync(join(dir, "kept.png"))).toBe(true);
    },
  );
});

describe("asset rows outlive bytes that could not be deleted", () => {
  let db: MarinaDB;
  let raw: Database;
  const now = 1_800_000_000_000;
  const old = now - REQUEST_IMAGE_KEEP_MS - DAY;

  beforeEach(() => {
    db = new MarinaDB(path);
    raw = new Database(path);
    for (const id of ["req_a", "req_b"]) {
      raw.run(
        "INSERT INTO assets (id, entity_name, filename, mime_type, size, storage_key, metadata, created_at) VALUES (?, 'k', 'f.png', 'image/png', 1, ?, ?, ?)",
        [id, `${id}.png`, JSON.stringify({ origin: "request" }), old],
      );
    }
  });

  afterEach(() => {
    raw.close();
    db.close();
    cleanupDb(path);
  });

  const ids = () =>
    (raw.query("SELECT id FROM assets ORDER BY id").all() as { id: string }[]).map((r) => r.id);

  it("retention keeps a request image whose blob delete failed, and removes it next pass", async () => {
    const failing = {
      delete: async (key: string) => {
        if (key === "req_a.png") throw new Error("EACCES");
        return true;
      },
    };
    expect(await pruneRequestImageBlobs(db, failing, { now, overridesEnv: "" })).toBe(1);
    expect(ids()).toEqual(["req_a"]);

    const healthy = { delete: async () => true };
    expect(await pruneRequestImageBlobs(db, healthy, { now, overridesEnv: "" })).toBe(1);
    expect(ids()).toEqual([]);
  });

  it("removeAsset keeps the row and reports when storage refuses the bytes", async () => {
    const storage = {
      init: async () => {},
      put: async () => "",
      get: async () => null,
      resolve: (key: string) => `/assets/${key}`,
      delete: async () => {
        throw new Error("read-only volume");
      },
    };
    const row = db.getAsset("req_a")!;
    await expect(removeAsset({ db, storage }, row)).rejects.toBeInstanceOf(AssetBytesError);
    expect(ids()).toEqual(["req_a", "req_b"]);

    const gone = { ...storage, delete: async () => false }; // already gone is not a failure
    expect(await removeAsset({ db, storage: gone }, row)).toBe(true);
    expect(ids()).toEqual(["req_b"]);
  });
});

describe("static page CSP hashes", () => {
  it("retries a failed read instead of caching no grants until restart", async () => {
    const page = `/tmp/never-cached-${Date.now()}.html`;
    const failed = await inlineScriptHashesFor(page, async () => {
      throw new Error("EIO");
    });
    expect(failed).toEqual([]);
    const html = "<html><script>console.log(1)</script></html>";
    const recovered = await inlineScriptHashesFor(page, async () => html);
    expect(recovered.length).toBe(1);
    // A successful read is cached: a later failing reader is never consulted.
    const cached = await inlineScriptHashesFor(page, async () => {
      throw new Error("not read again");
    });
    expect(cached).toEqual(recovered);
  });
});
