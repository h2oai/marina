# Reproduce a Marina benchmark

One command per published setup. It boots isolated Marina servers, runs the official evaluator for
each benchmark, files every run into a benchmark ledger, and prints a pooled, paired comparison
between arms. This page covers mechanics only. Run it yourself to see the numbers on your own
models.

```bash
bun run repro doctor                    # what you have, and the exact fix for what you don't
bun run repro list                      # setups, arms, smoke and full sizes
bun run repro hle-verified --dry-run    # the plan and estimated spend, no model calls
bun run repro hle-verified              # smoke size, 2 replicates per arm, $10 budget
```

## Setups

| setup | arms | official scoring | prerequisites |
|---|---|---|---|
| `hle-verified` | `single` (one model through Marina), `verify` (a verification crew) | HLE-Verified Gold answers, judged by a model **through Marina** | models |
| `swebench-verified` | `single` (one model patches), `verify` (patch plus reviewer) | the unmodified `swebench` harness in containers | models, podman or docker, Python `swebench` |
| `tau2` | `single` (one model as the agent), `verify` (`marina/verify:<model>[+<checker>]`); `obligations` (`marina/obligations:<model>`, only when named with `--arm`) | the unmodified τ²-bench CLI, user simulator and evaluator | models, a τ²-bench checkout |
| `futurex-backtest` | `cheap`, `verify` forecast variants | resolved FutureX questions, forecast with **date-bounded** research only | models |
| `arena-backtest` | `baseline`, `nowcast` | MIT Social Simulation Arena rounds, scored in lock order | none (keyless) |

Each arm is compared with the first arm on the same items, pooled over replicates (a two-stage
bootstrap over runs, then items). A single run is labelled "not replicated".

## Flags

| flag | meaning |
|---|---|
| `--arm a,b` | which arms to run (default: all except opt-in arms such as τ²'s `obligations`) |
| `--replicates N` | independent runs per arm (default 2); a crew arm gets a fresh server per replicate |
| `--limit N` | items per arm and replicate (default: the smoke size); the full sizes are in `repro list` |
| `--budget-usd X` | refuse to start when the estimate exceeds X (default 10); X is also a hard total, split evenly across the run's servers or SWE-bench runs |
| `--model`, `--checker`, `--judge` | the answer model, the reviewer or checker, and the judge or user simulator |
| `--domain` | τ²-bench domain (default `airline`) |
| `--split` | τ²-bench task split (`test` or `base`); runs the whole split unless `--limit` is given. `base` is the leaderboard split: every task, so `--limit` is refused with it. A re-run with the same `--run-dir` resumes an interrupted τ² run (`--auto-resume`) |
| `--effort`, `--user-effort` | τ²-bench agent and user-simulator reasoning effort (default `high` and `low`), sent in `extra_body` |
| `--retrieval-config` | τ³ `banking_knowledge` only: τ²'s knowledge-base retrieval configuration (default `alltools`, the board's reference configuration; it is shown on the board and is part of the run's configuration tag). Refused for other domains |
| `--task-ids a,b,c` | τ² only: run exactly these task ids (τ²'s `--task-ids`), for a pre-registered subset. Not with `--limit` or the board split `base`; the ids are part of the configuration tag |
| `--env-image` | SWE-bench: run the agent's tests inside each instance's environment image (full agent rather than agentless) |
| `--run-dir`, `--ledger` | where runs, servers and the ledger live (default under `~/.local/share/marina-repro/`, on disk) |
| `--dry-run` | print the plan and the estimate, then stop |

## Model tiers

The doctor reports which intelligence is reachable. Every setup runs at every tier and labels what
changed, so a single small model can still run everything:

| tier | how it is detected | what changes |
|---|---|---|
| frontier | `OPENROUTER_API_KEY`, or keys for two or more vendors | the published default models |
| single provider | one vendor key | every arm uses that provider; verification is the model checking itself, and the judge is the same model (not independent) |
| single local model | `OLLAMA_BASE_URL` or `LLAMA_BASE_URL` | the same, on `marina/default` or `--model ollama/<id>` / `llama/<id>`; the spend estimate is 0 |

## Prerequisites and their fixes

`bun run repro doctor [setup]` checks each of these and prints the fix:

- **Models:** any key above, or a local model runtime.
- **Optional data keys:** `TAVILY_API_KEY`, `ODDS_API_KEY`, `FRED_API_KEY`, `HF_TOKEN`. Results differ without them, so note which you had when comparing.
- **Container runtime** (SWE-bench): podman needs its API socket (`systemctl --user enable --now podman.socket`).
- **Podman network:** on kernels without bridge networking, set `netns = "pasta"` in `~/.config/containers/containers.conf`.
- **Sub-UID range:** a few SWE-bench images own files above 65,536 UIDs. Widen `/etc/subuid` and `/etc/subgid` (`sudo usermod --add-subuids 100000-399999 --add-subgids 100000-399999 $USER && podman system migrate`), or those instances are excluded.
- **Scratch space:** runs keep scratch under the run directory on disk. `/tmp` is often a RAM-backed tmpfs, too small for images and databases.
- **SWE-bench harness:** a Python with the `swebench` package, named by `SWEBENCH_PYTHON`.
- **τ²-bench:** a checkout with its virtualenv, named by `TAU2_HOME`.
- **τ²-bench evaluator:** `OPENAI_API_KEY` in `.env`. τ²'s NL-assertion judge calls OpenAI's `gpt-4.1` with keys from the environment; without one, those simulations end as infrastructure errors.
- **τ³ knowledge shell** (`--domain banking_knowledge` with `alltools` or `terminal_use`): τ² runs the agent's knowledge-base shell under Anthropic's sandbox-runtime, so `srt` (`@anthropic-ai/sandbox-runtime@0.0.23`, the version τ² pins), `rg`, `bwrap` and `socat` must be on `PATH`, and the τ² virtualenv needs τ²'s `knowledge` extra (`pip install -e ".[knowledge]"`). `alltools` also embeds with OpenAI (`OPENAI_API_KEY`); those embedding calls are τ²'s own and are not in Marina's spend ledger.

## What the kit does for you

These are the mechanics that otherwise trip a reproduction:

- **Server keys:** each server gets a fresh random `MODEL_API_KEYS` key, and the benchmark uses that same key. A shared "open" key is refused once keys are set, so nothing could file into the ledger. The key is never printed.
- **Judging through Marina:** graded answers are judged through a Marina server, not by calling a vendor directly.
- **Time limits:** crews get a long per-item limit, and the server's request timeout is set above it.
- **τ²-bench:** the agent and user simulator go through Marina, and τ²'s own evaluator runs as shipped. The τ² process gets the provider keys from `.env` (never printed) and no `OPENAI_BASE_URL` override. Reasoning effort travels in `extra_body`, because τ² sets LiteLLM's `drop_params`, which strips a top-level `reasoning_effort` for Marina-routed ids. The agent effort, user simulator and its effort appear in the plan's labels. A run with any infrastructure error is **invalid**: `tau2 convert --require-clean` reports the count, writes no scores, and the run never reaches the ledger.
- **Spend:** the budget is a true total. Each server's daily spend cap, and each SWE-bench run's `--max-usd`, is an even share of `--budget-usd`, rounded down, with no per-server minimum, so together they never exceed it.
- **The ledger:** results are imported into one ledger, grouped by arm, so `benchmark compare`, `leaderboard` and `replicates` work on them afterwards.

## Reading the output

```
Compare hle-verified-verify (A) vs hle-verified-single (B) on <n> shared items
  A <acc> over 2 run(s)   B <acc> over 2 run(s)
  A − B <delta>  95% [<low>, <high>]  p=<p>
```

The interval and p come from resampling both runs and items, so run-to-run noise is included.
Inspect further from any Marina pointed at the ledger:

- `benchmark compare <runA> <runB>`;
- `benchmark replicates <run>`;
- `benchmark frontier <benchmark>` (accuracy against cost per item).

Nothing is submitted to any leaderboard. Each benchmark's own guide describes its submission
process: [SWE-bench](swebench.md), [τ²-bench](tau2.md), [FutureX](futurex.md),
[Arena](arena.md), [ForecastBench](forecastbench.md), [Metaculus](metaculus.md).
