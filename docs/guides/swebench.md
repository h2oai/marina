# SWE-bench

Marina's coding agent can be measured on [SWE-bench](https://www.swebench.com/) without any
benchmark-specific behavior inside Marina. `bun run swebench` is a thin adapter over the general
one-shot coding entry point (`marina -p "<task>" <dir>`, see [Coding](coding.md)):

1. **Checkout:** each instance gets a fresh repository holding the base commit and nothing else
   (see [Workspace hygiene](#workspace-hygiene)). Attempts never share a working tree and never
   touch the Marina checkout that runs them.
2. **Task:** the agent receives the issue text only (`problem_statement`). Hints, the gold patch and
   the test patch are never exported by `benchmarks/swebench/export.py`, so nothing downstream can
   read them.
3. **Work:** `marina -p` boots a folder-scoped Marina, and its coding agent edits the checkout. Host
   execution stays allowlist-only, and a non-interactive run never escalates.
4. **Patch:** the working-tree change, including new files, is collected as `model_patch`.
5. **Trajectory and cost:** the streamed session, plus the session's Marina database (every turn,
   tool call and spend row), is kept as the trajectory. Cost is the session's `spend_daily` total.
   Each session's daily spend cap is $25. With `run --max-usd X`, the run's total, including attempts
   already recorded, is capped at X instead: every attempt gets an even share of what is left as
   its session's cap (`SpendGuard.share`), and no attempt starts once X is spent.
6. **Scoring:** the official SWE-bench harness, run unmodified.
7. **Ledger:** the scored run is filed into the benchmark ledger in a replicate group, so `benchmark
   compare`, `leaderboard` and `replicates` rank it with everything else Marina has measured.

## Workspace hygiene

A full clone of an upstream repository also contains every commit made after the task's base
commit, including the fix the benchmark grades against. Other branches, tags, remotes, packed refs,
the reflog, `FETCH_HEAD` and shared object stores all reach those commits, so a solver could recover
the reference patch with `git log --all`, `git show <sha>`, `git reflog` or `git fsck`. The
workspace is built so that none of these routes exists:

- **Layout.** Repositories are mirrored once under `<data>/mirrors`, but the mirror is only ever
  fetched from. Each attempt runs `git init` in an empty directory and fetches the base commit
  alone (`--depth=1 --no-tags --no-write-fetch-head`), then detaches HEAD at it. The workspace has
  no branches, tags, remotes, alternates, reflog (`core.logAllRefUpdates=false`, and the checkout's
  `logs/` are removed), stash, `FETCH_HEAD` or `ORIG_HEAD`, and no objects beyond the base tree.
- **Same sha, same patch.** HEAD is the real base commit, so `git diff HEAD` (the collected
  `model_patch`) applies to the base exactly as the grader applies it.
- **No earlier history either.** The fetch is shallow, so commits before the base are not
  available. `git log` shows the base commit only and `git blame` attributes every line to it.
- **Fail closed.** Every prepared workspace is checked before the agent starts
  (`assertWorkspaceIsolated` in `benchmarks/swebench/adapter.ts`). The instance fails, with no
  attempt recorded, when:
  - HEAD is not the base;
  - any ref, remote, reflog entry or pointer file (`packed-refs`, `FETCH_HEAD`, `ORIG_HEAD`,
    alternates, `worktrees/`, `modules/`) exists;
  - any commit other than the base is reachable;
  - the object store holds any object not reachable from the base tree;
  - a known forbidden sha (for example a gold commit, when one is supplied) resolves.

  `file` records an instance with no recorded attempt as unresolved.
- **Environment images.** With `--env-image`, the agent's commands run in the instance's official
  image. Its `/testbed` repository is prepared by the SWE-bench image builder: later tags are
  deleted, the remote is removed, the reflog is expired and the object store is pruned. The image
  keeps the history before the base, plus one synthetic setup commit on top of it. The patch is
  still collected from the isolated host workspace described above.

## Commands

```bash
# Solver-visible fields only, written outside the repository:
python benchmarks/swebench/export.py ~/.local/share/marina-swebench/data/verified.jsonl

bun run swebench subset --n 50 --seed 7                    # seeded ids, mixed across repositories
bun run swebench run --arm single --model <model> --replicate 1
bun run swebench run --arm verify --model <model> --review-model <model2> --replicate 1
SWEBENCH_PYTHON=<venv>/bin/python bun run swebench score --arm single --replicate 1
bun run swebench file --arm single --replicate 1 --db marina.db
```

- **The `verify` arm** is the verification formation, built from the same entry point. After the
  implementer, a reviewer (usually another vendor) reads the change against the issue. It edits only
  when the change is wrong or incomplete.
- **Resuming:** `run` skips instances already recorded in the run's `attempts.jsonl`, so an
  interrupted run picks up where it stopped. It records the arm, mode and subset (`--n`/`--seed`
  or `--ids`) in `arm.json` and refuses to continue a replicate under another configuration.
- **One subset per run:** `run` and `file` read the ids `subset` wrote, so give every step the
  same `--n` and `--seed` (or `--ids`); `file` records the seed from `arm.json`. `bun run swebench
  export` writes the task fields with `SWEBENCH_PYTHON` when `<data>/verified.jsonl` is missing.
- **Re-filing is a no-op:** the ledger result is stamped with the last attempt's write, never the
  filing time, and every replicate of an arm records the same target (no replicate number or path).
- **Location:** everything is written under `--data` (default `~/.local/share/marina-swebench/data`).
- **`--env-image` (opt-in):** the agent's commands run inside the instance's official environment
  image (`swebench/sweb.eval.x86_64.<id>`, pulled or built beforehand) through Marina's general
  container runner, in patch sync at `/testbed` with the `testbed` conda env and no network. The
  agent can then run the project's existing tests while it works (a full agent run instead of
  agentless). Without the flag, runs stay agentless.
- **In-loop verification:** with `--env-image`, `code verify` and `code test` run in that same
  image, including candidate checks. Preparation follows the detected project type: for a Python
  repository it probes the image's environment (the instance image already has it) and never runs a
  JavaScript installer, even when the repository carries a `package.json` or the agent asks for
  `dependencies:bun`. Tests relevant to the change run first. Each verification ends `passed`,
  `failed`, `not_run` (nothing could be checked, with the reason) or `error` (the runtime failed).
  Each attempt in `attempts.jsonl` carries these counts (`verification`), and the filed ledger result
  sums them in `metadata.verification`. They describe the agent's process only: grading is the
  harness's alone, and a `not_run` is never counted as a failed or passed check.

## SWE-bench Pro

[SWE-bench Pro](https://huggingface.co/datasets/ScaleAI/SWE-bench_Pro) (public set, v2: 642 tasks
from 11 repositories in Go, Python, JavaScript and TypeScript) uses the same adapter with
`--benchmark pro`. Its harness is
[scaleapi/SWE-bench_Pro-os](https://github.com/scaleapi/SWE-bench_Pro-os) (MIT; task content
follows each upstream repository's license).

```bash
python benchmarks/swebench/export.py <data>/pro.jsonl ScaleAI/SWE-bench_Pro test
git clone https://github.com/scaleapi/SWE-bench_Pro-os <harness>
bun run swebench subset --benchmark pro --data <data> --n 45 --seed 7
bun run swebench run --benchmark pro --data <data> --arm single --model <model> --replicate 1
SWEBENCH_PYTHON=python3 bun run swebench score --benchmark pro --data <data> \
  --tasks <harness>/v2/tasks --arm single --replicate 1
bun run swebench file --benchmark pro --data <data> --arm single --replicate 1 --db marina.db
```

- **Task text:** a Pro task is the PR description plus its `requirements` and `interface` sections,
  as in the official task text. The exporter writes those fields and nothing else: no gold patch, no
  test patch and no test lists.
- **Grading** (ledger judge: "swebench-pro verifier (local replay of the official verifier)"): `benchmarks/swebench/pro_grade.py` runs each task's own verifier, unmodified
  (`tests/test.sh`, `run_script.sh`, `parser.py`, `config.json`), in a fresh container of the task's
  pristine image (`ghcr.io/scaleapi/swe-bench_pro-v2:<instance_id>`).
  - **Patch:** applied with the harness's patch-replay fallback chain.
  - **Task limits:** each task's timeout, CPU and memory limits are honoured.
  - **Hardening:** the container runs with `--network none` (override with `--network <mode>` only
    for a task set whose verifier must fetch), `--cap-drop ALL` plus the file-ownership and process
    capabilities a root test run needs, `no-new-privileges`, a PID limit and no swap beyond the
    memory limit. The root filesystem stays writable: the patch lands in `/app` and the verifier
    writes `/logs/verifier`, so `--read-only` cannot grade. Instance ids must be plain names (no
    path separators). The `--gold` self-check proves a task set grades under these flags.
  - **Result:** `reward.txt` decides resolved (1) or not (0).
  - **Errors:** a pull, start or missing-reward failure is an error and is excluded from the ledger;
    it is never scored 0.
  - **Why not Harbor:** this replaces Harbor's own container backends on hosts where they cannot run,
    such as rootless Podman without bridge networking. With Harbor available, its `PatchReplayAgent`
    is the reference grader.
- **Self-check before measuring:** `pro_grade.py --ids <file> --gold` must resolve every task, and
  `--empty` must resolve none.
- **The official protocol** runs the agent offline, with only the model endpoint reachable, and bars
  looking up solutions. The task text carries the harness's no-lookup constraint.

## Running the official harness with Podman

The harness talks to a Docker-compatible API. With rootless Podman:

```bash
systemctl --user start podman.socket
export DOCKER_HOST=unix:///run/user/$(id -u)/podman/podman.sock
```

If containers fail to start with `netavark: create bridge … Operation not supported`, the kernel has
no bridge support. Make pasta the default rootless network instead, in
`~/.config/containers/containers.conf`:

```toml
[containers]
netns = "pasta"
```

## Limits

- **Tests during the agent's work need `--env-image`.** A host checkout has no installed
  dependencies, so by default runs are agentless: the agent reasons from the code. With
  `--env-image`, Marina's container runner (`docs/guides/coding.md` → "Run commands in a container
  image") executes the agent's commands in the instance's environment image; the images must already
  be present (the harness builds or pulls them), and each image needs a supported test runner shape
  (`python -m pytest`, `python tests/runtests.py`, `go test`, `npm run test`, …) to be useful.
  Patch sync starts every command from the image, so verification never installs dependencies
  there: an image without the project environment yields `not_run`, not a failure.
- **No submission.** Nothing is submitted anywhere. A leaderboard submission (a pull request to
  `SWE-bench/experiments` with predictions, logs and trajectories) is a separate act that its owner
  approves.
