// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { CodingServiceManager } from "../../../coding/service-manager";
import type { FlywheelToolBackend } from "../../../integrations/flywheel-manager";
import { dim, header, success } from "../../../net/ansi";
import type {
  CodingArtifactRow,
  CodingServiceRow,
  CodingSessionRow,
  MarinaDB,
} from "../../../persistence/database";
import type { Entity, EntityId, RoomContext } from "../../../types";
import {
  type CodeDeps,
  DEFAULT_PUBLICATION_TTL_MS,
  parseJsonObject,
  resolveSession,
  sendCode,
} from "./shared";

/** Everything a `serviceLifecycle` step needs, resolved once per invocation. */
interface ServiceCall {
  ctx: RoomContext;
  eid: EntityId;
  entity: Entity;
  deps: CodeDeps & { db: MarinaDB };
  flywheel: FlywheelToolBackend;
  args: string[];
  session: CodingSessionRow;
  manager: CodingServiceManager;
}

export async function serviceLifecycle(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): Promise<void> {
  if (!deps.flywheel) {
    ctx.send(eid, "Flywheel is not configured; managed VM services are unavailable.");
    return;
  }
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const manager = new CodingServiceManager(deps.db, deps.flywheel);
  const action = args[0]?.toLowerCase() ?? "list";

  const call: ServiceCall = {
    ctx,
    eid,
    entity,
    deps,
    flywheel: deps.flywheel,
    args,
    session,
    manager,
  };

  if (action === "list") {
    await serviceList(call);
    return;
  }

  if (action === "start") {
    await serviceStart(call);
    return;
  }

  if (action === "probes") {
    serviceProbes(call);
    return;
  }

  const selector = args[1];
  if (!selector) throw new Error(`Usage: code service ${action} <id|name>`);
  const service = deps.db.getCodingServiceForEntity(eid, selector);
  if (!service) throw new Error(`Unknown service: ${selector}`);

  if (action === "status") {
    await serviceStatus(call, service);
    return;
  }

  if (action === "logs") {
    await serviceLogs(call, service);
    return;
  }

  if (action === "probe") {
    await serviceProbe(call, service);
    return;
  }

  if (action === "capture" || action === "screenshot") {
    await serviceCapture(call, service);
    return;
  }

  if (action === "stop") {
    await serviceStop(call, service);
    return;
  }

  if (action === "restart") {
    await serviceRestart(call, service);
    return;
  }

  if (action === "publish") {
    await servicePublish(call, service);
    return;
  }

  if (action === "revoke") {
    await serviceRevoke(call, service);
    return;
  }

  ctx.send(
    eid,
    "Usage: code service start|list|status|logs|probe|probes|screenshot|stop|restart|publish|revoke",
  );
}

async function serviceList(call: ServiceCall): Promise<void> {
  const { ctx, eid, deps, session, manager } = call;
  const services = await Promise.all(
    deps.db
      .listCodingServices(eid)
      .map((service) =>
        ["running", "unknown"].includes(service.status) ? manager.refresh(eid, service) : service,
      ),
  );
  sendCode(
    ctx,
    eid,
    services.length
      ? services
          .map(
            (service) =>
              `${service.name}  ${service.status}  pid=${service.pid ?? "-"}${service.port ? `  port=${service.port}` : ""}`,
          )
          .join("\n")
      : "No managed services.",
    {
      event: "services_listed",
      rows: services.map((service) => ({
        id: service.id,
        path: service.log_path,
        status: service.status,
        title: service.name,
        type: "service",
      })),
      sessionId: session.id,
      title: "Managed VM Services",
      type: "list",
    },
  );
  return;
}

async function serviceStart(call: ServiceCall): Promise<void> {
  const { ctx, eid, entity, deps, args, session, manager } = call;
  const name = args[1];
  const separatorIndex = args.indexOf("--");
  if (!name || separatorIndex < 0 || separatorIndex === args.length - 1) {
    throw new Error("Usage: code service start <name> [--port N] -- <command> [args...]");
  }
  const portIndex = args.indexOf("--port", 2);
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : undefined;
  const service = await manager.start({
    entityId: eid,
    sessionId: session.id,
    name,
    command: args.slice(separatorIndex + 1),
    port,
  });
  recordServiceEvent(deps.db, session, entity, "service_started", service);
  sendCode(ctx, eid, success(`Service ${service.name} started (pid ${service.pid}).`), {
    event: "service_started",
    metadata: { port: service.port, serviceId: service.id },
    sessionId: session.id,
    status: service.status,
    title: service.name,
    type: "lifecycle",
    workspace: service.guest_cwd,
  });
  return;
}

function serviceProbes(call: ServiceCall): void {
  const { ctx, eid, deps, args } = call;
  const selector = args[1];
  if (!selector) throw new Error("Usage: code service probes <id|name> [limit]");
  const service = deps.db.getCodingServiceForEntity(eid, selector);
  if (!service) throw new Error(`Unknown service: ${selector}`);
  const probes = deps.db.listCodingServiceProbes(service.id, Number(args[2] ?? 20));
  ctx.send(
    eid,
    probes.length
      ? probes
          .map(
            (probe) =>
              `${new Date(probe.created_at).toISOString()}  ${probe.success ? "ok" : "fail"}  ${probe.http_status ?? "error"}  ${probe.duration_ms}ms  ${probe.path}${probe.error ? `  ${probe.error}` : ""}`,
          )
          .join("\n")
      : `No durable probe history for ${service.name}.`,
  );
  return;
}

async function serviceStatus(call: ServiceCall, initial: CodingServiceRow): Promise<void> {
  const { ctx, eid, session, manager } = call;
  let service = initial;
  service = await manager.refresh(eid, service);
  sendCode(
    ctx,
    eid,
    [
      header(service.name),
      `ID: ${service.id}`,
      `Status: ${service.status}`,
      `PID: ${service.pid ?? "none"}`,
      `Process identity: ${service.process_identity ?? "none"}`,
      `Port: ${service.port ?? "none"}`,
      `Command: ${JSON.parse(service.command_json).join(" ")}`,
      `Guest cwd: ${service.guest_cwd}`,
      `Restart: ${service.restart_policy}`,
      service.published_url ? `Published: ${service.published_url}` : "",
      service.publication_expires_at
        ? `Publication expires: ${new Date(service.publication_expires_at).toISOString()}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    {
      event: "service_status",
      sessionId: session.id,
      status: service.status,
      title: service.name,
      type: "readiness",
      workspace: service.guest_cwd,
    },
  );
  return;
}

async function serviceLogs(call: ServiceCall, initial: CodingServiceRow): Promise<void> {
  const { ctx, eid, entity, deps, args, session, manager } = call;
  const service = initial;
  const lines = args[2] ? Number(args[2]) : 100;
  const output = await manager.logs(eid, service, lines);
  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: "service_log",
    title: `Logs: ${service.name}`,
    status: "complete",
    contentText: output,
    metadata: { lines: Math.max(1, Math.min(500, Math.trunc(lines))), serviceId: service.id },
    createdBy: entity.name,
  });
  sendCode(ctx, eid, output || "No service logs yet.", {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    content: output,
    event: "service_logs_read",
    sessionId: session.id,
    status: "complete",
    title: artifact.title,
    type: "artifact",
  });
  return;
}

async function serviceProbe(call: ServiceCall, initial: CodingServiceRow): Promise<void> {
  const { ctx, eid, entity, deps, args, session, manager } = call;
  let service = initial;
  service = await manager.refresh(eid, service);
  if (service.status !== "running") throw new Error("Start the service before probing it.");
  const result = await manager.probe(eid, service, args[2] ?? "/");
  const successful = result.httpStatus >= 200 && result.httpStatus < 400;
  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: "service_probe",
    title: `Probe: ${service.name} ${args[2] ?? "/"}`,
    status: successful ? "complete" : "failed",
    contentText: result.body,
    metadata: {
      durationMs: result.durationMs,
      httpStatus: result.httpStatus,
      path: args[2] ?? "/",
      port: service.port,
      serviceId: service.id,
      truncated: result.truncated,
    },
    createdBy: entity.name,
  });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "service_probed",
    payload: {
      artifactId: artifact.id,
      durationMs: result.durationMs,
      httpStatus: result.httpStatus,
      serviceId: service.id,
    },
  });
  sendCode(
    ctx,
    eid,
    [
      `HTTP ${result.httpStatus} in ${result.durationMs}ms`,
      result.body || dim("Empty response body."),
    ].join("\n"),
    {
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      content: result.body,
      durationMs: result.durationMs,
      event: "service_probed",
      sessionId: session.id,
      status: artifact.status,
      title: artifact.title,
      truncated: result.truncated,
      type: "verification",
    },
  );
  return;
}

async function serviceCapture(call: ServiceCall, initial: CodingServiceRow): Promise<void> {
  const { ctx, eid, entity, deps, args, session, manager } = call;
  let service = initial;
  service = await manager.refresh(eid, service);
  if (service.status !== "running") throw new Error("Start the service before capturing it.");
  const path = args[2] ?? "/";
  const result = await manager.screenshot(eid, service, path);
  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: "service_screenshot",
    title: `Screenshot: ${service.name} ${path}`,
    status: "complete",
    contentText: Buffer.from(result.data).toString("base64"),
    metadata: {
      byteLength: result.data.length,
      durationMs: result.durationMs,
      encoding: "base64",
      mediaType: "image/png",
      path,
      port: service.port,
      serviceId: service.id,
    },
    createdBy: entity.name,
  });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "service_screenshot_captured",
    payload: {
      artifactId: artifact.id,
      byteLength: result.data.length,
      durationMs: result.durationMs,
      serviceId: service.id,
    },
  });
  sendCode(ctx, eid, success(`PNG screenshot stored as ${artifact.id}`), {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    durationMs: result.durationMs,
    event: "service_screenshot_captured",
    sessionId: session.id,
    status: "complete",
    title: artifact.title,
    type: "artifact",
  });
  return;
}

async function serviceStop(call: ServiceCall, initial: CodingServiceRow): Promise<void> {
  const { ctx, eid, entity, deps, flywheel, session, manager } = call;
  let service = initial;
  if (service.published_subdomain && flywheel.unpublish) {
    await flywheel.unpublish(eid, service.published_subdomain);
    deps.db.updateCodingService(service.id, {
      publishedSubdomain: null,
      publishedUrl: null,
      publicationExpiresAt: null,
    });
  }
  service = await manager.stop(eid, service);
  recordServiceEvent(deps.db, session, entity, "service_stopped", service);
  ctx.send(eid, success(`Service ${service.name} stopped.`));
  return;
}

async function serviceRestart(call: ServiceCall, initial: CodingServiceRow): Promise<void> {
  const { ctx, eid, entity, deps, session, manager } = call;
  let service = initial;
  service = await manager.restart(eid, service);
  recordServiceEvent(deps.db, session, entity, "service_restarted", service);
  ctx.send(eid, success(`Service ${service.name} restarted (pid ${service.pid}).`));
  return;
}

async function servicePublish(call: ServiceCall, initial: CodingServiceRow): Promise<void> {
  const { ctx, eid, entity, deps, flywheel, session, manager } = call;
  let service = initial;
  service = await manager.refresh(eid, service);
  if (service.status !== "running") throw new Error("Start the service before publishing it.");
  if (!service.port) throw new Error("Service has no declared port; restart it with --port N.");
  if (!flywheel.publishDetailed) {
    throw new Error("Configured Flywheel does not support detailed publish metadata.");
  }
  const approval = consumeNetworkApproval(
    deps.db,
    session.id,
    `publish:${service.id}`,
    entity.name,
  );
  if (!approval) {
    throw new Error(
      `Publishing requires explicit network approval. Request and approve: code approval request network publish:${service.id}`,
    );
  }
  const published = await flywheel.publishDetailed(eid, service.port);
  const configuredTtl = Number(process.env.MARINA_FLYWHEEL_PUBLICATION_TTL_MS);
  const ttlMs =
    Number.isSafeInteger(configuredTtl) && configuredTtl >= 60_000
      ? configuredTtl
      : DEFAULT_PUBLICATION_TTL_MS;
  const publicationExpiresAt = Date.now() + ttlMs;
  deps.db.updateCodingService(service.id, {
    publishedSubdomain: published.subdomain,
    publishedUrl: published.url,
    publicationExpiresAt,
  });
  recordServiceEvent(deps.db, session, entity, "service_published", service, {
    ...published,
    approvalId: approval.id,
    publicationExpiresAt,
  });
  ctx.send(
    eid,
    success(
      `Published ${service.name}: ${published.url} (lease expires ${new Date(publicationExpiresAt).toISOString()})`,
    ),
  );
  return;
}

async function serviceRevoke(call: ServiceCall, initial: CodingServiceRow): Promise<void> {
  const { ctx, eid, entity, deps, flywheel, session } = call;
  const service = initial;
  if (!service.published_subdomain) throw new Error("Service is not published.");
  if (!flywheel.unpublish) throw new Error("Configured Flywheel does not support revoke.");
  await flywheel.unpublish(eid, service.published_subdomain);
  deps.db.updateCodingService(service.id, {
    publishedSubdomain: null,
    publishedUrl: null,
    publicationExpiresAt: null,
  });
  recordServiceEvent(deps.db, session, entity, "service_unpublished", service);
  ctx.send(eid, success(`Publication revoked for ${service.name}.`));
  return;
}

function consumeNetworkApproval(
  db: MarinaDB,
  sessionId: string,
  description: string,
  actor: string,
): CodingArtifactRow | null {
  const approval = db
    .listCodingArtifacts(sessionId, 100)
    .find(
      (artifact) =>
        artifact.kind === "approval" &&
        artifact.status === "approved" &&
        artifact.content_text.trim() === description &&
        parseJsonObject(artifact.metadata_json).kind === "network",
    );
  if (!approval) return null;
  db.updateCodingArtifact(approval.id, {
    status: "applied",
    metadata: {
      ...parseJsonObject(approval.metadata_json),
      appliedAt: Date.now(),
      appliedBy: actor,
    },
  });
  return approval;
}

function recordServiceEvent(
  db: MarinaDB,
  session: CodingSessionRow,
  entity: Entity,
  kind: string,
  service: { id: string; name: string; port: number | null; guest_cwd: string },
  extra: Record<string, unknown> = {},
): void {
  db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind,
    payload: {
      ...extra,
      guestCwd: service.guest_cwd,
      port: service.port,
      serviceId: service.id,
      serviceName: service.name,
    },
  });
}
