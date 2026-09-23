// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { CodingProjectManager, PROJECT_ARCHIVE_FORMAT } from "../../../coding/project-manager";
import { header, success } from "../../../net/ansi";
import type { CodingSessionRow, MarinaDB } from "../../../persistence/database";
import type { Entity, EntityId, RoomContext } from "../../../types";
import { type CodeDeps, resolveSession, sendCode } from "./shared";
import { workspaceForSession } from "./workspace";

/** Everything a `projectLifecycle` step needs, resolved once per invocation. */
interface ProjectCall {
  ctx: RoomContext;
  eid: EntityId;
  entity: Entity;
  deps: CodeDeps & { db: MarinaDB };
  args: string[];
  session: CodingSessionRow;
  manager: CodingProjectManager;
}

export async function projectLifecycle(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): Promise<void> {
  if (!deps.flywheel) {
    ctx.send(eid, "Flywheel is not configured; sandbox projects are unavailable.");
    return;
  }
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const manager = new CodingProjectManager(
    deps.db,
    workspaceForSession(deps, session),
    deps.flywheel,
  );
  const action = args[0]?.toLowerCase() ?? "status";

  const call: ProjectCall = { ctx, eid, entity, deps, args, session, manager };

  if (action === "list") {
    projectList(call);
    return;
  }

  if (action === "init") {
    await projectInit(call);
    return;
  }

  if (action === "clone") {
    await projectClone(call);
    return;
  }

  if (action === "switch") {
    await projectSwitch(call);
    return;
  }

  if (action === "export") {
    await projectExport(call);
    return;
  }

  if (action === "import") {
    await projectImport(call);
    return;
  }

  if (action === "delete") {
    await projectDelete(call);
    return;
  }

  if (action === "reconcile") {
    projectReconcile(call);
    return;
  }

  if (action === "diff") {
    await projectDiff(call);
    return;
  }

  if (action === "status") {
    await projectStatus(call);
    return;
  }

  ctx.send(
    eid,
    "Usage: code project init|clone|import|status|list|diff|switch|export [archive]|delete|reconcile",
  );
}

function projectList(call: ProjectCall): void {
  const { ctx, eid, deps, session, manager } = call;
  const active = manager.active(eid);
  const projects = deps.db.listCodingProjects(eid);
  sendCode(
    ctx,
    eid,
    projects.length
      ? projects
          .map(
            (project) =>
              `${project.id === active?.id ? "*" : " "} ${project.name}  ${project.source_type}  ${project.guest_path}`,
          )
          .join("\n")
      : "No sandbox projects.",
    {
      event: "projects_listed",
      rows: projects.map((project) => ({
        id: project.id,
        kind: project.source_type,
        path: project.guest_path,
        status: project.id === active?.id ? "active" : undefined,
        title: project.name,
        type: "project",
      })),
      sessionId: session.id,
      title: "Sandbox Projects",
      type: "list",
    },
  );
  return;
}

async function projectInit(call: ProjectCall): Promise<void> {
  const { ctx, eid, entity, deps, args, session, manager } = call;
  if (!args[1]) throw new Error("Usage: code project init <name>");
  const project = await manager.init(eid, args[1]);
  recordProjectEvent(deps.db, session, entity, "project_initialized", project);
  sendCode(ctx, eid, success(`Project ${project.name} initialized at ${project.guest_path}`), {
    event: "project_initialized",
    sessionId: session.id,
    status: "active",
    title: project.name,
    type: "lifecycle",
    workspace: project.guest_path,
  });
  return;
}

async function projectClone(call: ProjectCall): Promise<void> {
  const { ctx, eid, entity, deps, args, session, manager } = call;
  if (!args[1]) throw new Error("Usage: code project clone <public-https-url> [name]");
  const project = await manager.clone(eid, args[1], args[2]);
  recordProjectEvent(deps.db, session, entity, "project_cloned", project);
  sendCode(ctx, eid, success(`Project ${project.name} cloned at ${project.guest_path}`), {
    event: "project_cloned",
    metadata: { source: project.source_locator },
    sessionId: session.id,
    status: "active",
    title: project.name,
    type: "lifecycle",
    workspace: project.guest_path,
  });
  return;
}

async function projectSwitch(call: ProjectCall): Promise<void> {
  const { ctx, eid, entity, deps, args, session, manager } = call;
  if (!args[1]) throw new Error("Usage: code project switch <id|name>");
  const project = await manager.switch(eid, args[1]);
  recordProjectEvent(deps.db, session, entity, "project_switched", project);
  sendCode(ctx, eid, success(`Active project: ${project.name}`), {
    event: "project_switched",
    sessionId: session.id,
    status: "active",
    title: project.name,
    type: "lifecycle",
    workspace: project.guest_path,
  });
  return;
}

async function projectExport(call: ProjectCall): Promise<void> {
  const { ctx, eid, entity, deps, args, session, manager } = call;
  if (args[1]?.toLowerCase() === "archive") {
    const exported = await manager.exportArchive(eid);
    const artifact = deps.db.createCodingArtifact({
      sessionId: session.id,
      kind: "project_archive",
      title: `Archive: ${exported.project.name}`,
      status: "complete",
      contentText: Buffer.from(exported.data).toString("base64"),
      metadata: {
        branch: exported.status.branch,
        byteLength: exported.data.length,
        encoding: "base64",
        expandedBytes: exported.manifest.expandedBytes,
        format: PROJECT_ARCHIVE_FORMAT,
        guestPath: exported.project.guest_path,
        mediaType: "application/gzip",
        memberCount: exported.manifest.memberCount,
        projectId: exported.project.id,
        revision: exported.status.revision,
        sha256: exported.sha256,
      },
      createdBy: entity.name,
    });
    recordProjectEvent(deps.db, session, entity, "project_archive_exported", exported.project, {
      artifactId: artifact.id,
      byteLength: exported.data.length,
    });
    sendCode(ctx, eid, success(`Complete project archive stored as ${artifact.id}`), {
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      event: "project_archive_exported",
      sessionId: session.id,
      status: "complete",
      title: artifact.title,
      type: "artifact",
      workspace: exported.project.guest_path,
    });
    return;
  }
  const exported = await manager.exportPatch(eid);
  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: "project_export",
    title: `Export: ${exported.project.name}`,
    status: "complete",
    contentText: exported.content,
    metadata: {
      branch: exported.status.branch,
      guestPath: exported.project.guest_path,
      projectId: exported.project.id,
      revision: exported.status.revision,
      sourceLocator: exported.project.source_locator,
      sourceType: exported.project.source_type,
    },
    createdBy: entity.name,
  });
  recordProjectEvent(deps.db, session, entity, "project_exported", exported.project, {
    artifactId: artifact.id,
  });
  sendCode(ctx, eid, success(`Project export stored as ${artifact.id}`), {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    event: "project_exported",
    sessionId: session.id,
    status: "complete",
    title: artifact.title,
    type: "artifact",
    workspace: exported.project.guest_path,
  });
  return;
}

async function projectImport(call: ProjectCall): Promise<void> {
  const { ctx, eid, entity, deps, args, session, manager } = call;
  if (!args[1] || !args[2]) {
    throw new Error("Usage: code project import <project_archive_artifact> <name>");
  }
  const artifact = deps.db.getCodingArtifact(args[1]);
  if (!artifact || artifact.session_id !== session.id || artifact.kind !== "project_archive") {
    throw new Error("Project import requires a project_archive artifact from this session.");
  }
  const metadata = JSON.parse(artifact.metadata_json) as {
    byteLength?: unknown;
    encoding?: unknown;
    format?: unknown;
    sha256?: unknown;
  };
  if (metadata.encoding !== "base64" || metadata.format !== PROJECT_ARCHIVE_FORMAT) {
    throw new Error("Project archive format or encoding is invalid.");
  }
  const archiveData = Uint8Array.from(Buffer.from(artifact.content_text, "base64"));
  const archiveDigest = new Bun.CryptoHasher("sha256").update(archiveData).digest("hex");
  if (metadata.byteLength !== archiveData.length || metadata.sha256 !== archiveDigest) {
    throw new Error("Project archive artifact failed byte-count/digest verification.");
  }
  const project = await manager.importArchive(eid, args[2], archiveData);
  recordProjectEvent(deps.db, session, entity, "project_archive_imported", project, {
    artifactId: artifact.id,
  });
  sendCode(ctx, eid, success(`Project ${project.name} imported at ${project.guest_path}`), {
    artifactId: artifact.id,
    event: "project_archive_imported",
    sessionId: session.id,
    status: "active",
    title: project.name,
    type: "lifecycle",
    workspace: project.guest_path,
  });
  return;
}

async function projectDelete(call: ProjectCall): Promise<void> {
  const { ctx, eid, entity, deps, args, session, manager } = call;
  if (!args[1]) throw new Error("Usage: code project delete <id|name> [discard] confirm");
  const discard = args[2]?.toLowerCase() === "discard";
  const confirmed = discard
    ? args[3]?.toLowerCase() === "confirm"
    : args[2]?.toLowerCase() === "confirm";
  if (!confirmed) {
    throw new Error("Project deletion requires literal confirmation: [discard] confirm");
  }
  const project = await manager.delete(eid, args[1], { discard });
  recordProjectEvent(deps.db, session, entity, "project_deleted", project, { discard });
  sendCode(ctx, eid, success(`Project ${project.name} deleted from its guest sandbox.`), {
    event: "project_deleted",
    sessionId: session.id,
    status: "deleted",
    title: project.name,
    type: "lifecycle",
  });
  return;
}

function projectReconcile(call: ProjectCall): void {
  const { ctx, eid, entity, deps, session, manager } = call;
  const result = manager.reconcile(eid);
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "project_metadata_reconciled",
    payload: { removedProjectIds: result.removed },
  });
  sendCode(
    ctx,
    eid,
    result.removed.length
      ? success(`Removed ${result.removed.length} stale project record(s).`)
      : "Project metadata already matches the active sandbox.",
    {
      event: "project_metadata_reconciled",
      sessionId: session.id,
      status: result.removed.length ? "changed" : "clean",
      title: "Project Reconciliation",
      type: "lifecycle",
    },
  );
  return;
}

async function projectDiff(call: ProjectCall): Promise<void> {
  const { ctx, eid, entity, deps, session, manager } = call;
  const inspected = await manager.diff(eid);
  const warning = inspected.diff.untrackedPaths.length
    ? `\n\nUntracked files (not represented above):\n${inspected.diff.untrackedPaths.join("\n")}`
    : "";
  const content = `${inspected.diff.content || "No tracked changes."}${warning}`;
  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: "project_diff",
    title: `Diff: ${inspected.project.name}`,
    status: "complete",
    contentText: content,
    metadata: {
      branch: inspected.diff.status.branch,
      dirty: inspected.diff.status.dirty,
      guestPath: inspected.project.guest_path,
      projectId: inspected.project.id,
      revision: inspected.diff.status.revision,
      untrackedPaths: inspected.diff.untrackedPaths,
    },
    createdBy: entity.name,
  });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "project_diff_inspected",
    payload: { artifactId: artifact.id, projectId: inspected.project.id },
  });
  sendCode(ctx, eid, content, {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    event: "project_diff_inspected",
    sessionId: session.id,
    status: inspected.diff.status.dirty ? "dirty" : "clean",
    title: artifact.title,
    type: "diff",
    workspace: inspected.project.guest_path,
  });
  return;
}

async function projectStatus(call: ProjectCall): Promise<void> {
  const { ctx, eid, deps, session, manager } = call;
  const project = manager.active(eid);
  if (!project) throw new Error("No active project. Use `code project init|clone` first.");
  const status = await manager.status(eid, project);
  const refreshed = deps.db.getCodingProject(project.id) ?? project;
  sendCode(
    ctx,
    eid,
    [
      header(project.name),
      `ID: ${project.id}`,
      `Source: ${project.source_type}${project.source_locator ? ` (${project.source_locator})` : ""}`,
      `Guest path: ${project.guest_path}`,
      `Branch: ${status.branch ?? "unborn"}`,
      `Revision: ${status.revision ?? "no commits"}`,
      `Working tree: ${status.dirty ? "dirty" : "clean"}`,
      `Export state: ${refreshed.has_unexported_changes ? "unexported changes" : "safe"}`,
      status.output,
    ].join("\n"),
    {
      event: "project_status",
      metadata: { dirty: status.dirty, projectId: project.id, revision: status.revision },
      sessionId: session.id,
      status: status.dirty ? "dirty" : "clean",
      title: project.name,
      type: "readiness",
      workspace: project.guest_path,
    },
  );
  return;
}

function recordProjectEvent(
  db: MarinaDB,
  session: CodingSessionRow,
  entity: Entity,
  kind: string,
  project: { id: string; guest_path: string; name: string; source_type: string },
  extra: Record<string, unknown> = {},
): void {
  db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind,
    payload: {
      ...extra,
      guestPath: project.guest_path,
      projectId: project.id,
      projectName: project.name,
      sourceType: project.source_type,
    },
  });
}
