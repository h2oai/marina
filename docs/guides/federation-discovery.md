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

## Optional signed identity

Marina is zero-configuration by default and publishes the explicitly unsigned
`marina.federation.manifest.v1` document. Set `MARINA_FEDERATION_SIGNING_KEY` to an Ed25519 PKCS#8
private key to publish `marina.federation.manifest.v2`. The v2 envelope signs a deterministic
representation of the complete manifest and exposes only its public key and SHA-256 fingerprint.
Imported v2 manifests with invalid signatures are rejected.

A valid signature proves that one key signed an unchanged document. It does **not** prove that the
operator is trustworthy, that manifest claims are true, or that the key belongs to the world you
intended to reach. Peers therefore remain `unverified` until an operator compares the fingerprint
through an independent channel and makes an explicit local trust decision. Key rotation,
cross-world principal authentication, replicated consensus, and automatic memory promotion remain
outside this contract.

## Content-addressed and chain-ready, without a chain dependency

Signed envelopes are plain canonical JSON and include no HTTP-only assumptions. They can be copied
through a file, mirrored to content-addressed storage such as IPFS, announced over a peer-to-peer
transport, or referenced by an external ledger without changing signature verification. A future
adapter should publish encrypted or explicitly public artifacts off-chain and anchor only compact
content identifiers or checkpoint hashes. Prompts, private memories, credentials, and personal data
must not be placed on a public chain.

External storage availability, blockchain finality, and signature validity are separate facts. None
of them automatically grants local trust, imports executable behavior, or blocks a local Marina from
working when the external network is absent. This separation keeps ordinary installations simple
while allowing independently operated worlds to add the witnesses and transports they require.

The supported `inheritance.unverified.v1` capability preserves the safe behavior: imported DNA
is a claim with asserted provenance, never governing policy. A future signed-envelope revision can
add issuer verification without changing that epistemic rule.
