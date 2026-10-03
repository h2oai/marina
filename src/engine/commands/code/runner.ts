// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `code workspace runner …` — where a session's finite commands run. The
 * default is the host (LocalWorkspace). `container` binds an image so tests and
 * scripts run inside it (src/coding/container-workspace.ts). The setting is a
 * per-session `workspace_runner` artifact (no schema change); the latest
 * active one wins, `local` retires it. Configuring a runner is gated like any
 * other execution change (`code.exec`, telnet refused) by the entry file.
 */

import {
  type ContainerRunnerConfig,
  ContainerWorkspace,
  resolveContainerRunner,
  UnavailableContainerWorkspace,
} from "../../../coding/container-workspace";
import type { WorkspaceRuntime } from "../../../coding/local-workspace";
import { LocalWorkspace } from "../../../coding/local-workspace";
import { dim, header, separator } from "../../../net/ansi";
import type { CodingSessionRow, MarinaDB } from "../../../persistence/database";
import type { Entity, EntityId, RoomContext } from "../../../types";
import { parseModifiers, splitOnTerminator } from "../../parse-input";
import { type CodeDeps, parseJsonObject, resolveSession, sendCode } from "./shared";

export const RUNNER_ARTIFACT_KIND = "workspace_runner";

const USAGE = [
  "code workspace runner                       show where commands run",
  "code workspace runner local                 run on the host (default)",
  "code workspace runner container image:<ref> [sync:mount|patch] [workdir:/path]",
  "    [network:on] [cpus:N] [memory:MB] [timeout:10m] [shell:sh|bash] [-- <init preamble>]",
].join("\n");

type RunnerSetting = { kind: "local" } | { kind: "container"; config: ContainerRunnerConfig };

/** The session's explicit runner setting (`local` pins the host), if any. */
export function sessionRunnerSetting(
  db: Pick<MarinaDB, "listCodingArtifacts">,
  sessionId: string,
): RunnerSetting | null {
  const artifact = db
    .listCodingArtifacts(sessionId, 200)
    .find((row) => row.kind === RUNNER_ARTIFACT_KIND && row.status === "active");
  if (!artifact) return null;
  const runner = parseJsonObject(artifact.metadata_json).runner as
    | (ContainerRunnerConfig & { kind?: string })
    | undefined;
  if (runner?.kind === "local") return { kind: "local" };
  return runner && typeof runner.image === "string" ? { kind: "container", config: runner } : null;
}

/** The session's container runner configuration, if one is set explicitly. */
export function activeRunnerConfig(
  db: Pick<MarinaDB, "listCodingArtifacts">,
  sessionId: string,
): ContainerRunnerConfig | null {
  const setting = sessionRunnerSetting(db, sessionId);
  return setting?.kind === "container" ? setting.config : null;
}

/**
 * Operator default runner from the environment (`MARINA_CODE_CONTAINER_*`):
 * every local session without an explicit setting runs its commands in this
 * image. Env-only by design, like the code roots themselves.
 */
export function envRunnerConfig(
  env: NodeJS.ProcessEnv = process.env,
): ContainerRunnerConfig | null {
  const image = env.MARINA_CODE_CONTAINER_IMAGE?.trim();
  if (!image) return null;
  const sync = env.MARINA_CODE_CONTAINER_SYNC?.trim();
  const shell = env.MARINA_CODE_CONTAINER_SHELL?.trim();
  return {
    image,
    ...(sync ? { sync: sync as ContainerRunnerConfig["sync"] } : {}),
    ...(env.MARINA_CODE_CONTAINER_WORKDIR?.trim()
      ? { workdir: env.MARINA_CODE_CONTAINER_WORKDIR.trim() }
      : {}),
    ...(env.MARINA_CODE_CONTAINER_INIT?.trim()
      ? { init: env.MARINA_CODE_CONTAINER_INIT.trim() }
      : {}),
    ...(shell ? { shell: shell as ContainerRunnerConfig["shell"] } : {}),
    network: /^(1|true|on|yes)$/i.test(env.MARINA_CODE_CONTAINER_NETWORK?.trim() ?? ""),
  };
}

/**
 * Wrap a session's host workspace in its container runner when one is set —
 * the session's explicit setting first, else the operator's env default.
 * A configured runner that cannot resolve (no runtime, bad image) yields a
 * workspace whose every command fails with that reason — never host execution.
 */
export function applySessionRunner(
  ws: WorkspaceRuntime,
  db: Pick<MarinaDB, "listCodingArtifacts"> | undefined,
  session: CodingSessionRow,
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceRuntime {
  if (session.execution_target !== "local" || !(ws instanceof LocalWorkspace)) return ws;
  const setting = db ? sessionRunnerSetting(db, session.id) : null;
  if (setting?.kind === "local") return ws;
  const config = setting?.kind === "container" ? setting.config : envRunnerConfig(env);
  if (!config) return ws;
  try {
    return new ContainerWorkspace(ws.root, resolveContainerRunner(config));
  } catch (error) {
    return new UnavailableContainerWorkspace(ws.root, error);
  }
}

export function handleRunner(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  rawArgs: string,
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const [head, init] = splitOnTerminator(rawArgs);
  const tokens = head.split(/\s+/).filter(Boolean);
  const action = tokens[0]?.toLowerCase() ?? "show";

  if (action === "show" || action === "status") {
    const setting = sessionRunnerSetting(deps.db, session.id);
    const fromEnv = setting ? null : envRunnerConfig();
    const config = setting?.kind === "container" ? setting.config : fromEnv;
    const lines = [header("Code Runner"), separator()];
    if (!config) {
      lines.push("Commands run on the host (local workspace).");
    } else {
      lines.push(
        `Commands run in container image ${config.image}${fromEnv ? dim(" (operator default, MARINA_CODE_CONTAINER_IMAGE)") : ""}`,
      );
      lines.push(
        `Sync: ${config.sync ?? "mount"} · workdir ${config.workdir ?? "/work"} · network ${config.network ? "on" : "off"}`,
      );
      if (config.init) lines.push(`Init: ${config.init}`);
      try {
        const resolved = resolveContainerRunner(config);
        lines.push(
          dim(
            `Runtime: ${resolved.runtime}; limits ${resolved.cpus} CPU, ${resolved.memoryMb} MB, ${Math.round(resolved.timeoutMs / 1000)} s`,
          ),
        );
      } catch (error) {
        lines.push(`Unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    lines.push("", dim(USAGE));
    sendCode(ctx, eid, lines.join("\n"), {
      event: "runner_shown",
      sessionId: session.id,
      metadata: { runner: config ?? { kind: "local" } },
      title: "Code Runner",
      type: "list",
    });
    return;
  }

  if (action === "local" || action === "host" || action === "off") {
    // An explicit `local` pins the host even when an operator default image is set.
    retireRunners(deps.db, session.id);
    deps.db.createCodingArtifact({
      sessionId: session.id,
      kind: RUNNER_ARTIFACT_KIND,
      title: "Host runner",
      status: "active",
      contentText: "host",
      metadata: { runner: { kind: "local" } },
      createdBy: entity.name,
    });
    sendCode(ctx, eid, "Commands now run on the host.", {
      event: "runner_changed",
      sessionId: session.id,
      metadata: { runner: { kind: "local" } },
      type: "lifecycle",
    });
    return;
  }

  if (action !== "container") {
    ctx.send(eid, `Usage:\n${USAGE}`);
    return;
  }
  if (session.execution_target !== "local")
    throw new Error(
      "A container runner applies to local workspaces; this session runs in a sandbox.",
    );
  const parsed = parseModifiers(tokens.slice(1), {
    image: { type: "string" },
    sync: { type: "string" },
    workdir: { type: "string" },
    network: { type: "bool" },
    cpus: { type: "number" },
    memory: { type: "int" },
    timeout: { type: "duration" },
    shell: { type: "string" },
    runtime: { type: "string" },
  });
  const v = parsed.values;
  const config: ContainerRunnerConfig = {
    image: String(v.image ?? parsed.rest[0] ?? ""),
    ...(v.sync !== undefined ? { sync: String(v.sync) as ContainerRunnerConfig["sync"] } : {}),
    ...(v.workdir !== undefined ? { workdir: String(v.workdir) } : {}),
    ...(v.network !== undefined ? { network: v.network === true } : {}),
    ...(typeof v.cpus === "number" ? { cpus: v.cpus } : {}),
    ...(typeof v.memory === "number" ? { memoryMb: v.memory } : {}),
    ...(typeof v.timeout === "number" ? { timeoutMs: v.timeout } : {}),
    ...(v.shell !== undefined ? { shell: String(v.shell) as ContainerRunnerConfig["shell"] } : {}),
    ...(v.runtime !== undefined
      ? { runtime: String(v.runtime) as ContainerRunnerConfig["runtime"] }
      : {}),
    ...(init ? { init } : {}),
  };
  // Validate now so a bad setting is refused at configuration time, not on first use.
  const resolved = resolveContainerRunner(config);
  retireRunners(deps.db, session.id);
  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: RUNNER_ARTIFACT_KIND,
    title: `Container runner: ${resolved.image}`,
    status: "active",
    contentText: `${resolved.runtime} ${resolved.image} (${resolved.sync})`,
    metadata: { runner: config },
    createdBy: entity.name,
  });
  sendCode(
    ctx,
    eid,
    [
      `Commands now run in ${resolved.image} via ${resolved.runtime} (${resolved.sync} sync).`,
      dim(
        `Network ${resolved.network ? "on" : "off"}; ${resolved.cpus} CPU, ${resolved.memoryMb} MB, ${Math.round(resolved.timeoutMs / 1000)} s per command. Same allowlist and approvals as host runs; no host fallback.`,
      ),
    ].join("\n"),
    {
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      event: "runner_changed",
      sessionId: session.id,
      metadata: { runner: config },
      type: "lifecycle",
    },
  );
}

function retireRunners(db: MarinaDB, sessionId: string): number {
  let retired = 0;
  for (const row of db.listCodingArtifacts(sessionId, 200)) {
    if (row.kind === RUNNER_ARTIFACT_KIND && row.status === "active") {
      db.updateCodingArtifact(row.id, { status: "superseded" });
      retired += 1;
    }
  }
  return retired;
}
