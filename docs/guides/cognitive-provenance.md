# Cognitive provenance

Cognitive provenance is an optional event plane for reconstructing how cognition led to action. It
does not replace Marina's structural traces, Chronicle, journey evidence, or canonical artifacts.

Enable capture explicitly:

```text
MARINA_COGNITIVE_PROVENANCE=true
```

Inspect it in-world:

```text
provenance status
provenance list
provenance list journey_abc123
provenance verify
```

Events use the `marina.cognition.event.v1` schema and form a SHA-256 hash chain. Capture covers
desires and commands, model request lifecycles, agent turns and text/thinking deltas, tool
intentions/actions/consequences, recall queries and exact note references, reflection notes, task
outcomes, and artifact/agent/note creation. Trace and span identifiers are retained whenever the
canonical event supplies them. Provider-side reasoning that Marina never receives remains an
explicit observability gap; provenance does not invent it.

If `MARINA_FEDERATION_SIGNING_KEY` contains an Ed25519 PKCS#8 private key, each event is also signed
with the Marina's existing federation identity. An unsigned chain still detects mutation within a
retained history. A signature proves integrity and key possession; it does not prove that a claim
is true, licensed, original, or valuable.

Capture is off by default because cognitive payloads can contain sensitive inputs or derived
context—including command text, model deltas, and recalled note identifiers. Enabling it is a
sovereignty and disclosure decision. Existing trace APIs and behavior are unchanged in either mode.
