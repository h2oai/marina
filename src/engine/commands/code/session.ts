// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { basename } from "node:path";
import { clearSessionExecState } from "../../../coding/exec-approver";
import { bold, dim, header, separator, success } from "../../../net/ansi";
import type { CodingSessionRow, MarinaDB } from "../../../persistence/database";
import type { Entity, EntityId, RoomContext } from "../../../types";
import { reassignWriter } from "./crew";
import { formatProfileTry } from "./profiles";
import {
  ACTIVE_MODAL_KEY,
  ACTIVE_SESSION_KEY,
  CODE_CONTEXT_KEY,
  type CodeDeps,
  type CodeTreeNode,
  capitalize,
  formatCodingNoteTitle,
  formatCompletionTitle,
  getActiveSessionId,
  getCodeProfile,
  latestActiveArtifact,
  normalizeCodingNoteKind,
  normalizeSteeringArgs,
  parseEventPayload,
  parseJsonObject,
  resolveSession,
  sameEntityName,
  sendCode,
  updateCodeContext,
} from "./shared";
import { stopCodeStreamsFor } from "./stream";
import {
  cleanupSessionWorktree,
  getSelectedWorkspace,
  getSelectedWorkspaceRoot,
  getWorkspaceRegistry,
} from "./workspace";

export function enterCodeMode(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
): void {
  entity.properties[ACTIVE_MODAL_KEY] = "code";
  const sessionId = getActiveSessionId(entity);
  let session = sessionId ? deps.db.getCodingSession(sessionId) : null;
  if (!session) {
    // Resume across restarts: quit/eviction deletes the entity row (and with it
    // the coding_session_id pointer), but sessions persist keyed by creator
    // name — re-adopt the most recent still-active one so entering `code`
    // resumes prior work instead of starting from scratch.
    session =
      deps.db.listCodingSessions(entity.name, 12).find((row) => row.status === "active") ?? null;
    if (session) entity.properties[ACTIVE_SESSION_KEY] = session.id;
  }
  updateCodeContext(entity, deps.db, session ?? undefined);
  const profile = getCodeProfile(entity);
  const registry = getWorkspaceRegistry(deps);
  const selectedRoot = session?.workspace_root ?? getSelectedWorkspaceRoot(entity, deps);

  // Evaluate the current directory on entry — a quick top-level listing so it's
  // clear Code Mode is looking at the workspace (orient now, act on the task).
  let overview = "";
  try {
    const entries = registry.workspaceForRoot(selectedRoot).list(".", 14);
    if (entries.length > 0) {
      const names = entries.map((e) => (e.type === "dir" ? `${e.path}/` : e.path));
      overview = `Contents: ${dim(names.join("  "))}`;
    }
  } catch {
    // Unlistable root (permissions / missing) — skip the overview, not fatal.
  }

  sendCode(
    ctx,
    eid,
    [
      success("Code Mode active."),
      `Profile: ${profile.name} ${dim(`prompt: ${profile.prompt}>`)}`,
      `Workspace: ${selectedRoot}${registry.usesCwdFallback ? dim(" (process cwd fallback)") : ""}`,
      overview,
      session ? `Session: ${session.id} ${dim(session.status)}` : dim("No active session yet."),
      "",
      bold("Just say what you want done") +
        dim(' — e.g. "add a health check endpoint and a test for it".'),
      dim("A coding agent will explore, edit, and run checks autonomously. Or use commands:"),
      dim(`  ${formatProfileTry(profile)} | code crew <goal> | onboard | exit`),
      registry.usesCwdFallback ? dim("Configure MARINA_CODE_ROOTS for production workspaces.") : "",
    ]
      .filter(Boolean)
      .join("\n"),
    {
      event: "code_mode_entered",
      ...(session
        ? {
            sessionCreatedAt: session.created_at,
            sessionId: session.id,
            status: session.status,
            title: session.title,
          }
        : {}),
      type: "modal",
      workspace: selectedRoot,
    },
  );
}

export async function exitCodeMode(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
): Promise<void> {
  const activeId = getActiveSessionId(entity);
  const session = activeId ? deps.db.getCodingSession(activeId) : null;
  if (entity.properties[ACTIVE_MODAL_KEY] === "code") {
    delete entity.properties[ACTIVE_MODAL_KEY];
    delete entity.properties[CODE_CONTEXT_KEY];
    deps.db.saveEntity(entity);
  }
  stopCodeStreamsFor(eid); // stop forwarding the bound agent's activity
  const lines = [success("Exited Code Mode.")];
  if (session) {
    const note = await cleanupSessionWorktree(deps, entity, session);
    if (note) lines.push(note);
  }
  ctx.send(eid, lines.join("\n"));
}

export function startSession(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  titleArg: string,
): void {
  const workspace = getSelectedWorkspace(entity, deps);
  const registry = getWorkspaceRegistry(deps);
  const title = titleArg.trim() || `${basename(workspace.displayRoot())} coding session`;
  const session = deps.db.createCodingSession({
    id: `code_${crypto.randomUUID().slice(0, 12)}`,
    title,
    workspaceRoot: workspace.displayRoot(),
    createdBy: entity.name,
  });
  entity.properties[ACTIVE_SESSION_KEY] = session.id;
  updateCodeContext(entity, deps.db, session);
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "session_started",
    payload: { title: session.title, workspaceRoot: session.workspace_root },
  });

  sendCode(
    ctx,
    eid,
    [
      success(`Coding session started: ${session.id}`),
      `Title: ${session.title}`,
      `Workspace: ${session.workspace_root}`,
      registry.usesCwdFallback
        ? dim(
            "Workspace is the process cwd fallback. Use code workspace use <path> or MARINA_CODE_ROOTS for production.",
          )
        : "",
      dim("Try: code files | code search <query> | code read <path> | code diff"),
    ]
      .filter(Boolean)
      .join("\n"),
    {
      commands: ["code files", "code search <query>", "code read <path>", "code diff"],
      event: "session_started",
      sessionId: session.id,
      status: session.status,
      title: session.title,
      type: "session",
      workspace: session.workspace_root,
    },
  );
}

export function branchSession(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  titleArg: string,
): void {
  const parent = resolveSession(ctx, eid, entity, deps.db);
  if (!parent) return;
  const title = titleArg.trim() || `${parent.title} branch`;
  const session = deps.db.createCodingSession({
    id: `code_${crypto.randomUUID().slice(0, 12)}`,
    title,
    workspaceRoot: parent.workspace_root,
    createdBy: entity.name,
  });
  if (parent.execution_target !== "local") {
    deps.db.updateCodingSession(session.id, { executionTarget: parent.execution_target });
    session.execution_target = parent.execution_target;
  }
  entity.properties[ACTIVE_SESSION_KEY] = session.id;
  updateCodeContext(entity, deps.db, session);
  deps.db.createCodingEvent({
    sessionId: parent.id,
    actor: entity.name,
    kind: "session_branch_created",
    payload: { childSessionId: session.id, title: session.title },
  });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "session_branched",
    payload: { parentSessionId: parent.id, parentTitle: parent.title },
  });

  sendCode(
    ctx,
    eid,
    [
      success(`Coding session branched: ${session.id}`),
      `Parent: ${parent.id}`,
      `Title: ${session.title}`,
      `Workspace: ${session.workspace_root}`,
      dim("Use: code tree | code status | code files"),
    ].join("\n"),
    {
      commands: ["code tree", "code status", "code files"],
      event: "session_branched",
      parentSessionId: parent.id,
      sessionId: session.id,
      status: session.status,
      title: session.title,
      type: "session",
      workspace: session.workspace_root,
    },
  );
}

export function listSessions(ctx: RoomContext, eid: EntityId, entity: Entity, db: MarinaDB): void {
  const sessions = db.listCodingSessions(entity.name, 12);
  if (sessions.length === 0) {
    ctx.send(eid, 'No coding sessions. Start one with "code start".');
    return;
  }
  const active = getActiveSessionId(entity);
  const lines = [header("Coding Sessions"), separator()];
  for (const s of sessions) {
    const mark = s.id === active ? "*" : " ";
    lines.push(
      `${mark} ${s.id} ${dim(s.status)} ${s.title} ${dim(new Date(s.updated_at).toLocaleString())}`,
    );
  }
  sendCode(ctx, eid, lines.join("\n"), {
    commands: ["code status", "code resume <session_id>", "code tree"],
    event: "sessions_listed",
    rows: sessions.map((session) => ({
      id: session.id,
      status: session.status,
      title: session.title,
      type: session.id === active ? "active_session" : "session",
    })),
    title: "Coding Sessions",
    type: "list",
  });
}

export function treeSessions(ctx: RoomContext, eid: EntityId, entity: Entity, db: MarinaDB): void {
  const sessions = db.listCodingSessions(entity.name, 50);
  if (sessions.length === 0) {
    ctx.send(eid, 'No coding sessions. Start one with "code start".');
    return;
  }
  const active = getActiveSessionId(entity);
  const children = new Map<string, string[]>();
  const parentByChild = new Map<string, string>();
  for (const session of sessions) {
    for (const event of db.listCodingEvents(session.id, 100)) {
      const payload = parseEventPayload(event);
      if (event.kind === "session_branched" && typeof payload.parentSessionId === "string") {
        parentByChild.set(session.id, payload.parentSessionId);
      }
      if (event.kind === "session_branch_created" && typeof payload.childSessionId === "string") {
        const list = children.get(session.id) ?? [];
        list.push(payload.childSessionId);
        children.set(session.id, list);
      }
    }
  }
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const roots = sessions.filter((session) => !parentByChild.has(session.id));
  const lines = [header("Coding Session Tree"), separator()];
  const toNode = (session: CodingSessionRow): CodeTreeNode => ({
    active: session.id === active,
    children: (children.get(session.id) ?? [])
      .map((childId) => byId.get(childId))
      .filter((child): child is CodingSessionRow => Boolean(child))
      .map(toNode),
    id: session.id,
    status: session.status,
    title: session.title,
  });
  const visit = (session: CodingSessionRow, depth: number) => {
    const mark = session.id === active ? "*" : " ";
    lines.push(
      `${"  ".repeat(depth)}${mark} ${session.id} ${dim(session.status)} ${session.title}`,
    );
    for (const childId of children.get(session.id) ?? []) {
      const child = byId.get(childId);
      if (child) visit(child, depth + 1);
    }
  };
  for (const root of roots) visit(root, 0);
  sendCode(ctx, eid, lines.join("\n"), {
    commands: ["code branch <title>", "code resume <session_id>", "code status"],
    event: "session_tree",
    sessionId: active,
    tree: roots.map(toNode),
    type: "tree",
  });
}

export function resumeSession(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  id: string | undefined,
): void {
  if (!id) {
    ctx.send(eid, "Usage: code resume <session_id>");
    return;
  }
  const session = deps.db.getCodingSession(id);
  if (!session) {
    ctx.send(eid, `Coding session not found: ${id}`);
    return;
  }
  // Ownership gate: only the session creator or its own bound coding agent may
  // adopt a session. Without this, any entity could point coding_session_id at a
  // loopback-sovereign's exec-mode session and ride its exec authorization
  // (which keys on session.created_by) — a confused-deputy path to arbitrary
  // host execution. Fail closed.
  if (
    !sameEntityName(session.created_by, entity.name) &&
    !sameEntityName(session.agent, entity.name)
  ) {
    ctx.send(
      eid,
      "You can only resume a coding session you created or are the bound coding agent for.",
    );
    return;
  }
  entity.properties[ACTIVE_SESSION_KEY] = session.id;
  updateCodeContext(entity, deps.db, session);
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "session_resumed",
    payload: {},
  });
  sendCode(ctx, eid, success(`Active coding session: ${session.id}`), {
    commands: ["code status", "code files", "code history"],
    event: "session_resumed",
    sessionId: session.id,
    status: session.status,
    title: session.title,
    type: "session",
    workspace: session.workspace_root,
  });
}

export function sessionTask(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  rawTitle: string,
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const title = rawTitle.trim();
  if (!title) {
    ctx.send(eid, "Usage: code task <title>");
    return;
  }
  const taskId = deps.db.createTask({
    title,
    description: `from coding session ${session.id}`,
    creatorId: entity.id,
    creatorName: entity.name,
  });
  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: "session_task",
    title: `Linked task: ${title}`,
    status: "active",
    contentText: `Task #${taskId}: ${title}\n\nLinked from coding session ${session.id}.`,
    metadata: { taskId, title },
    createdBy: entity.name,
  });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "coding_task_linked",
    payload: { id: artifact.id, taskId, title },
  });
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  sendCode(ctx, eid, success(`Linked task #${taskId}: ${title}`), {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    commands: [`code show ${artifact.id}`, "code status", "code history"],
    content: artifact.content_text,
    event: "coding_task_linked",
    metadata: { taskId, title },
    rows: [{ id: String(taskId), detail: title, status: "open", title, type: "task" }],
    sessionId: session.id,
    status: artifact.status,
    title: artifact.title,
    type: "artifact",
    workspace: session.workspace_root,
  });
}

export function modelSetting(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const action = args[0]?.toLowerCase() ?? "show";
  if (action === "set") {
    const target = args.slice(1).join(" ").trim();
    if (!target) {
      ctx.send(eid, "Usage: code model set <provider/model|agent|crew|direct>");
      return;
    }
    for (const previous of deps.db
      .listCodingArtifacts(session.id, 50)
      .filter((artifact) => artifact.kind === "model_setting" && artifact.status === "active")) {
      deps.db.updateCodingArtifact(previous.id, { status: "superseded" });
    }
    const artifact = deps.db.createCodingArtifact({
      sessionId: session.id,
      kind: "model_setting",
      title: `Code model: ${target}`,
      status: "active",
      contentText: `Code model target: ${target}`,
      metadata: { target, profile: getCodeProfile(entity).name },
      createdBy: entity.name,
    });
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "code_model_set",
      payload: { id: artifact.id, target },
    });
    updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
    sendCode(ctx, eid, success(`Code model target set: ${target}`), {
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      commands: ["code model", "code ask <request>"],
      event: "code_model_set",
      modelTarget: target,
      sessionId: session.id,
      status: artifact.status,
      title: artifact.title,
      type: "model",
      workspace: session.workspace_root,
    });
    return;
  }
  if (action === "clear") {
    for (const previous of deps.db
      .listCodingArtifacts(session.id, 50)
      .filter((artifact) => artifact.kind === "model_setting" && artifact.status === "active")) {
      deps.db.updateCodingArtifact(previous.id, { status: "superseded" });
    }
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "code_model_cleared",
      payload: {},
    });
    updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
    ctx.send(eid, success("Code model target cleared."));
    return;
  }
  const current = latestActiveArtifact(deps.db, session.id, "model_setting");
  const meta = current ? parseJsonObject(current.metadata_json) : {};
  const target = typeof meta.target === "string" ? meta.target : "default Marina code route";
  sendCode(ctx, eid, `${header("Code Model")}\n${separator()}\nTarget: ${target}`, {
    artifactId: current?.id,
    artifactKind: current?.kind,
    commands: ["code model set <target>", "code model clear"],
    event: "code_model_shown",
    modelTarget: target,
    sessionId: session.id,
    status: current?.status,
    title: "Code Model",
    type: "model",
    workspace: session.workspace_root,
  });
}

export function status(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  id?: string,
): void {
  const session = resolveSession(ctx, eid, entity, deps.db, id);
  if (!session) return;
  const events = deps.db.listCodingEvents(session.id, 5);
  const artifacts = deps.db.listCodingArtifacts(session.id, 50);
  const latestArtifact = artifacts[0];
  const model = latestActiveArtifact(deps.db, session.id, "model_setting");
  const modelMeta = model ? parseJsonObject(model.metadata_json) : {};
  const modelTarget =
    typeof modelMeta.target === "string" ? modelMeta.target : "default Marina code route";
  const pendingPatches = artifacts.filter(
    (artifact) => artifact.kind === "patch" && artifact.status === "pending",
  );
  updateCodeContext(entity, deps.db, session);
  const lines = [
    header("Coding Session"),
    separator(),
    `ID: ${session.id}`,
    `Title: ${session.title}`,
    `Status: ${session.status}`,
    `Mode: ${session.mode}`,
    `Execution target: ${session.execution_target}`,
    `Model target: ${modelTarget}`,
    `Workspace: ${session.workspace_root}`,
    `Latest artifact: ${latestArtifact ? `${latestArtifact.id} (${latestArtifact.kind}, ${latestArtifact.status})` : dim("none")}`,
    `Pending patches: ${pendingPatches.length}`,
    `Updated: ${new Date(session.updated_at).toLocaleString()}`,
  ];
  if (events.length > 0) {
    lines.push("", header("Recent Events"));
    for (const ev of events.slice(-5)) {
      lines.push(`  ${new Date(ev.created_at).toLocaleTimeString()} ${ev.kind} ${dim(ev.actor)}`);
    }
  }
  sendCode(ctx, eid, lines.join("\n"), {
    commands: ["code history", "code artifacts", "code patches"],
    event: "session_status",
    events: events.slice(-5).map((ev) => ({
      actor: ev.actor,
      kind: ev.kind,
      payload: ev.payload_json,
      timestamp: ev.created_at,
    })),
    modelTarget,
    rows: [
      { id: session.id, status: session.status, title: session.title, type: "session" },
      { detail: session.mode, title: "Mode", type: "field" },
      { detail: modelTarget, title: "Model target", type: "field" },
      { path: session.workspace_root, title: "Workspace", type: "field" },
      ...(latestArtifact
        ? [
            {
              id: latestArtifact.id,
              kind: latestArtifact.kind,
              status: latestArtifact.status,
              title: latestArtifact.title,
              type: "artifact",
            },
          ]
        : []),
      {
        detail: String(pendingPatches.length),
        status: pendingPatches.length > 0 ? "pending" : "clear",
        title: "Pending patches",
        type: "field",
      },
    ],
    sessionId: session.id,
    status: session.status,
    title: session.title,
    type: "session",
    workspace: session.workspace_root,
  });
}

export function history(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  id?: string,
): void {
  const session = resolveSession(ctx, eid, entity, deps.db, id);
  if (!session) return;
  const events = deps.db.listCodingEvents(session.id, 40);
  const lines = [header(`Coding History: ${session.id}`), separator()];
  for (const ev of events) {
    lines.push(
      `  ${new Date(ev.created_at).toLocaleString()} ${ev.kind} ${dim(ev.actor)} ${dim(ev.payload_json)}`,
    );
  }
  sendCode(ctx, eid, lines.join("\n"), {
    commands: ["code status", "code artifacts", "code patches"],
    event: "history_shown",
    events: events.map((ev) => ({
      actor: ev.actor,
      kind: ev.kind,
      payload: ev.payload_json,
      timestamp: ev.created_at,
    })),
    sessionId: session.id,
    title: `Coding History: ${session.id}`,
    type: "history",
    workspace: session.workspace_root,
  });
}

export function steer(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const text = normalizeSteeringArgs(args);
  if (!text) {
    ctx.send(eid, "Usage: code steer <direction>");
    return;
  }
  const profile = getCodeProfile(entity);
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "session_steered",
    payload: { text, profile: profile.name },
  });
  sendCode(ctx, eid, success(`Steering recorded: ${text}`), {
    commands: ["code status", "code history"],
    content: text,
    event: "session_steered",
    sessionId: session.id,
    title: "Steering",
    type: "note",
    workspace: session.workspace_root,
  });
}

export function observe(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const text = args.join(" ").trim();
  if (!text) {
    ctx.send(eid, "Usage: code observe <what you observed>");
    return;
  }
  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: "observation",
    title: formatCodingNoteTitle("observation", text),
    status: "complete",
    contentText: text,
    metadata: { profile: getCodeProfile(entity).name },
    createdBy: entity.name,
  });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "observation_recorded",
    payload: { id: artifact.id, text },
  });
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  sendCode(ctx, eid, success(`Observation stored: ${artifact.id}`), {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    commands: [`code show ${artifact.id}`, "code status"],
    content: text,
    event: "observation_recorded",
    sessionId: session.id,
    status: artifact.status,
    title: artifact.title,
    type: "note",
    workspace: session.workspace_root,
  });
}

export async function completeSession(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  summary: string,
): Promise<void> {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const text = summary.trim() || "Session completed.";
  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: "completion",
    title: formatCompletionTitle(text),
    status: "complete",
    contentText: text,
    metadata: { profile: getCodeProfile(entity).name },
    createdBy: entity.name,
  });
  deps.db.updateCodingSession(session.id, { status: "complete", mode: "done" });
  // A closed session must not leave live exec grants behind: drop its
  // approve-always allow-set and deny any still-pending exec prompts.
  clearSessionExecState(session.id);
  // Persist the closing summary into the bound project pool (if any) + a
  // personal note, so the session's takeaways outlive the ephemeral artifacts.
  if (summary.trim()) depositSessionSummary(deps, entity, session, text);
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "session_completed",
    payload: { artifactId: artifact.id, summary: text },
  });
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  const worktreeNote = await cleanupSessionWorktree(deps, entity, session);
  sendCode(
    ctx,
    eid,
    [
      success(`Coding session completed: ${session.id}`),
      `Artifact: ${artifact.id}`,
      worktreeNote ?? "",
      dim("Use: code show last | code tree | code branch <title>"),
    ]
      .filter(Boolean)
      .join("\n"),
    {
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      commands: ["code show last", "code tree", "code branch <title>"],
      content: text,
      event: "session_completed",
      sessionId: session.id,
      status: "complete",
      title: artifact.title,
      type: "session",
    },
  );
}

/**
 * Resolve a memory pool bound to this coding session, if any. Binding is by
 * convention: a project whose name matches the session workspace basename and
 * carries a pool_id. Returns undefined when nothing is bound (degrade silently).
 */
function resolveSessionPoolId(
  deps: CodeDeps & { db: MarinaDB },
  session: CodingSessionRow,
): string | undefined {
  const projectName = basename(session.workspace_root);
  const project = deps.db.getProjectByName(projectName);
  return project?.pool_id ?? undefined;
}

/**
 * Deposit a session summary into the bound project pool (when present) AND a
 * personal note. Both writes are best-effort — failures never block the
 * session flow. Returns the pool id when a pool deposit happened.
 */
function depositSessionSummary(
  deps: CodeDeps & { db: MarinaDB },
  entity: Entity,
  session: CodingSessionRow,
  text: string,
): string | undefined {
  const content = `[coding ${session.id}] ${text}`;
  try {
    deps.db.createNote(entity.name, content, undefined, { noteType: "summary" });
  } catch {
    // Personal note is best-effort.
  }
  const poolId = resolveSessionPoolId(deps, session);
  if (!poolId) return undefined;
  try {
    deps.db.addPoolNote(poolId, entity.name, content, undefined, "summary");
    return poolId;
  } catch {
    return undefined;
  }
}

export function recordCodingNote(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  kind: string,
  args: string[],
): void {
  const noteKind = normalizeCodingNoteKind(kind);
  if (!noteKind) {
    ctx.send(eid, "Usage: code plan|summary|handoff|decision <text>");
    return;
  }
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  // `code handoff <notes> [to <agent>]` — when `to <agent>` is present, transfer
  // the write lock to that agent in addition to writing the handoff artifact.
  let handoffTo: string | undefined;
  let noteArgs = args;
  if (noteKind === "handoff") {
    const toIdx = args.findIndex((a) => a.toLowerCase() === "to");
    if (toIdx >= 0 && args[toIdx + 1]) {
      handoffTo = args[toIdx + 1];
      noteArgs = args.slice(0, toIdx);
    }
  }
  const text = noteArgs.join(" ").trim();
  if (!text) {
    ctx.send(eid, `Usage: code ${noteKind} <text>${noteKind === "handoff" ? " [to <agent>]" : ""}`);
    return;
  }

  const profile = getCodeProfile(entity);
  // Handoffs link to the active dispatched crew when one exists, so a reader of
  // the handoff can find who picked up the work. Minimal, best-effort.
  const noteMetadata: Record<string, unknown> = { profile: profile.name };
  if (noteKind === "handoff") {
    const activeCrew = latestActiveArtifact(deps.db, session.id, "crew_dispatched");
    if (activeCrew) noteMetadata.sourceArtifactId = activeCrew.id;
    if (handoffTo) noteMetadata.handoffTo = handoffTo;
  }
  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: noteKind,
    title: formatCodingNoteTitle(noteKind, text),
    status: "complete",
    contentText: text,
    metadata: noteMetadata,
    createdBy: entity.name,
  });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: `${noteKind}_recorded`,
    payload: { id: artifact.id, text, profile: profile.name },
  });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "session_steered",
    payload: { text, profile: profile.name, artifactId: artifact.id, artifactKind: noteKind },
  });
  // A summary is the durable session takeaway — deposit it into the bound
  // project pool (when present) and a personal note. Degrades silently.
  if (noteKind === "summary") depositSessionSummary(deps, entity, session, text);
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  // `code handoff <notes> to <agent>` transfers the write lock alongside the
  // handoff artifact. Re-read the row so reassignWriter sees the freshest writer.
  if (noteKind === "handoff" && handoffTo) {
    const fresh = deps.db.getCodingSession(session.id) ?? session;
    reassignWriter(ctx, eid, entity, deps, fresh, handoffTo, "handoff");
  }
  sendCode(ctx, eid, success(`${capitalize(noteKind)} stored: ${artifact.id}`), {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    commands: [`code show ${artifact.id}`, "code status", "code history"],
    content: text,
    event: `${noteKind}_recorded`,
    sessionId: session.id,
    status: artifact.status,
    title: artifact.title,
    type: "note",
    workspace: session.workspace_root,
  });
}
