import { accessSync, constants as fsConstants } from "node:fs";
import { basename, delimiter, join } from "node:path";
import {
  type CodePromptAnswerer,
  CodeSessionDriver,
  type CodingAgentRuntime,
} from "../../coding/code-session-driver";
import type { LocalWorkspace, WorkspaceRunResult } from "../../coding/local-workspace";
import { WorkspaceRegistry } from "../../coding/workspace-registry";
import { dim, error as fmtError, header, separator, success } from "../../net/ansi";
import type { CodingArtifactRow, CodingSessionRow, MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";

const ACTIVE_SESSION_KEY = "coding_session_id";
const ACTIVE_MODAL_KEY = "active_modal";
const CODE_CONTEXT_KEY = "code_context";
const CODE_PROFILE_KEY = "code_profile";
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
    | "note"
    | "patch"
    | "profile"
    | "readiness"
    | "search"
    | "session"
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
  pendingPatches: number;
  profile: CodeProfileName;
  sessionId?: string;
  sessionMode?: string;
  sessionStatus?: string;
  sessionTitle?: string;
  workspace?: string;
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
  code workspace              Show active/default code workspace
  code workspace list         List configured code workspace roots
  code workspace use <path>   Select a workspace root for new sessions
  code doctor                 Inspect Code Mode workspace readiness
  code onboard                Show workspace/session readiness guidance
  code ask <request>          Ask the default Marina code model for this session
  code assign <agent> <req>   Assign this coding session to a live Marina agent
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
  code handoff <notes>        Store a handoff artifact
  code decision <choice>      Store a decision artifact
  code steer <direction>      Record steering on the active session
  code exit                   Leave Code Mode

In Code Mode, omit the "code" prefix: start, files, read <path>, run test, exit.
This first cut is local-CWD only and path-confined. Writes happen only by applying a stored patch.`;

export interface CodeDeps {
  agentRuntime?: CodingAgentRuntime;
  answerPrompt?: CodePromptAnswerer;
  db?: MarinaDB;
  workspace?: LocalWorkspace;
  workspaceRegistry?: WorkspaceRegistry;
  getEntity: (id: string) => Entity | undefined;
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
          default:
            ctx.send(input.entity, formatHelp(profile));
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
  ctx.send(
    eid,
    [
      success("Code Mode active."),
      `Profile: ${profile.name} ${dim(`prompt: ${profile.prompt}>`)}`,
      `Workspace: ${selectedRoot}${registry.usesCwdFallback ? dim(" (process cwd fallback)") : ""}`,
      session ? `Session: ${session.id} ${dim(session.status)}` : dim("No active session yet."),
      "Commands now route to local coding sessions.",
      dim(`Try: ${formatProfileTry(profile)} | onboard | exit`),
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
    ctx.send(eid, `${header(`Aliases: ${profile.name}`)}\n${formatAliases(profile)}`);
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
    ctx.send(eid, "Usage: code workspace [show|list|use <path>]");
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
      dim("Use: code workspace list | code workspace use <path> | code doctor"),
    ].join("\n"),
    {
      commands: ["code workspace list", "code workspace use <path>", "code doctor"],
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
  const artifact = await driver.runDirect({
    actor: entity.name,
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
      sessionId: session.id,
      status: artifact.status,
      title: artifact.title,
      type: "artifact",
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
  const artifact = await driver.assignAgent({
    actor: entity.name,
    agentName: agentName ?? "",
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
    rows: [
      { id: session.id, status: session.status, title: session.title, type: "session" },
      { detail: session.mode, title: "Mode", type: "field" },
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
    dim("Use: code workspace list | code workspace use <path> | code start <title>"),
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
  workspace: LocalWorkspace,
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

async function verifyWorkspace(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
): Promise<void> {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;

  const workspace = workspaceForSession(deps, session);
  const packageJson = await workspace.read("package.json").catch(() => null);
  const scripts = packageJson ? detectPackageScripts(packageJson.content) : [];
  const commands = recommendedVerify(scripts);
  if (commands.length === 0) {
    commands.push("git diff --check");
  }

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
    title: failed ? "Verification failed" : "Verification passed",
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
  if (session.created_by !== entity.name) {
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
  const text = args.join(" ").trim();
  if (!text) {
    ctx.send(eid, `Usage: code ${noteKind} <text>`);
    return;
  }

  const profile = getCodeProfile(entity);
  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: noteKind,
    title: formatCodingNoteTitle(noteKind, text),
    status: "complete",
    contentText: text,
    metadata: { profile: profile.name },
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
  updateCodeContext(entity, deps.db, deps.db.getCodingSession(session.id) ?? session);
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

function getSelectedWorkspace(entity: Entity, deps: CodeDeps): LocalWorkspace {
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

function workspaceForSession(deps: CodeDeps, session: CodingSessionRow): LocalWorkspace {
  return getWorkspaceRegistry(deps).workspaceForRoot(session.workspace_root);
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
    pendingPatches,
    profile: profile.name,
    sessionId: session?.id,
    sessionMode: session?.mode,
    sessionStatus: session?.status,
    sessionTitle: session?.title,
    workspace: session?.workspace_root ?? selectedWorkspace,
  };
  entity.properties[CODE_CONTEXT_KEY] = snapshot;
  db.saveEntity(entity);
}

function getCodeProfile(entity: Entity): CodeProfile {
  const name = normalizeProfileName(entity.properties[CODE_PROFILE_KEY]);
  return CODE_PROFILES[name ?? "marina"];
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

async function detectPackageManager(workspace: LocalWorkspace): Promise<string> {
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
