// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { acquireDatabaseLease } from "./database-lease";

export interface RecoverySpecification {
  /** Absolute paths or paths relative to the specification file. Include world and auth databases. */
  databases: Record<string, string>;
  /** Explicit assets, workspaces, custom worlds and private configuration files. */
  files: Record<string, string>;
}
interface BundleFile {
  path: string;
  bytes: number;
  sha256: string;
  executable: boolean;
}
interface BundleManifest {
  format: "marina-recovery-v1";
  createdAt: string;
  databases: string[];
  files: BundleFile[];
}

function validName(name: string): void {
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new Error(`Invalid recovery component name: ${name}`);
}
function safePath(root: string, path: string): string {
  const target = resolve(root, path),
    rel = relative(root, target);
  if (!rel || isAbsolute(path) || rel.startsWith("..") || isAbsolute(rel))
    throw new Error("Invalid bundle path");
  return target;
}
function copyTree(source: string, destination: string): void {
  const info = lstatSync(source);
  if (info.isSymbolicLink())
    throw new Error(`Recovery bundles require explicit files, not symbolic links: ${source}`);
  if (info.isDirectory()) {
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(source)) copyTree(join(source, name), join(destination, name));
  } else if (info.isFile()) {
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(source, destination);
    chmodSync(destination, info.mode & 0o111 ? 0o700 : 0o600);
  } else throw new Error(`Unsupported recovery input: ${source}`);
}
function inventory(root: string, directory = root): BundleFile[] {
  return readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const path = join(directory, name),
        info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error("Bundle contains a symbolic link");
      if (info.isDirectory()) return inventory(root, path);
      if (!info.isFile()) throw new Error("Bundle contains a special file");
      return [
        {
          path: relative(root, path),
          bytes: info.size,
          sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
          executable: !!(info.mode & 0o111),
        },
      ];
    });
}
function checkDatabase(path: string): void {
  const db = new Database(path, { readonly: true });
  try {
    const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
    if (
      integrity.length !== 1 ||
      integrity[0]?.integrity_check !== "ok" ||
      db.query("PRAGMA foreign_key_check").all().length
    )
      throw new Error("Recovery database integrity validation failed");
  } finally {
    db.close();
  }
}

/** Offline only: all declared database leases are held while copying the complete instance. */
export function createRecoveryBundle(
  spec: RecoverySpecification,
  destination: string,
  cwd = process.cwd(),
): void {
  if (!spec.databases?.world || !spec.files || typeof spec.files !== "object")
    throw new Error("Specification requires databases.world and files");
  const output = resolve(destination);
  if (existsSync(output)) throw new Error("Bundle destination must be new");
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(dirname(output), ".marina-bundle-"));
  const leases: Array<() => void> = [];
  try {
    const databases: string[] = [];
    for (const [name, path] of Object.entries(spec.databases)) {
      validName(name);
      const source = resolve(cwd, path);
      leases.push(acquireDatabaseLease(source));
      const target = join(stage, "databases", `${name}.db`);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      const db = new Database(source, { readonly: true });
      try {
        db.run("VACUUM INTO ?", [target]);
      } finally {
        db.close();
      }
      chmodSync(target, 0o600);
      checkDatabase(target);
      databases.push(relative(stage, target));
    }
    for (const [name, path] of Object.entries(spec.files)) {
      validName(name);
      const source = resolve(cwd, path);
      if (output === source || output.startsWith(`${source}/`))
        throw new Error("Bundle must be outside its inputs");
      copyTree(source, join(stage, "files", name));
    }
    const manifest: BundleManifest = {
      format: "marina-recovery-v1",
      createdAt: new Date().toISOString(),
      databases,
      files: inventory(stage),
    };
    writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    if (existsSync(output)) throw new Error("Bundle destination already exists");
    renameSync(stage, output);
  } finally {
    for (const release of leases.reverse()) release();
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  }
}

/** Verify every file before publishing to a new directory; no live database is overwritten. */
export function restoreRecoveryBundle(source: string, destination: string): void {
  const root = resolve(source),
    output = resolve(destination);
  if (existsSync(output)) throw new Error("Restore destination must be new");
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as BundleManifest;
  if (
    manifest.format !== "marina-recovery-v1" ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.databases)
  )
    throw new Error("Invalid recovery manifest");
  const actual = inventory(root).filter((file) => file.path !== "manifest.json");
  if (
    actual.length !== manifest.files.length ||
    new Set(manifest.files.map((file) => file.path)).size !== actual.length
  )
    throw new Error("Bundle file inventory differs");
  for (const file of manifest.files) {
    safePath(root, file.path);
    const found = actual.find((item) => item.path === file.path);
    if (
      !found ||
      found.sha256 !== file.sha256 ||
      found.bytes !== file.bytes ||
      found.executable !== file.executable
    )
      throw new Error(`Bundle verification failed: ${file.path}`);
  }
  for (const path of manifest.databases) checkDatabase(safePath(root, path));
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(dirname(output), ".marina-restore-"));
  try {
    copyTree(root, stage);
    // Recheck the copied bytes, not only inputs that could change during copying.
    for (const file of manifest.files) {
      if (
        createHash("sha256")
          .update(readFileSync(safePath(stage, file.path)))
          .digest("hex") !== file.sha256
      )
        throw new Error("Bundle changed during restore");
    }
    if (existsSync(output)) throw new Error("Restore destination already exists");
    renameSync(stage, output);
  } finally {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  }
}
