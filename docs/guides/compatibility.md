# Compatibility and upgrades

| Surface | Supported contract | Qualification |
| --- | --- | --- |
| Server | Bun ≥ 1.4.2; SQLite and Bun networking | Backend tests, dashboard/browser build and image smoke |
| JavaScript clients | ESM in Bun and Node with native fetch/WebSocket | Packed archive imports, authenticated memory request and strict NodeNext declarations |
| Memory API | `/v1/memory` and `@marina/agent-sdk/memory` are the canonical durable interface | Memory API/client tests and recovery qualification |
| Legacy memory | `/mem/*`, `note`, `recall`, numeric references, tiers and pool ACLs remain supported | Cross-interface lifecycle and restart tests |
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

Legacy commands and `/mem` enqueue synchronization in their write transaction and
share one worker. For mapped notes, durable edits update the same numeric note and
search index atomically. Explicit durable `forget` removes its legacy history too;
legacy deletion retires the record and preserves lineage. Changing a record's text
clears verification of the old assertion. If an API edit reports `compatibility_pending`,
allow the queued legacy correction to finish, reread the record, and retry with its
current version. Sources, verdicts and graph links survive interrupted commands.

REST creation reports `synced`, `pending`, or `world_identity_required`. A legacy API
credential alone does not create a world identity. The compatibility projection and
`isServiceMemoryNote` preserve numeric references, tiers and owner/pool permissions;
institutional publications and process/core memory retain their distinct semantics.
New integrations should use the durable API and do not need to orchestrate mirroring.

Use `readiness` to distinguish configuration from live operation. `readiness providers`
actively probes configured upstreams; a configured key or local URL alone is not proof
of connectivity or successful agent work.

For preexisting notes, stop the instance and run
`bun run memory:compatibility backfill DB_PATH [OWNER]`. It pages through eligible
notes, reconciles their sources/verdicts/links, reuses canonical receipts and retains numeric IDs. Already mirrored notes are included so partial backfills can be resumed safely. `status` lists pending
intent IDs and error codes without note content; `retry` runs one bounded batch.
Identityless legacy namespaces stay legacy-only until provisioned through the normal
world identity flow. Backfill does not infer identity from a submitted display name.
