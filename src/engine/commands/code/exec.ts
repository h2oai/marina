// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  type ExecApprover,
  type ExecAuditSink,
  getPendingExecApproval,
  HeadlessGateApprover,
  InteractiveApprover,
  OPERATOR_APPROVED_REASON,
  renderArgv,
  settleExecApproval,
} from "../../../coding/exec-approver";
import type { WorkspaceRunResult, WorkspaceRuntime } from "../../../coding/local-workspace";
import { summarizeFlywheelEvents, WorkspaceGateway } from "../../../coding/workspace-gateway";
import { dim, error as fmtError, header, separator, success } from "../../../net/ansi";
import type { CodingArtifactRow, CodingSessionRow, MarinaDB } from "../../../persistence/database";
import type { Connection, Entity, EntityId, RoomContext } from "../../../types";
import { getRank } from "../../permissions";
import { recordDemonstration } from "../../safety-gates";
import { isLocalUngated } from "../../trust-profile";
import {
  findStoredRecipe,
  parseRecipeCommands,
  resolveRecipeCommands,
  showArtifact,
} from "./artifacts";
import {
  type CodeDeps,
  entityNameForm,
  getCodeProfile,
  parseJsonObject,
  resolveSession,
  sameEntityName,
  sendCode,
  updateCodeContext,
} from "./shared";
import { detectPackageScripts, recommendedVerify, workspaceForSession } from "./workspace";

export async function runWorkspaceCommand(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): Promise<void> {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  if (args.length === 0) {
    ctx.send(eid, "Usage: code run <typecheck|lint|test|build|dashboard:build|bun ...|git ...>");
    return;
  }
  if (args[0]?.toLowerCase() === "allowlist") {
    await showRunAllowlist(ctx, eid, session, workspaceForSession(deps, session));
    return;
  }
  if (args[0]?.toLowerCase() === "app") {
    await runApp(ctx, eid, entity, deps, session, args[1]);
    return;
  }

  const command = normalizeCodeRunArgs(args);
  const { artifact, result } = await executeWorkspaceCommand(entity, deps, session, command);
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);

  sendCode(ctx, eid, formatRunOutput(artifact.id, result), {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    command: result.command,
    commands: [`code show ${artifact.id}`, `code run ${result.command.join(" ")}`],
    content: result.output,
    durationMs: result.durationMs,
    event: "command_ran",
    exitCode: result.exitCode,
    sessionId: session.id,
    status: artifact.status,
    timedOut: result.timedOut,
    truncated: result.truncated,
    type: "command",
  });
}

async function showRunAllowlist(
  ctx: RoomContext,
  eid: EntityId,
  session: CodingSessionRow,
  workspace: WorkspaceRuntime,
): Promise<void> {
  if (session.execution_target === "flywheel") {
    sendCode(
      ctx,
      eid,
      [
        header("Code Run Policy"),
        separator(),
        "Execution target: Flywheel sandbox",
        "Policy: guest-open finite commands under code.exec governance",
        dim("Commands are passed as argument arrays through a fixed audited wrapper."),
        dim("There is no host fallback. Use code service start for managed background processes."),
      ].join("\n"),
      {
        commands: ["code run <command>", "code verify", "code sandbox local"],
        event: "run_allowlist_shown",
        sessionId: session.id,
        title: "Flywheel Run Policy",
        type: "list",
        workspace: session.workspace_root,
      },
    );
    return;
  }
  const policy = workspace.runPolicy();
  const packageJson = await workspace.read("package.json").catch(() => null);
  const scripts = packageJson ? detectPackageScripts(packageJson.content) : [];
  const detected = new Set(scripts);
  const lines = [
    header("Code Run Allowlist"),
    separator(),
    `Workspace: ${session.workspace_root}`,
    `Timeout: ${policy.timeoutMs}ms`,
    "",
    header("Allowed By Host Policy"),
    ...policy.commands.map((command) => {
      const script = command.startsWith("bun run ") ? command.slice("bun run ".length) : "";
      const suffix = script ? (detected.has(script) ? dim(" detected") : dim(" not detected")) : "";
      return `  ${command}${suffix}`;
    }),
    "",
    `Detected package scripts: ${scripts.length > 0 ? scripts.join(", ") : dim("none")}`,
    "",
    dim("Host-local mode rejects shell metacharacters, absolute binary paths, and path escapes."),
  ];
  sendCode(ctx, eid, lines.join("\n"), {
    commands: ["code run test", "code run git status --short", "code verify"],
    event: "run_allowlist_shown",
    rows: policy.commands.map((command) => ({
      detail: command.startsWith("bun run ")
        ? detected.has(command.slice("bun run ".length))
          ? "detected"
          : "not detected"
        : "host policy",
      status: command.startsWith("bun run ")
        ? detected.has(command.slice("bun run ".length))
          ? "detected"
          : "not detected"
        : "allowed",
      title: command,
      type: command.startsWith("git ") ? "git_command" : "bun_command",
    })),
    sessionId: session.id,
    title: "Code Run Allowlist",
    type: "list",
    workspace: session.workspace_root,
  });
}

async function runApp(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  session: CodingSessionRow,
  requestedScript?: string,
): Promise<void> {
  const script = requestedScript?.trim();
  const sandboxTarget = session.execution_target === "flywheel";
  const message = [
    sandboxTarget
      ? "Use the managed service lifecycle for long-running sandbox applications."
      : fmtError("code run app is disabled in host local mode."),
    script ? `Requested script: ${script}` : "",
    sandboxTarget
      ? `Start: code service start <name> --port <port> -- bun run ${script || "dev"}`
      : "Long-running package scripts do not execute on the Marina host; configure Flywheel and use code service start.",
    dim("Use code verify for finite checks and code service for VM-resident processes."),
  ]
    .filter(Boolean)
    .join("\n");
  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: "app_run_denial",
    title: script ? `App run denied: ${script}` : "App run denied",
    status: "denied",
    contentText: message,
    metadata: {
      containerRequired: !sandboxTarget,
      profile: getCodeProfile(entity).name,
      reason: sandboxTarget ? "managed-service-required" : "host-local-mode",
      requestedScript: script || undefined,
    },
    createdBy: entity.name,
  });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "app_run_denied",
    payload: {
      id: artifact.id,
      reason: sandboxTarget ? "managed-service-required" : "host-local-mode",
      requestedScript: script || null,
    },
  });
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);

  sendCode(ctx, eid, `${message}\n${dim(`artifact: ${artifact.id}`)}`, {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    commands: [`code show ${artifact.id}`, "code observe <note>", "code verify"],
    content: message,
    event: "app_run_denied",
    rows: [
      {
        id: artifact.id,
        kind: artifact.kind,
        status: artifact.status,
        title: artifact.title,
        type: "artifact",
      },
    ],
    sessionId: session.id,
    status: artifact.status,
    title: artifact.title,
    type: "artifact",
    workspace: session.workspace_root,
  });
}

export async function recipe(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): Promise<void> {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const action = args[0]?.toLowerCase() ?? "list";
  if (action === "save" || action === "set") {
    const name = args[1]?.toLowerCase();
    const body = args.slice(2).join(" ").trim();
    if (!name || !body) {
      ctx.send(eid, "Usage: code recipe save <name> <command> [then <command>...]");
      return;
    }
    const commands = parseRecipeCommands(body);
    if (commands.length === 0) {
      ctx.send(
        eid,
        "Recipe needs at least one command, for example: code recipe save quick typecheck then lint",
      );
      return;
    }
    const artifact = deps.db.createCodingArtifact({
      sessionId: session.id,
      kind: "run_recipe",
      title: `Recipe: ${name}`,
      status: "active",
      contentText: commands.join("\n"),
      metadata: { name, commands, profile: getCodeProfile(entity).name },
      createdBy: entity.name,
    });
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "run_recipe_saved",
      payload: { id: artifact.id, name, commands },
    });
    updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
    sendCode(ctx, eid, success(`Recipe saved: ${name} (${artifact.id})`), {
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      commands: [`code recipe run ${name}`, `code show ${artifact.id}`],
      content: artifact.content_text,
      event: "run_recipe_saved",
      rows: commands.map((command) => ({ title: command, type: "command" })),
      sessionId: session.id,
      status: artifact.status,
      title: artifact.title,
      type: "verification",
      workspace: session.workspace_root,
    });
    return;
  }
  if (action === "run") {
    const name = args[1]?.toLowerCase();
    if (!name) {
      ctx.send(eid, "Usage: code recipe run <name>");
      return;
    }
    const commands = await resolveRecipeCommands(
      deps.db,
      session,
      workspaceForSession(deps, session),
      name,
    );
    if (!commands) {
      ctx.send(eid, `Recipe not found: ${name}`);
      return;
    }
    await runVerificationCommands(ctx, eid, entity, deps, session, commands, `Recipe ${name}`);
    return;
  }
  if (action === "show") {
    const name = args[1]?.toLowerCase();
    if (!name) {
      ctx.send(eid, "Usage: code recipe show <name>");
      return;
    }
    const found = findStoredRecipe(deps.db, session.id, name);
    if (!found) {
      ctx.send(eid, `Stored recipe not found: ${name}`);
      return;
    }
    showArtifact(ctx, eid, entity, deps, found.id);
    return;
  }
  if (action !== "list") {
    ctx.send(eid, "Usage: code recipe [list|save|show|run]");
    return;
  }
  const workspace = workspaceForSession(deps, session);
  const packageJson = await workspace.read("package.json").catch(() => null);
  const scripts = packageJson ? detectPackageScripts(packageJson.content) : [];
  const detected = recommendedVerify(scripts);
  const stored = deps.db
    .listCodingArtifacts(session.id, 50)
    .filter((artifact) => artifact.kind === "run_recipe" && artifact.status === "active");
  const lines = [header("Code Recipes"), separator()];
  lines.push(
    `Detected verify: ${detected.length > 0 ? detected.join(" then ") : "git diff --check"}`,
  );
  for (const artifact of stored) {
    const meta = parseJsonObject(artifact.metadata_json);
    const name = typeof meta.name === "string" ? meta.name : artifact.title;
    const commands = Array.isArray(meta.commands) ? meta.commands.map(String) : [];
    lines.push(`  ${name}: ${commands.join(" then ")}`);
  }
  sendCode(ctx, eid, lines.join("\n"), {
    commands: ["code recipe save quick typecheck then lint", "code recipe run detected"],
    event: "run_recipes_listed",
    rows: [
      { id: "detected", title: "detected", detail: detected.join(" then "), type: "recipe" },
      ...stored.map((artifact) => {
        const meta = parseJsonObject(artifact.metadata_json);
        return {
          id: artifact.id,
          title: typeof meta.name === "string" ? meta.name : artifact.title,
          detail: artifact.content_text.replace(/\n/g, " then "),
          status: artifact.status,
          type: "recipe",
        };
      }),
    ],
    sessionId: session.id,
    title: "Code Recipes",
    type: "list",
    workspace: session.workspace_root,
  });
}

export async function verifyWorkspace(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
): Promise<void> {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;

  const workspace = workspaceForSession(deps, session);
  const commands = (await resolveRecipeCommands(deps.db, session, workspace, "default")) ??
    (session.execution_target === "local"
      ? await resolveRecipeCommands(deps.db, session, workspace, "detected")
      : null) ?? ["git diff --check"];

  await runVerificationCommands(ctx, eid, entity, deps, session, commands, "Verification");
}

async function runVerificationCommands(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  session: CodingSessionRow,
  commands: string[],
  titlePrefix: string,
): Promise<void> {
  const results: StoredCommandResult[] = [];
  for (const commandText of commands) {
    const command = normalizeCodeRunArgs(commandText.split(/\s+/).filter(Boolean));
    const stored = await executeWorkspaceCommand(entity, deps, session, command);
    results.push(stored);
    if (stored.result.exitCode !== 0 || stored.result.timedOut) break;
  }

  const failed = results.find((item) => item.result.exitCode !== 0 || item.result.timedOut);
  const status = failed ? "failed" : "complete";
  const summary = formatVerificationSummary(results);
  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: "verification",
    title: failed ? `${titlePrefix} failed` : `${titlePrefix} passed`,
    status,
    contentText: summary,
    metadata: {
      commands: results.map((item) => item.result.command),
      artifactIds: results.map((item) => item.artifact.id),
      exitCode: failed?.result.exitCode ?? 0,
      stoppedAt: failed?.result.command,
    },
    createdBy: entity.name,
  });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "verification_ran",
    payload: {
      id: artifact.id,
      status,
      commands: results.map((item) => item.result.command),
      artifactIds: results.map((item) => item.artifact.id),
    },
  });
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);

  sendCode(ctx, eid, `${summary}\n${dim(`verification artifact: ${artifact.id}`)}`, {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    commands: ["code show last", "code verify"],
    content: summary,
    event: "verification_ran",
    exitCode: failed?.result.exitCode ?? 0,
    sessionId: session.id,
    status,
    type: "verification",
  });
}

interface StoredCommandResult {
  artifact: CodingArtifactRow;
  result: WorkspaceRunResult;
}

async function executeWorkspaceCommand(
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  session: CodingSessionRow,
  command: string[],
): Promise<StoredCommandResult> {
  const workspace = workspaceForSession(deps, session);
  // Arbitrary (non-allowlisted) host exec is fenced by an optional approver,
  // attached per-call to the local workspace only. Off the allowlist, the
  // workspace consults it; with none attached, behavior is allowlist-only.
  if (session.execution_target === "local") {
    workspace.attachExecApprover?.(selectExecApprover(entity, deps, session), entity.id);
  }
  const execution = await new WorkspaceGateway(workspace, deps.flywheel).run(
    entity.id,
    session.execution_target,
    command,
    120_000,
    session.execution_target === "flywheel"
      ? (deps.db.listFlywheelBindings().find((row) => row.entity_id === entity.id)?.guest_cwd ??
          undefined)
      : undefined,
  );
  const { result } = execution;
  const commandText = result.command.join(" ");
  const flywheelEventKinds = execution.flywheelEvents
    ? summarizeFlywheelEvents(execution.flywheelEvents)
    : undefined;
  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: "command_output",
    title: `$ ${commandText}`,
    status: result.exitCode === 0 && !result.timedOut ? "complete" : "failed",
    contentText: result.output,
    metadata: {
      command: result.command,
      exitCode: result.exitCode,
      truncated: result.truncated,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      executionTarget: execution.target,
      flywheelEventKinds,
      cwd:
        session.execution_target === "flywheel"
          ? deps.db.listFlywheelBindings().find((row) => row.entity_id === entity.id)?.guest_cwd
          : undefined,
    },
    createdBy: entity.name,
  });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "command_ran",
    payload: {
      id: artifact.id,
      command: result.command,
      exitCode: result.exitCode,
      truncated: result.truncated,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      executionTarget: execution.target,
      flywheelEventKinds,
    },
  });
  return { artifact, result };
}

// ─── Arbitrary-exec approver wiring ──────────────────────────────────────────

const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

// Per-session interactive exec mode ("prompt"/"auto"). In-memory only, never
// persisted — a restart drops it and exec returns to allowlist-only.
const execModes = new Map<string, "prompt" | "auto">();

/**
 * Exported for tests: the exec/loopback TRUST anchor. Consults ONLY the real,
 * unspoofable socket peer (`conn.peerIp`) plus the in-process/internal flag —
 * never the header-derived `conn.ip`.
 */
export function isLoopbackConnection(conn: Connection | undefined): boolean {
  if (!conn) return false;
  if (conn.protocol === "telnet") return false; // never trust telnet as loopback
  if (conn.internal) return true; // in-process trusted connections
  // TRUST ANCHOR: consult ONLY the real, unspoofable socket peer address (peerIp),
  // NEVER conn.ip (header-derived X-Forwarded-For / X-Real-IP — client can forge it
  // to claim 127.0.0.1). A remote WebSocket peer sending `X-Forwarded-For: 127.0.0.1`
  // sets conn.ip but not conn.peerIp, so this stays false. Undefined peerIp (real
  // peer unknown) fails closed.
  const ip = conn.peerIp;
  if (!ip) return false;
  return LOOPBACK_IPS.has(ip) || ip.startsWith("127.") || ip.startsWith("::ffff:127.");
}

/**
 * Resolve a session's creator by EXACT, sanitize-normalized name equality —
 * never the fuzzy prefix matcher (`findEntityGlobal`). A resolved entity is
 * accepted only when its name sanitize-equals `session.created_by`, so an
 * attacker whose name prefixes the creator's cannot be mistaken for them.
 * Returns undefined when no exact match exists (fail closed).
 */
function resolveCreatorExact(deps: CodeDeps, session: CodingSessionRow): Entity | undefined {
  const resolver = deps.findEntityExact ?? deps.findEntityByName;
  const creator = resolver?.(session.created_by) ?? resolver?.(entityNameForm(session.created_by));
  if (!creator) return undefined;
  return sameEntityName(creator.name, session.created_by) ? creator : undefined;
}

/**
 * Server-side, independent verification (never trust the launcher's word) that
 * a session's creator is a local sovereign operator on a loopback connection.
 * Gates whether an `exec-mode` request is honored. Creator resolution is EXACT
 * (not prefix) so a name-prefix spoof cannot pose as the loopback sovereign.
 */
function verifyInteractiveEligible(deps: CodeDeps, session: CodingSessionRow): boolean {
  const creator = resolveCreatorExact(deps, session);
  if (!creator || getRank(creator) < 9) return false;
  return isLoopbackConnection(deps.getConnection?.(creator.id));
}

/** Audit sink — one durable `exec_decision` artifact + event per attempt. */
function makeExecAudit(
  deps: CodeDeps & { db: MarinaDB },
  session: CodingSessionRow,
): ExecAuditSink {
  return (req, decision, meta) => {
    const rendered = renderArgv(req.argv);
    const artifact = deps.db.createCodingArtifact({
      sessionId: session.id,
      kind: "exec_decision",
      title: `${decision.approved ? "Approved" : "Denied"} exec: ${rendered}`,
      status: decision.approved ? "complete" : "denied",
      contentText: rendered,
      metadata: {
        argv: req.argv,
        cwd: req.cwd,
        entityId: req.entityId,
        approved: decision.approved,
        scope: decision.scope,
        reason: decision.reason,
        mode: meta.mode,
        interactive: meta.interactive,
        humanApproved: meta.humanApproved,
      },
      createdBy: session.created_by,
    });
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: req.entityId,
      kind: "exec_decision",
      payload: {
        id: artifact.id,
        approved: decision.approved,
        argv: req.argv,
        mode: meta.mode,
        interactive: meta.interactive,
        reason: decision.reason ?? null,
      },
    });
    // A supervised (human-approved) interactive arbitrary exec is a witnessed
    // demonstration toward code.exec.unrestricted — this is how an entity earns
    // the unsupervised competence the headless path later requires. ONLY a
    // genuine per-command human prompt approval qualifies: auto-mode approvals
    // and session-allow-set replays set humanApproved=false and never mint
    // competence toward the highest-blast-radius gate.
    if (meta.humanApproved) {
      recordDemonstration(deps.db, req.entityId, "code.exec.unrestricted");
    }
  };
}

/**
 * Pick the arbitrary-exec approver for this local run, or `undefined` (→
 * allowlist-only). Interactive wins when the launcher enabled `exec-mode` AND
 * the server verifies a loopback sovereign creator; otherwise the headless
 * approver is offered whenever MARINA_CODE_EXEC_UNRESTRICTED lists any entity.
 */
function selectExecApprover(
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  session: CodingSessionRow,
): ExecApprover | undefined {
  // Participant gate: an approver is attached ONLY when the ACTING entity is
  // legitimately part of this session — the creator, or the session's own bound
  // coding agent (dispatched by that creator). A stranger who merely pointed
  // coding_session_id at this session id gets NO approver (→ allowlist-only),
  // closing the confused-deputy path where a non-creator rides the creator's
  // exec authorization. The human-approval prompt still targets the creator.
  const actingIsCreator = sameEntityName(session.created_by, entity.name);
  const actingIsBoundAgent = !!session.agent && sameEntityName(session.agent, entity.name);
  if (!actingIsCreator && !actingIsBoundAgent) return undefined;

  // LOCAL trust profile: arbitrary host commands run without a prompt (mode
  // `auto`) unless the launcher chose otherwise; the exec_decision audit row
  // is still written for every attempt.
  const mode = execModes.get(session.id) ?? (isLocalUngated() ? "auto" : undefined);
  if (mode && deps.notify && verifyInteractiveEligible(deps, session)) {
    const creator = resolveCreatorExact(deps, session);
    return new InteractiveApprover({
      sessionId: session.id,
      creatorEntityId: creator?.id ?? session.created_by,
      creatorName: session.created_by,
      mode,
      notify: deps.notify,
      audit: makeExecAudit(deps, session),
      timeoutMs: deps.execApprovalTimeoutMs,
    });
  }
  const allow = deps.execUnrestrictedAllow ?? [];
  if (allow.length > 0) {
    return new HeadlessGateApprover({
      db: deps.db,
      entityName: entity.name,
      allowList: allow,
      authRequired: deps.authRequired ?? false,
      // Per-connection trust: resolve the ACTING entity's own live connection and
      // require it to be genuinely local (loopback IP / in-process). This does
      // NOT consult WS_HOST — so an accidentally-0.0.0.0-bound server that a
      // remote peer reaches never yields headless exec, even if WS_HOST lies.
      actingConnectionTrusted: (entityId) => isLoopbackConnection(deps.getConnection?.(entityId)),
      audit: makeExecAudit(deps, session),
    });
  }
  return undefined;
}

/** `code exec-mode <prompt|auto|off>` — launcher opt-in, server re-verified. */
export function execModeCommand(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  // Enabling or changing exec-mode is a creator/operator-only privilege. The
  // interactive launcher issues `code exec-mode prompt|auto` on the HUMAN
  // operator's own connection (actor == creator), so the human path is
  // unaffected. A session's bound coding agent (or any non-creator) is refused
  // here — otherwise the agent could self-enable auto-approval and ride the
  // creator's loopback-sovereign standing for unattended arbitrary host exec.
  if (!sameEntityName(session.created_by, entity.name)) {
    ctx.send(eid, "Only the session's operator can change exec-mode.");
    return;
  }
  const mode = args[0]?.toLowerCase();
  if (mode === "off" || mode === "none" || mode === "disable") {
    execModes.delete(session.id);
    ctx.send(eid, success("Code exec-mode disabled (allowlist only)."));
    return;
  }
  if (mode !== "prompt" && mode !== "auto") {
    ctx.send(eid, "Usage: code exec-mode <prompt|auto|off>");
    return;
  }
  // Honor prompt/auto ONLY when the server independently verifies a local
  // sovereign creator on a loopback connection — never the client's word alone.
  if (!verifyInteractiveEligible(deps, session)) {
    ctx.send(
      eid,
      "Exec-mode requires a loopback sovereign session creator; request refused. Exec stays allowlist-only.",
    );
    return;
  }
  execModes.set(session.id, mode);
  ctx.send(
    eid,
    success(
      `Code exec-mode: ${mode}. Non-allowlisted commands will ${
        mode === "auto" ? "run (audited, no prompt)" : "prompt the session creator"
      }.`,
    ),
  );
}

/** `code exec-approve <token> [once]` — session creator only, rank 0. */
export function execApprove(ctx: RoomContext, eid: EntityId, entity: Entity, args: string[]): void {
  const token = args[0];
  if (!token) {
    ctx.send(eid, "Usage: code exec-approve <token> [once]");
    return;
  }
  const pending = getPendingExecApproval(token);
  if (!pending) {
    ctx.send(eid, `No pending exec approval: ${token}`);
    return;
  }
  // Identity-checked, not rank-gated: only the session creator may resolve.
  if (!sameEntityName(pending.creatorName, entity.name)) return;
  const scope = args[1]?.toLowerCase() === "once" ? "once" : "session";
  // Stamp the human-decision provenance so the audit sink counts this — and only
  // this — as a witnessed demonstration toward code.exec.unrestricted.
  settleExecApproval(token, { approved: true, scope, reason: OPERATOR_APPROVED_REASON });
  ctx.send(eid, success(`Approved exec ${token} (${scope}).`));
}

/** `code exec-deny <token> [reason]` — session creator only, rank 0. */
export function execDeny(ctx: RoomContext, eid: EntityId, entity: Entity, args: string[]): void {
  const token = args[0];
  if (!token) {
    ctx.send(eid, "Usage: code exec-deny <token> [reason]");
    return;
  }
  const pending = getPendingExecApproval(token);
  if (!pending) {
    ctx.send(eid, `No pending exec approval: ${token}`);
    return;
  }
  if (!sameEntityName(pending.creatorName, entity.name)) return;
  const reason = args.slice(1).join(" ").trim() || "denied by operator";
  settleExecApproval(token, { approved: false, reason });
  ctx.send(eid, success(`Denied exec ${token}.`));
}

function normalizeCodeRunArgs(args: string[]): string[] {
  const shorthand = args[0]?.toLowerCase();
  if (
    args.length === 1 &&
    shorthand &&
    ["build", "dashboard:build", "lint", "test", "typecheck"].includes(shorthand)
  ) {
    return ["bun", "run", shorthand];
  }
  return args;
}

function formatRunOutput(
  artifactId: string,
  result: {
    command: string[];
    durationMs: number;
    exitCode: number;
    output: string;
    timedOut: boolean;
    truncated: boolean;
  },
): string {
  const lines = [dim(`$ ${result.command.join(" ")}`)];
  if (result.output.trim()) {
    lines.push(result.output.trimEnd());
  }
  if (result.truncated) {
    lines.push(dim("[truncated]"));
  }
  if (result.timedOut) {
    lines.push(fmtError("[timed out]"));
  }
  const exit = result.exitCode === 0 ? dim("[exit 0]") : fmtError(`[exit ${result.exitCode}]`);
  lines.push(`${exit} ${dim(`${result.durationMs}ms`)} artifact: ${artifactId}`);
  return lines.join("\n");
}

function formatVerificationSummary(results: StoredCommandResult[]): string {
  const failed = results.find((item) => item.result.exitCode !== 0 || item.result.timedOut);
  const lines = [
    failed ? fmtError("Verification failed.") : success("Verification passed."),
    separator(),
  ];
  for (const item of results) {
    const result = item.result;
    const status = result.exitCode === 0 && !result.timedOut ? success("pass") : fmtError("fail");
    lines.push(
      `${status} $ ${result.command.join(" ")} ${dim(
        `[exit ${result.exitCode}] ${result.durationMs}ms artifact: ${item.artifact.id}`,
      )}`,
    );
  }
  if (failed) {
    lines.push(dim("Stopped at first failed verification command."));
  }
  return lines.join("\n");
}
