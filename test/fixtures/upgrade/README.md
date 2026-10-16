# Upgrade fixtures from real releases

Each `<tag>.sql` is a database created by that release's own code; `<tag>.json` records
the tag, commit, schema version, Bun/SQLite versions and the rows seeded through the
release's API. `test/upgrade-from-releases.test.ts` upgrades every fixture with today's
code and compares it with a fresh install.

| Release | Schema | Status |
| --- | --- | --- |
| v0.5.0 | 41 | generated |
| v0.6.0 | 70 | generated |
| v0.7.0 | 94 | generated |
| v0.8.0 | 167 | generated |

Add a fixture after tagging a release (needs network access for `bun install`):

```bash
bun scripts/generate-upgrade-fixture.ts vX.Y.Z
```

Never edit a fixture by hand or regenerate one with today's code. If a release can no
longer be booted (for example its dependencies no longer install), leave it out, add a
row above with the reason, and do not substitute a database built another way. See
[persistence](../../../docs/architecture/persistence.md#baseline-refresh-policy).
