# Sandbox credential broker contract

Status: **cross-product design dependency** · Updated 2026-08-05

## Decision

Marina will not copy long-lived credentials into a sandbox, command argument, Git URL, environment
variable, persisted project record, artifact, or model context. Credentialed sandbox work must use a
Flywheel-owned, versioned credential-broker interface. Marina authorizes a logical use; Flywheel
holds or resolves the real secret and enforces its use at the compute boundary.

This applies to more than private Git:

| Need | Native mechanism | Never use |
| --- | --- | --- |
| Private Git over HTTPS | credential-injecting Git HTTP proxy | token in clone URL or `.git/config` |
| npm, PyPI, Cargo, Go modules | registry proxy with server-side auth | checked-in user config or token env vars |
| OpenAI, Anthropic, other model APIs | named HTTP upstream proxy | provider keys in the guest |
| Cloud and internal HTTP APIs | named, policy-bound upstream proxy | general bearer tokens passed to a process |
| Object/artifact storage | session/sandbox-bound storage capability | durable storage credentials |
| Package/signing keys | remote signing service | private key material in the workspace |
| Published app runtime | proxied service access; otherwise a scoped process secret handle | baking secrets into images or project files |

SSH-agent forwarding, broad cloud credentials, and arbitrary secret environment injection are not
v1 fallbacks. Protocols that cannot use a proxy need a separately reviewed short-lived workload
identity or signing-service contract.

## Current Flywheel reality

Flywheel already implements the right core idea: its OpenAI/Anthropic proxy and generalized named
HTTP upstreams inject the real credential server-side. The guest presents only an execution token.
However, that proxy currently validates scheduled-function execution records. Marina Code Mode uses
the public `CreateSandbox` + direct `Exec` lifecycle, whose protocol currently has no credential
binding, proxy discovery, environment, or secret-handle fields. Named upstream registration is an
internal server API, not a public consumer control-plane contract.

Therefore Marina is philosophically aligned but cannot safely consume this feature for durable Code
Mode yet. `code project clone` remains public HTTPS only. Marina must fail closed instead of passing
one of its own API keys into the guest.

## Required Flywheel-neutral public contract

The public API should expose generic concepts, not Marina-specific fields:

1. **Discover broker capabilities** — supported proxy classes and transport semantics, without
   revealing configured secrets.
2. **Bind a named credential profile** to one session/sandbox with purposes, allowed hosts/path
   prefixes, methods, expiry, and optional project/process ownership.
3. **Return a non-secret endpoint descriptor** suitable for Git, package managers, model SDKs, or a
   generic HTTP client. The upstream credential is never returned.
4. **Authenticate the sandbox**, preferably through backend identity or a sandbox-bound ephemeral
   capability. If a bearer is unavoidable, it is not an upstream credential, is narrowly scoped and
   expiring, and is injected by Flywheel rather than Marina command text.
5. **Revoke/list bindings** and revoke them automatically on sandbox stop, expiry, project switch
   where scoped, or operator action.
6. **Emit sanitized audit events** containing actor/session/sandbox, profile alias, purpose, target,
   decision, byte counts, and timing—never authorization headers, query secrets, or response bodies
   by default.
7. **Redact at the boundary** before stdout/stderr and event persistence. Marina performs a second
   defensive redaction pass but is not the primary secret-containment layer.

Operator-configured profiles should reference a vault/provider entry by opaque ID. A consumer may
request use of `git:github-work`, `registry:npm-read`, or `model:openai-team`; it cannot upload or
read the underlying secret through the agent-facing API.

## Marina authorization model

Marina stores only credential-free bindings:

- entity, coding session, and project IDs;
- opaque Flywheel profile/binding IDs and display aliases;
- declared purpose and target constraints;
- approval/gate decision, expiry, state, and sanitized last error;
- creation, use, revocation, and reconciliation timestamps.

Binding a profile is consequential and uses Marina's existing competence/approval layer. Routine
use after binding remains autonomous within its declared scope. Agents and humans use the same
surface and evidence trail. A crew uses the task owner's sandbox and bindings in v1; membership does
not grant independent access to the underlying credential.

Marina never becomes a second vault and never persists Flywheel access capabilities. On restart it
reconciles opaque binding metadata against Flywheel, just as it does sandbox lifecycle state.

## Acceptance tests

- No provider, Git, registry, cloud, or storage secret appears in Marina DB exports, artifacts,
  command arrays, process listings, guest files, Git remotes, logs, or model prompts.
- A binding cannot be used by another entity, session, sandbox, project, host, path, method, or after
  expiry/revocation.
- Public/credential-free work remains available with no broker configuration.
- Broker failure never falls back to raw credential injection or host execution.
- Hibernate/resume reconciles bindings; stop revokes them before deleting the workspace.
- Private clone and package install have live cross-product tests proving both success and negative
  isolation cases.
