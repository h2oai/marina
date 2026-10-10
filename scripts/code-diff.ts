// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  classifyDiffLines,
  diffStat,
  firstHunk,
  formatDiffStat,
  hunkCount,
} from "../src/coding/unified-diff";

/**
 * Terminal diff presentation. Colour is added only here, on the client, from
 * structured diff content that has already passed terminal sanitising. The
 * server never sends escape sequences and this module never trusts any.
 */

/** Colour only for an interactive terminal, and never under NO_COLOR. */
export function diffColorEnabled(
  stream: { isTTY?: boolean } | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.NO_COLOR === undefined && !!stream?.isTTY;
}

const SGR = { add: "32", del: "31", hunk: "36", file: "1" } as const;

/** `+` green, `-` red, `@@` cyan, file headers bold. Plain text when disabled. */
export function colorizeDiff(text: string, enabled: boolean): string {
  if (!enabled) return text;
  const lines = text.split("\n");
  const kinds = classifyDiffLines(lines);
  return lines
    .map((line, index) => {
      const kind = kinds[index]!;
      const code = kind in SGR ? SGR[kind as keyof typeof SGR] : undefined;
      return code && line ? `\x1b[${code}m${line}\x1b[0m` : line;
    })
    .join("\n");
}

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** Says what the server left out and where the rest is. Never silent. */
export function truncationNote(shownBytes: number, totalBytes?: number, path?: string): string {
  const target = path && path !== "." ? path : "<path>";
  return `[Diff truncated by the server: showing ${size(shownBytes)}${totalBytes && totalBytes > shownBytes ? ` of ${size(totalBytes)}` : " (total size not reported)"}. Run code diff ${target} to read one file in full.]`;
}

export interface DiffPayload {
  content: string;
  /** full: stat + every hunk; preview: stat + first hunk; stat: stat only. */
  mode: "full" | "preview" | "stat";
  truncated?: boolean;
  totalBytes?: number;
  path?: string;
  /** Command that prints the whole diff when this is a preview. */
  fullCommand?: string;
}

/** Plain-text body: per-file stat first, then hunks, then any truncation note. */
export function renderDiff(payload: DiffPayload): string {
  const content = payload.content.replace(/\s+$/, "");
  if (!content) return "No changes.";
  const parts = [formatDiffStat(diffStat(content))];
  if (payload.mode === "full") parts.push(content);
  else if (payload.mode === "preview") {
    const hunk = firstHunk(content);
    const total = hunkCount(content);
    if (hunk) parts.push(hunk);
    if (total > 1 || !hunk)
      parts.push(
        `[${hunk ? `First of ${total} hunks shown.` : "No hunks."}${payload.fullCommand ? ` ${payload.fullCommand} prints the whole diff.` : ""}]`,
      );
  }
  if (payload.truncated)
    parts.push(
      truncationNote(Buffer.byteLength(payload.content), payload.totalBytes, payload.path),
    );
  return parts.join("\n\n");
}

/** How a perception's structured diff should be shown, or undefined for plain text. */
export function diffPayloadFor(code: Record<string, unknown> | undefined): DiffPayload | undefined {
  // An empty diff keeps the server's own "No git diff." wording.
  if (!code || typeof code.content !== "string" || !code.content.trim()) return undefined;
  const base = {
    content: code.content,
    truncated: code.truncated === true,
    totalBytes: typeof code.totalBytes === "number" ? code.totalBytes : undefined,
    path:
      Array.isArray(code.paths) && typeof code.paths[0] === "string" ? code.paths[0] : undefined,
  };
  const id = typeof code.artifactId === "string" ? code.artifactId : undefined;
  if (code.type === "diff" && code.event === "diff_viewed") return { ...base, mode: "full" };
  if (code.type !== "patch") return undefined;
  if (code.event === "patch_proposed")
    return { ...base, mode: "preview", fullCommand: id ? `code show ${id}` : undefined };
  if (code.event === "artifact_shown") return { ...base, mode: "full" };
  if (code.event === "patch_applied") return { ...base, mode: "stat" };
  return undefined;
}

// --- Native edit approvals -------------------------------------------------

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

type Op = { t: " " | "-" | "+"; line: string };

/** Line operations between two texts: common prefix/suffix, then LCS on the middle. */
function lineOps(before: string[], after: string[]): Op[] {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix++;
  const a = before.slice(prefix, before.length - suffix);
  const b = after.slice(prefix, after.length - suffix);
  const middle: Op[] = [];
  if (a.length * b.length > 0 && a.length * b.length <= 1_000_000) {
    const width = b.length + 1;
    const table = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--)
        table[i * width + j] =
          a[i] === b[j]
            ? table[(i + 1) * width + j + 1]! + 1
            : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        middle.push({ t: " ", line: a[i]! });
        i++;
        j++;
      } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!)
        middle.push({ t: "-", line: a[i++]! });
      else middle.push({ t: "+", line: b[j++]! });
    }
    while (i < a.length) middle.push({ t: "-", line: a[i++]! });
    while (j < b.length) middle.push({ t: "+", line: b[j++]! });
  } else {
    for (const line of a) middle.push({ t: "-", line });
    for (const line of b) middle.push({ t: "+", line });
  }
  return [
    ...before.slice(0, prefix).map((line) => ({ t: " " as const, line })),
    ...middle,
    ...before.slice(before.length - suffix).map((line) => ({ t: " " as const, line })),
  ];
}

/** A unified diff of one file, three lines of context, git-style headers. */
export function unifiedFileDiff(
  path: string,
  before: string | null,
  after: string | null,
  context = 3,
): string {
  const ops = lineOps(splitLines(before ?? ""), splitLines(after ?? ""));
  const oldAt: number[] = [];
  const newAt: number[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const op of ops) {
    oldAt.push(oldLine);
    newAt.push(newLine);
    if (op.t !== "+") oldLine++;
    if (op.t !== "-") newLine++;
  }
  const changes = ops.flatMap((op, index) => (op.t === " " ? [] : [index]));
  if (!changes.length) return "";
  const hunks: string[] = [];
  let groupStart = 0;
  for (let k = 1; k <= changes.length; k++) {
    if (k < changes.length && changes[k]! - changes[k - 1]! <= context * 2 + 1) continue;
    const start = Math.max(0, changes[groupStart]! - context);
    const end = Math.min(ops.length, changes[k - 1]! + 1 + context);
    const slice = ops.slice(start, end);
    const oldCount = slice.filter((op) => op.t !== "+").length;
    const newCount = slice.filter((op) => op.t !== "-").length;
    const oldStart = oldCount ? oldAt[start]! + 1 : oldAt[start]!;
    const newStart = newCount ? newAt[start]! + 1 : newAt[start]!;
    hunks.push(
      `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      ...slice.map((op) => `${op.t}${op.line}`),
    );
    groupStart = k;
  }
  return [
    `--- ${before === null ? "/dev/null" : `a/${path}`}`,
    `+++ ${after === null ? "/dev/null" : `b/${path}`}`,
    ...hunks,
  ].join("\n");
}

const MAX_COMPARED_FILE_BYTES = 1024 * 1024;

/** Current text of a file the agent asks to change: null when absent, undefined when unreadable. */
export function readCurrentFile(cwd: string, path: string): string | null | undefined {
  try {
    const target = resolve(cwd, path);
    const stat = statSync(target, { throwIfNoEntry: false });
    if (!stat) return null;
    if (!stat.isFile() || stat.size > MAX_COMPARED_FILE_BYTES) return undefined;
    return readFileSync(target, "utf8");
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function field(input: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) if (typeof input[name] === "string") return input[name] as string;
  return undefined;
}
function replaceText(current: string, oldText: string, newText: string, all: boolean) {
  if (!oldText || !current.includes(oldText)) return undefined;
  if (all) return current.split(oldText).join(newText);
  const at = current.indexOf(oldText);
  return current.slice(0, at) + newText + current.slice(at + oldText.length);
}
function looksLikePatch(value: string): boolean {
  return /^(diff --git |--- |@@ |\*\*\* Begin Patch)/m.test(value);
}

/**
 * Turns a native file-change approval (Claude Edit/MultiEdit/Write, Codex or
 * pi patch requests) into a unified diff against the current file. Returns
 * undefined for anything else, which keeps the JSON presentation.
 */
export function nativeEditDiff(
  input: unknown,
  read: (path: string) => string | null | undefined,
  cwd?: string,
): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  const rawPath = field(value, "file_path", "filePath", "path");
  const display = (path: string) =>
    cwd && isAbsolute(path) && !relative(cwd, path).startsWith("..")
      ? relative(cwd, path)
      : path.replace(/^\/+/, "");

  const patch = field(value, "patch", "diff", "unified_diff");
  if (patch && looksLikePatch(patch))
    return /^(diff --git |--- |\*\*\* Begin Patch)/m.test(patch) || !rawPath
      ? patch
      : `--- a/${display(rawPath)}\n+++ b/${display(rawPath)}\n${patch}`;

  // Codex file changes: a map or list of {path, kind|type, diff|content}.
  const changes = value.changes ?? value.fileChanges;
  if (changes && typeof changes === "object") {
    const entries = Array.isArray(changes)
      ? changes.map((change) => [text((change as Record<string, unknown>)?.path), change] as const)
      : Object.entries(changes as Record<string, unknown>);
    const parts: string[] = [];
    for (const [path, change] of entries) {
      if (!path || !change || typeof change !== "object") return undefined;
      const record = change as Record<string, unknown>;
      const kind =
        text(record.type) ??
        text((record.kind as Record<string, unknown> | undefined)?.type) ??
        text(record.kind);
      const body = field(record, "unified_diff", "diff", "patch");
      const content = field(record, "content");
      const name = display(path);
      if (kind === "add" && (content ?? body) !== undefined && !(body && looksLikePatch(body)))
        parts.push(unifiedFileDiff(name, null, content ?? body ?? ""));
      else if (kind === "delete")
        parts.push(unifiedFileDiff(name, read(path) ?? "", null) || `--- a/${name}\n+++ /dev/null`);
      else if (body)
        parts.push(
          /^(diff --git |--- )/m.test(body) ? body : `--- a/${name}\n+++ b/${name}\n${body}`,
        );
      else return undefined;
    }
    return parts.length ? parts.join("\n") : undefined;
  }

  if (!rawPath) return undefined;
  const name = display(rawPath);
  const current = read(rawPath);
  const content = field(value, "content");
  const oldText = field(value, "old_string", "oldText", "old_text");
  const newText = field(value, "new_string", "newText", "new_text");
  const edits = Array.isArray(value.edits)
    ? value.edits.map((edit) => {
        const entry = (edit ?? {}) as Record<string, unknown>;
        return {
          oldText: field(entry, "old_string", "oldText", "old_text"),
          newText: field(entry, "new_string", "newText", "new_text"),
          all: entry.replace_all === true || entry.replaceAll === true,
        };
      })
    : oldText !== undefined && newText !== undefined
      ? [{ oldText, newText, all: value.replace_all === true || value.replaceAll === true }]
      : undefined;

  if (edits) {
    if (
      !edits.length ||
      edits.some((edit) => edit.oldText === undefined || edit.newText === undefined)
    )
      return undefined;
    let next = typeof current === "string" ? current : undefined;
    for (const edit of edits) {
      if (next === undefined) break;
      next = replaceText(next, edit.oldText!, edit.newText!, edit.all);
    }
    if (typeof current === "string" && next !== undefined)
      return unifiedFileDiff(name, current, next) || `--- a/${name}\n+++ b/${name}`;
    // The requested text is not in the current file (or it cannot be read):
    // show the requested replacement itself, and say so.
    return [
      `[The current file could not be compared; showing the requested replacement.]`,
      ...edits.map((edit) => unifiedFileDiff(name, edit.oldText!, edit.newText!)),
    ].join("\n");
  }
  if (content !== undefined)
    return (
      unifiedFileDiff(name, current === undefined ? "" : current, content) ||
      `--- a/${name}\n+++ b/${name}`
    );
  return undefined;
}
