// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { WorkspaceRuntime } from "../../../coding/local-workspace";
import { dim, error as fmtError, header, separator, success } from "../../../net/ansi";
import type { CodingSessionRow, MarinaDB } from "../../../persistence/database";
import type { Entity, EntityId, RoomContext } from "../../../types";
import { parsePatchActionArgs, resolveKindArtifact, resolvePatchArtifact } from "./artifacts";
import {
  type CodeDeps,
  enforceWriteLock,
  ensureTrailingNewline,
  parseArtifactMetadata,
  parseJsonObject,
  resolveSession,
  sameEntityName,
  sendCode,
  updateCodeContext,
} from "./shared";
import { workspaceForSession } from "./workspace";

export function files(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  path: string,
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const workspace = workspaceForSession(deps, session);
  const entries = workspace.list(path);
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "files_listed",
    payload: { path },
  });
  const lines = [header(`Files: ${path || "."}`), separator()];
  for (const entry of entries) {
    const icon = entry.type === "dir" ? "/" : " ";
    const size = entry.type === "file" ? dim(`${entry.size}b`) : "";
    lines.push(`  ${entry.path}${icon} ${size}`);
  }
  sendCode(ctx, eid, lines.join("\n"), {
    commands: ["code read <path>", "code search <query>", "code diff"],
    event: "files_listed",
    rows: entries.map((entry) => ({
      path: entry.path,
      size: entry.size,
      title: entry.path,
      type: entry.type,
    })),
    sessionId: session.id,
    title: `Files: ${path || "."}`,
    type: "list",
    workspace: session.workspace_root,
  });
}

export async function readFile(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  path: string,
): Promise<void> {
  if (!path.trim()) {
    ctx.send(eid, "Usage: code read <path>");
    return;
  }
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const workspace = workspaceForSession(deps, session);
  const result = await workspace.read(path);
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "file_read",
    payload: { path: result.path, size: result.size, truncated: result.truncated },
  });
  const suffix = result.truncated ? dim("\n[truncated]") : "";
  sendCode(
    ctx,
    eid,
    `${header(result.path)} ${dim(`${result.size}b`)}\n${result.content}${suffix}`,
    {
      commands: [`code diff ${result.path}`, `code search ${result.path}`],
      content: result.content,
      event: "file_read",
      paths: [result.path],
      rows: [
        {
          path: result.path,
          size: result.size,
          status: result.truncated ? "truncated" : "complete",
          title: result.path,
          type: "file",
        },
      ],
      sessionId: session.id,
      title: result.path,
      truncated: result.truncated,
      type: "file",
      workspace: session.workspace_root,
    },
  );
}

export async function search(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  query: string,
): Promise<void> {
  if (!query.trim()) {
    ctx.send(eid, "Usage: code search <query>");
    return;
  }
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const workspace = workspaceForSession(deps, session);
  const hits = await workspace.search(query);
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "workspace_searched",
    payload: { query, hits: hits.length },
  });
  if (hits.length === 0) {
    sendCode(ctx, eid, `No code search results for "${query}".`, {
      commands: ["code files", "code search <query>"],
      event: "workspace_searched",
      query,
      rows: [],
      sessionId: session.id,
      title: `Code Search: "${query}"`,
      type: "search",
      workspace: session.workspace_root,
    });
    return;
  }
  const lines = [header(`Code Search: "${query}"`), separator()];
  for (const hit of hits) {
    lines.push(`  ${hit.path}:${hit.line}: ${hit.text}`);
  }
  sendCode(ctx, eid, lines.join("\n"), {
    commands: ["code read <path>", "code diff <path>"],
    event: "workspace_searched",
    query,
    rows: hits.map((hit) => ({
      line: hit.line,
      path: hit.path,
      text: hit.text,
      title: `${hit.path}:${hit.line}`,
      type: "search_hit",
    })),
    sessionId: session.id,
    title: `Code Search: "${query}"`,
    type: "search",
    workspace: session.workspace_root,
  });
}

export async function diff(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  path: string,
): Promise<void> {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const workspace = workspaceForSession(deps, session);
  const result = await workspace.diff(path || undefined);
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "diff_viewed",
    payload: { path: path || ".", exitCode: result.exitCode, truncated: result.truncated },
  });
  const body = result.content.trim() || dim("No git diff.");
  const suffix = result.truncated ? dim("\n[truncated]") : "";
  sendCode(ctx, eid, `${header(`Diff: ${path || "."}`)}\n${body}${suffix}`, {
    commands: ["code patch <title>", "code verify"],
    content: result.content,
    event: "diff_viewed",
    exitCode: result.exitCode,
    paths: [path || "."],
    sessionId: session.id,
    title: `Diff: ${path || "."}`,
    truncated: result.truncated,
    type: "diff",
    workspace: session.workspace_root,
  });
}

export async function proposePatch(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  raw: string,
): Promise<void> {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const parsed = parsePatchProposal(raw);
  if (!parsed.ok) {
    ctx.send(eid, parsed.error);
    return;
  }
  const workspace = workspaceForSession(deps, session);
  const check = await workspace.checkPatch(parsed.patch);
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: check.ok ? "patch_checked" : "patch_check_failed",
    payload: { title: parsed.title, paths: check.paths, output: check.output },
  });
  if (!check.ok) {
    ctx.send(
      eid,
      [fmtError("Patch did not apply cleanly."), check.output || dim("git apply --check failed.")]
        .filter(Boolean)
        .join("\n"),
    );
    return;
  }

  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: "patch",
    title: parsed.title,
    contentText: parsed.patch,
    metadata: { paths: check.paths },
    createdBy: entity.name,
  });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "patch_proposed",
    payload: { id: artifact.id, title: artifact.title, paths: check.paths },
  });
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);

  sendCode(
    ctx,
    eid,
    [
      success(`Patch proposed: ${artifact.id}`),
      `Title: ${artifact.title}`,
      `Paths: ${check.paths.join(", ")}`,
      dim(`Review: code show ${artifact.id}`),
      dim(`Apply:  code apply ${artifact.id}`),
    ].join("\n"),
    {
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      commands: [
        `code show ${artifact.id}`,
        `code apply ${artifact.id}`,
        `code reject ${artifact.id}`,
      ],
      content: artifact.content_text,
      event: "patch_proposed",
      paths: check.paths,
      sessionId: session.id,
      status: artifact.status,
      title: artifact.title,
      type: "patch",
    },
  );
}

export async function applyPatch(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  ref: string | undefined,
): Promise<void> {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  // Write-lock gate: when a crew writer is set, only the holder may apply.
  // Null writer = no restriction (preserves solo-session behavior).
  if (!enforceWriteLock(ctx, eid, entity, session)) return;
  // Solo-workspace guard (only enforced when there is no crew writer): the
  // session creator owns local writes. A set writer supersedes this.
  if (!session.writer && !sameEntityName(session.created_by, entity.name)) {
    ctx.send(eid, "Only the session creator can apply patches in this local workspace mode.");
    return;
  }
  const artifact = resolvePatchArtifact(ctx, eid, deps.db, session.id, ref);
  if (!artifact) return;
  if (artifact.status !== "pending") {
    ctx.send(eid, `Patch ${artifact.id} is ${artifact.status}, not pending.`);
    return;
  }

  const workspace = workspaceForSession(deps, session);
  const result = await workspace.applyPatch(artifact.content_text);
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: result.ok ? "patch_applied" : "patch_apply_failed",
    payload: { id: artifact.id, paths: result.paths, output: result.output },
  });
  if (!result.ok) {
    ctx.send(
      eid,
      [fmtError(`Patch ${artifact.id} did not apply.`), result.output || dim("git apply failed.")]
        .filter(Boolean)
        .join("\n"),
    );
    return;
  }
  deps.db.updateCodingArtifact(artifact.id, {
    status: "applied",
    appliedBy: entity.name,
    appliedAt: Date.now(),
  });
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  const diffResult = await workspace.diff();
  const diffBody = diffResult.content.trim() || dim("Patch applied; no git diff remains.");
  sendCode(
    ctx,
    eid,
    [
      success(`Patch applied: ${artifact.id}`),
      `Paths: ${result.paths.join(", ")}`,
      separator(),
      diffBody,
    ].join("\n"),
    {
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      commands: ["code diff", `code show ${artifact.id}`],
      content: diffResult.content,
      event: "patch_applied",
      paths: result.paths,
      sessionId: session.id,
      status: "applied",
      title: artifact.title,
      type: "patch",
    },
  );
}

/**
 * File-mutation surface implemented by LocalWorkspace.editFile/writeFile.
 * Typed locally (and probed at runtime) so `code edit`/`code write` degrade
 * with a clear message on a workspace runtime that predates the methods.
 */
interface WorkspaceFileEdits {
  editFile(
    path: string,
    oldText: string,
    newText: string,
    opts?: { replaceAll?: boolean },
  ): Promise<{ ok: boolean; output: string; occurrences: number }>;
  writeFile(
    path: string,
    content: string,
  ): Promise<{ ok: boolean; output: string; created: boolean }>;
}

const EDIT_USAGE =
  "Usage: code edit <path>[ all]\\n<<<<<<< OLD\\n{old text}\\n=======\\n{new text}\\n>>>>>>> NEW";

const WRITE_USAGE = "Usage: code write <path>\\n{content}";

function parseEditRequest(
  raw: string,
):
  | { ok: true; path: string; oldText: string; newText: string; replaceAll: boolean }
  | { ok: false; error: string } {
  const newlineIdx = raw.indexOf("\n");
  if (newlineIdx === -1) return { ok: false, error: EDIT_USAGE };
  const header = raw.slice(0, newlineIdx).trim();
  const replaceAll = /\s+all$/i.test(header);
  const path = replaceAll ? header.replace(/\s+all$/i, "").trim() : header;
  if (!path) return { ok: false, error: EDIT_USAGE };
  const body = raw.slice(newlineIdx + 1);
  const match = body.match(/^<{7} OLD\r?\n([\s\S]*?)\r?\n={7}\r?\n([\s\S]*?)\r?\n>{7} NEW\s*$/);
  if (!match) return { ok: false, error: EDIT_USAGE };
  return { ok: true, path, oldText: match[1] ?? "", newText: match[2] ?? "", replaceAll };
}

/**
 * Shared writer gate for direct file mutations — identical to applyPatch's:
 * a set crew writer must be the actor; with no writer, only the session
 * creator may write in this local workspace mode.
 */
function enforceFileWriteGuard(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  session: CodingSessionRow,
  verb: string,
): boolean {
  if (!enforceWriteLock(ctx, eid, entity, session)) return false;
  if (!session.writer && !sameEntityName(session.created_by, entity.name)) {
    ctx.send(eid, `Only the session creator can ${verb} files in this local workspace mode.`);
    return false;
  }
  return true;
}

export async function editWorkspaceFile(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  raw: string,
): Promise<void> {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  if (!enforceFileWriteGuard(ctx, eid, entity, session, "edit")) return;
  const parsed = parseEditRequest(raw);
  if (!parsed.ok) {
    ctx.send(eid, parsed.error);
    return;
  }
  const workspace = workspaceForSession(deps, session) as WorkspaceRuntime &
    Partial<WorkspaceFileEdits>;
  if (typeof workspace.editFile !== "function") {
    ctx.send(eid, "This workspace runtime does not support code edit.");
    return;
  }
  const result = await workspace.editFile(parsed.path, parsed.oldText, parsed.newText, {
    replaceAll: parsed.replaceAll,
  });
  if (!result.ok) {
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "file_edit_failed",
      payload: { path: parsed.path, output: result.output, occurrences: result.occurrences },
    });
    ctx.send(
      eid,
      [fmtError(`Edit did not apply to ${parsed.path}.`), result.output].filter(Boolean).join("\n"),
    );
    return;
  }
  // Audit trail: durable artifact + session event, same as an applied patch.
  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: "file_edit",
    title: `Edit ${parsed.path}`,
    status: "applied",
    contentText: [
      `--- ${parsed.path} (old)`,
      parsed.oldText,
      `+++ ${parsed.path} (new)`,
      parsed.newText,
    ].join("\n"),
    metadata: {
      occurrences: result.occurrences,
      output: result.output,
      path: parsed.path,
      replaceAll: parsed.replaceAll,
    },
    createdBy: entity.name,
  });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "file_edited",
    payload: {
      id: artifact.id,
      occurrences: result.occurrences,
      path: parsed.path,
      replaceAll: parsed.replaceAll,
    },
  });
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  sendCode(
    ctx,
    eid,
    [
      success(
        `Edited ${parsed.path} (${result.occurrences} occurrence${result.occurrences === 1 ? "" : "s"}).`,
      ),
      result.output,
      dim(`Review: code diff ${parsed.path}`),
    ]
      .filter(Boolean)
      .join("\n"),
    {
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      commands: [`code diff ${parsed.path}`, `code show ${artifact.id}`],
      content: artifact.content_text,
      event: "file_edited",
      paths: [parsed.path],
      sessionId: session.id,
      status: artifact.status,
      title: artifact.title,
      type: "file",
      workspace: session.workspace_root,
    },
  );
}

export async function writeWorkspaceFile(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  raw: string,
): Promise<void> {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  if (!enforceFileWriteGuard(ctx, eid, entity, session, "write")) return;
  const newlineIdx = raw.indexOf("\n");
  const path = (newlineIdx === -1 ? raw : raw.slice(0, newlineIdx)).trim();
  if (newlineIdx === -1 || !path) {
    ctx.send(eid, WRITE_USAGE);
    return;
  }
  const content = raw.slice(newlineIdx + 1);
  const workspace = workspaceForSession(deps, session) as WorkspaceRuntime &
    Partial<WorkspaceFileEdits>;
  if (typeof workspace.writeFile !== "function") {
    ctx.send(eid, "This workspace runtime does not support code write.");
    return;
  }
  const result = await workspace.writeFile(path, content);
  if (!result.ok) {
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "file_write_failed",
      payload: { path, output: result.output },
    });
    ctx.send(
      eid,
      [fmtError(`Write failed for ${path}.`), result.output].filter(Boolean).join("\n"),
    );
    return;
  }
  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: "file_write",
    title: `${result.created ? "Create" : "Overwrite"} ${path}`,
    status: "applied",
    contentText: content,
    metadata: { created: result.created, output: result.output, path },
    createdBy: entity.name,
  });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "file_written",
    payload: { id: artifact.id, created: result.created, path },
  });
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  sendCode(
    ctx,
    eid,
    [
      success(`${result.created ? "Created" : "Overwrote"} ${path}.`),
      result.output,
      dim(`Review: code read ${path}`),
    ]
      .filter(Boolean)
      .join("\n"),
    {
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      commands: [`code read ${path}`, `code show ${artifact.id}`],
      content: artifact.content_text,
      event: "file_written",
      paths: [path],
      sessionId: session.id,
      status: artifact.status,
      title: artifact.title,
      type: "file",
      workspace: session.workspace_root,
    },
  );
}

export function rejectPatch(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const parsed = parsePatchActionArgs(args);
  const artifact = resolvePatchArtifact(ctx, eid, deps.db, session.id, parsed.ref);
  if (!artifact) return;
  if (artifact.status !== "pending") {
    ctx.send(eid, `Patch ${artifact.id} is ${artifact.status}, not pending.`);
    return;
  }
  deps.db.updateCodingArtifact(artifact.id, { status: "rejected" });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "patch_rejected",
    payload: { id: artifact.id, reason: parsed.reason || undefined },
  });
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  sendCode(ctx, eid, success(`Patch rejected: ${artifact.id}`), {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    commands: [`code show ${artifact.id}`],
    event: "patch_rejected",
    paths: parseArtifactMetadata(artifact).paths,
    sessionId: session.id,
    status: "rejected",
    title: artifact.title,
    type: "patch",
  });
}

export async function checkpoint(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  titleArg: string,
): Promise<void> {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const workspace = workspaceForSession(deps, session);
  const result = await workspace.diff();
  const title = titleArg.trim() || "Workspace checkpoint";
  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: "checkpoint",
    title,
    status: "complete",
    contentText: result.content,
    metadata: { empty: result.content.trim().length === 0, exitCode: result.exitCode },
    createdBy: entity.name,
  });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "checkpoint_created",
    payload: { id: artifact.id, title, empty: result.content.trim().length === 0 },
  });
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  sendCode(ctx, eid, success(`Checkpoint stored: ${artifact.id}`), {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    commands: [`code show ${artifact.id}`, `code revert ${artifact.id}`],
    content: artifact.content_text,
    event: "checkpoint_created",
    exitCode: result.exitCode,
    sessionId: session.id,
    status: artifact.status,
    title: artifact.title,
    type: "diff",
    workspace: session.workspace_root,
  });
}

export async function revertCheckpoint(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  ref: string | undefined,
): Promise<void> {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  // Reverting a checkpoint writes the workspace — same single-writer gate.
  if (!enforceWriteLock(ctx, eid, entity, session)) return;
  if (!session.writer && !sameEntityName(session.created_by, entity.name)) {
    ctx.send(eid, "Only the session creator can revert checkpoints in this local workspace mode.");
    return;
  }
  const artifact = resolveKindArtifact(
    ctx,
    eid,
    deps.db,
    session.id,
    ref,
    "checkpoint",
    "last checkpoint",
  );
  if (!artifact) return;
  if (!artifact.content_text.trim()) {
    ctx.send(eid, `Checkpoint ${artifact.id} has no diff to reverse.`);
    return;
  }
  const workspace = workspaceForSession(deps, session);
  const result = await workspace.reversePatch(artifact.content_text);
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: result.ok ? "checkpoint_reverted" : "checkpoint_revert_failed",
    payload: { id: artifact.id, paths: result.paths, output: result.output },
  });
  if (!result.ok) {
    ctx.send(
      eid,
      [fmtError(`Checkpoint ${artifact.id} did not reverse cleanly.`), result.output].join("\n"),
    );
    return;
  }
  deps.db.updateCodingArtifact(artifact.id, {
    metadata: {
      ...parseJsonObject(artifact.metadata_json),
      revertedAt: Date.now(),
      revertedBy: entity.name,
    },
  });
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  sendCode(ctx, eid, success(`Checkpoint reverted: ${artifact.id}`), {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    commands: ["code diff", `code show ${artifact.id}`],
    event: "checkpoint_reverted",
    paths: result.paths,
    sessionId: session.id,
    status: artifact.status,
    title: artifact.title,
    type: "patch",
    workspace: session.workspace_root,
  });
}

function parsePatchProposal(raw: string):
  | { ok: true; title: string; patch: string }
  | {
      ok: false;
      error: string;
    } {
  const body = raw.trimStart();
  if (!body.trim()) {
    return {
      ok: false,
      error: "Usage: code patch [title]\\n<unified diff>",
    };
  }
  const firstNewline = body.indexOf("\n");
  if (firstNewline === -1) {
    return {
      ok: false,
      error: "Patch proposal must include a unified diff on following lines.",
    };
  }
  const firstLine = body.slice(0, firstNewline).trim();
  if (firstLine.startsWith("diff --git ") || firstLine.startsWith("--- ")) {
    return { ok: true, title: "Patch proposal", patch: ensureTrailingNewline(body) };
  }
  const patch = body.slice(firstNewline + 1).trimStart();
  if (!patch.trim()) {
    return { ok: false, error: "Patch proposal is missing diff content." };
  }
  return { ok: true, title: firstLine || "Patch proposal", patch: ensureTrailingNewline(patch) };
}
