// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { artifactFileHash, type TaskArtifactFileAccess } from "./task-artifact-file";
import type { ProseReviewInput } from "./task-prose-review";

/** Optional caller-side read: no host/guest path assumptions, writes or automatic repairs. */
export async function reviewTaskProseFile(
  access: TaskArtifactFileAccess,
  input: {
    taskId: number;
    path: string;
    expected: { version: string; sha256: string | null };
    refs: string[];
    mode: "packet" | "fresh";
    model?: string;
    reasoningEffort?: ProseReviewInput["reasoningEffort"];
  },
) {
  if (!Number.isSafeInteger(input.taskId) || input.taskId < 1) throw new Error("Invalid task id.");
  if (!["packet", "fresh"].includes(input.mode))
    throw new Error("Use packet or fresh review mode.");
  const file = await access.read(input.path);
  if (
    file.content === null ||
    file.version !== input.expected.version ||
    artifactFileHash(file.content) !== input.expected.sha256
  )
    throw new Error("The prose file is absent or changed since your read. Read it before review.");
  const command = input.mode === "fresh" ? "prose-review-fresh" : "prose-review";
  const payload = {
    target: { name: input.path, content: file.content },
    refs: input.refs,
    ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.mode === "fresh" && input.model ? { model: input.model } : {}),
  };
  const response = await access.command(
    `task work ${input.taskId} ${command} ${JSON.stringify(payload)}`,
  );
  if (response.startsWith("task work:")) throw new Error(response);
  const result = JSON.parse(response);
  const current = await access.read(input.path);
  if (current.version !== file.version || current.content !== file.content)
    throw new Error(
      "The prose file changed during review. The assessment is historical; read current text before acting.",
    );
  const target = input.mode === "fresh" ? result.report?.target : result.target;
  if (target?.name !== input.path || target?.sha256 !== input.expected.sha256)
    throw new Error("Prose assessment does not identify the requested file contents.");
  return {
    ...result,
    file: { path: input.path, version: file.version, sha256: input.expected.sha256 },
  };
}
