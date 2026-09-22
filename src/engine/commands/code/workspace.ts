// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { accessSync, existsSync, constants as fsConstants, readdirSync, statSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { LocalWorkspace, type WorkspaceRuntime } from "../../../coding/local-workspace";
import { WorkspaceRegistry } from "../../../coding/workspace-registry";
import {
  createSessionWorktree,
  isGitRepo,
  removeSessionWorktree,
  worktreeHasChanges,
} from "../../../coding/worktree";
import { dim, error as fmtError, header, separator, success } from "../../../net/ansi";
import type { CodingSessionRow, MarinaDB } from "../../../persistence/database";
import type { Entity, EntityId, RoomContext } from "../../../types";
import { checkGateForExecution, recordGateExecution } from "../../safety-gates";
import {
  CODE_WORKSPACE_KEY,
  type CodeCheckRow,
  type CodeDeps,
  getActiveSessionId,
  NO_CODE_ROOT_DENY,
  resolveSession,
  sendCode,
  TELNET_HOST_EXEC_DENY,
  updateCodeContext,
} from "./shared";

/**
 * Auto-remove a session's worktree on close IF it has no uncommitted changes
 * (safe — nothing lost, it can be recreated). If it has work, keep it and return
 * a note surfacing the path + branch so the human can merge or discard. Never
 * spawns host git over telnet — keeps the tree and reports the path instead.
 * Returns a human-facing note, or undefined for the silent clean-remove path.
 */
export async function cleanupSessionWorktree(
  deps: CodeDeps & { db: MarinaDB },
  entity: Entity,
  session: CodingSessionRow,
): Promise<string | undefined> {
  if (!session.worktree_path) return undefined;
  if (deps.hostExecForbidden === true) {
    return dim(`Worktree kept (host git unavailable here): ${session.worktree_path}`);
  }
  const removal = await removeSessionWorktree(session.workspace_root, session.worktree_path, {
    hostExecForbidden: false,
  });
  if (removal.removed) {
    deps.db.updateCodingSession(session.id, { worktreePath: null, worktreeBranch: null });
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "worktree_removed",
      payload: { path: session.worktree_path, branch: session.worktree_branch, auto: true },
    });
    return undefined; // clean auto-remove: silent
  }
  return [
    `Kept your worktree (uncommitted work): ${session.worktree_path}`,
    dim(
      `Branch ${session.worktree_branch ?? "?"} — merge it (code worktree merge) or discard it manually.`,
    ),
  ].join("\n");
}

export function handleWorkspace(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): void {
  const action = args[0]?.toLowerCase() ?? "show";
  const registry = getWorkspaceRegistry(deps);
  if (action === "list") {
    const active = getSelectedWorkspaceRoot(entity, deps);
    const choices = registry.listChoices();
    const lines = [header("Code Workspaces"), separator()];
    for (const choice of choices) {
      const mark = choice.root === active ? "*" : " ";
      lines.push(`${mark} ${choice.label} ${dim(choice.root)}`);
    }
    sendCode(ctx, eid, lines.join("\n"), {
      commands: ["code workspace", "code workspace use <path>", "code doctor"],
      event: "workspace_listed",
      rows: choices.map((choice) => ({
        id: choice.label,
        path: choice.root,
        status: choice.root === active ? "active" : undefined,
        title: choice.label,
        type: "workspace",
      })),
      title: "Code Workspaces",
      type: "list",
    });
    return;
  }
  if (action === "discover" || action === "scan") {
    const active = getSelectedWorkspaceRoot(entity, deps);
    const choices = discoverWorkspaceChoices(registry);
    if (choices.length === 0) {
      ctx.send(eid, "No likely code workspaces found under configured roots.");
      return;
    }
    const lines = [header("Discovered Code Workspaces"), separator()];
    for (const choice of choices) {
      const mark = choice.root === active ? "*" : " ";
      lines.push(`${mark} ${choice.label} ${dim(choice.root)} ${dim(choice.reason)}`);
    }
    sendCode(ctx, eid, lines.join("\n"), {
      commands: ["code workspace use <path>", "code workspace", "code doctor"],
      event: "workspace_discovered",
      rows: choices.map((choice) => ({
        detail: choice.reason,
        path: choice.root,
        status: choice.root === active ? "active" : undefined,
        title: choice.label,
        type: "workspace",
      })),
      title: "Discovered Code Workspaces",
      type: "list",
      workspace: active,
    });
    return;
  }
  if (action === "use" || action === "set") {
    const raw = args.slice(1).join(" ");
    if (!raw.trim()) {
      ctx.send(eid, "Usage: code workspace use <path>");
      return;
    }
    const choice = registry.resolveRoot(raw);
    entity.properties[CODE_WORKSPACE_KEY] = choice.root;
    const sessionId = getActiveSessionId(entity);
    updateCodeContext(
      entity,
      deps.db,
      sessionId ? (deps.db.getCodingSession(sessionId) ?? undefined) : undefined,
    );
    sendCode(
      ctx,
      eid,
      [
        success(`Code workspace selected: ${choice.label}`),
        `Root: ${choice.root}`,
        dim(
          "New coding sessions will use this workspace. Existing sessions keep their stored root.",
        ),
      ].join("\n"),
      {
        commands: ["code start <title>", "code workspace", "code doctor"],
        event: "workspace_selected",
        rows: [{ id: choice.label, path: choice.root, status: "active", title: choice.label }],
        title: choice.label,
        type: "list",
        workspace: choice.root,
      },
    );
    return;
  }
  if (action !== "show") {
    ctx.send(eid, "Usage: code workspace [show|list|discover|use <path>]");
    return;
  }
  const root = getSelectedWorkspaceRoot(entity, deps);
  sendCode(
    ctx,
    eid,
    [
      header("Code Workspace"),
      separator(),
      `Selected: ${root}`,
      `Default: ${registry.defaultRoot}`,
      `Allowed roots: ${registry.roots.join(", ")}`,
      dim(
        "Use: code workspace list | code workspace discover | code workspace use <path> | code doctor",
      ),
    ].join("\n"),
    {
      commands: [
        "code workspace list",
        "code workspace discover",
        "code workspace use <path>",
        "code doctor",
      ],
      event: "workspace_shown",
      rows: registry.roots.map((choiceRoot) => ({
        path: choiceRoot,
        status:
          choiceRoot === root
            ? "active"
            : choiceRoot === registry.defaultRoot
              ? "default"
              : undefined,
        title: choiceRoot,
        type: "workspace",
      })),
      title: "Code Workspace",
      type: "list",
      workspace: root,
    },
  );
}

/**
 * Per-session git-worktree isolation (opt-in, default OFF).
 *
 *   code worktree [status]  — show binding + dirty state
 *   code worktree on        — bind an isolated worktree (git repos only)
 *   code worktree off       — remove it (auto if clean, keep+report if dirty)
 *   code worktree merge     — human-gated guidance to merge the branch (no auto-merge)
 *
 * `on`/`off` run host git, so they take the SAME gates as the other host-exec
 * verbs: telnet deny, no-code-root deny, and the earned `code.exec` competence.
 */
export async function handleWorktree(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): Promise<void> {
  const action = args[0]?.toLowerCase() ?? "status";
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;

  if (action === "status" || action === "show") {
    await worktreeStatus(ctx, eid, deps, session);
    return;
  }
  if (action === "merge") {
    worktreeMergeGuidance(ctx, eid, session);
    return;
  }
  const enabling = action === "on" || action === "enable";
  const disabling = action === "off" || action === "disable";
  if (!enabling && !disabling) {
    ctx.send(eid, "Usage: code worktree [status|on|off|merge]");
    return;
  }

  // on/off mutate the host via git — mirror the host-exec gate ladder.
  if (deps.getConnectionProtocol?.(eid) === "telnet") {
    ctx.send(eid, TELNET_HOST_EXEC_DENY);
    return;
  }
  if (getWorkspaceRegistry(deps).usesCwdFallback) {
    ctx.send(eid, NO_CODE_ROOT_DENY);
    return;
  }
  const gate = checkGateForExecution(deps.db, eid, "code.exec");
  if (!gate.ok) {
    ctx.send(
      eid,
      gate.reason ??
        "Running or applying code requires the code.exec capability, which is earned through contribution.",
    );
    return;
  }
  recordGateExecution(deps.db, eid, "code.exec", gate, "code worktree");
  const hostExecForbidden = deps.hostExecForbidden === true;

  if (enabling) {
    if (session.worktree_path && existsSync(session.worktree_path)) {
      ctx.send(
        eid,
        `Worktree already active for ${session.id}: ${session.worktree_path} (${session.worktree_branch}).`,
      );
      return;
    }
    if (!isGitRepo(session.workspace_root)) {
      ctx.send(
        eid,
        `Workspace is not a git repository — worktree isolation unavailable. Staying on the shared root: ${session.workspace_root}`,
      );
      return;
    }
    const created = await createSessionWorktree(session.workspace_root, session.id, {
      hostExecForbidden,
    });
    if (!created) {
      ctx.send(
        eid,
        `Could not create a worktree (no commits yet, or git error). Staying on the shared root: ${session.workspace_root}`,
      );
      return;
    }
    deps.db.updateCodingSession(session.id, {
      worktreePath: created.path,
      worktreeBranch: created.branch,
    });
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "worktree_enabled",
      payload: { path: created.path, branch: created.branch },
    });
    updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
    sendCode(
      ctx,
      eid,
      [
        success(`Worktree isolation on for ${session.id}`),
        `Path: ${created.path}`,
        `Branch: ${created.branch}`,
        dim("Edits land on this branch. Merge back with code worktree merge when ready."),
      ].join("\n"),
      {
        commands: ["code worktree status", "code worktree merge", "code worktree off"],
        event: "worktree_enabled",
        sessionId: session.id,
        status: session.status,
        title: created.branch,
        type: "session",
        workspace: created.path,
      },
    );
    return;
  }

  // disabling
  if (!session.worktree_path) {
    ctx.send(eid, `No worktree bound to ${session.id}. It already uses the shared root.`);
    return;
  }
  const removal = await removeSessionWorktree(session.workspace_root, session.worktree_path, {
    hostExecForbidden,
  });
  if (removal.removed) {
    deps.db.updateCodingSession(session.id, { worktreePath: null, worktreeBranch: null });
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "worktree_removed",
      payload: { path: session.worktree_path, branch: session.worktree_branch },
    });
    updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
    ctx.send(
      eid,
      success(
        `Worktree removed; ${session.id} is back on the shared root ${session.workspace_root}.`,
      ),
    );
    return;
  }
  // Kept (uncommitted work or removal failed) — keep the binding + surface the path.
  ctx.send(
    eid,
    [
      `Kept the worktree: ${removal.keptReason ?? session.worktree_path}`,
      dim(`Branch: ${session.worktree_branch ?? "?"}`),
      dim("Commit or discard the work, then run code worktree off again."),
    ].join("\n"),
  );
}

async function worktreeStatus(
  ctx: RoomContext,
  eid: EntityId,
  deps: CodeDeps & { db: MarinaDB },
  session: CodingSessionRow,
): Promise<void> {
  if (!session.worktree_path) {
    ctx.send(
      eid,
      [
        `Worktree: off for ${session.id}.`,
        `Shared root: ${session.workspace_root}`,
        dim("Enable isolation with code worktree on (git repos only)."),
      ].join("\n"),
    );
    return;
  }
  // Probe dirty state only when host git is available here (never over telnet).
  let dirtyNote = dim("(dirty state not probed)");
  if (deps.hostExecForbidden !== true && !getWorkspaceRegistry(deps).usesCwdFallback) {
    const dirty = await worktreeHasChanges(session.worktree_path, { hostExecForbidden: false });
    dirtyNote = dirty ? "uncommitted changes present" : "clean";
  }
  sendCode(
    ctx,
    eid,
    [
      header("Session Worktree"),
      separator(),
      `Session: ${session.id}`,
      `Path: ${session.worktree_path}`,
      `Branch: ${session.worktree_branch ?? "?"}`,
      `Base root: ${session.workspace_root}`,
      `State: ${dirtyNote}`,
      dim("code worktree merge for merge guidance | code worktree off to remove"),
    ].join("\n"),
    {
      commands: ["code worktree merge", "code worktree off"],
      event: "worktree_status",
      sessionId: session.id,
      status: session.status,
      title: session.worktree_branch ?? session.id,
      type: "session",
      workspace: session.worktree_path,
    },
  );
}

/**
 * Merging a session branch into the base is an EXPLICIT, human-gated step —
 * Marina never auto-merges. This prints the branch + the exact git command to
 * run from the base repo; it executes nothing.
 */
function worktreeMergeGuidance(ctx: RoomContext, eid: EntityId, session: CodingSessionRow): void {
  if (!session.worktree_branch) {
    ctx.send(eid, `No worktree branch bound to ${session.id}. Enable one with code worktree on.`);
    return;
  }
  ctx.send(
    eid,
    [
      header("Merge worktree branch"),
      separator(),
      `Branch: ${session.worktree_branch}`,
      `Base repo: ${session.workspace_root}`,
      `Worktree: ${session.worktree_path ?? "(removed)"}`,
      dim("Merging into your base branch is a human step. From the base repo run:"),
      `  git merge ${session.worktree_branch}`,
      dim("Marina never auto-merges a session branch into your base."),
    ].join("\n"),
  );
}

export async function doctor(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
): Promise<void> {
  const registry = getWorkspaceRegistry(deps);
  const selected = getSelectedWorkspace(entity, deps);
  const activeSessionId = getActiveSessionId(entity);
  const session = activeSessionId ? deps.db.getCodingSession(activeSessionId) : null;
  const workspace = session ? workspaceForSession(deps, session) : selected;
  const packageJson = await workspace.read("package.json").catch(() => null);
  const scripts = packageJson ? detectPackageScripts(packageJson.content) : [];
  const packageManager = await detectPackageManager(workspace);
  const binaries = ["bun", "git", "rg"].map((binary) => ({
    binary,
    available: binaryAvailable(binary),
  }));
  const git = await workspace.run(["git", "status", "--short"]).catch((err) => ({
    exitCode: 127,
    output: err instanceof Error ? err.message : String(err),
  }));
  const gitState = formatGitState(git.exitCode, git.output);
  const verify = recommendedVerify(scripts);
  const roots = registry.listChoices();
  const flywheel = deps.flywheel?.status(eid);
  const nextSteps = [
    session ? "code status" : "code start <title>",
    verify.length > 0 ? "code verify" : "code run git diff --check",
    "code workspace discover",
    roots.length > 1 ? "code workspace list" : "",
  ].filter(Boolean);
  const lines = [
    header("Code Doctor"),
    separator(),
    `Workspace: ${workspace.displayRoot()}`,
    registry.usesCwdFallback
      ? `Workspace source: ${fmtError("process cwd fallback; configure MARINA_CODE_ROOTS for production")}`
      : "Workspace source: configured root",
    `Configured roots: ${roots.map((choice) => choice.root).join(", ")}`,
    `Session: ${session?.id ?? dim("none active")}`,
    `Session status: ${session?.status ?? dim("not started")}`,
    `Package manager: ${packageManager}`,
    `Package scripts: ${scripts.length > 0 ? scripts.join(", ") : dim("none detected")}`,
    `Git: ${gitState}`,
    `Binaries: ${formatBinaryAvailability(binaries)}`,
    `Search: ${binaries.find((item) => item.binary === "rg")?.available ? "rg" : "built-in fallback"}`,
    `Recommended verify: ${verify.length > 0 ? verify.map((cmd) => `code run ${cmd}`).join(" -> ") : "code run git diff --check"}`,
    `Local policy: host-safe allowlist`,
    `Flywheel: ${deps.flywheel ? (flywheel ? `${flywheel.state} (${flywheel.image})` : "configured; no workspace") : "not configured; local Code Mode available"}`,
    `Next: ${nextSteps.join(" | ")}`,
    dim("Configure roots with MARINA_CODE_ROOTS and MARINA_CODE_DEFAULT_ROOT."),
    dim("Use: code workspace discover | code workspace use <path> | code start <title>"),
  ];
  sendCode(ctx, eid, lines.join("\n"), {
    checks: [
      { label: "Workspace", status: "ok", detail: workspace.displayRoot() },
      {
        label: "Workspace config",
        status: registry.usesCwdFallback ? "warn" : "ok",
        detail: registry.usesCwdFallback
          ? "process cwd fallback; configure MARINA_CODE_ROOTS for production"
          : "configured root",
      },
      {
        label: "Session",
        status: session ? (session.status === "complete" ? "ok" : "info") : "warn",
        detail: session ? `${session.id} (${session.status})` : "none active",
      },
      {
        label: "Package manager",
        status: packageManager === "unknown" ? "warn" : "ok",
        detail: packageManager,
      },
      {
        label: "Package scripts",
        status: scripts.length > 0 ? "ok" : "warn",
        detail: scripts.length > 0 ? scripts.join(", ") : "none detected",
      },
      {
        label: "Git",
        status: git.exitCode === 0 ? "ok" : "warn",
        detail: gitState,
      },
      ...binaries.map(
        (item): CodeCheckRow => ({
          label: item.binary,
          status: item.available ? "ok" : item.binary === "rg" ? "warn" : "fail",
          detail: item.available ? "available" : "missing",
        }),
      ),
      {
        label: "Local policy",
        status: "info",
        detail: "host-safe allowlist",
      },
      {
        label: "Flywheel",
        status: !deps.flywheel ? "info" : flywheel?.state === "running" ? "ok" : "warn",
        detail: !deps.flywheel
          ? "not configured; local Code Mode available"
          : flywheel
            ? `${flywheel.state} (${flywheel.image})`
            : "configured; no workspace",
      },
    ],
    commands: nextSteps.length > 0 ? nextSteps : ["code start <title>"],
    event: "doctor_ran",
    rows: roots.map((choice) => ({
      path: choice.root,
      status: choice.root === workspace.displayRoot() ? "active" : undefined,
      title: choice.label,
      type: "workspace",
    })),
    sessionId: session?.id,
    status: session?.status,
    title: "Code Doctor",
    type: "readiness",
    workspace: workspace.displayRoot(),
  });
}

export function getWorkspaceRegistry(deps: CodeDeps): WorkspaceRegistry {
  if (!deps.workspace) {
    return deps.workspaceRegistry ?? WorkspaceRegistry.fromEnv();
  }
  const root = deps.workspace.displayRoot();
  return deps.workspaceRegistry ?? new WorkspaceRegistry({ defaultRoot: root, roots: [root] });
}

/**
 * Stamp the telnet-origin host-exec ban onto a freshly-resolved workspace. The
 * registry hands back a NEW LocalWorkspace per call, so this is per-invocation
 * state — no cross-caller stickiness. Every host-spawning workspace flows through
 * `getSelectedWorkspace` / `workspaceForSession`, so stamping here covers all
 * subcommands (including read-only host spawners like `code doctor`) by
 * construction rather than an enumerated list.
 */
function stampHostExecPolicy(ws: WorkspaceRuntime, deps: CodeDeps): WorkspaceRuntime {
  ws.setHostExecForbidden?.(deps.hostExecForbidden === true);
  return ws;
}

export function getSelectedWorkspace(entity: Entity, deps: CodeDeps): WorkspaceRuntime {
  return stampHostExecPolicy(
    getWorkspaceRegistry(deps).workspaceForRoot(getSelectedWorkspaceRoot(entity, deps)),
    deps,
  );
}

export function getSelectedWorkspaceRoot(entity: Entity, deps: CodeDeps): string {
  const value = entity.properties[CODE_WORKSPACE_KEY];
  const registry = getWorkspaceRegistry(deps);
  if (typeof value === "string" && value.trim()) {
    return registry.resolveRoot(value).root;
  }
  return registry.defaultRoot;
}

export function workspaceForSession(deps: CodeDeps, session: CodingSessionRow): WorkspaceRuntime {
  // When the session is bound to a Marina-managed worktree (opt-in), all file /
  // exec ops confine to the worktree instead of the shared root. The worktree
  // lives OUTSIDE the configured roots (~/.marina/worktrees), so it bypasses the
  // registry allowlist and constructs a LocalWorkspace pinned to that subtree —
  // path confinement still applies, just relative to the worktree. Default (no
  // worktree) is byte-identical to before.
  if (session.worktree_path && existsSync(session.worktree_path)) {
    return stampHostExecPolicy(new LocalWorkspace(session.worktree_path), deps);
  }
  return stampHostExecPolicy(
    getWorkspaceRegistry(deps).workspaceForRoot(session.workspace_root),
    deps,
  );
}

interface DiscoveredWorkspace {
  label: string;
  reason: string;
  root: string;
}

function discoverWorkspaceChoices(registry: WorkspaceRegistry): DiscoveredWorkspace[] {
  const found = new Map<string, DiscoveredWorkspace>();
  for (const root of registry.roots) {
    addDiscoveredWorkspace(found, root, "configured root");
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries.slice(0, 200)) {
      const path = join(root, entry);
      try {
        if (!statSync(path).isDirectory()) continue;
      } catch {
        continue;
      }
      const reason = workspaceDiscoveryReason(path);
      if (reason) addDiscoveredWorkspace(found, path, reason);
    }
  }
  return [...found.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function addDiscoveredWorkspace(
  found: Map<string, DiscoveredWorkspace>,
  root: string,
  reason: string,
): void {
  const candidateReason = workspaceDiscoveryReason(root) ?? reason;
  found.set(root, { label: basename(root) || root, reason: candidateReason, root });
}

function workspaceDiscoveryReason(root: string): string | undefined {
  const checks: [string, string][] = [
    [".git", "git repo"],
    ["package.json", "package.json"],
    ["bun.lock", "bun workspace"],
    ["pnpm-lock.yaml", "pnpm workspace"],
    ["yarn.lock", "yarn workspace"],
    ["Cargo.toml", "cargo workspace"],
    ["pyproject.toml", "python project"],
    ["go.mod", "go module"],
  ];
  for (const [name, reason] of checks) {
    try {
      accessSync(join(root, name), fsConstants.F_OK);
      return reason;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

export function detectPackageScripts(packageJson: string): string[] {
  try {
    const parsed = JSON.parse(packageJson) as { scripts?: Record<string, unknown> };
    return Object.entries(parsed.scripts ?? {})
      .filter(([, value]) => typeof value === "string")
      .map(([name]) => name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

async function detectPackageManager(workspace: WorkspaceRuntime): Promise<string> {
  const lockfiles = [
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ] as const;
  for (const [path, manager] of lockfiles) {
    const found = await workspace.read(path, 1).then(
      () => true,
      () => false,
    );
    if (found) return manager;
  }
  const packageJson = await workspace.read("package.json", 1).then(
    () => true,
    () => false,
  );
  return packageJson ? "package.json" : "none";
}

export function recommendedVerify(scripts: string[]): string[] {
  return ["typecheck", "lint", "test", "build"].filter((script) => scripts.includes(script));
}

function binaryAvailable(binary: string): boolean {
  const path = process.env.PATH ?? "";
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, binary), fsConstants.X_OK);
      return true;
    } catch {
      // Try the next PATH entry.
    }
  }
  return false;
}

function formatBinaryAvailability(items: { available: boolean; binary: string }[]): string {
  return items.map((item) => `${item.binary}=${item.available ? "yes" : "missing"}`).join(", ");
}

function formatGitState(exitCode: number, output: string): string {
  if (exitCode !== 0) return "unavailable";
  const changed = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean).length;
  if (changed === 0) return "clean";
  return `${changed} changed path${changed === 1 ? "" : "s"}`;
}
