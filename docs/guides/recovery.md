# Backup and recovery

Online database snapshots use `scripts/backup.sh DB BACKUP_DIRECTORY`. They include
committed WAL data and are verified before publication. Restore with
`scripts/restore.sh BACKUP NEW_DB`; an existing database is never replaced. Stop the
instance before changing `DB_PATH`, and retain the old database for rollback.

For a complete instance, stop all writers and prepare a private specification:

```json
{
  "databases": { "world": "data/marina.db", "auth": "data/marina-auth.db" },
  "files": {
    "assets": "data/assets",
    "workspace": "data/workspace",
    "configuration": ".env"
  }
}
```

Paths resolve relative to the specification. Remove `auth` if sign-in is disabled;
list additional code roots, custom worlds and separately managed credential files
explicitly. Missing inputs fail the operation. Environment-injected secrets such as
`MARINA_KEY_SECRET` and `BETTER_AUTH_SECRET` must be retained in your secret manager
or supplied as a private listed file. Without the original encryption secret, stored
provider keys cannot be decrypted.

```bash
bun run recovery create recovery.json /backups/marina-2026-09-26
bun run recovery restore /backups/marina-2026-09-26 /recovered/marina
```

The bundle has `databases/`, `files/`, and a hash manifest. It snapshots every declared
database, copies declared files with restricted permissions, and rejects symbolic
links and special files. Restoration validates hashes, file inventory and database
integrity before publishing a new directory. Point configuration at the restored
paths, supply the matching secrets, start on a test port, then verify sign-in, notes,
assets and workspace operations before switching traffic. Bundles are private and
are not encrypted by this tool; use your backup storage's encryption and access control.

Official world and standalone-memory servers hold an exclusive lock on a separate
SQLite lease file. Offline bundle creation and CLI import refuse a held lease. The
kernel releases it even after an unclean process kill, so restart does not require
removing a stale PID file. Never unlink the lease file while another process may use
it. `bun run recovery unlock STOPPED_DB` safely checks that the lease can be acquired
and released; it cannot force a live lock open. Stop third-party writers as well:
only cooperating Marina entry points participate in this maintenance protocol.

Logical JSON exports omit some credentials by default but retain private notes,
messages and other content. They are not public datasets or complete backups.
Replacement import clears each table present in the snapshot, including empty tables;
omitted tables are preserved. Imports reject newer schemas and roll back on row,
foreign-key or index failures. A failed CLI import exits nonzero.
