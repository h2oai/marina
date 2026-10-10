# Coding in Marina

A coding session in Marina lives inside a persistent world. Start with one coder and one task;
add other participants when the work calls for them. People and agents can exchange messages,
inspect recorded checks, review submitted work, and share what they learn while independent
world activity continues. Verification and approval describe specific candidates, not a promise
that every edit has already been checked or can automatically be reversed.

This guide gets you from zero to a working coding session in about five minutes, then shows the
parts that make it more than a CLI.

## Start in your project folder

Run `marina` in a project and describe a task. The default runtime is Marina's coding
agent, using your configured provider. You can also use an installed coding tool and
its existing credentials through the same terminal:

```bash
marina --agent claude
marina --agent codex
marina --agent pi
marina --agent marina --model openrouter/<model-id> --profile claude
```

Runtime and command dialect are independent: `--agent claude` runs Claude Code's native
tools; `--agent marina --profile claude` uses Marina's tools with its Claude-style command
aliases. `--model` selects a model understood by the chosen runtime. Native agents keep
their own configuration and permission systems; Marina's `--allow-exec` flags apply
only to Marina's own Code Mode commands. There is no automatic provider failover.

For the fullscreen workspace, run **`marina --tui`** (or add `--tui` to your connected
`--url … --name … --session …` invocation). It keeps the project location, active
conversation, task status and unread counts visible around the transcript and composer.
Coding remains a single session; World messages and independent agents continue alongside it.
Omit `--tui` to use the scrollback terminal described below.

At 110 columns or wider, **Coding and World appear side by side**. F6 changes which
conversation receives your input; the marked pane header and composer label identify the
destination. F7 opens Requests in the left pane while World stays visible; F8 does the same
for your panel. Incoming requests never take over your draft. Each pane retains its scroll
position, and each conversation retains its draft when focus or terminal size changes.

Use **F2** to cycle layouts, or `/layout auto`, `/layout focus`, and `/layout split` to choose
directly. Explicit split needs at least 80 columns and enough height for readable panes;
smaller windows fall back to the focused view. Resizing back restores the selected arrangement.
Unread counts track activity outside your focused conversation even when its pane is visible.
These controls only arrange views; they do not spawn workers or change coding sessions.

In the workspace, type `/` for command suggestions with descriptions. Up/Down selects;
Tab or Enter inserts the selection into your draft, and a separate Enter sends it.
Argument hints follow the selected command. Paste inserts a multiline draft without sending;
Shift+Enter (where supported) or a trailing `\` adds another line. F1 opens help, F6 switches
Coding/World, F7 opens pending requests, and F8 opens the published panel view.
PageUp/PageDown scroll the focused pane;
Alt+Up/Down or `/view older` and `/view newer` fetch another retained local page. `/view latest`
jumps back to recent output and follows new updates in the focused conversation. Ctrl+D exits
an empty composer. Each conversation retains its editor, cursor and history; cancelled
requests discard their partial answers. The workspace restores the shell on exit without
copying unsent drafts into scrollback. It requires interactive input and output; one-shot
`-p` and redirected output keep their existing stream behavior. `NO_COLOR=1` disables accents.

The first screen is short: the Marina version, the folder, the agent and its model, whether the
session is new or resumed, and a one-line hint. A missing model provider is reported only when the
server itself has none. `--verbose` adds the database, the server endpoints and the federation
address; `/status` and `/project` show the rest whenever you want them.

Inside the terminal, `/help` shows one screen of essentials and `/help all` lists every control;
Tab completes their names and the `/verify` and `/review` actions. `/quit`, `/exit` and Ctrl+D
leave. Streaming
output preserves the current draft and cursor, including wrapped lines and terminal resizing.
The prompt names the folder and what the agent is doing (`myapp · working ›`), and adds what
is waiting only when something is (`myapp · ready · 1 request · World 3 ›`); transcript labels distinguish world messages, check
receipts, results, submitted work and review. Permission details appear above a short answer
prompt. End a line with `\` to continue a task on another line.

In an interactive terminal, **Coding** is the initial view. F6 switches between Coding and
**World**, preserving each view's draft, cursor, multiline input and command history. The
prompt counts unread output in the other conversation (`World 3`, `Coding 2`). Use `/view coding` or
`/view world` when function keys are unavailable. World input uses normal Marina commands;
`/world <command>` also works from either conversation. Incoming world events and coding
output continue to arrive while you focus elsewhere.

F7 or `/view approvals` opens pending permission questions deliberately; a new question
does not replace your draft or turn a world message into an answer. `/view older` and
`/view newer` browse bounded local transcript pages. Eviction and excerpt notices identify
missing history; these pages are not a durable server transcript. Redirected output remains
one continuous plain-text stream.

For a local Git project with a Marina worker, `/task <request>` requires current candidate
verification before the worker can submit its result. Start with a small change, for example
`/task Fix the pagination boundary and add a regression test`. Early summaries remain progress;
blockers are reported explicitly. Ordinary freeform requests retain their existing behavior.

Interactive Marina sessions inspect the project at startup. `/project` repeats this inspection:
workspace and execution location, selected model, root instruction sources, Git state, and the
effective verification recipe (including a saved `default` recipe). It does not call the model,
run the recipe, install dependencies, or recruit a worker. A whitespace-only recipe is flagged;
configure meaningful checks with, for example, `/world code recipe save default typecheck then test`.
The report is an observation, not proof that a provider is reachable or permission to execute.
Connected mode inspects the server workspace; a sandbox report identifies host-only observations.

For the selected Marina session, `/status` shows the task, `/diff` shows working changes,
`/verify` starts candidate checks, and `/review` inspects the latest attempt and its evidence.
`/checks` lists recorded verification results; `/status` shows checks still in progress.
`/history` lists recent task attempts, and `/show <artifact-id>` opens a recorded artifact.
These are bounded server listings; local transcript pages are available through `/view older`.

Complete an ordinary verified task from this terminal:

```text
/project
/task Fix the pagination boundary and add a regression test
/status
/diff
/checks
/review
/review approve <attempt-id>
```

Copy the attempt ID from the review output. `/review reject <attempt-id>` rejects that submission;
`/review <attempt-id>` inspects a historical attempt. Decisions require an explicit ID and use
Marina's existing ownership checks. Approval rechecks source freshness, so a direct filesystem
edit after inspection can withhold approval. Approval records the canonical task decision; it
does not commit, merge, or push files. The prompt distinguishes approval, rejection, and explicit
unverified acceptance. Unverified acceptance remains the deliberate owner command
`/world code review accept-unverified <attempt-id> <reason>` and never marks checks as passed.

`/verify live` starts background checks in the live workspace; those results remain unbound to
an immutable candidate. For a Bun project needing dependencies, `/verify candidate dependencies:bun`
explicitly prepares the captured lockfile inside the candidate with lifecycle scripts disabled.
There is no automatic install; a project whose environment is not ready reports `not_run`. These shortcuts use the same server commands and permissions as other
interfaces. Native runtimes retain their own tools. Redirected output stays plain text.

The prompt also shows worker pauses, budget exhaustion and upstream recovery when reported
by the selected Marina worker. `/status` includes the reason; use the suggested `agent status`
command to inspect its limits. A pause is not a completed task, and switching views does not
raise budgets, resume workers or change task ownership.

Use `/world <command>` while a runtime is launching or a permission question is pending
to send a message, inspect the world, or participate in another task. World input does
not answer or dismiss a permission question, and your unfinished coding draft is kept.
Coding input stays ordered behind setup. World commands still use normal server admission:
a long synchronous command already running as your resident can delay subsequent commands.
Use `code verify start` for finite local checks that return a receipt and leave your resident
free to participate while they run.
Approval prompts require both terminal input and visible terminal output; redirected or
closed input/output never counts as consent.

```text
/agents
/spawn codex reviewer
/use reviewer
Review the current implementation; send your findings to the other participant through Marina.
/use claude
/world task list
/dashboard
```

`/use` switches to a launched agent or starts an installed runtime. The first native
worker uses your project folder. Additional workers use isolated Git worktrees starting
at committed HEAD; uncommitted source edits are **not copied**. `/spawn` always requests
a worktree and reports an error if it cannot create one. Agent output is labeled in the
terminal and recorded through Marina's existing participant routing. There is no fixed
three-agent limit. `/agents` lists this terminal's managed roster; independently joined
participants remain discoverable through `marina route` and the browser Streams view.

`/dashboard` opens an authenticated Streams workspace with output replay, agent controls,
permissions and delivery history, without reconnecting the terminal's chat session.
The browser consumes the credential from the URL fragment into tab storage and removes
the fragment immediately. “Disconnect this view” clears that tab's credential. The
normal dashboard remains available at the printed Dashboard URL.

Use `/stop` or Ctrl+C to interrupt the selected worker. A second Ctrl+C or `/quit` stops
all native processes owned by this terminal and closes its local Marina. Worktrees and
the output journal remain available for inspection. Restarting preserves history but
does **not** replay uncertain work or resume a native process automatically. Run `/agents` to
restore the recorded roster, inspect its history and workspace, then `/resume <exact-name-or-id>`
to reconnect a stopped Codex or pi session. Recovery preserves its directory and model, refuses
missing or changed identities, and sends no prior task again. The dashboard Streams controls offer
the same action. Claude managed resume remains unavailable until its SDK can confirm the resumed
identity before input; recover those conversations in Claude itself.

### Complete names from your current work

After `/world code files [directory]`, Tab suggests the displayed paths for
`/world code read <path>` and `code read <path>` in the World pane. `/checks` and
`/history` populate `/show <artifact>` and `/review <attempt>` hints. Observed native
participants appear under `/use` and supported disconnected sessions under `/resume`.
Both terminal renderers use these same local hints; the TUI shows a dropdown.

Suggestions only edit the draft. They do not scan the filesystem, fetch more data, run a
command or approve work. File and artifact hints clear when you switch coding sessions;
approval answers have no command completion. Refresh a listing if its contents changed.

### Keep a Coding desk beside your work

In the dashboard, select an existing session in **Work** to open a personal desk. Its repository may be Marina itself or any external project. To publish a shared desk, choose **Workspace → Canvas → Published panels → Create coding desk**.
Select an existing Marina coding session; optionally attach a task and a visible participant.
**Publish and open desk** opens its activity, artifacts, recorded verification, request composer
and world feed beside Chat. Each coding request is reviewed and targets that exact session,
without changing Chat's selected session. Native agents can be followed through participant
resources and Streams; a native participant ID is not a Marina coding session ID.

The same publication is usable from the coding terminal:

```text
/panel list
/panel desk
/panel views
/panel publish <canvas-id>
/view panel
```

`/panel desk [session-id]` opens a personal view of the current or explicit session without
publishing it. `/panel publish <canvas-id> [session-id]` explicitly publishes a shared desk;
`/panel list` supplies canvas IDs. Open a publication with `/panel open <canvas-id> <node-id>`.
Up to four open views keep independent drafts and captured reviews. `/panel use <number>` or
Alt+Left / Alt+Right in the TUI panel form switches views; `/panel close` closes only the current view.

In `--tui`, F8 focuses the panel. Tab/Shift+Tab selects fields and buttons; type into a field,
use Space for a checkbox, and Enter to review an action. Review starts on **Cancel**; select
**Confirm** to submit, or Escape to dismiss it. Scrollback mode uses `/panel field`,
`/panel act` and `/panel confirm`; see [Published panels](published-panels.md#terminal).

Live updates, view switching and reconnects preserve drafts within the open application.
Closing a panel only closes that view; it never stops the worker. Saved browser layouts restore
references and geometry, not unsent drafts across reloads. Terminal exit still follows the
process ownership rules above. Other conversations remain active throughout.

### Remember and share a harness

```text
/harness save daily
/harness list
/harness export
```

Saving makes this runtime/model/dialect selection the default for subsequent bare
`marina` launches in the same folder. Preferences live beside the folder's database in
`~/.marina/projects/<slug>/harnesses.json`. Explicit `--agent` overrides the saved default.
Export prints a portable, versioned JSON definition, for example:

```json
{"version":1,"agent":"marina","model":"openrouter/<model-id>","profile":"claude"}
```

Save that JSON to a file and use `marina --harness ./daily.json`, or select a personal
definition with `marina --harness daily`. `/harness use <name-or-path>` selects one inside
the terminal. Harness definitions in a repository are never loaded implicitly. These definitions
select a runtime, model and dialect; they do not yet package teams, Scores, roles,
credentials or approval policies. Changing a bound Marina worker's model takes effect
between tasks; stop or finish active work first.

Native runtimes also support `marina --agent codex -p "<task>"`. Exit 0 means the native
turn finished without a reported error, not that Marina verified or approved its work.
Missing terminal input denies native permission requests. Marina-native tasks retain
the canonical task/submission/review workflow described below.

## Project instructions

Marina workers receive `CLAUDE.md`, `AGENTS.md` and `.marina.md` from the effective workspace
root when assigned work. `code files <directory>` and `code read <path>` refresh instructions
along that path, from the root to the inspected directory. Deeper instructions apply within
their subtree; same-directory documents retain their stated precedence. Workers are prompted
to inspect a path before editing it. This is guidance, not an additional write permission gate.

Each delivery identifies its sources, scope, loaded byte count and any omissions or read
errors. Assignment artifacts and inspection events record source metadata and SHA-256 hashes
of the raw source excerpts. Automatic loading is bounded to 4 KiB per file, 16 KiB in total and
32 directory levels. Read truncated or omitted files explicitly before relying on them.
Instructions are refreshed from disk on inspection, so subsequent edits can change the
guidance. Symlinks and nonregular instruction files are refused.

For internal workers, exact repeated instruction excerpts are represented once in the retained
conversation. Later reads keep a reference and their original source details. If compaction
removes the full copy, a surviving reference restores it; changed or differently scoped rules
are delivered in full. Raw inspections and the durable journal remain available. This avoids
paying to resend the same conventions on every file read without treating old delivery as proof
that the model still has them.

Use `code search <query> path:<relative-path>` to limit a search to one file or directory.
The `marina_code` and typed search tools expose the same `path` field.
For a path with spaces, use `code search path:"src/my folder" -- <query>`. Use `--` before a query
that contains a literal modifier, for example `code search path:src -- path:literal`.

Worktree sessions use the worktree's instructions. Sandbox sessions report that host
instructions were not loaded; inspect the actual execution workspace. Repository instructions
never grant execution permission. Native external runtimes keep their own instruction loaders.

## Code inside an existing world

Use connected coding when your Marina already contains conversations, agents and ongoing
work. Authenticate as your own resident, select a workspace configured on that server,
and create or find your session:

```bash
marina connect Owner --url ws://localhost:3300
```

```text
code workspace use /srv/projects/my-project
code start Repair the application
code list
```

Note the session ID, then disconnect that terminal with Ctrl+D. Attach the coding terminal:

```bash
marina --url ws://localhost:3300 --name Owner --session code_<id>
```

This reconnects the same resident using its cached credential for that server; an explicit
`MARINA_TOKEN` also works. An invalid credential or inaccessible session is refused. It
does not create a replacement identity or world. Reconnection rotates and privately saves
the credential, including when a later session check refuses the attach. A resident can
have one controlling connection: disconnect its existing chat/CLI before attaching.

Describe a task in ordinary language. The server's coding agent uses the session's existing
model, dialect, permissions and workspace. The printed **Server workspace** path belongs
to that server; files on your terminal's machine are not synchronized. Configure provider
credentials and allowed workspace roots on the server. Task dispatch still requires
`code.exec`, and launching a new worker requires `agent.spawn`.

```text
Fix the failing parser test, run the checks, and summarize the changes.
/world tell Reviewer I am working on the parser
/world channel send project Verification is running
/world task list
verify start
```

World messages and worker output continue while you work. `/world` uses normal command
admission; background verification releases the command slot while finite checks run.
Closing with `/quit` or Ctrl+D disconnects this view and leaves the world, agents and tasks
running. `/stop` explicitly interrupts the selected coding worker. Reattaching restores
its output stream and task indicator without replaying work. After a network failure,
inspect `status`, `history` and `artifacts` before retrying an uncertain command.

Automatic recruitment only considers idle coding agents without a goal, focus, pending
perceptions, task claim, active coding run or crew membership. An existing bound worker
continues to receive its session's steering; other autonomous workers keep their work.
Additional workers remain an explicit or permission-gated choice.

Connected coding currently supports Marina's server-side worker in an interactive terminal.
Local native runtimes (`/use codex`, `/spawn claude`, etc.) require a separate workspace
bridge and are refused here. Use the folder launcher for those runtimes. Simultaneous
controlling views of one resident and connected one-shot mode are not yet supported.

## Address a session without selecting it

SDK clients can direct an operation to an existing coding session without changing the
resident's selected session, modal input mode, or saved coding context:

```ts
await client.command("code status", { codingTarget: { sessionId } });
await client.command("code observe reproduced the failure", {
  codingTarget: { sessionId, runId },
  signal: controller.signal,
});
```

`sessionId` is required. The caller must be the session creator or its bound coding agent,
matching `code resume` authority; holding its writer lock alone does not grant access.
Existing write locks, competence gates, workspace boundaries and transport restrictions
still apply. An optional `runId` is an execution precondition: it must still identify that
session's active attempt when the command starts. It is not a historical query selector.
A rejected or uncertain request must be inspected before retrying.

Targeting currently supports session inspection (`status`, `history`, `artifacts`, `show`,
`thread`, `patches`, `review`), owner dispatch (`do`, `assign`), evidence
(`plan`, `decision`, `observe`, `summary`, `blocked`), and workspace
operations (`files`, `read`, `search`, `diff`, `patch`, `propose`, `apply`, `reject`, `edit`,
`write`, `checkpoint`, `revert`, `verify`, `run`, `test`, `lint`, `typecheck`, `build`,
`dashboard:build`, `recipe`). Use explicit `code …` input. Conflicting session IDs, selection changes,
settings, separate recruitment/lifecycle operations, macros and room overrides are refused when
a target is supplied. Commands without a target keep their existing behavior.

The WebSocket envelope carries `coding_target: { sessionId, runId? }`; successful login
and authentication advertise `codingTargetProtocol: "session-run-v1"`. The SDK refuses
to send a targeted command if that support is absent, even on a server that supports
correlated command completion. Gate challenges and held shell-execution approvals retain
the target for replay through the normal bounded command queue. A shell approval for one
execution cannot authorize another request or survive a stale/rejected replay. Explicit
session-wide shell approvals retain their broader scope. Late results and approval audit
records retain the attempt captured when execution began; replay output arrives as a world
event, separate from the command that granted approval.
`code exec-mode off` revokes pending shell approvals and enforces allowlist-only execution,
including under the local profile. Session exec-mode overrides last until server restart.

This adds addressing to the existing command path. Commands from one participant still
execute in FIFO order; it does not add a second execution lane or change world lifetime.
Other participants and incoming world perceptions remain independent.

## First autonomous fix (copy and paste)

This path uses a disposable, intentionally broken TypeScript project included with Marina. It is
the shortest way to see the coding agent inspect code, change it, run checks, and report evidence
without risking one of your repositories.

### 1. Prepare the demo

From the Marina repository root:

```bash
rm -rf /tmp/marina-coding-agent-demo
cp -R examples/coding-agent-demo /tmp/marina-coding-agent-demo
cd /tmp/marina-coding-agent-demo
bun install
git init
git add .
git -c user.name="Marina Demo" -c user.email="demo@localhost" commit -m "demo baseline"
bun test
```

The last command should fail. That failure is the agent's starting point.

### 2. Provide one model key

The folder-scoped launcher uses provider keys from the shell that starts it. Choose one provider;
do not paste a real key into a command you intend to save or share:

```bash
export ANTHROPIC_API_KEY="your-key-here"
# Automatic model selection also supports OPENAI_API_KEY, GEMINI_API_KEY,
# GROQ_API_KEY, and OPENROUTER_API_KEY.
```

For another provider or a local model, also export an explicit routable model such as
`MARINA_DEFAULT_MODEL=provider/model-id`; see [Configuration](configuration.md). A key previously
saved in a different Marina database is not copied into this disposable folder-scoped session.

### 3. Launch Marina against only that folder

Return to the Marina repository and pass the demo path explicitly:

```bash
cd /path/to/marina
bun run code /tmp/marina-coding-agent-demo
```

Wait for the `»` prompt, then paste this task exactly:

```text
Fix the percentage-discount bug. Treat percent as a value from 0 through 100, reject invalid cents or percent inputs, add regression tests for boundaries and invalid inputs, then run the test and typecheck scripts. Do not change dependencies.
```

Marina creates a temporary local world, binds one coding agent to the demo directory, and streams
its progress. The expected lifecycle is `received → inspect → plan → patch → apply → verify →
complete`. The agent may phrase its messages differently, but a completion must identify changed
paths and successful checks. It must not claim success from a proposed patch alone.

### 4. Inspect or steer while it works

At the same `»` prompt, these are safe to paste:

```text
status
diff
show last patch
focus on input validation before changing anything else
```

Because this launcher is already in Code Mode, omit the `code` prefix. A plain sentence is steering
or a new task; `status`, `diff`, and `show` are commands. Use `Ctrl-C` to stop the launcher. The
session's database persists per folder (see below), so relaunching resumes where you left off;
edits in the demo folder remain available to inspect. Pass `--fresh` for the old throwaway
behavior.

### 5. Verify independently

Do not rely only on the agent's summary:

```bash
cd /tmp/marina-coding-agent-demo
bun test
bun run typecheck
git diff --no-index \
  /path/to/marina/examples/coding-agent-demo \
  /tmp/marina-coding-agent-demo || true
```

Both checks should pass. The diff should show changes limited to the copied demo. Delete the copy
when finished:

```bash
rm -rf /tmp/marina-coding-agent-demo
```

### If it does not start

- **“No model provider is configured”:** the server found no provider key. Put one in the Marina
  repository's `.env` (or run `marina init`), or export it in the same shell, then relaunch. A
  native agent (`/use claude`, `/use codex`, `/use pi`) needs no Marina key.
- **Server timeout:** run `bun install` in the Marina repository, confirm Bun is at least 1.4.2, and
  retry.
- **Stale project database:** a per-folder DB written by an older Marina version can block boot.
  The failure hint prints the exact path (`~/.marina/projects/<slug>/marina.db`) — remove it, or
  relaunch with `--fresh` to use a throwaway DB.
- **Agent cannot run checks:** use the folder-scoped launcher above; it boots `coder` as the local
  operator. In a shared Marina, `code.exec` remains safety-gated.
- **Wrong files appear:** exit immediately and relaunch with the explicit absolute demo path. The
  first screen names the folder (`--verbose` prints its full path); `/status` shows the workspace
  Marina is confined to. Verify it before sending the task.

Once this works, replace the demo path with a clean branch or disposable worktree of your own
project. Keep the task bounded and name the checks that define completion.

> **Where it runs today:** every coding session has an explicit execution target. The default is a
> real host workspace behind a safe allowlist (`bun` scripts such as
> `test`/`lint`/`typecheck`/`build`, plus a constrained `git` subset). When the operator configures
> Flywheel, an entity can create one durable isolated sandbox, materialize guest projects, run open
> finite commands there, and manage guest services. Selection is per session and never falls back
> silently to the host. See [Optional isolated execution with Flywheel](#optional-isolated-execution-with-flywheel).
>
> **Running or applying code is an earned capability.** Reading, searching, diffing, and *proposing*
> patches are open to everyone, but `code run`/`verify`/`test` and `code apply`/`revert` require the
> `code.exec` safety gate (low bar — standing 5; operators are granted it) so a freshly-spawned,
> untrusted agent can't execute arbitrary host code. If `code run` is refused, you haven't earned
> `code.exec` yet — three paths: contribute a little to raise standing, run
> `witness request code.exec` so a qualified holder can supervise or attest a demonstration, or
> have an operator grant it. Under `MARINA_AUTONOMY=earned` supervised attempts run freely pending
> attestation; under `open` this gate auto-passes (only the destructive core stays gated).

## TL;DR — just talk to it (like Codex / Claude Code / Cursor)

**Zero-config, in any folder** — boots a folder-scoped Marina and drops
you straight into agentic Code Mode (needs an LLM provider key in your env):

```bash
bun run code            # the current directory
bun run code ~/projects/acme   # …or any directory
# It evaluates the directory, then you say what you want, in plain English:
» fix the off-by-one in the tokenizer and add a regression test
```

**Sessions persist per folder.** Each directory gets its own Marina database at
`~/.marina/projects/<slug>/marina.db` (slug = folder basename + a short hash of the absolute
path), so sessions, artifacts, and agent memory accrete across launches — relaunching in the same
folder prints `Resuming session <id> — started <age>, workspace <path>` and picks up where the
last run left off. Pass `--fresh` (or set `MARINA_CODE_FRESH=1`) for the old behavior: a
throwaway database, deleted on exit. Only the ephemeral DB is ever deleted; the per-folder one is
yours to keep or remove.

**One-shot mode** (`marina -p "<task>" [dir]`, alias `--print`) dispatches a single task
non-interactively: it boots (persistent DB by default, so `-p` runs accrete history), streams the
agent's work as usual, then waits for the structured completion signal. On completion it prints
the session diff and the agent's summary and exits `0`; if the run fails (the agent dies mid-task
or is stopped) it exits `1`; if nothing terminal arrives within `MARINA_CODE_TASK_TIMEOUT_MS`
(default 600000 ms) it sends `code stop` and exits `2` — script-friendly for CI and cron.

```bash
marina -p "fix the off-by-one in the tokenizer and add a regression test" ~/projects/acme
echo $?   # 0 completed · 1 failed · 2 timed out
```

Or inside an already-running Marina:

```bash
bun run start
bun run scripts/connect.ts coder

# Enter Code Mode — it evaluates the current directory and waits for a task:
code
# Then say what you want, in plain English:
fix the off-by-one in the tokenizer and add a regression test
```

Entering `code` binds a **coding agent** to your workspace. Type a natural-language
task and it works autonomously — explores the repo, edits via reviewable patches,
runs the test/lint chain, and iterates — streaming its progress back. Type again to
steer it; `code status` to watch. This is the **single-agent driver** (the default).

The default coding agent follows an observable operating contract: **received → inspect → plan →
patch → apply → verify → submit → review**. Dispatch through the single-agent driver or `code assign`
creates a canonical Marina task and a durable attempt artifact. Follow-up instructions steer the
same active attempt. Its tool events, changes, checks and summary carry the attempt and task IDs.
A worker can hold one active coding attempt at a time.

`code summary` submits the worker's task after storing its summary. Calling the tool or writing
an operator note does not complete the task. Candidate verification is reported as passed,
failed, missing, stale or unavailable. Submission and `code review` read actual included source
bytes, so edits made outside Marina also make evidence stale. Live-workspace checks are reported
as **unbound**: their output remains useful, but does not certify an immutable candidate. Only
task review marks the canonical task completed:

```text
code review                  # inspect the latest attempt, summary and verification
code review approve          # accept its submitted task (task creator only)
code review reject           # return its task to open work
code review <attempt-id>      # inspect an older attempt
```

The dashboard renders the same task/evidence links and review actions. Ordinary `task info`,
`task approve` and `task reject` still operate on the same task. A one-shot exit `0` means the
worker stored and submitted its result; it does not mean the operator approved it or that every
check passed. Check the reported verification and review evidence before accepting changes.
`code review approve` withholds approval of candidate-bound work unless its checks still pass
for the observed source. Inspect stale work and reverify in a new attempt. Ordinary `task approve`
remains a manual task decision; it does not refresh evidence or mark changed source verified.
Freshness is an observation at the displayed time, not a continuous lock on external writers.

For a task that must have current candidate evidence before submission, use:

```text
/task Fix the pagination boundary and add a regression test
# Equivalent world commands:
code do verification:candidate -- Fix the pagination boundary and add a regression test
code assign alice verification:candidate -- Fix the pagination boundary
```

`/task` applies to Marina workers in local Git workspaces with the single-agent driver.
Ordinary freeform dispatch retains its existing behavior. The owner sets the requirement
when the attempt begins; steering preserves it. An early summary is saved as progress,
keeps the same task active, and returns the missing step. Pending, failed, stale, unavailable,
or live-workspace checks cannot satisfy the requirement. The worker inspects the candidate
receipt/result, resolves failures, and submits another summary. The terminal shows server
states: verification required, checks running, needs attention, or ready for review. Source
freshness is reassessed at status, submission, and review; readiness is an observation.
The configured check recipe determines what is tested: a whitespace-only fallback does not
establish functional correctness. Use a project test recipe for a meaningful completion check.

Workers keep the completion requirement and a link to the full task artifact ahead of any
abbreviated task reminder. Finish source and regression-test edits before verification;
background completion reports the observed candidate state, and any later edit requires fresh
checks. Coding note tools use single-line `text`; exact replacements use `edit` with
`oldText`/`newText`, while a new file uses `write` with `content`.

If work cannot proceed, `code blocked <reason>` saves a handoff, interrupts this attempt,
and releases its claim. It preserves edits and evidence. Configured worker budgets still apply;
this requirement adds no retry scheduler or automatic dependency installation. An active task
continues until it submits, reports a blocker, reaches its configured limits, or is stopped.
An owner can deliberately accept a saved worker summary with
`code review accept-unverified <attempt-id> <reason>`. This records who accepted the risk and
why; it never changes missing or failed verification to passed. Normal approval still requires
current evidence for a candidate-required task. World communication and other agents continue
while background checks run.

`code stop` retains changes and ends the attempt as cancelled. Worker death records failure.
On server restart, unfinished attempts become interrupted and their claims are released;
Marina does not replay uncertain host actions. Inspect `code review` and artifacts before retrying.
Closing a coding session with `code done` requires its active task to be submitted or stopped.
The existing crew driver remains available; this task-attempt lifecycle currently covers the
single Marina worker and explicit assignment paths.

Want a team instead of one agent? `code driver crew` (or `code crew <goal>`) fans the
work out to an implementer / reviewer / tester. The driver is a seam — single today,
multi-agent / multi-backend as it grows.

### The manual loop is still there
Every step the agent takes is a command you can drive yourself:

```bash
code start Fix the parser     # open a coding session
code doctor                   # check the workspace is ready
code files                    # look around
code read src/parser.ts       # read a file
code run test                 # run the test suite (allowlisted)
code patch Fix off-by-one     # propose a diff (paste it on the next line)
code apply last patch         # apply the proposed patch
code checkpoint before-refactor  # snapshot you can revert to
code done Fixed the parser    # close the session with a summary
```

That's the whole loop. Everything below is detail and the good parts.

## Your first session (5-minute walkthrough)

**1. Connect.** Any surface works — the dashboard at `http://localhost:3300`, the compact web chat
at `http://localhost:3300/chat`,
telnet, the SDK, or the `marina` CLI:

```bash
bun run scripts/connect.ts coder
```

**2. Start a session.** Code Mode opens against your workspace:

```
> code start Fix the parser
Coding session started: code_8f3a1c2b-7de
Title: Fix the parser
Workspace: /home/you/projects/acme
Try: code files | code search <query> | code read <path> | code diff
```

(Tip: bare `code` enters Code Mode, where you can drop the prefix — `files`, `read <path>`,
`run test`, `exit`. The explicit `code <verb>` form always works too.)

**3. Check readiness.** `code doctor` tells you exactly what's available and what to fix:

```
> code doctor
Workspace: /home/you/projects/acme  (git repo, clean)
git: ok   ripgrep: ok   package manager: bun
Verification: typecheck, lint, test detected
Ready.
```

**4. Explore.** Read-only and fast:

```
> code files src
> code read src/parser.ts
> code search off by one
> code diff
```

**5. Run a check.** In the default local target, allowlisted commands run in the host workspace. In
an explicitly selected Flywheel target, finite guest commands run in the active sandbox project.
Either way, normalized output and execution evidence are stored on the session:

```
> code run test
$ bun test
 412 pass  0 fail
exit 0 · 8.1s
```

`code verify` runs the detected chain in one go, where the session runs (the host, or its
container runner):

1. **Prepare** for the detected project type. A probe checks that the environment has what the
   checks need (`python -m pytest --version`, `go version`, `node_modules` for a package with
   dependencies or workspace links, and so on). A JavaScript installer never runs on a Python project, and the
   reverse.
2. **Type-check**, when the project configures it and the chain does not already run it:
   `tsc --noEmit` for a `tsconfig.json`, `mypy` or `pyright` on the changed Python files.
3. **Checks and tests**: typecheck → lint → test → build for JavaScript, the project's test
   runner otherwise. Tests relevant to the change run first (see below).

Every verification ends in one of four states:

| State | Meaning |
| --- | --- |
| `passed` | the checks ran and passed |
| `failed` | the checks ran and at least one failed (a timed-out check counts as failed) |
| `not_run` | nothing could be checked: no tests were found, the runner is missing, or the environment is not ready. The reason is recorded. |
| `error` | the infrastructure failed: the container runtime could not start, or the pending diff did not apply |

`not_run` and `error` are never counted as a pass or a failure: not by task submission, not in
lessons, and not by the SWE-bench adapter's counts. A task that requires candidate verification
stays active on `not_run`; report it with `code blocked <reason>`, or the owner may accept the
work unverified.

Changing source or tests invalidates earlier candidate verification. The submission feedback
includes a retry command preserving the recorded verification options; finish your edits,
review the options, rerun checks and inspect the completed receipt before submitting again.

Options (each also has an operator default, `MARINA_CODE_VERIFY_*`):

```text
code verify scope:auto            # default: relevant tests, else the full suite
code verify scope:changed         # relevant tests only (not_run when there are none)
code verify scope:full            # the whole suite
code verify scope:changed+full budget:10m   # relevant tests, then the full suite within 10 minutes
code verify dependencies:check    # default: probe the environment, never install
code verify dependencies:none     # skip the probe
code verify dependencies:auto     # also install locked dependencies where that is isolated
code verify typecheck:off         # skip the configured type-check
```

Workspace roots require preparation even when dependencies are declared only in child
packages. `dependencies:check` still never installs; `dependencies:bun` uses the locked,
isolated candidate installer with lifecycle scripts disabled. An operator can set
`MARINA_CODE_VERIFY_DEPENDENCIES` for a deployment's normal policy; explicit command
modifiers override it. Use `none` only for checks known to need no installed dependencies.

Verification receipt IDs are artifacts, not files. Inspect them with `code show <id>`,
or `marina_code` with `action=show` and `artifactId=<id>`. A completed request displays
its linked result, including failed-check output and the full-output artifact pointer.

**Relevant tests** are the test files you changed, tests named after the files you changed
(`test_parser.py`, `parser.test.ts`, `ParserTest.java`), and tests that import them. Go runs the
packages you changed. JavaScript is scoped only when the `test` script's runner accepts file
paths (Jest, Vitest, Mocha, `bun test`, `node --test`). Rust runs the whole suite. At most 25
test targets are selected.

**Installing dependencies.** `dependencies:auto`, or the project's own manager
(`dependencies:npm`, `uv`, …), installs locked dependencies only where the install is isolated
and persists: a candidate snapshot's Bun text lockfile on the host (below), or a container runner
with `sync:mount` and `network:on` (`npm ci --ignore-scripts`, `pnpm`/`yarn`/`bun install
--frozen-lockfile --ignore-scripts`, `uv sync --frozen`). Elsewhere, a missing environment is
reported as `not_run` with the reason. A `sync:patch` runner starts every command from its image,
so the image must already hold the environment (SWE-bench instance images do).

For a local workspace, `code verify start` starts that same chain and returns a durable
`verification_request` artifact immediately. Its command completion acknowledges admission;
it does **not** mean checks passed. Continue chatting or inspecting other sessions. Completion
arrives as a later world event; `code show <receipt_id>` displays the status, any error, and
the result artifact. Target the original session when inspecting it from another session.
The existing `code verify` and `code recipe run` still wait for their results.

Background verification is bounded to four workspaces per engine, one request per real
workspace path, and at most eight commands per recipe. It accepts only the existing local
command allowlist and requires unattended `code.exec` competence (or the local trust profile).
Interactive shell approvals, supervised checks, and Flywheel checks use foreground verification.
Session access, writer authority, execution target, transport, and the current coding attempt
are rechecked before each check process starts, including after waiting for the workspace lock.
Revocation stops subsequent processes; it does not undo or cancel one already executing.

Results remain attached to the original session and attempt. `code verify` and `code verify start`
use the live workspace and existing per-command workspace lock; they are unbound checks.
Graceful shutdown drains admitted checks before closing persistence,
subject to the server's existing 30-second forced-shutdown watchdog.
After an interrupted process, unfinished receipts are marked `interrupted` with an unknown
execution outcome and are never replayed automatically. Inspect the workspace before retrying.

For immutable source evidence in a supported local Git repository, use **`code verify candidate`**.
This uses the same background admission and authority checks, with a separate source directory
and Git index. It captures actual tracked and untracked, non-ignored files into a Git tree using
an alternate index, without changing your index, staging choices, branch or HEAD. Tracked
deletions, executable modes, binary files and internal relative symlinks are represented.
Git stat caches and `assume-unchanged` flags cannot hide source edits. The Git working-tree root
must be the session root; sparse checkouts, unresolved merges, submodules, filters/LFS, encoding
or ident attributes, escaping symlinks and non-UTF-8/newline paths are refused explicitly.

The `candidate` artifact records the tree, base commit, repository, capture policy, source hash
and retained ref. Each command receipt names the candidate and temporary execution directory;
the verification artifact records commands, exit status, runtime, final source hash and freshness.
The directory is disposed after checking. If checks modify included source, Marina captures a
successor candidate and withholds evidence for it until it is separately verified. Those changes
are never copied back automatically. The fallback whitespace check compares the candidate index
with its base (`git diff --cached --check`); it is labeled `whitespace-only`, not a test suite.

Capture is bounded to 8,192 paths, 16 MiB per file and 128 MiB total. Ignored untracked files
(including `node_modules`, generated files and ignored secrets) are excluded. Included
credential-shaped files such as `.env.local`, `.npmrc` and private-key files cause refusal;
this filename rule is not a content secret scanner. External dependencies are excluded by
default. When the checks need dependencies the snapshot lacks, verification reports `not_run`.

Candidate checks run where the session runs: with a container runner, the snapshot is mounted
(`sync:mount`) or its diff applied (`sync:patch`) inside the same image, under the same allowlist,
approvals and gates. They never fall back to the host. The verification artifact records the
runner (`executionRunner`).

For a Bun project on the host, opt into preparation with:

```text
code verify candidate dependencies:auto      # or dependencies:bun
# From the terminal:
/world code verify candidate dependencies:bun
```

Marina requires a captured `bun.lock`, installs into the disposable snapshot with
`--frozen-lockfile --ignore-scripts`, and records preparation separately from checks. It uses
an isolated cache and copied packages; it never copies or links the writer's `node_modules`.
The supported dependency sources are integrity-locked public npm packages and captured
workspaces. Repository/global install settings and credentials are not inherited; custom
registries, Git/URL/file dependencies, uncaptured workspaces, unsafe patch paths and captured
`node_modules` are refused. Native packages that need install scripts may therefore fail their
checks. Preparation has a 120-second deadline and the existing background admission limits.
A preparation failure stops the check chain and produces `not_run` evidence, with an
inspectable output artifact. Successful evidence records the preparation policy and lockfile SHA-256;
generated dependencies are excluded from source freshness only inside the private copy.

The source tree does not certify the external environment, services or dependencies, and the
temporary directory is **not a security sandbox**. Host-local checks retain their existing trust
model; Flywheel remains a separate execution target with no host fallback.

Git refs under `refs/marina/candidates/` retain each snapshot and its base ancestry across Git GC.
At 64 retained candidates, further captures refuse instead of deleting review evidence. Inspect
the exact ref in `code show <candidate-id>` with `git show <ref>:<path>` or
`git diff <base-commit> <ref>`. An operator may retire a finished candidate with
`git update-ref -d <ref> <recorded-commit>` (the commit is in the artifact metadata). Retire only
after its review/evidence retention needs end; later freshness checks report retired evidence
unavailable. Refs are local Git metadata and are not pushed automatically.

Agents can use `marina_code` with `action: "verify", verificationMode: "candidate"`, or the same
optional `verificationMode` on `marina_code_verify`. The default remains live verification.
Both tools also take `dependencies` (`none`, `check`, `auto` or a manager) and `scope`; ask for
user authorization before installing dependencies.
For either background mode, inspect the receipt's result before writing the final summary.

**6. Propose a change.** You (or an agent) propose a unified diff as a reviewable *patch*, rather
than editing blindly:

```
> code patch Fix off-by-one in tokenizer
diff --git a/src/parser.ts b/src/parser.ts
@@ -42,1 +42,1 @@
-  for (let i = 0; i <= tokens.length; i++) {
+  for (let i = 0; i < tokens.length; i++) {
```

Marina checks it applies cleanly and stores it as a pending patch. Apply it when you're happy:

```
> code apply last patch
Applied patch_2a9f… (1 file)
```

**7. Stay safe.** Snapshot before risky work and reverse it instantly if needed:

```
> code checkpoint before-refactor
> code revert before-refactor
```

**8. Close the loop.** Finishing a session leaves a durable trail — a summary that becomes part of
the project's memory:

```
> code done Fixed the off-by-one; added a regression test.
```

You just did a full review-grade coding loop: inspect → run → propose → review → apply →
checkpoint → summarize. Now the parts that make Marina different.

## What makes it more than a CLI

**It's persistent.** Sessions, patches, checkpoints, and summaries don't vanish when you
disconnect. `code list` shows your sessions; `code resume <id>` picks one back up; `code history`
replays what happened. Work compounds instead of restarting.

**It's multi-agent and people-native.** A human in WebChat and an autonomous agent are *peers* —
they issue the same commands. You can pull a team together:

```
> code roles                         # see suggested roles (implementer, reviewer, tester…)
> code crew Refactor the auth module # auto-assembles a crew and dispatches the goal
> code crew Refactor auth with alice,bob   # …or name the members yourself
```

When a crew shares a session, a **write lock** keeps changes coherent — one writer at a time, with
explicit handoff — so a reviewer testing the code never clobbers the implementer's work:

```
> code writer            # who currently holds the write lock
> code handoff ready for review to:alice     # hand the lock to alice (a session participant)
```

The recipient must be a session participant: the creator, the bound agent, a dispatched crew member,
or anyone who has acted in the session. Only the current holder or the creator can pass a held lock
on. An unknown `to:` recipient refuses the handoff and keeps the lock. The older spelling
`code handoff <notes> to alice` still works when `to alice` ends the notes and names a participant.
Otherwise the notes are stored as written and the lock is left alone, so a "to" in the prose never
moves it.

**Approvals are first-class, auditable artifacts.** Risky actions can be surfaced as **approvals** —
request/approve/deny artifacts that leave a visible decision trail and render as cards with
Approve/Deny buttons in the dashboard. *(Today these are advisory: they record the decision but don't
yet block the underlying action, and the requester can decide their own — enforced approvals with
separation-of-duties are on the roadmap.)* From any surface:

```
> code approvals                 # pending requests
> code approve <id>   /   code deny <id>
```

**It speaks your tool's dialect.** Coming from Claude Code, Codex, or Pi? Switch the profile and
keep your muscle memory — the vocabulary maps onto Marina's primitives:

```
> code profile use claude      # accept→apply, bash→run, compact→summary, …
> code profile help codex
```

**It remembers and teaches.** Summaries deposit into the project's shared pools; skills learned
during a session (`code skill add …`) outlive it, so the *next* agent — human or AI — starts ahead
instead of from scratch.

## The core commands

| Do this | Command |
|---|---|
| Start / resume / finish | `code start [title]` · `code resume <id>` · `code done [summary]` · `code list` |
| Look around | `code files [path]` · `code read <path>` · `code search <query> [path:<relative-path>]` · `code diff` |
| Run things | `code run <cmd>` · `code verify` · `code test` / `lint` / `typecheck` · `code recipe run <name>` |
| Change code | `code patch <title>` → `code apply last patch` · `code checkpoint [title]` · `code revert <id>` |
| Review | `code approvals` · `code approve\|deny <id>` |
| Team up | `code roles` · `code crew <goal> [with a,b]` · `code writer [agent]` · `code handoff <notes> [to:agent]` |
| Capture | `code summary <notes>` · `code skill add <name> <text>` · `code task <title>` |
| Orient | `code doctor` · `code onboard` · `code status` · `code history` |

Full reference any time: **`code help`**.

## Point it at the right workspace

By default a session uses the server's working directory. For real projects, configure roots:

```bash
# env (e.g. in docker-compose or your shell)
MARINA_CODE_ROOTS=/srv/repos/acme,/srv/repos/widgets
MARINA_CODE_DEFAULT_ROOT=/srv/repos/acme
```

Then `code workspace list`, `code workspace discover` (find likely projects), and
`code workspace use <path>` choose where new sessions open. `code doctor` confirms git + ripgrep
are present (they power `diff`/`checkpoint`/`revert` and fast `search`).

### The project's own test runner

`code test`, `code verify` and `code recipe run detected` follow the project's language rather
than assuming JavaScript. Detection reads root markers (`pyproject.toml`, `setup.py`, `setup.cfg`,
`tox.ini`, `pytest.ini`, `manage.py`, `tests/runtests.py`, `Cargo.toml`, `go.mod`, `pom.xml`,
`build.gradle`, `package.json`) and prefers the language of the files you changed, so a Python
repository that also carries a `package.json` for tooling is tested with its Python runner.
Lockfiles name the dependency manager (`bun.lock`, `pnpm-lock.yaml`, `yarn.lock`,
`package-lock.json`, `uv.lock`, `poetry.lock`):

| Project | Runner |
| --- | --- |
| Django's own repository (`tests/runtests.py`) | `python tests/runtests.py [labels]` |
| Django project (`manage.py`) | `python manage.py test [labels]` |
| Other Python | `python -m pytest [paths or node ids] [-q -x -v]` |
| Rust | `cargo test [filter]` |
| Go | `go test ./... [-count=N -short -v]` |
| Java (Maven / Gradle) | `mvn -B -q test [-Dtest=Class,…]` / `gradle test -q [--tests Class]` |
| JavaScript / TypeScript | the `typecheck` / `lint` / `test` / `build` package scripts, run with the lockfile's manager (`bun run`, `npm run`, `pnpm run`, `yarn run`) |

These join the `code run` allowlist only in those fixed shapes: relative selectors that stay
inside the workspace and a few inert flags, never an arbitrary script or interpreter. `code doctor`
shows the detected runner and why. A saved `default` recipe (`code recipe save default …`)
overrides detection for a workspace.

### Run commands in a container image

`code workspace runner container image:<ref>` keeps the session's files on the host but runs its
finite commands (tests, scripts, `code verify`) inside a container image: a project's CI image, a
language toolchain, or a benchmark environment. Podman or Docker is required.

```text
code workspace runner                                   # where commands run now
code workspace runner container image:python:3.12 workdir:/work
code workspace runner container image:<ref> sync:patch workdir:/testbed shell:bash
code workspace runner local                             # back to the host (if the operator allows)
```

- **`sync:mount`** (default) binds the worktree at `workdir` read-write on a read-only container
  root, with the repository's `.git` bound read-only so code in the container cannot change git
  metadata that Marina's host git reads. The workspace root must be a repository root. The process
  runs as your user.
- **`sync:patch`** mounts nothing from the host. The image already holds the project at `workdir`;
  Marina applies the session's pending diff (tracked changes and new files) inside a throwaway
  container before each command.
- An environment preamble (for example activating a conda env) is operator configuration:
  `MARINA_CODE_CONTAINER_INIT`. Text after `--` is refused in-world, because a preamble would run
  outside the allowlist and approvals.

The same `code.exec` gate, allowlist and exec approvals apply as for host runs; configuring a
runner is itself gated. Choosing an image yourself, or adding `network:on`, also needs the
`code.exec.unrestricted` gate (a refusal asks your creator or an admin). All capabilities are
dropped, CPU, memory and process limits apply (`cpus:`, `memory:` in MB, `timeout:`), and every
container is removed after its command. If the runtime or image is missing, commands fail. Marina
never quietly runs them on the host instead. `code test`, `code verify` and
`code verify start|candidate` all use the session's runner; a verification dependency install runs
only in a mount-sync container with network, otherwise it is reported as not run.

Operators set the container for every local session with `MARINA_CODE_CONTAINER_IMAGE` (and
`_SYNC`, `_WORKDIR`, `_INIT`, `_SHELL`, `_NETWORK`, `_RUNTIME`). That is policy, not a default:
`code workspace runner local` is refused and sessions may change only `cpus:`, `memory:` and
`timeout:`. `MARINA_CODE_CONTAINER_REQUIRED=false` makes the image a default a session may leave
for the host; `MARINA_CODE_CONTAINER_REQUIRED=true` requires a container even without an operator
image. Neither can be changed in-world.

The container runtime uses your own container setup: the images you have already pulled, your
`containers.conf`/`storage.conf` (or Docker context), and your registry logins, taken from the
server's environment at startup. The command inside the container gets none of that environment.
To keep images elsewhere with Podman, set `MARINA_CODE_CONTAINER_STORAGE` (and optionally
`MARINA_CODE_CONTAINER_RUNROOT`) to absolute paths. `code doctor` shows where images are stored
and warns if that is on tmpfs or under `/tmp`, where images would fill memory.

### Optional isolated execution with Flywheel

When the Marina server has `FLYWHEEL_TOKEN`, each entity can create one durable isolated workspace.
This is shipped functionality; “optional” means Marina and local Code Mode do not require Flywheel:

```text
code sandbox start
code sandbox use       # active session now runs finite commands in Flywheel
code project init demo # /workspace/projects/demo becomes the durable guest cwd
# or: code project clone https://github.com/example/project.git
code run bun test
code project status
code project diff      # inspect tracked changes without marking them exported
code project export    # bounded Git patch artifact for tracked work
code project export archive # complete bounded archive, including binary/untracked files
# code project import <project_archive_artifact> restored
code project delete restored confirm # refuses unexported work without `discard confirm`
code project reconcile # remove metadata belonging to a replaced sandbox
code service start web --port 3000 -- bun run dev
code service logs web
code service probe web /health
code service probes web # durable health history
code service screenshot web / # PNG evidence when Chromium is present in the image
code approval request network publish:<service-id>
# approve the returned artifact before publishing
code service publish web
code service revoke web
code service stop web
code sandbox local     # explicitly return this session to host-safe local mode
# steward operations:
code sandbox ops inventory
code sandbox ops reclaim          # dry run
code sandbox ops reclaim confirm  # recoverable idle hibernation
```

Selection is stored per coding session. Sessions default to local, configuration alone
never changes the target, and a Flywheel error never retries on the host. Use `code sandbox status`,
`hibernate`, `resume`, and `stop confirm` for lifecycle management. `code project list|diff|switch`
selects among durable guest projects and refuses to leave unexported dirty work. Public clone URLs
must be credential-free HTTPS. Patch export remains the compact tracked-work path; bounded archive
export/import preserves complete project content through Flywheel's typed byte stream, stages and
validates imports with digest, byte, expansion, member, path, and file-type limits, then atomically
promotes them. Private Git remains a broker extension. Local and guest
files are distinct and must not be treated as synchronized. Managed services run only in Flywheel,
keep durable restart recipes and bounded guest logs, and stop across hibernation until explicitly
restarted. PID plus process birth identity prevents a reused guest PID from being signaled as the
original service. Localhost HTTP probes store response status, latency, and a bounded redacted body as
verification evidence, with history available through `code service probes`. Publishing requires a
matching one-use network approval and is automatically leased (one hour by default); stop,
hibernate, explicit revoke, or lease expiry removes exposure. `code sandbox network status` reports
whether policy is provider-owned or verified. Credential-like command arguments are refused;
`code sandbox credentials` exposes only logical, secret-free binding state, and binding fails closed
until Flywheel exposes its direct-sandbox broker contract. Screenshot capture runs a guest-local
Chromium browser, transfers a size-bounded PNG, verifies its signature, and removes the guest temporary
file. It fails closed when the sandbox image has no supported Chromium binary.

## Try it now

A runnable, narrated session lives in [`examples/coding-quickstart/`](../../examples/coding-quickstart/) —
copy-paste or run the script to watch the whole loop end to end.

## Where to go next

- [Commands Quick Reference](commands.md) — every Marina command by category
- [Agent Development](agent-development.md) — drive coding sessions from the TypeScript SDK
- [Coordination](coordination.md) — crews, roles, projects, and tasks in depth
- [Connecting](connecting.md) — WebChat, WebSocket, Telnet, MCP, SDK, and the ACP editor bridge
