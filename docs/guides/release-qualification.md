# Release qualification

Run the deterministic public-release gate from the repository root:

Install the pinned Syft scanner described in [Supply-chain verification](supply-chain.md)
before running the gate; the dependency inventory must cover every tracked Bun lockfile.

```bash
bun run qualify:release
```

It must complete TypeScript checking, Biome, all backend tests, all dashboard unit tests, the
production dashboard build, the production-browser Canvas/dashboard suite, the public documentation
site build, the CycloneDX dependency inventory, and the Bun dependency audit. A missing browser is a failed prerequisite, not a skipped
success; set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` when the environment supplies Chromium outside
Playwright.

Provider-backed prompt, autonomy, evolution, and Flywheel qualifications remain separate because
they require credentials or a live target. Run only the gates that match the claim being released:

```bash
bun run qualify:prompt
bun run qualify:autonomy
bun run qualify:evolution
bun run qualify:flywheel
```

Do not describe an unavailable or skipped live gate as passed. Preserve its output, relevant trace
IDs, artifacts, environment prerequisites (never secret values), source commit, and evidence
checkpoint with the release record. World Collective comparisons should cite the exact baseline and
candidate variant IDs and retain the promotion rationale and evidence references.

## Script knobs

These are read by the qualification scripts, not by the Marina server, so they are not in
[`config/environment.reference`](../../config/environment.reference).

| Variable | Default | Read by |
|---|---|---|
| `MARINA_QUALIFY_TIMEOUT_MS`, `MARINA_QUALIFY_POLL_MS` | `120000`, `2000` (min 500) | `qualify:autonomy`, `qualify:evolution`: overall wait and poll interval |
| `MARINA_FLYWHEEL_LIVE_REQUIRED` | `false` | `qualify:flywheel`: fail, instead of skip, when live configuration or a required check is unavailable |
| `MARINA_FLYWHEEL_LIVE_FULL` | `false` | `qualify:flywheel`: also require clone, service/probe, screenshot, publish/revoke and hibernate/resume |
| `MARINA_FLYWHEEL_LIVE_CLONE_URL` | unset | `qualify:flywheel`: credential-free public fixture repository for the full run |
| `MARINA_FLYWHEEL_LIVE_ALLOW_PUBLISH` | `false` | `qualify:flywheel`: permit temporary public exposure during the run |
| `MARINA_FLYWHEEL_EVIDENCE_DIR` | `artifacts/flywheel` | `qualify:flywheel`: where redacted evidence is written |
| `MARINA_FLYWHEEL_DEPLOYMENT_MODE` | `separate` | `qualify:flywheel`: deployment-mode label recorded in the evidence |
| `MARINA_TRIAL_MODEL`, `MARINA_TRIAL_TIMEOUT_MS` | `openai/gpt-6-luna`, `180000` | `trial:evolution`, `trial:evolution:local` |
| `CONTAINER_RUNTIME` | `docker` | `scripts/qualify-image.ts` (`podman` also works) |
| `EVAL_TIMEOUT_MS` | `120000` | `scripts/eval-prompt.ts` (`qualify:prompt`): per-case timeout |
| `MARINA_SMOKE_URL`, `MARINA_SMOKE_TOKEN` | local address, generated key | `scripts/smoke-production.ts` (see [Operations](../operations.md)) |

## Memory-delta benchmark

`bun run qualify:memory:benchmark` runs the memory-delta harness (`benchmarks/memory/genbench.ts`)
offline with the deterministic stub model and exact-match judge. It is a plumbing gate: it proves
the five arms (`bare`, `cold`, `warm`, `fullcontext`, `bm25`), the held-out seed/eval split, the
resident-path memory injection, and the result schema all work without touching the network. It
produces no evidence about any real model.

A memory *claim* in a release record needs a real-model run under the same harness
(`--model <id> --judge <id> --seeds 5` or more against a running instance), and must quote the
per-arm Wilson 95% intervals, token-F1 next to judge accuracy, tokens injected, latency, cost,
the judge prompt version, split salt, harness git sha, and `residentContextVersion` from the
result JSON in `benchmarks/results/memory/`. Do not cite the `HISTORY.md` §5 pilot figures as a
result; the reporting standard and its rationale are in `benchmarks/memory/README.md`.
