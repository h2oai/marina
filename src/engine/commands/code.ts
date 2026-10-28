// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// `code` command entry point. The subcommand implementations live in
// `./code/*` (one module per concern); this file owns the `CommandDef`, the
// modal routing (bare `code`, profile/workspace/style pre-dispatch), the
// LAYER-0 telnet refusal, the no-code-root refusal, the imperative `code.exec`
// gate, and the subcommand dispatch table. Anything that is not a known
// subcommand inside Code Mode is a natural-language task routed to `doCode`.

import { CodeSessionDriver } from "../../coding/code-session-driver";
import { parseCommandArgv } from "../../coding/command-argv";
import { parseCodeSearchInput } from "../../coding/search-input";
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
import { failCommandResponse, refuseCommand } from "../command-response";
import { getErrorMessage } from "../errors";
import { parseModifiers } from "../parse-input";
import { checkGateForExecution, recordGateExecution } from "../safety-gates";
import { dailySpendCapUsd, formatSpendUsd, spentTodayUsd } from "../spend-ledger";
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
import { isReviewRequestForm, reviewRequestCommand } from "./code/review-request";
import { handleRunner } from "./code/runner";
import { sandboxLifecycle } from "./code/sandbox";
import { serviceLifecycle } from "./code/service";
import {
  branchSession,
  compactSession,
  completeSession,
  continueSession,
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
  assumeCodingRun,
  blockCodingRun,
  observeCodingRun,
  publishCodingRun,
  reviewCodingRun,
} from "./code/task-run";
import { startVerification } from "./code/verification";
import { seeWorkspaceFile } from "./code/visual";
import {
  doctor,
  getWorkspaceRegistry,
  handleWorkspace,
  handleWorktree,
  workspaceForSession,
} from "./code/workspace";
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
  "assume",
  "do",
  "assign",
  "status",
  "history",
  "files",
  "read",
  "see",
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
  "handoff",
  "writer",
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
const continueHandler: SubcommandHandler = (c) => {
  continueSession(c.ctx, c.eid, c.entity, c.deps);
};
const compactHandler: SubcommandHandler = async (c) => {
  await compactSession(c.ctx, c.eid, c.entity, c.deps);
};
const costHandler: SubcommandHandler = (c) => {
  const today = spentTodayUsd();
  const cap = dailySpendCapUsd();
  const lines = [`Today's model spend: ${formatSpendUsd(today)}`];
  if (cap !== undefined) {
    lines.push(`Daily cap: ${formatSpendUsd(cap)}`);
    if (cap > 0) lines.push(`${Math.round((today / cap) * 100)}% of today's cap used`);
  } else {
    lines.push("Daily cap: none set");
  }
  c.ctx.send(c.eid, lines.join("\n"));
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
  "code verify [start|candidate|delivery] [manifest:<path>] [dependencies:none|check|auto|<manager>] [scope:auto|changed|full|changed+full] [typecheck:auto|off] [budget:<duration>]";

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
    await serviceLifecycle(c.ctx, c.eid, c.entity, c.deps, parseCommandArgv(c.rawAfterSub));
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
  assume: (c) => assumeCodingRun(c.ctx, c.eid, c.entity, c.deps, c.args),
  review: (c) =>
    isReviewRequestForm(c.args)
      ? reviewRequestCommand(c.ctx, c.eid, c.entity, c.deps, c.args, c.rawAfterSub)
      : reviewCodingRun(c.ctx, c.eid, c.entity, c.deps, c.args),
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
  continue: continueHandler,
  compact: compactHandler,
  cost: costHandler,
  usage: costHandler,
  use: resumeHandler,
  status: async (c) => {
    await status(c.ctx, c.eid, c.entity, c.deps, c.args[0]);
  },
  files: filesHandler,
  ls: filesHandler,
  read: readHandler,
  cat: readHandler,
  see: async (c) => {
    await seeWorkspaceFile(c.ctx, c.eid, c.entity, c.deps, c.rawAfterSub, c.args);
  },
  search: async (c) => {
    const parsed = parseCodeSearchInput(c.rawAfterSub);
    await search(c.ctx, c.eid, c.entity, c.deps, parsed.query, parsed.path);
  },
  diff: async (c) => {
    await diff(c.ctx, c.eid, c.entity, c.deps, c.args.join(" "));
  },
  run: async (c) => {
    await runWorkspaceCommand(c.ctx, c.eid, c.entity, c.deps, parseCommandArgv(c.rawAfterSub));
  },
  verify: async (c) => {
    const parsed = parseModifiers(c.args, {
      manifest: { type: "string" },
      dependencies: { type: "string" },
      scope: { type: "string" },
      typecheck: { type: "string" },
      budget: { type: "string" },
    });
    const mode = parsed.rest[0]?.toLowerCase();
    if (
      parsed.errors.length ||
      parsed.rest.length > 1 ||
      (mode !== undefined && mode !== "start" && mode !== "candidate" && mode !== "delivery")
    )
      throw new Error(`Usage: ${VERIFY_USAGE}`);
    const manifest = parsed.values.manifest as string | undefined;
    if ((mode === "delivery") !== !!manifest)
      throw new Error(
        "Delivery verification requires manifest:<relative path>; other modes do not accept a manifest.",
      );
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
    if (mode === "start" || mode === "candidate" || mode === "delivery") {
      await startVerification(
        c.ctx,
        c.eid,
        c.entity,
        c.deps,
        mode === "candidate",
        options,
        manifest,
      );
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
      { syntax: "code", effect: "write" },
      { syntax: "code apply <patch_id|last patch>", effect: "write" },
      { syntax: "code approval", effect: "read" },
      { syntax: "code approval list", effect: "read" },
      { syntax: "code approval request <k> <desc>", effect: "write" },
      {
        syntax: "code approval request <shell|network|secret|commit|spawn|other> <description>",
        effect: "write",
      },
      { syntax: "code approvals", effect: "read" },
      { syntax: "code approve <id>", effect: "write" },
      { syntax: "code archive <artifact_id|last>", effect: "write" },
      { syntax: "code artifacts", effect: "read" },
      { syntax: "code artifacts failed", effect: "read" },
      { syntax: "code artifacts kind <artifact_kind>", effect: "read" },
      { syntax: "code artifacts recent", effect: "read" },
      { syntax: "code artifacts status <status>", effect: "read" },
      { syntax: "code ask <request>", effect: "execute" },
      { syntax: "code assign <agent> <req>", effect: "execute" },
      { syntax: "code assign <agent> verification:candidate -- <req>", effect: "execute" },
      {
        syntax:
          "code do [verification:candidate|checks|delivery] [owner:unattended] [budget:<duration>] -- <task>",
        effect: "execute",
      },
      { syntax: "code assume <interpretation>", effect: "write" },
      { syntax: "code blocked [kind:decision|impossible] <reason>", effect: "write" },
      { syntax: "code branch [title]", effect: "write" },
      { syntax: "code checkpoint [title]", effect: "write" },
      { syntax: "code crew <goal> [with <a,b>]", effect: "execute" },
      { syntax: "code crew <goal> [with <agentA,agentB,...>]", effect: "execute" },
      { syntax: "code decision <choice>", effect: "write" },
      { syntax: "code decision <text>", effect: "write" },
      { syntax: "code deny <id>", effect: "write" },
      { syntax: "code diff [path]", effect: "read" },
      { syntax: "code doctor", effect: "read" },
      { syntax: "code done [summary]", effect: "write" },
      { syntax: "code edit <path> [all] <old text> <new text>", effect: "write" },
      { syntax: "code exec-approve <token> [once]", effect: "execute" },
      { syntax: "code exec-deny <token> [reason]", effect: "write" },
      { syntax: "code exec-mode <prompt|auto|off>", effect: "write" },
      { syntax: "code exit", effect: "write" },
      { syntax: "code external", effect: "read" },
      {
        syntax: "code external link <acp|mcp|cursor|zed|vscode|other> <external_id>",
        effect: "write",
      },
      { syntax: "code external link <system> <id>", effect: "write" },
      { syntax: "code external show", effect: "read" },
      { syntax: "code external unlink", effect: "delete" },
      { syntax: "code files [path]", effect: "read" },
      { syntax: "code handoff <notes> [to:<agent>]", effect: "write" },
      { syntax: "code handoff <text>", effect: "write" },
      { syntax: "code history [session_id]", effect: "read" },
      { syntax: "code lint", effect: "execute" },
      { syntax: "code list", effect: "read" },
      { syntax: "code model", effect: "read" },
      { syntax: "code model set <provider/model|agent|crew|direct>", effect: "write" },
      { syntax: "code model set <target>", effect: "write" },
      { syntax: "code observe <note>", effect: "write" },
      { syntax: "code observe <what you observed>", effect: "write" },
      { syntax: "code onboard", effect: "read" },
      { syntax: "code patch [title] <diff>", effect: "write" },
      { syntax: "code patches [status]", effect: "read" },
      { syntax: "code patches applied", effect: "read" },
      { syntax: "code patches pending", effect: "read" },
      { syntax: "code patches rejected", effect: "read" },
      { syntax: "code pin <artifact_id|last>", effect: "write" },
      { syntax: "code plan <direction>", effect: "write" },
      { syntax: "code plan <text>", effect: "write" },
      { syntax: "code profile", effect: "read" },
      { syntax: "code profile alias <a> <b>", effect: "write" },
      { syntax: "code profile alias <alias> <command>", effect: "write" },
      { syntax: "code profile alias clear <alias>", effect: "delete" },
      { syntax: "code profile aliases", effect: "read" },
      { syntax: "code profile compare", effect: "read" },
      { syntax: "code profile help [name]", effect: "read" },
      { syntax: "code profile list", effect: "read" },
      { syntax: "code profile show", effect: "read" },
      { syntax: "code profile use <name>", effect: "write" },
      { syntax: "code project clone <public-https-url> [name]", effect: "execute" },
      { syntax: "code project clone <url> [name]", effect: "execute" },
      { syntax: "code project delete <id|name> [discard] confirm", effect: "delete" },
      { syntax: "code project delete <id|name> confirm", effect: "delete" },
      { syntax: "code project diff", effect: "write" },
      { syntax: "code project export [archive]", effect: "write" },
      { syntax: "code project import <artifact> <name>", effect: "write" },
      { syntax: "code project import <project_archive_artifact> <name>", effect: "write" },
      { syntax: "code project init <name>", effect: "write" },
      { syntax: "code project list", effect: "read" },
      { syntax: "code project reconcile", effect: "write" },
      { syntax: "code project status", effect: "read" },
      { syntax: "code project switch <id|name>", effect: "write" },
      { syntax: "code run --argv <json-array>", effect: "execute" },
      { syntax: "code read <path>", effect: "read" },
      { syntax: "code see <path> [question]", effect: "write" },
      { syntax: "code recipe", effect: "read" },
      { syntax: "code recipe list", effect: "read" },
      { syntax: "code recipe run <name>", effect: "execute" },
      { syntax: "code recipe save <n> <cmds>", effect: "write" },
      { syntax: "code recipe save <name> <command> [then <command>...]", effect: "write" },
      { syntax: "code recipe show <name>", effect: "read" },
      { syntax: "code reject <patch_id|last patch>", effect: "write" },
      { syntax: "code resume <session_id>", effect: "write" },
      { syntax: "code revert <checkpoint>", effect: "write" },
      { syntax: "code review", effect: "write" },
      { syntax: "code review approve", effect: "write" },
      { syntax: "code review reject", effect: "write" },
      { syntax: "code review accept-unverified <attempt> <reason>", effect: "write" },
      {
        syntax: "code review request <name|auto|review_id> [author:<name>] [-- claims]",
        effect: "write",
      },
      { syntax: "code review verdict <review_id> approve|rework [-- findings]", effect: "write" },
      { syntax: "code review <review_id>", effect: "read" },
      { syntax: "code review approve|reject <review_id>", effect: "write" },
      { syntax: "code roles", effect: "read" },
      { syntax: "code run <check|cmd...>", effect: "execute" },
      {
        syntax: "code run <typecheck|lint|test|build|dashboard:build|bun ...|git ...>",
        effect: "execute",
      },
      { syntax: "code run allowlist", effect: "read" },
      { syntax: "code run app [script]", effect: "execute" },
      { syntax: "code sandbox credentials", effect: "read" },
      { syntax: "code sandbox hibernate", effect: "write" },
      { syntax: "code sandbox local", effect: "write" },
      { syntax: "code sandbox network status", effect: "read" },
      { syntax: "code sandbox ops hibernate <entity-id> confirm", effect: "write" },
      { syntax: "code sandbox ops inventory", effect: "read" },
      { syntax: "code sandbox ops metrics", effect: "read" },
      { syntax: "code sandbox ops reclaim [confirm]", effect: "write" },
      { syntax: "code sandbox ops reconcile", effect: "write" },
      { syntax: "code sandbox ops revoke <entity-id> confirm", effect: "delete" },
      { syntax: "code sandbox ops stop <entity-id> [discard] confirm", effect: "delete" },
      { syntax: "code sandbox resume", effect: "execute" },
      { syntax: "code sandbox start [image]", effect: "execute" },
      { syntax: "code sandbox status", effect: "read" },
      { syntax: "code sandbox stop [discard] confirm", effect: "delete" },
      { syntax: "code sandbox stop confirm", effect: "delete" },
      { syntax: "code sandbox providers", effect: "read" },
      { syntax: "code sandbox use [provider]", effect: "write" },
      { syntax: "code search <query> [path:<relative-path>]", effect: "read" },
      { syntax: "code service list", effect: "read" },
      { syntax: "code service logs", effect: "write" },
      { syntax: "code service probe", effect: "execute" },
      { syntax: "code service probes <id|name> [limit]", effect: "read" },
      { syntax: "code service publish <name>", effect: "write" },
      { syntax: "code service restart", effect: "execute" },
      { syntax: "code service revoke <name>", effect: "delete" },
      { syntax: "code service screenshot", effect: "execute" },
      { syntax: "code service start <name> [--port N] -- <command>", effect: "execute" },
      { syntax: "code service status", effect: "read" },
      { syntax: "code service stop", effect: "write" },
      { syntax: "code show <artifact_id|last|last patch|last failed>", effect: "read" },
      { syntax: "code show <patch_id|last patch>", effect: "read" },
      { syntax: "code skill", effect: "read" },
      { syntax: "code skill add <name> <instructions>", effect: "write" },
      { syntax: "code skill add <name> <text>", effect: "write" },
      { syntax: "code skill list", effect: "read" },
      { syntax: "code skill use <name>", effect: "read" },
      { syntax: "code spawn <role> <goal>", effect: "execute" },
      { syntax: "code spawn run <spawn_request>", effect: "execute" },
      { syntax: "code start [title]", effect: "write" },
      { syntax: "code status [session_id]", effect: "read" },
      { syntax: "code steer <direction>", effect: "write" },
      { syntax: "code stop", effect: "write" },
      { syntax: "code summary <notes>", effect: "write" },
      { syntax: "code summary <text>", effect: "write" },
      { syntax: "code supersede <artifact_id|last>", effect: "write" },
      { syntax: "code task <title>", effect: "write" },
      { syntax: "code test", effect: "execute" },
      { syntax: "code thread", effect: "read" },
      { syntax: "code tree", effect: "read" },
      { syntax: "code typecheck", effect: "execute" },
      { syntax: "code unpin <artifact_id|last>", effect: "write" },
      { syntax: "code verify", effect: "execute" },
      { syntax: "code verify start", effect: "execute" },
      { syntax: "code verify candidate", effect: "execute" },
      { syntax: "code verify delivery manifest:<path>", effect: "execute" },
      { syntax: "code verify candidate dependencies:auto", effect: "execute" },
      { syntax: "code verify scope:changed+full budget:10m", effect: "execute" },
      { syntax: "code workspace", effect: "read" },
      { syntax: "code workspace discover", effect: "read" },
      { syntax: "code workspace list", effect: "read" },
      { syntax: "code workspace show", effect: "read" },
      { syntax: "code workspace runner", effect: "read" },
      { syntax: "code workspace runner local", effect: "write" },
      {
        syntax:
          "code workspace runner container image:<ref> [sync:mount|patch] [workdir:<path>] [network:on]",
        effect: "write",
      },
      { syntax: "code workspace use <path>", effect: "write" },
      { syntax: "code worktree", effect: "read" },
      { syntax: "code worktree merge", effect: "read" },
      { syntax: "code worktree off", effect: "write" },
      { syntax: "code worktree on", effect: "write" },
      { syntax: "code worktree status", effect: "read" },
      { syntax: "code write <path> <content>", effect: "write" },
      { syntax: "code writer [<agent>]", effect: "write" },
    ],
    name: "code",
    aliases: [],
    category: "Agents",
    help: formatHelp(CODE_PROFILES.marina),
    handler: async (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;
      if (!deps.db) {
        refuseCommand(ctx, input.entity, requiresPersistence("coding sessions"));
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
        describeWorkspace: (session) =>
          session.execution_target === "local"
            ? workspaceForSession(depsWithDb, session).describe?.()
            : undefined,
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
        const action = args[workspaceRunner ? 1 : 0]?.toLowerCase();
        const inspectOnly =
          (canonicalSub === "recipe" && (!action || action === "list" || action === "show")) ||
          (canonicalSub === "run" && action === "allowlist") ||
          (canonicalSub === "runner" && (!action || action === "show" || action === "status"));

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
          (!inspectOnly && CODE_HOST_EXEC_SURFACE.has(canonicalSub)) || mutatesSandbox || isProject;
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
          !inspectOnly &&
          !getWorkspaceRegistry(depsWithDb).hostExecAllowed
        ) {
          failCommandResponse(NO_CODE_ROOT_DENY);
          ctx.send(input.entity, NO_CODE_ROOT_DENY);
          return;
        }
        // The narrower gated set (earned competence). patch/propose stay rank 0
        // (read/propose are open per policy) and so are NOT gated here.
        // Posture-aware check: self-certification stays closed, while approved
        // runs, earned-posture reviewed practice, and an operator-declared
        // open posture authorize with their consequence recorded.
        if (
          (!inspectOnly && CODE_EXEC_SUBCOMMANDS.has(canonicalSub)) ||
          mutatesSandbox ||
          isProject
        ) {
          const gate = checkGateForExecution(depsWithDb.db, input.entity, "code.exec");
          if (!gate.ok) {
            failCommandResponse(gate.reason ?? "code.exec capability required.");
            refuseCommand(
              ctx,
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
