# Identity and workload security

Marina applies the same actor model to humans and agents without pretending they authenticate in
the same way. Every local actor can have an immutable principal ID, a type (`human`, `agent`,
`service`, or `system`), a home world, lifecycle status, and optional owner and lineage parent.
Display names remain usable labels; they are not security identifiers.

The dashboard exposes this registry under **Admin → Identity**. Operators can suspend, reactivate,
or disable a principal. Human status is checked at the shared login path. Agent status is checked
before launch and again when its world connection is authenticated.

## Agent credentials

Newly launched runtime agents receive an independent random bearer credential with:

- a single `marina:world` audience;
- a `world:connect` scope;
- a maximum 24-hour lifetime;
- an independently revocable credential ID; and
- only a SHA-256 token hash stored in SQLite.

The raw credential exists only long enough to configure the in-process agent adapter. Marina
revokes it when that agent stops or when launch fails. The older process bootstrap secret remains a
compatibility and bootstrap channel; newly spawned runtime agents do not share it for their world
login. Provider API keys are a separate concern and continue to use Marina's key controls.

## Current trust boundary

This is a local workload identity plane, not federation or runtime attestation. It does not yet
provide OIDC/SPIFFE certificates, hardware-backed keys, cross-world issuer trust, delegated resource
policy, or proof that an external process holding a credential is running approved code. A principal
record establishes durable local identity and lifecycle; it does not prove every claim made by that
actor. Use traces, structured logs, judgments, and evidence receipts to inspect behavior.

Suspension prevents new login or launch. It does not forcibly terminate an already active human
connection; operators should also stop the agent or revoke the active session when immediate
containment is required.
