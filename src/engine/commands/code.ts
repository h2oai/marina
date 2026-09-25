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
import { error as fmtError } from "../../net/ansi";
import { codingRunContext } from "../../persistence/coding-run-context";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";
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
  restAfterSubcommand,
  TELNET_HOST_EXEC_DENY,
} from "./code/shared";
import { spawnRequest } from "./code/spawn";
import { observeCodingRun, publishCodingRun, reviewCodingRun } from "./code/task-run";
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
const filesHandler: SubcommandHandler = (c) => {
  files(c.ctx, c.eid, c.entity, c.deps, c.args.join(" ") || ".");
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
const codingNoteHandler: SubcommandHandler = (c) => {
  recordCodingNote(c.ctx, c.eid, c.entity, c.deps, c.canonicalSub, c.args);
};
const stopHandler: SubcommandHandler = async (c) => {
  await stopSessionAgent(c.ctx, c.eid, c.entity, c.deps);
};

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
  status: (c) => {
    status(c.ctx, c.eid, c.entity, c.deps, c.args[0]);
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
    await verifyWorkspace(c.ctx, c.eid, c.entity, c.deps);
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
        if (sub === "workspace") {
          handleWorkspace(ctx, input.entity, entity, depsWithDb, args);
          return;
        }
        if (sub === "style") {
          handleProfile(ctx, input.entity, entity, depsWithDb, ["use", ...args]);
          return;
        }

        const profile = getCodeProfile(entity);
        const canonicalSub = canonicalCodeSubcommand(profile, sub);

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
        ctx.send(input.entity, fmtError(err instanceof Error ? err.message : String(err)));
      }
    },
  };
  return {
    ...command,
    handler: (ctx, input) => {
      const sessionId = deps.getEntity(input.entity)?.properties.coding_session_id as
        | string
        | undefined;
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
