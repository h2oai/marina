// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hostGitArgv, hostGitEnv } from "./host-git";
import type { WorkspaceFiles } from "./local-workspace";

const MAX_FILES = 128;
const MAX_REQUIREMENTS = 32;
const MAX_REQUIREMENT_CHARS = 500;
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export function deliveryLimits(env: NodeJS.ProcessEnv = process.env) {
  const limit = (name: string, fallback: number) => {
    if (env[name] === undefined) return fallback;
    const value = Number(env[name]);
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(`${name} must be a positive safe integer in bytes.`);
    return value;
  };
  return {
    fileBytes: limit("MARINA_CODE_DELIVERY_MAX_FILE_BYTES", 1024 ** 3),
    totalBytes: limit("MARINA_CODE_DELIVERY_MAX_TOTAL_BYTES", 4 * 1024 ** 3),
  };
}

export interface DeliveryManifest {
  files: string[];
  /** Finite argv commands, parsed and authorized by the normal verification path. */
  checks: string[];
  /** The task's explicit requirements, each mapped to the checks that observe it. */
  requirements?: DeliveryRequirement[];
}

/** One stated requirement (worker-authored) and how it is observed. */
export interface DeliveryRequirement {
  text: string;
  /** 0-based indexes into `checks` (the manifest may also name a check by its exact text). */
  checks: number[];
  /** Explicitly not machine-checkable, with the reason. Recorded and shown, never a pass. */
  notCheckable?: string;
}

/** Which stated requirements a passing delivery check observed on the current files. */
export interface RequirementCoverage {
  /** False when the manifest lists no requirements at all. */
  listed: boolean;
  verified: string[];
  unverified: string[];
  notCheckable: { text: string; reason: string }[];
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
  const requirements = parseRequirements(
    (value as Record<string, unknown>).requirements,
    checks as string[],
  );
  return { files: paths, checks: checks as string[], ...(requirements ? { requirements } : {}) };
}

function parseRequirements(value: unknown, checks: string[]): DeliveryRequirement[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_REQUIREMENTS)
    throw new Error(`Delivery requirements must be a list of at most ${MAX_REQUIREMENTS}.`);
  return value.map((item, index) => {
    const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const text = typeof entry.text === "string" ? entry.text.trim() : "";
    if (!text || text.length > MAX_REQUIREMENT_CHARS)
      throw new Error(
        `Delivery requirement ${index} needs text of 1–${MAX_REQUIREMENT_CHARS} characters.`,
      );
    const refs = entry.checks === undefined ? [] : entry.checks;
    if (!Array.isArray(refs))
      throw new Error(`Delivery requirement ${index}: checks must be a list.`);
    const indexes = refs.map((ref) => {
      const at =
        typeof ref === "number"
          ? ref
          : typeof ref === "string"
            ? checks.findIndex((check) => check.trim() === ref.trim())
            : -1;
      if (!Number.isInteger(at) || at < 0 || at >= checks.length)
        throw new Error(
          `Delivery requirement ${index} names a check that is not in the manifest: ${JSON.stringify(ref)}.`,
        );
      return at;
    });
    const notCheckable =
      typeof entry.notCheckable === "string" ? entry.notCheckable.trim() : undefined;
    if (entry.notCheckable !== undefined && !notCheckable)
      throw new Error(`Delivery requirement ${index}: notCheckable needs a reason.`);
    if (notCheckable && indexes.length)
      throw new Error(`Delivery requirement ${index}: use checks or notCheckable, not both.`);
    return {
      text,
      checks: [...new Set(indexes)],
      ...(notCheckable ? { notCheckable: notCheckable.slice(0, MAX_REQUIREMENT_CHARS) } : {}),
    };
  });
}

/** A whitespace check observes no requirement. */
function observes(command: unknown): boolean {
  const argv = Array.isArray(command) ? command.map(String) : String(command ?? "").split(/\s+/);
  return !!argv[0] && !(argv[0] === "git" && argv[1] === "diff" && argv.includes("--check"));
}

/**
 * Map each stated requirement to the recorded check steps (index-aligned with the manifest's
 * checks). Only a step that ran and passed counts; a requirement with no such step is unverified,
 * whatever the summary asserts. `notCheckable` entries are listed apart, never as verified.
 */
export function requirementCoverage(
  manifest: Pick<DeliveryManifest, "requirements">,
  steps: readonly unknown[],
): RequirementCoverage {
  const coverage: RequirementCoverage = {
    listed: !!manifest.requirements?.length,
    verified: [],
    unverified: [],
    notCheckable: [],
  };
  for (const requirement of manifest.requirements ?? []) {
    if (requirement.notCheckable) {
      coverage.notCheckable.push({ text: requirement.text, reason: requirement.notCheckable });
      continue;
    }
    const observed = requirement.checks.some((at) => {
      const step = steps[at] as { outcome?: unknown; command?: unknown } | undefined;
      return step?.outcome === "passed" && observes(step.command);
    });
    (observed ? coverage.verified : coverage.unverified).push(requirement.text);
  }
  return coverage;
}

/** True when every stated requirement is observed or explicitly marked not machine-checkable. */
export function requirementsComplete(coverage: RequirementCoverage | undefined): boolean {
  return !coverage || (coverage.listed && coverage.unverified.length === 0);
}

/** The reviewer-facing lines for a coverage record. */
export function requirementLines(coverage: RequirementCoverage): string[] {
  return [
    ...(coverage.listed ? [] : ["UNVERIFIED: no acceptance checklist (manifest requirements)"]),
    ...coverage.verified.map((text) => `verified: ${text}`),
    ...coverage.notCheckable.map(
      ({ text, reason }) => `not machine-checkable: ${text} (${reason})`,
    ),
    ...coverage.unverified.map((text) => `UNVERIFIED: ${text}`),
  ];
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

async function readFiles(workspace: WorkspaceFiles, paths: string[], directory?: string) {
  if (!workspace.readByteChunks && !workspace.readBytes)
    throw new Error("This workspace cannot capture delivery files.");
  const limits = deliveryLimits();
  let total = 0;
  const files = [];
  for (const path of paths) {
    assertRegularFile(workspace, path);
    const remaining = limits.totalBytes - total;
    if (remaining < 0) throw new Error("Delivery exceeds MARINA_CODE_DELIVERY_MAX_TOTAL_BYTES.");
    const destination = directory ? join(directory, path) : undefined;
    if (destination) await mkdir(dirname(destination), { recursive: true });
    const output = destination ? await open(destination, "wx", 0o600) : undefined;
    try {
      const maxBytes = Math.max(1, Math.min(limits.fileBytes, remaining));
      const chunks = workspace.readByteChunks
        ? workspace.readByteChunks(path, maxBytes)
        : [(await workspace.readBytes!(path, maxBytes)).data];
      const digest = createHash("sha256");
      let bytes = 0;
      for await (const chunk of chunks) {
        bytes += chunk.length;
        total += chunk.length;
        if (bytes > limits.fileBytes || total > limits.totalBytes)
          throw new Error("Delivery exceeds its configured file or total capture limit.");
        digest.update(chunk);
        await output?.writeFile(chunk);
      }
      files.push({ path, sha256: digest.digest("hex"), bytes });
    } finally {
      await output?.close();
    }
  }
  return files;
}

export async function deliveryFingerprint(workspace: WorkspaceFiles, paths: string[]) {
  const files = await readFiles(workspace, paths);
  return hash(JSON.stringify(files));
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
  const directory = await mkdtemp(join(tmpdir(), "marina-delivery-"));
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    const inventory = await readFiles(workspace, manifest.files, directory);
    beforeCapture();
    const evidence: DeliveryEvidence = {
      version: 1,
      manifestPath,
      manifestSha256: sha256,
      files: inventory,
      fingerprint: hash(JSON.stringify(inventory)),
    };
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
