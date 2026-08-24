# Federation discovery

Every Marina exposes a non-secret discovery document at:

```text
GET /api/federation/manifest
```

It contains a stable local world ID, display name, base URL, supported contract versions, and the
current local evidence-chain head. Open **Dashboard → Admin → Collective**, open this world's
manifest, and paste another world's manifest to register a peer. The same operation is available to
authenticated clients at `POST /api/federation/peers`.

Registration is deliberately passive: Marina performs no server-side fetch, imports no memory, and
marks the peer `unverified`. This avoids turning a pasted URL into an SSRF mechanism or a display
name into identity. An operator can explicitly mark a record `trusted` or `blocked`; that decision is
local policy metadata, not cryptographic authentication.

## What the manifest does not prove

The current `marina.federation.manifest.v1` document is unsigned and says so in its
`trustBoundary`. Its `publicKey` is `null`. A copied manifest can be altered, and its evidence head
is only useful when an independent party retained an earlier checkpoint. Marina does not yet claim
signed envelopes, key rotation, cross-world principal authentication, replicated consensus, or
automatic memory promotion.

The supported `inheritance.unverified.v1` capability preserves today's safe behavior: imported DNA
is a claim with asserted provenance, never governing policy. A future signed-envelope revision can
add issuer verification without changing that epistemic rule.
