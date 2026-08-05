# Marina Web Coding CLI

## Intent

Marina should expose a coding-agent experience from inside the live world: a universal terminal
thread that feels as immediate as Codex, Claude Code, Cursor, or pi-code, but is native to Marina's
persistent multiuser multiagent substrate.

The core idea is not "embed a terminal in the dashboard." It is a shared coding-session primitive
that can be driven by humans, agents, ACP clients, MCP tools, and future desktop/editor surfaces.
The existing rich WebChat should be the first client. A modal can still exist as a focused view of
the same terminal thread, but it should not be a separate dashboard application or parallel coding UI.

Code Mode is the preferred coding surface for new Marina deployments and worlds. Older room/world
coding workflows such as `craft/workshop` can remain useful as spec-process examples, but they should
be treated as legacy or specialized workflows layered over the universal coding modal rather than as
the required place where coding happens.

## Execution Strategies

Code Mode is a routing surface over Marina's existing agent society, not a single hard-coded agent
loop. A user-facing profile decides the prompt label and vocabulary; an execution strategy decides who
services the request.

Current strategies:

- `direct`: `code ask <request>` sends the prompt through Marina's internal `/v1/chat/completions`
  model surface and stores the answer as an `agent_response` artifact. This is useful for quick
  guidance, but it is intentionally honest that it has no direct workspace tools.
- `agent`: `code assign <agent> <request>` sends a coding-session attention packet to an already
  running Marina agent and stores the assignment as an artifact. If the agent exposes an entity id,
  assignment also binds that entity into Code Mode by setting its active session and profile. The
  agent continues through the normal Marina perception/tool loop, with a structured `marina_code`
  tool available on full/crew profiles and `marina_command` remaining the universal fallback.

Planned strategies:

- `spawn`: create a dedicated coding agent through the existing `agent.spawn` safety gate, with a
  session-scoped goal and tool profile.
- `crew`: compile a coding Score and run it through the conductor/crew primitives so scouts,
  implementers, verifiers, and reviewers can work in parallel.
- `model`: route through a specific provider model or `marina:<channel>` orchestration while keeping
  the same coding transcript and artifact store.

The durable contract remains the coding session: prompts, strategy decisions, tool calls, command
output, patches, approvals, and handoffs should all land in the same session ledger no matter which
strategy was used.

## Onboarding Difference

Most coding agents inherit their workspace from the shell that launched them: the user `cd`s into a
repo and runs a CLI. Marina is different. It is a persistent server/world that may stay online for
weeks, serve many users, host many agents, and coordinate many projects at once. Its process cwd is
an implementation detail, not the user's coding intent.

That changes onboarding:

- The first question is not "what directory did the process start in?" It is "which workspace should
  this coding session bind to?"
- A user may enter Code Mode from WebChat, telnet, ACP, an external gateway, or another agent. None
  of those clients necessarily has a local cwd.
- Multiple people can use different workspaces in one Marina instance.
- A live agent assigned to a coding session must receive the session's workspace capability, not
  whatever cwd the server happens to have.
- Browser-only users may need a userland workspace that Marina stores and materializes, rather than
  a host repo path.

The local implementation therefore has an explicit workspace registry:

- `MARINA_CODE_ROOTS`: comma-separated directories Marina may offer for host workspace mode.
- `MARINA_CODE_DEFAULT_ROOT`: optional default workspace root.
- `code workspace list`: show configured roots.
- `code workspace use <path>`: select a workspace for new sessions.
- `code doctor`: report selected workspace, active session, git/search/package-script readiness, and
  the recommended verification chain. The first local version reports package manager from lockfiles,
  package scripts, git cleanliness/change count, `bun`/`git`/`rg` binary availability, search mode,
  and exact `code run ...` verification commands.
- `code verify`: run the detected verification chain through the same allowlisted local runner as
  `code run`, store each command output, and store a verification summary artifact. If no known
  package scripts are present, fall back to `git diff --check`.
- `code run app [script]`: planned container/userland-gated app run. Disabled in host local mode so
  package scripts do not execute directly on the Marina host.
- `code observe <note>`: store a durable observation artifact for app/workspace behavior.

If no roots are configured, Marina falls back to its process cwd for backwards compatibility and
tests. Production deployments should configure roots deliberately, for example `/srv/marina/repos`
or `/workspaces`.

## What To Borrow

The strongest ideas from current coding agents map cleanly onto Marina:

- Terminal-style conversational loop: prompt, stream, tool calls, command output, diffs, approvals.
- Slash commands for session control: context, permissions, models, agents, review, compact, resume.
- Persistent sessions with branch/fork/resume instead of throwaway chats.
- User-owned harness profiles: aliases, prompt label, steering vocabulary, skills, and templates.
- Compatibility profiles for familiar migration paths: `marina`, `pi`, `claude`, and `codex` should
  share the same session/artifact/workspace substrate while changing prompt labels, aliases, help
  wording, and steering vocabulary.
- Compatibility is graded, not assumed. See
  [code-agent-compatibility-audit.md](./code-agent-compatibility-audit.md) for the current source
  audit and known gaps. In particular, Marina `code verify` currently means local check-chain
  verification, not full Claude-style app launch and observation.
- Workspace isolation with explicit filesystem, shell, network, and credential boundaries.
- Plan/review modes before edits, with visible todos and checkpoints.
- Diff-first code review: show proposed patches as first-class artifacts, not just prose.
- Background and parallel agents for independent tasks.
- Tool extension through MCP and Marina's existing command substrate.
- Editor compatibility through ACP, without making ACP the internal architecture.
- Reusable instructions, skills, hooks, and policy rules.
- Team visibility: presence, handoffs, shared notes, task ownership, and audit trails.

Marina's differentiator is that these do not need to be bolted on separately. The world already has
identity, memory, standing, rooms, groups, tasks, channels, boards, canvas, MCP, ACP, runtime agents,
and streaming dashboard events.

## Current Marina Fit

Useful existing substrate:

- `src/net/websocket-server.ts` already serves `/ws`, `/dashboard-ws`, `/canvas-ws`, `/api/*`,
  `/v1/*`, `/mem/*`, dashboard, canvas, and webchat from one server.
- `src/sdk/client.ts` already gives programmatic login, reconnect, command dispatch, and perception
  collection.
- `src/net/acp-server.ts` already provides a minimal ACP bridge for editor/agent-client
  compatibility.
- `src/agent/agent-runtime.ts` already spawns persistent agents, records configs, emits turn events,
  streams text/thinking deltas, and tracks tool counts.
- `src/agent/tools/index.ts` already wraps Marina commands as typed LLM tools and supports tool
  profiles.
- `src/engine/commands/run.ts`, `src/engine/commands/shell.ts`, `src/engine/shell-runtime.ts`, and
  the `shell_allowlist` / `shell_log` tables already provide a restricted shell foundation.
- `dashboard/src/components/WebChat.tsx` already handles a command-style chat session, rich/compact
  modes, structured perception cards, copyable transcript items, contextual suggestions,
  command-triggered overlays, media job views, and canvas timeline embeds.
- `dashboard/src/hooks/use-websocket.ts` already consumes high-frequency agent streaming events for
  live UI state.

Missing substrate:

- A durable coding session model distinct from generic world chat.
- Workspace records: repo path/source, sandbox policy, branch/worktree, current cwd, env profile.
- Structured transcript items for user prompts, agent deltas, tool calls, approvals, command output,
  file changes, checkpoints, and artifacts.
- Patch/diff storage and review endpoints.
- File read/write/search APIs constrained to a declared workspace.
- Approval requests with multiuser ownership and timeout behavior.
- Session-scoped slash command registry.
- First-class coding agent roles and orchestration patterns.
- Rich WebChat renderers and overlays for code work: session headers, tool calls, approval cards,
  diffs, command logs, file previews, and coding artifacts.

## Proposed Architecture

### 1. Coding Session Core

Add a `coding` backend module:

```text
src/coding/
  coding-types.ts
  coding-session-manager.ts
  workspace-manager.ts
  diff-service.ts
  approval-service.ts
  coding-slash-commands.ts
  coding-agent-bridge.ts
```

The session manager owns durable state and emits engine/dashboard events. It should not know about
React, ACP, or a specific model provider.

Core entities:

- `coding_session`: durable session record.
- `coding_workspace`: repo/worktree/sandbox declaration.
- `coding_turn`: one user or agent turn.
- `coding_event`: append-only event stream.
- `coding_artifact`: patch, command output, screenshot, test report, plan, summary.
- `coding_approval`: pending human decision for shell, network, file write, commit, PR, or secret use.

### 2. Workspace Boundary

Every coding session must bind to a workspace:

- local path inside an allowed root,
- optional generated worktree,
- optional scratch workspace for non-repo tasks,
- sandbox policy,
- shell allowlist policy,
- env/secret profile,
- network mode.

Do not let WebChat issue arbitrary `run raw`. The coding substrate should call a narrower
workspace executor that understands cwd, max output size, timeouts, allowlists, and approval gates.

The existing `ShellRuntime` is the right precedent, not the complete solution. Today it runs
allowlisted binaries in `data/scratch/<entity>`, blocks shell metacharacters in normal mode, reserves
raw shell for sovereign users, rate limits execution, writes full output files, stores previews, logs
to `shell_log`, and lets outputs be saved to notes, boards, memory, or canvas. That is enough for
basic isolated command execution. It is not enough for coding against real repositories because it
has no workspace root, repo metadata, cwd stack, file patch model, long-running process model,
dependency policy, or per-session permissions.

Coding should introduce `WorkspaceRuntime`, reusing the good `ShellRuntime` constraints:

- scoped cwd and root containment,
- allowlist and approval gates,
- output preview plus full artifact log,
- timeout and rate limiting,
- DB audit log,
- scratch/artifact publishing,
- curated environment.

But it must add repo-aware behavior:

- resolve and validate paths relative to a workspace root,
- read, write, create, delete, rename, and stat files,
- search text with `rg`-style semantics,
- compute and store diffs before and after edits,
- run finite commands in workspace cwd,
- manage long-running dev servers separately,
- detect package manager and verification commands,
- optionally create git worktrees for parallel sessions,
- expose git status/diff/branch/commit operations as tools.

Local mode should keep a small default command allowlist because it runs against an operator-owned
host checkout. It needs enough binaries for the inspect/patch/verify loop, not a general shell. The
baseline package surface is:

- required: `bun`, `git`, `rg`;
- common next additions by policy profile: `node`, package-manager metadata commands, repo-declared
  test runners, and formatter/linter scripts surfaced through `package.json`;
- container/userland-only candidates: compilers, build-essential toolchains, Python/uv, pnpm/yarn,
  cargo, go, system package managers, browsers, Playwright dependencies, and networked dependency
  installs.

That split matters: broadening the host allowlist should be slower than broadening a sandbox image.
Containers can ship a richer developer image while local mode remains a narrow trusted-repo harness.

### 2a. Userland Filesystem Model

Marina likely needs two filesystem modes:

1. **Host workspace mode** for local/operator-controlled repos.
   - A workspace points at a real directory under configured allowed roots.
   - File reads are direct but path-confined.
   - Writes go through proposed patches and approvals.
   - Commands run with cwd inside the workspace.
   - Best for developing Marina itself or trusted local projects.

2. **Userland workspace mode** for online multiuser coding.
   - A workspace is stored in Marina-managed storage and projected to a temp/scratch directory only
     while commands run.
   - Files, diffs, generated artifacts, and checkpoints are durable DB/storage objects.
   - Multiple users/agents can have isolated branches of the same logical workspace.
   - Best for browser-only users, shared coding rooms, tutorials, bounties, and untrusted uploads.

Userland workspaces prevent "Marina can only code on the host repo" from becoming a hard product
limit. They also let agents build small projects, examples, patches, and exercises without receiving
host filesystem authority.

Minimum userland file tables can be simple:

```sql
CREATE TABLE coding_files (
  workspace_id TEXT NOT NULL,
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  storage_key TEXT,
  content_text TEXT,
  mime_type TEXT NOT NULL DEFAULT 'text/plain',
  size INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, path)
);

CREATE TABLE coding_checkpoints (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  label TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

Large/binary content belongs in the storage provider; small text can live inline for search and
diffing. A checkpoint is a manifest of file paths to hashes/storage keys, not a full duplicate of
every file.

The first implementation can ship host workspace mode plus scratch-only userland mode. Full durable
userland workspaces can follow once the session, diff, and approval model is stable.

### 2b. Sandbox And Workspace Lessons

NVIDIA OpenShell is the more precise reference for this layer. Its useful idea is not "run another
shell"; it is a gateway-managed runtime where each agent/sub-agent gets an individual sandbox, every
resource is metered, and policy is enforced before filesystem, network, process, or inference access
reaches the host.

Marina should adopt the same shape without outsourcing its identity/memory/collaboration model:

- **Direct host mode** is operator/local development. It should be visibly labeled and restricted to
  configured roots.
- **Sandboxed host mode** runs commands in an isolated process/container with only the approved
  workspace root mounted.
- **Userland mode** stores files in Marina and materializes them into a temp execution directory only
  for commands.
- **Remote executor mode** can come later: a separate worker/agent server executes workspace jobs and
  streams events back to Marina.

The important lesson is that filesystem authority and agent identity are separate. A Marina agent can
be a persistent citizen with memory and standing while receiving only a temporary, narrow workspace
capability for a coding session.

OpenShell-specific lessons to copy conceptually:

- **Gateway as policy boundary:** all file, process, network, secret, and inference actions pass
  through a Marina gateway before they touch host resources.
- **Per-session sandbox identity:** a coding session gets a sandbox id, workspace mount/materialized
  root, policy snapshot, resource quotas, and audit stream.
- **Static vs dynamic policy:** filesystem and process constraints are usually fixed when the
  sandbox starts; network and inference/provider routing can be hot-updated after approval.
- **Policy at multiple levels:** binary, path, HTTP method/path, process privilege, syscall-like
  danger classes, and credential provider.
- **Provider injection:** secrets should be bound as named providers and injected at runtime, not
  written into the workspace filesystem.
- **Policy roadblocks as workflow:** when an agent is blocked, it should emit a policy-change request
  explaining the command/path/network/provider it needs and why.
- **Auditability:** every allow/deny decision becomes a durable coding event and can be rendered as
  a rich WebChat approval card.

This points to a Marina `WorkspaceGateway` between `CodingSessionManager` and `WorkspaceRuntime`.
The agent asks for an action; the gateway evaluates policy; the runtime executes only if allowed.

If Flywheel is available as a maintained local dependency/service, Marina may not need OpenShell as a
runtime dependency at all. The split should be:

- **Use Flywheel-style architecture for execution:** sandbox providers, process lifecycle, execution
  ids, parent/child executions, event streams, persisted replay, storage artifacts.
- **Use OpenShell as a policy/sandbox-design reference:** gateway enforcement, static/dynamic policy
  split, resource metering, credential provider injection, deny/approval workflow.

In other words: prefer one real executor substrate. Do not run both Flywheel and OpenShell unless
there is a concrete gap Flywheel cannot cover. Keep the OpenShell lessons as requirements for
Marina's gateway/policy layer.

### 2c. Skill Layers

Code Mode should consume skills at two levels:

1. **Base reality Marina skills.**
   - Stored and shared through the existing `skill` command and memory/pool substrate.
   - Useful to every world participant, regardless of modal.
   - Examples: "how this repo verifies changes", "preferred review checklist", "how to ask a
     specialist agent for a handoff".

2. **Coding modal/profile skills.**
   - Bound to a coding profile or session and surfaced in Code Mode help/steering.
   - Useful for emulating tool styles without vendor lock-in.
   - Examples: Codex-style inspect/patch/verify loop, Claude-style compact/handoff behavior,
     pi-style proposal/accept language, project-specific edit rules.

Both layers should compile down to Marina primitives: code session events, typed artifacts, workspace
tools, memory notes, and agent attention. A skill imported from another platform should become a
Marina skill plus optional Code Mode aliases or steering text, not a new backend dependency.

### 2d. Command Capability Tiers

Expanding the global shell allowlist helps, but it does not replace workspace policy. More binaries
make scratch commands more useful; they do not solve path containment, diffs, edits, dependency
installs, long-running processes, or multiuser permissions.

Use layered command policy:

- **Global binary allowlist:** safe defaults available anywhere, e.g. `ls`, `cat`, `head`, `tail`,
  `wc`, `grep`, `rg`, `find`, `jq`, `date`, `echo`.
- **Workspace read-only commands:** `git status`, `git diff`, `git log`, package-manager metadata,
  language version checks.
- **Workspace verification commands:** `bun test`, `bun run typecheck`, `bun run lint`, `npm test`,
  `pytest`, etc.; inferred and then pinned per workspace.
- **Mutation commands:** formatters, code generators, dependency installs, build outputs; require
  session policy and usually approval.
- **Long-running commands:** dev servers/watchers; require process ownership, port assignment, log
  artifacts, health checks, and cleanup.
- **Dangerous commands:** deletion, recursive moves, shell pipelines, network installers, pushes,
  secret reads; require explicit approval or remain unavailable.

This lets Marina expand useful command coverage without turning `run raw` into the coding
architecture.

### 2e. Userland Workspace Lifecycle

A durable userland workspace should behave like a small hosted repository:

1. **Create** from blank template, uploaded archive, copied host workspace, generated project, or
   future remote git clone.
2. **Materialize** into an execution directory when a command needs a real filesystem.
3. **Execute** commands with a curated env, quotas, timeout, and optional network policy.
4. **Collect** changed files, logs, generated artifacts, and exit status.
5. **Diff** collected changes against the workspace manifest.
6. **Approve/apply** selected changes back into durable `coding_files`.
7. **Checkpoint** a manifest after meaningful milestones.
8. **Publish** outputs to canvas, board, pool, task submission, or downloadable archive.

This model keeps the browser-native coding path real. Users can create and evolve projects entirely
inside Marina without granting host filesystem access.

### 2f. Flywheel Loop

The local `h2oai-flywheel` repo is a useful implementation reference for the execution/event side of
this system. Its shape is close to what Marina needs:

- A `SandboxService` interface with multiple backends (`docker`, `local_sandbox`,
  `local_container`, `e2b`) and a common `Sandbox` / `SandboxedProcess` contract.
- Sandboxes emit lifecycle and process events (`Start`, `Stop`, `Error`, stdout/stderr/pty data).
- An `Executor` creates or reuses a sandbox, schedules a function/process execution, streams sandbox
  events, supports child executors, and emits completion/error events.
- An `EventRecorder` subscribes to executor events and persists them to the DB.
- Session APIs expose create/list/get/delete, schedule function execution, and fetch session events.
- The dashboard reconstructs an execution graph from event streams and renders command/function,
  process, storage, LLM, and sandbox nodes with logs and file previews.

Marina should adapt those ideas to its universal terminal instead of copying the graph UI:

- Treat every coding-session command/tool as an execution with `execution_id`, optional
  `parent_execution_id`, `sandbox_id`, status, arguments, result, and event stream.
- Record executor events durably and render them as rich WebChat transcript cards.
- Preserve parent/child execution relationships so multiagent and delegated tool calls can be
  replayed, debugged, and scored.
- Support multiple sandbox providers behind one `WorkspaceRuntime` interface: local scratch, host
  workspace, container, remote worker, and future E2B-like provider.
- Separate session events from final results; users need live progress and post-hoc replay.
- Store generated files/logs as artifacts with previews, not just opaque stdout.

Flywheel does not appear, in the inspected local code, to be a complete replacement for Marina's
policy layer. It has authentication, API keys, sandbox ids, sandbox services, storage, websocket
tokens, and TODOs around claim verification, but the visible code does not yet provide the full
OpenShell-style policy gateway for path/network/process/secret/inference decisions. Marina should
wrap or extend Flywheel with `WorkspaceGateway` instead of assuming all policy decisions live inside
Flywheel.

On top of that executor substrate, Marina should treat coding sessions as training/evaluation data
for the civilization:

- Capture task intent, context set, agent role/model, tools used, patch size, commands run, test
  outcomes, review findings, approvals, rejections, and final result.
- Convert successful workflows into skills, pinned verification recipes, project conventions, and
  role evidence.
- Feed failures into regression tasks, benchmark cases, and policy improvements.
- Score agents on useful coding outcomes, not just tool volume.
- Use the accumulated evidence to route future coding requests to the right agent, role, model, or
  crew pattern.

This is the coding-specific version of Marina's broader memory and standing system: code work should
improve the next code work.

### 3. Agent Bridge

Implement a Marina-native coding agent role before adding more external agent compatibility.

The bridge should expose tools like:

- `workspace.read_file`
- `workspace.write_file`
- `workspace.search`
- `workspace.list`
- `workspace.diff`
- `workspace.apply_patch`
- `workspace.run`
- `workspace.checkpoint`
- `workspace.request_approval`
- `marina.note`
- `marina.recall`
- `marina.tell`
- `marina.task`
- `marina.channel`
- `marina.canvas`

The agent should still exist as a Marina entity, with a room, profile, memory, standing, tasks, and
messages. The coding session is its workbench, not its identity.

### 4. Universal Terminal Client

Extend `dashboard/src/components/WebChat.tsx` and nearby components rather than adding a separate
dashboard element:

```text
dashboard/src/components/WebChat.tsx
dashboard/src/components/coding/
  CodingSessionHeader.tsx
  CodingTranscriptItem.tsx
  CodingToolCallCard.tsx
  CodingDiffCard.tsx
  CodingApprovalCard.tsx
  CodingArtifactEmbed.tsx
  CodingSessionOverlay.tsx
  CodingSlashPalette.tsx
```

Expected behavior:

- The normal WebChat transcript remains the universal terminal.
- `code ...` and `/...` commands create, resume, drive, and inspect coding sessions.
- Coding events render as rich transcript cards when WebChat is in rich mode.
- Compact mode falls back to readable plain text for every coding event.
- Diffs, approvals, file previews, test logs, screenshots, and artifacts appear inline or in
  `StatusOverlay`-style overlays, reusing the existing overlay pattern for tasks, boards, channels,
  groups, media, and canvas.
- A focused modal, if added, is only a larger presentation of the same WebChat thread and state.

This keeps Marina's main interaction model coherent: everything remains a command in the shared
world terminal, and rich UI is a progressive enhancement of perceptions.

### 5. API And Realtime

Add REST endpoints for snapshots and WebSocket events for live state:

```text
GET  /api/coding/sessions
POST /api/coding/sessions
GET  /api/coding/sessions/:id
POST /api/coding/sessions/:id/prompt
POST /api/coding/sessions/:id/cancel
POST /api/coding/sessions/:id/approve
POST /api/coding/sessions/:id/reject
GET  /api/coding/sessions/:id/artifacts
GET  /api/coding/workspaces
POST /api/coding/workspaces
```

Dashboard/WebChat WS event types:

- `coding_session_created`
- `coding_session_updated`
- `coding_turn_start`
- `coding_text_delta`
- `coding_thinking_delta`
- `coding_tool_start`
- `coding_tool_end`
- `coding_approval_requested`
- `coding_approval_resolved`
- `coding_artifact_created`
- `coding_diff_updated`
- `coding_turn_end`

Keep these separate from generic `agent_*` events. Coding sessions can contain multiple agents and
humans, so agent identity is a field, not the stream's root identity.

## Commands And Slash Commands

Coding should work through both world commands and session-local slash commands:

- `code` is the world command. It creates, lists, resumes, links, and closes coding sessions.
- Slash commands are interpreted when a WebChat input is attached to an active coding session.
- A slash command that affects the wider world calls back into the world command substrate.

Initial commands:

- `/help` show coding commands.
- `/new [workspace]` start a session.
- `/resume [session]` switch sessions.
- `/mode plan|ask|edit|auto` set autonomy.
- `/agent spawn <role>` add a collaborator.
- `/agents` list session participants.
- `/context` show loaded files, notes, task, room, and repo instructions.
- `/add <path|selection|task|note|url>` attach context.
- `/diff` show current patch.
- `/checkpoint [label]` snapshot current state.
- `/revert <checkpoint|file>` revert proposed or applied changes.
- `/run <cmd>` request a command through workspace policy.
- `/test [cmd]` run configured verification.
- `/review` ask for review of current diff.
- `/compact` summarize long transcript into session memory.
- `/share <channel|board|pool>` publish result.
- `/handoff <agent|user>` transfer ownership.
- `/done` close out with summary, tests, artifacts, and optional chronicle/feed entry.

Do not make slash commands a separate hidden product surface. They should be discoverable through
`code help`, render in the normal WebChat transcript, and degrade to explicit `code <subcommand>`
forms for telnet, MCP, ACP, and SDK users.

## Collaboration Semantics

Coding sessions should be rooms-with-state:

- Multiple humans can watch and type into the same session.
- Agents can join as named participants.
- Ownership is explicit: one active driver, many observers/commenters.
- Approval authority is policy-based: creator, workspace owner, steward, sovereign.
- Session notes can be promoted to personal memory, shared pools, project memory, boards, or
  chronicle entries.
- A coding session can be linked to a Marina task, project, group, channel, canvas node, or bounty.

This makes "civilization of coders" concrete: code work becomes civic work. Agents gain memory and
standing from useful contributions; humans can see who did what and why; future agents can recall
decisions instead of rediscovering them.

## Safety Model

Start conservative:

- Read-only workspace mode by default.
- Plan mode before first write.
- Explicit approval for file writes, shell commands outside allowlist, network access, commits,
  pushes, PRs, secret access, dependency installs, and destructive operations.
- Workspace root containment for every file operation.
- Command timeout, output cap, and artifact-backed full logs.
- Redacted env/secret display.
- Audit every approval and tool call to `coding_event`.
- Keep generated files and patches reviewable before applying.
- Prefer worktrees or scratch copies for multi-agent parallel edits.

Marina already has rank and gate concepts. Reuse them, but add session-scoped policy so a steward can
allow one session to run `bun test` without granting broad shell authority.

## Coverage Checklist

The first implementation should deliberately cover the common coding-tool jobs users expect, even if
some start as thin wrappers over the same session substrate.

### Context And Navigation

- Detect repo metadata: root, git branch, dirty files, package manager, language, test commands, and
  nested instruction files such as `AGENTS.md`.
- Keep an explicit context set: attached files, commands run, diffs, task links, notes, web fetches,
  and selected artifacts.
- Provide `code context`, `code files`, `code search`, and `/add` so users can see and change what
  the agent is using.
- Support large-output handling: previews in transcript, full logs as artifacts, searchable history.
- Add transcript compaction that writes a session summary back into `coding_events` and, when useful,
  Marina notes or project pools.

### Editing And Review

- Show every proposed edit as a diff before application unless the session mode explicitly allows
  auto-apply.
- Support file create, edit, delete, rename, and generated artifact attach.
- Track applied vs proposed patches separately.
- Provide checkpoint/revert for entire sessions and individual files.
- Add a review pass that can inspect the current diff for bugs, tests, security, and style before
  the user accepts completion.
- Preserve formatting/import commands as separate tool calls so users can audit mechanical changes.

### Execution And Verification

- Infer and expose likely commands: typecheck, lint, format, unit test, integration test, dev server,
  build, bench.
- Let users pin verification recipes per workspace or session.
- Stream command output while preserving full logs.
- Recognize long-running servers separately from finite commands.
- Track pass/fail status per command and tie completion summaries to concrete verification.
- Capture screenshots or browser checks later, but do not block the first version on browser
  automation.

### Collaboration And Handoff

- Show session participants, active driver, observers, and pending approvals in the terminal.
- Support comments from non-driver humans without stealing turn ownership.
- Let agents split work into subtasks and link those to Marina tasks/projects.
- Record handoffs as first-class events with a summary, current diff, blockers, and next command.
- Let a reviewer agent join without receiving write authority by default.

### Permissions And Policy

- Make modes explicit: ask, plan, edit, auto.
- Gate writes, shell, network, dependency installs, destructive operations, commits, pushes, PRs, and
  secret access independently.
- Support session-scoped allow rules such as "allow `bun test` in this workspace for this session."
- Make approval prompts actionable in plain text for non-rich clients and as cards in rich WebChat.
- Log denial reasons and model retries so failed approvals do not vanish from the transcript.

### External Integrations

- Keep ACP, MCP, SDK, telnet, and WebChat behavior backed by the same session records.
- Add import/export for transcripts and artifacts.
- Treat Git operations as tools: status, diff, branch, commit, push, PR.
- Leave provider-specific conveniences behind the generic session/tool model.

### Product Feel

- Keep latency visible: queued, thinking, tool running, awaiting approval, cancelled, complete.
- Add cancel/stop at the session and command level.
- Use stable message ids so streamed coding cards update in place instead of duplicating.
- Support copy for command, output, patch, path, and final summary.
- Preserve compact text output for terminal users; rich rendering is enhancement, not a dependency.

## Pending Design Questions

These decisions should be resolved before implementation moves beyond the read-only prototype:

- **Workspace roots:** Which host paths may be attached? Environment variable, DB setting, sovereign
  command, or all three?
- **Default workspace:** When a user types `code`, should Marina attach the server repo, the user's
  scratch workspace, the current room/project workspace, or prompt for selection?
- **Userland filesystem:** Is durable browser-native coding a phase-one requirement, or can phase one
  use host workspaces plus scratch-only userland files?
- **Patch application:** Should agents edit files directly behind approval, or always create a patch
  artifact that a separate apply tool commits?
- **Worktree policy:** Should every editable host workspace session use a git worktree by default, or
  only parallel/multiagent sessions?
- **Command policy:** Should command allowlists be global, workspace-scoped, session-scoped, or
  layered? The likely answer is layered.
- **Dependency installs:** Are `bun install`, `npm install`, `pip install`, etc. allowed with user
  approval, or only in disposable worktrees/userland workspaces?
- **Long-running processes:** Should dev servers be owned by a session, an entity, or a workspace?
  They need lifecycle commands, ports, log artifacts, and cleanup.
- **Secrets:** Can coding sessions access provider/API keys, or must users explicitly bind a secret
  profile per workspace/session?
- **Remote repos:** Should Marina clone repos itself, accept uploaded zip/tar/project files, or rely
  on host workspaces first?
- **Conflict handling:** How do concurrent agents edit the same file: optimistic patch failure,
  locks, branches, or merge queues?
- **Authority transfer:** When a user hands a session to another human or agent, which permissions
  transfer and which require reapproval?

## Data Model Sketch

```sql
CREATE TABLE coding_workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  repo_url TEXT,
  branch TEXT,
  policy_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE coding_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES coding_workspaces(id),
  room_id TEXT,
  task_id TEXT,
  status TEXT NOT NULL,
  mode TEXT NOT NULL,
  active_driver TEXT,
  model TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE coding_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES coding_sessions(id),
  turn_id TEXT,
  actor TEXT,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE coding_artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES coding_sessions(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  storage_key TEXT,
  content_text TEXT,
  metadata_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE coding_approvals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES coding_sessions(id),
  requested_by TEXT NOT NULL,
  required_rank INTEGER NOT NULL DEFAULT 0,
  action_kind TEXT NOT NULL,
  action_json TEXT NOT NULL,
  status TEXT NOT NULL,
  decided_by TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
```

Use storage provider assets for large logs and screenshots; keep compact metadata and previews in
SQLite.

## ACP And External Tool Strategy

The existing ACP server should eventually route to `CodingSessionManager`, not directly to
`MarinaAgent.command(promptText)`.

Target behavior:

- `session/new` creates or attaches to a coding session.
- `session/prompt` appends a turn and streams coding events.
- ACP diff/file/terminal capabilities map onto workspace tools when advertised.
- Unsupported ACP features degrade to markdown transcript chunks.

This keeps Marina compatible with Zed, JetBrains, VS Code, Neovim, and future ACP clients, while
WebChat remains the richer native interface.

## Implementation Plan

### Near-Term Decision

Start with the smallest useful coding-agent substrate:

- Use the Marina server's current working directory as the first workspace.
- Read and write only local files under that workspace root.
- Use path confinement, explicit diffs, and approvals before writes.
- Use existing Marina WebChat as the only UI surface.
- Use existing local command execution patterns only for finite, approved commands.
- Do not introduce containers, Flywheel runtime integration, remote executors, durable userland
  filesystems, worktrees, Monaco, PR automation, or browser automation in the first cut.

This lets Marina prove the core loop first: prompt, inspect files, propose edits, show diffs, apply,
run checks, summarize, and persist the session.

### Phase 1: Local CWD Coding Loop

- Add coding tables and DB helpers.
- Add `CodingSessionManager` with create/list/get/prompt/cancel.
- Add local workspace tools for the server CWD: list, search, read, diff, propose patch, apply
  approved patch.
- Add a conservative local command runner for pinned finite checks such as `bun run typecheck`,
  `bun run lint`, and `bun run test`.
- Add `/api/coding/*` snapshot endpoints.
- Add dashboard WS events.
- Add `/code` world command that creates/opens a session and links it to the current entity.

Exit criteria: WebChat can start a coding session against the local Marina checkout, ask questions
about files, stream agent work, show proposed diffs, apply approved edits, run a basic check, and
persist the transcript.

### Phase 2: WebChat Coding MVP

- Add WebChat renderers for coding session events.
- Add a coding session header/status chip in rich mode.
- Add `StatusOverlay`-style views for session list, artifact list, and full diff/log inspection.
- Add slash palette for active coding sessions.
- Render tool calls, command logs, diffs, approvals, and context attachments inline.
- Persist active coding session id in local storage.

Exit criteria: usable Claude/Codex-style coding chat inside the dashboard, backed by Marina state.

### Phase 3: Edits, Diffs, And Approvals

- Harden write/apply-patch tools behind approval.
- Add diff artifact generation for multi-file changes.
- Add checkpoint/revert.
- Add shell command execution through workspace policy.
- Add approval cards with multiuser decision handling.

Exit criteria: an agent can propose, apply, test, and revert code changes with visible approval and
auditable logs.

### Phase 4: Multiagent Coding

- Add coding roles: planner, implementer, reviewer, tester, security reviewer, release writer.
- Add `/agent spawn` and `/handoff` inside sessions.
- Link coding sessions to tasks/projects/crews.
- Store session summaries into project pools and personal notes.

Exit criteria: multiple Marina agents can work in one coding session with clear ownership,
specialization, and shared memory.

### Phase 5: External Compatibility

- Rewire ACP through coding sessions.
- Add MCP tools for coding sessions.
- Add optional OpenAI-compatible endpoint behavior that targets coding sessions.
- Add import/export for session transcripts and artifacts.
- Flywheel executor evaluation is complete; Phase 6 owns the accepted integration path.

Exit criteria: editor clients and external agents can participate in the same coding sessions as the
WebChat terminal.

### Phase 6: Flywheel Sandboxed Execution

The earlier evaluation is complete: Flywheel is the canonical sandbox substrate, and the first
allocation boundary is one durable sandbox per Marina entity. Implementation sequence, security
invariants, project materialization, failure recovery, and exit criteria are maintained in
[Code Mode × Flywheel execution plan](./code-flywheel-execution-plan.md).

Do not implement the older Marina-direct vfkit/crosvm path or imply live coherence between host and
sandbox files. Durable entity lifecycle, explicit Code Mode routing, credential-free project
materialization, archive transfer, and managed service observation have shipped. The active milestone
is M5 production hardening in the canonical plan.

## Initial Scope Recommendation

The local CWD coding loop and explicit Flywheel target are established. Preserve both independent
paths while Phase 6 hardens the cross-product boundary.

Do not start with a Monaco editor, complete file tree, PR automation, or browser automation. The
first version should feel like a serious coding CLI: prompt, stream, read files, search, propose
diffs, request approvals, run tests, summarize, and hand off. That loop now exists. Richer editor
features and arbitrary remote filesystems remain incremental; Flywheel production readiness follows
the Phase 6 M5 gates.
