// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseCommandArgv } from "../../../coding/command-argv";
import {
  type DeliveryRequirement,
  requirementCoverage,
  requirementLines,
} from "../../../coding/delivery";
import {
  clearSessionExecState,
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
import {
  detectWorkspaceRunner,
  isTestCommand,
  workspaceTouchedPaths,
} from "../../../coding/project-detection";
import {
  aggregateVerification,
  classifyStep,
  detectedSteps,
  executePreparation,
  findRelevantTests,
  isPytestCommand,
  isVerificationStop,
  OUTCOME_STATUS,
  PREPARATION_PROBES,
  type PreparationPlan,
  type PreparationResult,
  type PythonTestFallback,
  planPreparation,
  pytestUnavailable,
  pythonTestFallback,
  recipeSteps,
  resolveVerificationOptions,
  type StepOutcome,
  type StepPlan,
  stopCause,
  stopOnRefusal,
  type VerificationOptions,
  type VerificationOutcome,
  type VerificationStep,
  type VerificationVerdict,
  withFallbackRunner,
} from "../../../coding/verification-plan";
import { summarizeFlywheelEvents, WorkspaceGateway } from "../../../coding/workspace-gateway";
import { lessonsBlock, recallForWork } from "../../../learning/service";
import { noteWorkFor, workScopeFor } from "../../../learning/work";
import { dim, error as fmtError, header, separator, success } from "../../../net/ansi";
import { isLoopbackIp } from "../../../net/loopback";
import { recordVerification } from "../../../outcomes/live";
import type { CodingArtifactRow, CodingSessionRow, MarinaDB } from "../../../persistence/database";
import type { Connection, Entity, EntityId, RoomContext } from "../../../types";
import { getRank } from "../../permissions";
import { isLocalUngated } from "../../trust-profile";
import {
  findStoredRecipe,
  parseRecipeCommands,
  resolveRecipeCommands,
  showArtifact,
} from "./artifacts";
import {
  type CodeDeps,
  canAdoptCodingSession,
  entityNameForm,
  getCodeProfile,
  parseJsonObject,
  resolveSession,
  sameEntityName,
  sendCode,
  updateCodeContext,
} from "./shared";
import { detectPackageScripts, workspaceForSession } from "./workspace";

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

  const { command, fallback } = await resolveTestShorthand(deps, session, args);
  // The fallback runs like any command: same allowlist, approver and gates.
  const { artifact, result } = await executeWorkspaceCommand(entity, deps, session, command);
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  // A fallback runner's zero exit is a pass only when it reports tests ran.
  const outcome = fallback
    ? classifyStep({ command: fallback.command, role: "tests", requireTestCount: true }, result)
    : undefined;
  const text = fallback
    ? [
        dim(`runner: ${fallback.runner} (pytest unavailable)`),
        formatRunOutput(artifact.id, result),
        ...(outcome && outcome.outcome !== "passed"
          ? [`Tests ${OUTCOME_LABEL[outcome.outcome]}: ${outcome.reason}.`]
          : []),
      ].join("\n")
    : formatRunOutput(artifact.id, result);

  sendCode(ctx, eid, text, {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    command: result.command,
    commands: [`code show ${artifact.id}`, `code run --argv ${JSON.stringify(result.command)}`],
    content: result.output,
    durationMs: result.durationMs,
    event: "command_ran",
    exitCode: result.exitCode,
    ...(fallback && outcome
      ? {
          metadata: {
            testRunner: {
              runner: fallback.runner,
              fallbackFrom: "pytest",
              reason: "pytest unavailable",
            },
            outcome: outcome.outcome,
            outcomeReason: outcome.reason,
          },
        }
      : {}),
    sessionId: session.id,
    status:
      outcome && outcome.outcome !== "passed" && outcome.outcome !== "failed"
        ? outcome.outcome
        : artifact.status,
    timedOut: result.timedOut,
    truncated: result.truncated,
    type: "command",
  });
}

/**
 * `code test` / `code run test` follows the project's detected runner when the
 * project (or the touched files) is not JavaScript — `python -m pytest`,
 * `python tests/runtests.py`, `cargo test`, `go test ./...` — instead of
 * always meaning `bun run test`. Other shorthands are unchanged. A detected
 * pytest that the fixed probe shows is not importable switches to the
 * project's test script or `python -m unittest` (`pythonTestFallback`).
 */
async function resolveTestShorthand(
  deps: CodeDeps & { db: MarinaDB },
  session: CodingSessionRow,
  args: string[],
): Promise<{ command: string[]; fallback?: PythonTestFallback }> {
  if (args.length === 1 && args[0]?.toLowerCase() === "test") {
    const workspace = workspaceForSession(deps, session);
    // allow-empty-catch: undetectable runner falls back to the default test command
    const runner = await detectWorkspaceRunner(workspace).catch(() => null);
    // The detected test command (a bare `test` for Bun still means `bun run test`).
    const test = runner?.testCommand;
    if (test) {
      if (
        runner.language === "python" &&
        isPytestCommand(test) &&
        session.execution_target === "local" &&
        workspace.runPreparationStep
      ) {
        const probe = await workspace
          .runPreparationStep([...PREPARATION_PROBES.pytest])
          // allow-empty-catch: a failed probe means unknown; the test run reports for itself
          .catch(() => null);
        if (probe && pytestUnavailable(probe)) {
          const fallback = pythonTestFallback(workspace.displayRoot());
          return { command: normalizeCodeRunArgs(parseCommandArgv(fallback.command)), fallback };
        }
      }
      return { command: normalizeCodeRunArgs(parseCommandArgv(test)) };
    }
  }
  return { command: normalizeCodeRunArgs(args) };
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
  // allow-empty-catch: a missing package.json means no package scripts
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
  const runner = await detectWorkspaceRunner(workspace);
  const detected = runner.verify;
  const stored = deps.db
    .listCodingArtifacts(session.id, 50)
    .filter((artifact) => artifact.kind === "run_recipe" && artifact.status === "active");
  const lines = [header("Code Recipes"), separator()];
  lines.push(
    `Detected verify: ${detected.length > 0 ? detected.join(" then ") : "git diff --check"}${detected.length > 0 ? dim(` (${runner.reason})`) : ""}`,
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
  options: VerificationOptions = resolveVerificationOptions(),
): Promise<void> {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const workspace = workspaceForSession(deps, session);
  const plan = await planVerification(deps, session, workspace, options);
  await runVerificationCommands(
    ctx,
    eid,
    entity,
    deps,
    session,
    plan.commands,
    "Verification",
    undefined,
    plan,
  );
}

/** What `code verify` will do: preparation, then ordered steps, with the reasons. */
export interface VerificationRun {
  commands: string[];
  steps: StepPlan;
  options: VerificationOptions;
  language?: string;
  preparation?: PreparationPlan;
  workspace?: WorkspaceRuntime;
  /** Paths the change touches (reused for a candidate snapshot of the same bytes). */
  touched?: string[];
  /**
   * Steps to run instead when preparation finds pytest is not importable
   * (`PreparationPlan.fallback`): the same plan with the fallback runner.
   */
  fallback?: { runner: string; commands: string[]; steps: StepPlan };
}

/**
 * Plan a verification for a workspace (the live session workspace, or a
 * candidate snapshot under the same runner). A stored `default` recipe runs as
 * written; otherwise the detected project decides preparation, type-check and
 * test scope. Sandbox (Flywheel) sessions keep their recipe and no preparation.
 */
export async function planVerification(
  deps: CodeDeps & { db: MarinaDB },
  session: CodingSessionRow,
  workspace: WorkspaceRuntime,
  options: VerificationOptions,
  candidate = false,
  knownTouched?: readonly string[],
): Promise<VerificationRun> {
  const recipe = await resolveRecipeCommands(deps.db, session, workspace, "default");
  if (session.execution_target !== "local") {
    const commands = recipe ?? ["git diff --check"];
    return { commands, steps: recipeSteps(commands), options };
  }
  const touched = knownTouched
    ? [...knownTouched]
    : await workspaceTouchedPaths(workspace).catch(() => [] as string[]);
  // allow-empty-catch: undetectable runner falls back to the stored or default recipe
  const detected = await detectWorkspaceRunner(workspace, touched).catch(() => null);
  // A stored recipe decides what runs, so preparation probes for what IT needs:
  // a Python recipe without pytest (unittest, a test script) needs Python only.
  const profile =
    detected && recipe && detected.language === "python"
      ? { ...detected, testCommand: recipe.find(isTestCommand) }
      : detected;
  const runner = workspace.describe?.().runner;
  const preparation = profile
    ? planPreparation(profile, options.dependencies, {
        installsPermitted: workspace.installsPermitted?.() ?? false,
        hostCandidate: candidate && !runner,
        ephemeral: runner?.sync === "patch",
      })
    : undefined;
  if (recipe)
    return {
      commands: recipe,
      steps: recipeSteps(recipe),
      options,
      preparation,
      workspace,
      touched,
    };
  if (!profile || profile.language === "unknown") {
    const commands = ["git diff --check"];
    return { commands, steps: recipeSteps(commands), options, workspace, touched };
  }
  const root = workspace.displayRoot();
  const relevant =
    options.scope === "full"
      ? { files: [], reasons: [], packages: [] }
      : findRelevantTests(root, profile, touched);
  const exists = (path: string) => existsSync(join(root, path));
  const steps = detectedSteps({ profile, options, touched, relevant, exists });
  // pytest may be missing where the checks run: plan the switch now, so the
  // fallback commands are known (and admitted) before anything spawns.
  let fallback: VerificationRun["fallback"];
  if (profile.language === "python" && isPytestCommand(profile.testCommand) && preparation?.probe) {
    const runner = pythonTestFallback(root);
    const planned = detectedSteps({
      profile: withFallbackRunner(profile, runner),
      options,
      touched,
      relevant,
      exists,
    });
    const fallbackSteps: StepPlan = {
      ...planned,
      steps: planned.steps.map((step) =>
        step.role === "tests" || step.role === "full-tests"
          ? { ...step, requireTestCount: true }
          : step,
      ),
    };
    fallback = {
      runner: runner.runner,
      commands: fallbackSteps.steps.map((step) => step.command),
      steps: fallbackSteps,
    };
    preparation.fallback = runner.runner;
  }
  return {
    commands: steps.steps.map((step) => step.command),
    steps,
    options,
    language: profile.language,
    preparation,
    workspace,
    touched,
    ...(fallback ? { fallback } : {}),
  };
}

const OUTCOME_LABEL: Record<VerificationOutcome, string> = {
  passed: "passed",
  failed: "failed",
  not_run: "not run",
  error: "error",
};

export async function runVerificationCommands(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  session: CodingSessionRow,
  commands: string[],
  titlePrefix: string,
  background?: {
    receiptId: string;
    workspace: WorkspaceRuntime;
    beforeSpawn: () => void;
    candidateId?: string;
    candidateEvidence?: () => Promise<Record<string, unknown>>;
  },
  plan?: VerificationRun,
): Promise<CodingArtifactRow> {
  let stepPlan = plan?.steps ?? recipeSteps(commands);
  const preparationWorkspace = background?.workspace ?? plan?.workspace;
  // An authority refusal before a spawn aborts the run (never a check outcome).
  const guarded = background
    ? { ...background, beforeSpawn: stopOnRefusal(background.beforeSpawn)! }
    : undefined;
  let preparation: PreparationResult | undefined;
  try {
    preparation =
      plan?.preparation && preparationWorkspace && session.execution_target === "local"
        ? await executePreparation(plan.preparation, preparationWorkspace, guarded?.beforeSpawn)
        : undefined;
  } catch (error) {
    throw stopCause(error);
  }
  // pytest is not importable here: run the planned fallback runner instead.
  const fallback = preparation?.fallback ? plan?.fallback : undefined;
  if (fallback) stepPlan = fallback.steps;
  else if (preparation?.fallback && plan?.preparation)
    preparation = {
      ...preparation,
      status: "not_run",
      reason: plan.preparation.missingReason,
      fallback: undefined,
    };
  const lastRun = preparation?.runs.at(-1);
  const preparationArtifact =
    preparation && lastRun
      ? deps.db.createCodingArtifact({
          sessionId: session.id,
          kind: "command_output",
          title: preparation.policy ? "Candidate dependency preparation" : "Dependency preparation",
          status:
            preparation.status === "installed" || preparation.status === "ready"
              ? "complete"
              : "failed",
          contentText: preparation.runs
            .map((run) => `$ ${run.command.join(" ")}\n${run.output}`)
            .join("\n\n"),
          metadata: {
            command: lastRun.command,
            exitCode: lastRun.exitCode,
            timedOut: lastRun.timedOut,
            truncated: lastRun.truncated,
            durationMs: lastRun.durationMs,
            phase: "dependency-preparation",
            outcome: preparation.status,
            reason: preparation.reason,
            policy: preparation.policy,
            lockfileSha256: preparation.lockfileSha256,
            candidateId: background?.candidateId,
            ...(background?.candidateId ? { executionLocation: "candidate-materialization" } : {}),
          },
          createdBy: entity.name,
        })
      : undefined;
  const blocked = preparation?.status === "not_run" || preparation?.status === "error";
  const ran: RanStep[] = [];
  for (const step of blocked ? [] : stepPlan.steps) {
    const text =
      preparation?.wrapTests && /^python3?\s/.test(step.command)
        ? `${preparation.wrapTests} ${step.command}`
        : step.command;
    const command = normalizeCodeRunArgs(parseCommandArgv(text));
    let stored: StoredCommandResult | undefined;
    let outcome: StepOutcome;
    try {
      stored = await executeWorkspaceCommand(
        entity,
        deps,
        session,
        command,
        guarded,
        step.timeoutMs,
      );
      outcome = classifyStep(step, stored.result);
    } catch (error) {
      if (isVerificationStop(error)) throw stopCause(error);
      outcome = classifyStep(step, error instanceof Error ? error : new Error(String(error)));
    }
    ran.push({ step, command, stored, outcome });
    if (outcome.outcome === "failed" || outcome.outcome === "error") break;
  }
  const verdict = aggregateVerification({
    preparation,
    steps: ran,
    testsPlanned: stepPlan.testsPlanned,
    scopeNote: stepPlan.scopeNote,
  });
  const results = ran.flatMap((item) => (item.stored ? [item.stored] : []));
  const failedRun = ran.find((item) => item.outcome.outcome === verdict.outcome && item.stored);
  const status = OUTCOME_STATUS[verdict.outcome];
  const passed = verdict.outcome === "passed";
  const failed = verdict.outcome === "failed";
  const candidateEvidence = await background?.candidateEvidence?.();
  const relevant = stepPlan.relevant;
  // Delivery receipts say which stated requirements these steps observed (index-aligned).
  const coverage = Array.isArray(candidateEvidence?.requirements)
    ? requirementCoverage(
        { requirements: candidateEvidence.requirements as DeliveryRequirement[] },
        ran.map((item) => ({ command: item.command, outcome: item.outcome.outcome })),
      )
    : undefined;
  const summary =
    (preparationArtifact
      ? `Dependency preparation: ${preparationArtifact.status} (${preparationArtifact.id}).${blocked ? " Checks were not run." : preparation?.policy ? " Install scripts disabled." : ""}\n`
      : "") +
    (fallback ? `${dim(`runner: ${fallback.runner} (pytest unavailable)`)}\n` : "") +
    formatVerificationSummary(verdict, ran, preparation) +
    (!passed && failedRun?.stored
      ? `\nCheck output (untrusted command output):\n${failedRun.stored.result.output.slice(-4096)}\nFull output: code show ${failedRun.stored.artifact.id}`
      : "") +
    (plan && stepPlan.scopeNote !== "configured recipe"
      ? `\n${dim(`Scope: ${stepPlan.scopeNote}.${relevant?.files.length ? ` Relevant tests: ${relevant.files.slice(0, 8).join(", ")}${relevant.files.length > 8 ? ", …" : ""}` : ""}`)}`
      : "") +
    (candidateEvidence?.delivery
      ? `\nDelivery checks used only the manifest's files in a clean working directory under the configured runner. The inventory and digests are saved. Check coverage and task acceptance still require review.${
          coverage
            ? `\nRequirements:\n${requirementLines(coverage)
                .map((line) => `- ${line}`)
                .join("\n")}`
            : ""
        }`
      : candidateEvidence
        ? `\nCandidate evidence: ${candidateEvidence.freshness}. Source snapshot: ${candidateEvidence.candidateId}.\nRecipe: ${candidateEvidence.recipeType}.${typeof candidateEvidence.observedAt === "number" ? `\nObserved: ${new Date(candidateEvidence.observedAt).toISOString()}` : ""}${candidateEvidence.freshnessReason ? `\n${candidateEvidence.freshnessReason}` : ""}`
        : "\nLive-workspace check results; no immutable candidate binding.");
  const runner = (background?.workspace ?? plan?.workspace)?.describe?.().runner;
  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: "verification",
    title: `${titlePrefix} ${OUTCOME_LABEL[verdict.outcome]}`,
    status,
    contentText: summary,
    metadata: {
      ...candidateEvidence,
      ...(coverage ? { requirementCoverage: coverage } : {}),
      workspace: session.worktree_path ?? session.workspace_root,
      executionTarget: session.execution_target,
      ...(background ? { requestId: background.receiptId } : {}),
      outcome: verdict.outcome,
      outcomeReason: verdict.reason,
      ...(plan?.language ? { language: plan.language } : {}),
      ...(fallback
        ? {
            testRunner: {
              runner: fallback.runner,
              fallbackFrom: "pytest",
              reason: "pytest unavailable",
            },
          }
        : {}),
      ...(plan
        ? {
            verificationOptions: plan.options,
            scope: plan.options.scope,
            scopeNote: stepPlan.scopeNote,
            ...(relevant?.files.length || relevant?.packages.length
              ? { relevantTests: [...relevant.files, ...relevant.packages] }
              : {}),
          }
        : {}),
      runner: runner ? { kind: "container", image: runner.image, sync: runner.sync } : undefined,
      steps: ran.map((item) => ({
        command: item.command,
        role: item.step.role,
        outcome: item.outcome.outcome,
        reason: item.outcome.reason,
        artifactId: item.stored?.artifact.id,
      })),
      ...(preparation
        ? {
            preparation: {
              outcome: preparation.status,
              reason: preparation.reason,
              ...(preparationArtifact
                ? {
                    policy: preparation.policy,
                    lockfileSha256: preparation.lockfileSha256,
                    status: preparationArtifact.status,
                  }
                : {}),
            },
          }
        : {}),
      ...(preparationArtifact ? { preparationArtifactId: preparationArtifact.id } : {}),
      commands: results.map((item) => item.result.command),
      artifactIds: results.map((item) => item.artifact.id),
      exitCode: passed ? 0 : (failedRun?.stored?.result.exitCode ?? null),
      stoppedAt: passed ? undefined : (failedRun?.command ?? undefined),
    },
    createdBy: entity.name,
  });
  // Only a check that ran teaches: not_run and error are neither a pass nor a failure.
  // One outcome on the shared path: lessons scoped to whose work it was, and
  // evidence of what this agent's model and role get done.
  if (passed || failed)
    recordVerification(deps.db, {
      artifactId: artifact.id,
      actor: entity.name,
      passed,
      commands: results.map((item) => item.result.command),
      detail: failed
        ? `failed at ${failedRun?.command.join(" ") ?? "a check"} (exit ${failedRun?.stored?.result.exitCode})`
        : `passed ${results.length} check${results.length === 1 ? "" : "s"}`,
      sessionId: session.id,
    });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "verification_ran",
    payload: {
      id: artifact.id,
      status,
      outcome: verdict.outcome,
      commands: results.map((item) => item.result.command),
      artifactIds: results.map((item) => item.artifact.id),
    },
  });
  const currentEntity = background ? deps.getEntity(eid) : entity;
  const currentSession = deps.db.getCodingSession(session.id) ?? session;
  if (currentEntity && (!background || canAdoptCodingSession(currentSession, currentEntity)))
    updateCodeContext(currentEntity, deps.db, currentSession);

  // A failure brings back what earlier verifications and tool work taught about
  // this kind of work (`code` and `tools` lessons — lessons from work land in
  // `tools`) — the actor's own lessons (its owner's, for a spawned coder) with
  // the shared pool — plus cross-board method lessons within a third of the
  // budget (MARINA_LESSONS / MARINA_LESSONS_META; observe records the ids
  // without showing them).
  const lessons = failed
    ? await recallForWork(
        deps.db,
        ["code", "tools"],
        `${results.map((item) => item.result.command.join(" ")).join(" ")} ${(failedRun?.stored?.result.output ?? "").slice(-300)}`,
        { limit: 3, maxBytes: 600, ...lessonOwner(deps.db, entity.name) },
      )
    : undefined;
  const lessonText = lessons?.inject.length ? `\n${lessonsBlock(lessons.inject)}` : "";
  sendCode(ctx, eid, `${summary}${lessonText}\n${dim(`verification artifact: ${artifact.id}`)}`, {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    commands: ["code show last", "code verify"],
    content: `${summary}${lessonText}`,
    event: "verification_ran",
    metadata: {
      runId: JSON.parse(artifact.metadata_json).runId,
      outcome: verdict.outcome,
      outcomeReason: verdict.reason,
      ...(candidateEvidence?.delivery ? { delivery: candidateEvidence.delivery } : {}),
      ...(lessons?.recalled.length
        ? {
            lessons: lessons.recalled.map((l) => l.id ?? "?"),
            lessonsMode: lessons.mode,
          }
        : {}),
    },
    // Only checks that ran report an exit code; not_run/error are not failures.
    ...(passed || failed
      ? { exitCode: passed ? 0 : (failedRun?.stored?.result.exitCode ?? 1) }
      : {}),
    sessionId: session.id,
    status,
    type: "verification",
  });
  return artifact;
}

interface StoredCommandResult {
  artifact: CodingArtifactRow;
  result: WorkspaceRunResult;
}

interface RanStep {
  step: VerificationStep;
  command: string[];
  stored?: StoredCommandResult;
  outcome: StepOutcome;
}

async function executeWorkspaceCommand(
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  session: CodingSessionRow,
  command: string[],
  background?: { workspace: WorkspaceRuntime; beforeSpawn: () => void; candidateId?: string },
  timeoutMs?: number,
): Promise<StoredCommandResult> {
  const workspace = background?.workspace ?? workspaceForSession(deps, session);
  // Arbitrary (non-allowlisted) host exec is fenced by an optional approver,
  // attached per-call to the local workspace only. Off the allowlist, the
  // workspace consults it; with none attached, behavior is allowlist-only.
  if (!background && session.execution_target === "local") {
    workspace.attachExecApprover?.(selectExecApprover(entity, deps, session), entity.id);
  }
  const execution = background
    ? {
        target: "local" as const,
        result: await workspace.runAllowlisted!(command, background.beforeSpawn, timeoutMs),
        flywheelEvents: undefined,
      }
    : await new WorkspaceGateway(workspace, deps.flywheel).run(
        entity.id,
        session.execution_target,
        command,
        timeoutMs ?? 120_000,
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
      ...(background?.candidateId
        ? {
            candidateId: background.candidateId,
            executionLocation: "candidate-materialization",
          }
        : {}),
      flywheelEventKinds,
      cwd:
        session.execution_target === "flywheel"
          ? deps.db.listFlywheelBindings().find((row) => row.entity_id === entity.id)?.guest_cwd
          : workspace.displayRoot(),
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

// Per-session exec policy. Explicit off overrides the profile default.
// In-memory only; a restart drops overrides and re-applies the instance's policy.
const execModes = new Map<string, "prompt" | "auto" | "off">();

/** Drop a closed session's exec-mode override (called with `clearSessionExecState`). */
export function clearSessionExecMode(sessionId: string): void {
  execModes.delete(sessionId);
}

/** Exported for tests: the session's exec-mode override, if any. */
export function sessionExecModeForTests(sessionId: string): "prompt" | "auto" | "off" | undefined {
  return execModes.get(sessionId);
}

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
  return isLoopbackIp(conn.peerIp);
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
      title: `${decision.approved ? "Approved" : decision.outcome === "timeout" ? "Timed out" : "Denied"} exec: ${rendered}`,
      status: decision.approved ? "complete" : "denied",
      contentText: rendered,
      metadata: {
        argv: req.argv,
        cwd: req.cwd,
        entityId: req.entityId,
        approved: decision.approved,
        scope: decision.scope,
        reason: decision.reason,
        outcome: decision.outcome ?? (decision.approved ? "approved" : "denied"),
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
        outcome: decision.outcome ?? (decision.approved ? "approved" : "denied"),
      },
    });
    // Lessons from work: a denied program NAME and outcome only (never argv).
    if (!decision.approved)
      noteWorkFor(deps.db, deps.getEntity(req.entityId)?.name ?? session.created_by, {
        source: "code-exec-denied",
        tool: req.argv[0] ?? "exec",
        errorClass: decision.outcome ?? "denied",
        succeeded: false,
        at: Date.now(),
        ref: `artifact:${artifact.id}`,
        ...(decision.reason ? { privateText: decision.reason } : {}),
      });
    // An approved interactive arbitrary exec builds nothing:
    // code.exec.unrestricted is operator-grant only (src/engine/safety-gates.ts),
    // so no approval, however genuine, mints competence toward it. The
    // decision itself is audited above.
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
  if (mode === "off") return undefined;
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
    // Explicit off must override the local profile's default auto mode and revoke pending grants.
    execModes.set(session.id, "off");
    clearSessionExecState(session.id);
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

export function normalizeCodeRunArgs(args: string[]): string[] {
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

function formatVerificationSummary(
  verdict: VerificationVerdict,
  ran: RanStep[],
  preparation?: PreparationResult,
): string {
  const headline =
    verdict.outcome === "passed"
      ? success("Verification passed.")
      : verdict.outcome === "failed"
        ? fmtError("Verification failed.")
        : verdict.outcome === "not_run"
          ? `Verification not run: ${verdict.reason}`
          : fmtError(`Verification error: ${verdict.reason}`);
  const lines = [headline, separator()];
  if (preparation && preparation.status !== "skipped")
    lines.push(dim(`Preparation: ${preparation.status}. ${preparation.reason}`));
  const tag: Record<VerificationOutcome, string> = {
    passed: success("pass"),
    failed: fmtError("fail"),
    not_run: dim("not run"),
    error: fmtError("error"),
  };
  for (const item of ran) {
    const result = item.stored?.result;
    lines.push(
      `${tag[item.outcome.outcome]} $ ${item.command.join(" ")} ${dim(
        result
          ? `[exit ${result.exitCode}] ${result.durationMs}ms artifact: ${item.stored!.artifact.id}${item.outcome.outcome === "not_run" ? ` (${item.outcome.reason})` : ""}`
          : item.outcome.reason,
      )}`,
    );
  }
  if (verdict.outcome === "failed" || verdict.outcome === "error") {
    lines.push(dim("Stopped at first failed verification command."));
  }
  return lines.join("\n");
}

/** Recall scope for an actor's own lessons: the owner its work is recorded under (`workScopeFor`). */
function lessonOwner(db: MarinaDB, actor: string): { owner?: string } {
  const scope = workScopeFor(db, actor);
  return scope?.kind === "owner" ? { owner: scope.owner } : {};
}
