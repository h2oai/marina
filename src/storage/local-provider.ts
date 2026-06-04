import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
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

  async put(key: string, data: Uint8Array, _mime: string): Promise<string> {
    const path = join(this.dir, key);
    // Ensure parent directory exists (for keys like "abc/def.png")
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (parent && !existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    await Bun.write(path, data);
    return key;
  }

  async get(key: string): Promise<{ data: Uint8Array; mime: string } | null> {
    const path = join(this.dir, key);
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    const data = new Uint8Array(await file.arrayBuffer());
    return { data, mime: file.type };
  }

  async delete(key: string): Promise<boolean> {
    const path = join(this.dir, key);
    try {
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  }

  resolve(key: string): string {
    return `/assets/${key}`;
  }
}
