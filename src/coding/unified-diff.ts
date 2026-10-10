// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Plain-text reading of unified (git) diffs: line roles, per-file stat and
 * jump anchors. Pure and presentation-free, so the server can print a plain
 * stat and terminal clients can colour from the same structure.
 */

export type DiffLineKind = "file" | "meta" | "hunk" | "add" | "del" | "context" | "other";

export interface DiffFileStat {
  path: string;
  added: number;
  removed: number;
  binary: boolean;
}

const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

function stripPrefix(path: string): string {
  const trimmed = path.replace(/\t.*$/, "").trim();
  return /^[ab]\//.test(trimmed) ? trimmed.slice(2) : trimmed;
}

/**
 * Classifies every line. Hunk bodies are counted from the `@@` header, so a
 * removed line whose text starts with `--` is never mistaken for a header.
 */
export function classifyDiffLines(lines: readonly string[]): DiffLineKind[] {
  const kinds: DiffLineKind[] = [];
  let oldLeft = 0;
  let newLeft = 0;
  let inFile = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("+")) {
        newLeft--;
        kinds.push("add");
        continue;
      }
      if (line.startsWith("-")) {
        oldLeft--;
        kinds.push("del");
        continue;
      }
      if (line.startsWith(" ") || line === "") {
        oldLeft--;
        newLeft--;
        kinds.push("context");
        continue;
      }
      if (line.startsWith("\\")) {
        kinds.push("meta");
        continue;
      }
      // A malformed or truncated hunk ends here; read the line as a header.
      oldLeft = 0;
      newLeft = 0;
    }
    if (line.startsWith("\\")) {
      kinds.push("meta");
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      kinds.push("hunk");
      continue;
    }
    if (line.startsWith("diff --git ")) {
      inFile = true;
      kinds.push("file");
      continue;
    }
    if (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
      // A plain unified diff has no `diff --git` line: its `---` starts the file.
      kinds.push("file");
      inFile = true;
      continue;
    }
    if (line.startsWith("+++ ") && kinds.at(-1) === "file") {
      kinds.push("file");
      continue;
    }
    if (
      inFile &&
      /^(index |new file mode|deleted file mode|old mode|new mode|similarity index|rename from|rename to|copy from|copy to|Binary files )/.test(
        line,
      )
    ) {
      kinds.push("meta");
      continue;
    }
    kinds.push("other");
  }
  return kinds;
}

/** Index of each file's first line and each hunk header, for jump navigation. */
export function diffAnchors(lines: readonly string[]): { files: number[]; hunks: number[] } {
  const kinds = classifyDiffLines(lines);
  const files: number[] = [];
  const hunks: number[] = [];
  kinds.forEach((kind, index) => {
    if (kind === "hunk") hunks.push(index);
    // `diff --git` then `---`/`+++`: one file, anchored at its first header line.
    const line = lines[index]!;
    if (
      kind === "file" &&
      (line.startsWith("diff --git ") ||
        (line.startsWith("--- ") && kinds[index - 1] !== "file" && kinds[index - 1] !== "meta"))
    )
      files.push(index);
  });
  return { files, hunks };
}

/** Per-file added/removed line counts, in diff order. */
export function diffStat(content: string): DiffFileStat[] {
  const lines = content.split("\n");
  const kinds = classifyDiffLines(lines);
  const files: DiffFileStat[] = [];
  let current: DiffFileStat | undefined;
  let removedPath: string | undefined;
  const start = (path: string) => {
    current = { path, added: 0, removed: 0, binary: false };
    files.push(current);
  };
  kinds.forEach((kind, index) => {
    const line = lines[index]!;
    if (kind === "file") {
      if (line.startsWith("diff --git ")) {
        const match = / b\/(.+)$/.exec(line) ?? /^diff --git (\S+)/.exec(line);
        start(stripPrefix(match?.[1] ?? line.slice(11)));
        removedPath = undefined;
      } else if (line.startsWith("--- ")) {
        removedPath = stripPrefix(line.slice(4));
        if (kinds[index - 1] !== "file" && kinds[index - 1] !== "meta")
          start(removedPath === "/dev/null" ? "" : removedPath);
      } else if (line.startsWith("+++ ") && current) {
        const added = stripPrefix(line.slice(4));
        current.path = added === "/dev/null" ? (removedPath ?? current.path) : added;
      }
    } else if (kind === "meta" && line.startsWith("Binary files ") && current) {
      current.binary = true;
    } else if (kind === "add" && current) current.added++;
    else if (kind === "del" && current) current.removed++;
  });
  return files;
}

/** `3 files · +42 −7`, then one aligned line per file. Plain text. */
export function formatDiffStat(stats: readonly DiffFileStat[]): string {
  if (!stats.length) return "0 files";
  const added = stats.reduce((sum, file) => sum + file.added, 0);
  const removed = stats.reduce((sum, file) => sum + file.removed, 0);
  const width = Math.min(60, Math.max(...stats.map((file) => file.path.length)));
  return [
    `${stats.length} file${stats.length === 1 ? "" : "s"} · +${added} −${removed}`,
    ...stats.map(
      (file) =>
        `  ${file.path.padEnd(width)}  ${file.binary ? "binary" : `+${file.added} −${file.removed}`}`,
    ),
  ].join("\n");
}

/** The first file's headers through the end of its first hunk. */
export function firstHunk(content: string): string {
  const lines = content.split("\n");
  const kinds = classifyDiffLines(lines);
  const hunk = kinds.indexOf("hunk");
  if (hunk < 0) return "";
  let start = hunk;
  while (start > 0 && (kinds[start - 1] === "file" || kinds[start - 1] === "meta")) start--;
  let end = hunk + 1;
  while (end < lines.length && ["add", "del", "context", "meta"].includes(kinds[end]!)) {
    if (kinds[end] === "meta" && !lines[end]!.startsWith("\\")) break;
    end++;
  }
  return lines.slice(start, end).join("\n").trimEnd();
}

/** Number of hunks, so a preview can say what it left out. */
export function hunkCount(content: string): number {
  return classifyDiffLines(content.split("\n")).filter((kind) => kind === "hunk").length;
}
