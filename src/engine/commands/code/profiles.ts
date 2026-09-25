// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { dim, header, separator, success } from "../../../net/ansi";
import type { MarinaDB } from "../../../persistence/database";
import type { Entity, EntityId, RoomContext } from "../../../types";
import {
  CODE_PROFILE_ALIASES_KEY,
  CODE_PROFILE_KEY,
  CODE_PROFILES,
  type CodeDataRow,
  type CodeDeps,
  type CodeProfile,
  type CodeProfileName,
  getActiveSessionId,
  getCodeProfile,
  getCustomProfileAliases,
  normalizeProfileName,
  type ProfileComparisonRow,
  sendCode,
  updateCodeContext,
} from "./shared";

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
    marina: "service start/probe/screenshot; observe",
    pi: "extension/skill",
    claude: "/verify",
    codex: "browser/test workflow",
    canonical: "service_probe/service_screenshot + observation artifacts",
    grade: "narrow",
    portability: "Flywheel managed-service evidence",
    behavior:
      "Managed guest services support HTTP probes and PNG evidence; one automatic full-app verify verb is not claimed.",
    status: "implemented",
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

const BASE_HELP = `Coding sessions with explicit local or optional Flywheel execution.
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
  code sandbox status         Show optional Flywheel workspace readiness
  code sandbox network status Show network profile and verified-enforcement state
  code sandbox credentials    List logical credential bindings (never secret material)
  code sandbox ops inventory  Steward fleet inventory and recoverable reclamation
  code sandbox start [image]  Create this entity's durable Flywheel workspace
  code sandbox use|local      Select Flywheel or local execution for this session
  code sandbox hibernate|resume Preserve or resume its writable guest disk
  code sandbox stop confirm   Destructively remove its guest workspace
  code project init <name>    Bootstrap a durable guest Git project
  code project clone <url> [name] Clone a public HTTPS Git repository
  code project status|list|diff Inspect durable project state and tracked changes
  code project switch <id|name> Change the active guest project safely
  code project export [archive] Store a patch or complete bounded archive artifact
  code project import <artifact> <name> Materialize a project archive atomically
  code project delete <id|name> confirm Remove safely exported guest project content
  code project reconcile       Remove stale metadata from replacement sandboxes
  code service start <name> [--port N] -- <command> Start a managed VM service
  code service list|status|logs|probe|screenshot|stop|restart Manage and observe services
  code service publish|revoke <name> Expose or revoke a declared service port
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
  code stop                   Stop the bound coding agent's current run (alias: cancel)
  code list                   List your coding sessions
  code resume <session_id>    Make a session active
  code status [session_id]    Show session status
  code files [path]           List workspace files
  code read <path>            Read a workspace file
  code search <query>         Search workspace text
  code diff [path]            Show git diff
  code run <check|cmd...>     Run an allowed workspace command and store output
  code run allowlist          Show host-local allowed commands
  code run app [script]       Show managed Flywheel service guidance (host mode is disabled)
  code observe <note>         Store an app/workspace observation
  code review [approve|reject] Review the latest coding task and its evidence
  code verify                 Run detected typecheck/lint/test/build chain
  code test|lint|typecheck    Run a common verification command
  code patch [title]\\n<diff>  Propose a unified-diff patch
  code edit <path> [all]\\n<<<<<<< OLD\\n{old}\\n=======\\n{new}\\n>>>>>>> NEW  Replace exact text in a file
  code write <path>\\n<content> Create or overwrite a workspace file
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

export function handleProfile(
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

export function formatHelp(profile: CodeProfile): string {
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

export function formatProfileTry(profile: CodeProfile): string {
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
