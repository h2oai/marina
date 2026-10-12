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

## Bundled server

### Standalone terminal executable

`bun run qualify:native` compiles `dist/marina`, copies it into a temporary directory,
and runs with only Git on `PATH`. It checks the package version; server startup, SDK
room access and graceful shutdown in the empty, default and showcase worlds; and a
real terminal folder session with `/cost`, idle `/compact` and `/quit`, initialization,
standalone `connect`, and durable memory across a folder-session restart. This gate runs
in pull-request CI without provider credentials. The compiled catalog is also checked
against all shipped world and shared-room definitions.

The executable includes the server, built-in worlds and settings catalog. Launch it with
`marina start` or `marina <project-directory>`; a separate Bun installation and Marina
checkout are not required. Git, project build tools, container runtimes, provider keys,
external coding agents and optional extensions remain prerequisites for their respective
features. Browser assets are separate: place the built `dist/dashboard` directory beside
the executable when serving the dashboard. Custom worlds are explicit local paths or
already-installed packages. The standalone gate currently qualifies Linux; other operating
systems need the same acceptance run before shipping their executable.

These checks prove startup and transport behavior, not model task quality. Run the
provider-backed coding qualification for model-dependent claims.

### Bun server bundle

`bun run build` keeps Zod as an external runtime dependency. Bun 1.4.2 can emit MCP's static
schema construction before Zod's constructors initialize when Zod is bundled alongside dynamic
imports. Loading the installed package preserves its module initialization order. Keep the
production dependencies installed beside `dist/`; the server bundle is not a standalone executable.

`bun run build:sdk && bun run qualify:server` starts the actual bundle from a temporary instance
directory, checks its web assets and settings, exercises a Node SDK command, and checks shutdown.
Build the dashboard first with `bun run dashboard:build`. The same qualification runs in pull-request
CI and in the release gate, so a successful build alone cannot qualify server startup.

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
result JSON in `benchmarks/results/memory/`. Do not cite historical pilot figures as a
result; the reporting standard and its rationale are in `benchmarks/memory/README.md`.


## Live model command acceptance

`bun run scripts/qualify-coding.ts --directory /private/run-001 --budget-usd 25
--scenarios bugfix --timeout-ms 180000 --cli-controls` exercises the real terminal
command controller, WebSocket server and native agent loop. Supply `OPENAI_API_KEY`;
missing credentials fail before any world starts. The output directory must be new
and outside the source checkout. Each invocation retains its own report, including
failures. An explicit finite allowance up to $1,000 is supported; reservation and
attempt limits still apply to every upstream call: 40 attempts per coding scenario,
or 120 for the three-phase plan/implement/continue control journey. Each phase has
the selected deadline. Raising an allowance does not
change a previously recorded result.

The journey checks a read-only proposal, model-authored regression tests, immutable
candidate verification, hidden acceptance outside the worker workspace, explicit owner
review, forced compaction, continuity of an earlier marker, and `/cost`. It uses the
existing coding qualification fixtures and grading. The actual PTY/bootstrap and
restart contracts run separately in ordinary CI. The scripted-provider version proves
routing and persistence without credentials; only provider-backed results test the
model's behavior. The core fixture excludes optional external judges and embeddings;
JEV/fallback mechanisms have their own tests and qualification.

The **Live model acceptance** workflow is manual and runs only a committed `main`
revision. Configure environment `live-model` with a main-only deployment branch rule
and any required reviewers, an environment secret `OPENAI_API_KEY`, and repository
variable `LIVE_EVIDENCE_PUBLIC_KEY` containing the evidence custodian's GPG public key.
The workflow never runs fork code or accepts an arbitrary checkout revision. Missing
credentials or the encryption recipient fail the lane rather than skip it. It does
not run on every PR or on a schedule.

Only allowlisted scalar result metadata appears in the public summary. Detailed
reports, transcripts, attempts, workspace and logs are encrypted to that public key
before artifact upload; the holder of the private key can decrypt them with
`gpg --decrypt live-evidence.tar.gz.gpg > live-evidence.tar.gz`. Archive the evidence
in the private release record before its 14-day artifact retention expires. No raw
qualification artifact is uploaded. Preserve earlier failures when a later revision
passes. Repeated fresh tasks and multiple supported providers are required before a
release reliability claim; these smoke fixtures are not leaderboard measurements.
