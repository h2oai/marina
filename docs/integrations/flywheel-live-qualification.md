# Flywheel live qualification

Marina's ordinary test suite never requires Flywheel. The M5e release gate is an explicit live run
against an independently reachable Flywheel public RPC endpoint:

```bash
FLYWHEEL_TOKEN=... \
FLYWHEEL_RPC_URL=http://flywheel.example:8088/rpc \
FLYWHEEL_IMAGE=registry.example/flywheel-agentd:qualified \
bun run qualify:flywheel
```

Every run writes a versioned, credential-redacted JSON record under `artifacts/flywheel/` by default.
Use `MARINA_FLYWHEEL_EVIDENCE_DIR` to retain it elsewhere. The runner always attempts sandbox
teardown, uses a temporary Marina database, never touches a Marina host workspace, and never retries
guest work on the host. With no token it records a skip and exits successfully; set
`MARINA_FLYWHEEL_LIVE_REQUIRED=true` to make missing configuration or any required failure fatal.

## Qualification levels

The baseline requires create, finite execution, authoritative timeout cancellation, bounded project
archive export/import, content verification, and teardown. It is suitable for every backend.

The full release matrix additionally requires public clone, a managed HTTP service and probe,
browser screenshot, publication/revocation, and hibernate/resume:

```bash
MARINA_FLYWHEEL_LIVE_REQUIRED=true \
MARINA_FLYWHEEL_LIVE_FULL=true \
MARINA_FLYWHEEL_LIVE_CLONE_URL=https://github.com/example/small-public-fixture.git \
MARINA_FLYWHEEL_LIVE_ALLOW_PUBLISH=true \
MARINA_FLYWHEEL_DEPLOYMENT_MODE=separate \
bun run qualify:flywheel
```

Publication is never attempted unless `MARINA_FLYWHEEL_LIVE_ALLOW_PUBLISH=true`. Unsupported image
or backend capabilities are recorded as `skipped`; in full mode a skipped required capability fails
qualification. Run the same full command once with `MARINA_FLYWHEEL_DEPLOYMENT_MODE=separate` and
once with `composed`, retaining both evidence files. The label is evidentiary and does not change the
protocol path.

## Required failure matrix

The harness directly proves remote timeout cancellation by checking that a delayed marker is never
written. Release operators must also retain runs or infrastructure evidence for conditions that
cannot be safely synthesized through Flywheel's public production API:

| Scenario | Expected Marina result |
| --- | --- |
| Flywheel absent/unreachable | readiness degrades; local mode remains usable; selected guest work never runs locally |
| Invalid/expired capability | operation stops with sanitized authorization failure; no token appears in evidence |
| Exec stream disconnect | outcome is unknown/failed and is never blindly replayed |
| Flywheel restart | persisted binding reconciles to the registry before lifecycle mutation |
| Marina restart first | binding and project metadata recover; running services require identity revalidation |
| Disk full during upload/import | staged content fails; destination is not promoted; partial file is cleaned |
| Publication revoke failure | exposure remains visible with retry-pending error and an operations alert |
| Hibernation unsupported | capability is explicitly skipped/degraded; no disk-preservation claim is made |

Flywheel-specific fault injection belongs in Flywheel's own test environment. Marina should consume
only its public endpoint and retain the resulting Marina evidence; neither repository may import the
other's internals or fixtures.

Before release, also run `bun run test`, `bun run typecheck`, `bun run lint`, the dashboard tests and
build, and Flywheel's standalone suite with no Marina process.
