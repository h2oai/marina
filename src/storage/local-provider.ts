// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { StorageProvider } from "./provider";

/** Stores assets on the local filesystem under a configurable directory. */
export class LocalStorageProvider implements StorageProvider {
  private dir: string;

  constructor(dir = "data/assets") {
    this.dir = dir;
  }

  async init(): Promise<void> {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  /**
   * The file for `key`, which must stay inside the storage directory: a write
   * or delete of a key that resolves outside it (`../x`, an absolute path) is
   * refused.
   */
  private pathFor(key: string): string {
    const path = this.containedPath(key);
    if (!path) throw new Error(`Storage key outside the asset directory: ${key}`);
    return path;
  }

  /** The file for `key`, or `null` when it would resolve outside the directory. */
  private containedPath(key: string): string | null {
    const root = resolve(this.dir);
    const path = resolve(root, key);
    const rel = relative(root, path);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    return path;
  }

  async put(key: string, data: Uint8Array, _mime: string): Promise<string> {
    const path = this.pathFor(key);
    // Ensure parent directory exists (for keys like "abc/def.png")
    const parent = dirname(path);
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    await Bun.write(path, data);
    return key;
  }

  async get(key: string): Promise<{ data: Uint8Array; mime: string } | null> {
    // A key outside the directory names no stored asset: not found.
    const path = this.containedPath(key);
    if (!path) return null;
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    const data = new Uint8Array(await file.arrayBuffer());
    return { data, mime: file.type };
  }

  async delete(key: string): Promise<boolean> {
    const path = this.pathFor(key);
    try {
      unlinkSync(path);
      return true;
    } catch (err) {
      // Already gone is not a failure; anything else (permissions, a busy or
      // read-only volume) leaves the bytes behind and must reach the caller.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  resolve(key: string): string {
    return `/assets/${key}`;
  }
}
