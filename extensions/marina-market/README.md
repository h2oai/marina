# Optional marketplace extension (`marina-market`)

This extension lets a publisher sell or license whole Marina worlds and curated
memory. The core does not need it. A standard Marina install never installs,
loads, tests or calls it, and Marina without it behaves exactly as before.

Some things never need this extension, a wallet, a chain, a token or a network
call:

- running Marina;
- growing memory;
- building, exporting or federating worlds;
- importing free (`open`) tiers.

Entitlement checks run only when a user chooses to import or join a **paid** tier.

## What it adds

- **World artifacts.** A `marina.world.v1` artifact is a `marina.learned.v1`
  envelope whose `content_profile` is `marina.world.v1`. It is not a second
  format. A world artifact contains:
  - the world document, which is data only: rooms, exits, guide notes and quest
    descriptions;
  - optional room source code, kept as inert text for review;
  - roles (RoleBundle v1);
  - a curated memory slice (lessons, conventions, defaults, skills);
  - optional pseudonymous contribution vectors;
  - a generated `spec.json`.

  Every artifact has an open `core` tier and may add paid tiers. The default
  licence is proprietary (`LicenseRef-<publisher>-proprietary`).
- **Entitlements.** Two interchangeable verifiers sit behind one interface:
  - `token` (the default): a publisher-signed `marina.entitlement.v1`, verified
    offline against pinned publisher keys.
  - `evm-wallet`: the licensee signs a short statement in their own wallet.
    Marina recovers the address and makes a read-only `balanceOf` call on a
    configured chain.
- **Chain-agnostic adapters.** `ChainAdapter` defines `verifyEntitlement`,
  `anchor`, `readAnchor` and `resolveSettlement`. A single EVM adapter covers any
  EVM chain by configuration.

  `anchor` returns an unsigned transaction. Marina never holds, receives or asks
  for a private key, has no token of its own, and does no bridging.

  A non-EVM family plugs in by implementing `ChainAdapter` and registering a
  factory for its `family` in `createChainRegistry`.
- **Paid hosted worlds over federation.** A host can name a `hosted_world`. The
  core then sends every inbound gateway peer through the extension's admission
  check, which:
  - runs after `GATEWAY_SECRET`, whose meaning is unchanged;
  - requires an entitlement that names the host as its audience.

  Like `GATEWAY_SECRET`, this gates the gateway handshake only. A hard boundary
  also needs `MARINA_AUTH=better-auth` without open login. Free worlds register
  nothing.
- **Payment hook only.** `contracts/src/MarinaLicense.sol` is a minimal ERC-1155
  licence registry:
  - licence id = `keccak256(artifactId ‖ 0x00 ‖ tier)`;
  - immutable `transferable` and `revocable` terms;
  - a write-once artifact digest anchor;
  - no payable functions.

  The contract does not take payment. An external checkout or marketplace
  contract takes payment and calls `issue()` with `ISSUER_ROLE`. Marina only
  reads the result (`resolveSettlement`).

## Install and enable (operators)

```bash
bun install --cwd extensions/marina-market --frozen-lockfile
MARINA_PLUGINS=./extensions/marina-market MARINA_MARKET_CONFIG=./market.json bun run start
```

`market.json` holds only public keys, read-only RPC endpoints and paths:

```json
{
  "publishers": [{ "name": "acme", "public_key": "<base64 SPKI from keygen>" }],
  "audit_log": "data/marina-market-audit.jsonl",
  "chains": {
    "base-sepolia": {
      "family": "evm", "chain_id": 84532, "rpc": "https://sepolia.base.org",
      "license_contract": "0x…", "confirmations": 3, "network": "testnet"
    }
  },
  "hosted_world": {
    "artifact_id": "marina-world:sha256:…/research-lab", "version": "1.2.0",
    "tiers": ["standard"], "audience": "my-world"
  },
  "gateway_proofs": { "lab": "proofs/lab.json" }
}
```

Mainnet chains are refused unless the config sets `"allow_mainnet": true`. Leave
it off until there is an explicit decision to go to production. A chain id that
is a known mainnet but is declared `testnet` is always refused.

RPC requests go through Marina's SSRF guard. A loopback devnet such as anvil is
reachable only under `MARINA_PROFILE=local`.

In-world, `market status` and `market audit` are read-only. Every other action
goes through the operator CLI:

```bash
bun run cli.ts keygen publisher.pem                      # prints only the PUBLIC key
bun run cli.ts publish <payload-dir> publish.json --key publisher.pem
bun run cli.ts verify <bundle-dir>
bun run cli.ts issue --key publisher.pem --artifact <id> --tiers standard --licensee buyer
bun run cli.ts plan-import <bundle-dir> --slices core,standard --proof proof.json
bun run cli.ts statement --chain base-sepolia --artifact <id> --tiers standard --address 0x…
bun run cli.ts anchor-tx <bundle-dir> --chain base-sepolia   # unsigned; sign in your wallet
bun run cli.ts resolve-settlement --chain base-sepolia --tx 0x… --licensee 0x… --artifact <id> --tier standard
bun run cli.ts audit-verify
```

Imports are handled as follows:

- `plan-import` verifies the bundle and applies the entitlement gate. It then
  hands the plan to the core `marina.learned.v1` importer at trust `imported`:
  an imported item is not trusted until local outcomes confirm it.
- The extension never writes memory, roles or rooms itself.
- Room source code is listed for review. It is installed only through the
  existing `world.code`-gated path.

Every decision goes to a hash-chained, mode-0600 audit log. The log never holds
tokens, signatures or keys.

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
3. anchors a real artifact;
4. verifies the licence, the anchor and the settlement through the read-only
   adapter.

All keys in these steps are ephemeral. When Foundry is absent, those checks are
skipped.

`script/Deploy.s.sol` refuses every chain that is not a known devnet or testnet.
The deployer signs with their own key, and Marina never sees it.
