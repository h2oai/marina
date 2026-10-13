# Schedules

**When to read this:** you are changing `schedule`, the `schedules` tick job, or anything that runs an owner's command later or on a repeat. For the periodic engine jobs (retention, hygiene, standing…), see the tick scheduler in [persistence.md](persistence.md) and `src/engine/tick-jobs.ts`.

A **schedule** is an owner's own command, arranged to run later or on a repeat. It is a general world primitive, not a benchmark feature. A person can schedule a daily digest, and an agent can arrange its own follow-up an hour before a deadline. Scheduling supports long-horizon autonomy: it never replaces the agent's own judgement and never runs anything its owner could not.

## Model

| Piece | Where |
|---|---|
| Tables (migration 165) | `schedules`: owner by durable account key (`users.id`), command text, trigger JSON, catch-up policy, `max_runs`, `next_run_at`, run state. `schedule_runs` is append-only history: status, error class, clamped error text, duration. |
| Store | `src/persistence/db-schedules.ts`, `SchedulesStore` |
| Triggers (pure) | `src/schedules/trigger.ts` |
| Runner | `src/schedules/runner.ts`, the `schedules` tick job (every 10 ticks, about 10 s) |
| Command | `src/engine/commands/schedule.ts` |

**Triggers:**
- `every:<dur>`: repeating, anchored to the previous due time.
- `daily:HH:MM`: UTC.
- `at:<time>`: once.
- `before:<time> lead:<dur>`: once, `lead` before a deadline.

Times must carry a zone (`2026-10-14T13:00Z`). Next-run times are **wall-clock and durable**, so a restart or a stalled tick never shifts them. Tick phases, by contrast, count from boot.

**Missed runs** (the server was down, or a slot passed while busy) follow `catch-up`:
- `once` (default) runs one late run, then returns to the cadence.
- `none` skips to the next slot.

A `before:` run never runs after its deadline; it is recorded as `missed`.

## How a run executes

Every run is `submitCommand` + `processCommand` on the **owner's** entity, in that entity's FIFO slot, wrapped in `withCommandResponse` so the result (ok, or the first error) is captured. Rank, safety gates, challenges, spend caps, audit and quest/usage accounting are exactly those of a typed command. A schedule never grants authority.

- **Owner connected** (a person online, or a running agent): the command runs on that live entity. Its output, and a `[schedule <name>] <command>` line, reach the owner's own session.
- **Person offline:** a quiet in-process connection (`Connection.quiet`, so the room sees no connect or disconnect line) attaches to the account with `Engine.attachScheduled`, runs, and detaches.
  - No network surface reaches the attach, and it mints no session token.
  - It restores the account's **current** stored rank, so a later demotion applies.
  - It refuses a banned or non-active principal.
  - It has no loopback peer, so loopback-only host exec stays refused.
- **Agent not running:** `owner-absent`. A stopped agent's intent does not keep acting in the world; its schedules wait and alert.

**Creating a schedule needs the account's full rank.** `schedule add` refuses a session whose rank is below the account's stored rank, for example a remote passwordless login capped at 0. A capped session therefore cannot arrange runs that would later execute at the account's real rank.

Runs are detached (`engine.trackBackground`, drained on shutdown), so a slow command never delays other schedules. A schedule still running when it comes due again records `skipped-overlap`. The slot is claimed in the database before the run starts.

## Statuses, history, alerts

`ok`, `failed`, `refused` (rank or gate), `spend-cap`, `overloaded` (command admission full), `owner-absent`, `skipped-overlap`, `missed`.

The error class comes from the failure message (`rank`, `gate`, `unknown-command`, `spend-cap`, `error`), never from the command's arguments.

- **Alerts:** after `ALERT_AFTER_FAILURES` (2) consecutive non-ok runs, or at once for `owner-absent`, the runner upserts the operational alert `schedule:<id>`, and the owner sees the failure if connected. The next good run resolves it.
- **Readiness:** `schedules` reports failing schedules, and `tick-jobs` reports any periodic engine job whose last run failed (`describeTickSchedule().lastError`, previously visible only in logs). Both flow into operational alerts through the hourly sync.
- **Retention:** `schedule_runs` is kept 30 days. Schedules themselves are never pruned.

## Limits

- `MARINA_SCHEDULES=off` stores schedules but never runs them.
- `MARINA_SCHEDULES_PER_ENTITY` (default 20, `0` = unlimited) caps how many schedules one account holds.
- `MARINA_SCHEDULE_MIN_INTERVAL` (default `1m`) is the shortest repeat.

The limits are visible in the refusal message and are raised by the operator. They bound amplification (a schedule may itself add schedules) without hiding anything.

## Not yet

Phase 1 of the plan:
- **Per-run spend caps:** a run spends under the owner's normal daily and scope caps.
- **Deadline references:** `before:` takes a time, not yet a round or task id.
- **A dashboard card.**
- **A cross-owner operator view:** the readiness check names failing schedules.
