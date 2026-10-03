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

- **No tests during the agent's work.** The agent cannot run the project's tests, because a host
  checkout has no installed dependencies. Running them inside the instance's environment image needs
  a container-backed workspace, which Marina does not have yet (the Flywheel sandbox is the only
  isolated execution backend). Until then, runs are in the "agentless" setting: the agent reasons from
  the code.
- **No submission.** Nothing is submitted anywhere. A leaderboard submission (a pull request to
  `SWE-bench/experiments` with predictions, logs and trajectories) is a separate act that its owner
  approves.
