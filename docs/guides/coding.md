# Coding in Marina

Most coding agents are a solo loop: one model, one terminal, one throwaway session. **Marina
codes differently.** A coding session here lives *inside a civilization* — work persists, agents
and people collaborate as peers, every change is reviewed and reversible, and what gets learned
becomes shared memory the next session can build on.

This guide gets you from zero to a working coding session in about five minutes, then shows the
parts that make it more than a CLI.

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

- **“No provider key” or model error:** export a supported provider key in the same shell, then
  relaunch `bun run code …`.
- **Server timeout:** run `bun install` in the Marina repository, confirm Bun is at least 1.1, and
  retry.
- **Stale project database:** a per-folder DB written by an older Marina version can block boot.
  The failure hint prints the exact path (`~/.marina/projects/<slug>/marina.db`) — remove it, or
  relaunch with `--fresh` to use a throwaway DB.
- **Agent cannot run checks:** use the folder-scoped launcher above; it boots `coder` as the local
  operator. In a shared Marina, `code.exec` remains safety-gated.
- **Wrong files appear:** exit immediately and relaunch with the explicit absolute demo path. The
  startup banner prints the directory Marina is confined to; verify it before sending the task.

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
> `code.exec` yet — contribute a little first, or have an operator grant it.

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
patch → apply → verify → complete**. Each transition is persisted on the coding session and pushed
to WebChat immediately, where a causal progress rail stays synchronized with the durable artifact
view. Completion requires a summary that cites changed paths and successful checks; the agent is
instructed not to expand scope, install dependencies, or launch applications without a decision.

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
> code search "off by one"
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

`code verify` runs the whole detected chain (typecheck → lint → test → build) in one go.

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
> code handoff "ready for review" to alice   # hand the lock to alice
```

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
| Look around | `code files [path]` · `code read <path>` · `code search <query>` · `code diff` |
| Run things | `code run <cmd>` · `code verify` · `code test` / `lint` / `typecheck` · `code recipe run <name>` |
| Change code | `code patch <title>` → `code apply last patch` · `code checkpoint [title]` · `code revert <id>` |
| Review | `code approvals` · `code approve\|deny <id>` |
| Team up | `code roles` · `code crew <goal> [with a,b]` · `code writer [agent]` · `code handoff <notes> [to agent]` |
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
