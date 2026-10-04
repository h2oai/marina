// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getErrorMessage } from "../engine/errors";

const INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md", ".marina.md"] as const;
const MAX_FILE_BYTES = 4096;
const MAX_TOTAL_BYTES = 16 * 1024;
const MAX_SCOPE_DEPTH = 32;

export interface ProjectInstructionSource {
  path: string;
  scope: string;
  status: "loaded" | "truncated" | "omitted" | "unreadable";
  content?: string;
  size?: number;
  loadedBytes?: number;
  modifiedAt?: number;
  /** SHA-256 of raw source bytes read for the excerpt, excluding the unseen tail.
   * Rendering omits an incomplete UTF-8 character at a truncated boundary. */
  excerptHash?: string;
  detail?: string;
}

export interface ProjectInstructions {
  version: 1;
  root: string;
  target: string;
  executionTarget: string;
  sources: ProjectInstructionSource[];
  notices: string[];
}

/** Resolve fresh, bounded instructions along one inspected path. No recursive scan, home
 * directory lookup, execution, delivery cache, or host fallback for sandbox sessions. */
export async function loadProjectInstructions(options: {
  root: string;
  target?: string;
  executionTarget: string;
}): Promise<ProjectInstructions> {
  const result: ProjectInstructions = {
    version: 1,
    root: options.root,
    target: options.target?.trim() || ".",
    executionTarget: options.executionTarget,
    sources: [],
    notices: [],
  };
  if (options.executionTarget !== "local") {
    result.notices.push(
      "Project instructions were not loaded from the host: this session executes in a sandbox. Inspect instructions in the actual execution workspace; host files are not evidence of sandbox contents.",
    );
    return result;
  }
  try {
    const root = await realpath(options.root);
    result.root = root;
    if (isAbsolute(result.target) || result.target.includes("\0")) {
      throw new Error("Instruction scope must be a relative workspace path.");
    }
    const target = resolve(root, result.target);
    assertInside(root, target);
    const targetStat = await lstat(target);
    if (targetStat.isSymbolicLink()) {
      throw new Error("Instruction scope must not be a symbolic link.");
    }
    const directory = targetStat.isDirectory() ? target : dirname(target);
    const parts = relative(root, directory).split(sep).filter(Boolean);
    if (parts.length > MAX_SCOPE_DEPTH) {
      throw new Error(`Instruction scope exceeds ${MAX_SCOPE_DEPTH} directory levels.`);
    }
    // Never follow a scoped directory symlink, including one pointing within the root:
    // logical and physical ancestry can otherwise disagree about which rules govern it.
    let current = root;
    const directories = [root];
    for (const part of parts) {
      current = join(current, part);
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Instruction scope ${relative(root, current)} is not a plain directory.`);
      }
      assertInside(root, await realpath(current));
      directories.push(current);
    }
    let remaining = MAX_TOTAL_BYTES;
    for (const dir of directories) {
      for (const name of INSTRUCTION_FILES) {
        const path = join(dir, name);
        const source = await readInstruction(root, path, Math.min(MAX_FILE_BYTES, remaining));
        if (!source) continue;
        remaining -= source.loadedBytes ?? 0;
        result.sources.push(source);
      }
    }
  } catch (error) {
    result.notices.push(`Project instructions unavailable: ${getErrorMessage(error)}`);
  }
  return result;
}

async function readInstruction(
  root: string,
  path: string,
  budget: number,
): Promise<ProjectInstructionSource | undefined> {
  const source: ProjectInstructionSource = {
    path: relative(root, path).split(sep).join("/"),
    scope: relative(root, dirname(path)).split(sep).join("/") || ".",
    status: "unreadable",
  };
  try {
    const before = await lstat(path);
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new Error("Only regular, non-symlink instruction files are loaded.");
    }
    const canonical = await realpath(path);
    assertInside(root, canonical);
    source.size = before.size;
    source.modifiedAt = before.mtimeMs;
    if (budget === 0) {
      source.status = "omitted";
      source.loadedBytes = 0;
      source.detail = `Instruction excerpt budget (${MAX_TOTAL_BYTES} bytes) exhausted; read this file explicitly.`;
      return source;
    }
    const file = await open(
      canonical,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Error("Instruction file changed while being opened; inspect again.");
      }
      const buffer = Buffer.alloc(budget);
      const { bytesRead } = await file.read(buffer, 0, budget, 0);
      const after = await file.stat();
      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
        throw new Error("Instruction file changed while being read; inspect again.");
      }
      const bytes = buffer.subarray(0, bytesRead);
      source.size = after.size;
      source.modifiedAt = after.mtimeMs;
      source.loadedBytes = bytesRead;
      source.excerptHash = createHash("sha256").update(bytes).digest("hex");
      source.status = bytesRead < after.size ? "truncated" : "loaded";
      source.content = new TextDecoder().decode(bytes, { stream: source.status === "truncated" });
      if (source.status === "truncated") {
        source.detail = `Showing ${bytesRead} of ${after.size} bytes; read this file explicitly for the remaining instructions.`;
      }
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    source.status = "unreadable";
    source.detail = getErrorMessage(error);
  }
  return source;
}

function assertInside(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Instruction path escapes the workspace root.");
  }
}

/** Metadata records what was delivered without duplicating document contents. */
export function projectInstructionMetadata(instructions: ProjectInstructions) {
  return {
    ...instructions,
    sources: instructions.sources.map(({ content: _content, ...source }) => source),
  };
}

export function formatProjectInstructions(instructions: ProjectInstructions): string[] {
  if (instructions.sources.length === 0 && instructions.notices.length === 0) return [];
  return [
    "",
    "Project conventions:",
    `Workspace: ${instructions.root}; inspected path: ${instructions.target}.`,
    "Sources are ordered from root to the inspected directory. Deeper instructions apply only in their subtree. Combine same-directory documents and honor their explicit precedence; filename order does not establish precedence. If they conflict without a stated resolution, ask the requester.",
    ...instructions.sources.map(formatProjectInstructionSource),
    ...instructions.notices.map((notice) => `[${notice}]`),
  ];
}

function formatProjectInstructionSource(source: ProjectInstructionSource): string {
  return [
    `--- ${source.path} ---`,
    `Scope: ${source.scope === "." ? "entire workspace" : `${source.scope}/ subtree`}; ${source.status}${source.size === undefined ? "" : `; ${source.loadedBytes ?? 0}/${source.size} bytes`}.`,
    ...(source.content ? [source.content] : []),
    ...(source.detail ? [`[${source.detail}]`] : []),
  ].join("\n");
}

/** Exact, reversible excerpts for the agent's working transcript. Fresh reads and
 * durable events still carry every source; this is not a delivery cache. */
export function projectInstructionContextBlocks(instructions: ProjectInstructions) {
  return instructions.sources
    .filter((source) => source.content)
    .map((source) => ({
      key: JSON.stringify([
        instructions.root,
        instructions.executionTarget,
        source.path,
        source.scope,
      ]),
      text: formatProjectInstructionSource(source),
    }));
}
