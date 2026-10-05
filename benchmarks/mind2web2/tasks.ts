// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mind2Web 2 tasks: the public dev set comes from the published judge scripts
 * (each defines `TASK_ID` and `TASK_DESCRIPTION`); a test run reads the task
 * list CSV (`task_id` plus the description column) supplied by the operator.
 * Only ids and descriptions are read — never a script's rubric or ground truth.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface M2W2Task {
  id: string;
  description: string;
}

/** `TASK_ID` / `TASK_DESCRIPTION` of one judge script (undefined when either is missing). */
export function taskFromScript(source: string): M2W2Task | undefined {
  const id = /^TASK_ID\s*=\s*["']([^"']+)["']/m.exec(source)?.[1];
  const desc = /^TASK_DESCRIPTION\s*=\s*(?:"""([\s\S]*?)"""|'''([\s\S]*?)''')/m.exec(source);
  const description = (desc?.[1] ?? desc?.[2])?.trim();
  return id && description ? { id, description } : undefined;
}

/** Every task of a directory of judge scripts, sorted by id. */
export function tasksFromScripts(dir: string): M2W2Task[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".py"))
    .flatMap((f) => {
      const t = taskFromScript(readFileSync(join(dir, f), "utf8"));
      return t ? [t] : [];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** RFC 4180 CSV → rows of fields (quoted fields, doubled quotes, embedded newlines). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.length > 0)) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.length > 0)) rows.push(row);
  return rows;
}

const DESCRIPTION_COLUMNS = ["task_description", "description", "task", "question", "prompt"];

/** Tasks from a task-list CSV with a `task_id` column and a description column. */
export function tasksFromCsv(text: string): M2W2Task[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const cols = header.map((h) => h.trim().toLowerCase());
  const idCol = cols.indexOf("task_id");
  const descCol = DESCRIPTION_COLUMNS.map((c) => cols.indexOf(c)).find((i) => i >= 0);
  if (idCol < 0 || descCol === undefined)
    throw new Error(
      `task list needs task_id and one of ${DESCRIPTION_COLUMNS.join(", ")} (has ${cols.join(", ")})`,
    );
  return rows.flatMap((r) => {
    const id = r[idCol]?.trim();
    const description = r[descCol]?.trim();
    return id && description ? [{ id, description }] : [];
  });
}

/**
 * The pre-registered split: tasks ordered by `sha256(salt + ":" + id)`; the
 * first `tune` are for debugging, the rest for selection.
 */
export function splitTasks<T extends { id: string }>(
  tasks: readonly T[],
  tune: number,
  salt: string,
): { tune: T[]; heldOut: T[] } {
  const key = (id: string) => createHash("sha256").update(`${salt}:${id}`).digest("hex");
  const ordered = [...tasks].sort((a, b) => key(a.id).localeCompare(key(b.id)));
  return { tune: ordered.slice(0, tune), heldOut: ordered.slice(tune) };
}
