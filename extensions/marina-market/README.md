# Optional marketplace extension (`marina-market`)

This extension lets a publisher sell or license whole Marina worlds and curated
memory. The core does not need it. A standard Marina install never installs,
loads, tests or calls it, and Marina without it behaves exactly as before.

Some things never need this extension, a wallet, a chain, a token or a network
call:

- running Marina;
- growing memory;
- building, exporting or federating worlds;
- importing open slices.

## What lives in the core, and what this adds

The format, the verifier and the importer are free and open, and they live in
the core (`src/learned/`, see `docs/guides/learned-bundles.md`). The core
provides:

- **`marina.learned.v1` bundles**, signed and verified against pinned publisher
  keys. Each bundle has slices, and each slice has an `access` of `open`,
  `token` or `private`.
- **World content.** A `marina.world.v1` bundle is a learned bundle with two item
  kinds:
  - `world`: the data-only world document;
  - `room_source`: room source code as inert text flagged for `world.code`,
    never compiled on import.
- **Offline entitlement tokens** (`marina.entitlement.v1`): `bun run learned
  entitle` issues them and the importer verifies them offline.
- **An entitlement-gated importer.** A paid item is never written without a grant
  that covers one of its slices.

This extension adds:

- **World publishing** (`cli.ts publish`). It turns a payload directory into a
  signed world bundle through the core's `assembleBundle`. It enforces the
  marketplace's world rule: an open `tier:core` slice that carries the world
  document. It also runs publish-side scans, which refuse secrets, home paths,
  emails, unknown files and symlinks.
- **A read-only on-chain verifier** (`evm-wallet`). The licensee signs a short
  statement in their own wallet. Marina recovers the address and makes a
  read-only `balanceOf` call on a configured chain. The verifier implements the
  core `EntitlementVerifier` interface, so it yields the same grant as a token.
- **`ChainAdapter`**, which defines `verifyEntitlement`, `anchor`, `readAnchor`
  and `resolveSettlement`. A single EVM adapter covers any EVM chain by
  configuration.
  - `anchor` returns an unsigned transaction. Marina never holds, receives or
    asks for a private key, has no token of its own, and does no bridging.
  - A non-EVM family plugs in by implementing `ChainAdapter` and registering a
    factory for its `family` in `createChainRegistry`.
- **Paid hosted worlds over federation.** A host can name a `hosted_world`
  bundle. Inbound gateway peers then need an entitlement that names this host
  as its audience.
  - The check runs through the core's optional gateway hooks, after
    `GATEWAY_SECRET`, whose meaning is unchanged.
  - It gates the gateway handshake only. A hard boundary also needs
    `MARINA_AUTH=better-auth` without open login.
  - Free worlds register nothing.
- **A licence contract** (`contracts/src/MarinaLicense.sol`): a minimal ERC-1155
  licence registry. The licence id is `keccak256(artifactId ‖ 0x00 ‖ slice id)`.
  Its `transferable` and `revocable` terms cannot change, it anchors an artifact
  digest once, and it has no payable functions.

  Payment happens outside Marina. An external checkout or marketplace contract
  takes payment and calls `issue()` with `ISSUER_ROLE`. Marina only reads the
  result (`resolveSettlement`).

## Install and enable (operators)

```bash
bun install --cwd extensions/marina-market --frozen-lockfile
MARINA_PLUGINS=./extensions/marina-market MARINA_MARKET_CONFIG=./market.json bun run start
```

`market.json` holds only public keys, read-only RPC endpoints and paths:

```json
{
  "publishers": [{ "name": "acme", "public_key": "<base64 SPKI from bun run learned keygen>" }],
  "audit_log": "data/marina-market-audit.jsonl",
  "revocations": ["revocations.json"],
  "chains": {
    "base-sepolia": {
      "family": "evm", "chain_id": 84532, "rpc": "https://sepolia.base.org",
      "license_contract": "0x…", "confirmations": 3, "network": "testnet"
    }
  },
  "hosted_world": { "bundle": "worlds/research-lab-1.2.0", "tiers": ["tier:standard"], "audience": "my-world" },
  "gateway_proofs": { "lab": "proofs/lab.json" }
}
```

Publishers in this file are added to the core's pinned keys
(`MARINA_LEARNED_PUBLISHER_KEYS`). Mainnet chains are refused unless the config
sets `"allow_mainnet": true`. Leave it off until there is an explicit decision to
go to production. A chain id that is a known mainnet but is declared `testnet` is
always refused.

RPC requests go through Marina's SSRF guard. A loopback devnet such as anvil is
reachable only under `MARINA_PROFILE=local`.

In-world, `market status` and `market audit` are read-only. Every other action
is an operator act:

```bash
bun run learned keygen publisher.key                     # core: a publisher key (0600)
bun run cli.ts publish <payload-dir> <out-dir> publish.json --key-file publisher.key
bun run learned entitle --artifact <id> --tiers tier:standard --licensee buyer --key-file publisher.key
MARINA_UPSTREAM=on bun run cli.ts import <bundle-dir> --slices tier:standard --proof proof.json
bun run cli.ts statement --chain base-sepolia --artifact <id> --tiers tier:standard --address 0x…
bun run cli.ts anchor-tx <bundle-dir> --chain base-sepolia   # unsigned; sign in your wallet
bun run cli.ts resolve-settlement --chain base-sepolia --tx 0x… --licensee 0x… --artifact <id> --tier tier:standard
bun run cli.ts audit-verify
```

`cli.ts import` verifies the proof, then hands the bundle and the grant to the
core importer. The core importer writes only the slices the grant covers, at
trust `imported`. Room source code is stored for review. It is installed only
through the existing `world.code`-gated path.

Every marketplace decision goes to a hash-chained, mode-0600 audit log, which
never holds tokens, signatures or keys. The core records imports in
`upstream_events`.

## Payload layout for `publish`

| Path | Becomes |
|---|---|
| `world/world.json` | a `world` item (data only; unknown keys refused) |
| `world/rooms/<id>.ts` | `room_source` items (inert text) |
| `roles/<name>.json` | `role` items (RoleBundle v1) |
| `conventions.jsonl` (`{id, text, pool}`) | `convention` items |
| `lessons.jsonl` (`{id, text, domain, lesson_kind, resolved_at}`) | `lesson` items |
| `contributions.jsonl` | pseudonymous contribution vectors, in the spec sheet |

## Tests

```bash
bun run check            # the extension's own checks (*.check.ts; not part of the core suite)
bun run typecheck
cd contracts && forge test
```

Foundry is optional: install it without sudo from the release tarball into
`~/.foundry/bin`. When Foundry is present, `test/anvil.check.ts` starts a local
anvil devnet and runs these steps:

1. deploys the contract with the testnet-only `script/Deploy.s.sol`;
2. issues a licence;
3. imports the paid slice through the core importer with a wallet proof;
4. anchors the artifact and resolves the settlement through the read-only
   adapter.

All keys in these steps are ephemeral. When Foundry is absent, those checks are
skipped.
