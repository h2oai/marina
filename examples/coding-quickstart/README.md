# Coding Quickstart — a narrated session

A runnable tour of Marina's coding loop. It opens a coding session, looks around the workspace,
runs the review-grade loop, and closes with a durable summary — all from the `marina` CLI in pipe
mode, so you can watch the whole thing scroll by.

Pairs with the guide: [docs/guides/coding.md](../../docs/guides/coding.md).

## What it shows

- A coding **session** as a persistent, resumable unit of work (not a throwaway chat).
- **Read-grade tools** — `files`, `read`, `search`, `diff` — for orienting in a repo.
- **`code doctor`** reporting workspace readiness (git, ripgrep, detected verification chain).
- A **checkpoint** you could `code revert` to, and a **summary** that becomes shared memory.

**Primitives touched:** coding sessions · workspace registry · `WorkspaceRuntime` (the local
execution/FS layer) · coding artifacts (checkpoint, summary) · the session event history.

## Prerequisites

Marina running locally (defaults to `ws://localhost:3300`):

```bash
bun run start
```

## Run it

```bash
# from the repo root
./examples/coding-quickstart/session.sh

# or pick the entity name / a different server
./examples/coding-quickstart/session.sh ada
MARINA_URL=ws://my-host:3300 ./examples/coding-quickstart/session.sh
```

The script pipes a sequence of commands to `scripts/connect.ts` (the `marina` CLI). It's
read-mostly and fast — the only things it writes are session records and a checkpoint artifact, so
it's safe to run against any repo Marina is pointed at.

## What you'll see (annotated)

```text
> code start Quickstart Tour
Coding session started: code_8f3a1c2b-7de        # a persistent session, resumable later
Title: Quickstart Tour
Workspace: /your/workspace
Try: code files | code search <query> | code read <path> | code diff

> code doctor
git: ok   ripgrep: ok   package manager: bun      # readiness + what powers diff/search
Verification: typecheck, lint, test detected
Ready.

> code files                                       # orient: list the workspace
> code read README.md                              # read a file (truncated to a safe size)
> code search marina                               # ripgrep-fast text search
> code diff                                        # current git diff (empty on a clean tree)

> code checkpoint tour-start                        # snapshot — `code revert tour-start` undoes later
Checkpoint stored: checkpoint_… (tour-start)

> code summary Explored files, read the README, searched, diffed, checkpointed.
Summary stored.                                    # becomes part of the project's memory

> code done Finished the quickstart tour.
Coding session completed.
```

## Take it further

- Run a real check: `code run test` or `code verify` (runs the detected typecheck/lint/test chain).
- Propose a change for review: `code patch <title>` then paste a unified diff, and `code apply
  last patch`. (Patches take multi-line input, so they're easier interactively than in this piped
  script.)
- Bring in a team: `code roles`, then `code crew <goal>` to auto-assemble implementer/reviewer/
  tester and dispatch the work.
- Speak your tool's dialect: `code profile use claude` (or `codex` / `pi`).

See [docs/guides/coding.md](../../docs/guides/coding.md) for the full picture.
