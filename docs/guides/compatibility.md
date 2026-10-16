# Compatibility and upgrades

| Surface | Supported contract | Qualification |
| --- | --- | --- |
| Server | Bun ≥ 1.4.2; SQLite and Bun networking | Backend tests, dashboard/browser build and image smoke |
| Dashboard unit tests | Node 24 selected by `dashboard/.node-version`; supported versions in `dashboard/package.json` | Vitest/JSDOM suite via `bun run test:ui`; see [testing](testing.md#dashboard-runtime-and-browser-tests) |
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
checks its web assets and settings catalog, and connects a Node SDK agent.
`bun run build:native` produces the separate standalone `dist/marina` executable,
with its server, built-in worlds and settings embedded. `qualify:native` tests it
outside the checkout with no Bun on PATH; browser assets remain a sidecar. See
[artifact scope](release-qualification.md#standalone-terminal-executable).
Where you deploy a released revision is your choice; nothing in a release requires a
cloud account. The maintainers' own optional deployment workflow follows the same rule
of qualifying first: it qualifies its selected revision before obtaining cloud
credentials, transfers that qualified image between jobs without rebuilding, and
qualifies and scans an existing image before a rollback. The release steps are in
[Releasing Marina](releasing.md).

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


## Public contract and version policy

Marina remains 0.x. The supported pairing is a server and SDK from the same minor
release; use the latest patch in that minor. Cross-minor operation requires the
specific compatibility tests below and is not a blanket support promise.

| Surface | Contract retained within a minor release | Executable checks |
| --- | --- | --- |
| SDK root, `/memory`, `/routing` exports | Documented exports, request parameters, errors and authorization; additive optional fields are allowed | SDK packaging/declaration checks; `sdk-legacy-compatibility.test.ts`, memory and routing client suites |
| WebSocket participation | Legacy uncorrelated commands remain readable; correlated-v1 request IDs and confirmed completion remain attributable; strict clients refuse unsupported mutation rather than replay it | `sdk-legacy-compatibility.test.ts`, WebSocket and command-outcome suites |
| Named MCP tools | Published parameter names, bounds, enums and defaults; new world commands use command discovery | Frozen `test/fixtures/mcp-named-contracts.json` and `mcp-named-contracts.test.ts` |
| Durable memory HTTP and numeric compatibility | Record identity, ownership, explicit erasure, version conflicts and numeric-ID projection | Memory cross-interface, canonical-upgrade and portable suites |
| CLI | Documented dispatch, version, successful exit zero, failure nonzero, explicit verification/approval | Dispatcher, one-shot, terminal journeys and standalone qualification |
| Persistence | Append-only forward migrations; reject unsupported future schemas; verified restore into a new path | `upgrade-compatibility.test.ts`, schema baseline and memory recovery suites |
| Experimental behavior | Advisory policy, learned promotions, model-specific judgments, opt-in providers and internal dashboard APIs may evolve; observe/on is an operator choice, not an API version | Mechanism-specific tests and held-out qualification before default promotion |

A patch release must not remove or rename a documented stable operation, reinterpret
its arguments, weaken its authorization, or silently change a documented default.
Deprecation requires a replacement, changelog notice and migration example before
removal. During 0.x, removal requires a new minor version; after 1.0, removal requires
a major version and at least two minor releases and 90 days of notice. Security fixes
may shorten the window, with an explicit upgrade advisory. Consumers should tolerate
unknown additive response fields and must not derive authority from display text.
Internal modules under `src/` are not SDK import paths.

A stability declaration does not enable experimental mechanisms. Promote defaults
only with paired held-out evidence, including missing-provider/JEV behavior, false
positives, cost and latency. Deterministic tests and a single live success cannot
establish that evidence.

## What 1.0 will guarantee

This is the **planned** 1.0 contract. Marina is still 0.x, and until 1.0 ships the
[version policy above](#public-contract-and-version-policy) governs. It extends that
policy; it does not replace it: deprecation still needs a replacement, a changelog notice
and a migration example, and after 1.0 removal needs a major version with at least two
minor releases and 90 days of notice.

Each public surface will carry one of three tiers:

- **Stable**: covered by the guarantees below. Breaking changes only in a major version.
- **Preview**: documented and usable, but may change in a minor release with a changelog
  notice. Opt-in and experimental mechanisms are preview until promoted.
- **Internal**: no compatibility promise, whether or not it is reachable.

Surfaces planned as stable at 1.0:

| Surface | What stays compatible | Reference |
| --- | --- | --- |
| SDK exports | `@marina/agent-sdk` root, `/memory` and `/routing` exports, their parameters, errors and authorization | [SDK reference](../reference/sdk.md) |
| HTTP routes and shapes | Documented routes, request and response shapes, error codes and authentication, including the OpenAI-compatible `/v1` surface, `/v1/memory` and the deprecated-but-supported `/mem` | [HTTP reference](../reference/http.md), [Model API](model-api.md), [Memory API](memory-api.md) |
| World commands | Command names, documented usage forms and their rank and gate requirements | [Command reference](../reference/commands.md) |
| Environment variables | The meaning and accepted values of every documented `MARINA_*` variable | [Environment reference](../reference/environment.md) |
| MCP named tools | Published parameter names, bounds, enums and defaults, as frozen in `test/fixtures/mcp-named-contracts.json` | [MCP reference](../reference/mcp.md) |
| Panel SDK | Documents with schema `marina.panel.v1` keep rendering and validating; a new incompatible shape gets a new schema name | [Published panels](published-panels.md) |
| Database | A database written by any released version upgrades in place through forward migrations; a future schema is refused, never silently opened | [Verified upgrade and rollback](#verified-upgrade-and-rollback) |
| CLI | Documented dispatch, exit status and approval behaviour, as in the version policy table | [Scripts reference](scripts.md) |

Not covered at 1.0:

- world-simulation internals: tick phases and timing, prompt text, scoring weights,
  room-agent behaviour and anything under `src/` that is not an SDK export;
- experimental and opt-in mechanisms and flags, observe/on postures, learned promotions and
  model-specific judgments (preview until promoted with held-out evidence);
- dashboard layout, styling and its internal APIs;
- display text, which must never be parsed for authority.

Today the database guarantee is qualified from the populated schema-131/132 fixtures and the
migration chain, not from a snapshot of every released version; see
[Releasing Marina](releasing.md#gaps-before-10) for what 1.0 still needs.

## Verified upgrade and rollback

1. Stop writers, record the deployed revision and schema, and create a snapshot:
   `bun run memory backup --db /instance/world.db --output /backups/pre-upgrade.db`.
   Retain its verified manifest/hash and test restoration before changing the service.
2. Upgrade a restored copy first. Fresh databases start at the schema-137 baseline;
   existing databases replay their pending historical and forward migrations. The
   populated schema-131/132 fixtures explicitly qualify older memory identities.
   Other starting versions use the migration chain; qualify an actual backup before
   treating an untested starting version as supported for your deployment.
3. Start the new binary, check readiness, authenticate an existing client and check
   durable records and task state. A failed migration halts startup; it does not skip
   the migration. Earlier successful migrations may already have committed.
4. To roll back, stop the service and restore the pre-upgrade snapshot into a **new**
   database path using `bun run memory restore --backup /backups/pre-upgrade.db --db
   /instance/restored.db`. Select that path with the matching older binary. Preserve
   the failed database for diagnosis; never downgrade its schema number manually.

The upgrade test verifies stable IDs, backup integrity, refusal of a future schema,
restoration of the original schema and content, and a subsequent successful upgrade.
Snapshots refuse to overwrite an existing database.
