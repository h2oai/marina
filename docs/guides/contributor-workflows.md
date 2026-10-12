# Tracing a Marina workflow

Start from a user's operation, follow its admission path, then locate the durable
result and the test that observes it. Every surface participates in the same world.

| Boundary and responsibility | Implementation entry points | Start with these tests |
| --- | --- | --- |
| Terminal input and presentation; no local approval authority | `scripts/marina.ts`, `scripts/code-console.ts`, `scripts/code-workflow.ts` | `marina-dispatch`, `cli-journeys`, `coding-controls-journey` |
| Transport identity, request attribution, reconnect and cancellation | `src/sdk/client.ts`, `src/net/websocket-server.ts`, `src/net/mcp-session.ts` | `sdk-legacy-compatibility`, `websocket-server`, `mcp-session` |
| Admission, FIFO execution, rank and safety gates | `src/engine/engine.ts`, `command-coordinator.ts`, `command-phase-coordinator.ts`, `safety-gates.ts` | `command-admission`, `command-phase-coordinator`, `safety-gates` |
| Coding command routing and session ownership | `src/engine/commands/code.ts`, `code/session.ts`, `code/driver.ts`, `src/coding/code-session-driver.ts` | `code-session-agent`, `coding-task-run` |
| Agent model/tool loop, context and spend | `src/agent/lean-agent-adapter.ts`, `context-manager.ts`, `src/engine/spend-ledger.ts` | `agent-manual-compaction`, `agent-spend-guard`, `agent-loop-lifecycle` |
| Durable memory, authorization and retrieval | `src/memory/world-service.ts`, `src/persistence/db-memory*.ts` | `memory-platform-wire`, `memory-portable`, `memory-canonical-upgrade` |
| Verification and attributable owner review | `src/coding/task-run.ts`, `candidate.ts`, `src/engine/commands/code/verification.ts`, `task-run.ts` | `coding-task-run`, `coding-candidate`, `coding-controls-journey` |
| Persistence, upgrade and recovery | `src/persistence/database.ts`, `schema.ts`, `db-memory-maintenance.ts` | `upgrade-compatibility`, `schema-baseline`, `memory-reliability` |

Paths without a directory in a cell are relative to the preceding directory.
Test names omit `test/` and `.test.ts`; use `rg --files test` to find related coverage.
The generated [API reference](../reference/commands.md) inventories public commands
and adapters; [CLAUDE.md](../../CLAUDE.md) defines the mandatory subsystem invariants.

For a terminal bug, first reproduce the slash command with the terminal controller
and an isolated engine. Follow the resulting `code` command through normal admission;
do not patch the UI to bypass a server refusal. For a model failure, inspect the saved
attempt, tool receipts, provider lifecycle and verification result before changing a
prompt. A success message without a canonical completion or matching candidate hash
is insufficient evidence.

Use deterministic fixtures for routing, failures and races. Use the existing coding
qualifier for model behavior, and retain failed attempts outside this public repository.
Its scripted-provider journey runs the real controller, WS ingress, agent loop, tools
and candidate checks. Native qualification tests the packaged executable separately.
See [testing](testing.md), [release qualification](release-qualification.md) and the
[public compatibility contract](compatibility.md#public-contract-and-version-policy).

Keep fixes at the owning boundary. New commands belong in the registry; MCP discovery
comes from those definitions. Query changes belong in persistence modules; migrations
append to the forward chain. A fallback keeps the original operation usable and records
its weaker evidence; it must not manufacture verification or silently change execution
from a sandbox to the host.
