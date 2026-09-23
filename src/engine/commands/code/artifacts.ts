// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { WorkspaceRuntime } from "../../../coding/local-workspace";
import { dim, header, separator, success } from "../../../net/ansi";
import type { CodingArtifactRow, CodingSessionRow, MarinaDB } from "../../../persistence/database";
import type { Entity, EntityId, RoomContext } from "../../../types";
import {
  type CodeDeps,
  capitalize,
  formatArtifactMeta,
  formatArtifactMetaLine,
  formatPaths,
  getCodeProfile,
  isFailureArtifact,
  latestFailureArtifact,
  latestSessionArtifact,
  parseArtifactMetadata,
  parseJsonObject,
  resolveSession,
  sendCode,
  updateCodeContext,
} from "./shared";
import { detectPackageScripts, recommendedVerify } from "./workspace";

export function patches(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[] = [],
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const statusFilter = args[0]?.toLowerCase();
  if (statusFilter && !["applied", "pending", "rejected"].includes(statusFilter)) {
    ctx.send(eid, "Usage: code patches [pending|applied|rejected]");
    return;
  }
  const artifacts = deps.db
    .listCodingArtifacts(session.id, 20)
    .filter(
      (artifact) =>
        artifact.kind === "patch" && (!statusFilter || artifact.status === statusFilter),
    );
  if (artifacts.length === 0) {
    ctx.send(
      eid,
      statusFilter
        ? `No ${statusFilter} patch proposals for this coding session.`
        : "No patch proposals for this coding session.",
    );
    return;
  }
  const lines = [
    header(statusFilter ? `Patches: ${statusFilter} (${session.id})` : `Patches: ${session.id}`),
    separator(),
  ];
  for (const artifact of artifacts) {
    const meta = parseArtifactMetadata(artifact);
    lines.push(
      `  ${artifact.id} ${dim(artifact.status)} ${artifact.title} ${dim(formatPaths(meta.paths))}`,
    );
  }
  sendCode(ctx, eid, lines.join("\n"), {
    commands: ["code show last patch", "code apply last patch", "code reject last patch"],
    event: "patches_listed",
    rows: artifacts.map((artifact) => {
      const meta = parseArtifactMetadata(artifact);
      return {
        detail: formatPaths(meta.paths),
        id: artifact.id,
        kind: artifact.kind,
        path: meta.paths[0],
        status: artifact.status,
        title: artifact.title,
        type: "patch",
      };
    }),
    sessionId: session.id,
    status: statusFilter,
    title: statusFilter ? `Patches: ${statusFilter}` : "Patches",
    type: "list",
    workspace: session.workspace_root,
  });
}

export function artifacts(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[] = [],
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const filter = parseArtifactListFilter(args);
  if (!filter.ok) {
    ctx.send(eid, filter.error);
    return;
  }
  const limit = filter.mode === "recent" ? 10 : 30;
  const artifacts = deps.db
    .listCodingArtifacts(session.id, 50)
    .filter((artifact) => artifactMatchesListFilter(artifact, filter))
    .slice(0, limit);
  if (artifacts.length === 0) {
    ctx.send(eid, formatNoArtifactsMessage(filter));
    return;
  }
  const lines = [header(`${formatArtifactListTitle(filter)} (${session.id})`), separator()];
  for (const artifact of artifacts) {
    const meta = parseArtifactMetadata(artifact);
    lines.push(
      `  ${artifact.id} ${dim(artifact.kind)} ${dim(artifact.status)} ${artifact.title} ${dim(formatArtifactMeta(meta))}`,
    );
  }
  sendCode(ctx, eid, lines.join("\n"), {
    commands: ["code show last", "code show last failed", "code artifacts failed", "code pin last"],
    event: "artifacts_listed",
    rows: artifacts.map((artifact) => {
      const meta = parseArtifactMetadata(artifact);
      return {
        detail: formatArtifactMeta(meta),
        id: artifact.id,
        kind: artifact.kind,
        status: artifact.status,
        title: artifact.title,
        type: "artifact",
      };
    }),
    sessionId: session.id,
    title: formatArtifactListTitle(filter),
    type: "list",
    workspace: session.workspace_root,
  });
}

export function showArtifact(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  id: string | undefined,
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const artifact = resolveSessionArtifact(ctx, eid, deps.db, session.id, id);
  if (!artifact) return;
  const meta = parseArtifactMetadata(artifact);
  sendCode(
    ctx,
    eid,
    [
      header(`${artifact.title} (${artifact.id})`),
      `Kind: ${artifact.kind}`,
      `Status: ${artifact.status}`,
      formatArtifactMetaLine(meta),
      separator(),
      artifact.content_text,
    ].join("\n"),
    {
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      command: meta.command.length > 0 ? meta.command : undefined,
      commands:
        artifact.kind === "patch" && artifact.status === "pending"
          ? [`code apply ${artifact.id}`, `code reject ${artifact.id}`]
          : [`code show ${artifact.id}`],
      content: artifact.content_text,
      durationMs: meta.durationMs,
      event: "artifact_shown",
      exitCode: meta.exitCode,
      paths: meta.paths,
      sessionId: session.id,
      status: artifact.status,
      timedOut: meta.timedOut,
      title: artifact.title,
      truncated: meta.truncated,
      type: artifact.kind === "patch" ? "patch" : "artifact",
    },
  );
}

export function lifecycleArtifact(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  ref: string | undefined,
  lifecycleStatus: "active" | "archived" | "pinned" | "superseded",
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const artifact = resolveSessionArtifact(ctx, eid, deps.db, session.id, ref);
  if (!artifact) return;
  if (artifact.kind === "patch" && artifact.status === "pending") {
    ctx.send(eid, "Pending patches must be applied or rejected before lifecycle status changes.");
    return;
  }
  const metadata = parseJsonObject(artifact.metadata_json);
  const previousLifecycle = typeof metadata.lifecycle === "string" ? metadata.lifecycle : undefined;
  if (
    previousLifecycle === "pinned" &&
    (lifecycleStatus === "archived" || lifecycleStatus === "superseded")
  ) {
    ctx.send(eid, `Artifact ${artifact.id} is pinned; unpin it before ${lifecycleStatus}.`);
    return;
  }
  const nextLifecycle = lifecycleStatus === "active" ? undefined : lifecycleStatus;
  deps.db.updateCodingArtifact(artifact.id, {
    metadata: {
      ...metadata,
      lifecycle: nextLifecycle,
      lifecycleAt: Date.now(),
      lifecycleBy: entity.name,
      previousLifecycle,
    },
  });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: `artifact_${lifecycleStatus}`,
    payload: {
      id: artifact.id,
      lifecycle: nextLifecycle ?? "active",
      previousLifecycle,
      status: artifact.status,
    },
  });
  const updated = deps.db.getCodingArtifact(artifact.id) ?? artifact;
  const updatedMeta = parseArtifactMetadata(updated);
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  const message =
    lifecycleStatus === "active"
      ? success(`Artifact unpinned: ${artifact.id}`)
      : success(`Artifact ${lifecycleStatus}: ${artifact.id}`);
  sendCode(ctx, eid, message, {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    commands: [`code show ${artifact.id}`, "code artifacts"],
    content: updated.content_text,
    event: lifecycleStatus === "active" ? "artifact_unpinned" : `artifact_${lifecycleStatus}`,
    sessionId: session.id,
    status: updated.status,
    title: updated.title,
    type: artifact.kind === "patch" ? "patch" : "artifact",
    workspace: session.workspace_root,
    rows: [
      {
        detail: updatedMeta.lifecycle ?? "active",
        id: artifact.id,
        kind: artifact.kind,
        status: updated.status,
        title: updated.title,
        type: "artifact",
      },
    ],
  });
}

export function approvals(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const items = deps.db
    .listCodingArtifacts(session.id, 50)
    .filter((artifact) => artifact.kind === "approval");
  if (items.length === 0) {
    ctx.send(eid, "No coding approvals for this session.");
    return;
  }
  const lines = [header("Coding Approvals"), separator()];
  for (const artifact of items) {
    const meta = parseJsonObject(artifact.metadata_json);
    lines.push(
      `  ${artifact.id} ${dim(artifact.status)} ${meta.kind ?? "approval"} ${artifact.title}`,
    );
  }
  sendCode(ctx, eid, lines.join("\n"), {
    commands: ["code approval request shell <description>", "code approve <id>", "code deny <id>"],
    event: "coding_approvals_listed",
    rows: items.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      status: artifact.status,
      title: artifact.title,
      type: "approval",
    })),
    sessionId: session.id,
    title: "Coding Approvals",
    type: "list",
    workspace: session.workspace_root,
  });
}

export function approval(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const action = args[0]?.toLowerCase();
  if (action === "request") {
    const kind = args[1]?.toLowerCase();
    const description = args.slice(2).join(" ").trim();
    if (!kind || !description) {
      ctx.send(
        eid,
        "Usage: code approval request <shell|network|secret|commit|spawn|other> <description>",
      );
      return;
    }
    const artifact = deps.db.createCodingArtifact({
      sessionId: session.id,
      kind: "approval",
      title: `Approval: ${kind}`,
      status: "pending",
      contentText: description,
      metadata: { kind, requestedBy: entity.name },
      createdBy: entity.name,
    });
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "coding_approval_requested",
      payload: { id: artifact.id, kind, description },
    });
    updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
    sendCode(ctx, eid, success(`Approval requested: ${artifact.id}`), {
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      commands: [`code approve ${artifact.id}`, `code deny ${artifact.id}`],
      content: description,
      event: "coding_approval_requested",
      metadata: { kind, requestedBy: entity.name },
      sessionId: session.id,
      status: artifact.status,
      title: artifact.title,
      type: "artifact",
      workspace: session.workspace_root,
    });
    return;
  }
  if (action === "list" || !action) {
    approvals(ctx, eid, entity, deps);
    return;
  }
  ctx.send(eid, "Usage: code approval [list|request]");
}

export function decideApproval(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  ref: string | undefined,
  status: "approved" | "denied",
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const artifact = resolveDecisionArtifact(ctx, eid, deps.db, session.id, ref);
  if (!artifact) return;
  if (artifact.status !== "pending") {
    ctx.send(eid, `${artifact.kind} ${artifact.id} is ${artifact.status}, not pending.`);
    return;
  }
  const decidedAt = Date.now();
  const decidedBy = entity.name;
  const priorMetadata = parseJsonObject(artifact.metadata_json);
  deps.db.updateCodingArtifact(artifact.id, {
    status,
    metadata: {
      ...priorMetadata,
      decidedAt,
      decidedBy,
    },
  });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: `coding_approval_${status}`,
    payload: { id: artifact.id },
  });
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  sendCode(ctx, eid, success(`Approval ${status}: ${artifact.id}`), {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    commands:
      artifact.kind === "spawn_request" && status === "approved"
        ? [`code spawn run ${artifact.id}`, `code show ${artifact.id}`]
        : [`code show ${artifact.id}`, "code approvals"],
    event: `coding_approval_${status}`,
    metadata: {
      ...priorMetadata,
      decidedAt,
      decidedBy,
      requestedBy: priorMetadata.requestedBy ?? artifact.created_by,
    },
    sessionId: session.id,
    status,
    title: artifact.title,
    type: "artifact",
    workspace: session.workspace_root,
  });
}

export function skill(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const action = args[0]?.toLowerCase() ?? "list";
  if (action === "add" || action === "store") {
    const name = args[1]?.toLowerCase();
    const text = args.slice(2).join(" ").trim();
    if (!name || !text) {
      ctx.send(eid, "Usage: code skill add <name> <instructions>");
      return;
    }
    const artifact = deps.db.createCodingArtifact({
      sessionId: session.id,
      kind: "code_skill",
      title: `Code skill: ${name}`,
      status: "active",
      contentText: text,
      metadata: { name, profile: getCodeProfile(entity).name },
      createdBy: entity.name,
    });
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "code_skill_added",
      payload: { id: artifact.id, name },
    });
    updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
    sendCode(ctx, eid, success(`Code skill stored: ${name} (${artifact.id})`), {
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      commands: [`code skill use ${name}`, `code show ${artifact.id}`],
      content: text,
      event: "code_skill_added",
      sessionId: session.id,
      status: artifact.status,
      title: artifact.title,
      type: "artifact",
      workspace: session.workspace_root,
    });
    return;
  }
  if (action === "use") {
    const name = args[1]?.toLowerCase();
    if (!name) {
      ctx.send(eid, "Usage: code skill use <name>");
      return;
    }
    const artifact = findNamedArtifact(deps.db, session.id, "code_skill", name);
    if (!artifact) {
      ctx.send(eid, `Code skill not found: ${name}`);
      return;
    }
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "code_skill_used",
      payload: { id: artifact.id, name },
    });
    sendCode(
      ctx,
      eid,
      `${success(`Code skill active for next work: ${name}`)}\n${artifact.content_text}`,
      {
        artifactId: artifact.id,
        artifactKind: artifact.kind,
        commands: [`code show ${artifact.id}`, "code plan <next step>"],
        content: artifact.content_text,
        event: "code_skill_used",
        sessionId: session.id,
        status: artifact.status,
        title: artifact.title,
        type: "skill",
        workspace: session.workspace_root,
      },
    );
    return;
  }
  if (action !== "list") {
    ctx.send(eid, "Usage: code skill [list|add|use]");
    return;
  }
  const skills = deps.db
    .listCodingArtifacts(session.id, 50)
    .filter((artifact) => artifact.kind === "code_skill" && artifact.status === "active");
  if (skills.length === 0) {
    ctx.send(eid, "No code-modal skills for this session.");
    return;
  }
  const lines = [header("Code Skills"), separator()];
  for (const artifact of skills) {
    const meta = parseJsonObject(artifact.metadata_json);
    lines.push(`  ${meta.name ?? artifact.id} ${dim(artifact.id)} ${artifact.title}`);
  }
  sendCode(ctx, eid, lines.join("\n"), {
    commands: ["code skill add <name> <instructions>", "code skill use <name>"],
    event: "code_skills_listed",
    rows: skills.map((artifact) => {
      const meta = parseJsonObject(artifact.metadata_json);
      return {
        id: artifact.id,
        title: typeof meta.name === "string" ? meta.name : artifact.title,
        detail: artifact.content_text,
        status: artifact.status,
        type: "skill",
      };
    }),
    sessionId: session.id,
    title: "Code Skills",
    type: "list",
    workspace: session.workspace_root,
  });
}

export function thread(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const artifacts = deps.db.listCodingArtifacts(session.id, 80);
  const important = artifacts.filter((artifact) =>
    [
      "plan",
      "decision",
      "summary",
      "handoff",
      "checkpoint",
      "verification",
      "patch",
      "approval",
      "crew_plan",
      "model_setting",
      "external_link",
    ].includes(artifact.kind),
  );
  if (important.length === 0) {
    ctx.send(eid, "No thread artifacts for this coding session yet.");
    return;
  }
  const lines = [header(`Code Thread: ${session.id}`), separator()];
  for (const artifact of important.slice(0, 20)) {
    lines.push(`  ${artifact.id} ${dim(artifact.kind)} ${dim(artifact.status)} ${artifact.title}`);
  }
  sendCode(ctx, eid, lines.join("\n"), {
    commands: ["code show <artifact_id>", "code artifacts", "code status"],
    event: "code_thread_shown",
    rows: important.slice(0, 20).map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      status: artifact.status,
      title: artifact.title,
      type: "artifact",
    })),
    sessionId: session.id,
    title: `Code Thread: ${session.id}`,
    type: "history",
    workspace: session.workspace_root,
  });
}

export function externalLink(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const action = args[0]?.toLowerCase() ?? "show";
  if (action === "link") {
    const system = args[1]?.toLowerCase();
    const externalId = args.slice(2).join(" ").trim();
    if (!system || !externalId) {
      ctx.send(eid, "Usage: code external link <acp|mcp|cursor|zed|vscode|other> <external_id>");
      return;
    }
    const artifact = deps.db.createCodingArtifact({
      sessionId: session.id,
      kind: "external_link",
      title: `External link: ${system}`,
      status: "active",
      contentText: `${system}: ${externalId}`,
      metadata: { system, externalId },
      createdBy: entity.name,
    });
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "external_session_linked",
      payload: { id: artifact.id, system, externalId },
    });
    updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
    sendCode(ctx, eid, success(`External coding link stored: ${system} ${externalId}`), {
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      commands: ["code external", `code show ${artifact.id}`],
      event: "external_session_linked",
      sessionId: session.id,
      status: artifact.status,
      title: artifact.title,
      type: "artifact",
      workspace: session.workspace_root,
    });
    return;
  }
  if (action === "unlink") {
    const ref = args.slice(1).join(" ");
    const artifact = resolveKindArtifact(
      ctx,
      eid,
      deps.db,
      session.id,
      ref,
      "external_link",
      "last external",
    );
    if (!artifact) return;
    deps.db.updateCodingArtifact(artifact.id, { status: "archived" });
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "external_session_unlinked",
      payload: { id: artifact.id },
    });
    updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
    ctx.send(eid, success(`External coding link archived: ${artifact.id}`));
    return;
  }
  if (action !== "show" && action !== "list") {
    ctx.send(eid, "Usage: code external [show|link|unlink]");
    return;
  }
  const links = deps.db
    .listCodingArtifacts(session.id, 50)
    .filter((artifact) => artifact.kind === "external_link" && artifact.status === "active");
  if (links.length === 0) {
    const lines = [
      header("External Coding Links"),
      separator(),
      "No external coding links for this session.",
      "",
      "Useful local link forms:",
      "  code external link acp <session-id>",
      "  code external link mcp <client-or-session-id>",
      "  code external link cursor <workspace-or-thread-id>",
      "  code external link vscode <workspace-or-thread-id>",
      "",
      dim("Links are durable handles. They do not bypass Marina permissions or routing."),
    ];
    sendCode(ctx, eid, lines.join("\n"), {
      commands: [
        `code external link acp ${session.id}`,
        `code external link mcp ${session.id}`,
        "code external link vscode <id>",
      ],
      event: "external_sessions_listed",
      rows: [
        { detail: "Agent Client Protocol session handle", title: "acp", type: "external_link" },
        {
          detail: "Model Context Protocol client/session handle",
          title: "mcp",
          type: "external_link",
        },
        { detail: "Editor or IDE workspace handle", title: "vscode", type: "external_link" },
      ],
      sessionId: session.id,
      title: "External Coding Links",
      type: "list",
      workspace: session.workspace_root,
    });
    return;
  }
  const lines = [header("External Coding Links"), separator()];
  for (const artifact of links) {
    lines.push(`  ${artifact.id} ${artifact.content_text}`);
  }
  sendCode(ctx, eid, lines.join("\n"), {
    commands: ["code external link acp <id>", "code external unlink <id>"],
    event: "external_sessions_listed",
    rows: links.map((artifact) => ({
      id: artifact.id,
      title: artifact.title,
      detail: artifact.content_text,
      status: artifact.status,
      type: "external_link",
    })),
    sessionId: session.id,
    title: "External Coding Links",
    type: "list",
    workspace: session.workspace_root,
  });
}

export function resolvePatchArtifact(
  ctx: RoomContext,
  eid: EntityId,
  db: MarinaDB,
  sessionId: string,
  id: string | undefined,
): CodingArtifactRow | null {
  if (!id) {
    ctx.send(eid, "Usage: code show|apply|reject <patch_id|last patch>");
    return null;
  }
  if (id.toLowerCase() === "last patch") {
    const latest = latestSessionArtifact(db, sessionId, "patch");
    if (!latest) {
      ctx.send(eid, "No patch proposals for this coding session.");
      return null;
    }
    return latest;
  }
  const artifact = db.getCodingArtifact(id);
  if (artifact?.kind !== "patch") {
    ctx.send(eid, `Patch not found: ${id}`);
    return null;
  }
  if (artifact.session_id !== sessionId) {
    ctx.send(eid, `Patch ${id} does not belong to the active coding session.`);
    return null;
  }
  return artifact;
}

function resolveSessionArtifact(
  ctx: RoomContext,
  eid: EntityId,
  db: MarinaDB,
  sessionId: string,
  id: string | undefined,
): CodingArtifactRow | null {
  if (!id) {
    ctx.send(eid, "Usage: code show <artifact_id|last|last patch|last failed>");
    return null;
  }
  const normalized = id.toLowerCase();
  if (normalized === "last" || normalized === "last artifact") {
    const latest = latestSessionArtifact(db, sessionId);
    if (!latest) {
      ctx.send(eid, "No artifacts for this coding session.");
      return null;
    }
    return latest;
  }
  if (normalized === "last patch") {
    const latest = latestSessionArtifact(db, sessionId, "patch");
    if (!latest) {
      ctx.send(eid, "No patch proposals for this coding session.");
      return null;
    }
    return latest;
  }
  if (normalized === "last failed" || normalized === "last failure") {
    const latest = latestFailureArtifact(db, sessionId);
    if (!latest) {
      ctx.send(eid, "No failed artifacts for this coding session.");
      return null;
    }
    return latest;
  }
  const artifact = db.getCodingArtifact(id);
  if (!artifact) {
    ctx.send(eid, `Artifact not found: ${id}`);
    return null;
  }
  if (artifact.session_id !== sessionId) {
    ctx.send(eid, `Artifact ${id} does not belong to the active coding session.`);
    return null;
  }
  return artifact;
}

function findNamedArtifact(
  db: MarinaDB,
  sessionId: string,
  kind: string,
  name: string,
): CodingArtifactRow | undefined {
  return db.listCodingArtifacts(sessionId, 80).find((artifact) => {
    if (artifact.kind !== kind || artifact.status === "archived") return false;
    const meta = parseJsonObject(artifact.metadata_json);
    return meta.name === name;
  });
}

export function findStoredRecipe(
  db: MarinaDB,
  sessionId: string,
  name: string,
): CodingArtifactRow | undefined {
  return findNamedArtifact(db, sessionId, "run_recipe", name);
}

export async function resolveRecipeCommands(
  db: MarinaDB,
  session: CodingSessionRow,
  workspace: WorkspaceRuntime,
  name: string,
): Promise<string[] | null> {
  if (name === "detected") {
    const packageJson = await workspace.read("package.json").catch(() => null);
    const scripts = packageJson ? detectPackageScripts(packageJson.content) : [];
    const commands = recommendedVerify(scripts);
    return commands.length > 0 ? commands : ["git diff --check"];
  }
  const stored = findStoredRecipe(db, session.id, name);
  if (!stored) {
    if (name === "default") return null;
    return null;
  }
  const meta = parseJsonObject(stored.metadata_json);
  const commands = Array.isArray(meta.commands) ? meta.commands.map(String).filter(Boolean) : [];
  return commands.length > 0 ? commands : null;
}

export function parseRecipeCommands(raw: string): string[] {
  return raw
    .split(/\s+then\s+|[|]/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function resolveKindArtifact(
  ctx: RoomContext,
  eid: EntityId,
  db: MarinaDB,
  sessionId: string,
  ref: string | undefined,
  kind: string,
  lastPhrase: string,
): CodingArtifactRow | null {
  const normalized = ref?.trim().toLowerCase();
  if (!normalized || normalized === "last" || normalized === lastPhrase) {
    const latest = latestSessionArtifact(db, sessionId, kind);
    if (!latest) {
      ctx.send(eid, `No ${kind} artifacts for this coding session.`);
      return null;
    }
    return latest;
  }
  const artifact = db.getCodingArtifact(ref!.trim());
  if (!artifact || artifact.kind !== kind) {
    ctx.send(eid, `${capitalize(kind.replace(/_/g, " "))} not found: ${ref}`);
    return null;
  }
  if (artifact.session_id !== sessionId) {
    ctx.send(eid, `Artifact ${artifact.id} does not belong to the active coding session.`);
    return null;
  }
  return artifact;
}

function resolveDecisionArtifact(
  ctx: RoomContext,
  eid: EntityId,
  db: MarinaDB,
  sessionId: string,
  ref: string | undefined,
): CodingArtifactRow | undefined {
  const normalized = ref?.trim();
  if (!normalized || normalized === "last" || normalized === "last approval") {
    const artifact = db
      .listCodingArtifacts(sessionId, 80)
      .find(
        (candidate) =>
          ["approval", "spawn_request"].includes(candidate.kind) && candidate.status === "pending",
      );
    if (!artifact) {
      ctx.send(eid, "No pending approvals or spawn requests for this coding session.");
      return undefined;
    }
    return artifact;
  }
  const artifact = db.getCodingArtifact(normalized);
  if (!artifact || !["approval", "spawn_request"].includes(artifact.kind)) {
    ctx.send(eid, `Approval or spawn request not found: ${normalized}`);
    return undefined;
  }
  if (artifact.session_id !== sessionId) {
    ctx.send(eid, `Artifact ${artifact.id} does not belong to the active coding session.`);
    return undefined;
  }
  return artifact;
}

export function parsePatchActionArgs(args: string[]): { ref: string | undefined; reason: string } {
  if (args[0]?.toLowerCase() === "last" && args[1]?.toLowerCase() === "patch") {
    return { ref: "last patch", reason: args.slice(2).join(" ") };
  }
  return { ref: args[0], reason: args.slice(1).join(" ") };
}

type ArtifactListFilter =
  | { ok: true; mode?: "failed" | "recent"; kind?: string; status?: string }
  | { ok: false; error: string };

function parseArtifactListFilter(args: string[]): ArtifactListFilter {
  const [action, value, extra] = args;
  if (!action) return { ok: true };
  const normalized = action.toLowerCase();
  if (normalized === "recent" && !value) return { ok: true, mode: "recent" };
  if ((normalized === "failed" || normalized === "failures") && !value) {
    return { ok: true, mode: "failed" };
  }
  if (normalized === "kind" && value && !extra) return { ok: true, kind: value };
  if (normalized === "status" && value && !extra) return { ok: true, status: value };
  return {
    ok: false,
    error: "Usage: code artifacts [recent|failed|status <status>|kind <artifact_kind>]",
  };
}

function artifactMatchesListFilter(
  artifact: CodingArtifactRow,
  filter: Extract<ArtifactListFilter, { ok: true }>,
): boolean {
  if (filter.kind && artifact.kind !== filter.kind) return false;
  if (filter.status && artifact.status !== filter.status) return false;
  if (filter.mode === "failed" && !isFailureArtifact(artifact)) return false;
  return true;
}

function formatArtifactListTitle(filter: Extract<ArtifactListFilter, { ok: true }>): string {
  if (filter.mode === "failed") return "Artifacts: failed";
  if (filter.mode === "recent") return "Artifacts: recent";
  if (filter.status) return `Artifacts: status ${filter.status}`;
  if (filter.kind) return `Artifacts: ${filter.kind}`;
  return "Artifacts";
}

function formatNoArtifactsMessage(filter: Extract<ArtifactListFilter, { ok: true }>): string {
  if (filter.mode === "failed") return "No failed artifacts for this coding session.";
  if (filter.mode === "recent") return "No recent artifacts for this coding session.";
  if (filter.status) return `No artifacts with status ${filter.status} for this coding session.`;
  if (filter.kind) return `No ${filter.kind} artifacts for this coding session.`;
  return "No artifacts for this coding session.";
}
