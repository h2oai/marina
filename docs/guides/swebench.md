# SWE-bench

Marina's coding agent can be measured on [SWE-bench](https://www.swebench.com/) without any
benchmark-specific behavior inside Marina. `bun run swebench` is a thin adapter over the general
one-shot coding entry point (`marina -p "<task>" <dir>`, see [Coding](coding.md)):

1. **Checkout:** each instance gets a fresh clone at its base commit. Repositories are mirrored once
   under the data directory and cloned with `--shared`, so attempts never share a working tree and
   never touch the Marina checkout that runs them.
2. **Task:** the agent receives the issue text only (`problem_statement`). Hints, the gold patch and
   the test patch are never exported by `benchmarks/swebench/export.py`, so nothing downstream can
   read them.
3. **Work:** `marina -p` boots a folder-scoped Marina, and its coding agent edits the checkout. Host
   execution stays allowlist-only, and a non-interactive run never escalates.
4. **Patch:** the working-tree change, including new files, is collected as `model_patch`.
5. **Trajectory and cost:** the streamed session, plus the session's Marina database (every turn,
   tool call and spend row), is kept as the trajectory. Cost is the session's `spend_daily` total.
6. **Scoring:** the official SWE-bench harness, run unmodified.
7. **Ledger:** the scored run is filed into the benchmark ledger in a replicate group, so `benchmark
   compare`, `leaderboard` and `replicates` rank it with everything else Marina has measured.

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
  interrupted run picks up where it stopped.
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
