// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

export interface DiffRow {
  header?: string;
  left?: { number?: number; text: string; changed: boolean };
  right?: { number?: number; text: string; changed: boolean };
}

/** Pair deletion/addition runs within each hunk; preserve metadata and multiple files. */
export function splitDiff(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let removed: NonNullable<DiffRow["left"]>[] = [];
  let added: NonNullable<DiffRow["right"]>[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++)
      rows.push({ left: removed[i], right: added[i] });
    removed = [];
    added = [];
  };
  for (const line of patch.trimEnd().split("\n")) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      flush();
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      rows.push({ header: line });
    } else if (inHunk && line.startsWith("-")) {
      if (added.length) flush();
      removed.push({ number: oldLine++, text: line.slice(1), changed: true });
    } else if (inHunk && line.startsWith("+"))
      added.push({ number: newLine++, text: line.slice(1), changed: true });
    else if (inHunk && line.startsWith(" ")) {
      flush();
      rows.push({
        left: { number: oldLine++, text: line.slice(1), changed: false },
        right: { number: newLine++, text: line.slice(1), changed: false },
      });
    } else {
      flush();
      if (!line.startsWith("\\")) inHunk = false;
      rows.push({ header: line });
    }
  }
  flush();
  return rows;
}
