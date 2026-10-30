---
name: run-marina
description: Build, run, and drive the Marina server on an isolated port. Use when asked to start Marina, run a world command against a live instance, open or screenshot the dashboard, hit the dashboard API, smoke-test a change end to end, or run engine code in-process without a server.
---

Marina is a Bun server (WebSocket/HTTP on one port, MCP on +1, log viewer on +2) with a
built React dashboard. Drive it through `.claude/skills/run-marina/driver.mjs`: it boots an
**isolated** instance (port 3400, its own SQLite DB under `$TMPDIR/marina-run-3400`, no
provider keys), runs world commands over the WebSocket, logs into the dashboard with headless
Chromium (Playwright, no xvfb), screenshots it, and reads the dashboard REST API.

All paths are relative to the repo root.

## Prerequisites

Bun ≥ 1.4.4 (`.bun-version`; older Bun fails in ways that look like Marina bugs), Node (the
driver runs under `node`), and the Playwright Chromium that `playwright-core` expects in
`~/.cache/ms-playwright`. Check which build it wants:

```bash
bun --version
node node_modules/playwright-core/cli.js install --dry-run chromium
```

If the install location it names is empty, run the same command without `--dry-run` (it
downloads Chrome for Testing into `~/.cache/ms-playwright`).

## Setup and build

```bash
bun install                       # one root install covers every workspace member
cd dashboard && bun run build     # Vite → dist/dashboard (git-ignored; the server serves a "not built" page without it)
```

If a server is already serving `dist/dashboard`, build elsewhere and swap it in afterwards
(`bun run build -- --outDir <dir>`): Vite empties the output directory first.

## Run (agent path) — the driver

```bash
node .claude/skills/run-marina/driver.mjs smoke
```

`smoke` boots the instance (or reuses it), runs `look` over the WebSocket, logs into the
dashboard as `driver`, types `look` in Web Chat, screenshots `<run dir>/smoke.png`, and reads
`/api/ops/overview` with the session token. It prints one `ok`/`FAIL` line per check and
exits non-zero on failure. The verbs it is built from:

```bash
D=.claude/skills/run-marina/driver.mjs
node $D up                                   # boot; waits for /health; prints URLs, pid, log path
node $D status                               # /health + `marina status --port 3400`
node $D cmd "note add driver smoke test note" --wait 2   # one world command, printed, done
node $D cmd "recall smoke" --wait 2
node $D ui --cmd "look" --text 300           # dashboard login + command + screenshot (+ body text); --out <file.png>
node $D cmd readiness                        # the full capability report (what is off and why)
node $D api /api/ops/overview --limit 500    # GET with the cached session token (logs in first if none)
node $D down                                 # SIGTERM by pid (add --clean to delete the run dir and DB)
```

Knobs (env): `MARINA_RUN_PORT` (3400), `MARINA_RUN_DIR`, `MARINA_RUN_NAME` (`driver`),
`MARINA_RUN_ENV_FILE` — an env file with provider keys when the test needs agents or
model-backed commands; by default the server starts with `--no-env-file` and a minimal
environment, so nothing from the checkout `.env` leaks in.

Screenshots and the server log land in the run dir (`$TMPDIR/marina-run-3400` unless
`MARINA_RUN_DIR` is set); `up` prints the log path, and a failed `up` prints its tail.

## Direct invocation (no server)

Most PRs touch `src/engine`, `src/persistence` or a command; those need no listener. The
test fixture boots a whole engine in-process with an in-memory DB:

```bash
bun --no-env-file .claude/skills/run-marina/engine-probe.ts look "help memory"
```

It logs in as `probe`, runs each argument through `engine.processCommand`, and prints what the
connection received (`connection.messages`, ANSI stripped). Copy the pattern into a one-off
script for a specific change; the same fixture (`test/engine-fixture.ts`, always `await
dispose()`) backs the test suite. Note it runs the fixture's plain Test Room, not the seeded
Workbench world — use `up` + `cmd` for anything that depends on world seeds.

## Run (human path)

`bun run start` reads the checkout `.env` and listens on 3300–3302 (plus telnet when
`TELNET_PORT` is set) until Ctrl-C. If a Marina is already running from that checkout, this
collides with it; the driver's 3400 does not.

## Test

```bash
bun run test:fast                 # engine-free files, ~10 s
bun test test/arena-freshness.test.ts   # one file
```

## Gotchas

- **Ports follow `WS_PORT`.** MCP = `WS_PORT+1`, log viewer = `WS_PORT+2`; a second instance
  needs only `WS_PORT`. A developer's own Marina usually holds the defaults (3300–3302, and
  a telnet port) — never reuse 3300, and stop instances by pid, never `pkill -f bun`, which
  would also kill that server.
- **The checkout `.env` must not be read** by a test instance: it may set ports that collide
  with a running server, provider keys, and spend scopes. The driver launches with
  `bun --no-env-file` and an explicit minimal environment.
- **Dashboard REST is 401 until a session exists.** The local model-API key the server
  writes next to the DB is *not* a dashboard session token (it answers "Invalid or expired
  session token"). The token is minted on Web Chat login and kept in
  `localStorage.marina_chat_token`; the driver copies it to `<run dir>/token` after `ui`/`smoke`
  and `api` uses it. It dies with the process (`down` deletes it).
- **`marina status --port` shows readiness only with a session** (`MARINA_TOKEN`); without
  one it prints health and says so. `node $D cmd readiness` gives the full report.
- **No provider key ⇒ no agents.** `status` shows "LLM provider configuration: off"; `agent
  spawn` is refused and `/v1` answers 503. That is the intended default for a smoke run; pass
  `MARINA_RUN_ENV_FILE=<file with ANTHROPIC_API_KEY=…>` to test anything model-backed.
- **`connect -c` lingers** until output has been quiet for 2.5 s after the first output,
  capped by `--wait`; model-backed commands (`ask`) need a longer `--wait`.
- **Headless Chromium runs without xvfb** (`playwright-core` 1.64.1, `--disable-gpu`). The
  first dashboard load logs a burst of 401 console errors before login — expected, not a bug.
- **Login selectors:** name box placeholder `Enter your name...`, button `Connect`, then the
  command box placeholder `Type a command...`. The driver waits on the latter to know login
  finished.
- **`.gitignore` ignores `.claude/*` but re-includes `.claude/skills/`** — keep it that way;
  git cannot re-include a file under an ignored directory, so a plain `.claude/` rule would
  drop this skill from the repo.

## Troubleshooting

- `up` says `already up` but it is not your instance — something else answers
  `127.0.0.1:3400/health`; set `MARINA_RUN_PORT=3410` (every listener follows it).
- `Invalid or expired session token` from `api` after a restart — the token file outlived the
  process: `rm <run dir>/token` (or `down` next time), then `api` logs in again.
- `Activity unavailable` in the dashboard screenshot — not logged in; the name box was still
  showing. Re-run `ui`; if it persists, check `dist/dashboard` is the current build.
