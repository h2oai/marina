// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { getErrorMessage } from "../engine/errors";
import { canonicalFederationJson } from "../net/federation-crypto";
import type { ArtifactEdit } from "./task-artifact";

export const artifactFileHash = (content: string | null) =>
  content === null ? null : createHash("sha256").update(content).digest("hex");

export interface TaskArtifactFileAccess {
  /** Caller owns path authorization and host/guest mapping; no filesystem fallback here. */
  read(path: string): Promise<{ content: string | null; version: string }>;
  /**
   * Atomically compare version AND hash before writing. Every workspace write, including
   * ordinary writes, A→B→A and path-identity changes, must advance the opaque version.
   * Versions must distinguish a replaced or retargeted file from its predecessor.
   * Unmanaged external writes
   * are outside this contract; a content hash alone cannot provide this guarantee.
   */
  compareAndWrite(
    path: string,
    expected: { version: string; sha256: string | null },
    content: string,
  ): Promise<boolean>;
  /** Execute as the requesting actor through the normal world command queue. */
  command(command: string): Promise<string>;
}

function result(text: string): Record<string, unknown> {
  if (text.startsWith("task work:")) throw new Error(text);
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a task-work command result.");
  return value as Record<string, unknown>;
}

/**
 * Optional file adapter: scoped native edits publish the actual deliverable.
 * Existing ordinary file edits are adopted in the same native edit transaction.
 * The caller never has to maintain a separate scalar work record or copy an export.
 */
export async function editTaskArtifactFile(
  access: TaskArtifactFileAccess,
  input: {
    taskId: number;
    path: string;
    expected: { revision: number; version: string; sha256: string | null };
    edits: ArtifactEdit[];
  },
) {
  if (!Number.isSafeInteger(input.taskId) || input.taskId < 1) throw new Error("Invalid task id.");
  if (!Array.isArray(input.edits) || !input.edits.length)
    throw new Error("Supply a nonempty edits array.");
  if (
    !input.expected ||
    !Number.isSafeInteger(input.expected.revision) ||
    input.expected.revision < 0 ||
    typeof input.expected.version !== "string"
  )
    throw new Error("Supply the revision, version and hash returned by your last read.");
  const { content, version } = await access.read(input.path);
  if (version !== input.expected.version || artifactFileHash(content) !== input.expected.sha256)
    throw new Error(
      "The deliverable changed since your read. Read it before retrying; no edit was applied.",
    );
  const state = result(await access.command(`task work ${input.taskId} show`));
  if (!Number.isSafeInteger(state.revision)) throw new Error("Missing work revision.");
  if (state.revision !== input.expected.revision)
    throw new Error(
      "Native work changed since your read. Read it before retrying; no edit was applied.",
    );
  const artifact = state.artifact as { value: unknown } | undefined;
  const edits: ArtifactEdit[] = [];
  if (content !== null) {
    const value = JSON.parse(content);
    if (!artifact) edits.push({ op: "set", path: "", value });
    else if (canonicalFederationJson(artifact.value) !== canonicalFederationJson(value))
      edits.push({
        op: "replace",
        path: "",
        value,
        reason: "Adopt the explicitly selected current file before applying its scoped edits.",
      });
  } else if (artifact) {
    // A deleted/missing file must not silently recreate a previous private draft.
    throw new Error(
      "The artifact exists but its file is missing. Render it explicitly or choose an existing file.",
    );
  }
  edits.push(...input.edits);
  const edited = result(
    await access.command(
      `task work ${input.taskId} artifact-edit ${state.revision} ${JSON.stringify(edits)}`,
    ),
  );
  if (
    typeof edited.content !== "string" ||
    typeof edited.sha256 !== "string" ||
    !Number.isSafeInteger(edited.revision)
  )
    throw new Error("Native artifact edit did not return a deliverable.");
  if (artifactFileHash(edited.content) !== edited.sha256)
    throw new Error("Artifact content hash mismatch.");
  const recovery = `Native revision ${edited.revision} is retained, but publication was not confirmed. Read both the file and native work before retrying.`;
  let published: boolean;
  try {
    published = await access.compareAndWrite(input.path, input.expected, edited.content);
  } catch (error) {
    throw new Error(`File write failed: ${getErrorMessage(error)}. ${recovery}`, { cause: error });
  }
  if (!published)
    throw new Error(`File changed while editing; the current file was preserved. ${recovery}`);
  return {
    taskId: input.taskId,
    path: input.path,
    revision: edited.revision as number,
    sha256: edited.sha256,
    content: edited.content,
    changedPaths: edited.changedPaths,
    feedback: edited.feedback,
  };
}
