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
 * `sandbox` runs every finite command in a local bubblewrap OS sandbox
 * (src/coding/sandbox-workspace.ts): any command, no network, the home
 * directory hidden. `MARINA_CODE_SANDBOX=off|available|default` (operator,
 * env-only) refuses it, allows it, or makes it the runner for every local
 * session without an explicit setting. Choosing it needs only `code.exec`:
 * it is stricter than the host.
 *
 * Operator policy wins (`operatorContainerPolicy`, `effectiveRunner`): when
 * the operator requires containers, `local` is refused and the image, runtime,
 * sync, workdir, shell and network are the operator's; a session tunes only
 * resource limits. An `init` preamble is operator-only everywhere. Without an
 * operator image, a session-chosen image or `network:on` needs the
 * `code.exec.unrestricted` gate (checked and recorded here).
 */

import { existsSync, realpathSync } from "node:fs";
import {
  type ContainerRunnerConfig,
  ContainerWorkspace,
  resolveContainerRunner,
  UnavailableContainerWorkspace,
} from "../../../coding/container-workspace";
import { type EgressRule, formatEgressRule, parseEgressRules } from "../../../coding/egress-proxy";
import type { WorkspaceRuntime } from "../../../coding/local-workspace";
import { LocalWorkspace } from "../../../coding/local-workspace";
import {
  codeSandboxMode,
  gitHooksNotice,
  SANDBOX_RUN_NOTE,
  type SandboxTamperError,
  SandboxWorkspace,
  sandboxHooksFor,
  UnavailableSandboxWorkspace,
} from "../../../coding/sandbox-workspace";
import { dim, header, separator } from "../../../net/ansi";
import type { CodingSessionRow, MarinaDB } from "../../../persistence/database";
import type { Entity, EntityId, RoomContext } from "../../../types";
import { refuseCommand } from "../../command-response";
import { principalOf } from "../../gate-context";
import { notifyOperator } from "../../ops-notify";
import { parseModifiers, splitOnTerminator } from "../../parse-input";
import { checkGateForExecution, recordGateExecution } from "../../safety-gates";
import { type CodeDeps, parseJsonObject, resolveSession, sendCode } from "./shared";

export const RUNNER_ARTIFACT_KIND = "workspace_runner";
/** A destination a person allowed for one session (written only by an approved egress challenge). */
export const EGRESS_GRANT_ARTIFACT_KIND = "egress_grant";

const USAGE = [
  "code workspace runner                       show where commands run",
  "code workspace runner local                 run on the host (unless the operator requires containers)",
  "code workspace runner sandbox               run any command in a local OS sandbox (bubblewrap; no network)",
  "code workspace runner release               (a person) lift a sandbox hold after inspecting the repository",
  "code workspace runner container image:<ref> [sync:mount|patch] [workdir:/path]",
  "    [network:on] [cpus:N] [memory:MB] [timeout:10m] [shell:sh|bash]",
].join("\n");

const REQUIRED_REFUSAL =
  "Refused: the operator requires container execution for Code Mode (MARINA_CODE_CONTAINER_IMAGE / MARINA_CODE_CONTAINER_REQUIRED). Only the operator can allow host runs (MARINA_CODE_CONTAINER_REQUIRED=false).";

const INIT_REFUSAL =
  "Refused: an init preamble is operator configuration (MARINA_CODE_CONTAINER_INIT). It runs as shell text before the allowlisted command, so it cannot be set in-world.";

export type RunnerSetting =
  | { kind: "local" }
  | { kind: "sandbox" }
  | { kind: "container"; config: ContainerRunnerConfig };

const SANDBOX_REQUIRED_REFUSAL =
  "Refused: the operator requires the local sandbox for Code Mode (MARINA_CODE_SANDBOX=required). Only the operator can allow host or container runs.";

const SANDBOX_DEFAULT_AGENT_REFUSAL =
  "Refused: the sandbox is this world's default runner (MARINA_CODE_SANDBOX=default); only a person can move a session back to host execution.";

const SANDBOX_OFF_REASON =
  "The operator turned the sandbox runner off (MARINA_CODE_SANDBOX=off); choose `code workspace runner local` or a container. Sandbox runs never fall back to host execution.";

/** The session's explicit runner setting (`local` pins the host), if any. */
export function sessionRunnerSetting(
  db: Pick<MarinaDB, "listCodingArtifacts">,
  sessionId: string,
): RunnerSetting | null {
  // Kind and status filter in the query, before its limit: newer artifacts of
  // other kinds can never push the setting out of view (and fall back to the host).
  const artifact = db
    .listCodingArtifacts(sessionId, 1, RUNNER_ARTIFACT_KIND, "active")
    .find((row) => row.kind === RUNNER_ARTIFACT_KIND && row.status === "active");
  if (!artifact) return null;
  const runner = parseJsonObject(artifact.metadata_json).runner as
    | (ContainerRunnerConfig & { kind?: string })
    | undefined;
  if (runner?.kind === "local") return { kind: "local" };
  if (runner?.kind === "sandbox") return { kind: "sandbox" };
  return runner && typeof runner.image === "string" ? { kind: "container", config: runner } : null;
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
    ...(env.MARINA_CODE_CONTAINER_EGRESS?.trim()
      ? { egress: parseEgressRules(env.MARINA_CODE_CONTAINER_EGRESS) }
      : {}),
    ...(/^(1|true|on|yes)$/i.test(env.MARINA_CODE_CONTAINER_MODEL_API?.trim() ?? "")
      ? { modelApi: true }
      : {}),
    ...(env.MARINA_CODE_CONTAINER_MODEL_CAP_USD?.trim()
      ? { modelCapUsd: Number(env.MARINA_CODE_CONTAINER_MODEL_CAP_USD.trim()) }
      : {}),
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
  | { kind: "sandbox" }
  | { kind: "container"; config: ContainerRunnerConfig }
  | { kind: "unavailable"; reason: string };

/**
 * What a session's commands actually run on, from its stored setting and the
 * operator policy. Applied on EVERY use, so a setting stored before a policy
 * change (or written around the command) never outranks the operator:
 * - required: a `local` pin is ignored; under an operator image, the image,
 *   runtime, sync, workdir, shell, network and init are the operator's and the
 *   session keeps only its resource limits;
 * - `init` and the `egress` allowlist are never taken from a session setting
 *   (operator-only);
 * - session network access survives only when the setting records that the
 *   override gate passed when it was configured;
 * - `sandbox`: an operator-required container still wins; `MARINA_CODE_SANDBOX=off`
 *   makes a stored sandbox setting unavailable (never the host); `default`
 *   makes the sandbox the runner for sessions with no explicit setting and no
 *   operator image.
 */
export function effectiveRunner(
  setting: RunnerSetting | null,
  env: NodeJS.ProcessEnv = process.env,
): EffectiveRunner {
  const policy = operatorContainerPolicy(env);
  const defaults = policy.defaults;
  const sandboxMode = codeSandboxMode(env);
  // Sandbox required (and no required container, which still wins): no stored
  // setting leaves the sandbox. A `local` or container pin from an earlier
  // launch makes commands fail rather than run elsewhere.
  if (sandboxMode === "required" && !policy.required) {
    if (!setting || setting.kind === "sandbox") return { kind: "sandbox" };
    return {
      kind: "unavailable",
      reason: `The operator requires the local sandbox (MARINA_CODE_SANDBOX=required), but this session holds an earlier \`${setting.kind}\` runner setting, which no longer applies. Run \`code workspace runner sandbox\`.`,
    };
  }
  if (setting?.kind === "container") {
    if (policy.required && defaults)
      return { kind: "container", config: { ...defaults, ...sessionLimits(setting.config) } };
    const {
      init: _ignored,
      egress: _operatorOnly,
      modelApi: _operatorModel,
      modelCapUsd: _operatorCap,
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
    // So do its egress allowlist and model access.
    if (operatorImage && defaults.egress) config.egress = defaults.egress;
    if (operatorImage && defaults.modelApi) {
      config.modelApi = true;
      if (defaults.modelCapUsd !== undefined) config.modelCapUsd = defaults.modelCapUsd;
    }
    return { kind: "container", config };
  }
  if (setting?.kind === "sandbox" && !policy.required)
    return sandboxMode === "off"
      ? { kind: "unavailable", reason: SANDBOX_OFF_REASON }
      : { kind: "sandbox" };
  if (setting?.kind === "local" && !policy.required) return { kind: "host" };
  if (defaults) return { kind: "container", config: defaults };
  if (sandboxMode === "default" && !policy.required) return { kind: "sandbox" };
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
/**
 * Destinations people approved for this session. They extend an operator
 * allowlist only — never create network where the operator gave none.
 */
export function sessionEgressGrants(
  db: Pick<MarinaDB, "listCodingArtifacts">,
  sessionId: string,
): EgressRule[] {
  const rules: EgressRule[] = [];
  for (const row of db.listCodingArtifacts(sessionId, 1000, EGRESS_GRANT_ARTIFACT_KIND, "active")) {
    if (row.kind !== EGRESS_GRANT_ARTIFACT_KIND || row.status !== "active") continue;
    const rule = parseJsonObject(row.metadata_json).rule;
    if (typeof rule !== "string") continue;
    try {
      rules.push(...parseEgressRules(rule));
    } catch {
      // allow-empty-catch: a malformed stored grant allows nothing
    }
  }
  return rules;
}

/** Record a person's approval of `host:port` for the session (an `egress_grant` artifact). */
export function grantSessionEgress(
  db: Pick<MarinaDB, "createCodingArtifact" | "createCodingEvent">,
  sessionId: string,
  destination: { host: string; port: number },
  approval: { requester: string; token: string },
): void {
  const rule = `${destination.host}:${destination.port}`;
  // Validates the shape before anything is stored.
  parseEgressRules(rule);
  db.createCodingArtifact({
    sessionId,
    kind: EGRESS_GRANT_ARTIFACT_KIND,
    title: `Egress allowed: ${rule}`,
    status: "active",
    contentText: rule,
    metadata: { rule, challenge: approval.token },
    createdBy: approval.requester,
  });
  db.createCodingEvent({
    sessionId,
    actor: approval.requester,
    kind: "egress_granted",
    payload: { rule, challenge: approval.token },
  });
}

/** The runner with approved destinations added — only onto an operator allowlist. */
export function withEgressGrants(
  config: ContainerRunnerConfig,
  grants: readonly EgressRule[],
): ContainerRunnerConfig {
  if (!config.egress?.length || grants.length === 0) return config;
  return { ...config, egress: [...config.egress, ...grants] };
}

/** Core-memory owner of sandbox holds, keyed by the workspace root's realpath. */
export const SANDBOX_HOLD_OWNER = "sandbox:hold";

export interface SandboxHold {
  message: string;
  paths: string[];
  session: string;
  at: number;
}

type HoldDb = Partial<Pick<MarinaDB, "getCoreMemory">>;

/**
 * The hold on a workspace root (a detected submodule tamper), if any. Keyed by
 * the ROOT, not the session: a new `code start` on the same tree is held too.
 */
export function sandboxHold(db: HoldDb, root: string): SandboxHold | undefined {
  const row = db.getCoreMemory?.(SANDBOX_HOLD_OWNER, canonicalRoot(root));
  if (!row) return undefined;
  try {
    return JSON.parse(row.value) as SandboxHold;
  } catch {
    return { message: row.value, paths: [], session: "", at: 0 };
  }
}

function canonicalRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

type RunnerDb = Pick<MarinaDB, "listCodingArtifacts"> &
  HoldDb &
  Partial<Pick<MarinaDB, "createCodingEvent" | "setCoreMemory" | "upsertOperationalAlert">>;

/**
 * Record a hold on the workspace root: every command there fails, on any
 * runner and in any session, until a person releases it. Raises an ops-inbox
 * item for the session's owner and the operators, and an operator notice.
 */
function holdRoot(
  db: RunnerDb,
  session: CodingSessionRow,
  root: string,
  error: SandboxTamperError,
): void {
  const key = canonicalRoot(root);
  const hold: SandboxHold = {
    message: error.message,
    paths: error.paths,
    session: session.id,
    at: Date.now(),
  };
  db.setCoreMemory?.(SANDBOX_HOLD_OWNER, key, JSON.stringify(hold));
  db.createCodingEvent?.({
    sessionId: session.id,
    actor: "marina",
    kind: "sandbox_tamper",
    payload: { paths: error.paths, root: key },
  });
  const title = `Sandbox held: submodule git metadata changed in ${key}`;
  const detail = `paths ${error.paths.join(", ")} · session ${session.id} · owner ${session.created_by}`;
  db.upsertOperationalAlert?.({
    key: `${SANDBOX_HOLD_ALERT_PREFIX}${key}`,
    severity: "critical",
    category: "sandbox-hold",
    kind: "approval",
    title,
    detail,
    remedy:
      "inspect the repository's submodule .git links and module configs from a shell, then a person runs `code workspace runner release` in a session on that workspace",
    assignedTo: session.created_by,
    targetEntity: session.created_by,
    actionLabel: "code workspace runner release",
    metadata: { root: key, paths: error.paths, session: session.id },
  });
  void notifyOperator({
    event: "sandbox.hold",
    title: `Marina: ${title}`,
    detail,
    action: "code workspace runner release",
  });
}

export const SANDBOX_HOLD_ALERT_PREFIX = "sandbox-hold:";

export function applySessionRunner(
  ws: WorkspaceRuntime,
  db: RunnerDb | undefined,
  session: CodingSessionRow,
  env: NodeJS.ProcessEnv = process.env,
  /** A finite Marina-owned run (gate or base check): bind this directory at the sandbox's /tmp. */
  run: { scratchTmp?: string } = {},
): WorkspaceRuntime {
  if (session.execution_target !== "local" || !(ws instanceof LocalWorkspace)) return ws;
  // A held session runs nothing, on any runner, until a person releases it.
  const hold = db ? sandboxHold(db, ws.root) : undefined;
  if (hold) return new UnavailableSandboxWorkspace(ws.root, new Error(hold.message), ws.fileGrants);
  const runner = effectiveRunner(db ? sessionRunnerSetting(db, session.id) : null, env);
  if (runner.kind === "host") return ws;
  if (runner.kind === "sandbox") {
    try {
      return new SandboxWorkspace(
        ws.root,
        ws.fileGrants,
        run.scratchTmp ? { scratchTmp: run.scratchTmp } : {},
        (error) => (db ? holdRoot(db, session, ws.root, error) : undefined),
      );
    } catch (error) {
      return new UnavailableSandboxWorkspace(ws.root, error, ws.fileGrants);
    }
  }
  if (runner.kind === "unavailable")
    return new UnavailableContainerWorkspace(ws.root, new Error(runner.reason), ws.fileGrants);
  const config = withEgressGrants(
    runner.config,
    db && runner.config.egress?.length ? sessionEgressGrants(db, session.id) : [],
  );
  try {
    return new ContainerWorkspace(
      ws.root,
      resolveContainerRunner(config, env),
      undefined,
      ws.fileGrants,
      { entityName: session.created_by, sessionId: session.id },
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
    const hold = sandboxHold(deps.db, sessionRoot(session));
    if (hold) {
      lines.push(`Held: ${hold.message}`);
    } else if (runner.kind === "unavailable") {
      lines.push(`Unavailable: ${runner.reason}`);
    } else if (runner.kind === "sandbox") {
      lines.push(
        `Commands run in a local OS sandbox (bubblewrap)${setting?.kind === "sandbox" ? "" : dim(" (operator default, MARINA_CODE_SANDBOX=default)")}.`,
      );
      lines.push(dim(SANDBOX_RUN_NOTE));
      const hooks = sandboxHooksFor(sessionRoot(session));
      if (hooks.length) lines.push(gitHooksNotice(hooks));
      try {
        new SandboxWorkspace(sessionRoot(session));
      } catch (error) {
        lines.push(`Unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (!config) {
      lines.push("Commands run on the host (local workspace).");
    } else {
      lines.push(
        `Commands run in container image ${config.image}${fromEnv ? dim(policy.required ? " (operator policy, MARINA_CODE_CONTAINER_IMAGE)" : " (operator default, MARINA_CODE_CONTAINER_IMAGE)") : ""}`,
      );
      lines.push(
        `Sync: ${config.sync ?? "mount"} · workdir ${config.workdir ?? "/work"} · network ${networkLabel(config)}`,
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
      metadata: { runner: config ?? { kind: runner.kind === "sandbox" ? "sandbox" : "local" } },
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
    const sandboxMode = codeSandboxMode();
    if (sandboxMode === "required") {
      refuseRunner(
        ctx,
        eid,
        entity,
        deps,
        session,
        SANDBOX_REQUIRED_REFUSAL,
        "local",
        "operator_requires_sandbox",
      );
      return;
    }
    // Under `default` an agent cannot take its own session out of the sandbox.
    if (sandboxMode === "default" && principalOf(eid) !== "person") {
      refuseRunner(
        ctx,
        eid,
        entity,
        deps,
        session,
        SANDBOX_DEFAULT_AGENT_REFUSAL,
        "local",
        "agent_leaves_default_sandbox",
      );
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

  if (action === "sandbox") {
    handleSandboxRunner(ctx, eid, entity, deps, session);
    return;
  }

  if (action === "release") {
    releaseHold(ctx, eid, entity, deps, session);
    return;
  }

  if (action !== "container") {
    refuseCommand(ctx, eid, `Usage:\n${USAGE}`);
    return;
  }
  if (codeSandboxMode() === "required" && !operatorContainerPolicy().required) {
    refuseRunner(
      ctx,
      eid,
      entity,
      deps,
      session,
      SANDBOX_REQUIRED_REFUSAL,
      "container",
      "operator_requires_sandbox",
    );
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
        `Network ${networkLabel(resolved)}; ${resolved.cpus} CPU, ${resolved.memoryMb} MB, ${Math.round(resolved.timeoutMs / 1000)} s per command. Same allowlist and approvals as host runs; no host fallback.`,
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

/**
 * `code workspace runner sandbox`. Stricter than the host, so `code.exec`
 * (checked by the entry file) is the only gate; the operator's container
 * requirement and `MARINA_CODE_SANDBOX=off` refuse it. Validated now (bwrap
 * present, a git root) so a broken setting is refused, not stored.
 */
function handleSandboxRunner(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  session: CodingSessionRow,
): void {
  const refuse = (message: string, reason: string) => {
    refuseCommand(ctx, eid, message);
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "runner_refused",
      payload: { requested: "sandbox", reason },
    });
  };
  if (session.execution_target !== "local") {
    refuse(
      "A sandbox runner applies to local workspaces; this session runs in a sandbox provider.",
      "not_local",
    );
    return;
  }
  if (operatorContainerPolicy().required) {
    refuse(REQUIRED_REFUSAL, "operator_requires_container");
    return;
  }
  if (codeSandboxMode() === "off") {
    refuse(SANDBOX_OFF_REASON, "sandbox_off");
    return;
  }
  try {
    new SandboxWorkspace(sessionRoot(session));
  } catch (error) {
    refuse(
      `Refused: ${error instanceof Error ? error.message : String(error)}`,
      "sandbox_unavailable",
    );
    return;
  }
  retireRunners(deps.db, session.id);
  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: RUNNER_ARTIFACT_KIND,
    title: "Sandbox runner (bubblewrap)",
    status: "active",
    contentText: "sandbox",
    metadata: { runner: { kind: "sandbox" } },
    createdBy: entity.name,
  });
  sendCode(
    ctx,
    eid,
    ["Commands now run in a local OS sandbox (bubblewrap).", dim(SANDBOX_RUN_NOTE)].join("\n"),
    {
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      event: "runner_changed",
      sessionId: session.id,
      metadata: { runner: { kind: "sandbox" } },
      type: "lifecycle",
    },
  );
}

function refuseRunner(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  session: CodingSessionRow,
  message: string,
  requested: string,
  reason: string,
): void {
  refuseCommand(ctx, eid, message);
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "runner_refused",
    payload: { requested, reason },
  });
}

/**
 * `code workspace runner release`: a PERSON who has inspected the repository
 * lifts a sandbox hold. Agents are refused: the hold exists because sandboxed
 * code may have planted git metadata.
 */
function releaseHold(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  session: CodingSessionRow,
): void {
  const root = canonicalRoot(sessionRoot(session));
  if (!sandboxHold(deps.db, root)) {
    ctx.send(eid, "No sandbox hold on this workspace.");
    return;
  }
  if (principalOf(eid) !== "person") {
    refuseRunner(
      ctx,
      eid,
      entity,
      deps,
      session,
      "Refused: only a person who has inspected the repository's submodule git metadata can release a sandbox hold.",
      "release",
      "agent_release",
    );
    return;
  }
  deps.db.deleteCoreMemory(SANDBOX_HOLD_OWNER, root);
  for (const alert of deps.db.listOperationalAlerts("open", 500))
    if (alert.alert_key === `${SANDBOX_HOLD_ALERT_PREFIX}${root}`)
      deps.db.setOperationalAlertStatus(alert.id, "resolved");
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "sandbox_hold_released",
    payload: { root },
  });
  sendCode(ctx, eid, "Sandbox hold released; commands run again.", {
    event: "runner_changed",
    sessionId: session.id,
    metadata: { released: true },
    type: "lifecycle",
  });
}

/** One line naming where a session's commands run (start/welcome lines). */
export function runnerSummary(
  db: Pick<MarinaDB, "listCodingArtifacts"> & HoldDb,
  session: CodingSessionRow,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (session.execution_target !== "local")
    return `Runner: sandbox provider ${session.execution_target}`;
  if (sandboxHold(db, sessionRoot(session)))
    return "Runner: held after a sandbox security check (code workspace runner)";
  const runner = effectiveRunner(sessionRunnerSetting(db, session.id), env);
  switch (runner.kind) {
    case "host":
      return "Runner: host (allowlisted commands; code run allowlist)";
    case "sandbox": {
      const hooks = sandboxHooksFor(sessionRoot(session));
      return `Runner: local OS sandbox (bubblewrap): any command, no network, home hidden${hooks.length ? `\n${gitHooksNotice(hooks)}` : ""}`;
    }
    case "container":
      return `Runner: container ${runner.config.image}`;
    default:
      return `Runner: unavailable: ${runner.reason}`;
  }
}

/** The root a session's commands run in (its worktree when one is bound). */
function sessionRoot(session: CodingSessionRow): string {
  return session.worktree_path && existsSync(session.worktree_path)
    ? session.worktree_path
    : session.workspace_root;
}

function retireRunners(db: MarinaDB, sessionId: string): number {
  return retireActive(db, sessionId, RUNNER_ARTIFACT_KIND);
}

/** Supersede every active artifact of one kind (queried by kind and status, so none is missed). */
function retireActive(db: MarinaDB, sessionId: string, kind: string): number {
  let retired = 0;
  for (let pass = 0; pass < 100; pass++) {
    const rows = db.listCodingArtifacts(sessionId, 500, kind, "active");
    if (rows.length === 0) break;
    for (const row of rows) db.updateCodingArtifact(row.id, { status: "superseded" });
    retired += rows.length;
  }
  return retired;
}

/** `on`, `off`, or the egress allowlist that governs instead. */
function networkLabel(
  config: Pick<ContainerRunnerConfig, "network" | "egress"> & {
    modelApi?: boolean | { capUsd: number };
  },
): string {
  if (config.egress?.length)
    return `allowlist (${config.egress.map(formatEgressRule).join(", ")}) via Marina's proxy${config.modelApi ? ", plus Marina's model API at http://marina.model/v1" : ""}`;
  return config.network ? "on" : "off";
}
