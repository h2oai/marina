import { accessSync, constants as fsConstants, readdirSync, statSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import type { AgentEvent, AgentHandle } from "../../agent/agent-types";
import {
  type CodePromptAnswerer,
  CodeSessionDriver,
  type CodingAgentRuntime,
} from "../../coding/code-session-driver";
import type { WorkspaceRunResult, WorkspaceRuntime } from "../../coding/local-workspace";
import { WorkspaceRegistry } from "../../coding/workspace-registry";
import type { ChannelManager } from "../../coordination/channel-manager";
import { CrewError, type CrewManager } from "../../coordination/crew-manager";
import { bold, dim, error as fmtError, header, separator, success } from "../../net/ansi";
import type { CodingArtifactRow, CodingSessionRow, MarinaDB } from "../../persistence/database";
import type { CommandDef, CrewFormation, Entity, EntityId, RoomContext } from "../../types";
import { checkGate, grant, recordDemonstration } from "../safety-gates";

const ACTIVE_SESSION_KEY = "coding_session_id";
const ACTIVE_MODAL_KEY = "active_modal";
const CODE_CONTEXT_KEY = "code_context";
const CODE_PROFILE_KEY = "code_profile";
const CODE_PROFILE_ALIASES_KEY = "code_profile_aliases";
const CODE_WORKSPACE_KEY = "code_workspace_root";

type CodeProfileName = "marina" | "pi" | "claude" | "codex";
type CodingNoteKind = "decision" | "handoff" | "observation" | "plan" | "summary";
type CompatibilityGrade = "adapter" | "native" | "narrow" | "planned";

interface CodeMessageMetadata {
  artifactId?: string;
  artifactKind?: string;
  checks?: CodeCheckRow[];
  command?: string[];
  commands?: string[];
  content?: string;
  durationMs?: number;
  event: string;
  events?: CodeEventRow[];
  exitCode?: number;
  metadata?: Record<string, unknown>;
  modelTarget?: string;
  phase?: string;
  parentSessionId?: string;
  paths?: string[];
  query?: string;
  rows?: CodeDataRow[];
  sessionId?: string;
  status?: string;
  timedOut?: boolean;
  title?: string;
  tree?: CodeTreeNode[];
  truncated?: boolean;
  type:
    | "artifact"
    | "command"
    | "diff"
    | "file"
    | "history"
    | "list"
    | "lifecycle"
    | "model"
    | "note"
    | "patch"
    | "profile"
    | "readiness"
    | "search"
    | "session"
    | "skill"
    | "tree"
    | "verification";
  workspace?: string;
}

interface CodeCheckRow {
  detail?: string;
  label: string;
  status: "fail" | "info" | "ok" | "warn";
}

interface CodeDataRow {
  action?: string;
  canonical?: string;
  detail?: string;
  grade?: CompatibilityGrade;
  id?: string;
  kind?: string;
  line?: number;
  portability?: string;
  path?: string;
  size?: number;
  status?: string;
  text?: string;
  title?: string;
  type?: string;
}

interface CodeEventRow {
  actor: string;
  kind: string;
  payload?: string;
  timestamp: number;
}

interface CodeContextSnapshot {
  assignedAgent?: string;
  latestArtifactId?: string;
  latestArtifactKind?: string;
  latestArtifactLifecycle?: string;
  latestArtifactStatus?: string;
  modelTarget?: string;
  pendingPatches: number;
  profile: CodeProfileName;
  sessionId?: string;
  sessionMode?: string;
  sessionStatus?: string;
  sessionTitle?: string;
  workspace?: string;
  writer?: string;
}

interface CodeTreeNode {
  active: boolean;
  children: CodeTreeNode[];
  id: string;
  status: string;
  title: string;
}

interface CodeProfile {
  aliases: Record<string, string>;
  description: string;
  name: CodeProfileName;
  prompt: string;
  steering: string[];
}

interface ProfileComparisonRow {
  action: string;
  behavior?: string;
  canonical: string;
  claude: string;
  codex: string;
  grade: CompatibilityGrade;
  marina: string;
  pi: string;
  portability: string;
  status: string;
}

const CODE_PROFILES: Record<CodeProfileName, CodeProfile> = {
  marina: {
    name: "marina",
    prompt: "code",
    description: "Marina-native coding profile: explicit primitives, durable artifacts.",
    aliases: {
      cat: "read",
      decision: "decision",
      handoff: "handoff",
      ls: "files",
      new: "start",
      note: "steer",
      plan: "plan",
      propose: "patch",
      sessions: "list",
      summary: "summary",
      use: "resume",
    },
    steering: [
      "plan <direction>",
      "summary <notes>",
      "handoff <notes>",
      "decision <choice>",
      "note <direction>",
    ],
  },
  pi: {
    name: "pi",
    prompt: "pi",
    description: "Pi-style coding profile: light harness vocabulary over Marina primitives.",
    aliases: {
      accept: "apply",
      changes: "diff",
      decline: "reject",
      decision: "decision",
      exec: "run",
      follow: "steer",
      followup: "steer",
      grep: "search",
      handoff: "handoff",
      log: "history",
      note: "steer",
      open: "read",
      outputs: "artifacts",
      plan: "plan",
      proposal: "patch",
      summary: "summary",
      switch: "resume",
      tree: "tree",
    },
    steering: [
      "plan <direction>",
      "summary <notes>",
      "handoff <notes>",
      "decision <choice>",
      "follow up <direction>",
      "note <direction>",
    ],
  },
  claude: {
    name: "claude",
    prompt: "claude",
    description:
      "Claude Code-style profile: conversational project work, review, and compact steering.",
    aliases: {
      accept: "apply",
      bash: "run",
      compact: "summary",
      decision: "decision",
      edit: "patch",
      grep: "search",
      handoff: "handoff",
      note: "steer",
      open: "read",
      plan: "plan",
      review: "diff",
      shell: "run",
      summary: "summary",
      think: "steer",
    },
    steering: [
      "plan <direction>",
      "summary <notes>",
      "handoff <notes>",
      "decision <choice>",
      "think <direction>",
      "compact <summary preference>",
      "note <direction>",
    ],
  },
  codex: {
    name: "codex",
    prompt: "codex",
    description: "Codex-style profile: concise inspect, patch, run, and verify loop.",
    aliases: {
      accept: "apply",
      changes: "diff",
      check: "verify",
      decision: "decision",
      exec: "run",
      grep: "search",
      handoff: "handoff",
      inspect: "files",
      note: "steer",
      open: "read",
      plan: "plan",
      rg: "search",
      shell: "run",
      summary: "summary",
      view: "read",
    },
    steering: [
      "plan <direction>",
      "summary <notes>",
      "handoff <notes>",
      "decision <choice>",
      "note <direction>",
    ],
  },
};

function sendCode(
  ctx: RoomContext,
  eid: EntityId,
  message: string,
  code: CodeMessageMetadata,
): void {
  ctx.send(eid, message, "code", { code });
}

const PROFILE_COMPARISON_ROWS: ProfileComparisonRow[] = [
  {
    action: "Enter coding mode",
    marina: "code",
    pi: "code profile use pi; code",
    claude: "code profile use claude; code",
    codex: "code profile use codex; code",
    canonical: "active_modal=code",
    grade: "native",
    portability: "vendor-neutral modal",
    status: "implemented",
  },
  {
    action: "Start work",
    marina: "start/new",
    pi: "start",
    claude: "start",
    codex: "start",
    canonical: "coding_session",
    grade: "native",
    portability: "Marina session row",
    status: "implemented",
  },
  {
    action: "Prompt context",
    marina: "code> context strip",
    pi: "session header",
    claude: "status/context",
    codex: "status/context",
    canonical: "entity.code_context",
    grade: "native",
    portability: "WebChat modal state",
    status: "implemented",
  },
  {
    action: "Help / command map",
    marina: "profile help",
    pi: "profile help pi",
    claude: "profile help claude",
    codex: "profile help codex",
    canonical: "profile adapter docs",
    grade: "native",
    portability: "migration map",
    status: "implemented",
  },
  {
    action: "Ask code model",
    marina: "ask",
    pi: "ask",
    claude: "ask",
    codex: "ask",
    canonical: "direct model artifact",
    grade: "native",
    portability: "Marina model surface",
    status: "implemented",
  },
  {
    action: "Check status",
    marina: "status",
    pi: "status",
    claude: "status",
    codex: "status",
    canonical: "session_status",
    grade: "native",
    portability: "session/artifact summary",
    status: "implemented",
  },
  {
    action: "Assign live agent",
    marina: "assign",
    pi: "assign",
    claude: "assign",
    codex: "assign",
    canonical: "agent attention",
    grade: "native",
    portability: "Marina agent runtime",
    status: "implemented",
  },
  {
    action: "Inspect files",
    marina: "files/ls",
    pi: "files",
    claude: "files",
    codex: "inspect",
    canonical: "workspace.list",
    grade: "adapter",
    portability: "workspace API",
    status: "implemented",
  },
  {
    action: "Read file",
    marina: "read/cat",
    pi: "open",
    claude: "open",
    codex: "view/open",
    canonical: "workspace.read",
    grade: "adapter",
    portability: "workspace API",
    status: "implemented",
  },
  {
    action: "Search",
    marina: "search",
    pi: "grep",
    claude: "grep",
    codex: "rg/grep",
    canonical: "workspace.search",
    grade: "adapter",
    portability: "workspace API",
    status: "implemented",
  },
  {
    action: "Review changes",
    marina: "diff",
    pi: "changes",
    claude: "review",
    codex: "changes",
    canonical: "workspace.diff",
    grade: "narrow",
    portability: "git diff surface",
    status: "implemented",
  },
  {
    action: "Run command",
    marina: "run",
    pi: "exec",
    claude: "bash/shell",
    codex: "exec/shell",
    canonical: "workspace.run artifact",
    grade: "narrow",
    portability: "allowlisted runner",
    status: "implemented",
  },
  {
    action: "Inspect run policy",
    marina: "run allowlist",
    pi: "exec allowlist",
    claude: "bash policy",
    codex: "sandbox/approval status",
    canonical: "workspace.runPolicy",
    grade: "native",
    portability: "host-local policy",
    status: "implemented",
  },
  {
    action: "Verify checks",
    marina: "verify; test/lint/typecheck run one command",
    pi: "exec test",
    claude: "run tests via bash",
    codex: "check -> verify; run test for one command",
    canonical: "verify -> verification; run -> command_output",
    grade: "native",
    portability: "local check runner",
    status: "implemented",
  },
  {
    action: "Verify app behavior",
    marina: "observe; run app planned",
    pi: "extension/skill",
    claude: "/verify",
    codex: "browser/test workflow",
    canonical: "observation artifact",
    grade: "planned",
    portability: "container-gated app launch",
    status: "planned",
  },
  {
    action: "Project run recipes",
    marina: "recipe list/save/run; verify uses default",
    pi: "exec recipe",
    claude: "custom command/checklist",
    codex: "check recipe",
    canonical: "run_recipe artifact",
    grade: "native",
    portability: "allowlisted command chain",
    behavior: "Recipes are durable session artifacts and never bypass host-local policy.",
    status: "implemented",
  },
  {
    action: "Checkpoint / revert",
    marina: "checkpoint; revert",
    pi: "checkpoint/tree",
    claude: "checkpoint/revert",
    codex: "checkpoint/revert",
    canonical: "checkpoint artifact",
    grade: "native",
    portability: "reverse-applied workspace diff",
    status: "implemented",
  },
  {
    action: "Coding approvals",
    marina: "approval request; approve; deny",
    pi: "approval card",
    claude: "permission prompt",
    codex: "approval request",
    canonical: "approval artifact",
    grade: "native",
    portability: "multiuser decision artifact",
    status: "implemented",
  },
  {
    action: "Coding crew plan",
    marina: "roles; crew; spawn request",
    pi: "crew/tree",
    claude: "subagents",
    codex: "assign/review",
    canonical: "crew_plan / spawn_request artifacts",
    grade: "adapter",
    portability: "Marina agent orchestration",
    behavior: "Live assignment is implemented; spawning is represented as a supervised request.",
    status: "implemented",
  },
  {
    action: "Code skills",
    marina: "skill list/add/use",
    pi: "skills",
    claude: "skills/commands",
    codex: "instructions/profile",
    canonical: "code_skill artifact",
    grade: "native",
    portability: "session-local skill registry",
    status: "implemented",
  },
  {
    action: "Model target",
    marina: "model show/set/clear",
    pi: "model target",
    claude: "model selector",
    codex: "model switch",
    canonical: "model_setting artifact",
    grade: "adapter",
    portability: "Marina model routing intent",
    behavior: "Stored per-session now; execution still uses configured Marina model surface.",
    status: "implemented",
  },
  {
    action: "External/editor link",
    marina: "external link/show/unlink",
    pi: "external session",
    claude: "IDE session",
    codex: "ACP/MCP session",
    canonical: "external_link artifact",
    grade: "adapter",
    portability: "future ACP/MCP routing handle",
    status: "implemented",
  },
  {
    action: "Artifact thread",
    marina: "thread",
    pi: "tree/thread",
    claude: "transcript summary",
    codex: "session summary",
    canonical: "typed artifact timeline",
    grade: "native",
    portability: "WebChat rich metadata",
    status: "implemented",
  },
  {
    action: "Propose edit",
    marina: "patch/propose",
    pi: "proposal",
    claude: "edit",
    codex: "patch",
    canonical: "patch artifact",
    grade: "narrow",
    portability: "unified diff artifact",
    status: "implemented",
  },
  {
    action: "Accept edit",
    marina: "apply",
    pi: "accept",
    claude: "accept",
    codex: "accept",
    canonical: "apply patch",
    grade: "adapter",
    portability: "patch artifact",
    status: "implemented",
  },
  {
    action: "Record plan",
    marina: "plan",
    pi: "plan",
    claude: "plan",
    codex: "plan",
    canonical: "plan artifact",
    grade: "native",
    portability: "typed artifact",
    status: "implemented",
  },
  {
    action: "Record summary",
    marina: "summary",
    pi: "summary",
    claude: "summary/compact",
    codex: "summary",
    canonical: "summary artifact",
    grade: "native",
    portability: "typed artifact",
    status: "implemented",
  },
  {
    action: "Record handoff",
    marina: "handoff",
    pi: "handoff",
    claude: "handoff",
    codex: "handoff",
    canonical: "handoff artifact",
    grade: "native",
    portability: "typed artifact",
    status: "implemented",
  },
  {
    action: "Record decision",
    marina: "decision",
    pi: "decision",
    claude: "decision",
    codex: "decision",
    canonical: "decision artifact",
    grade: "native",
    portability: "typed artifact",
    status: "implemented",
  },
  {
    action: "Record loose steering",
    marina: "steer/note",
    pi: "follow/note",
    claude: "think/note",
    codex: "note",
    canonical: "session_steered event",
    grade: "native",
    portability: "session event",
    status: "implemented",
  },
  {
    action: "Pin artifact",
    marina: "pin",
    pi: "pin",
    claude: "pin",
    codex: "pin",
    canonical: "artifact lifecycle pinned",
    grade: "native",
    portability: "artifact lifecycle",
    status: "implemented",
  },
  {
    action: "Archive artifact",
    marina: "archive",
    pi: "archive",
    claude: "clear/archive",
    codex: "archive",
    canonical: "artifact lifecycle archived",
    grade: "native",
    portability: "artifact lifecycle",
    status: "implemented",
  },
  {
    action: "Supersede artifact",
    marina: "supersede",
    pi: "supersede",
    claude: "compact/supersede",
    codex: "supersede",
    canonical: "artifact lifecycle superseded",
    grade: "native",
    portability: "artifact lifecycle",
    status: "implemented",
  },
  {
    action: "List failures",
    marina: "artifacts failed; show last failed",
    pi: "outputs failed",
    claude: "review failed output",
    codex: "show last failed",
    canonical: "artifact status/exit metadata",
    grade: "native",
    portability: "durable output triage",
    behavior: "Finds failed command, verification, and denied app artifacts.",
    status: "implemented",
  },
  {
    action: "Session branching",
    marina: "branch/tree",
    pi: "tree",
    claude: "branch/handoff",
    codex: "branch/tree",
    canonical: "parent_session_id",
    grade: "native",
    portability: "multiuser session tree",
    behavior: "Keeps alternate attempts as durable branches instead of replacing context.",
    status: "implemented",
  },
  {
    action: "Approval semantics",
    marina: "patch then apply; run allowlist",
    pi: "accept/decline",
    claude: "approval prompt",
    codex: "approval policy",
    canonical: "artifact + host policy",
    grade: "narrow",
    portability: "explicit local safety",
    behavior: "Patch writes require explicit apply; commands are limited by host-local policy.",
    status: "implemented",
  },
];

const BASE_HELP = `Local coding sessions.
Usage:
  code                        Enter Code Mode
  code profile                Show active code profile
  code profile list           List code profiles
  code profile compare        Compare profiles to Marina primitives
  code profile help [name]    Show migration help for a profile
  code profile use <name>     Use a code profile
  code profile alias <a> <b>  Add a personal Code Mode alias
  code workspace              Show active/default code workspace
  code workspace list         List configured code workspace roots
  code workspace discover     Find likely projects under configured roots
  code workspace use <path>   Select a workspace root for new sessions
  code doctor                 Inspect Code Mode workspace readiness
  code onboard                Show workspace/session readiness guidance
  code ask <request>          Ask the default Marina code model for this session
  code assign <agent> <req>   Assign this coding session to a live Marina agent
  code roles                  Show suggested coding-agent roles
  code crew <goal> [with <a,b>] Dispatch a crew; with no members, auto-assemble (recruit + gated spawn)
  code writer [<agent>]       Show or reassign the session write lock
  code task <title>           Create a task linked to this coding session
  code spawn <role> <goal>    Store a reviewed agent-spawn request
  code model                  Show per-session code model target
  code model set <target>     Set per-session code model target
  code recipe                 List detected/stored verification recipes
  code recipe save <n> <cmds> Store a verification recipe (use "then" between commands)
  code recipe run <name>      Run a stored or detected recipe
  code checkpoint [title]     Store current workspace diff as a checkpoint
  code revert <checkpoint>    Reverse-apply a checkpoint diff
  code approvals              List pending coding approvals
  code approval request <k> <desc> Store an approval request
  code approve|deny <id>      Decide a pending coding approval
  code skill                  List code-modal skills
  code skill add <name> <text> Store a code-modal skill
  code skill use <name>       Record skill use in this session
  code thread                 Show a compact artifact thread
  code external               Show external session links
  code external link <system> <id> Link an external coding surface
  code start [title]          Start a coding session for the server workspace
  code branch [title]         Branch the active coding session
  code tree                   Show session branch lineage
  code done [summary]         Complete the active coding session
  code list                   List your coding sessions
  code resume <session_id>    Make a session active
  code status [session_id]    Show session status
  code files [path]           List workspace files
  code read <path>            Read a workspace file
  code search <query>         Search workspace text
  code diff [path]            Show git diff
  code run <check|cmd...>     Run an allowed workspace command and store output
  code run allowlist          Show host-local allowed commands
  code run app [script]       Planned: container-gated app run/observation
  code observe <note>         Store an app/workspace observation
  code verify                 Run detected typecheck/lint/test/build chain
  code test|lint|typecheck    Run a common verification command
  code patch [title]\\n<diff>  Propose a unified-diff patch
  code artifacts [recent|failed|status <s>|kind <k>] List coding artifacts
  code patches [status]       List proposed patches
  code show <artifact_id|last|last patch|last failed> Show a coding artifact
  code pin <artifact_id|last> Archive-protect a non-pending artifact
  code unpin <artifact_id|last> Remove artifact archive protection
  code archive <artifact_id|last> Mark an artifact archived
  code supersede <artifact_id|last> Mark an artifact superseded
  code apply <patch_id|last patch> Apply a pending patch
  code reject <patch_id|last patch> Reject a pending patch
  code history [session_id]   Show recent coding events
  code plan <direction>       Store a plan artifact
  code summary <notes>        Store a summary artifact
  code handoff <notes> [to <agent>] Store a handoff artifact; transfer the write lock when "to" given
  code decision <choice>      Store a decision artifact
  code steer <direction>      Record steering on the active session
  code exit                   Leave Code Mode

In Code Mode, omit the "code" prefix: start, files, read <path>, run test, exit.
This first cut is local-CWD only and path-confined. Writes happen only by applying a stored patch.`;

// Subcommands that execute host processes or mutate the workspace. These are
// gated behind the `code.exec` safety gate (earned competence) so a freshly
// spawned, zero-standing agent cannot reach arbitrary host code execution via
// `code apply` + `code run`. Read/inspect/propose subcommands stay ungated.
const CODE_EXEC_SUBCOMMANDS = new Set<string>([
  "run",
  "verify",
  "test",
  "lint",
  "typecheck",
  "recipe",
  "apply",
  "revert",
]);

export interface CodeDeps {
  agentRuntime?: CodingAgentRuntime;
  answerPrompt?: CodePromptAnswerer;
  channelManager?: ChannelManager;
  crewManager?: CrewManager;
  db?: MarinaDB;
  findAgentByName?: (name: string) => Entity | undefined;
  listAgents?: () => { name: string }[];
  workspace?: WorkspaceRuntime;
  workspaceRegistry?: WorkspaceRegistry;
  getEntity: (id: string) => Entity | undefined;
  /** Send a line to a specific entity's connection — used to stream a bound
   *  coding agent's live activity back to the human who dispatched the task. */
  notify?: (entityId: string, message: string, metadata?: Record<string, unknown>) => void;
}

export function codeCommand(deps: CodeDeps): CommandDef {
  return {
    name: "code",
    aliases: [],
    category: "Agents",
    help: formatHelp(CODE_PROFILES.marina),
    handler: async (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;
      if (!deps.db) {
        ctx.send(input.entity, "Coding sessions require database support.");
        return;
      }
      const depsWithDb: CodeDeps & { db: MarinaDB } = { ...deps, db: deps.db };
      const driver = new CodeSessionDriver({
        agentRuntime: deps.agentRuntime,
        answerPrompt: deps.answerPrompt,
        db: deps.db,
        getEntity: deps.getEntity,
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
        if (CODE_EXEC_SUBCOMMANDS.has(canonicalSub)) {
          const gate = checkGate(depsWithDb.db, input.entity, "code.exec");
          if (!gate.ok) {
            ctx.send(
              input.entity,
              gate.reason ??
                "Running or applying code requires the code.exec capability, which is earned through contribution.",
            );
            return;
          }
          if (gate.supervisedOnly) {
            recordDemonstration(depsWithDb.db, input.entity, "code.exec");
          }
        }

        switch (canonicalSub) {
          case "help":
            ctx.send(input.entity, formatHelp(profile));
            return;
          case "doctor":
            await doctor(ctx, input.entity, entity, depsWithDb);
            return;
          case "onboard":
          case "setup":
            await doctor(ctx, input.entity, entity, depsWithDb);
            return;
          case "exit":
          case "back":
          case "world":
            exitCodeMode(ctx, input.entity, entity, depsWithDb);
            return;
          case "start":
          case "new":
            startSession(ctx, input.entity, entity, depsWithDb, args.join(" "));
            return;
          case "branch":
            branchSession(ctx, input.entity, entity, depsWithDb, args.join(" "));
            return;
          case "tree":
            treeSessions(ctx, input.entity, entity, deps.db);
            return;
          case "done":
            completeSession(ctx, input.entity, entity, depsWithDb, rawAfterSub);
            return;
          case "ask":
            await askCode(ctx, input.entity, entity, depsWithDb, driver, rawAfterSub);
            return;
          case "assign":
            await assignCode(ctx, input.entity, entity, depsWithDb, driver, args);
            return;
          case "roles":
            roles(ctx, input.entity);
            return;
          case "crew":
            await crewPlan(ctx, input.entity, entity, depsWithDb, rawAfterSub);
            return;
          case "writer":
            writerCommand(ctx, input.entity, entity, depsWithDb, args);
            return;
          case "task":
            sessionTask(ctx, input.entity, entity, depsWithDb, rawAfterSub);
            return;
          case "spawn":
            await spawnRequest(ctx, input.entity, entity, depsWithDb, args);
            return;
          case "model":
            modelSetting(ctx, input.entity, entity, depsWithDb, args);
            return;
          case "recipe":
            await recipe(ctx, input.entity, entity, depsWithDb, args);
            return;
          case "checkpoint":
            await checkpoint(ctx, input.entity, entity, depsWithDb, rawAfterSub);
            return;
          case "revert":
            await revertCheckpoint(ctx, input.entity, entity, depsWithDb, args.join(" "));
            return;
          case "approvals":
            approvals(ctx, input.entity, entity, depsWithDb);
            return;
          case "approval":
            approval(ctx, input.entity, entity, depsWithDb, args);
            return;
          case "approve":
            decideApproval(ctx, input.entity, entity, depsWithDb, args.join(" "), "approved");
            return;
          case "deny":
            decideApproval(ctx, input.entity, entity, depsWithDb, args.join(" "), "denied");
            return;
          case "skill":
            skill(ctx, input.entity, entity, depsWithDb, args);
            return;
          case "thread":
            thread(ctx, input.entity, entity, depsWithDb);
            return;
          case "external":
            externalLink(ctx, input.entity, entity, depsWithDb, args);
            return;
          case "list":
          case "sessions":
            listSessions(ctx, input.entity, entity, deps.db);
            return;
          case "resume":
          case "use":
            resumeSession(ctx, input.entity, entity, depsWithDb, args[0]);
            return;
          case "status":
            status(ctx, input.entity, entity, depsWithDb, args[0]);
            return;
          case "files":
          case "ls":
            files(ctx, input.entity, entity, depsWithDb, args.join(" ") || ".");
            return;
          case "read":
          case "cat":
            await readFile(ctx, input.entity, entity, depsWithDb, args.join(" "));
            return;
          case "search":
            await search(ctx, input.entity, entity, depsWithDb, args.join(" "));
            return;
          case "diff":
            await diff(ctx, input.entity, entity, depsWithDb, args.join(" "));
            return;
          case "run":
            await runWorkspaceCommand(ctx, input.entity, entity, depsWithDb, args);
            return;
          case "verify":
            await verifyWorkspace(ctx, input.entity, entity, depsWithDb);
            return;
          case "test":
          case "lint":
          case "typecheck":
          case "build":
          case "dashboard:build":
            await runWorkspaceCommand(ctx, input.entity, entity, depsWithDb, [canonicalSub]);
            return;
          case "patch":
          case "propose":
            await proposePatch(ctx, input.entity, entity, depsWithDb, rawAfterSub);
            return;
          case "artifacts":
            artifacts(ctx, input.entity, entity, depsWithDb, args);
            return;
          case "patches":
            patches(ctx, input.entity, entity, depsWithDb, args);
            return;
          case "show":
            showArtifact(ctx, input.entity, entity, depsWithDb, args.join(" "));
            return;
          case "pin":
            lifecycleArtifact(ctx, input.entity, entity, depsWithDb, args.join(" "), "pinned");
            return;
          case "unpin":
            lifecycleArtifact(ctx, input.entity, entity, depsWithDb, args.join(" "), "active");
            return;
          case "archive":
            lifecycleArtifact(ctx, input.entity, entity, depsWithDb, args.join(" "), "archived");
            return;
          case "supersede":
            lifecycleArtifact(ctx, input.entity, entity, depsWithDb, args.join(" "), "superseded");
            return;
          case "apply":
            await applyPatch(ctx, input.entity, entity, depsWithDb, args.join(" "));
            return;
          case "reject":
            rejectPatch(ctx, input.entity, entity, depsWithDb, args);
            return;
          case "history":
            history(ctx, input.entity, entity, depsWithDb, args[0]);
            return;
          case "plan":
          case "summary":
          case "handoff":
          case "decision":
            recordCodingNote(ctx, input.entity, entity, depsWithDb, canonicalSub, args);
            return;
          case "steer":
            steer(ctx, input.entity, entity, depsWithDb, args);
            return;
          case "observe":
            observe(ctx, input.entity, entity, depsWithDb, args);
            return;
          case "do":
            // Explicit agentic dispatch: hand a natural-language task to the
            // session's driver (default: a single bound coding agent).
            await doCode(ctx, input.entity, entity, depsWithDb, driver, rawAfterSub);
            return;
          case "driver":
            driverCommand(ctx, input.entity, entity, depsWithDb, args);
            return;
          default: {
            // In Code Mode, anything that isn't a known subcommand is a
            // natural-language task — route it to the driver (Codex/Claude-style)
            // instead of dumping help. Outside the modal, fall back to help.
            const line = input.tokens.join(" ").trim();
            if (entity.properties[ACTIVE_MODAL_KEY] === "code" && line) {
              await doCode(ctx, input.entity, entity, depsWithDb, driver, line);
            } else {
              ctx.send(input.entity, formatHelp(profile));
            }
          }
        }
      } catch (err) {
        ctx.send(input.entity, fmtError(err instanceof Error ? err.message : String(err)));
      }
    },
  };
}

function enterCodeMode(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
): void {
  entity.properties[ACTIVE_MODAL_KEY] = "code";
  const sessionId = getActiveSessionId(entity);
  const session = sessionId ? deps.db.getCodingSession(sessionId) : null;
  updateCodeContext(entity, deps.db, session ?? undefined);
  const profile = getCodeProfile(entity);
  const registry = getWorkspaceRegistry(deps);
  const selectedRoot = session?.workspace_root ?? getSelectedWorkspaceRoot(entity, deps);

  // Evaluate the current directory on entry — a quick top-level listing so it's
  // clear Code Mode is looking at the workspace (orient now, act on the task).
  let overview = "";
  try {
    const entries = registry.workspaceForRoot(selectedRoot).list(".", 14);
    if (entries.length > 0) {
      const names = entries.map((e) => (e.type === "dir" ? `${e.path}/` : e.path));
      overview = `Contents: ${dim(names.join("  "))}`;
    }
  } catch {
    // Unlistable root (permissions / missing) — skip the overview, not fatal.
  }

  ctx.send(
    eid,
    [
      success("Code Mode active."),
      `Profile: ${profile.name} ${dim(`prompt: ${profile.prompt}>`)}`,
      `Workspace: ${selectedRoot}${registry.usesCwdFallback ? dim(" (process cwd fallback)") : ""}`,
      overview,
      session ? `Session: ${session.id} ${dim(session.status)}` : dim("No active session yet."),
      "",
      bold("Just say what you want done") +
        dim(' — e.g. "add a health check endpoint and a test for it".'),
      dim("A coding agent will explore, edit, and run checks autonomously. Or use commands:"),
      dim(`  ${formatProfileTry(profile)} | code crew <goal> | onboard | exit`),
      registry.usesCwdFallback ? dim("Configure MARINA_CODE_ROOTS for production workspaces.") : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function exitCodeMode(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
): void {
  if (entity.properties[ACTIVE_MODAL_KEY] === "code") {
    delete entity.properties[ACTIVE_MODAL_KEY];
    delete entity.properties[CODE_CONTEXT_KEY];
    deps.db.saveEntity(entity);
  }
  stopCodeStreamsFor(eid); // stop forwarding the bound agent's activity
  ctx.send(eid, success("Exited Code Mode."));
}

function handleProfile(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): void {
  const action = args[0]?.toLowerCase() ?? "show";
  if (action === "list") {
    const active = getCodeProfile(entity).name;
    const lines = [header("Code Profiles"), separator()];
    for (const profile of Object.values(CODE_PROFILES)) {
      const mark = profile.name === active ? "*" : " ";
      lines.push(`${mark} ${profile.name} ${dim(`${profile.prompt}>`)} ${profile.description}`);
    }
    ctx.send(eid, lines.join("\n"));
    return;
  }
  if (action === "compare") {
    const active = getCodeProfile(entity).name;
    sendCode(ctx, eid, formatProfileComparison(active), {
      commands: [
        "code profile help marina",
        "code profile help pi",
        "code profile help claude",
        "code profile help codex",
      ],
      event: "profile_compared",
      rows: profileComparisonRows(),
      status: "complete",
      title: "Code Profile Comparison",
      type: "profile",
    });
    return;
  }
  if (action === "help") {
    const requested = args[1];
    const name = requested ? normalizeProfileName(requested) : getCodeProfile(entity).name;
    if (!name) {
      ctx.send(eid, `Usage: code profile help [${Object.keys(CODE_PROFILES).join("|")}]`);
      return;
    }
    sendCode(ctx, eid, formatProfileDetail(CODE_PROFILES[name]), {
      commands: ["code profile compare", `code profile use ${name}`, "code"],
      event: "profile_help_shown",
      rows: profileComparisonRows(name),
      status: "complete",
      title: `Code Profile: ${name}`,
      type: "profile",
    });
    return;
  }
  if (action === "use" || action === "set") {
    const name = normalizeProfileName(args[1]);
    if (!name) {
      ctx.send(eid, `Usage: code profile use <${Object.keys(CODE_PROFILES).join("|")}>`);
      return;
    }
    entity.properties[CODE_PROFILE_KEY] = name;
    const sessionId = getActiveSessionId(entity);
    updateCodeContext(
      entity,
      deps.db,
      sessionId ? (deps.db.getCodingSession(sessionId) ?? undefined) : undefined,
    );
    const profile = CODE_PROFILES[name];
    ctx.send(
      eid,
      [
        success(`Code profile set: ${profile.name}`),
        `Prompt: ${profile.prompt}>`,
        `Aliases: ${formatAliases(profile)}`,
        `Steering: ${profile.steering.join(" | ")}`,
      ].join("\n"),
    );
    return;
  }
  if (action === "aliases") {
    const profile = getCodeProfile(entity);
    ctx.send(
      eid,
      `${header(`Aliases: ${profile.name}`)}\n${formatAliases(profile)}\n${dim(
        "Use: code profile alias <alias> <command> | code profile alias clear <alias>",
      )}`,
    );
    return;
  }
  if (action === "alias") {
    const aliasAction = args[1]?.toLowerCase();
    if (!aliasAction) {
      ctx.send(
        eid,
        "Usage: code profile alias <alias> <command> | code profile alias clear <alias>",
      );
      return;
    }
    const aliases = getCustomProfileAliases(entity);
    if (aliasAction === "clear") {
      const alias = args[2]?.toLowerCase();
      if (!alias) {
        ctx.send(eid, "Usage: code profile alias clear <alias>");
        return;
      }
      delete aliases[alias];
      entity.properties[CODE_PROFILE_ALIASES_KEY] = aliases;
      deps.db.saveEntity(entity);
      ctx.send(eid, success(`Code alias cleared: ${alias}`));
      return;
    }
    const target = args[2]?.toLowerCase();
    if (!target) {
      ctx.send(eid, "Usage: code profile alias <alias> <command>");
      return;
    }
    aliases[aliasAction] = target;
    entity.properties[CODE_PROFILE_ALIASES_KEY] = aliases;
    deps.db.saveEntity(entity);
    ctx.send(eid, success(`Code alias saved: ${aliasAction} -> ${target}`));
    return;
  }
  if (action !== "show") {
    ctx.send(eid, "Usage: code profile [show|list|compare|help|use|aliases]");
    return;
  }

  const profile = getCodeProfile(entity);
  ctx.send(
    eid,
    [
      header("Code Profile"),
      separator(),
      `Name: ${profile.name}`,
      `Prompt: ${profile.prompt}>`,
      `Description: ${profile.description}`,
      `Aliases: ${formatAliases(profile)}`,
      `Steering: ${profile.steering.join(" | ")}`,
    ].join("\n"),
  );
}

function handleWorkspace(
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

function startSession(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  titleArg: string,
): void {
  const workspace = getSelectedWorkspace(entity, deps);
  const registry = getWorkspaceRegistry(deps);
  const title = titleArg.trim() || `${basename(workspace.displayRoot())} coding session`;
  const session = deps.db.createCodingSession({
    id: `code_${crypto.randomUUID().slice(0, 12)}`,
    title,
    workspaceRoot: workspace.displayRoot(),
    createdBy: entity.name,
  });
  entity.properties[ACTIVE_SESSION_KEY] = session.id;
  updateCodeContext(entity, deps.db, session);
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "session_started",
    payload: { title: session.title, workspaceRoot: session.workspace_root },
  });

  sendCode(
    ctx,
    eid,
    [
      success(`Coding session started: ${session.id}`),
      `Title: ${session.title}`,
      `Workspace: ${session.workspace_root}`,
      registry.usesCwdFallback
        ? dim(
            "Workspace is the process cwd fallback. Use code workspace use <path> or MARINA_CODE_ROOTS for production.",
          )
        : "",
      dim("Try: code files | code search <query> | code read <path> | code diff"),
    ]
      .filter(Boolean)
      .join("\n"),
    {
      commands: ["code files", "code search <query>", "code read <path>", "code diff"],
      event: "session_started",
      sessionId: session.id,
      status: session.status,
      title: session.title,
      type: "session",
      workspace: session.workspace_root,
    },
  );
}

function branchSession(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  titleArg: string,
): void {
  const parent = resolveSession(ctx, eid, entity, deps.db);
  if (!parent) return;
  const title = titleArg.trim() || `${parent.title} branch`;
  const session = deps.db.createCodingSession({
    id: `code_${crypto.randomUUID().slice(0, 12)}`,
    title,
    workspaceRoot: parent.workspace_root,
    createdBy: entity.name,
  });
  entity.properties[ACTIVE_SESSION_KEY] = session.id;
  updateCodeContext(entity, deps.db, session);
  deps.db.createCodingEvent({
    sessionId: parent.id,
    actor: entity.name,
    kind: "session_branch_created",
    payload: { childSessionId: session.id, title: session.title },
  });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "session_branched",
    payload: { parentSessionId: parent.id, parentTitle: parent.title },
  });

  sendCode(
    ctx,
    eid,
    [
      success(`Coding session branched: ${session.id}`),
      `Parent: ${parent.id}`,
      `Title: ${session.title}`,
      `Workspace: ${session.workspace_root}`,
      dim("Use: code tree | code status | code files"),
    ].join("\n"),
    {
      commands: ["code tree", "code status", "code files"],
      event: "session_branched",
      parentSessionId: parent.id,
      sessionId: session.id,
      status: session.status,
      title: session.title,
      type: "session",
      workspace: session.workspace_root,
    },
  );
}

function listSessions(ctx: RoomContext, eid: EntityId, entity: Entity, db: MarinaDB): void {
  const sessions = db.listCodingSessions(entity.name, 12);
  if (sessions.length === 0) {
    ctx.send(eid, 'No coding sessions. Start one with "code start".');
    return;
  }
  const active = getActiveSessionId(entity);
  const lines = [header("Coding Sessions"), separator()];
  for (const s of sessions) {
    const mark = s.id === active ? "*" : " ";
    lines.push(
      `${mark} ${s.id} ${dim(s.status)} ${s.title} ${dim(new Date(s.updated_at).toLocaleString())}`,
    );
  }
  sendCode(ctx, eid, lines.join("\n"), {
    commands: ["code status", "code resume <session_id>", "code tree"],
    event: "sessions_listed",
    rows: sessions.map((session) => ({
      id: session.id,
      status: session.status,
      title: session.title,
      type: session.id === active ? "active_session" : "session",
    })),
    title: "Coding Sessions",
    type: "list",
  });
}

function treeSessions(ctx: RoomContext, eid: EntityId, entity: Entity, db: MarinaDB): void {
  const sessions = db.listCodingSessions(entity.name, 50);
  if (sessions.length === 0) {
    ctx.send(eid, 'No coding sessions. Start one with "code start".');
    return;
  }
  const active = getActiveSessionId(entity);
  const children = new Map<string, string[]>();
  const parentByChild = new Map<string, string>();
  for (const session of sessions) {
    for (const event of db.listCodingEvents(session.id, 100)) {
      const payload = parseEventPayload(event);
      if (event.kind === "session_branched" && typeof payload.parentSessionId === "string") {
        parentByChild.set(session.id, payload.parentSessionId);
      }
      if (event.kind === "session_branch_created" && typeof payload.childSessionId === "string") {
        const list = children.get(session.id) ?? [];
        list.push(payload.childSessionId);
        children.set(session.id, list);
      }
    }
  }
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const roots = sessions.filter((session) => !parentByChild.has(session.id));
  const lines = [header("Coding Session Tree"), separator()];
  const toNode = (session: CodingSessionRow): CodeTreeNode => ({
    active: session.id === active,
    children: (children.get(session.id) ?? [])
      .map((childId) => byId.get(childId))
      .filter((child): child is CodingSessionRow => Boolean(child))
      .map(toNode),
    id: session.id,
    status: session.status,
    title: session.title,
  });
  const visit = (session: CodingSessionRow, depth: number) => {
    const mark = session.id === active ? "*" : " ";
    lines.push(
      `${"  ".repeat(depth)}${mark} ${session.id} ${dim(session.status)} ${session.title}`,
    );
    for (const childId of children.get(session.id) ?? []) {
      const child = byId.get(childId);
      if (child) visit(child, depth + 1);
    }
  };
  for (const root of roots) visit(root, 0);
  sendCode(ctx, eid, lines.join("\n"), {
    commands: ["code branch <title>", "code resume <session_id>", "code status"],
    event: "session_tree",
    sessionId: active,
    tree: roots.map(toNode),
    type: "tree",
  });
}

function resumeSession(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  id: string | undefined,
): void {
  if (!id) {
    ctx.send(eid, "Usage: code resume <session_id>");
    return;
  }
  const session = deps.db.getCodingSession(id);
  if (!session) {
    ctx.send(eid, `Coding session not found: ${id}`);
    return;
  }
  entity.properties[ACTIVE_SESSION_KEY] = session.id;
  updateCodeContext(entity, deps.db, session);
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "session_resumed",
    payload: {},
  });
  sendCode(ctx, eid, success(`Active coding session: ${session.id}`), {
    commands: ["code status", "code files", "code history"],
    event: "session_resumed",
    sessionId: session.id,
    status: session.status,
    title: session.title,
    type: "session",
    workspace: session.workspace_root,
  });
}

async function askCode(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  driver: CodeSessionDriver,
  prompt: string,
): Promise<void> {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const profile = getCodeProfile(entity);
  const modelTarget = getSessionModelTarget(deps.db, session.id);
  const artifact = await driver.runDirect({
    actor: entity.name,
    modelTarget,
    profile: profile.name,
    prompt,
    session,
  });
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  sendCode(
    ctx,
    eid,
    [
      success(`Code response stored: ${artifact.id}`),
      dim(`Strategy: direct model | Session: ${session.id}`),
      separator(),
      artifact.content_text,
    ].join("\n"),
    {
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      commands: [`code show ${artifact.id}`, "code status"],
      content: artifact.content_text,
      event: "code_response_stored",
      modelTarget,
      sessionId: session.id,
      status: artifact.status,
      title: artifact.title,
      type: "skill",
      workspace: session.workspace_root,
    },
  );
}

async function assignCode(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  driver: CodeSessionDriver,
  args: string[],
): Promise<void> {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const agentName = args[0];
  const prompt = args.slice(1).join(" ");
  const profile = getCodeProfile(entity);
  const modelTarget = getSessionModelTarget(deps.db, session.id);
  const artifact = await driver.assignAgent({
    actor: entity.name,
    agentName: agentName ?? "",
    modelTarget,
    profile: profile.name,
    prompt,
    session,
  });
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  sendCode(
    ctx,
    eid,
    [
      success(`Coding session assigned: ${agentName}`),
      `Session: ${session.id}`,
      `Artifact: ${artifact.id}`,
      dim("The agent will continue through Marina's normal attention/tool loop."),
    ].join("\n"),
    {
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      commands: [`code show ${artifact.id}`, "code status", "code history"],
      content: artifact.content_text,
      event: "code_agent_assigned",
      modelTarget,
      rows: [
        {
          detail: prompt,
          id: agentName,
          status: artifact.status,
          title: agentName,
          type: "agent",
        },
      ],
      sessionId: session.id,
      status: artifact.status,
      title: `Assigned: ${agentName}`,
      type: "artifact",
      workspace: session.workspace_root,
    },
  );
}

const CODING_ROLES = [
  ["planner", "Turns the goal into a small ordered plan and acceptance criteria."],
  ["implementer", "Makes the smallest coherent patch against the workspace."],
  ["reviewer", "Reviews diffs for correctness, regressions, and missing tests."],
  ["tester", "Runs allowed checks and records verification artifacts."],
  ["security", "Looks for path, secret, network, auth, and data risks."],
  ["release", "Writes summary, handoff, and operator-facing notes."],
] as const;

function roles(ctx: RoomContext, eid: EntityId): void {
  const lines = [header("Coding Roles"), separator()];
  for (const [role, detail] of CODING_ROLES) {
    lines.push(`  ${role} ${dim(detail)}`);
  }
  sendCode(ctx, eid, lines.join("\n"), {
    commands: ["code crew <goal>", "code spawn <role> <goal>", "code assign <agent> <request>"],
    event: "coding_roles_shown",
    rows: CODING_ROLES.map(([role, detail]) => ({
      id: role,
      detail,
      title: role,
      type: "role",
    })),
    title: "Coding Roles",
    type: "list",
  });
}

/**
 * Parse `code crew <goal> [with <agentA,agentB,...>]`. The optional trailing
 * `with <members>` clause names live agents who should join the crew; the goal
 * is everything before it.
 */
function parseCrewArgs(raw: string): { goal: string; members: string[] } {
  const match = raw.match(/\bwith\b/i);
  if (!match || match.index === undefined) {
    return { goal: raw.trim(), members: [] };
  }
  const goal = raw.slice(0, match.index).trim();
  const memberPart = raw.slice(match.index + match[0].length).trim();
  const members = memberPart
    .split(/[,\s]+/)
    .map((m) => m.trim())
    .filter(Boolean);
  return { goal, members };
}

async function crewPlan(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  rawGoal: string,
): Promise<void> {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const { goal: text, members } = parseCrewArgs(rawGoal);
  if (!text) {
    ctx.send(eid, "Usage: code crew <goal> [with <agentA,agentB,...>]");
    return;
  }
  const body = [
    `Goal: ${text}`,
    "",
    "Suggested crew:",
    ...CODING_ROLES.map(([role, detail]) => `- ${role}: ${detail}`),
    "",
    members.length > 0
      ? `Members requested: ${members.join(", ")}`
      : "Next: name members with code crew <goal> with <agentA,agentB,...>, assign live agents with code assign, or request supervised spawns with code spawn.",
  ].join("\n");
  // Always write the crew_plan proposal trail.
  const planArtifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: "crew_plan",
    title: formatCodingNoteTitle("plan", text).replace("Plan:", "Crew plan:"),
    status: "planned",
    contentText: body,
    metadata: { goal: text, roles: CODING_ROLES.map(([role]) => role), members },
    createdBy: entity.name,
  });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "coding_crew_planned",
    payload: { id: planArtifact.id, goal: text, members },
  });

  // Two dispatch paths, both degrade to the crew_plan-only proposal trail:
  //  - explicit `with <a,b>`: resolve the named agents (recruited) and dispatch.
  //  - bare `code crew <goal>`: autonomously assemble (recruit + gated spawn).
  if (members.length > 0) {
    if (deps.crewManager && deps.channelManager) {
      const assembled = resolveNamedMembers(ctx, eid, deps, members);
      if (assembled.length > 0) {
        const dispatched = await dispatchCodingCrew(
          ctx,
          eid,
          entity,
          deps,
          session,
          text,
          assembled,
          planArtifact.id,
        );
        if (dispatched) return;
      }
    } else {
      ctx.send(
        eid,
        dim(
          "Live crew dispatch is unavailable in this Marina process; stored the crew plan instead.",
        ),
      );
    }
  } else if (deps.crewManager && deps.channelManager) {
    const assembled = await assembleCodingCrew(ctx, eid, entity, deps, session, text);
    if (assembled.length > 0) {
      const dispatched = await dispatchCodingCrew(
        ctx,
        eid,
        entity,
        deps,
        session,
        text,
        assembled,
        planArtifact.id,
      );
      if (dispatched) return;
    } else {
      ctx.send(
        eid,
        dim(
          "Could not assemble a crew — need agent.spawn competence or online coding agents. Stored the crew plan instead.",
        ),
      );
    }
  }

  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  sendCode(ctx, eid, `${success(`Coding crew plan stored: ${planArtifact.id}`)}\n${body}`, {
    artifactId: planArtifact.id,
    artifactKind: planArtifact.kind,
    commands: [
      `code show ${planArtifact.id}`,
      "code roles",
      "code crew <goal> with <agentA,agentB>",
      "code assign <agent> <request>",
    ],
    content: body,
    event: "coding_crew_planned",
    rows: CODING_ROLES.map(([role, detail]) => ({ id: role, detail, title: role, type: "role" })),
    sessionId: session.id,
    status: planArtifact.status,
    title: planArtifact.title,
    type: "artifact",
    workspace: session.workspace_root,
  });
}

/**
 * A crew member ready to dispatch. `source` records how the member joined:
 * `recruited` for an existing live agent named (or auto-picked), `spawned` for
 * an agent launched through the `agent.spawn` gate during autonomous assembly.
 * `role` is the coding role we want the crew to assign; when undefined the crew
 * falls back to its own default (preserves the explicit-`with` behavior).
 */
interface AssembledMember {
  agentName: string;
  id: EntityId;
  role?: string;
  source: "recruited" | "spawned";
}

/**
 * Resolve an explicit `with <a,b,...>` member list to live agents. Unknown
 * names are surfaced and skipped; resolved agents join as `recruited` with no
 * forced role (the crew assigns its default — preserves existing behavior).
 */
function resolveNamedMembers(
  ctx: RoomContext,
  eid: EntityId,
  deps: CodeDeps & { db: MarinaDB },
  members: string[],
): AssembledMember[] {
  const resolved: AssembledMember[] = [];
  const missing: string[] = [];
  for (const name of members) {
    const agent = deps.findAgentByName?.(name);
    if (agent) resolved.push({ agentName: agent.name, id: agent.id, source: "recruited" });
    else missing.push(name);
  }
  if (resolved.length === 0) {
    ctx.send(
      eid,
      `Could not resolve any named agents (${missing.join(", ")}). Stored the crew plan instead.`,
    );
    return [];
  }
  if (missing.length > 0) {
    ctx.send(eid, dim(`Skipping unknown agents: ${missing.join(", ")}`));
  }
  return resolved;
}

// The default autonomous coding crew. Implementer holds the write lock;
// reviewer + tester read/advise. Pulled from CODING_ROLES so the role detail
// (used as the spawned agent's attention) stays in one place.
const AUTONOMOUS_CREW_ROLES = ["implementer", "reviewer", "tester"] as const;

/**
 * Autonomously assemble a coding crew from a bare goal (no `with` clause).
 * Hybrid sourcing: recruit an existing idle/unassigned coding agent per role,
 * else spawn one through the `agent.spawn` safety gate (mirrors
 * runApprovedSpawnRequest — the gate IS the governance). Gate-blocked roles
 * with no recruit are skipped. Returns the members it could assemble (possibly
 * empty); never throws.
 */
async function assembleCodingCrew(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  session: CodingSessionRow,
  goal: string,
): Promise<AssembledMember[]> {
  const assembled: AssembledMember[] = [];
  // Names already in this assembly OR already live, so we never double-book an
  // agent across roles.
  const taken = new Set<string>();
  // Roles map by detail for spawned-agent attention.
  const roleDetail = new Map<string, string>(CODING_ROLES.map(([role, detail]) => [role, detail]));
  // Track whether the gate is supervised so we record a demonstration per spawn.
  let gateChecked = false;
  let gateOk = false;
  let gateSupervised = false;
  let gateReason: string | undefined;

  for (const role of AUTONOMOUS_CREW_ROLES) {
    // 1) Try to recruit an existing live coding agent not already taken.
    const recruit = recruitCodingAgent(deps, taken);
    if (recruit) {
      assembled.push({ agentName: recruit.name, id: recruit.id, role, source: "recruited" });
      taken.add(recruit.name.toLowerCase());
      continue;
    }

    // 2) Spawn through the agent.spawn gate. The gate result is stable for the
    //    entity across this assembly, so check it once.
    if (!deps.agentRuntime?.spawn) continue;
    if (deps.agentRuntime.isAvailable && !deps.agentRuntime.isAvailable()) continue;
    if (!gateChecked) {
      const gate = checkGate(deps.db, eid, "agent.spawn");
      gateChecked = true;
      gateOk = gate.ok;
      gateSupervised = gate.supervisedOnly === true;
      gateReason = gate.reason;
    }
    if (!gateOk) {
      ctx.send(eid, dim(`Skipping ${role}: ${gateReason ?? "not permitted to spawn agents."}`));
      continue;
    }

    const agentName = uniqueSpawnAgentName(
      [...(deps.agentRuntime.list?.() ?? []), ...assembled.map((m) => ({ name: m.agentName }))],
      role,
      session.id,
    );
    const modelTarget = modelTargetForAgentSpawn(getSessionModelTarget(deps.db, session.id));
    const detail = roleDetail.get(role) ?? role;
    try {
      const handle = await deps.agentRuntime.spawn({
        goal: `${detail}\n\nGoal: ${goal}\n\nCoding session: ${session.id}\nWorkspace: ${session.workspace_root}`,
        model: modelTarget,
        name: agentName,
        role,
        spawnedBy: entity.name,
      });
      bindSpawnedAgentEntity(handle, session, getCodeProfile(entity).name, deps);
      const attention = [
        `You were launched for Marina coding session ${session.id}.`,
        `Role: ${role} — ${detail}`,
        `Workspace: ${session.workspace_root}`,
        modelTarget ? `Model target: ${modelTarget}` : undefined,
        "",
        "Start with marina_code status, then inspect files/read/search/diff. Use patch for edits, verify for checks, and summary/handoff for durable progress.",
        "",
        `Goal: ${goal}`,
      ]
        .filter((line): line is string => typeof line === "string")
        .join("\n");
      await handle.sendAttention(attention);
      deps.db.createCodingArtifact({
        sessionId: session.id,
        kind: "spawn_assignment",
        title: `Spawned ${handle.name}: ${role}`,
        status: "complete",
        contentText: attention,
        metadata: { agent: handle.name, role, goal, source: "autonomous_crew", modelTarget },
        createdBy: entity.name,
      });
      deps.db.createCodingEvent({
        sessionId: session.id,
        actor: entity.name,
        kind: "coding_spawn_launched",
        payload: { agent: handle.name, role, modelTarget, source: "autonomous_crew" },
      });
      // Bind the freshly spawned entity id so it can join the crew channel.
      const spawnedId = handle.getStatus().entityId;
      assembled.push({
        agentName: handle.name,
        id: (spawnedId ?? handle.name) as EntityId,
        role,
        source: "spawned",
      });
      taken.add(handle.name.toLowerCase());
      // Supervised-only entities prove competence by completing a real spawn.
      if (gateSupervised) recordDemonstration(deps.db, eid, "agent.spawn");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.send(eid, dim(`Skipping ${role}: spawn failed (${message}).`));
    }
  }
  return assembled;
}

/**
 * Pick an existing live coding agent not already taken in this assembly. Best
 * effort: the runtime's agent list is the source of "online"; we skip any name
 * already taken. (Idle/assigned distinction is not surfaced by the runtime list
 * here, so we treat any untaken online agent as recruitable.)
 */
/**
 * Code Mode dispatch strategies. The registry is the extensibility seam — a new
 * strategy (multi-agent swarm, heterogeneous multi-backend, emergent grouping)
 * is a registry entry + a branch in doCode, nothing else. The *backend* for any
 * strategy is orthogonal: `code model <target>` sets the session's model, which
 * the single agent (and crew members) spawn against — so different sessions can
 * run on different models/providers today.
 */
const CODE_DRIVERS: Record<string, string> = {
  single: "one coding agent bound to the session (Codex/Claude/Cursor-style)",
  crew: "implementer + reviewer + tester working in parallel",
};

// Live streams from a bound coding agent → the human in Code Mode for that
// session. Keyed `${sessionId}:${dispatcherId}` so we subscribe at most once.
const codeStreams = new Map<string, () => void>();

/** Subscribe the dispatcher to a bound agent's activity and forward the
 *  high-signal events (tool actions, prose, errors) to their connection, so
 *  Code Mode shows the agent working instead of going quiet. */
function streamSessionAgent(
  deps: CodeDeps,
  dispatcherId: EntityId,
  handle: AgentHandle,
  sessionId: string,
): void {
  const notify = deps.notify;
  if (!notify) return;
  const key = `${sessionId}:${dispatcherId}`;
  if (codeStreams.has(key)) return; // already streaming this session to this watcher
  let buffer = "";
  let currentPhase = "received";
  const emitLifecycle = (phase: string, detail: string, extra: Record<string, unknown> = {}) => {
    if (phase === currentPhase && phase !== "failed") return;
    const previous = currentPhase;
    currentPhase = phase;
    const payload = { agent: handle.name, detail, phase, previous, ...extra };
    deps.db?.createCodingEvent({
      sessionId,
      actor: handle.name,
      kind: "code_lifecycle",
      payload,
    });
    notify(dispatcherId, detail, {
      code: {
        event: "code_lifecycle",
        metadata: payload,
        phase,
        sessionId,
        status: phase === "failed" ? "failed" : phase === "completed" ? "complete" : "active",
        title: `${handle.name}: ${phase.replace(/_/g, " ")}`,
        type: "lifecycle",
      },
    });
  };
  const flush = () => {
    const text = buffer.trim();
    buffer = "";
    if (text) notify(dispatcherId, `${handle.name}: ${text}`);
  };
  const unsub = handle.subscribe((ev: AgentEvent) => {
    switch (ev.type) {
      case "tool_call":
        {
          const lifecycle = lifecycleForToolCall(ev.toolName, ev.args);
          if (lifecycle) emitLifecycle(lifecycle.phase, lifecycle.detail, { tool: ev.toolName });
        }
        notify(dispatcherId, dim(`  ▸ ${formatAgentToolCall(ev.toolName, ev.args)}`));
        break;
      case "tool_result":
        if (ev.isError) {
          emitLifecycle("failed", `${handle.name} hit a tool error`, { tool: ev.toolName });
          notify(dispatcherId, `  ✗ ${ev.toolName}: ${clipLine(stringifyResult(ev.result))}`);
        }
        break;
      case "text_delta":
        buffer += ev.delta;
        break;
      case "turn_end":
        flush();
        break;
      case "error":
        notify(dispatcherId, `  ⚠ ${clipLine(ev.error)}`);
        break;
    }
  });
  codeStreams.set(key, unsub);
}

function lifecycleForToolCall(
  toolName: string,
  args: Record<string, unknown>,
): { detail: string; phase: string } | undefined {
  const typed = toolName.replace(/^marina_code_/, "");
  const action =
    toolName === "marina_code" && typeof args.action === "string" ? args.action : typed;
  if (/^(session_status|list_files|read_file|search|diff|status|files|read)$/.test(action)) {
    return { phase: "inspecting", detail: "Inspecting the workspace and current changes" };
  }
  if (action === "plan") return { phase: "planning", detail: "Recording an implementation plan" };
  if (/^(patch|apply_patch|reject_patch|apply|reject)$/.test(action)) {
    return {
      phase: action.includes("apply") ? "applying" : "patching",
      detail: action.includes("apply")
        ? "Applying the reviewed patch"
        : "Preparing a reviewable patch",
    };
  }
  if (action === "approval") {
    return { phase: "awaiting_approval", detail: "Waiting for a recorded approval decision" };
  }
  if (/^(verify|run)$/.test(action)) {
    return { phase: "verifying", detail: "Running workspace verification" };
  }
  if (action === "summary") {
    return { phase: "completed", detail: "Work completed with a durable summary" };
  }
  return undefined;
}

/** Tear down all live streams a dispatcher is watching (on exit / disconnect). */
function stopCodeStreamsFor(entityId: EntityId): void {
  const suffix = `:${entityId}`;
  for (const [key, unsub] of codeStreams) {
    if (!key.endsWith(suffix)) continue;
    try {
      unsub();
    } catch {
      /* best-effort */
    }
    codeStreams.delete(key);
  }
}

function formatAgentToolCall(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "marina_code") {
    const action = typeof args.action === "string" ? args.action : "";
    const detail = (args.path ?? args.query ?? args.command ?? "") as unknown;
    const detailStr = typeof detail === "string" && detail ? ` ${clipLine(detail, 60)}` : "";
    return `code ${action}${detailStr}`.trim();
  }
  return toolName;
}

function clipLine(value: unknown, max = 120): string {
  const flat = String(value).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/**
 * Code Mode's default agentic dispatch (Codex/Claude/Cursor-style): take a
 * natural-language task and drive autonomous work on the active session via the
 * session's *driver*. "single" (default) binds one coding agent to the session;
 * "crew" fans out to implementer/reviewer/tester. The driver is a seam — new
 * strategies (multi-agent, multi-backend) slot in here without touching callers.
 */
async function doCode(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  driver: CodeSessionDriver,
  rawTask: string,
): Promise<void> {
  const task = rawTask.trim();
  if (!task) {
    ctx.send(eid, 'Describe what you want done, e.g. "fix the off-by-one in the tokenizer".');
    return;
  }

  // Auto-start a session on the first task so entering Code Mode + typing just
  // works — no explicit `code start` required.
  if (!getActiveSessionId(entity)) startSession(ctx, eid, entity, deps, "");
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;

  const strategy = (session.driver ?? "single").toLowerCase();
  if (strategy === "crew") {
    await crewPlan(ctx, eid, entity, deps, task);
    return;
  }

  // Single-agent driver (default): ensure one bound coder, hand it the task.
  const agentName = await ensureSessionAgent(ctx, eid, entity, deps, session);
  if (!agentName) return; // ensureSessionAgent already explained why
  const profile = getCodeProfile(entity);
  try {
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "code_lifecycle",
      payload: { phase: "received", task },
    });
    sendCode(ctx, eid, "Task received and queued for the coding agent.", {
      event: "code_lifecycle",
      metadata: { phase: "received", task },
      phase: "received",
      sessionId: session.id,
      status: "active",
      title: "Task received",
      type: "lifecycle",
    });
    await driver.assignAgent({
      actor: entity.name,
      agentName,
      modelTarget: getSessionModelTarget(deps.db, session.id),
      profile: profile.name,
      prompt: task,
      session,
    });
    // Stream the bound agent's live work back to this human so Code Mode shows
    // it working (reads, edits, test runs, prose) rather than going quiet.
    const handle = deps.agentRuntime?.get?.(agentName);
    if (handle) streamSessionAgent(deps, eid, handle, session.id);
    ctx.send(
      eid,
      [
        success(`→ ${agentName} is on it.`),
        dim(`"${task.length > 80 ? `${task.slice(0, 77)}...` : task}"`),
        dim("It explores, edits, and runs checks autonomously — streaming below. Type to steer."),
      ].join("\n"),
    );
  } catch (err) {
    ctx.send(eid, fmtError(err instanceof Error ? err.message : String(err)));
  }
}

/**
 * Ensure the session has a live autonomous coding agent bound to it (the
 * single-agent default driver). Reuses the bound agent if still running, else
 * recruits an idle coding agent or spawns a fresh one. The bound agent is
 * granted code.exec for the session so it can actually run/apply — the operator
 * entering Code Mode is the responsible party (spawning itself is agent.spawn-
 * gated). Returns the agent name, or null after sending an explanation.
 */
async function ensureSessionAgent(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  session: CodingSessionRow,
): Promise<string | null> {
  // 1) Reuse the already-bound agent if it's still running.
  if (session.agent && deps.agentRuntime?.get?.(session.agent)) return session.agent;

  // 2) Recruit an idle coding agent already in the world.
  const recruited = recruitCodingAgent(deps, new Set());
  if (recruited) {
    grant(deps.db, recruited.id, "code.exec");
    deps.db.updateCodingSession(session.id, { agent: recruited.name, driver: "single" });
    return recruited.name;
  }

  // 3) Spawn a fresh coder (agent.spawn-gated).
  if (!deps.agentRuntime?.spawn) {
    ctx.send(eid, "No agent runtime available to drive this session.");
    return null;
  }
  if (deps.agentRuntime.isAvailable && !deps.agentRuntime.isAvailable()) {
    ctx.send(eid, "No LLM provider configured — set a provider key, then a coding agent can run.");
    return null;
  }
  const gate = checkGate(deps.db, eid, "agent.spawn");
  if (!gate.ok) {
    ctx.send(eid, gate.reason ?? "Not permitted to launch a coding agent (requires agent.spawn).");
    return null;
  }
  const name = uniqueSpawnAgentName(deps.agentRuntime.list?.() ?? [], "coder", session.id);
  const modelTarget = modelTargetForAgentSpawn(getSessionModelTarget(deps.db, session.id));
  try {
    const handle = await deps.agentRuntime.spawn({
      goal: [
        `You are the autonomous coder for Marina coding session ${session.id}.`,
        `Workspace: ${session.workspace_root}`,
        "Follow this operating contract for every task: inspect status and relevant files first; record a short plan; make the smallest reviewable patch; inspect the resulting diff; run the relevant verification chain; fix failures within the task scope; then record a summary citing changed paths and successful checks.",
        "Do not claim completion before verification succeeds. Do not modify unrelated files, install dependencies, launch applications, or expand scope without a user decision. Prefer one bounded tool action at a time so progress remains observable and steerable.",
      ].join("\n"),
      model: modelTarget,
      name,
      role: "coding-agent",
      spawnedBy: entity.name,
    });
    bindSpawnedAgentEntity(handle, session, getCodeProfile(entity).name, deps);
    const spawnedId = handle.getStatus().entityId;
    if (spawnedId) grant(deps.db, spawnedId as EntityId, "code.exec");
    if (gate.supervisedOnly) recordDemonstration(deps.db, eid, "agent.spawn");
    deps.db.updateCodingSession(session.id, { agent: handle.name, driver: "single" });
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "code_session_agent_launched",
      payload: { agent: handle.name, modelTarget },
    });
    return handle.name;
  } catch (err) {
    ctx.send(
      eid,
      fmtError(
        `Could not launch a coding agent: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    return null;
  }
}

/** `code driver [single|crew]` — view or set the session's dispatch strategy. */
function driverCommand(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const current = session.driver ?? "single";
  const want = args[0]?.toLowerCase();
  const names = Object.keys(CODE_DRIVERS);
  if (!want) {
    const lines = names.map(
      (n) => `  ${n === current ? bold(`${n} ✓`) : n} ${dim(`— ${CODE_DRIVERS[n]}`)}`,
    );
    ctx.send(
      eid,
      [
        `Driver: ${bold(current)}`,
        ...lines,
        dim("Set with: code driver <name>. Backend per session: code model <target>."),
      ].join("\n"),
    );
    return;
  }
  if (!names.includes(want)) {
    ctx.send(eid, `Unknown driver "${want}". Available: ${names.join(", ")}.`);
    return;
  }
  deps.db.updateCodingSession(session.id, { driver: want });
  ctx.send(eid, success(`Driver set to ${want}. ${dim(CODE_DRIVERS[want] ?? "")}`));
}

function recruitCodingAgent(
  deps: CodeDeps & { db: MarinaDB },
  taken: Set<string>,
): { name: string; id: EntityId } | undefined {
  const candidates = deps.listAgents?.() ?? [];
  for (const candidate of candidates) {
    const name = candidate.name;
    if (!name || taken.has(name.toLowerCase())) continue;
    const agent = deps.findAgentByName?.(name);
    if (!agent) continue;
    return { name: agent.name, id: agent.id };
  }
  return undefined;
}

/**
 * Create + dispatch a real ephemeral crew from already-resolved members.
 * Returns true on success (a `crew_dispatched` artifact was emitted), false to
 * fall back to the crew_plan-only path. Never throws — CrewError and
 * missing-manager cases degrade gracefully.
 *
 * On success the session write lock is set to `writer` (the implementer, else
 * the first member) so concurrent crew members can't race on workspace writes.
 */
async function dispatchCodingCrew(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  session: CodingSessionRow,
  goal: string,
  resolved: AssembledMember[],
  planArtifactId: string,
): Promise<boolean> {
  const crewManager = deps.crewManager;
  const channelManager = deps.channelManager;
  if (!crewManager || !channelManager) return false;
  if (resolved.length === 0) return false;

  // Map agentName -> source so we can annotate the dispatched-artifact members
  // with how each one joined (recruited vs spawned).
  const sourceByName = new Map(resolved.map((m) => [m.agentName, m.source] as const));
  // The implementer holds the write lock; fall back to the first member.
  const writer =
    resolved.find((m) => m.role === "implementer")?.agentName ?? resolved[0]?.agentName;

  const formation: CrewFormation = "swarm";
  const crewName = `code-${session.id}-${crypto.randomUUID().slice(0, 6)}`;
  try {
    const crew = crewManager.create({
      name: crewName,
      goal,
      formation,
      lifetime: "ephemeral",
      owner: entity.id,
      members: resolved.map((m) =>
        m.role ? { agentName: m.agentName, role: m.role } : { agentName: m.agentName },
      ),
    });
    crewManager.dispatch(crew.id, goal, { id: entity.id, name: entity.name });
    // The first dispatch lazily provisions the crew channel; mirror the crew
    // command's behavior and ensure all members + the owner are joined.
    if (crew.channelId) {
      for (const member of resolved) {
        if (!channelManager.isMember(crew.channelId, member.id)) {
          channelManager.addMember(crew.channelId, member.id);
        }
      }
      if (!channelManager.isMember(crew.channelId, eid)) {
        channelManager.addMember(crew.channelId, eid);
      }
    }

    const memberRoles = crew.members.map((m) => ({
      agentName: m.agentName,
      role: m.role,
      source: sourceByName.get(m.agentName) ?? "recruited",
    }));
    const dispatchedArtifact = deps.db.createCodingArtifact({
      sessionId: session.id,
      kind: "crew_dispatched",
      title: `Crew dispatched: ${crew.name}`,
      status: "active",
      contentText: [
        `Crew: ${crew.name} (${crew.formation})`,
        `Channel: ${crew.channelId ?? "(pending)"}`,
        `Members: ${memberRoles.map((m) => `${m.agentName} (${m.role})`).join(", ")}`,
        "",
        `Goal: ${goal}`,
      ].join("\n"),
      metadata: {
        crewId: crew.id,
        crewName: crew.name,
        channelId: crew.channelId,
        members: memberRoles,
        formation: crew.formation,
        goal,
        sourceArtifactId: planArtifactId,
      },
      createdBy: entity.name,
    });
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "coding_crew_dispatched",
      payload: {
        id: dispatchedArtifact.id,
        crewId: crew.id,
        crewName: crew.name,
        channelId: crew.channelId,
        goal,
      },
    });
    // Single-writer safety: the implementer (else first member) holds the
    // workspace write lock; other members read/advise via artifacts until a
    // handoff (`code handoff to <name>`) or owner reassignment (`code writer`).
    deps.db.updateCodingSession(session.id, { mode: "agent", writer: writer ?? null });
    if (writer) {
      deps.db.createCodingEvent({
        sessionId: session.id,
        actor: entity.name,
        kind: "writer_changed",
        payload: { writer, previousWriter: session.writer ?? null, reason: "crew_dispatch" },
      });
    }
    updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
    sendCode(
      ctx,
      eid,
      [
        success(`Coding crew dispatched: ${crew.name}`),
        `Crew: ${crew.id}`,
        `Channel: ${crew.channelId ?? "(pending)"}`,
        `Members: ${memberRoles.map((m) => `${m.agentName} (${m.role}, ${m.source})`).join(", ")}`,
        writer ? `Write lock: ${writer}` : dim("Write lock: open"),
        dim("The crew is working in its channel; track progress via code status."),
      ].join("\n"),
      {
        artifactId: dispatchedArtifact.id,
        artifactKind: dispatchedArtifact.kind,
        commands: [`code show ${dispatchedArtifact.id}`, "code status", "code history"],
        content: dispatchedArtifact.content_text,
        event: "coding_crew_dispatched",
        metadata: {
          crewId: crew.id,
          crewName: crew.name,
          channelId: crew.channelId,
          members: memberRoles,
          formation: crew.formation,
          goal,
          sourceArtifactId: planArtifactId,
        },
        rows: memberRoles.map((m) => ({
          id: m.agentName,
          detail: `${m.role} (${m.source})`,
          status: "active",
          title: m.agentName,
          type: "agent",
        })),
        sessionId: session.id,
        status: dispatchedArtifact.status,
        title: dispatchedArtifact.title,
        type: "artifact",
        workspace: session.workspace_root,
      },
    );
    return true;
  } catch (err) {
    const message =
      err instanceof CrewError ? err.message : err instanceof Error ? err.message : String(err);
    ctx.send(
      eid,
      `${fmtError(`Crew dispatch failed: ${message}`)}\n${dim(
        "Stored the crew plan instead. Re-run with distinct, online agent names.",
      )}`,
    );
    return false;
  }
}

/**
 * `code writer` — show the current write-lock holder (or "open").
 * `code writer <agent>` — reassign the lock. Allowed by the current holder OR
 * the session creator/owner. Emits a `writer_changed` event + artifact.
 */
function writerCommand(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const target = args[0]?.trim();
  if (!target) {
    const holder = session.writer ?? "open";
    sendCode(ctx, eid, `${header("Write Lock")}\n${separator()}\nHolder: ${holder}`, {
      commands: ["code writer <agent>", "code handoff <notes> to <agent>"],
      event: "code_writer_shown",
      sessionId: session.id,
      status: session.writer ? "locked" : "open",
      title: "Write Lock",
      type: "session",
      workspace: session.workspace_root,
    });
    return;
  }
  // Only the current holder or the session creator may reassign.
  const isOwner = session.created_by === entity.name;
  const isHolder = session.writer === entity.name;
  if (session.writer && !isHolder && !isOwner) {
    ctx.send(
      eid,
      `Only ${session.writer} (current holder) or ${session.created_by} (session creator) can reassign the write lock.`,
    );
    return;
  }
  reassignWriter(ctx, eid, entity, deps, session, target, "manual_reassign");
}

/**
 * Set the session writer to `newWriter`, emit a `writer_changed` event +
 * artifact, and announce. Shared by `code writer <agent>` and `code handoff
 * <notes> to <agent>`.
 */
function reassignWriter(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  session: CodingSessionRow,
  newWriter: string,
  reason: string,
): void {
  const previousWriter = session.writer ?? null;
  deps.db.updateCodingSession(session.id, { writer: newWriter });
  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: "writer_changed",
    title: `Write lock: ${newWriter}`,
    status: "active",
    contentText: `Write lock reassigned to ${newWriter}${
      previousWriter ? ` (was ${previousWriter})` : ""
    } by ${entity.name}.`,
    metadata: { writer: newWriter, previousWriter, reassignedBy: entity.name, reason },
    createdBy: entity.name,
  });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "writer_changed",
    payload: { id: artifact.id, writer: newWriter, previousWriter, reason },
  });
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  sendCode(ctx, eid, success(`Write lock now held by ${newWriter}.`), {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    commands: ["code writer", "code status"],
    event: "writer_changed",
    sessionId: session.id,
    status: artifact.status,
    title: artifact.title,
    type: "session",
    workspace: session.workspace_root,
  });
}

function sessionTask(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  rawTitle: string,
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const title = rawTitle.trim();
  if (!title) {
    ctx.send(eid, "Usage: code task <title>");
    return;
  }
  const taskId = deps.db.createTask({
    title,
    description: `from coding session ${session.id}`,
    creatorId: entity.id,
    creatorName: entity.name,
  });
  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: "session_task",
    title: `Linked task: ${title}`,
    status: "active",
    contentText: `Task #${taskId}: ${title}\n\nLinked from coding session ${session.id}.`,
    metadata: { taskId, title },
    createdBy: entity.name,
  });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "coding_task_linked",
    payload: { id: artifact.id, taskId, title },
  });
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  sendCode(ctx, eid, success(`Linked task #${taskId}: ${title}`), {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    commands: [`code show ${artifact.id}`, "code status", "code history"],
    content: artifact.content_text,
    event: "coding_task_linked",
    metadata: { taskId, title },
    rows: [{ id: String(taskId), detail: title, status: "open", title, type: "task" }],
    sessionId: session.id,
    status: artifact.status,
    title: artifact.title,
    type: "artifact",
    workspace: session.workspace_root,
  });
}

async function spawnRequest(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): Promise<void> {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const action = args[0]?.toLowerCase();
  if (!action || action === "list") {
    listSpawnRequests(ctx, eid, deps.db, session);
    return;
  }
  if (action === "run" || action === "approved" || action === "launch") {
    await runApprovedSpawnRequest(ctx, eid, entity, deps, session, args.slice(1));
    return;
  }

  const role = action;
  const goal = args.slice(1).join(" ").trim();
  if (!role || !goal) {
    ctx.send(eid, "Usage: code spawn <role> <goal> | code spawn run <spawn_request>");
    return;
  }
  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: "spawn_request",
    title: `Spawn request: ${role}`,
    status: "pending",
    contentText: `Role: ${role}\nGoal: ${goal}\n\nThis is a supervised spawn request. Approve it, then launch locally with code spawn run ${role}.`,
    metadata: { role, goal, requiredGate: "agent.spawn", launch: "code spawn run <id>" },
    createdBy: entity.name,
  });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "coding_spawn_requested",
    payload: { id: artifact.id, role, goal },
  });
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  sendCode(ctx, eid, success(`Coding spawn request stored: ${artifact.id}`), {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    commands: [
      `code show ${artifact.id}`,
      `code approve ${artifact.id}`,
      `code deny ${artifact.id}`,
      `code spawn run ${artifact.id}`,
    ],
    event: "coding_spawn_requested",
    sessionId: session.id,
    status: artifact.status,
    title: artifact.title,
    type: "artifact",
    workspace: session.workspace_root,
  });
}

function listSpawnRequests(
  ctx: RoomContext,
  eid: EntityId,
  db: MarinaDB,
  session: CodingSessionRow,
): void {
  const requests = db
    .listCodingArtifacts(session.id, 50)
    .filter((artifact) => artifact.kind === "spawn_request" && artifact.status !== "archived");
  if (requests.length === 0) {
    ctx.send(eid, "No coding spawn requests for this session.");
    return;
  }
  const lines = [header("Coding Spawn Requests"), separator()];
  for (const artifact of requests) {
    const meta = parseJsonObject(artifact.metadata_json);
    lines.push(
      `  ${artifact.id} ${dim(artifact.status)} ${meta.role ?? "agent"} ${dim(String(meta.goal ?? artifact.title))}`,
    );
  }
  sendCode(ctx, eid, lines.join("\n"), {
    commands: ["code spawn run <id>", "code approve <id>", "code deny <id>"],
    event: "coding_spawn_requests_listed",
    rows: requests.map((artifact) => {
      const meta = parseJsonObject(artifact.metadata_json);
      return {
        detail: typeof meta.goal === "string" ? meta.goal : artifact.content_text,
        id: artifact.id,
        status: artifact.status,
        title: typeof meta.role === "string" ? meta.role : artifact.title,
        type: "spawn_request",
      };
    }),
    sessionId: session.id,
    title: "Coding Spawn Requests",
    type: "list",
    workspace: session.workspace_root,
  });
}

async function runApprovedSpawnRequest(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  session: CodingSessionRow,
  args: string[],
): Promise<void> {
  if (!deps.agentRuntime?.spawn) {
    ctx.send(eid, "Agent spawning is not available in this Marina process.");
    return;
  }
  if (deps.agentRuntime.isAvailable && !deps.agentRuntime.isAvailable()) {
    ctx.send(eid, "No LLM runtime is available for local agent spawning.");
    return;
  }

  const parsed = parseSpawnRunArgs(args);
  const artifact = resolveKindArtifact(
    ctx,
    eid,
    deps.db,
    session.id,
    parsed.ref,
    "spawn_request",
    "last spawn request",
  );
  if (!artifact) return;
  if (artifact.status !== "approved") {
    ctx.send(eid, `Spawn request ${artifact.id} is ${artifact.status}, not approved.`);
    return;
  }

  // Spawning a coding agent is the same governed capability as `agent spawn`:
  // enforce the agent.spawn safety gate here rather than bypassing it from
  // inside Code Mode. The session-level approval artifact is a human review
  // step; the gate is the civic-substrate competence proof.
  const gate = checkGate(deps.db, eid, "agent.spawn");
  if (!gate.ok) {
    ctx.send(eid, gate.reason ?? "Not permitted to spawn agents.");
    return;
  }
  const pendingDemo = gate.supervisedOnly === true;

  const meta = parseJsonObject(artifact.metadata_json);
  const role = typeof meta.role === "string" ? meta.role : "implementer";
  const goal = typeof meta.goal === "string" ? meta.goal : artifact.content_text;
  const modelTarget =
    parsed.model ?? modelTargetForAgentSpawn(getSessionModelTarget(deps.db, session.id));
  const agentName =
    parsed.name ?? uniqueSpawnAgentName(deps.agentRuntime.list?.() ?? [], role, session.id);

  sendCode(ctx, eid, `Spawning ${agentName} for ${role}...`, {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    commands: ["code status"],
    event: "coding_spawn_started",
    modelTarget,
    sessionId: session.id,
    status: "running",
    title: `Spawn ${agentName}`,
    type: "session",
    workspace: session.workspace_root,
  });

  try {
    const handle = await deps.agentRuntime.spawn({
      goal: `${goal}\n\nCoding session: ${session.id}\nWorkspace: ${session.workspace_root}`,
      model: modelTarget,
      name: agentName,
      role,
      spawnedBy: entity.name,
    });
    bindSpawnedAgentEntity(handle, session, getCodeProfile(entity).name, deps);
    const attention = [
      `You were launched for Marina coding session ${session.id}.`,
      `Role: ${role}`,
      `Workspace: ${session.workspace_root}`,
      modelTarget ? `Model target: ${modelTarget}` : undefined,
      "",
      "Start with marina_code status, then inspect files/read/search/diff. Use patch for edits, verify for checks, and summary/handoff for durable progress.",
      "",
      `Goal: ${goal}`,
    ]
      .filter((line): line is string => typeof line === "string")
      .join("\n");
    await handle.sendAttention(attention);

    deps.db.updateCodingArtifact(artifact.id, {
      status: "launched",
      metadata: {
        ...meta,
        agent: handle.name,
        launchedAt: Date.now(),
        launchedBy: entity.name,
        modelTarget,
      },
    });
    const assignment = deps.db.createCodingArtifact({
      sessionId: session.id,
      kind: "spawn_assignment",
      title: `Spawned ${handle.name}: ${role}`,
      status: "complete",
      contentText: attention,
      metadata: { agent: handle.name, role, goal, sourceArtifactId: artifact.id, modelTarget },
      createdBy: entity.name,
    });
    deps.db.updateCodingSession(session.id, { mode: "agent" });
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "coding_spawn_launched",
      payload: {
        id: artifact.id,
        assignmentId: assignment.id,
        agent: handle.name,
        role,
        modelTarget,
      },
    });
    updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
    sendCode(ctx, eid, success(`Coding agent launched: ${handle.name}`), {
      artifactId: assignment.id,
      artifactKind: assignment.kind,
      commands: [`code show ${assignment.id}`, "code status", "code history"],
      content: attention,
      event: "coding_spawn_launched",
      modelTarget,
      rows: [{ id: handle.name, detail: goal, status: "launched", title: role, type: "agent" }],
      sessionId: session.id,
      status: assignment.status,
      title: assignment.title,
      type: "artifact",
      workspace: session.workspace_root,
    });

    // Supervised-only entities prove competence by completing a real spawn.
    // After demoThreshold demonstrations, agent.spawn flips to unsupervised.
    if (pendingDemo) {
      recordDemonstration(deps.db, eid, "agent.spawn");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "coding_spawn_failed",
      payload: { id: artifact.id, role, message },
    });
    sendCode(ctx, eid, fmtError(`Coding spawn failed: ${message}`), {
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      content: message,
      event: "coding_spawn_failed",
      modelTarget,
      sessionId: session.id,
      status: "failed",
      title: artifact.title,
      type: "artifact",
      workspace: session.workspace_root,
    });
  }
}

function modelSetting(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const action = args[0]?.toLowerCase() ?? "show";
  if (action === "set") {
    const target = args.slice(1).join(" ").trim();
    if (!target) {
      ctx.send(eid, "Usage: code model set <provider/model|agent|crew|direct>");
      return;
    }
    for (const previous of deps.db
      .listCodingArtifacts(session.id, 50)
      .filter((artifact) => artifact.kind === "model_setting" && artifact.status === "active")) {
      deps.db.updateCodingArtifact(previous.id, { status: "superseded" });
    }
    const artifact = deps.db.createCodingArtifact({
      sessionId: session.id,
      kind: "model_setting",
      title: `Code model: ${target}`,
      status: "active",
      contentText: `Code model target: ${target}`,
      metadata: { target, profile: getCodeProfile(entity).name },
      createdBy: entity.name,
    });
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "code_model_set",
      payload: { id: artifact.id, target },
    });
    updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
    sendCode(ctx, eid, success(`Code model target set: ${target}`), {
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      commands: ["code model", "code ask <request>"],
      event: "code_model_set",
      modelTarget: target,
      sessionId: session.id,
      status: artifact.status,
      title: artifact.title,
      type: "model",
      workspace: session.workspace_root,
    });
    return;
  }
  if (action === "clear") {
    for (const previous of deps.db
      .listCodingArtifacts(session.id, 50)
      .filter((artifact) => artifact.kind === "model_setting" && artifact.status === "active")) {
      deps.db.updateCodingArtifact(previous.id, { status: "superseded" });
    }
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "code_model_cleared",
      payload: {},
    });
    updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
    ctx.send(eid, success("Code model target cleared."));
    return;
  }
  const current = latestActiveArtifact(deps.db, session.id, "model_setting");
  const meta = current ? parseJsonObject(current.metadata_json) : {};
  const target = typeof meta.target === "string" ? meta.target : "default Marina code route";
  sendCode(ctx, eid, `${header("Code Model")}\n${separator()}\nTarget: ${target}`, {
    artifactId: current?.id,
    artifactKind: current?.kind,
    commands: ["code model set <target>", "code model clear"],
    event: "code_model_shown",
    modelTarget: target,
    sessionId: session.id,
    status: current?.status,
    title: "Code Model",
    type: "model",
    workspace: session.workspace_root,
  });
}

function status(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  id?: string,
): void {
  const session = resolveSession(ctx, eid, entity, deps.db, id);
  if (!session) return;
  const events = deps.db.listCodingEvents(session.id, 5);
  const artifacts = deps.db.listCodingArtifacts(session.id, 50);
  const latestArtifact = artifacts[0];
  const model = latestActiveArtifact(deps.db, session.id, "model_setting");
  const modelMeta = model ? parseJsonObject(model.metadata_json) : {};
  const modelTarget =
    typeof modelMeta.target === "string" ? modelMeta.target : "default Marina code route";
  const pendingPatches = artifacts.filter(
    (artifact) => artifact.kind === "patch" && artifact.status === "pending",
  );
  updateCodeContext(entity, deps.db, session);
  const lines = [
    header("Coding Session"),
    separator(),
    `ID: ${session.id}`,
    `Title: ${session.title}`,
    `Status: ${session.status}`,
    `Mode: ${session.mode}`,
    `Model target: ${modelTarget}`,
    `Workspace: ${session.workspace_root}`,
    `Latest artifact: ${latestArtifact ? `${latestArtifact.id} (${latestArtifact.kind}, ${latestArtifact.status})` : dim("none")}`,
    `Pending patches: ${pendingPatches.length}`,
    `Updated: ${new Date(session.updated_at).toLocaleString()}`,
  ];
  if (events.length > 0) {
    lines.push("", header("Recent Events"));
    for (const ev of events.slice(-5)) {
      lines.push(`  ${new Date(ev.created_at).toLocaleTimeString()} ${ev.kind} ${dim(ev.actor)}`);
    }
  }
  sendCode(ctx, eid, lines.join("\n"), {
    commands: ["code history", "code artifacts", "code patches"],
    event: "session_status",
    events: events.slice(-5).map((ev) => ({
      actor: ev.actor,
      kind: ev.kind,
      payload: ev.payload_json,
      timestamp: ev.created_at,
    })),
    modelTarget,
    rows: [
      { id: session.id, status: session.status, title: session.title, type: "session" },
      { detail: session.mode, title: "Mode", type: "field" },
      { detail: modelTarget, title: "Model target", type: "field" },
      { path: session.workspace_root, title: "Workspace", type: "field" },
      ...(latestArtifact
        ? [
            {
              id: latestArtifact.id,
              kind: latestArtifact.kind,
              status: latestArtifact.status,
              title: latestArtifact.title,
              type: "artifact",
            },
          ]
        : []),
      {
        detail: String(pendingPatches.length),
        status: pendingPatches.length > 0 ? "pending" : "clear",
        title: "Pending patches",
        type: "field",
      },
    ],
    sessionId: session.id,
    status: session.status,
    title: session.title,
    type: "session",
    workspace: session.workspace_root,
  });
}

async function doctor(
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

function files(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  path: string,
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const workspace = workspaceForSession(deps, session);
  const entries = workspace.list(path);
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "files_listed",
    payload: { path },
  });
  const lines = [header(`Files: ${path || "."}`), separator()];
  for (const entry of entries) {
    const icon = entry.type === "dir" ? "/" : " ";
    const size = entry.type === "file" ? dim(`${entry.size}b`) : "";
    lines.push(`  ${entry.path}${icon} ${size}`);
  }
  sendCode(ctx, eid, lines.join("\n"), {
    commands: ["code read <path>", "code search <query>", "code diff"],
    event: "files_listed",
    rows: entries.map((entry) => ({
      path: entry.path,
      size: entry.size,
      title: entry.path,
      type: entry.type,
    })),
    sessionId: session.id,
    title: `Files: ${path || "."}`,
    type: "list",
    workspace: session.workspace_root,
  });
}

async function readFile(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  path: string,
): Promise<void> {
  if (!path.trim()) {
    ctx.send(eid, "Usage: code read <path>");
    return;
  }
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const workspace = workspaceForSession(deps, session);
  const result = await workspace.read(path);
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "file_read",
    payload: { path: result.path, size: result.size, truncated: result.truncated },
  });
  const suffix = result.truncated ? dim("\n[truncated]") : "";
  sendCode(
    ctx,
    eid,
    `${header(result.path)} ${dim(`${result.size}b`)}\n${result.content}${suffix}`,
    {
      commands: [`code diff ${result.path}`, `code search ${result.path}`],
      content: result.content,
      event: "file_read",
      paths: [result.path],
      rows: [
        {
          path: result.path,
          size: result.size,
          status: result.truncated ? "truncated" : "complete",
          title: result.path,
          type: "file",
        },
      ],
      sessionId: session.id,
      title: result.path,
      truncated: result.truncated,
      type: "file",
      workspace: session.workspace_root,
    },
  );
}

async function search(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  query: string,
): Promise<void> {
  if (!query.trim()) {
    ctx.send(eid, "Usage: code search <query>");
    return;
  }
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const workspace = workspaceForSession(deps, session);
  const hits = await workspace.search(query);
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "workspace_searched",
    payload: { query, hits: hits.length },
  });
  if (hits.length === 0) {
    sendCode(ctx, eid, `No code search results for "${query}".`, {
      commands: ["code files", "code search <query>"],
      event: "workspace_searched",
      query,
      rows: [],
      sessionId: session.id,
      title: `Code Search: "${query}"`,
      type: "search",
      workspace: session.workspace_root,
    });
    return;
  }
  const lines = [header(`Code Search: "${query}"`), separator()];
  for (const hit of hits) {
    lines.push(`  ${hit.path}:${hit.line}: ${hit.text}`);
  }
  sendCode(ctx, eid, lines.join("\n"), {
    commands: ["code read <path>", "code diff <path>"],
    event: "workspace_searched",
    query,
    rows: hits.map((hit) => ({
      line: hit.line,
      path: hit.path,
      text: hit.text,
      title: `${hit.path}:${hit.line}`,
      type: "search_hit",
    })),
    sessionId: session.id,
    title: `Code Search: "${query}"`,
    type: "search",
    workspace: session.workspace_root,
  });
}

async function diff(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  path: string,
): Promise<void> {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const workspace = workspaceForSession(deps, session);
  const result = await workspace.diff(path || undefined);
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "diff_viewed",
    payload: { path: path || ".", exitCode: result.exitCode, truncated: result.truncated },
  });
  const body = result.content.trim() || dim("No git diff.");
  const suffix = result.truncated ? dim("\n[truncated]") : "";
  sendCode(ctx, eid, `${header(`Diff: ${path || "."}`)}\n${body}${suffix}`, {
    commands: ["code patch <title>", "code verify"],
    content: result.content,
    event: "diff_viewed",
    exitCode: result.exitCode,
    paths: [path || "."],
    sessionId: session.id,
    title: `Diff: ${path || "."}`,
    truncated: result.truncated,
    type: "diff",
    workspace: session.workspace_root,
  });
}

async function runWorkspaceCommand(
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

  const command = normalizeCodeRunArgs(args);
  const { artifact, result } = await executeWorkspaceCommand(entity, deps, session, command);
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);

  sendCode(ctx, eid, formatRunOutput(artifact.id, result), {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    command: result.command,
    commands: [`code show ${artifact.id}`, `code run ${result.command.join(" ")}`],
    content: result.output,
    durationMs: result.durationMs,
    event: "command_ran",
    exitCode: result.exitCode,
    sessionId: session.id,
    status: artifact.status,
    timedOut: result.timedOut,
    truncated: result.truncated,
    type: "command",
  });
}

async function showRunAllowlist(
  ctx: RoomContext,
  eid: EntityId,
  session: CodingSessionRow,
  workspace: WorkspaceRuntime,
): Promise<void> {
  const policy = workspace.runPolicy();
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
  const message = [
    fmtError("code run app is disabled in host local mode."),
    script ? `Requested script: ${script}` : "",
    "App launch will be enabled through the container/userland runner so package scripts do not execute directly on the Marina host.",
    dim(
      "For now: use code verify for checks, and code observe <note> for manual app observations.",
    ),
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
      containerRequired: true,
      profile: getCodeProfile(entity).name,
      reason: "host-local-mode",
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
      reason: "host-local-mode",
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

async function recipe(
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
  const packageJson = await workspace.read("package.json").catch(() => null);
  const scripts = packageJson ? detectPackageScripts(packageJson.content) : [];
  const detected = recommendedVerify(scripts);
  const stored = deps.db
    .listCodingArtifacts(session.id, 50)
    .filter((artifact) => artifact.kind === "run_recipe" && artifact.status === "active");
  const lines = [header("Code Recipes"), separator()];
  lines.push(
    `Detected verify: ${detected.length > 0 ? detected.join(" then ") : "git diff --check"}`,
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

async function verifyWorkspace(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
): Promise<void> {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;

  const workspace = workspaceForSession(deps, session);
  const commands = (await resolveRecipeCommands(deps.db, session, workspace, "default")) ??
    (await resolveRecipeCommands(deps.db, session, workspace, "detected")) ?? ["git diff --check"];

  await runVerificationCommands(ctx, eid, entity, deps, session, commands, "Verification");
}

async function runVerificationCommands(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  session: CodingSessionRow,
  commands: string[],
  titlePrefix: string,
): Promise<void> {
  const results: StoredCommandResult[] = [];
  for (const commandText of commands) {
    const command = normalizeCodeRunArgs(commandText.split(/\s+/).filter(Boolean));
    const stored = await executeWorkspaceCommand(entity, deps, session, command);
    results.push(stored);
    if (stored.result.exitCode !== 0 || stored.result.timedOut) break;
  }

  const failed = results.find((item) => item.result.exitCode !== 0 || item.result.timedOut);
  const status = failed ? "failed" : "complete";
  const summary = formatVerificationSummary(results);
  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: "verification",
    title: failed ? `${titlePrefix} failed` : `${titlePrefix} passed`,
    status,
    contentText: summary,
    metadata: {
      commands: results.map((item) => item.result.command),
      artifactIds: results.map((item) => item.artifact.id),
      exitCode: failed?.result.exitCode ?? 0,
      stoppedAt: failed?.result.command,
    },
    createdBy: entity.name,
  });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "verification_ran",
    payload: {
      id: artifact.id,
      status,
      commands: results.map((item) => item.result.command),
      artifactIds: results.map((item) => item.artifact.id),
    },
  });
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);

  sendCode(ctx, eid, `${summary}\n${dim(`verification artifact: ${artifact.id}`)}`, {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    commands: ["code show last", "code verify"],
    content: summary,
    event: "verification_ran",
    exitCode: failed?.result.exitCode ?? 0,
    sessionId: session.id,
    status,
    type: "verification",
  });
}

interface StoredCommandResult {
  artifact: CodingArtifactRow;
  result: WorkspaceRunResult;
}

async function executeWorkspaceCommand(
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  session: CodingSessionRow,
  command: string[],
): Promise<StoredCommandResult> {
  const workspace = workspaceForSession(deps, session);
  const result = await workspace.run(command);
  const commandText = result.command.join(" ");
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
    },
  });
  return { artifact, result };
}

async function proposePatch(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  raw: string,
): Promise<void> {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const parsed = parsePatchProposal(raw);
  if (!parsed.ok) {
    ctx.send(eid, parsed.error);
    return;
  }
  const workspace = workspaceForSession(deps, session);
  const check = await workspace.checkPatch(parsed.patch);
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: check.ok ? "patch_checked" : "patch_check_failed",
    payload: { title: parsed.title, paths: check.paths, output: check.output },
  });
  if (!check.ok) {
    ctx.send(
      eid,
      [fmtError("Patch did not apply cleanly."), check.output || dim("git apply --check failed.")]
        .filter(Boolean)
        .join("\n"),
    );
    return;
  }

  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: "patch",
    title: parsed.title,
    contentText: parsed.patch,
    metadata: { paths: check.paths },
    createdBy: entity.name,
  });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "patch_proposed",
    payload: { id: artifact.id, title: artifact.title, paths: check.paths },
  });
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);

  sendCode(
    ctx,
    eid,
    [
      success(`Patch proposed: ${artifact.id}`),
      `Title: ${artifact.title}`,
      `Paths: ${check.paths.join(", ")}`,
      dim(`Review: code show ${artifact.id}`),
      dim(`Apply:  code apply ${artifact.id}`),
    ].join("\n"),
    {
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      commands: [
        `code show ${artifact.id}`,
        `code apply ${artifact.id}`,
        `code reject ${artifact.id}`,
      ],
      content: artifact.content_text,
      event: "patch_proposed",
      paths: check.paths,
      sessionId: session.id,
      status: artifact.status,
      title: artifact.title,
      type: "patch",
    },
  );
}

function patches(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[] = [],
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const statusFilter = args[0]?.toLowerCase();
  if (statusFilter && !["applied", "pending", "rejected"].includes(statusFilter)) {
    ctx.send(eid, "Usage: code patches [pending|applied|rejected]");
    return;
  }
  const artifacts = deps.db
    .listCodingArtifacts(session.id, 20)
    .filter(
      (artifact) =>
        artifact.kind === "patch" && (!statusFilter || artifact.status === statusFilter),
    );
  if (artifacts.length === 0) {
    ctx.send(
      eid,
      statusFilter
        ? `No ${statusFilter} patch proposals for this coding session.`
        : "No patch proposals for this coding session.",
    );
    return;
  }
  const lines = [
    header(statusFilter ? `Patches: ${statusFilter} (${session.id})` : `Patches: ${session.id}`),
    separator(),
  ];
  for (const artifact of artifacts) {
    const meta = parseArtifactMetadata(artifact);
    lines.push(
      `  ${artifact.id} ${dim(artifact.status)} ${artifact.title} ${dim(formatPaths(meta.paths))}`,
    );
  }
  sendCode(ctx, eid, lines.join("\n"), {
    commands: ["code show last patch", "code apply last patch", "code reject last patch"],
    event: "patches_listed",
    rows: artifacts.map((artifact) => {
      const meta = parseArtifactMetadata(artifact);
      return {
        detail: formatPaths(meta.paths),
        id: artifact.id,
        kind: artifact.kind,
        path: meta.paths[0],
        status: artifact.status,
        title: artifact.title,
        type: "patch",
      };
    }),
    sessionId: session.id,
    status: statusFilter,
    title: statusFilter ? `Patches: ${statusFilter}` : "Patches",
    type: "list",
    workspace: session.workspace_root,
  });
}

function artifacts(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[] = [],
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const filter = parseArtifactListFilter(args);
  if (!filter.ok) {
    ctx.send(eid, filter.error);
    return;
  }
  const limit = filter.mode === "recent" ? 10 : 30;
  const artifacts = deps.db
    .listCodingArtifacts(session.id, 50)
    .filter((artifact) => artifactMatchesListFilter(artifact, filter))
    .slice(0, limit);
  if (artifacts.length === 0) {
    ctx.send(eid, formatNoArtifactsMessage(filter));
    return;
  }
  const lines = [header(`${formatArtifactListTitle(filter)} (${session.id})`), separator()];
  for (const artifact of artifacts) {
    const meta = parseArtifactMetadata(artifact);
    lines.push(
      `  ${artifact.id} ${dim(artifact.kind)} ${dim(artifact.status)} ${artifact.title} ${dim(formatArtifactMeta(meta))}`,
    );
  }
  sendCode(ctx, eid, lines.join("\n"), {
    commands: ["code show last", "code show last failed", "code artifacts failed", "code pin last"],
    event: "artifacts_listed",
    rows: artifacts.map((artifact) => {
      const meta = parseArtifactMetadata(artifact);
      return {
        detail: formatArtifactMeta(meta),
        id: artifact.id,
        kind: artifact.kind,
        status: artifact.status,
        title: artifact.title,
        type: "artifact",
      };
    }),
    sessionId: session.id,
    title: formatArtifactListTitle(filter),
    type: "list",
    workspace: session.workspace_root,
  });
}

function showArtifact(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  id: string | undefined,
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const artifact = resolveSessionArtifact(ctx, eid, deps.db, session.id, id);
  if (!artifact) return;
  const meta = parseArtifactMetadata(artifact);
  sendCode(
    ctx,
    eid,
    [
      header(`${artifact.title} (${artifact.id})`),
      `Kind: ${artifact.kind}`,
      `Status: ${artifact.status}`,
      formatArtifactMetaLine(meta),
      separator(),
      artifact.content_text,
    ].join("\n"),
    {
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      command: meta.command.length > 0 ? meta.command : undefined,
      commands:
        artifact.kind === "patch" && artifact.status === "pending"
          ? [`code apply ${artifact.id}`, `code reject ${artifact.id}`]
          : [`code show ${artifact.id}`],
      content: artifact.content_text,
      durationMs: meta.durationMs,
      event: "artifact_shown",
      exitCode: meta.exitCode,
      paths: meta.paths,
      sessionId: session.id,
      status: artifact.status,
      timedOut: meta.timedOut,
      title: artifact.title,
      truncated: meta.truncated,
      type: artifact.kind === "patch" ? "patch" : "artifact",
    },
  );
}

function lifecycleArtifact(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  ref: string | undefined,
  lifecycleStatus: "active" | "archived" | "pinned" | "superseded",
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const artifact = resolveSessionArtifact(ctx, eid, deps.db, session.id, ref);
  if (!artifact) return;
  if (artifact.kind === "patch" && artifact.status === "pending") {
    ctx.send(eid, "Pending patches must be applied or rejected before lifecycle status changes.");
    return;
  }
  const metadata = parseJsonObject(artifact.metadata_json);
  const previousLifecycle = typeof metadata.lifecycle === "string" ? metadata.lifecycle : undefined;
  if (
    previousLifecycle === "pinned" &&
    (lifecycleStatus === "archived" || lifecycleStatus === "superseded")
  ) {
    ctx.send(eid, `Artifact ${artifact.id} is pinned; unpin it before ${lifecycleStatus}.`);
    return;
  }
  const nextLifecycle = lifecycleStatus === "active" ? undefined : lifecycleStatus;
  deps.db.updateCodingArtifact(artifact.id, {
    metadata: {
      ...metadata,
      lifecycle: nextLifecycle,
      lifecycleAt: Date.now(),
      lifecycleBy: entity.name,
      previousLifecycle,
    },
  });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: `artifact_${lifecycleStatus}`,
    payload: {
      id: artifact.id,
      lifecycle: nextLifecycle ?? "active",
      previousLifecycle,
      status: artifact.status,
    },
  });
  const updated = deps.db.getCodingArtifact(artifact.id) ?? artifact;
  const updatedMeta = parseArtifactMetadata(updated);
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  const message =
    lifecycleStatus === "active"
      ? success(`Artifact unpinned: ${artifact.id}`)
      : success(`Artifact ${lifecycleStatus}: ${artifact.id}`);
  sendCode(ctx, eid, message, {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    commands: [`code show ${artifact.id}`, "code artifacts"],
    content: updated.content_text,
    event: lifecycleStatus === "active" ? "artifact_unpinned" : `artifact_${lifecycleStatus}`,
    sessionId: session.id,
    status: updated.status,
    title: updated.title,
    type: artifact.kind === "patch" ? "patch" : "artifact",
    workspace: session.workspace_root,
    rows: [
      {
        detail: updatedMeta.lifecycle ?? "active",
        id: artifact.id,
        kind: artifact.kind,
        status: updated.status,
        title: updated.title,
        type: "artifact",
      },
    ],
  });
}

async function applyPatch(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  ref: string | undefined,
): Promise<void> {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  // Write-lock gate: when a crew writer is set, only the holder may apply.
  // Null writer = no restriction (preserves solo-session behavior).
  if (!enforceWriteLock(ctx, eid, entity, session)) return;
  // Solo-workspace guard (only enforced when there is no crew writer): the
  // session creator owns local writes. A set writer supersedes this.
  if (!session.writer && session.created_by !== entity.name) {
    ctx.send(eid, "Only the session creator can apply patches in this local workspace mode.");
    return;
  }
  const artifact = resolvePatchArtifact(ctx, eid, deps.db, session.id, ref);
  if (!artifact) return;
  if (artifact.status !== "pending") {
    ctx.send(eid, `Patch ${artifact.id} is ${artifact.status}, not pending.`);
    return;
  }

  const workspace = workspaceForSession(deps, session);
  const result = await workspace.applyPatch(artifact.content_text);
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: result.ok ? "patch_applied" : "patch_apply_failed",
    payload: { id: artifact.id, paths: result.paths, output: result.output },
  });
  if (!result.ok) {
    ctx.send(
      eid,
      [fmtError(`Patch ${artifact.id} did not apply.`), result.output || dim("git apply failed.")]
        .filter(Boolean)
        .join("\n"),
    );
    return;
  }
  deps.db.updateCodingArtifact(artifact.id, {
    status: "applied",
    appliedBy: entity.name,
    appliedAt: Date.now(),
  });
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  const diffResult = await workspace.diff();
  const diffBody = diffResult.content.trim() || dim("Patch applied; no git diff remains.");
  sendCode(
    ctx,
    eid,
    [
      success(`Patch applied: ${artifact.id}`),
      `Paths: ${result.paths.join(", ")}`,
      separator(),
      diffBody,
    ].join("\n"),
    {
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      commands: ["code diff", `code show ${artifact.id}`],
      content: diffResult.content,
      event: "patch_applied",
      paths: result.paths,
      sessionId: session.id,
      status: "applied",
      title: artifact.title,
      type: "patch",
    },
  );
}

function rejectPatch(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const parsed = parsePatchActionArgs(args);
  const artifact = resolvePatchArtifact(ctx, eid, deps.db, session.id, parsed.ref);
  if (!artifact) return;
  if (artifact.status !== "pending") {
    ctx.send(eid, `Patch ${artifact.id} is ${artifact.status}, not pending.`);
    return;
  }
  deps.db.updateCodingArtifact(artifact.id, { status: "rejected" });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "patch_rejected",
    payload: { id: artifact.id, reason: parsed.reason || undefined },
  });
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  sendCode(ctx, eid, success(`Patch rejected: ${artifact.id}`), {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    commands: [`code show ${artifact.id}`],
    event: "patch_rejected",
    paths: parseArtifactMetadata(artifact).paths,
    sessionId: session.id,
    status: "rejected",
    title: artifact.title,
    type: "patch",
  });
}

async function checkpoint(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  titleArg: string,
): Promise<void> {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const workspace = workspaceForSession(deps, session);
  const result = await workspace.diff();
  const title = titleArg.trim() || "Workspace checkpoint";
  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: "checkpoint",
    title,
    status: "complete",
    contentText: result.content,
    metadata: { empty: result.content.trim().length === 0, exitCode: result.exitCode },
    createdBy: entity.name,
  });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "checkpoint_created",
    payload: { id: artifact.id, title, empty: result.content.trim().length === 0 },
  });
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  sendCode(ctx, eid, success(`Checkpoint stored: ${artifact.id}`), {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    commands: [`code show ${artifact.id}`, `code revert ${artifact.id}`],
    content: artifact.content_text,
    event: "checkpoint_created",
    exitCode: result.exitCode,
    sessionId: session.id,
    status: artifact.status,
    title: artifact.title,
    type: "diff",
    workspace: session.workspace_root,
  });
}

async function revertCheckpoint(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  ref: string | undefined,
): Promise<void> {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  // Reverting a checkpoint writes the workspace — same single-writer gate.
  if (!enforceWriteLock(ctx, eid, entity, session)) return;
  if (!session.writer && session.created_by !== entity.name) {
    ctx.send(eid, "Only the session creator can revert checkpoints in this local workspace mode.");
    return;
  }
  const artifact = resolveKindArtifact(
    ctx,
    eid,
    deps.db,
    session.id,
    ref,
    "checkpoint",
    "last checkpoint",
  );
  if (!artifact) return;
  if (!artifact.content_text.trim()) {
    ctx.send(eid, `Checkpoint ${artifact.id} has no diff to reverse.`);
    return;
  }
  const workspace = workspaceForSession(deps, session);
  const result = await workspace.reversePatch(artifact.content_text);
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: result.ok ? "checkpoint_reverted" : "checkpoint_revert_failed",
    payload: { id: artifact.id, paths: result.paths, output: result.output },
  });
  if (!result.ok) {
    ctx.send(
      eid,
      [fmtError(`Checkpoint ${artifact.id} did not reverse cleanly.`), result.output].join("\n"),
    );
    return;
  }
  deps.db.updateCodingArtifact(artifact.id, {
    metadata: {
      ...parseJsonObject(artifact.metadata_json),
      revertedAt: Date.now(),
      revertedBy: entity.name,
    },
  });
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  sendCode(ctx, eid, success(`Checkpoint reverted: ${artifact.id}`), {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    commands: ["code diff", `code show ${artifact.id}`],
    event: "checkpoint_reverted",
    paths: result.paths,
    sessionId: session.id,
    status: artifact.status,
    title: artifact.title,
    type: "patch",
    workspace: session.workspace_root,
  });
}

function approvals(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const items = deps.db
    .listCodingArtifacts(session.id, 50)
    .filter((artifact) => artifact.kind === "approval");
  if (items.length === 0) {
    ctx.send(eid, "No coding approvals for this session.");
    return;
  }
  const lines = [header("Coding Approvals"), separator()];
  for (const artifact of items) {
    const meta = parseJsonObject(artifact.metadata_json);
    lines.push(
      `  ${artifact.id} ${dim(artifact.status)} ${meta.kind ?? "approval"} ${artifact.title}`,
    );
  }
  sendCode(ctx, eid, lines.join("\n"), {
    commands: ["code approval request shell <description>", "code approve <id>", "code deny <id>"],
    event: "coding_approvals_listed",
    rows: items.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      status: artifact.status,
      title: artifact.title,
      type: "approval",
    })),
    sessionId: session.id,
    title: "Coding Approvals",
    type: "list",
    workspace: session.workspace_root,
  });
}

function approval(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const action = args[0]?.toLowerCase();
  if (action === "request") {
    const kind = args[1]?.toLowerCase();
    const description = args.slice(2).join(" ").trim();
    if (!kind || !description) {
      ctx.send(
        eid,
        "Usage: code approval request <shell|network|secret|commit|spawn|other> <description>",
      );
      return;
    }
    const artifact = deps.db.createCodingArtifact({
      sessionId: session.id,
      kind: "approval",
      title: `Approval: ${kind}`,
      status: "pending",
      contentText: description,
      metadata: { kind, requestedBy: entity.name },
      createdBy: entity.name,
    });
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "coding_approval_requested",
      payload: { id: artifact.id, kind, description },
    });
    updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
    sendCode(ctx, eid, success(`Approval requested: ${artifact.id}`), {
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      commands: [`code approve ${artifact.id}`, `code deny ${artifact.id}`],
      content: description,
      event: "coding_approval_requested",
      metadata: { kind, requestedBy: entity.name },
      sessionId: session.id,
      status: artifact.status,
      title: artifact.title,
      type: "artifact",
      workspace: session.workspace_root,
    });
    return;
  }
  if (action === "list" || !action) {
    approvals(ctx, eid, entity, deps);
    return;
  }
  ctx.send(eid, "Usage: code approval [list|request]");
}

function decideApproval(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  ref: string | undefined,
  status: "approved" | "denied",
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const artifact = resolveDecisionArtifact(ctx, eid, deps.db, session.id, ref);
  if (!artifact) return;
  if (artifact.status !== "pending") {
    ctx.send(eid, `${artifact.kind} ${artifact.id} is ${artifact.status}, not pending.`);
    return;
  }
  const decidedAt = Date.now();
  const decidedBy = entity.name;
  const priorMetadata = parseJsonObject(artifact.metadata_json);
  deps.db.updateCodingArtifact(artifact.id, {
    status,
    metadata: {
      ...priorMetadata,
      decidedAt,
      decidedBy,
    },
  });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: `coding_approval_${status}`,
    payload: { id: artifact.id },
  });
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  sendCode(ctx, eid, success(`Approval ${status}: ${artifact.id}`), {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    commands:
      artifact.kind === "spawn_request" && status === "approved"
        ? [`code spawn run ${artifact.id}`, `code show ${artifact.id}`]
        : [`code show ${artifact.id}`, "code approvals"],
    event: `coding_approval_${status}`,
    metadata: {
      ...priorMetadata,
      decidedAt,
      decidedBy,
      requestedBy: priorMetadata.requestedBy ?? artifact.created_by,
    },
    sessionId: session.id,
    status,
    title: artifact.title,
    type: "artifact",
    workspace: session.workspace_root,
  });
}

function history(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  id?: string,
): void {
  const session = resolveSession(ctx, eid, entity, deps.db, id);
  if (!session) return;
  const events = deps.db.listCodingEvents(session.id, 40);
  const lines = [header(`Coding History: ${session.id}`), separator()];
  for (const ev of events) {
    lines.push(
      `  ${new Date(ev.created_at).toLocaleString()} ${ev.kind} ${dim(ev.actor)} ${dim(ev.payload_json)}`,
    );
  }
  sendCode(ctx, eid, lines.join("\n"), {
    commands: ["code status", "code artifacts", "code patches"],
    event: "history_shown",
    events: events.map((ev) => ({
      actor: ev.actor,
      kind: ev.kind,
      payload: ev.payload_json,
      timestamp: ev.created_at,
    })),
    sessionId: session.id,
    title: `Coding History: ${session.id}`,
    type: "history",
    workspace: session.workspace_root,
  });
}

function steer(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const text = normalizeSteeringArgs(args);
  if (!text) {
    ctx.send(eid, "Usage: code steer <direction>");
    return;
  }
  const profile = getCodeProfile(entity);
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "session_steered",
    payload: { text, profile: profile.name },
  });
  sendCode(ctx, eid, success(`Steering recorded: ${text}`), {
    commands: ["code status", "code history"],
    content: text,
    event: "session_steered",
    sessionId: session.id,
    title: "Steering",
    type: "note",
    workspace: session.workspace_root,
  });
}

function observe(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const text = args.join(" ").trim();
  if (!text) {
    ctx.send(eid, "Usage: code observe <what you observed>");
    return;
  }
  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: "observation",
    title: formatCodingNoteTitle("observation", text),
    status: "complete",
    contentText: text,
    metadata: { profile: getCodeProfile(entity).name },
    createdBy: entity.name,
  });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "observation_recorded",
    payload: { id: artifact.id, text },
  });
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  sendCode(ctx, eid, success(`Observation stored: ${artifact.id}`), {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    commands: [`code show ${artifact.id}`, "code status"],
    content: text,
    event: "observation_recorded",
    sessionId: session.id,
    status: artifact.status,
    title: artifact.title,
    type: "note",
    workspace: session.workspace_root,
  });
}

function skill(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const action = args[0]?.toLowerCase() ?? "list";
  if (action === "add" || action === "store") {
    const name = args[1]?.toLowerCase();
    const text = args.slice(2).join(" ").trim();
    if (!name || !text) {
      ctx.send(eid, "Usage: code skill add <name> <instructions>");
      return;
    }
    const artifact = deps.db.createCodingArtifact({
      sessionId: session.id,
      kind: "code_skill",
      title: `Code skill: ${name}`,
      status: "active",
      contentText: text,
      metadata: { name, profile: getCodeProfile(entity).name },
      createdBy: entity.name,
    });
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "code_skill_added",
      payload: { id: artifact.id, name },
    });
    updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
    sendCode(ctx, eid, success(`Code skill stored: ${name} (${artifact.id})`), {
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      commands: [`code skill use ${name}`, `code show ${artifact.id}`],
      content: text,
      event: "code_skill_added",
      sessionId: session.id,
      status: artifact.status,
      title: artifact.title,
      type: "artifact",
      workspace: session.workspace_root,
    });
    return;
  }
  if (action === "use") {
    const name = args[1]?.toLowerCase();
    if (!name) {
      ctx.send(eid, "Usage: code skill use <name>");
      return;
    }
    const artifact = findNamedArtifact(deps.db, session.id, "code_skill", name);
    if (!artifact) {
      ctx.send(eid, `Code skill not found: ${name}`);
      return;
    }
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "code_skill_used",
      payload: { id: artifact.id, name },
    });
    sendCode(
      ctx,
      eid,
      `${success(`Code skill active for next work: ${name}`)}\n${artifact.content_text}`,
      {
        artifactId: artifact.id,
        artifactKind: artifact.kind,
        commands: [`code show ${artifact.id}`, "code plan <next step>"],
        content: artifact.content_text,
        event: "code_skill_used",
        sessionId: session.id,
        status: artifact.status,
        title: artifact.title,
        type: "skill",
        workspace: session.workspace_root,
      },
    );
    return;
  }
  if (action !== "list") {
    ctx.send(eid, "Usage: code skill [list|add|use]");
    return;
  }
  const skills = deps.db
    .listCodingArtifacts(session.id, 50)
    .filter((artifact) => artifact.kind === "code_skill" && artifact.status === "active");
  if (skills.length === 0) {
    ctx.send(eid, "No code-modal skills for this session.");
    return;
  }
  const lines = [header("Code Skills"), separator()];
  for (const artifact of skills) {
    const meta = parseJsonObject(artifact.metadata_json);
    lines.push(`  ${meta.name ?? artifact.id} ${dim(artifact.id)} ${artifact.title}`);
  }
  sendCode(ctx, eid, lines.join("\n"), {
    commands: ["code skill add <name> <instructions>", "code skill use <name>"],
    event: "code_skills_listed",
    rows: skills.map((artifact) => {
      const meta = parseJsonObject(artifact.metadata_json);
      return {
        id: artifact.id,
        title: typeof meta.name === "string" ? meta.name : artifact.title,
        detail: artifact.content_text,
        status: artifact.status,
        type: "skill",
      };
    }),
    sessionId: session.id,
    title: "Code Skills",
    type: "list",
    workspace: session.workspace_root,
  });
}

function thread(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const artifacts = deps.db.listCodingArtifacts(session.id, 80);
  const important = artifacts.filter((artifact) =>
    [
      "plan",
      "decision",
      "summary",
      "handoff",
      "checkpoint",
      "verification",
      "patch",
      "approval",
      "crew_plan",
      "model_setting",
      "external_link",
    ].includes(artifact.kind),
  );
  if (important.length === 0) {
    ctx.send(eid, "No thread artifacts for this coding session yet.");
    return;
  }
  const lines = [header(`Code Thread: ${session.id}`), separator()];
  for (const artifact of important.slice(0, 20)) {
    lines.push(`  ${artifact.id} ${dim(artifact.kind)} ${dim(artifact.status)} ${artifact.title}`);
  }
  sendCode(ctx, eid, lines.join("\n"), {
    commands: ["code show <artifact_id>", "code artifacts", "code status"],
    event: "code_thread_shown",
    rows: important.slice(0, 20).map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      status: artifact.status,
      title: artifact.title,
      type: "artifact",
    })),
    sessionId: session.id,
    title: `Code Thread: ${session.id}`,
    type: "history",
    workspace: session.workspace_root,
  });
}

function externalLink(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const action = args[0]?.toLowerCase() ?? "show";
  if (action === "link") {
    const system = args[1]?.toLowerCase();
    const externalId = args.slice(2).join(" ").trim();
    if (!system || !externalId) {
      ctx.send(eid, "Usage: code external link <acp|mcp|cursor|zed|vscode|other> <external_id>");
      return;
    }
    const artifact = deps.db.createCodingArtifact({
      sessionId: session.id,
      kind: "external_link",
      title: `External link: ${system}`,
      status: "active",
      contentText: `${system}: ${externalId}`,
      metadata: { system, externalId },
      createdBy: entity.name,
    });
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "external_session_linked",
      payload: { id: artifact.id, system, externalId },
    });
    updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
    sendCode(ctx, eid, success(`External coding link stored: ${system} ${externalId}`), {
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      commands: ["code external", `code show ${artifact.id}`],
      event: "external_session_linked",
      sessionId: session.id,
      status: artifact.status,
      title: artifact.title,
      type: "artifact",
      workspace: session.workspace_root,
    });
    return;
  }
  if (action === "unlink") {
    const ref = args.slice(1).join(" ");
    const artifact = resolveKindArtifact(
      ctx,
      eid,
      deps.db,
      session.id,
      ref,
      "external_link",
      "last external",
    );
    if (!artifact) return;
    deps.db.updateCodingArtifact(artifact.id, { status: "archived" });
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: "external_session_unlinked",
      payload: { id: artifact.id },
    });
    updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
    ctx.send(eid, success(`External coding link archived: ${artifact.id}`));
    return;
  }
  if (action !== "show" && action !== "list") {
    ctx.send(eid, "Usage: code external [show|link|unlink]");
    return;
  }
  const links = deps.db
    .listCodingArtifacts(session.id, 50)
    .filter((artifact) => artifact.kind === "external_link" && artifact.status === "active");
  if (links.length === 0) {
    const lines = [
      header("External Coding Links"),
      separator(),
      "No external coding links for this session.",
      "",
      "Useful local link forms:",
      "  code external link acp <session-id>",
      "  code external link mcp <client-or-session-id>",
      "  code external link cursor <workspace-or-thread-id>",
      "  code external link vscode <workspace-or-thread-id>",
      "",
      dim("Links are durable handles. They do not bypass Marina permissions or routing."),
    ];
    sendCode(ctx, eid, lines.join("\n"), {
      commands: [
        `code external link acp ${session.id}`,
        `code external link mcp ${session.id}`,
        "code external link vscode <id>",
      ],
      event: "external_sessions_listed",
      rows: [
        { detail: "Agent Client Protocol session handle", title: "acp", type: "external_link" },
        {
          detail: "Model Context Protocol client/session handle",
          title: "mcp",
          type: "external_link",
        },
        { detail: "Editor or IDE workspace handle", title: "vscode", type: "external_link" },
      ],
      sessionId: session.id,
      title: "External Coding Links",
      type: "list",
      workspace: session.workspace_root,
    });
    return;
  }
  const lines = [header("External Coding Links"), separator()];
  for (const artifact of links) {
    lines.push(`  ${artifact.id} ${artifact.content_text}`);
  }
  sendCode(ctx, eid, lines.join("\n"), {
    commands: ["code external link acp <id>", "code external unlink <id>"],
    event: "external_sessions_listed",
    rows: links.map((artifact) => ({
      id: artifact.id,
      title: artifact.title,
      detail: artifact.content_text,
      status: artifact.status,
      type: "external_link",
    })),
    sessionId: session.id,
    title: "External Coding Links",
    type: "list",
    workspace: session.workspace_root,
  });
}

function completeSession(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  summary: string,
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const text = summary.trim() || "Session completed.";
  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: "completion",
    title: formatCompletionTitle(text),
    status: "complete",
    contentText: text,
    metadata: { profile: getCodeProfile(entity).name },
    createdBy: entity.name,
  });
  deps.db.updateCodingSession(session.id, { status: "complete", mode: "done" });
  // Persist the closing summary into the bound project pool (if any) + a
  // personal note, so the session's takeaways outlive the ephemeral artifacts.
  if (summary.trim()) depositSessionSummary(deps, entity, session, text);
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "session_completed",
    payload: { artifactId: artifact.id, summary: text },
  });
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  sendCode(
    ctx,
    eid,
    [
      success(`Coding session completed: ${session.id}`),
      `Artifact: ${artifact.id}`,
      dim("Use: code show last | code tree | code branch <title>"),
    ].join("\n"),
    {
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      commands: ["code show last", "code tree", "code branch <title>"],
      content: text,
      event: "session_completed",
      sessionId: session.id,
      status: "complete",
      title: artifact.title,
      type: "session",
    },
  );
}

/**
 * Resolve a memory pool bound to this coding session, if any. Binding is by
 * convention: a project whose name matches the session workspace basename and
 * carries a pool_id. Returns undefined when nothing is bound (degrade silently).
 */
function resolveSessionPoolId(
  deps: CodeDeps & { db: MarinaDB },
  session: CodingSessionRow,
): string | undefined {
  const projectName = basename(session.workspace_root);
  const project = deps.db.getProjectByName(projectName);
  return project?.pool_id ?? undefined;
}

/**
 * Deposit a session summary into the bound project pool (when present) AND a
 * personal note. Both writes are best-effort — failures never block the
 * session flow. Returns the pool id when a pool deposit happened.
 */
function depositSessionSummary(
  deps: CodeDeps & { db: MarinaDB },
  entity: Entity,
  session: CodingSessionRow,
  text: string,
): string | undefined {
  const content = `[coding ${session.id}] ${text}`;
  try {
    deps.db.createNote(entity.name, content, undefined, { noteType: "summary" });
  } catch {
    // Personal note is best-effort.
  }
  const poolId = resolveSessionPoolId(deps, session);
  if (!poolId) return undefined;
  try {
    deps.db.addPoolNote(poolId, entity.name, content, undefined, "summary");
    return poolId;
  } catch {
    return undefined;
  }
}

function recordCodingNote(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  kind: string,
  args: string[],
): void {
  const noteKind = normalizeCodingNoteKind(kind);
  if (!noteKind) {
    ctx.send(eid, "Usage: code plan|summary|handoff|decision <text>");
    return;
  }
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  // `code handoff <notes> [to <agent>]` — when `to <agent>` is present, transfer
  // the write lock to that agent in addition to writing the handoff artifact.
  let handoffTo: string | undefined;
  let noteArgs = args;
  if (noteKind === "handoff") {
    const toIdx = args.findIndex((a) => a.toLowerCase() === "to");
    if (toIdx >= 0 && args[toIdx + 1]) {
      handoffTo = args[toIdx + 1];
      noteArgs = args.slice(0, toIdx);
    }
  }
  const text = noteArgs.join(" ").trim();
  if (!text) {
    ctx.send(eid, `Usage: code ${noteKind} <text>${noteKind === "handoff" ? " [to <agent>]" : ""}`);
    return;
  }

  const profile = getCodeProfile(entity);
  // Handoffs link to the active dispatched crew when one exists, so a reader of
  // the handoff can find who picked up the work. Minimal, best-effort.
  const noteMetadata: Record<string, unknown> = { profile: profile.name };
  if (noteKind === "handoff") {
    const activeCrew = latestActiveArtifact(deps.db, session.id, "crew_dispatched");
    if (activeCrew) noteMetadata.sourceArtifactId = activeCrew.id;
    if (handoffTo) noteMetadata.handoffTo = handoffTo;
  }
  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: noteKind,
    title: formatCodingNoteTitle(noteKind, text),
    status: "complete",
    contentText: text,
    metadata: noteMetadata,
    createdBy: entity.name,
  });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: `${noteKind}_recorded`,
    payload: { id: artifact.id, text, profile: profile.name },
  });
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "session_steered",
    payload: { text, profile: profile.name, artifactId: artifact.id, artifactKind: noteKind },
  });
  // A summary is the durable session takeaway — deposit it into the bound
  // project pool (when present) and a personal note. Degrades silently.
  if (noteKind === "summary") depositSessionSummary(deps, entity, session, text);
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
  // `code handoff <notes> to <agent>` transfers the write lock alongside the
  // handoff artifact. Re-read the row so reassignWriter sees the freshest writer.
  if (noteKind === "handoff" && handoffTo) {
    const fresh = deps.db.getCodingSession(session.id) ?? session;
    reassignWriter(ctx, eid, entity, deps, fresh, handoffTo, "handoff");
  }
  sendCode(ctx, eid, success(`${capitalize(noteKind)} stored: ${artifact.id}`), {
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    commands: [`code show ${artifact.id}`, "code status", "code history"],
    content: text,
    event: `${noteKind}_recorded`,
    sessionId: session.id,
    status: artifact.status,
    title: artifact.title,
    type: "note",
    workspace: session.workspace_root,
  });
}

/**
 * Single-writer guard for workspace-mutating paths. When `session.writer` is
 * non-null and the actor is not the holder, refuse and point at the transfer
 * commands. A null writer imposes NO restriction (solo sessions, existing
 * tests). Returns true when the caller may proceed.
 */
function enforceWriteLock(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  session: CodingSessionRow,
): boolean {
  if (!session.writer || session.writer === entity.name) return true;
  ctx.send(
    eid,
    `${session.writer} holds the write lock for this session — request a handoff (code handoff <notes> to ${entity.name}) or have the owner reassign (code writer ${entity.name}).`,
  );
  return false;
}

function resolveSession(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  db: MarinaDB,
  id?: string,
) {
  const sessionId = id || getActiveSessionId(entity);
  if (!sessionId) {
    ctx.send(
      eid,
      [
        "No active coding session.",
        'Start one with "code start", inspect readiness with "code onboard", or choose a workspace with "code workspace list".',
      ].join("\n"),
    );
    return null;
  }
  const session = db.getCodingSession(sessionId);
  if (!session) {
    ctx.send(eid, `Coding session not found: ${sessionId}`);
    return null;
  }
  return session;
}

function getWorkspaceRegistry(deps: CodeDeps): WorkspaceRegistry {
  if (!deps.workspace) {
    return deps.workspaceRegistry ?? WorkspaceRegistry.fromEnv();
  }
  const root = deps.workspace.displayRoot();
  return deps.workspaceRegistry ?? new WorkspaceRegistry({ defaultRoot: root, roots: [root] });
}

function getSelectedWorkspace(entity: Entity, deps: CodeDeps): WorkspaceRuntime {
  return getWorkspaceRegistry(deps).workspaceForRoot(getSelectedWorkspaceRoot(entity, deps));
}

function getSelectedWorkspaceRoot(entity: Entity, deps: CodeDeps): string {
  const value = entity.properties[CODE_WORKSPACE_KEY];
  const registry = getWorkspaceRegistry(deps);
  if (typeof value === "string" && value.trim()) {
    return registry.resolveRoot(value).root;
  }
  return registry.defaultRoot;
}

function workspaceForSession(deps: CodeDeps, session: CodingSessionRow): WorkspaceRuntime {
  return getWorkspaceRegistry(deps).workspaceForRoot(session.workspace_root);
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

function getSessionModelTarget(db: MarinaDB, sessionId: string): string | undefined {
  const artifact = latestActiveArtifact(db, sessionId, "model_setting");
  if (!artifact) return undefined;
  const meta = parseJsonObject(artifact.metadata_json);
  return typeof meta.target === "string" ? meta.target : undefined;
}

function modelTargetForAgentSpawn(target: string | undefined): string | undefined {
  if (!target) return undefined;
  const normalized = target.trim().toLowerCase();
  if (!normalized || ["agent", "crew", "direct", "default", "marina"].includes(normalized)) {
    return undefined;
  }
  return target;
}

function parseSpawnRunArgs(args: string[]): { model?: string; name?: string; ref?: string } {
  const parsed: { model?: string; name?: string; ref?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    const key = token?.toLowerCase();
    if ((key === "name" || key === "as") && args[i + 1]) {
      parsed.name = sanitizeAgentName(args[i + 1] ?? "");
      i++;
      continue;
    }
    if (key === "model" && args[i + 1]) {
      parsed.model = args[i + 1];
      i++;
      continue;
    }
    if (!parsed.ref && token) parsed.ref = token;
  }
  return parsed;
}

function sanitizeAgentName(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function uniqueSpawnAgentName(
  liveAgents: { name: string }[],
  role: string,
  sessionId: string,
): string {
  const live = new Set(liveAgents.map((agent) => agent.name.toLowerCase()));
  const base =
    sanitizeAgentName(`code-${role}-${sessionId.replace(/^code_session_?/, "").slice(0, 6)}`) ||
    "code-agent";
  if (!live.has(base.toLowerCase())) return base;
  for (let i = 2; i < 50; i++) {
    const candidate = `${base}-${i}`;
    if (!live.has(candidate.toLowerCase())) return candidate;
  }
  return `${base}-${Date.now().toString(36).slice(-4)}`;
}

function bindSpawnedAgentEntity(
  agent: { getStatus(): { entityId: string | null }; name: string },
  session: CodingSessionRow,
  profile: string,
  deps: CodeDeps & { db: MarinaDB },
): void {
  const entityId = agent.getStatus().entityId;
  if (!entityId) return;
  const spawned = deps.getEntity(entityId);
  if (!spawned) return;
  spawned.properties[ACTIVE_MODAL_KEY] = "code";
  spawned.properties[ACTIVE_SESSION_KEY] = session.id;
  spawned.properties[CODE_PROFILE_KEY] = profile;
  deps.db.saveEntity(spawned);
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: agent.name,
    kind: "code_agent_bound",
    payload: { agent: agent.name, entityId: spawned.id, profile },
  });
}

function getActiveSessionId(entity: Entity): string | undefined {
  const value = entity.properties[ACTIVE_SESSION_KEY];
  return typeof value === "string" ? value : undefined;
}

function updateCodeContext(entity: Entity, db: MarinaDB, session?: CodingSessionRow): void {
  const profile = getCodeProfile(entity);
  const artifacts = session ? db.listCodingArtifacts(session.id, 50) : [];
  const latestArtifact = artifacts[0];
  const latestMeta = latestArtifact ? parseArtifactMetadata(latestArtifact) : undefined;
  const pendingPatches = artifacts.filter(
    (artifact) => artifact.kind === "patch" && artifact.status === "pending",
  ).length;
  const assignment = artifacts.find((artifact) => artifact.kind === "agent_assignment");
  const assignmentMeta = assignment ? parseJsonObject(assignment.metadata_json) : {};
  const assignedAgent = typeof assignmentMeta.agent === "string" ? assignmentMeta.agent : undefined;
  const model = artifacts.find(
    (artifact) => artifact.kind === "model_setting" && artifact.status === "active",
  );
  const modelMeta = model ? parseJsonObject(model.metadata_json) : {};
  const modelTarget = typeof modelMeta.target === "string" ? modelMeta.target : undefined;
  const selectedWorkspace =
    typeof entity.properties[CODE_WORKSPACE_KEY] === "string"
      ? entity.properties[CODE_WORKSPACE_KEY]
      : undefined;
  const snapshot: CodeContextSnapshot = {
    assignedAgent,
    latestArtifactId: latestArtifact?.id,
    latestArtifactKind: latestArtifact?.kind,
    latestArtifactLifecycle: latestMeta?.lifecycle,
    latestArtifactStatus: latestArtifact?.status,
    modelTarget,
    pendingPatches,
    profile: profile.name,
    sessionId: session?.id,
    sessionMode: session?.mode,
    sessionStatus: session?.status,
    sessionTitle: session?.title,
    workspace: session?.workspace_root ?? selectedWorkspace,
    // Surface the single-writer lock holder so the UI chip renders without the
    // artifacts overlay open (the GET /api/coding/session/:id detail is a fallback).
    writer: session?.writer ?? undefined,
  };
  entity.properties[CODE_CONTEXT_KEY] = snapshot;
  db.saveEntity(entity);
}

function getCodeProfile(entity: Entity): CodeProfile {
  const name = normalizeProfileName(entity.properties[CODE_PROFILE_KEY]);
  const base = CODE_PROFILES[name ?? "marina"];
  return { ...base, aliases: { ...base.aliases, ...getCustomProfileAliases(entity) } };
}

function getCustomProfileAliases(entity: Entity): Record<string, string> {
  const raw = entity.properties[CODE_PROFILE_ALIASES_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const aliases: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && key.trim() && value.trim()) {
      aliases[key.toLowerCase()] = value.toLowerCase();
    }
  }
  return aliases;
}

function normalizeProfileName(value: unknown): CodeProfileName | null {
  if (value === "marina" || value === "pi" || value === "claude" || value === "codex") {
    return value;
  }
  return null;
}

function canonicalCodeSubcommand(profile: CodeProfile, sub: string): string {
  return profile.aliases[sub] ?? sub;
}

function normalizeCodingNoteKind(value: string): CodingNoteKind | null {
  if (value === "decision" || value === "handoff" || value === "plan" || value === "summary") {
    return value;
  }
  return null;
}

function detectPackageScripts(packageJson: string): string[] {
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

function recommendedVerify(scripts: string[]): string[] {
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

function formatHelp(profile: CodeProfile): string {
  return [
    BASE_HELP,
    "",
    `Profile: ${profile.name} ${dim(`prompt: ${profile.prompt}>`)}`,
    profile.description,
    `Aliases: ${formatAliases(profile)}`,
    `Steering: ${profile.steering.join(" | ")}`,
  ].join("\n");
}

function formatAliases(profile: CodeProfile): string {
  const entries = Object.entries(profile.aliases).sort(([a], [b]) => a.localeCompare(b));
  return entries.length > 0
    ? entries.map(([alias, target]) => `${alias} -> ${target}`).join(", ")
    : "none";
}

function formatProfileDetail(profile: CodeProfile): string {
  const rows = PROFILE_COMPARISON_ROWS.map(
    (row) =>
      `  ${row.action}: ${profileVerb(row, profile.name)} ${dim(
        `-> ${row.canonical}; grade=${row.grade}; ${row.portability}; ${row.status}${
          row.behavior ? `; ${row.behavior}` : ""
        }`,
      )}`,
  );
  return [
    header(`Code Profile: ${profile.name}`),
    separator(),
    `Prompt: ${profile.prompt}>`,
    `Description: ${profile.description}`,
    `Aliases: ${formatAliases(profile)}`,
    `Steering: ${profile.steering.join(" | ")}`,
    "",
    "Profiles are interface adapters. Marina primitives are the durable, vendor-neutral contract.",
    "Grades: native means Marina has a first-class primitive; adapter means familiar syntax maps cleanly; narrow means deliberately constrained; planned means not claiming parity yet.",
    "",
    header("Migration Map"),
    ...rows,
  ].join("\n");
}

function formatProfileComparison(active: CodeProfileName): string {
  const lines = [header("Code Profile Comparison"), separator()];
  lines.push(
    `Active: ${active}`,
    "Profiles preserve familiar syntax while routing to vendor-neutral Marina primitives.",
    "Grades: native = first-class Marina primitive; adapter = syntax adapter; narrow = constrained local behavior; planned = deferred capability.",
    "",
    "Action | marina | pi | claude | codex | Marina primitive | Grade | Portability | Behavior | Status",
    "--- | --- | --- | --- | --- | --- | --- | --- | --- | ---",
  );
  for (const row of PROFILE_COMPARISON_ROWS) {
    lines.push(
      [
        row.action,
        row.marina,
        row.pi,
        row.claude,
        row.codex,
        row.canonical,
        row.grade,
        row.portability,
        row.behavior ?? "",
        row.status,
      ].join(" | "),
    );
  }
  return lines.join("\n");
}

function profileComparisonRows(profile?: CodeProfileName): CodeDataRow[] {
  return PROFILE_COMPARISON_ROWS.map((row) => ({
    action: row.action,
    canonical: row.canonical,
    detail: row.behavior ?? row.portability,
    grade: row.grade,
    portability: row.portability,
    status: row.status,
    text: profile
      ? profileVerb(row, profile)
      : `${row.marina} | ${row.pi} | ${row.claude} | ${row.codex}`,
    title: profile ? profileVerb(row, profile) : row.action,
    type: "profile",
  }));
}

function profileVerb(row: ProfileComparisonRow, profile: CodeProfileName): string {
  switch (profile) {
    case "claude":
      return row.claude;
    case "codex":
      return row.codex;
    case "pi":
      return row.pi;
    case "marina":
      return row.marina;
  }
}

function formatCodingNoteTitle(kind: CodingNoteKind, text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const title = firstLine.length > 64 ? `${firstLine.slice(0, 61)}...` : firstLine;
  return `${capitalize(kind)}: ${title || "Untitled"}`;
}

function formatCompletionTitle(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const title = firstLine.length > 64 ? `${firstLine.slice(0, 61)}...` : firstLine;
  return `Completion: ${title || "Session completed"}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatProfileTry(profile: CodeProfile): string {
  switch (profile.name) {
    case "pi":
      return "open README.md | changes | exec test";
    case "claude":
      return "open README.md | review | plan prefer small patches";
    case "codex":
      return "inspect . | view README.md | test";
    case "marina":
      return "start | files | read <path> | run typecheck";
  }
}

function normalizeSteeringArgs(args: string[]): string {
  const cleaned = args[0]?.toLowerCase() === "up" ? args.slice(1) : args;
  return cleaned.join(" ").trim();
}

function restAfterSubcommand(args: string): string {
  const trimmed = args.trimStart();
  const match = trimmed.match(/^\S+\s*/);
  return match ? trimmed.slice(match[0].length) : "";
}

function parsePatchProposal(raw: string):
  | { ok: true; title: string; patch: string }
  | {
      ok: false;
      error: string;
    } {
  const body = raw.trimStart();
  if (!body.trim()) {
    return {
      ok: false,
      error: "Usage: code patch [title]\\n<unified diff>",
    };
  }
  const firstNewline = body.indexOf("\n");
  if (firstNewline === -1) {
    return {
      ok: false,
      error: "Patch proposal must include a unified diff on following lines.",
    };
  }
  const firstLine = body.slice(0, firstNewline).trim();
  if (firstLine.startsWith("diff --git ") || firstLine.startsWith("--- ")) {
    return { ok: true, title: "Patch proposal", patch: ensureTrailingNewline(body) };
  }
  const patch = body.slice(firstNewline + 1).trimStart();
  if (!patch.trim()) {
    return { ok: false, error: "Patch proposal is missing diff content." };
  }
  return { ok: true, title: firstLine || "Patch proposal", patch: ensureTrailingNewline(patch) };
}

function resolvePatchArtifact(
  ctx: RoomContext,
  eid: EntityId,
  db: MarinaDB,
  sessionId: string,
  id: string | undefined,
): CodingArtifactRow | null {
  if (!id) {
    ctx.send(eid, "Usage: code show|apply|reject <patch_id|last patch>");
    return null;
  }
  if (id.toLowerCase() === "last patch") {
    const latest = latestSessionArtifact(db, sessionId, "patch");
    if (!latest) {
      ctx.send(eid, "No patch proposals for this coding session.");
      return null;
    }
    return latest;
  }
  const artifact = db.getCodingArtifact(id);
  if (artifact?.kind !== "patch") {
    ctx.send(eid, `Patch not found: ${id}`);
    return null;
  }
  if (artifact.session_id !== sessionId) {
    ctx.send(eid, `Patch ${id} does not belong to the active coding session.`);
    return null;
  }
  return artifact;
}

function resolveSessionArtifact(
  ctx: RoomContext,
  eid: EntityId,
  db: MarinaDB,
  sessionId: string,
  id: string | undefined,
): CodingArtifactRow | null {
  if (!id) {
    ctx.send(eid, "Usage: code show <artifact_id|last|last patch|last failed>");
    return null;
  }
  const normalized = id.toLowerCase();
  if (normalized === "last" || normalized === "last artifact") {
    const latest = latestSessionArtifact(db, sessionId);
    if (!latest) {
      ctx.send(eid, "No artifacts for this coding session.");
      return null;
    }
    return latest;
  }
  if (normalized === "last patch") {
    const latest = latestSessionArtifact(db, sessionId, "patch");
    if (!latest) {
      ctx.send(eid, "No patch proposals for this coding session.");
      return null;
    }
    return latest;
  }
  if (normalized === "last failed" || normalized === "last failure") {
    const latest = latestFailureArtifact(db, sessionId);
    if (!latest) {
      ctx.send(eid, "No failed artifacts for this coding session.");
      return null;
    }
    return latest;
  }
  const artifact = db.getCodingArtifact(id);
  if (!artifact) {
    ctx.send(eid, `Artifact not found: ${id}`);
    return null;
  }
  if (artifact.session_id !== sessionId) {
    ctx.send(eid, `Artifact ${id} does not belong to the active coding session.`);
    return null;
  }
  return artifact;
}

function latestSessionArtifact(
  db: MarinaDB,
  sessionId: string,
  kind?: string,
): CodingArtifactRow | undefined {
  return db.listCodingArtifacts(sessionId, 50).find((artifact) => !kind || artifact.kind === kind);
}

function latestFailureArtifact(db: MarinaDB, sessionId: string): CodingArtifactRow | undefined {
  return db.listCodingArtifacts(sessionId, 50).find((artifact) => isFailureArtifact(artifact));
}

function latestActiveArtifact(
  db: MarinaDB,
  sessionId: string,
  kind: string,
): CodingArtifactRow | undefined {
  return db
    .listCodingArtifacts(sessionId, 50)
    .find((artifact) => artifact.kind === kind && artifact.status === "active");
}

function findNamedArtifact(
  db: MarinaDB,
  sessionId: string,
  kind: string,
  name: string,
): CodingArtifactRow | undefined {
  return db.listCodingArtifacts(sessionId, 80).find((artifact) => {
    if (artifact.kind !== kind || artifact.status === "archived") return false;
    const meta = parseJsonObject(artifact.metadata_json);
    return meta.name === name;
  });
}

function findStoredRecipe(
  db: MarinaDB,
  sessionId: string,
  name: string,
): CodingArtifactRow | undefined {
  return findNamedArtifact(db, sessionId, "run_recipe", name);
}

async function resolveRecipeCommands(
  db: MarinaDB,
  session: CodingSessionRow,
  workspace: WorkspaceRuntime,
  name: string,
): Promise<string[] | null> {
  if (name === "detected") {
    const packageJson = await workspace.read("package.json").catch(() => null);
    const scripts = packageJson ? detectPackageScripts(packageJson.content) : [];
    const commands = recommendedVerify(scripts);
    return commands.length > 0 ? commands : ["git diff --check"];
  }
  const stored = findStoredRecipe(db, session.id, name);
  if (!stored) {
    if (name === "default") return null;
    return null;
  }
  const meta = parseJsonObject(stored.metadata_json);
  const commands = Array.isArray(meta.commands) ? meta.commands.map(String).filter(Boolean) : [];
  return commands.length > 0 ? commands : null;
}

function parseRecipeCommands(raw: string): string[] {
  return raw
    .split(/\s+then\s+|[|]/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

function resolveKindArtifact(
  ctx: RoomContext,
  eid: EntityId,
  db: MarinaDB,
  sessionId: string,
  ref: string | undefined,
  kind: string,
  lastPhrase: string,
): CodingArtifactRow | null {
  const normalized = ref?.trim().toLowerCase();
  if (!normalized || normalized === "last" || normalized === lastPhrase) {
    const latest = latestSessionArtifact(db, sessionId, kind);
    if (!latest) {
      ctx.send(eid, `No ${kind} artifacts for this coding session.`);
      return null;
    }
    return latest;
  }
  const artifact = db.getCodingArtifact(ref!.trim());
  if (!artifact || artifact.kind !== kind) {
    ctx.send(eid, `${capitalize(kind.replace(/_/g, " "))} not found: ${ref}`);
    return null;
  }
  if (artifact.session_id !== sessionId) {
    ctx.send(eid, `Artifact ${artifact.id} does not belong to the active coding session.`);
    return null;
  }
  return artifact;
}

function resolveDecisionArtifact(
  ctx: RoomContext,
  eid: EntityId,
  db: MarinaDB,
  sessionId: string,
  ref: string | undefined,
): CodingArtifactRow | undefined {
  const normalized = ref?.trim();
  if (!normalized || normalized === "last" || normalized === "last approval") {
    const artifact = db
      .listCodingArtifacts(sessionId, 80)
      .find(
        (candidate) =>
          ["approval", "spawn_request"].includes(candidate.kind) && candidate.status === "pending",
      );
    if (!artifact) {
      ctx.send(eid, "No pending approvals or spawn requests for this coding session.");
      return undefined;
    }
    return artifact;
  }
  const artifact = db.getCodingArtifact(normalized);
  if (!artifact || !["approval", "spawn_request"].includes(artifact.kind)) {
    ctx.send(eid, `Approval or spawn request not found: ${normalized}`);
    return undefined;
  }
  if (artifact.session_id !== sessionId) {
    ctx.send(eid, `Artifact ${artifact.id} does not belong to the active coding session.`);
    return undefined;
  }
  return artifact;
}

function parsePatchActionArgs(args: string[]): { ref: string | undefined; reason: string } {
  if (args[0]?.toLowerCase() === "last" && args[1]?.toLowerCase() === "patch") {
    return { ref: "last patch", reason: args.slice(2).join(" ") };
  }
  return { ref: args[0], reason: args.slice(1).join(" ") };
}

function parseEventPayload(event: { payload_json: string }): Record<string, unknown> {
  return parseJsonObject(event.payload_json);
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

type ArtifactListFilter =
  | { ok: true; mode?: "failed" | "recent"; kind?: string; status?: string }
  | { ok: false; error: string };

function parseArtifactListFilter(args: string[]): ArtifactListFilter {
  const [action, value, extra] = args;
  if (!action) return { ok: true };
  const normalized = action.toLowerCase();
  if (normalized === "recent" && !value) return { ok: true, mode: "recent" };
  if ((normalized === "failed" || normalized === "failures") && !value) {
    return { ok: true, mode: "failed" };
  }
  if (normalized === "kind" && value && !extra) return { ok: true, kind: value };
  if (normalized === "status" && value && !extra) return { ok: true, status: value };
  return {
    ok: false,
    error: "Usage: code artifacts [recent|failed|status <status>|kind <artifact_kind>]",
  };
}

function artifactMatchesListFilter(
  artifact: CodingArtifactRow,
  filter: Extract<ArtifactListFilter, { ok: true }>,
): boolean {
  if (filter.kind && artifact.kind !== filter.kind) return false;
  if (filter.status && artifact.status !== filter.status) return false;
  if (filter.mode === "failed" && !isFailureArtifact(artifact)) return false;
  return true;
}

function formatArtifactListTitle(filter: Extract<ArtifactListFilter, { ok: true }>): string {
  if (filter.mode === "failed") return "Artifacts: failed";
  if (filter.mode === "recent") return "Artifacts: recent";
  if (filter.status) return `Artifacts: status ${filter.status}`;
  if (filter.kind) return `Artifacts: ${filter.kind}`;
  return "Artifacts";
}

function formatNoArtifactsMessage(filter: Extract<ArtifactListFilter, { ok: true }>): string {
  if (filter.mode === "failed") return "No failed artifacts for this coding session.";
  if (filter.mode === "recent") return "No recent artifacts for this coding session.";
  if (filter.status) return `No artifacts with status ${filter.status} for this coding session.`;
  if (filter.kind) return `No ${filter.kind} artifacts for this coding session.`;
  return "No artifacts for this coding session.";
}

function isFailureArtifact(artifact: CodingArtifactRow): boolean {
  if (["failed", "denied"].includes(artifact.status)) return true;
  const meta = parseArtifactMetadata(artifact);
  return meta.timedOut === true || (typeof meta.exitCode === "number" && meta.exitCode !== 0);
}

function parseArtifactMetadata(artifact: CodingArtifactRow): {
  command: string[];
  durationMs?: number;
  exitCode?: number;
  lifecycle?: string;
  lifecycleAt?: number;
  lifecycleBy?: string;
  paths: string[];
  timedOut?: boolean;
  truncated?: boolean;
} {
  try {
    const parsed = JSON.parse(artifact.metadata_json) as {
      command?: unknown;
      durationMs?: unknown;
      exitCode?: unknown;
      lifecycle?: unknown;
      lifecycleAt?: unknown;
      lifecycleBy?: unknown;
      paths?: unknown;
      timedOut?: unknown;
      truncated?: unknown;
    };
    return {
      command: Array.isArray(parsed.command) ? parsed.command.map(String) : [],
      durationMs: typeof parsed.durationMs === "number" ? parsed.durationMs : undefined,
      exitCode: typeof parsed.exitCode === "number" ? parsed.exitCode : undefined,
      lifecycle: typeof parsed.lifecycle === "string" ? parsed.lifecycle : undefined,
      lifecycleAt: typeof parsed.lifecycleAt === "number" ? parsed.lifecycleAt : undefined,
      lifecycleBy: typeof parsed.lifecycleBy === "string" ? parsed.lifecycleBy : undefined,
      paths: Array.isArray(parsed.paths) ? parsed.paths.map(String) : [],
      timedOut: typeof parsed.timedOut === "boolean" ? parsed.timedOut : undefined,
      truncated: typeof parsed.truncated === "boolean" ? parsed.truncated : undefined,
    };
  } catch {
    return { command: [], paths: [] };
  }
}

function formatPaths(paths: string[]): string {
  return paths.length > 0 ? paths.join(", ") : "(no paths)";
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function normalizeCodeRunArgs(args: string[]): string[] {
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

function formatVerificationSummary(results: StoredCommandResult[]): string {
  const failed = results.find((item) => item.result.exitCode !== 0 || item.result.timedOut);
  const lines = [
    failed ? fmtError("Verification failed.") : success("Verification passed."),
    separator(),
  ];
  for (const item of results) {
    const result = item.result;
    const status = result.exitCode === 0 && !result.timedOut ? success("pass") : fmtError("fail");
    lines.push(
      `${status} $ ${result.command.join(" ")} ${dim(
        `[exit ${result.exitCode}] ${result.durationMs}ms artifact: ${item.artifact.id}`,
      )}`,
    );
  }
  if (failed) {
    lines.push(dim("Stopped at first failed verification command."));
  }
  return lines.join("\n");
}

function formatArtifactMetaLine(meta: ReturnType<typeof parseArtifactMetadata>): string {
  const detail = formatArtifactMeta(meta);
  return detail ? `Details: ${detail}` : "Details: none";
}

function formatArtifactMeta(meta: ReturnType<typeof parseArtifactMetadata>): string {
  const lifecycle = meta.lifecycle
    ? `lifecycle: ${meta.lifecycle}${meta.lifecycleBy ? ` by ${meta.lifecycleBy}` : ""}`
    : "";
  if (meta.paths.length > 0) {
    return [lifecycle, `paths: ${formatPaths(meta.paths)}`].filter(Boolean).join(", ");
  }
  if (meta.command.length > 0) {
    const parts = [`command: ${meta.command.join(" ")}`];
    if (meta.exitCode !== undefined) parts.push(`exit: ${meta.exitCode}`);
    if (meta.durationMs !== undefined) parts.push(`${meta.durationMs}ms`);
    if (meta.timedOut) parts.push("timed out");
    if (meta.truncated) parts.push("truncated");
    if (lifecycle) parts.push(lifecycle);
    return parts.join(", ");
  }
  return lifecycle;
}
