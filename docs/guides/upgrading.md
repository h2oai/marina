# Upgrading a Marina server

The operator path from one release to the next: back up, stop, upgrade, let the first
boot migrate, verify, and — if anything is wrong — roll back by restoring the backup.
Supported contracts per surface are in [Compatibility and upgrades](compatibility.md);
the backup tools are described in [Backup and recovery](recovery.md).

## What an upgrade does

The world database (`DB_PATH`, default `marina.db`) records its schema in the
`schema_version` table. When a new binary opens an existing database it applies every
pending migration in order, each in its own transaction together with its version
marker. Nothing else is needed: there is no separate migration step to run.

- **Every release upgrades.** Each released version's real database (created by that
  release's own code) is upgraded in CI and must end with exactly the schema of a fresh
  install, with its rows intact (`test/upgrade-from-releases.test.ts`, fixtures in
  `test/fixtures/upgrade/`). You can skip releases; the chain covers every step.
- **A failed migration halts startup** with the failing version and the error. That
  migration rolled back, so the database stays at the previous version. Migrations
  before it already committed — which is why the backup comes first.
- **A newer database is refused.** A binary never opens a database whose schema is
  newer than it supports: startup fails with `Database schema N is newer than this
  binary supports; restore a compatible backup or use the newer binary.` Nothing is
  written. There is no downgrade path; an older binary needs the backup taken before
  the upgrade.

## 1. Back up

Take the backup with the server still running, or stopped — both work. The snapshot
uses SQLite's `VACUUM INTO`, so committed data still in the `-wal` file is included and
the `-shm` file is not needed; never copy `marina.db` alone with `cp` while it is open.

```bash
scripts/backup.sh "$DB_PATH" backups/
# or, to a named file:
bun run memory backup --db "$DB_PATH" --output backups/pre-upgrade.db
```

Each prints a receipt with `schema_version`, `sha256` and `verified: true` (integrity and
foreign keys were checked before the file was published). Keep that `schema_version`:
it is the version you are upgrading **from**.

Also keep the files the database alone does not hold:

- `<DB_PATH>.key-secret` (mode 0600) — the key-encryption secret, when
  `MARINA_KEY_SECRET` is not set. Without it, stored provider keys cannot be decrypted.
- the auth database when external sign-in is on, the asset and workspace directories,
  and your `.env` or secret-manager values (`MARINA_KEY_SECRET`, `BETTER_AUTH_SECRET`).

To capture all of it at once, stop the server and use a recovery bundle
(`bun run recovery create SPEC.json DIR`, see [Backup and recovery](recovery.md)).

## 2. Stop the server

Stop every Marina process that writes this database (server, standalone memory service,
CLI imports). Each holds an exclusive lease on the database; `bun run recovery unlock
"$DB_PATH"` confirms the lease is free and cannot force a live one open.

## 3. Upgrade the code

Install the new release the same way you installed the old one — `git checkout <tag>`
and `bun install --frozen-lockfile` for a source checkout, or the new container image
or standalone executable. Do not change `DB_PATH`.

Optionally rehearse first: restore the backup into a scratch path
(`scripts/restore.sh backups/pre-upgrade.db /tmp/rehearsal.db`) and run the next step
against that copy.

## 4. First boot migrates

Start the server as usual (`bun run start`, the image, or the executable). Pending
migrations run before the server accepts connections. A large world may take a while on
the first boot after a release with data conversions; let it finish.

To migrate without starting the server — for example in a deploy pipeline — run, with
the server stopped:

```bash
bun run memory:compatibility upgrade "$DB_PATH"
```

It takes the database lease, applies pending migrations, prints memory-integrity counts
as JSON and exits nonzero if a migration failed or the counts show unconverted or broken
records. (`memory:compatibility status` opens the database the same way, so it also
migrates; run it on a copy if you only want to look.)

## 5. Verify

- **Schema version.** A fresh verified snapshot reports the version now on disk; it
  must equal the new binary's latest migration:

  ```bash
  bun run memory backup --db "$DB_PATH" --output backups/post-upgrade.db   # receipt: schema_version
  bun -e 'import { SCHEMA_VERSION } from "./src/persistence/schema"; console.log(SCHEMA_VERSION)'
  ```

  The second command applies to a source checkout; for an image, compare against the
  release notes.
- **Liveness.** `GET /health` answers `200` while the tick loop runs (`503` with
  `stalled` when it does not); `bun run monitor` watches it from outside.
- **Capabilities.** Run `readiness` (aliases `doctor`, `health`) in the world, or
  `readiness providers` to probe upstreams. Every capability you rely on should be `ok`
  or show a remediation you expect.
- **Data.** Sign in with an existing account, recall a known note, open a known task.

## Rolling back

Rollback is restoring the backup into a **new** path and pointing the older binary at
it. Never edit `schema_version` or run an old binary against the upgraded file — it
will refuse to open it.

1. Stop the server. Keep the upgraded (or failed) database for diagnosis.
2. Restore: `scripts/restore.sh backups/pre-upgrade.db /instance/restored.db`
   (or `bun run memory restore --backup backups/pre-upgrade.db --db /instance/restored.db`).
   Restore refuses an existing destination and verifies integrity before publishing.
3. Reinstall the previous release, set `DB_PATH` to the restored file, keep the matching
   `.key-secret` and secrets, and start it.

Anything written between the backup and the rollback exists only in the upgraded
database. Upgrading the restored copy again later is safe: it takes the same path.

## Reporting a failed upgrade

Include the version you upgraded from and to, the full startup error (it names the
failing migration and the version still on disk) and the backup receipt. Keep the
failed database; do not delete it to retry.
