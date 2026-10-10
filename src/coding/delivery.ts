// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hostGitArgv, hostGitEnv } from "./host-git";
import type { WorkspaceFiles } from "./local-workspace";

const MAX_FILES = 128;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export interface DeliveryManifest {
  files: string[];
  /** Finite argv commands, parsed and authorized by the normal verification path. */
  checks: string[];
}

export interface DeliveryEvidence {
  version: 1;
  manifestPath: string;
  manifestSha256: string;
  files: { path: string; sha256: string; bytes: number }[];
  fingerprint: string;
  checkedFingerprint?: string;
}

export function deliveryPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.startsWith("/") ||
    /[\\\0\r\n:]/.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === ".." || part === ".git")
  )
    throw new Error("Delivery paths must name relative workspace files without traversal or .git.");
  return value;
}

export function parseDeliveryManifest(value: unknown): DeliveryManifest {
  if (!value || typeof value !== "object") throw new Error("Invalid delivery manifest.");
  const { files, checks } = value as Record<string, unknown>;
  if (!Array.isArray(files) || !files.length || files.length > MAX_FILES)
    throw new Error(`Delivery requires 1–${MAX_FILES} explicitly listed files.`);
  const paths = files.map(deliveryPath);
  if (new Set(paths).size !== paths.length) throw new Error("Duplicate delivery file.");
  if (
    !Array.isArray(checks) ||
    !checks.length ||
    checks.length > 8 ||
    checks.some((check) => typeof check !== "string" || !check.trim() || check.length > 8192)
  )
    throw new Error("Delivery requires 1–8 finite check commands.");
  return { files: paths, checks: checks as string[] };
}

export async function readDeliveryManifest(workspace: WorkspaceFiles, path: string) {
  if (!workspace.readBytes) throw new Error("This workspace cannot capture delivery files.");
  assertRegularFile(workspace, path);
  const source = await workspace.readBytes(deliveryPath(path), 64 * 1024);
  return {
    manifest: parseDeliveryManifest(JSON.parse(new TextDecoder().decode(source.data))),
    sha256: hash(source.data),
  };
}

function assertRegularFile(workspace: WorkspaceFiles, path: string) {
  let location = workspace.displayRoot();
  const parts = deliveryPath(path).split("/");
  for (const [index, part] of parts.entries()) {
    location = join(location, part);
    const info = lstatSync(location);
    if (
      info.isSymbolicLink() ||
      (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())
    )
      throw new Error("Delivery capture requires regular files without symlink components.");
  }
}

async function readFiles(workspace: WorkspaceFiles, paths: string[]) {
  if (!workspace.readBytes) throw new Error("This workspace cannot capture delivery files.");
  let total = 0;
  const files = [];
  for (const path of paths) {
    assertRegularFile(workspace, path);
    const { data } = await workspace.readBytes(deliveryPath(path), MAX_FILE_BYTES);
    total += data.length;
    if (total > MAX_TOTAL_BYTES) throw new Error("Delivery exceeds the 64 MiB capture limit.");
    files.push({ path, data, sha256: hash(data), bytes: data.length });
  }
  return files;
}

export async function deliveryFingerprint(workspace: WorkspaceFiles, paths: string[]) {
  const files = await readFiles(workspace, paths);
  return hash(JSON.stringify(files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes }))));
}

/** Container mount runners protect Git metadata read-only. Initialize only this disposable root,
 * with the same hardened host Git policy used for candidate capture; no task code runs here. */
export async function prepareDeliveryMount(directory: string, beforeSpawn: () => void) {
  beforeSpawn();
  const process = Bun.spawn(hostGitArgv(["git", "init", "--quiet", "--template="]), {
    cwd: directory,
    env: hostGitEnv(),
    stdout: "ignore",
    stderr: "pipe",
  });
  const [exit, error] = await Promise.all([process.exited, new Response(process.stderr).text()]);
  if (exit !== 0) throw new Error(`Cannot prepare delivery mount: ${error.slice(0, 1000)}`);
  beforeSpawn();
}

/** Capture exactly the selected files. A clean working directory is not a security sandbox. */
export async function captureDelivery(
  workspace: WorkspaceFiles,
  manifestPath: string,
  beforeCapture: () => void,
) {
  beforeCapture();
  const { manifest, sha256 } = await readDeliveryManifest(workspace, manifestPath);
  const files = await readFiles(workspace, manifest.files);
  beforeCapture();
  const inventory = files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes }));
  const evidence: DeliveryEvidence = {
    version: 1,
    manifestPath,
    manifestSha256: sha256,
    files: inventory,
    fingerprint: hash(JSON.stringify(inventory)),
  };
  const directory = await mkdtemp(join(tmpdir(), "marina-delivery-"));
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    for (const file of files) {
      const destination = join(directory, file.path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, file.data, { flag: "wx", mode: 0o600 });
    }
    // Detect edits during capture instead of presenting a mixed-version bundle as current.
    if (
      (await deliveryFingerprint(workspace, manifest.files)) !== evidence.fingerprint ||
      (await readDeliveryManifest(workspace, manifestPath)).sha256 !== sha256
    )
      throw new Error("Delivery files changed while being captured. Retry after edits finish.");
    beforeCapture();
    return { directory, evidence, manifest, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
