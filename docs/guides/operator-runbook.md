# Operator runbook

Start with `readiness`, then `readiness providers` if model-backed work is failing.
In the dashboard, open the header Health badge or Admin → Ops. Record the running
revision, affected capability, timestamps and request/trace IDs before changing settings.
See [deployment](deployment.md) for installation and [recovery](recovery.md) for backups.

## Readiness and health

| Signal | Meaning | Action |
| --- | --- | --- |
| `ok` / green | The capability's configured checks pass. Provider configuration alone does not prove upstream connectivity. | Use `readiness providers` for a live provider probe. |
| `degraded` / amber | The capability is partially available or has an unmet dependency. | Follow that check's `remediation`; inspect provider errors, agent status and spending limits. |
| `off` / dim | A capability is disabled or not configured. This can be intentional in minimal deployments. | Enable it only if the deployment needs it. |
| Red aggregate badge | No checks are healthy; inspect the individual checks. | Do not infer data corruption from the color alone. |
| `/health` returns 503 while stopping | Admission is draining. | Let outstanding work finish before restarting. |

`GET /health` is a process/world liveness check, not a test of every provider or query.
`GET /api/readiness` provides the detailed capability report through the dashboard's
normal authorization boundary. Inspect error rates and latency alongside both probes.

## Tick and command latency

`Slow room onTick(s): room=123ms` identifies a room's synchronous handler exceeding
100 ms. `Tick budget exceeded` means the overall synchronous room phase crossed
200 ms and deferred remaining rooms. An individual blocking handler cannot be
preempted by this cooperative budget. Async handlers are tracked separately, never
overlap themselves, and are drained during shutdown.

1. Correlate the named room with recent room code changes and tick-job status.
2. Remove unbounded synchronous loops and full-table work from `onTick`; bound each
   unit of work. Move slow I/O out of the synchronous phase and use supported sandboxes.
3. Validate the repaired room with `build validate <room>` and apply it with
   `build reload <room>` under the existing permissions. Observe several ticks.
4. If the event loop is unresponsive, use the process supervisor's graceful stop;
   restarting unchanged blocking code only repeats the failure.

MCP serializes actions within each session. A slow action delays that session's next
action; separate participants can interleave. Cancellation before execution removes
the action from execution, while a started mutation retains its FIFO slot until it
finishes. A disconnected client must check the operation receipt/state before retrying
a write. A timeout is not proof that a write did not commit.

## SQLite pressure and WAL

Marina uses one writer connection and one read-only connection per `MarinaDB`.
It does not have a general connection pool. More writers would still contend on
SQLite's single-writer lock; do not run multiple world processes against one database.
The entry point's database lease enforces that ownership.

Current connection settings are explicit in `src/persistence/database.ts`:

| Setting | Current value / behavior |
| --- | --- |
| Journal | WAL |
| Durability | World and standalone service default to FULL; direct `new MarinaDB()` defaults to NORMAL for explicit callers/tests |
| Writer busy timeout | 5,000 ms |
| Page cache | 64,000 KiB configured on each connection |
| Memory mapping | Up to 256 MiB on each connection |
| Temporary tables | Memory on the writer |
| Checkpoint | `checkpoint()` uses PASSIVE; startup and close use TRUNCATE |
| Auto-checkpoint | SQLite default; Marina does not override `wal_autocheckpoint` |

These are connection settings, not environment knobs. Running a PRAGMA in a separate
CLI does not retune the server connection. See SQLite's [WAL documentation](https://sqlite.org/wal.html)
for checkpoints and long-lived readers. Use local persistent storage; WAL's shared-memory
coordination is not a multi-host network-filesystem architecture.

When latency or WAL size grows, check disk space/I/O, long read transactions,
`SQLITE_BUSY`, active import/index jobs, and request volume. Reduce admission/concurrent
optional jobs first; pause the affected agents or clients while keeping inspection
available. Use narrow retrieval queries and bounded context budgets. Repeated overload
requires measured capacity limits or separate worlds/services, not extra connections
to the same writer. The service's storage quotas fail writes explicitly; it does not
silently drop writes or switch to an in-memory store.

Never delete live WAL/SHM files. Use the [verified snapshot/restore workflow](recovery.md),
not a raw copy of only the `.db` file. FULL durability remains the production default;
switching to NORMAL trades crash durability for write latency and is not an automatic
overload response. After disk-full or I/O failures, resolve storage pressure and inspect
the failed receipt before retrying; use stable idempotency keys where the API supports them.

## Reload or restart

| Change / symptom | Preferred action |
| --- | --- |
| Supported room or dynamic-command source update | Validate, then the specific `build ... reload` command |
| Role definition update | `role reload <name>` under existing gates and self-modification restrictions |
| Binary, dependency, world module, plugin list, ports or environment change | Graceful restart with the updated configuration |
| Optional provider outage | Repair provider configuration or wait for recovery; inspect readiness before restarting |
| Database errors or unresponsive event loop | Diagnose storage/blocked work first; graceful restart after remediation if needed |

SIGTERM/SIGINT stops admission, drains requests and command work, flushes agent state,
then closes persistence. Allow at least the server's 30-second shutdown deadline in the supervisor.
Do not turn shutdown errors into successful health responses.

`DB log failed: Cannot use a closed database` means a producer outlived persistence.
In tests, await adapter shutdown and command drains before `db.close()`. In production,
retain the surrounding shutdown logs and treat recurrence as a lifecycle defect rather
than hiding the warning. The shutdown integration test verifies persisted work and
rejects this warning during a real SIGTERM sequence.
