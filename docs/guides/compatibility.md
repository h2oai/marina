# Compatibility and upgrades

| Surface | Supported contract | Qualification |
| --- | --- | --- |
| Server | Bun ≥ 1.4.2; SQLite and Bun networking | Backend tests, dashboard/browser build and image smoke |
| JavaScript clients | ESM in Bun and Node with native fetch/WebSocket | Packed archive imports, authenticated memory request and strict NodeNext declarations |
| Memory API | `/v1/memory` and `@marina/agent-sdk/memory` are the canonical durable interface | Memory API/client tests and recovery qualification |
| Deprecated numeric memory | `/mem/*`, `note`, `recall`, numeric references, tiers and pool ACLs remain supported | Cross-interface lifecycle and restart tests |
| Extension API | Manifest `apiVersion: 1` | Permissions, collision, lifecycle and package fixture tests |
| Database | Append-only migrations through the current binary's schema | Populated schema-131 upgrade fixture; newer schemas rejected |

The server is Bun-only. Docker is the portable server deployment path; the SDK has
no Bun server-module dependency. Node server support would require additional database,
networking and runtime adapters and is not implied by client compatibility.

Create a verified backup before upgrading. Deploy only a qualified revision, allow its
forward migrations, and verify readiness. Binary rollback must use a database version
that binary supports; restore the corresponding backup when necessary. Never edit old
migrations or point an older binary at a newer schema. `bun run qualify:release` checks
the source revision and SDK artifact; `bun run qualify:image IMAGE` checks the packaged
server. The release qualifier also boots `dist/main.js` from a fresh instance directory,
checks its web assets and settings catalog, and connects a Node SDK agent. Compiled
entry points retain the shipped `worlds/`, `rooms/`, and `src/` assets beside `dist/`;
they are not standalone executables. Deployment qualifies its selected revision
before obtaining cloud credentials.
Promotion transfers that qualified image between jobs, verifies its image ID and pushes
it without rebuilding. Production selects the registry digest. Rollback also qualifies
and scans the existing registry artifact before changing production.

Numeric commands and `/mem` write the canonical record history synchronously.
A successful response means the whole operation committed; failures roll back.
Numeric handles read the same versioned content and keep their existing IDs,
owner/pool permissions and historical corrections. Native edits clear verification
of replaced text. `note delete` retires; explicit durable `forget` erases history.
REST creation retains `durable: "synced"` for fact-like records and reports
`not_applicable` for process/core journals. There is no pending replay state.

Migration 138 converts existing notes and pending changes transactionally. It also
handles old snapshots during import. Server namespaces without human accounts get
distinct system ownership; creating a human account does not claim those spaces.
The external resident API still requires an active durable world account.

Use `readiness` to distinguish configuration from live operation. `readiness providers`
actively probes configured upstreams; a configured key or local URL alone is not proof
of connectivity or successful agent work.

For an offline upgrade, stop the instance and run
`bun run memory:compatibility upgrade DB_PATH`. `status DB_PATH` reports integrity
counts without content. The old backfill/retry commands and queue are retired.
A conversion failure preserves the previous schema and data for recovery.

For new features, replace numeric-note creation with `memory remember <text>`,
`/v1/memory`, or `ctx.durableMemory.run({ operation: "remember", input: { content } })`.
Use the returned durable record ID and version for later edits. Numeric IDs are not
interchangeable with record IDs. Existing data is converted by the forward migration. `/mem` discovery now advertises its deprecated status and successor.
Core beliefs continue to use `memory kv`; shared pools retain their membership rules.

Fresh databases use the schema-137 baseline. Existing databases follow their pending
upgrade history unchanged. See [persistence](../architecture/persistence.md#fresh-schema-and-existing-database-upgrades).
