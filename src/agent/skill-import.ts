// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Skill import — parse markdown-with-frontmatter skill files into the
 * shape Marina's `skill` command expects.
 *
 * A skill file is a portable, version-controllable artifact:
 *
 *   ---
 *   name: answer-request
 *   description: Procedure for handling an incoming model_request
 *   tags: answerer, dispatch, benchmark
 *   importance: 7
 *   ---
 *
 *   # Procedure
 *
 *   1. Parse the model_request JSON for id, content, target.
 *   2. ...
 *
 * Format design notes:
 *   - YAML-like frontmatter, but parsed with a simple regex — no YAML
 *     library dependency. Only `key: value` lines (single-line scalars)
 *     are supported. This is enough for skill metadata.
 *   - Required keys: `name`, `description`. Everything else optional.
 *   - `tags` is a comma-separated string in source; parsed to string[].
 *   - `importance` defaults to 6 (mid-tier); same default as `skill store`.
 *   - The body (everything after the closing `---`) becomes the action
 *     sequence the skill encodes.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";

export interface SkillImport {
  name: string;
  description: string;
  tags: string[];
  importance: number;
  body: string;
}

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/;
const KEY_RE = /^([a-z][a-z0-9_-]*)\s*:\s*(.*)$/i;

/**
 * Parse a markdown source string into a SkillImport. Throws if the
 * frontmatter is missing or required keys (`name`, `description`) are
 * absent.
 */
export function parseSkillMarkdown(source: string): SkillImport {
  const match = source.match(FRONTMATTER_RE);
  if (!match) {
    throw new Error("Skill markdown missing YAML frontmatter (--- key: value ---)");
  }
  const frontmatter = match[1] ?? "";
  const body = (match[2] ?? "").trim();
  const meta: Record<string, string> = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const m = line.match(KEY_RE);
    if (m) meta[(m[1] ?? "").toLowerCase()] = (m[2] ?? "").trim();
  }
  if (!meta.name) throw new Error("Skill markdown frontmatter must declare `name`");
  if (!meta.description) {
    throw new Error("Skill markdown frontmatter must declare `description`");
  }
  const tagsField = meta.tags ?? "";
  const tags = tagsField
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const impParsed = meta.importance ? Number.parseInt(meta.importance, 10) : 6;
  const importance = Number.isFinite(impParsed) ? Math.min(10, Math.max(1, impParsed)) : 6;
  if (!body) throw new Error("Skill markdown must have a non-empty body (the procedure)");
  return {
    name: meta.name,
    description: meta.description,
    tags,
    importance,
    body,
  };
}

/**
 * Format a parsed SkillImport into the same content shape `skill store`
 * produces, so downstream `skill search` / `skill list` find it the same
 * way regardless of whether it was created in-world or imported from disk.
 *
 * Shape: `[Skill: <name>] <description> || Actions: <body>`
 */
export function formatSkillContent(skill: SkillImport): string {
  return `[Skill: ${skill.name}] ${skill.description} || Actions: ${skill.body}`;
}

/**
 * Confine a user-supplied skill path to the server's working directory.
 *
 * `skill import` is a host file read driven by in-world input, so the path is
 * resolved against `process.cwd()` and must stay inside it (or inside a
 * `skills/` directory under it — the same root, spelled for the common case).
 * `..` segments, absolute paths outside cwd, and symlinks that resolve outside
 * the root are all rejected. Returns the real (symlink-resolved) path.
 */
export function resolveConfinedSkillPath(path: string, root = process.cwd()): string {
  const trimmed = path.trim();
  if (!trimmed) throw new Error("skill import: empty path");
  if (trimmed.split(/[\\/]+/).includes("..")) {
    throw new Error("skill import: path may not contain '..' segments");
  }
  const realRoot = realpathSync(root);
  const candidate = resolve(realRoot, trimmed);
  const inside = (p: string) => p === realRoot || p.startsWith(realRoot + sep);
  if (!inside(candidate)) {
    throw new Error(`skill import: path must be inside ${realRoot} (or its skills/ directory)`);
  }
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    throw new Error(`skill import: file not found: ${trimmed}`);
  }
  if (!inside(real)) {
    throw new Error("skill import: path resolves (via symlink) outside the working directory");
  }
  return real;
}

/**
 * Read a skill file from disk and parse it. Convenience wrapper.
 */
export function loadSkillFile(path: string): SkillImport {
  const source = readFileSync(path, "utf8");
  try {
    return parseSkillMarkdown(source);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse skill file ${path}: ${msg}`);
  }
}

/**
 * Discover .md skill files in a directory. Non-recursive.
 * Returns absolute file paths sorted by basename for deterministic seed order.
 */
export function discoverSkillFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // Missing directory is not an error — just no skills to import
  }
  const files: string[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const path = join(dir, name);
    try {
      if (statSync(path).isFile()) files.push(path);
    } catch {
      /* ignore unreadable entries */
    }
  }
  return files.sort((a, b) => basename(a).localeCompare(basename(b)));
}
