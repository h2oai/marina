// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { CodingProjectManager } from "../../../coding/project-manager";
import type { FlywheelToolBackend } from "../../../integrations/flywheel-manager";
import { dim, header, success } from "../../../net/ansi";
import type { MarinaDB } from "../../../persistence/database";
import type { Entity, EntityId, RoomContext } from "../../../types";
import {
  type CodeDeps,
  getActiveSessionId,
  resolveSession,
  sendCode,
  updateCodeContext,
} from "./shared";

/** Everything a `sandboxLifecycle` step needs, resolved once per invocation. */
interface SandboxCall {
  ctx: RoomContext;
  eid: EntityId;
  entity: Entity;
  deps: CodeDeps & { db: MarinaDB };
  flywheel: FlywheelToolBackend;
  action: string;
  args: string[];
}

export async function sandboxLifecycle(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): Promise<void> {
  const action = args[0]?.toLowerCase() ?? "status";
  const flywheel = deps.flywheel;
  if (!flywheel) {
    sendCode(
      ctx,
      eid,
      [
        "Flywheel is not configured.",
        "Local Code Mode remains available and unchanged.",
        dim("Set FLYWHEEL_TOKEN on the Marina server to enable isolated workspaces."),
      ].join("\n"),
      {
        event: "sandbox_unconfigured",
        status: "unconfigured",
        title: "Flywheel Sandbox",
        type: "readiness",
      },
    );
    return;
  }

  const call: SandboxCall = { ctx, eid, entity, deps, flywheel, action, args };

  if (action === "ops") {
    await sandboxOps(call);
    return;
  }

  if (action === "status") {
    sandboxStatus(call);
    return;
  }

  if (action === "network") {
    sandboxNetwork(call);
    return;
  }

  if (action === "credentials" || action === "credential") {
    sandboxCredentials(call);
    return;
  }

  if (action === "use" || action === "local") {
    sandboxSelectTarget(call);
    return;
  }

  if (action === "start") {
    await sandboxStart(call);
    return;
  }
  if (action === "hibernate") {
    await sandboxHibernate(call);
    return;
  }
  if (action === "resume") {
    await sandboxResume(call);
    return;
  }
  if (action === "stop") {
    await sandboxStop(call);
    return;
  }

  ctx.send(
    eid,
    "Usage: code sandbox status|start [image]|use|local|network|credentials|ops|hibernate|resume|stop [discard] confirm",
  );
}

async function sandboxOps(call: SandboxCall): Promise<void> {
  const { ctx, eid, entity, deps, flywheel, args } = call;
  if ((entity.properties.rank ?? 0) < 5) {
    throw new Error("Sandbox fleet operations require steward rank or higher.");
  }
  const operation = args[1]?.toLowerCase() ?? "inventory";
  if (operation === "inventory") {
    const inventory = flywheel.inventory?.() ?? [];
    ctx.send(
      eid,
      inventory.length
        ? inventory
            .map(
              (item) =>
                `${item.entityId}  ${item.state}  ${item.sandboxId}  services=${item.activeServices ? "active" : "none"}  published=${item.publishedUrl ? "yes" : "no"}  last=${item.lastActivityAt ? new Date(item.lastActivityAt).toISOString() : "unknown"}`,
            )
            .join("\n")
        : "No Flywheel sandbox allocations.",
    );
    return;
  }
  if (operation === "metrics") {
    const summary = flywheel.operationSummary?.() ?? [];
    ctx.send(
      eid,
      summary.length
        ? summary
            .map(
              (row) =>
                `${row.operation}  ${row.outcome}  count=${row.count}  avg=${row.avg_duration_ms}ms  bytes=${row.byte_count}`,
            )
            .join("\n")
        : "No Flywheel operation telemetry in the current window.",
    );
    return;
  }
  if (operation === "reconcile") {
    if (!flywheel.reconcile) throw new Error("Flywheel reconciliation is unavailable.");
    await flywheel.reconcile();
    ctx.send(eid, success("Flywheel fleet reconciliation completed."));
    return;
  }
  if (operation === "reclaim") {
    if (!flywheel.reclaim) throw new Error("Flywheel reclamation is unavailable.");
    const apply = args[2]?.toLowerCase() === "confirm";
    const candidates = await flywheel.reclaim(apply);
    const detail = candidates.length
      ? candidates
          .map(
            (candidate) =>
              `${candidate.entityId}  ${candidate.sandboxId}  ${candidate.action}  ${candidate.reason}`,
          )
          .join("\n")
      : "No reclaimable sandboxes.";
    ctx.send(
      eid,
      apply
        ? `${success(`Applied ${candidates.length} recoverable reclamation action(s).`)}\n${detail}`
        : `${detail}\n${dim("Dry run only. Use: code sandbox ops reclaim confirm")}`,
    );
    return;
  }
  if (operation === "hibernate") {
    const target = args[2] as EntityId | undefined;
    if (!target) throw new Error("Usage: code sandbox ops hibernate <entity-id> confirm");
    if (args[3]?.toLowerCase() !== "confirm") {
      throw new Error("Operator hibernation requires literal confirm.");
    }
    await flywheel.hibernate(target);
    ctx.send(eid, success(`Hibernated sandbox for ${target}; guest disk is preserved.`));
    return;
  }
  if (operation === "revoke") {
    const target = args[2] as EntityId | undefined;
    if (!target) throw new Error("Usage: code sandbox ops revoke <entity-id> confirm");
    if (args[3]?.toLowerCase() !== "confirm") {
      throw new Error("Operator publication revocation requires literal confirm.");
    }
    if (!flywheel.unpublish) throw new Error("Flywheel publication revocation is unavailable.");
    let revoked = 0;
    for (const service of deps.db.listCodingServices(target)) {
      if (!service.published_subdomain) continue;
      await flywheel.unpublish(target, service.published_subdomain);
      deps.db.updateCodingService(service.id, {
        publishedSubdomain: null,
        publishedUrl: null,
        publicationExpiresAt: null,
      });
      revoked++;
    }
    ctx.send(eid, success(`Revoked ${revoked} publication(s) for ${target}.`));
    return;
  }
  if (operation === "stop") {
    const target = args[2] as EntityId | undefined;
    if (!target) {
      throw new Error("Usage: code sandbox ops stop <entity-id> [discard] confirm");
    }
    const discard = args[3]?.toLowerCase() === "discard";
    const confirmed = (discard ? args[4] : args[3])?.toLowerCase() === "confirm";
    if (!confirmed) throw new Error("Operator teardown requires literal [discard] confirm.");
    const unexported = deps.db
      .listCodingProjects(target)
      .filter((project) => project.has_unexported_changes === 1);
    if (unexported.length > 0 && !discard) {
      throw new Error(
        `${unexported.length} project(s) have unexported work; export first or use discard confirm.`,
      );
    }
    const sandboxId = flywheel.status(target)?.sandboxId;
    await flywheel.stop(target);
    if (sandboxId) {
      deps.db.stopCodingServicesForSandbox(target, sandboxId, "Sandbox destroyed by operator.");
      deps.db.deleteCodingProjectsForSandbox(target, sandboxId);
    }
    ctx.send(eid, success(`Stopped sandbox for ${target}; its Flywheel allocation was removed.`));
    return;
  }
  throw new Error(
    "Usage: code sandbox ops inventory|metrics|reconcile|reclaim [confirm]|hibernate|revoke|stop <entity-id> ... confirm",
  );
}

function sandboxStatus(call: SandboxCall): void {
  const { ctx, eid, entity, deps, flywheel } = call;
  const workspace = flywheel.status(eid);
  const binding = deps.db.listFlywheelBindings().find((row) => row.entity_id === eid);
  const activeProject = binding?.active_project_id
    ? deps.db.getCodingProject(binding.active_project_id)
    : null;
  const activeSessionId = getActiveSessionId(entity);
  const activeSession = activeSessionId ? deps.db.getCodingSession(activeSessionId) : null;
  sendCode(
    ctx,
    eid,
    workspace
      ? [
          header("Flywheel Sandbox"),
          `State: ${workspace.state}`,
          `Image: ${workspace.image}`,
          `Persistence: ${workspace.keepAlive ? "durable guest disk" : "ephemeral"}`,
          `Network profile: ${binding?.network_profile ?? "provider-default"} (${binding?.network_profile_enforced ? "enforced" : "provider-owned; not Marina-enforced"})`,
          `Session: ${workspace.sessionId}`,
          `Sandbox: ${workspace.sandboxId}`,
          workspace.lastActivityAt
            ? `Last activity: ${new Date(workspace.lastActivityAt).toISOString()}`
            : "",
          workspace.lifecycleExpiresAt
            ? `Lifecycle deadline: ${new Date(workspace.lifecycleExpiresAt).toISOString()}`
            : "",
          workspace.hibernatedReason ? `Hibernated reason: ${workspace.hibernatedReason}` : "",
          activeProject ? `Project: ${activeProject.name} (${activeProject.id})` : "Project: none",
          binding?.guest_cwd ? `Guest cwd: ${binding.guest_cwd}` : "",
          workspace.publishedUrl ? `Published: ${workspace.publishedUrl}` : "",
          workspace.lastError ? `Last error: ${workspace.lastError}` : "",
          `Session target: ${activeSession?.execution_target ?? "local (no active session)"}`,
        ]
          .filter(Boolean)
          .join("\n")
      : [
          "Flywheel is configured; this entity has no sandbox.",
          "Use: code sandbox start [image]",
          dim("Local Code Mode remains the active execution target."),
        ].join("\n"),
    {
      event: "sandbox_status",
      status: workspace?.state ?? "absent",
      title: "Flywheel Sandbox",
      type: "readiness",
    },
  );
  return;
}

function sandboxNetwork(call: SandboxCall): void {
  const { ctx, eid, deps, args } = call;
  const binding = deps.db.listFlywheelBindings().find((row) => row.entity_id === eid);
  if (!binding) throw new Error("Start a Flywheel sandbox before inspecting its network policy.");
  if (!args[1] || args[1].toLowerCase() === "status") {
    ctx.send(
      eid,
      [
        header("Sandbox Network Policy"),
        `Profile: ${binding.network_profile}`,
        `Enforcement: ${binding.network_profile_enforced ? "verified" : "provider-owned; not Marina-enforced"}`,
        dim(
          "Marina will not claim a restrictive profile until Flywheel exposes direct-sandbox enforcement.",
        ),
      ].join("\n"),
    );
    return;
  }
  throw new Error(
    "Network profile changes are unavailable: Flywheel's public direct-sandbox policy API is not exposed. No policy was changed.",
  );
}

function sandboxCredentials(call: SandboxCall): void {
  const { ctx, eid, deps, flywheel, action, args } = call;
  const workspace = flywheel.status(eid);
  if (!workspace) throw new Error("Start a Flywheel sandbox before managing credentials.");
  const bindings = deps.db
    .listFlywheelCredentialBindings(eid)
    .filter((binding) => binding.sandbox_id === workspace.sandboxId);
  if (action === "credentials" || !args[1] || args[1].toLowerCase() === "list") {
    ctx.send(
      eid,
      bindings.length
        ? bindings
            .map(
              (binding) =>
                `${binding.profile_name}  ${binding.purpose}  ${binding.state}${binding.expires_at ? `  expires=${new Date(binding.expires_at).toISOString()}` : ""}`,
            )
            .join("\n")
        : "No credential bindings. Marina stores no credential material in sandbox metadata.",
    );
    return;
  }
  throw new Error(
    "Credential binding is unavailable: Flywheel's public direct-sandbox credential broker is not exposed. No secret was stored or injected.",
  );
}

function sandboxSelectTarget(call: SandboxCall): void {
  const { ctx, eid, entity, deps, flywheel, action } = call;
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const target = action === "use" ? "flywheel" : "local";
  if (target === "flywheel") {
    const workspace = flywheel.status(eid);
    if (!workspace) {
      ctx.send(eid, "Use `code sandbox start` before selecting Flywheel execution.");
      return;
    }
    if (workspace.state !== "running") {
      ctx.send(eid, `Flywheel sandbox is ${workspace.state}; resume it before selection.`);
      return;
    }
  }
  deps.db.updateCodingSession(session.id, { executionTarget: target });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "execution_target_changed",
    payload: { previous: session.execution_target, target },
  });
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  sendCode(
    ctx,
    eid,
    success(
      target === "flywheel"
        ? "Execution target set to Flywheel for this coding session."
        : "Execution target set to local host-safe mode for this coding session.",
    ),
    {
      event: "execution_target_changed",
      sessionId: session.id,
      status: target,
      title: "Execution Target",
      type: "lifecycle",
    },
  );
  return;
}

async function sandboxStart(call: SandboxCall): Promise<void> {
  const { ctx, eid, flywheel, args } = call;
  const workspace = await flywheel.create(eid, args[1], true);
  sendCode(ctx, eid, success(`Flywheel sandbox ready: ${workspace.sandboxId}`), {
    event: "sandbox_started",
    status: workspace.state,
    title: "Flywheel Sandbox",
    type: "lifecycle",
  });
  return;
}

async function sandboxHibernate(call: SandboxCall): Promise<void> {
  const { ctx, eid, deps, flywheel } = call;
  const sandboxId = flywheel.status(eid)?.sandboxId;
  for (const service of deps.db.listCodingServices(eid)) {
    if (!service.published_subdomain) continue;
    if (!flywheel.unpublish) {
      throw new Error("Revoke published services before hibernating this sandbox.");
    }
    await flywheel.unpublish(eid, service.published_subdomain);
    deps.db.updateCodingService(service.id, {
      publishedSubdomain: null,
      publishedUrl: null,
      publicationExpiresAt: null,
    });
  }
  await flywheel.hibernate(eid);
  if (sandboxId) {
    deps.db.stopCodingServicesForSandbox(eid, sandboxId, "Sandbox hibernated; restart required.");
  }
  sendCode(ctx, eid, success("Flywheel sandbox hibernated; writable disk preserved."), {
    event: "sandbox_hibernated",
    status: "hibernated",
    title: "Flywheel Sandbox",
    type: "lifecycle",
  });
  return;
}

async function sandboxResume(call: SandboxCall): Promise<void> {
  const { ctx, eid, flywheel } = call;
  await flywheel.resume(eid);
  sendCode(ctx, eid, success("Flywheel sandbox resumed by cold boot."), {
    event: "sandbox_resumed",
    status: "running",
    title: "Flywheel Sandbox",
    type: "lifecycle",
  });
  return;
}

async function sandboxStop(call: SandboxCall): Promise<void> {
  const { ctx, eid, deps, flywheel, args } = call;
  const discardConfirmed =
    args[1]?.toLowerCase() === "discard" && args[2]?.toLowerCase() === "confirm";
  const activeProject = new CodingProjectManager(deps.db, deps.workspace, flywheel).active(eid);
  if (activeProject && !discardConfirmed) {
    await new CodingProjectManager(deps.db, deps.workspace, flywheel).status(eid, activeProject);
  }
  const hasUnexportedProjects = deps.db
    .listCodingProjects(eid)
    .some((project) => project.has_unexported_changes === 1);
  const confirmed = args[1]?.toLowerCase() === "confirm";
  if (hasUnexportedProjects && !discardConfirmed) {
    ctx.send(
      eid,
      "Stopping would destroy unexported project work. Export it first, or use `code sandbox stop discard confirm` to acknowledge data loss.",
    );
    return;
  }
  if (!hasUnexportedProjects && !confirmed && !discardConfirmed) {
    ctx.send(
      eid,
      "Stopping destroys the guest workspace. Use `code sandbox stop confirm` to continue.",
    );
    return;
  }
  const sandboxId = flywheel.status(eid)?.sandboxId;
  await flywheel.stop(eid);
  if (sandboxId) {
    deps.db.stopCodingServicesForSandbox(eid, sandboxId, "Sandbox destroyed.");
    deps.db.deleteCodingProjectsForSandbox(eid, sandboxId);
  }
  sendCode(ctx, eid, success("Flywheel sandbox stopped and durable binding removed."), {
    event: "sandbox_stopped",
    status: "absent",
    title: "Flywheel Sandbox",
    type: "lifecycle",
  });
  return;
}
