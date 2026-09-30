# MCP session model

`bun run check:model` runs the pinned [TLC 1.7.4 model checker](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4) (the latest stable release)
with Java 21. The script verifies the official JAR's SHA-256 before execution. An offline
copy can be supplied with `--jar /path/tla2tools.jar`; `--java /path/java` selects a runtime.
Logs, counterexamples and the JSON result go to `/tmp/marina-session-model` (`--output` overrides it).
CI checks the model and its negative controls on every change.

The model exhaustively explores two sessions, two requests per session, two global slots,
and two per-session slots, with arbitrary interleavings of admission, start, finish,
cancellation, queue expiry, identity rebinding, optional context delivery and shutdown
admission closure. Both sessions compete for the same bounded admission pool. A second configuration uses
one session, three requests, three global slots and two session slots, so the session
limit is exercised independently of the global limit.

| Model | Runtime correspondence |
| --- | --- |
| `Admit`, `reserved` | `McpAdmission.enter` counts queued and running calls |
| `queue`, `Start`, `Skip` | `cmdTool` waits on `session.commandTail`, then checks cancellation, age and connection identity |
| `Finish` | Handler completion retains the FIFO slot; `finally(admission.release)` releases it, including on errors |
| `Cancel` | Abort before execution skips a mutation; abort after start cannot roll back a write or release its slot early |
| `Rebind`, `bound` | A queued call captures an entity; engine connection identity must still match at start |
| `Deliver` | Optional context checks current identity after retrieval; cancellation suppresses enrichment |
| `StopAdmission` | MCP transport rejects new work when draining, before awaiting admitted calls |

Invariants check capacity, exact slot ownership, one executing request per session,
ascending execution order, authorized starts/context delivery, and no commit by a skipped
request. Every request can finish only once. Already-started writes can finish after
identity withdrawal: revocation is **not** represented as rollback.

The runner also enables four faults individually and requires the corresponding invariant
to fail: early release (`SlotsOwned`), skipped identity checks (`AuthorizedStart`), skipped
FIFO checks (`FIFO`), and ignored queued cancellation (`AuthorizedStart`). A parse/tool
failure does not count as a detected fault. Counterexample traces are retained for inspection.

This is finite-state safety verification, not an inductive proof for arbitrary queue sizes,
a TypeScript refinement proof, or a liveness guarantee for a handler that never returns.
Network delivery, database transactions, engine-level per-entity scheduling and the full
HTTP authentication protocol are outside this abstraction. Terminal states intentionally
have no enabled action, so deadlock reporting is disabled; safety invariants remain enabled.
`test/mcp-session.test.ts` and `test/command-order-property.test.ts` exercise the actual
implementation's cancellation, ordering, capacity and idempotent release behavior.
When these boundaries change, update both their implementation tests and this model.
