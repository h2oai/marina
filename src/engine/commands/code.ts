// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// `code` command entry point. The subcommand implementations live in
// `./code/*` (one module per concern); this file owns the `CommandDef`, the
// modal routing (bare `code`, profile/workspace/style pre-dispatch), the
// LAYER-0 telnet refusal, the no-code-root refusal, the imperative `code.exec`
// gate, and the subcommand dispatch table. Anything that is not a known
// subcommand inside Code Mode is a natural-language task routed to `doCode`.

import { CodeSessionDriver } from "../../coding/code-session-driver";
import { codingRunMetadata } from "../../coding/task-run";
import {
  resolveVerificationOptions,
  type VerificationOptions,
} from "../../coding/verification-plan";
import { error as fmtError } from "../../net/ansi";
import { codingRunContext } from "../../persistence/coding-run-context";
import type { MarinaDB } from "../../persistence/database";
import { parseCodingCommandTarget } from "../../sdk/command-target";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";
import { failCommandResponse } from "../command-response";
import { getErrorMessage } from "../errors";
import { parseModifiers } from "../parse-input";
import { checkGateForExecution, recordGateExecution } from "../safety-gates";
import {
  approval,
  approvals,
  artifacts,
  decideApproval,
  externalLink,
  lifecycleArtifact,
  patches,
  showArtifact,
  skill,
  thread,
} from "./code/artifacts";
import { crewPlan, roles, writerCommand } from "./code/crew";
import { askCode, assignCode, doCode, driverCommand, stopSessionAgent } from "./code/driver";
import {
  execApprove,
  execDeny,
  execModeCommand,
  recipe,
  runWorkspaceCommand,
  verifyWorkspace,
} from "./code/exec";
import {
  applyPatch,
  checkpoint,
  diff,
  editWorkspaceFile,
  files,
  proposePatch,
  readFile,
  rejectPatch,
  revertCheckpoint,
  search,
  writeWorkspaceFile,
} from "./code/files";
import { formatHelp, handleProfile } from "./code/profiles";
import { projectLifecycle } from "./code/project";
import { handleRunner } from "./code/runner";
import { sandboxLifecycle } from "./code/sandbox";
import { serviceLifecycle } from "./code/service";
import {
  branchSession,
  completeSession,
  enterCodeMode,
  exitCodeMode,
  history,
  listSessions,
  modelSetting,
  observe,
  recordCodingNote,
  resumeSession,
  sessionTask,
  startSession,
  status,
  steer,
  treeSessions,
} from "./code/session";
import {
  ACTIVE_MODAL_KEY,
  CODE_EXEC_SUBCOMMANDS,
  CODE_HOST_EXEC_SURFACE,
  CODE_PROFILES,
  type CodeDeps,
  type CodeProfile,
  canonicalCodeSubcommand,
  getCodeProfile,
  HOST_ROOT_EXEC_SUBCOMMANDS,
  NO_CODE_ROOT_DENY,
  resolveSession,
  restAfterSubcommand,
  TELNET_HOST_EXEC_DENY,
} from "./code/shared";
import { spawnRequest } from "./code/spawn";
import {
  blockCodingRun,
  observeCodingRun,
  publishCodingRun,
  reviewCodingRun,
} from "./code/task-run";
import { startVerification } from "./code/verification";
import { doctor, getWorkspaceRegistry, handleWorkspace, handleWorktree } from "./code/workspace";
import { requiresPersistence } from "./command-messages";

// Public surface consumed by other modules and tests (engine.ts, websocket
// tests) — keep these re-exports stable so importers never need to know about
// the `./code/*` layout.
export { isLoopbackConnection } from "./code/exec";
export type { CodeDeps } from "./code/shared";

/** Everything a subcommand handler needs, resolved once per invocation. */
interface SubcommandCall {
  ctx: RoomContext;
  eid: EntityId;
  entity: Entity;
  deps: CodeDeps & { db: MarinaDB };
  driver: CodeSessionDriver;
  profile: CodeProfile;
  /** Profile-alias-resolved subcommand name (what the switch used to key on). */
  canonicalSub: string;
  args: string[];
  rawAfterSub: string;
}

type SubcommandHandler = (call: SubcommandCall) => void | Promise<void>;

// First request-local surface: existing session inspection, evidence and workspace operations.
// Owner dispatch and blocked reports are scoped; selection/settings and other lifecycle verbs
// still use their explicit legacy paths.
// New subcommands must be reviewed before accepting a target, rather than silently ignoring it.
const TARGETED_SUBCOMMANDS = new Set([
  "doctor",
  "onboard",
  "setup",
  "review",
  "blocked",
  "do",
  "assign",
  "status",
  "history",
  "files",
  "read",
  "search",
  "diff",
  "artifacts",
  "show",
  "thread",
  "patches",
  "plan",
  "decision",
  "observe",
  "summary",
  "patch",
  "propose",
  "apply",
  "reject",
  "edit",
  "write",
  "checkpoint",
  "revert",
  "verify",
  "run",
  "test",
  "lint",
  "typecheck",
  "build",
  "dashboard:build",
  "recipe",
]);

const doctorHandler: SubcommandHandler = async (c) => {
  await doctor(c.ctx, c.eid, c.entity, c.deps);
};
const exitHandler: SubcommandHandler = async (c) => {
  await exitCodeMode(c.ctx, c.eid, c.entity, c.deps);
};
const startHandler: SubcommandHandler = (c) => {
  startSession(c.ctx, c.eid, c.entity, c.deps, c.args.join(" "));
};
const listHandler: SubcommandHandler = (c) => {
  listSessions(c.ctx, c.eid, c.entity, c.deps.db);
};
const resumeHandler: SubcommandHandler = (c) => {
  resumeSession(c.ctx, c.eid, c.entity, c.deps, c.args[0]);
};
const filesHandler: SubcommandHandler = async (c) => {
  await files(c.ctx, c.eid, c.entity, c.deps, c.args.join(" ") || ".");
};
const readHandler: SubcommandHandler = async (c) => {
  await readFile(c.ctx, c.eid, c.entity, c.deps, c.args.join(" "));
};
/** test / lint / typecheck / build / dashboard:build — the canonical name IS the command. */
const namedRunHandler: SubcommandHandler = async (c) => {
  await runWorkspaceCommand(c.ctx, c.eid, c.entity, c.deps, [c.canonicalSub]);
};
const proposeHandler: SubcommandHandler = async (c) => {
  await proposePatch(c.ctx, c.eid, c.entity, c.deps, c.rawAfterSub);
};
/** plan / summary / handoff / decision — the canonical name is the note kind. */
const codingNoteHandler: SubcommandHandler = async (c) => {
  await recordCodingNote(c.ctx, c.eid, c.entity, c.deps, c.canonicalSub, c.args);
};
const stopHandler: SubcommandHandler = async (c) => {
  await stopSessionAgent(c.ctx, c.eid, c.entity, c.deps);
};
const VERIFY_USAGE =
  "code verify [start|candidate] [dependencies:none|check|auto|<manager>] [scope:auto|changed|full|changed+full] [typecheck:auto|off] [budget:<duration>]";

/**
 * Subcommand dispatch table, keyed by the profile-canonical subcommand name.
 * Aliases point at the same handler. Order of gating (telnet → no-code-root →
 * code.exec) is enforced in `codeCommand` BEFORE this table is consulted.
 */
const SUBCOMMANDS: Record<string, SubcommandHandler> = {
  help: (c) => {
    c.ctx.send(c.eid, formatHelp(c.profile));
  },
  doctor: doctorHandler,
  sandbox: async (c) => {
    await sandboxLifecycle(c.ctx, c.eid, c.entity, c.deps, c.args);
  },
  project: async (c) => {
    await projectLifecycle(c.ctx, c.eid, c.entity, c.deps, c.args);
  },
  service: async (c) => {
    await serviceLifecycle(c.ctx, c.eid, c.entity, c.deps, c.args);
  },
  onboard: doctorHandler,
  setup: doctorHandler,
  exit: exitHandler,
  back: exitHandler,
  world: exitHandler,
  worktree: async (c) => {
    await handleWorktree(c.ctx, c.eid, c.entity, c.deps, c.args);
  },
  /** `code workspace runner …` (also `code runner …`): host or container execution. */
  runner: (c) => {
    const raw =
      c.args[0]?.toLowerCase() === "runner" ? restAfterSubcommand(c.rawAfterSub) : c.rawAfterSub;
    handleRunner(c.ctx, c.eid, c.entity, c.deps, raw);
  },
  "exec-mode": (c) => {
    execModeCommand(c.ctx, c.eid, c.entity, c.deps, c.args);
  },
  "exec-approve": (c) => {
    execApprove(c.ctx, c.eid, c.entity, c.args);
  },
  "exec-deny": (c) => {
    execDeny(c.ctx, c.eid, c.entity, c.args);
  },
  start: startHandler,
  new: startHandler,
  branch: (c) => {
    branchSession(c.ctx, c.eid, c.entity, c.deps, c.args.join(" "));
  },
  tree: (c) => {
    treeSessions(c.ctx, c.eid, c.entity, c.deps.db);
  },
  done: async (c) => {
    await completeSession(c.ctx, c.eid, c.entity, c.deps, c.rawAfterSub);
  },
  ask: async (c) => {
    await askCode(c.ctx, c.eid, c.entity, c.deps, c.driver, c.rawAfterSub);
  },
  assign: async (c) => {
    await assignCode(c.ctx, c.eid, c.entity, c.deps, c.driver, c.args);
  },
  roles: (c) => {
    roles(c.ctx, c.eid);
  },
  crew: async (c) => {
    await crewPlan(c.ctx, c.eid, c.entity, c.deps, c.rawAfterSub);
  },
  writer: (c) => {
    writerCommand(c.ctx, c.eid, c.entity, c.deps, c.args);
  },
  blocked: (c) => blockCodingRun(c.ctx, c.eid, c.entity, c.deps, c.args),
  review: (c) => reviewCodingRun(c.ctx, c.eid, c.entity, c.deps, c.args),
  task: (c) => {
    sessionTask(c.ctx, c.eid, c.entity, c.deps, c.rawAfterSub);
  },
  spawn: async (c) => {
    await spawnRequest(c.ctx, c.eid, c.entity, c.deps, c.args);
  },
  model: (c) => {
    modelSetting(c.ctx, c.eid, c.entity, c.deps, c.args);
  },
  recipe: async (c) => {
    await recipe(c.ctx, c.eid, c.entity, c.deps, c.args);
  },
  checkpoint: async (c) => {
    await checkpoint(c.ctx, c.eid, c.entity, c.deps, c.rawAfterSub);
  },
  revert: async (c) => {
    await revertCheckpoint(c.ctx, c.eid, c.entity, c.deps, c.args.join(" "));
  },
  approvals: (c) => {
    approvals(c.ctx, c.eid, c.entity, c.deps);
  },
  approval: (c) => {
    approval(c.ctx, c.eid, c.entity, c.deps, c.args);
  },
  approve: (c) => {
    decideApproval(c.ctx, c.eid, c.entity, c.deps, c.args.join(" "), "approved");
  },
  deny: (c) => {
    decideApproval(c.ctx, c.eid, c.entity, c.deps, c.args.join(" "), "denied");
  },
  skill: (c) => {
    skill(c.ctx, c.eid, c.entity, c.deps, c.args);
  },
  thread: (c) => {
    thread(c.ctx, c.eid, c.entity, c.deps);
  },
  external: (c) => {
    externalLink(c.ctx, c.eid, c.entity, c.deps, c.args);
  },
  list: listHandler,
  sessions: listHandler,
  resume: resumeHandler,
  use: resumeHandler,
  status: async (c) => {
    await status(c.ctx, c.eid, c.entity, c.deps, c.args[0]);
  },
  files: filesHandler,
  ls: filesHandler,
  read: readHandler,
  cat: readHandler,
  search: async (c) => {
    await search(c.ctx, c.eid, c.entity, c.deps, c.args.join(" "));
  },
  diff: async (c) => {
    await diff(c.ctx, c.eid, c.entity, c.deps, c.args.join(" "));
  },
  run: async (c) => {
    await runWorkspaceCommand(c.ctx, c.eid, c.entity, c.deps, c.args);
  },
  verify: async (c) => {
    const parsed = parseModifiers(c.args, {
      dependencies: { type: "string" },
      scope: { type: "string" },
      typecheck: { type: "string" },
      budget: { type: "string" },
    });
    const mode = parsed.rest[0]?.toLowerCase();
    if (
      parsed.errors.length ||
      parsed.rest.length > 1 ||
      (mode !== undefined && mode !== "start" && mode !== "candidate")
    )
      throw new Error(`Usage: ${VERIFY_USAGE}`);
    let options: VerificationOptions;
    try {
      options = resolveVerificationOptions({
        dependencies: parsed.values.dependencies as string | undefined,
        scope: parsed.values.scope as string | undefined,
        typecheck: parsed.values.typecheck as string | undefined,
        budget: parsed.values.budget as string | undefined,
      });
    } catch (error) {
      throw new Error(`${getErrorMessage(error)}\nUsage: ${VERIFY_USAGE}`);
    }
    if (mode === "start" || mode === "candidate") {
      await startVerification(c.ctx, c.eid, c.entity, c.deps, mode === "candidate", options);
      return;
    }
    await verifyWorkspace(c.ctx, c.eid, c.entity, c.deps, options);
  },
  test: namedRunHandler,
  lint: namedRunHandler,
  typecheck: namedRunHandler,
  build: namedRunHandler,
  "dashboard:build": namedRunHandler,
  patch: proposeHandler,
  propose: proposeHandler,
  artifacts: (c) => {
    artifacts(c.ctx, c.eid, c.entity, c.deps, c.args);
  },
  patches: (c) => {
    patches(c.ctx, c.eid, c.entity, c.deps, c.args);
  },
  show: (c) => {
    showArtifact(c.ctx, c.eid, c.entity, c.deps, c.args.join(" "));
  },
  pin: (c) => {
    lifecycleArtifact(c.ctx, c.eid, c.entity, c.deps, c.args.join(" "), "pinned");
  },
  unpin: (c) => {
    lifecycleArtifact(c.ctx, c.eid, c.entity, c.deps, c.args.join(" "), "active");
  },
  archive: (c) => {
    lifecycleArtifact(c.ctx, c.eid, c.entity, c.deps, c.args.join(" "), "archived");
  },
  supersede: (c) => {
    lifecycleArtifact(c.ctx, c.eid, c.entity, c.deps, c.args.join(" "), "superseded");
  },
  apply: async (c) => {
    await applyPatch(c.ctx, c.eid, c.entity, c.deps, c.args.join(" "));
  },
  reject: (c) => {
    rejectPatch(c.ctx, c.eid, c.entity, c.deps, c.args);
  },
  history: (c) => {
    history(c.ctx, c.eid, c.entity, c.deps, c.args[0]);
  },
  plan: codingNoteHandler,
  summary: codingNoteHandler,
  handoff: codingNoteHandler,
  decision: codingNoteHandler,
  steer: (c) => {
    steer(c.ctx, c.eid, c.entity, c.deps, c.args);
  },
  observe: (c) => {
    observe(c.ctx, c.eid, c.entity, c.deps, c.args);
  },
  do: async (c) => {
    // Explicit agentic dispatch: hand a natural-language task to the
    // session's driver (default: a single bound coding agent).
    await doCode(c.ctx, c.eid, c.entity, c.deps, c.driver, c.rawAfterSub);
  },
  driver: (c) => {
    driverCommand(c.ctx, c.eid, c.entity, c.deps, c.args);
  },
  stop: stopHandler,
  cancel: stopHandler,
  edit: async (c) => {
    await editWorkspaceFile(c.ctx, c.eid, c.entity, c.deps, c.rawAfterSub);
  },
  write: async (c) => {
    await writeWorkspaceFile(c.ctx, c.eid, c.entity, c.deps, c.rawAfterSub);
  },
};

export function codeCommand(deps: CodeDeps): CommandDef {
  const command: CommandDef = {
    usage: [
      "code",
      "code apply <patch_id|last patch>",
      "code approval",
      "code approval list",
      "code approval request <k> <desc>",
      "code approval request <shell|network|secret|commit|spawn|other> <description>",
      "code approvals",
      "code approve <id>",
      "code archive <artifact_id|last>",
      "code artifacts",
      "code artifacts failed",
      "code artifacts kind <artifact_kind>",
      "code artifacts recent",
      "code artifacts status <status>",
      "code ask <request>",
      "code assign <agent> <req>",
      "code assign <agent> verification:candidate -- <req>",
      "code do verification:candidate -- <task>",
      "code blocked <reason>",
      "code branch [title]",
      "code checkpoint [title]",
      "code crew <goal> [with <a,b>]",
      "code crew <goal> [with <agentA,agentB,...>]",
      "code decision <choice>",
      "code decision <text>",
      "code deny <id>",
      "code diff [path]",
      "code doctor",
      "code done [summary]",
      "code edit <path> [all] <old text> <new text>",
      "code exec-approve <token> [once]",
      "code exec-deny <token> [reason]",
      "code exec-mode <prompt|auto|off>",
      "code exit",
      "code external",
      "code external link <acp|mcp|cursor|zed|vscode|other> <external_id>",
      "code external link <system> <id>",
      "code external show",
      "code external unlink",
      "code files [path]",
      "code handoff <notes> [to <agent>]",
      "code handoff <text>",
      "code history [session_id]",
      "code lint",
      "code list",
      "code model",
      "code model set <provider/model|agent|crew|direct>",
      "code model set <target>",
      "code observe <note>",
      "code observe <what you observed>",
      "code onboard",
      "code patch [title] <diff>",
      "code patches [status]",
      "code patches applied",
      "code patches pending",
      "code patches rejected",
      "code pin <artifact_id|last>",
      "code plan <direction>",
      "code plan <text>",
      "code profile",
      "code profile alias <a> <b>",
      "code profile alias <alias> <command>",
      "code profile alias clear <alias>",
      "code profile aliases",
      "code profile compare",
      "code profile help [name]",
      "code profile list",
      "code profile show",
      "code profile use <name>",
      "code project clone <public-https-url> [name]",
      "code project clone <url> [name]",
      "code project delete <id|name> [discard] confirm",
      "code project delete <id|name> confirm",
      "code project diff",
      "code project export [archive]",
      "code project import <artifact> <name>",
      "code project import <project_archive_artifact> <name>",
      "code project init <name>",
      "code project list",
      "code project reconcile",
      "code project status",
      "code project switch <id|name>",
      "code read <path>",
      "code recipe",
      "code recipe list",
      "code recipe run <name>",
      "code recipe save <n> <cmds>",
      "code recipe save <name> <command> [then <command>...]",
      "code recipe show <name>",
      "code reject <patch_id|last patch>",
      "code resume <session_id>",
      "code revert <checkpoint>",
      "code review",
      "code review approve",
      "code review reject",
      "code review accept-unverified <attempt> <reason>",
      "code roles",
      "code run <check|cmd...>",
      "code run <typecheck|lint|test|build|dashboard:build|bun ...|git ...>",
      "code run allowlist",
      "code run app [script]",
      "code sandbox credentials",
      "code sandbox hibernate",
      "code sandbox local",
      "code sandbox network status",
      "code sandbox ops hibernate <entity-id> confirm",
      "code sandbox ops inventory",
      "code sandbox ops metrics",
      "code sandbox ops reclaim [confirm]",
      "code sandbox ops reconcile",
      "code sandbox ops revoke <entity-id> confirm",
      "code sandbox ops stop <entity-id> [discard] confirm",
      "code sandbox resume",
      "code sandbox start [image]",
      "code sandbox status",
      "code sandbox stop [discard] confirm",
      "code sandbox stop confirm",
      "code sandbox use",
      "code search <query>",
      "code service list",
      "code service logs",
      "code service probe",
      "code service probes <id|name> [limit]",
      "code service publish <name>",
      "code service restart",
      "code service revoke <name>",
      "code service screenshot",
      "code service start <name> [--port N] -- <command>",
      "code service status",
      "code service stop",
      "code show <artifact_id|last|last patch|last failed>",
      "code show <patch_id|last patch>",
      "code skill",
      "code skill add <name> <instructions>",
      "code skill add <name> <text>",
      "code skill list",
      "code skill use <name>",
      "code spawn <role> <goal>",
      "code spawn run <spawn_request>",
      "code start [title]",
      "code status [session_id]",
      "code steer <direction>",
      "code stop",
      "code summary <notes>",
      "code summary <text>",
      "code supersede <artifact_id|last>",
      "code task <title>",
      "code test",
      "code thread",
      "code tree",
      "code typecheck",
      "code unpin <artifact_id|last>",
      "code verify",
      "code verify start",
      "code verify candidate",
      "code verify candidate dependencies:auto",
      "code verify scope:changed+full budget:10m",
      "code workspace",
      "code workspace discover",
      "code workspace list",
      "code workspace show",
      "code workspace runner",
      "code workspace runner local",
      "code workspace runner container image:<ref> [sync:mount|patch] [workdir:<path>] [network:on] [-- <init>]",
      "code workspace use <path>",
      "code worktree",
      "code worktree merge",
      "code worktree off",
      "code worktree on",
      "code worktree status",
      "code write <path> <content>",
      "code writer [<agent>]",
    ],
    name: "code",
    aliases: [],
    category: "Agents",
    help: formatHelp(CODE_PROFILES.marina),
    handler: async (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;
      if (!deps.db) {
        ctx.send(input.entity, requiresPersistence("coding sessions"));
        return;
      }
      // Resolve the acting caller's transport ONCE. A telnet-origin caller is
      // host-exec-forbidden: every workspace resolved this invocation refuses to
      // spawn (the chokepoint guarantee, independent of the enumerated surface).
      const depsWithDb: CodeDeps & { db: MarinaDB } = {
        ...deps,
        db: deps.db,
        hostExecForbidden: deps.getConnectionProtocol?.(input.entity) === "telnet",
      };
      const driver = new CodeSessionDriver({
        agentRuntime: deps.agentRuntime,
        answerPrompt: deps.answerPrompt,
        db: deps.db,
        getEntity: deps.getEntity,
        onRun: (run, handle) => observeCodingRun(depsWithDb, run, handle),
        onRunEnd: (run) => publishCodingRun(depsWithDb, run),
      });

      const sub = input.tokens[0]?.toLowerCase();
      const args = input.tokens.slice(1);
      const rawAfterSub = restAfterSubcommand(input.args);

      try {
        if (!sub) {
          enterCodeMode(ctx, input.entity, entity, depsWithDb);
          return;
        }
        if (sub === "profile") {
          handleProfile(ctx, input.entity, entity, depsWithDb, args);
          return;
        }
        // `code workspace runner …` changes WHERE commands execute, so it skips the
        // ungated workspace pre-dispatch and takes the gated `runner` path below.
        const workspaceRunner = sub === "workspace" && args[0]?.toLowerCase() === "runner";
        if (sub === "workspace" && !workspaceRunner) {
          handleWorkspace(ctx, input.entity, entity, depsWithDb, args);
          return;
        }
        if (sub === "style") {
          handleProfile(ctx, input.entity, entity, depsWithDb, ["use", ...args]);
          return;
        }

        const profile = getCodeProfile(entity);
        const canonicalSub = workspaceRunner ? "runner" : canonicalCodeSubcommand(profile, sub);

        // Gate the host-execution / workspace-mutation surface behind code.exec.
        // The `code` command is rank 0 (read/inspect/propose stay open), but
        // running or applying code can execute arbitrary host processes, so it
        // requires earned competence — closing the ungated `code apply` + `code
        // run` path to host code execution.
        const mutatesSandbox =
          canonicalSub === "sandbox" && (args[0]?.toLowerCase() ?? "status") !== "status";
        const isProject = canonicalSub === "project";
        // LAYER 0 (highest precedence): transport-origin deny across the ENTIRE
        // host-subprocess surface (superset of the gated set — also covers
        // patch/propose, which run `git apply --check`). Host execution is never
        // available over telnet (plaintext, unauthenticated) — even for a
        // sovereign or a code.exec.unrestricted holder, and even for an
        // allowlisted run. Refuse before the gate; do not fall through.
        const isHostExecSurface =
          CODE_HOST_EXEC_SURFACE.has(canonicalSub) || mutatesSandbox || isProject;
        if (isHostExecSurface && deps.getConnectionProtocol?.(input.entity) === "telnet") {
          failCommandResponse(TELNET_HOST_EXEC_DENY);
          ctx.send(input.entity, TELNET_HOST_EXEC_DENY);
          return;
        }
        // LAYER 0.5: no configured code root → refuse HOST mutation/execution.
        // Never fall back to the server's own process.cwd() (Finding 2). Scoped
        // to subcommands that touch the HOST working tree / spawn host processes
        // (run/verify/test/lint/typecheck/build/recipe/apply/revert/edit/write
        // plus patch/propose's `git apply --check`). Flywheel-contained surfaces
        // (sandbox/project/service) have their own isolation and don't use the
        // host root, so they are NOT refused here. Read-only inspectors stay open.
        if (
          HOST_ROOT_EXEC_SUBCOMMANDS.has(canonicalSub) &&
          !getWorkspaceRegistry(depsWithDb).hostExecAllowed
        ) {
          failCommandResponse(NO_CODE_ROOT_DENY);
          ctx.send(input.entity, NO_CODE_ROOT_DENY);
          return;
        }
        // The narrower gated set (earned competence). patch/propose stay rank 0
        // (read/propose are open per policy) and so are NOT gated here.
        // Posture-aware check: self-certification stays closed, while witness
        // windows, earned-posture reviewed practice, and an operator-declared
        // open posture authorize with their consequence recorded.
        if (CODE_EXEC_SUBCOMMANDS.has(canonicalSub) || mutatesSandbox || isProject) {
          const gate = checkGateForExecution(depsWithDb.db, input.entity, "code.exec");
          if (!gate.ok) {
            failCommandResponse(gate.reason ?? "code.exec capability required.");
            ctx.send(
              input.entity,
              gate.reason ??
                "Running or applying code requires the code.exec capability, which is earned through contribution.",
            );
            return;
          }
          recordGateExecution(
            depsWithDb.db,
            input.entity,
            "code.exec",
            gate,
            `code ${canonicalSub}`,
          );
        }

        // `Object.hasOwn` so a prototype key (`constructor`, `toString`, …)
        // typed as a subcommand falls through to the natural-language default
        // exactly like an unknown word, instead of resolving to Object.prototype.
        const handler = Object.hasOwn(SUBCOMMANDS, canonicalSub)
          ? SUBCOMMANDS[canonicalSub]
          : undefined;
        if (handler) {
          await handler({
            ctx,
            eid: input.entity,
            entity,
            deps: depsWithDb,
            driver,
            profile,
            canonicalSub,
            args,
            rawAfterSub,
          });
          return;
        }

        // In Code Mode, anything that isn't a known subcommand is a
        // natural-language task — route it to the driver (Codex/Claude-style)
        // instead of dumping help. Outside the modal, fall back to help.
        const line = input.tokens.join(" ").trim();
        if (entity.properties[ACTIVE_MODAL_KEY] === "code" && line) {
          await doCode(ctx, input.entity, entity, depsWithDb, driver, line);
        } else {
          ctx.send(input.entity, formatHelp(profile));
        }
      } catch (err) {
        failCommandResponse(getErrorMessage(err));
        ctx.send(input.entity, fmtError(getErrorMessage(err)));
      }
    },
  };
  return {
    ...command,
    handler: async (ctx, input) => {
      const entity = deps.getEntity(input.entity);
      let sessionId = entity?.properties.coding_session_id as string | undefined;
      if (ctx.codingTarget !== undefined) {
        try {
          ctx = { ...ctx, codingTarget: parseCodingCommandTarget(ctx.codingTarget) };
          if (!entity || !deps.db) throw new Error("Coding target is unavailable.");
          const session = resolveSession(ctx, input.entity, entity, deps.db);
          if (!session) return;
          sessionId = session.id;
          const sub = canonicalCodeSubcommand(
            getCodeProfile(entity),
            input.tokens[0]?.toLowerCase() ?? "",
          );
          if (!TARGETED_SUBCOMMANDS.has(sub))
            throw new Error("This code operation does not support request-local targeting.");
          // Check before gates and side effects. Never silently use the selected/latest attempt
          // when an explicit expected attempt has completed, moved or been replaced.
          if (ctx.codingTarget?.runId) {
            const expected = deps.db.getCodingArtifact(ctx.codingTarget.runId);
            const active = deps.db.listCodingRuns({ sessionId, status: "active", limit: 1 })[0];
            if (
              expected?.kind !== "task_run" ||
              expected.session_id !== sessionId ||
              active?.id !== expected.id
            )
              throw new Error(
                "Coding run target is not the session's active attempt. Inspect state before retrying.",
              );
          }
        } catch (error) {
          const message = getErrorMessage(error);
          failCommandResponse(message);
          ctx.send(input.entity, fmtError(message));
          return;
        }
      }
      const run = sessionId
        ? deps.db?.listCodingRuns({ sessionId, status: "active", limit: 1 })[0]
        : undefined;
      return codingRunContext.run(
        { sessionId, runId: run?.id, taskId: run ? codingRunMetadata(run).taskId : undefined },
        () => command.handler(ctx, input),
      );
    },
  };
}
