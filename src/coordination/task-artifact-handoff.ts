// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  artifactFileHash,
  staleFileRefusal,
  type TaskArtifactFileAccess,
} from "./task-artifact-file";

/** `{version, sha256}` as a read returns it (`sha256` null for an absent file). */
function isFileExpectation(value: unknown): value is { version: string; sha256: string | null } {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { version?: unknown }).version === "string" &&
    "sha256" in (value as object) &&
    ((value as { sha256?: unknown }).sha256 === null ||
      typeof (value as { sha256?: unknown }).sha256 === "string")
  );
}

/** Deterministic snapshot, never a second model-authored account of the same facts. */
export function renderArtifactHandoff(artifact: {
  taskId: number;
  revision: number;
  content: string;
  sha256: string;
}) {
  const fence = "~".repeat(
    [...artifact.content.matchAll(/~+/g)].reduce((n, m) => Math.max(n, m[0].length + 1), 3),
  );
  const content = [
    `### Recorded task ${artifact.taskId}, work revision ${artifact.revision}`,
    "",
    `Artifact SHA-256: ${artifact.sha256}`,
    "",
    "This is the authored deliverable at this revision, not a statement that its sources remain current or its conclusions are verified. Read the latest task work before acting. Earlier snapshots are history, not current instructions.",
    "",
    `${fence}json`,
    artifact.content.trimEnd(),
    fence,
    "",
  ].join("\n");
  return {
    ...artifact,
    artifactSha256: artifact.sha256,
    content,
    sha256: artifactFileHash(content)!,
  };
}

/**
 * Optional client publication: replace only an explicitly named snapshot block.
 * Authored notes outside it are retained verbatim and are not semantically checked.
 * A later native edit cannot make this captured revision a live view.
 */
export async function publishTaskArtifactHandoffFile(
  access: TaskArtifactFileAccess,
  input: {
    taskId: number;
    path: string;
    section: string;
    expected: {
      revision: number;
      artifactSha256: string;
      version: string;
      sha256: string | null;
    };
  },
) {
  if (!Number.isSafeInteger(input.taskId) || input.taskId < 1) throw new Error("Invalid task id.");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(input.section))
    throw new Error("Use a snapshot section id of 1–64 letters, digits, underscores or hyphens.");
  if (!Number.isSafeInteger(input.expected.revision) || input.expected.revision < 1)
    throw new Error("Supply the artifact revision returned by your read.");
  const file = await access.read(input.path);
  if (
    file.version !== input.expected.version ||
    artifactFileHash(file.content) !== input.expected.sha256
  )
    throw new Error(
      staleFileRefusal({
        object: "journal",
        path: input.path,
        field: "expected",
        supplied: input.expected,
        current: { version: file.version, sha256: artifactFileHash(file.content) },
      }),
    );
  const response = await access.command(`task work ${input.taskId} handoff`);
  if (response.startsWith("task work:")) throw new Error(response);
  const handoff = JSON.parse(response) as ReturnType<typeof renderArtifactHandoff>;
  if (
    handoff.taskId !== input.taskId ||
    typeof handoff.content !== "string" ||
    artifactFileHash(handoff.content) !== handoff.sha256
  )
    throw new Error("The artifact snapshot is invalid; no file changed.");
  if (
    handoff.revision !== input.expected.revision ||
    handoff.artifactSha256 !== input.expected.artifactSha256
  )
    throw new Error(
      `The artifact changed since your read: you supplied revision ${input.expected.revision} sha ${input.expected.artifactSha256.slice(0, 12)}…, the current handoff is revision ${handoff.revision} sha ${handoff.artifactSha256.slice(0, 12)}…. Run \`task work ${input.taskId} handoff\` and resend its revision and artifactSha256 as expected; no file changed.`,
    );
  return publishHandoffBlock(access, input, file, handoff);
}

/**
 * Capture an ordinary deliverable without creating or aligning a native artifact.
 * File access is authorized by the adapter; the world command checks task access.
 * This records the observed file version, never a claim of live cross-file coherence.
 */
export async function publishTaskDeliverableHandoffFile(
  access: TaskArtifactFileAccess & {
    /** Authorized canonical file identity, resolving aliases in the adapter's workspace. */
    identity(path: string): Promise<string>;
  },
  input: {
    taskId: number;
    path: string;
    section: string;
    expected: { version: string; sha256: string | null };
    deliverable: { path: string; expected: { version: string; sha256: string } };
  },
) {
  if (!Number.isSafeInteger(input.taskId) || input.taskId < 1) throw new Error("Invalid task id.");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(input.section))
    throw new Error("Use a snapshot section id of 1–64 letters, digits, underscores or hyphens.");
  // Shape first, so a malformed call gets the contract back, never a TypeError.
  if (!isFileExpectation(input.expected) || typeof input.path !== "string" || !input.path)
    throw new Error(
      "Supply path (the journal) and expected as {version, sha256} from your read of the journal; the deliverable goes in deliverable: {path, expected: {version, sha256}}.",
    );
  if (
    !input.deliverable ||
    typeof input.deliverable !== "object" ||
    typeof input.deliverable.path !== "string" ||
    !input.deliverable.path ||
    !isFileExpectation(input.deliverable.expected) ||
    typeof input.deliverable.expected.sha256 !== "string"
  )
    throw new Error(
      "Supply deliverable as {path, expected: {version, sha256}} from your read of the deliverable; `expected` is the journal, `deliverable.expected` is the deliverable.",
    );
  const journalIdentity = await access.identity(input.path);
  const deliverableIdentity = await access.identity(input.deliverable.path);
  if (!journalIdentity || !deliverableIdentity)
    throw new Error("The adapter must identify both files before capture.");
  if (journalIdentity === deliverableIdentity)
    throw new Error("Choose a journal distinct from the deliverable.");
  const authorize = async () => {
    const response = await access.command(`task work ${input.taskId} show`);
    if (response.startsWith("task work:")) throw new Error(response);
    if (JSON.parse(response)?.taskId !== input.taskId)
      throw new Error("Task access was not confirmed.");
  };
  await authorize();
  const source = await access.read(input.deliverable.path);
  const file = await access.read(input.path);
  const journalHash = artifactFileHash(file.content);
  if (
    source.content === null ||
    source.version !== input.deliverable.expected.version ||
    artifactFileHash(source.content) !== input.deliverable.expected.sha256
  ) {
    // The commonest loop: the journal's version/hash sent as the deliverable's.
    const swapped =
      input.deliverable.expected.version === file.version &&
      input.deliverable.expected.sha256 === journalHash;
    throw new Error(
      staleFileRefusal({
        object: "deliverable",
        path: input.deliverable.path,
        field: "deliverable.expected",
        supplied: input.deliverable.expected,
        current:
          source.content === null
            ? null
            : { version: source.version, sha256: artifactFileHash(source.content) },
        ...(swapped
          ? {
              hint: `You supplied the journal's version and hash (${JSON.stringify(input.path)}) for the deliverable; \`expected\` is the journal, \`deliverable.expected\` is the deliverable.`,
            }
          : {}),
      }),
    );
  }
  if (file.version !== input.expected.version || journalHash !== input.expected.sha256)
    throw new Error(
      staleFileRefusal({
        object: "journal",
        path: input.path,
        field: "expected",
        supplied: input.expected,
        current: { version: file.version, sha256: journalHash },
      }),
    );
  const fence = "~".repeat(
    [...source.content.matchAll(/~+/g)].reduce((n, m) => Math.max(n, m[0].length + 1), 3),
  );
  const content = [
    `### Recorded deliverable for task ${input.taskId}`,
    "",
    // Encode caller-controlled names so they cannot inject Markdown block delimiters.
    `File: ${JSON.stringify(input.deliverable.path)}`,
    `Observed version: ${JSON.stringify(source.version)}`,
    `Artifact SHA-256: ${input.deliverable.expected.sha256}`,
    "",
    "This is a captured file version, not a live view or verification of its conclusions. Read the actual deliverable before acting. Earlier snapshots are history, not current instructions.",
    "",
    fence,
    source.content,
    fence,
    "",
  ].join("\n");
  await authorize();
  const current = await access.read(input.deliverable.path);
  if (current.version !== source.version || current.content !== source.content)
    throw new Error("The deliverable changed while capturing its snapshot; no file changed.");
  if (
    (await access.identity(input.path)) !== journalIdentity ||
    (await access.identity(input.deliverable.path)) !== deliverableIdentity
  )
    throw new Error("A file identity changed while capturing its snapshot; no file changed.");
  return publishHandoffBlock(access, input, file, {
    taskId: input.taskId,
    deliverable: {
      path: input.deliverable.path,
      version: source.version,
      sha256: input.deliverable.expected.sha256,
    },
    artifactSha256: input.deliverable.expected.sha256,
    content,
    sha256: artifactFileHash(content)!,
  });
}

async function publishHandoffBlock<T extends { content: string }>(
  access: TaskArtifactFileAccess,
  input: {
    path: string;
    section: string;
    expected: { version: string; sha256: string | null };
  },
  file: { content: string | null; version: string },
  handoff: T,
): Promise<T & { path: string; section: string; changed: boolean; note?: string }> {
  const start = `<!-- marina-task-snapshot:${input.section}:start -->`;
  const end = `<!-- marina-task-snapshot:${input.section}:end -->`;
  if (handoff.content.includes(start) || handoff.content.includes(end))
    throw new Error("The artifact contains snapshot delimiters. Choose a different section id.");
  const original = file.content ?? "";
  const starts = original.split(start).length - 1;
  const ends = original.split(end).length - 1;
  if (
    starts !== ends ||
    starts > 1 ||
    (starts === 1 && original.indexOf(end) < original.indexOf(start))
  )
    throw new Error("Snapshot section is ambiguous or incomplete; no file changed.");
  if (
    starts &&
    original
      .slice(original.indexOf(start) + start.length, original.indexOf(end))
      .includes("<!-- marina-task-snapshot:")
  )
    throw new Error("Snapshot sections must not nest; no file changed.");
  const block = `${start}\n${handoff.content}${end}`;
  const content = starts
    ? original.slice(0, original.indexOf(start)) +
      block +
      original.slice(original.indexOf(end) + end.length)
    : `${original}${original && !original.endsWith("\n") ? "\n" : ""}${original ? "\n" : ""}${block}\n`;
  // Equal bytes need no write, revision bump, or peer wake.
  if (content === original) {
    const current = await access.read(input.path);
    if (current.version !== file.version || current.content !== file.content)
      throw new Error(
        "The journal changed while inspecting its snapshot. Read it before retrying.",
      );
    return {
      ...handoff,
      path: input.path,
      section: input.section,
      changed: false,
      note: `Snapshot "${input.section}" is already published at this version; nothing changed and no peer was woken.`,
    };
  }
  if (!(await access.compareAndWrite(input.path, input.expected, content)))
    throw new Error(
      `The journal changed while publishing (${JSON.stringify(input.path)}); its current contents were preserved. Re-read it and resend its version and hash as expected.`,
    );
  return { ...handoff, path: input.path, section: input.section, changed: true };
}
