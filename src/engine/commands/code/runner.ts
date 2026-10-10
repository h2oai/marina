// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `code workspace runner …` — where a session's finite commands run. The
 * default is the host (LocalWorkspace). `container` binds an image so tests and
 * scripts run inside it (src/coding/container-workspace.ts). The setting is a
 * per-session `workspace_runner` artifact (no schema change); the latest
 * active one wins, `local` retires it. Configuring a runner is gated like any
 * other execution change (`code.exec`, telnet refused) by the entry file.
 *
 * Operator policy wins (`operatorContainerPolicy`, `effectiveRunner`): when
 * the operator requires containers, `local` is refused and the image, runtime,
 * sync, workdir, shell and network are the operator's; a session tunes only
 * resource limits. An `init` preamble is operator-only everywhere. Without an
 * operator image, a session-chosen image or `network:on` needs the
 * `code.exec.unrestricted` gate (checked and recorded here).
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
import { checkGateForExecution, recordGateExecution } from "../../safety-gates";
import { type CodeDeps, parseJsonObject, resolveSession, sendCode } from "./shared";

export const RUNNER_ARTIFACT_KIND = "workspace_runner";

const USAGE = [
  "code workspace runner                       show where commands run",
  "code workspace runner local                 run on the host (unless the operator requires containers)",
  "code workspace runner container image:<ref> [sync:mount|patch] [workdir:/path]",
  "    [network:on] [cpus:N] [memory:MB] [timeout:10m] [shell:sh|bash]",
].join("\n");

const REQUIRED_REFUSAL =
  "Refused: the operator requires container execution for Code Mode (MARINA_CODE_CONTAINER_IMAGE / MARINA_CODE_CONTAINER_REQUIRED). Only the operator can allow host runs (MARINA_CODE_CONTAINER_REQUIRED=false).";

const INIT_REFUSAL =
  "Refused: an init preamble is operator configuration (MARINA_CODE_CONTAINER_INIT). It runs as shell text before the allowlisted command, so it cannot be set in-world.";

export type RunnerSetting =
  | { kind: "local" }
  | { kind: "container"; config: ContainerRunnerConfig };

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
 * The operator's container policy. Containers are REQUIRED when
 * `MARINA_CODE_CONTAINER_REQUIRED` is on, or when it is unset and
 * `MARINA_CODE_CONTAINER_IMAGE` names an image. Only
 * `MARINA_CODE_CONTAINER_REQUIRED=false` turns an operator image back into a
 * mere default that a session may leave for the host. Env-only by design:
 * nothing in-world can change it.
 */
export interface OperatorContainerPolicy {
  required: boolean;
  defaults: ContainerRunnerConfig | null;
}

export function operatorContainerPolicy(
  env: NodeJS.ProcessEnv = process.env,
): OperatorContainerPolicy {
  const defaults = envRunnerConfig(env);
  const raw = env.MARINA_CODE_CONTAINER_REQUIRED?.trim().toLowerCase() ?? "";
  const required = /^(1|true|on|yes)$/.test(raw)
    ? true
    : /^(0|false|off|no)$/.test(raw)
      ? false
      : defaults !== null;
  return { required, defaults };
}

/** The gate a session-chosen image or network access needs (`checkGateForExecution`). */
export const RUNNER_OVERRIDE_GATE = "code.exec.unrestricted";

/** Session-tunable fields under an operator image: resource limits only. */
const SESSION_LIMIT_KEYS = ["cpus", "memoryMb", "timeoutMs"] as const;

function sessionLimits(config: ContainerRunnerConfig): Partial<ContainerRunnerConfig> {
  const out: Partial<ContainerRunnerConfig> = {};
  for (const key of SESSION_LIMIT_KEYS) if (config[key] !== undefined) out[key] = config[key];
  return out;
}

export type EffectiveRunner =
  | { kind: "host" }
  | { kind: "container"; config: ContainerRunnerConfig }
  | { kind: "unavailable"; reason: string };

/**
 * What a session's commands actually run on, from its stored setting and the
 * operator policy. Applied on EVERY use, so a setting stored before a policy
 * change (or written around the command) never outranks the operator:
 * - required: a `local` pin is ignored; under an operator image, the image,
 *   runtime, sync, workdir, shell, network and init are the operator's and the
 *   session keeps only its resource limits;
 * - `init` is never taken from a session setting (operator-only);
 * - session network access survives only when the setting records that the
 *   override gate passed when it was configured.
 */
export function effectiveRunner(
  setting: RunnerSetting | null,
  env: NodeJS.ProcessEnv = process.env,
): EffectiveRunner {
  const policy = operatorContainerPolicy(env);
  const defaults = policy.defaults;
  if (setting?.kind === "container") {
    if (policy.required && defaults)
      return { kind: "container", config: { ...defaults, ...sessionLimits(setting.config) } };
    const {
      init: _ignored,
      gated,
      ...rest
    } = setting.config as ContainerRunnerConfig & {
      gated?: boolean;
    };
    const operatorImage = defaults !== null && defaults.image === rest.image;
    const config: ContainerRunnerConfig = {
      ...rest,
      network:
        (rest.network === true && gated === true) ||
        (operatorImage && defaults.network === true && rest.network !== false),
    };
    // The operator's preamble belongs to the operator's image.
    if (operatorImage && defaults.init) {
      config.init = defaults.init;
      if (defaults.shell) config.shell = defaults.shell;
    }
    return { kind: "container", config };
  }
  if (setting?.kind === "local" && !policy.required) return { kind: "host" };
  if (defaults) return { kind: "container", config: defaults };
  if (policy.required)
    return {
      kind: "unavailable",
      reason:
        "The operator requires a container runner (MARINA_CODE_CONTAINER_REQUIRED) and names no default image; configure one with `code workspace runner container image:<ref>`.",
    };
  return { kind: "host" };
}

/**
 * Wrap a session's host workspace in its container runner per
 * `effectiveRunner`. A configured runner that cannot resolve (no runtime, bad
 * image, or a policy with no image) yields a workspace whose every command
 * fails with that reason — never host execution.
 */
export function applySessionRunner(
  ws: WorkspaceRuntime,
  db: Pick<MarinaDB, "listCodingArtifacts"> | undefined,
  session: CodingSessionRow,
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceRuntime {
  if (session.execution_target !== "local" || !(ws instanceof LocalWorkspace)) return ws;
  const runner = effectiveRunner(db ? sessionRunnerSetting(db, session.id) : null, env);
  if (runner.kind === "host") return ws;
  if (runner.kind === "unavailable")
    return new UnavailableContainerWorkspace(ws.root, new Error(runner.reason), ws.fileGrants);
  try {
    return new ContainerWorkspace(
      ws.root,
      resolveContainerRunner(runner.config, env),
      undefined,
      ws.fileGrants,
    );
  } catch (error) {
    return new UnavailableContainerWorkspace(ws.root, error, ws.fileGrants);
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
    const policy = operatorContainerPolicy();
    const runner = effectiveRunner(setting);
    const config = runner.kind === "container" ? runner.config : null;
    const fromEnv = config !== null && (setting?.kind !== "container" || policy.required);
    const lines = [header("Code Runner"), separator()];
    if (runner.kind === "unavailable") {
      lines.push(`Unavailable: ${runner.reason}`);
    } else if (!config) {
      lines.push("Commands run on the host (local workspace).");
    } else {
      lines.push(
        `Commands run in container image ${config.image}${fromEnv ? dim(policy.required ? " (operator policy, MARINA_CODE_CONTAINER_IMAGE)" : " (operator default, MARINA_CODE_CONTAINER_IMAGE)") : ""}`,
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
    // Operator policy wins: only MARINA_CODE_CONTAINER_REQUIRED=false lets a
    // session leave an operator image for the host. No in-world path.
    if (operatorContainerPolicy().required) {
      sendCode(ctx, eid, REQUIRED_REFUSAL, {
        event: "runner_refused",
        sessionId: session.id,
        metadata: { requested: "local", reason: "operator_requires_container" },
        type: "lifecycle",
      });
      return;
    }
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
  // An init preamble is shell text run before the allowlisted command, outside
  // the allowlist, the approver and the exec_decision audit. It is operator
  // configuration only (MARINA_CODE_CONTAINER_INIT), never set in-world.
  if (init) {
    sendCode(ctx, eid, INIT_REFUSAL, {
      event: "runner_refused",
      sessionId: session.id,
      metadata: { requested: "container", reason: "init_operator_only" },
      type: "lifecycle",
    });
    return;
  }
  const policy = operatorContainerPolicy();
  const operator = policy.required ? policy.defaults : null;
  if (operator) {
    // Under an operator image the session tunes resource limits only.
    const requested = v.image ?? parsed.rest[0];
    const conflicts: string[] = [];
    const differs = (value: unknown, current: string | undefined, fallback: string) =>
      value !== undefined && String(value) !== (current ?? fallback);
    if (requested !== undefined && String(requested) !== operator.image) conflicts.push("image");
    if (differs(v.sync, operator.sync, "mount")) conflicts.push("sync");
    if (differs(v.workdir, operator.workdir, "/work")) conflicts.push("workdir");
    if (differs(v.shell, operator.shell, "sh")) conflicts.push("shell");
    if (
      v.runtime !== undefined &&
      String(v.runtime) !== process.env.MARINA_CODE_CONTAINER_RUNTIME?.trim()
    )
      conflicts.push("runtime");
    if (v.network === true && operator.network !== true) conflicts.push("network");
    if (conflicts.length > 0) {
      sendCode(
        ctx,
        eid,
        `Refused: the operator sets this world's container runner (MARINA_CODE_CONTAINER_*); a session cannot change ${conflicts.join(", ")}. Only cpus, memory and timeout are session settings here.`,
        {
          event: "runner_refused",
          sessionId: session.id,
          metadata: { requested: "container", reason: "operator_policy", fields: conflicts },
          type: "lifecycle",
        },
      );
      return;
    }
  }
  const config: ContainerRunnerConfig & { gated?: boolean } = operator
    ? {
        ...operator,
        ...(typeof v.cpus === "number" ? { cpus: v.cpus } : {}),
        ...(typeof v.memory === "number" ? { memoryMb: v.memory } : {}),
        ...(typeof v.timeout === "number" ? { timeoutMs: v.timeout } : {}),
      }
    : {
        image: String(v.image ?? parsed.rest[0] ?? ""),
        ...(v.sync !== undefined ? { sync: String(v.sync) as ContainerRunnerConfig["sync"] } : {}),
        ...(v.workdir !== undefined ? { workdir: String(v.workdir) } : {}),
        ...(v.network !== undefined ? { network: v.network === true } : {}),
        ...(typeof v.cpus === "number" ? { cpus: v.cpus } : {}),
        ...(typeof v.memory === "number" ? { memoryMb: v.memory } : {}),
        ...(typeof v.timeout === "number" ? { timeoutMs: v.timeout } : {}),
        ...(v.shell !== undefined
          ? { shell: String(v.shell) as ContainerRunnerConfig["shell"] }
          : {}),
        ...(v.runtime !== undefined
          ? { runtime: String(v.runtime) as ContainerRunnerConfig["runtime"] }
          : {}),
      };
  // Validate now so a bad setting is refused at configuration time, not on first use.
  const resolved = resolveContainerRunner(config);
  if (!operator) {
    // An image the operator did not name, or network access, widens what the
    // session's code can run or reach: earned or granted, never free in-world.
    const overrides = [
      ...(config.image !== policy.defaults?.image ? ["image"] : []),
      ...(config.network === true ? ["network"] : []),
    ];
    if (overrides.length > 0) {
      const gate = checkGateForExecution(deps.db, eid, RUNNER_OVERRIDE_GATE);
      if (!gate.ok) {
        sendCode(
          ctx,
          eid,
          gate.reason ??
            `Choosing a container ${overrides.join(" and ")} requires the ${RUNNER_OVERRIDE_GATE} capability.`,
          {
            event: "runner_refused",
            sessionId: session.id,
            metadata: { requested: "container", reason: "gate", fields: overrides },
            type: "lifecycle",
          },
        );
        return;
      }
      recordGateExecution(
        deps.db,
        eid,
        RUNNER_OVERRIDE_GATE,
        gate,
        `code workspace runner container ${overrides.join("+")}`,
      );
      if (config.network === true) config.gated = true;
    }
  }
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
