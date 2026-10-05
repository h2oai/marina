# Learned bundles (`marina.learned.v1`)

A learned bundle carries what one Marina learned to another Marina: the
lessons its outcomes taught, the defaults it earned, aggregate evidence from
its benchmark ledger, the roles it adopted and the conventions it ratified. The
bundle is signed by a publisher. Before anything is imported, the bundle is
checked against publisher keys that the operator pinned.

Imported knowledge is never trusted on arrival. Lessons arrive with the trust
level `imported`. They stay below anything this Marina learned itself until its
own outcomes confirm them.

Nothing changes for an install that never exports or imports a bundle. Imports
are off by default (`MARINA_UPSTREAM=off`).

- [What a bundle contains](#what-a-bundle-contains)
- [Export](#export)
- [Verify, diff and import](#verify-diff-and-import)
- [Licence, access and slices](#licence-access-and-slices)
- [Entitlements for paid and private slices](#entitlements-for-paid-and-private-slices)
- [Worlds (`marina.world.v1`)](#worlds-marinaworldv1)
- [Revocation](#revocation)
- [Keys](#keys)
- [Inspecting imports in-world](#inspecting-imports-in-world)

## What a bundle contains

A bundle is a directory. Every file except `signature.json` is listed with its
sha256 hash in `manifest.json`, and `signature.json` signs the manifest
(Ed25519, through `src/net/federation-crypto.ts`).

| File | Contents |
|---|---|
| `manifest.json` | The bundle's identity, version and lineage, publisher, licence and terms, access fields, slices, item counts and the hash of every file. |
| `signature.json` | The publisher's Ed25519 signature over the canonical manifest. |
| `spec.json` | The spec sheet: counts by kind, domain, tier and source trust; the rank distribution; judge labels; confirmation rates; evidence summaries for defaults; scan counts; tier sizes. |
| `diff.jsonl` | One line per `item_key` whose status is `added`, `changed`, `re-ranked` or `retired`, compared with the parent version. |
| `lessons.jsonl` | Lessons and meta-lessons that the publisher served as trusted. |
| `conventions.jsonl` | Records ratified into institutional spaces (`guide`, `orchestration:*`, `tradition:*`). |
| `defaults.jsonl` | Promoted benchmark defaults, each with an evidence summary that holds numbers only. |
| `evidence.jsonl` | Aggregate ledger statistics per descriptor, family and (internal packs only) benchmark. A cell is exported only when it has at least 20 items. |
| `roles.jsonl` | Roles adopted through `world adopt`, as RoleBundle v1. |
| `world.jsonl` | World bundles only: the data-only world document (rooms, exits, guide notes, quest descriptions). |
| `room-sources.jsonl` | World bundles only: room source code as inert text, flagged for review under `world.code`. |

Every item has two identifiers:
- an `item_key`: a stable, opaque identity that survives edits across versions;
- a `content_hash`: the hash of this version's content, excluding rank, tier and provenance.

Each record also carries a provenance chain. Every hop names its producer, an
opaque origin, hashed outcome references, the judge and whether it is
calibrated, and a role label such as `ratifier`. A hop never names a person.

The manifest identifies the artifact with these fields:
- `artifact_id`: `marina-memory:<publisher key fingerprint>/<name>`, or
  `marina-world:…` for a world bundle;
- `version`: semver;
- `generation`: a monotonic integer, used to refuse downgrades;
- `parent`: `{version, generation, manifest_digest}`;
- `lineage`: every ancestor, oldest first.

## Export

Export is an operator script and never an in-world command:

```bash
DB_PATH=marina.db MARINA_LEARNED_SIGNING_KEY=$(cat ~/.marina/learned.key) \
  bun run learned export --out ./packs/curated-1.0.0 --name curated \
  --publisher "Example Org" [--profile internal|public] [--parent ./packs/curated-0.9.0]
```

**Allow-list only.** Export reads exactly these sources and nothing else:

| Class | Source |
|---|---|
| Lessons | Current records with trust `trusted` in the `lessons:*` spaces, meta-lessons included. Unverified, rejected and retired lessons are never exported. |
| Conventions | Current records in institutional spaces that carry `ratified_by`. |
| Defaults | `benchmark_defaults` rows whose incumbent run is still valid. |
| Evidence | Completed ledger runs, aggregated per cell. A cell is cut when it has fewer than 20 items. Run ids, item ids and answer hashes are never exported. |
| Roles | Roles whose `world adopt` request was applied. |

These are never exported:
- private memory, process memory or core memory, and `memory kv`;
- pool notes;
- transcripts and traces;
- item-level outcomes and answer hashes;
- human names and secrets.

**Scans: an item is dropped, never redacted.** Every candidate item is scanned.
An item that fails a scan is dropped from the bundle, and the export prints its
key, kind and reason but never its content.

| Scan | What fails it |
|---|---|
| `secret` | Key-shaped strings, private-key blocks, bearer tokens, `password=`-style assignments and JWTs. Also the value of any of this process's own environment variables whose name ends in KEY, SECRET, TOKEN or PASSWORD. |
| `instance` | Emails, IPv4 addresses, absolute paths, internal host names, UUIDs, URLs with a query string or credentials, and phone-like numbers. Also the host name, `MARINA_NAME` and any `--instance-token`. |
| `human-name` | Any local account name of 4 or more characters, matched as a whole word. |
| `benchmark-text` | Any 6-word shingle, or 40-character window starting at a word, shared with a local benchmark dataset. The default dataset is `benchmarks/datasets`; add more with `--bench-corpus <path>`. |

References are salted with the publisher key id and hashed. For example,
`bench:<run id>` becomes `bench:<hash>`.

**Profiles.** `internal` packs are for backups and moves between your own
worlds. `public` packs differ in two ways:
- arena lessons are held back;
- evidence is reported at family level only. A benchmark joins a family only through `--family <name>=<bench>,<bench>`, and a benchmark with no declared family is dropped.

**Versions.** With `--parent <dir>`, export does four things:
- checks that the parent was signed by the same key and carries the same name;
- sets `generation` to the parent's plus one;
- records the parent and the lineage;
- writes `diff.jsonl`.

The version is bumped automatically:

| Change since the parent | Bump |
|---|---|
| The profile changed | Major |
| Items were added | Minor |
| Anything else | Patch |

An explicit `--version` must be greater than the parent's version.

**Tiers.** Every item is placed in one tier:

| Tier | Contents |
|---|---|
| `core` | At most 8 KB of rendered text: the defaults, then the highest-ranked lessons and conventions. Sized for small models. |
| `standard` | Adds the remaining lessons and conventions, plus the evidence aggregates. |
| `full` | Adds the roles. |

## Verify, diff and import

```bash
bun run learned verify ./packs/curated-1.1.0 [--revocations revocations.json]
bun run learned diff ./packs/curated-1.0.0 ./packs/curated-1.1.0
MARINA_UPSTREAM=on DB_PATH=marina.db bun run learned import ./packs/curated-1.1.0 --own
```

`--own` imports your own private pack, which is the default export. Open slices
need no flag, and paid slices need `--entitlement`; see
[Entitlements](#entitlements-for-paid-and-private-slices).

Verification refuses the bundle at the first failure in this order:
1. the schema is not `marina.learned.v1`;
2. the signature does not verify against a pinned key, or the signing key is not the manifest's publisher key;
3. a file's sha256 does not match the manifest, or an item file is present that the manifest does not list;
4. an item does not parse, is in the wrong file, or has a `content_hash` that does not recompute.

A refused bundle is never imported through any fallback. Import additionally
refuses three cases:
- a generation older than one already imported (a downgrade);
- a generation already imported with different content;
- a version that its publisher revoked.

Import also runs the export scans again.

| Class | Where it lands |
|---|---|
| Lessons | `upstream:lessons:<domain>` spaces owned by the `marina:upstream` account. Each lesson has trust `imported`, its original `resolved_at` (so the leakage rule applies unchanged) and the publisher's score as `publisher_rank`. Imported lessons are never written into `lessons:*`, so they are not served as local lessons. |
| Conventions | The `upstream:conventions` space, with trust `imported`. |
| Defaults | `upstream_default_seeds`, and only for a slot that has no local `benchmark_defaults` row. Default resolution reads a seed below every local layer (`upstreamSeedFor` in `src/learned/upstream-seed.ts`). A seed answers nothing once a local default exists for its slot. |
| Evidence | `evidence_priors`, down-weighted (weight 0.25, at most 50 items per cell). Evidence never enters `benchmark_runs` or `benchmark_items`. |
| Roles | Created under the `upstream.` prefix, for both the role and its traits. A role is only ever created, never bound to an agent, and changing it later takes `role.edit`. |

Importing a newer generation changes local state in three ways:
- an item it no longer carries is retired locally;
- a changed item replaces the earlier version, and the earlier version stays readable;
- an unchanged item is left alone.

Every action is written to the append-only `upstream_events` table, including
refused imports, dropped items, skipped slots, seeds, priors and roles.

**Confirmation.** An imported lesson never becomes trusted by being imported.
Only this Marina's own judged outcome loop confirms it. To do so, the loop
writes a local, trusted lesson that cites the imported lesson as
`upstream:<item_key>`. `confirmImportedLesson` (`src/learned/import.ts`) checks
that citation, then:
- records the confirming lesson in `learned_items.confirmed_by`;
- adds `confirmed_locally_by` to the imported record's metadata.

The imported record itself keeps trust `imported`. The trusted knowledge is the
local lesson that confirmed it.

## Licence, access and slices

Bundles are **proprietary by default**:

| Field | Default value |
|---|---|
| `license` | `LicenseRef-<publisher>-proprietary` |
| `redistribution` | `none` |
| `commercial_use` | `none` |
| `access.model` | `private` |

`--terms-url` and `--terms-file` record the terms of use. The file is recorded
as a hash. Opening a bundle is always an explicit flag:

- `--open` opens the whole bundle. It sets `CC-BY-4.0`, `redistribution: allowed`, `commercial_use: allowed` and `access.model: open`. Attribution is required either way.
- `--open-slice <id>` opens one slice and leaves the rest proprietary. For example, `--open-slice tier:core` marks the core tier as the open core.

The `slices` list in the manifest has one tier slice per tier (`tier:core`,
`tier:standard` and `tier:full`) and one slice per domain (`domain:forecast`,
`domain:code`, `domain:conventions` and so on). Each slice lists its item keys,
a digest, and its own `open`, `license` and `access` values.

Each slice's `access` decides what an import needs. The next section
describes the rules. Licence terms beyond access, such as redistribution and
attribution, are the operator's to honour: the code records and displays them.
Nothing is encrypted. `access.encryption` and `access.entitlement` are reserved
and always `null`.

## Entitlements for paid and private slices

An import writes an item only when one of its slices allows it:

| Slice `access` | What the import needs |
|---|---|
| `open` | Nothing. No check runs and no network call is made. |
| `token` (paid) | An entitlement grant that names the slice. |
| `private` (the default export) | A grant that names the slice, or `--own`: the operator's assertion that the pack is their own, for an internal move or a backup. `--own` never unlocks a `token` slice. |

Without a grant, an import writes the open items and reports the rest as
withheld. It refuses when every selected item is withheld. `--slices` limits
an import to named slices; a named `token` or `private` slice without a grant
is refused. A withheld or unselected item is never retired, so importing only
the free core later leaves paid items imported earlier in place. Every grant
used is recorded in `upstream_events`.

A grant comes from an entitlement token, `marina.entitlement.v1`. The
publisher, or an issuer listed in `access.entitlement_issuers`, signs it with
its learned-bundle key. It is verified offline against the same pinned keys as
bundles, so an import still works air-gapped. Payment happens outside Marina:
a checkout run by the publisher issues the token.

```bash
# publisher: issue a token for one buyer
MARINA_LEARNED_SIGNING_KEY=… bun run learned entitle --artifact marina-memory:…/curated \
  --tiers tier:standard --licensee buyer-co --versions '^1.0.0' --days 365 > buyer.json
# buyer: import the paid slice
MARINA_UPSTREAM=on DB_PATH=marina.db bun run learned import ./packs/curated-1.1.0 \
  --slices tier:standard --entitlement buyer.json
```

A token names the artifact, a semver range of versions, the slice ids it
grants, a licensee label, an optional federation audience, a validity window
and a nonce. A publisher revokes a token with a signed revocation entry
carrying `entitlement_nonce`; an import with a revoked token is refused.

`src/learned/entitlement.ts` defines the `EntitlementVerifier` interface, so
other proofs can produce grants too. The optional `extensions/marina-market`
extension adds a read-only on-chain licence check. `access.chains` lists the
chains on which a publisher sells such licences.

## Worlds (`marina.world.v1`)

A world travels as a learned bundle whose `content_profile` is
`marina.world.v1`. There is no separate format: world content is two item
kinds, so worlds get content hashes, slices, diffs, revocation and the scanner
like every other item.

- `world`: the data-only world document. Unknown keys are refused, so a seed,
  lifecycle hook or bootstrap command cannot ride along.
- `room_source`: room source code as inert text with `requires_gate:
  world.code`. Import stores it in `upstream:room-sources` for review and never
  compiles, registers or runs it. Installing it is the existing
  `world.code`-gated path, taken by someone who read it.

Imported world documents land in `upstream:worlds` with trust `imported`.
`src/learned/assemble.ts` builds and signs a bundle from items a publisher
already holds, such as a world.

## Revocation

A publisher revokes with a separately signed `revocations.json`:

```json
{
  "schema": "marina.learned.revocations.v1",
  "publisher_key_id": "sha256:…",
  "issued_at": "2026-10-04T00:00:00Z",
  "entries": [
    { "artifact_id": "marina-memory:…/curated", "version": "1.1.0", "reason": "…", "severity": "critical" },
    { "artifact_id": "marina-memory:…/curated", "item_key": "lesson:…", "reason": "…", "severity": "retire" }
  ],
  "signature": { "algorithm": "Ed25519", "publicKey": "…", "keyId": "sha256:…", "value": "…" }
}
```

You can supply a revocation list in two ways:
- with `--revocations <file>` on `import` and `verify`;
- as `revocations.json` placed beside the bundle.

Revocation lists are handled as follows:
- A revocation list must verify against a pinned key, and that key must be the list's `publisher_key_id`.
- A list only affects artifacts of its own publisher.
- An entry without `version` revokes every version of the artifact.
- A revoked version is refused.
- A revoked item is dropped and, if it was already imported, retired locally with status `revoked`.

`signRevocations` in `src/learned/bundle.ts` builds a signed list.

## Keys

Bundles are signed with a dedicated key, `MARINA_LEARNED_SIGNING_KEY`. It is
never the federation key or the arena key. Signatures are verified **only**
against these pinned keys:
- `BUILTIN_PUBLISHER_KEYS` in `src/learned/sign.ts`, which is empty until a publisher key is pinned in a reviewed change;
- the operator's `MARINA_LEARNED_PUBLISHER_KEYS`, a comma-separated list of `label=<base64 SPKI>` entries.

The public key embedded in a signature is never trusted on its own.

**An instance key, for internal packs between your own worlds:**

```bash
bun run learned keygen ~/.marina/learned.key   # mode 0600; prints the public key
# exporting world:  MARINA_LEARNED_SIGNING_KEY=$(cat ~/.marina/learned.key)
# importing world:  MARINA_LEARNED_PUBLISHER_KEYS=mine=<printed public key>
```

**A publisher key for public packs.** A publisher key, such as an
organisation's key for public packs, is created offline by its owner. It is
never generated by an agent or kept on a server. The steps are:

1. On an offline machine, run `openssl genpkey -algorithm ed25519 -out publisher.pem`.
2. Run `openssl pkey -in publisher.pem -pubout -outform DER | base64 -w0` to get the public key to pin.
3. Keep `publisher.pem` offline, mode 0600, with a backup under two-person control.
4. Sign each pack on that machine. `MARINA_LEARNED_SIGNING_KEY` accepts PEM with escaped newlines.
5. Pin the public key: in `BUILTIN_PUBLISHER_KEYS` through a reviewed change, or per install through `MARINA_LEARNED_PUBLISHER_KEYS`.

Key rotation, where the old key signs a statement naming the new one, and
countersignatures are later phases.

## Inspecting imports in-world

`learned` is a read-only command available at rank 0:

| Command | Shows |
|---|---|
| `learned` | The import mode and counts of artifacts, items, confirmations, seeds and priors. |
| `learned artifacts` | Each imported version with its licence, access and key. |
| `learned items [artifact:<id>] [status:active\|retired\|revoked]` | Each item with its trust (`imported`) and whether it is confirmed. |
| `learned seeds` | Each seeded slot, and whether a local default shadows it. |
| `learned priors [family:<f>]` | Each prior, with its raw counts and its weighted counts. |
| `learned events [limit:<n>]` | The audit trail. |

Export and import stay operator acts.
