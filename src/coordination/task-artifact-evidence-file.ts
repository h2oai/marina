// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ArtifactEvidencePlan } from "./task-artifact-evidence";
import { artifactFileHash, type TaskArtifactFileAccess } from "./task-artifact-file";

/** Optional evidence audit of actual file bytes; never imports, edits or approves them. */
export async function auditTaskArtifactFile(
  access: TaskArtifactFileAccess,
  input: {
    taskId: number;
    path: string;
    expected: { version: string; sha256: string | null };
    plan: ArtifactEvidencePlan;
  },
) {
  if (!Number.isSafeInteger(input.taskId) || input.taskId < 1) throw new Error("Invalid task id.");
  const file = await access.read(input.path);
  if (
    file.content === null ||
    file.version !== input.expected.version ||
    artifactFileHash(file.content) !== input.expected.sha256
  )
    throw new Error("The deliverable is absent or changed since your read; read it before audit.");
  const payload = { target: { name: input.path, content: file.content }, plan: input.plan };
  const response = await access.command(
    `task work ${input.taskId} artifact-audit ${JSON.stringify(payload)}`,
  );
  if (response.startsWith("task work:")) throw new Error(response);
  const result = JSON.parse(response);
  const current = await access.read(input.path);
  if (current.version !== file.version || current.content !== file.content)
    throw new Error("The deliverable changed during audit; the report is historical.");
  if (
    result.taskId !== input.taskId ||
    result.target?.name !== input.path ||
    result.target?.sha256 !== input.expected.sha256
  )
    throw new Error("Evidence audit does not identify the selected file contents.");
  return { ...result, file: { path: input.path, ...input.expected } };
}
