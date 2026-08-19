# Flywheel isolated execution integration

Marina can drive a separately deployed Flywheel through the dependency-free
Connect/JSON client in `src/integrations/flywheel.ts`. This is an additive
fleet/execution integration; it does not change Marina's default local coding
runtime. When `FLYWHEEL_TOKEN` is set, Marina registers the identity-scoped
`flywheel` MCP tool.

## Preview setup from a clean machine

> **Availability**: Flywheel is currently in private preview — the repository below requires
> access granted by H2O.ai. Without it, skip this integration entirely; Marina runs fully without
> Flywheel (Code Mode simply reports sandbox execution as unavailable rather than falling back to
> host execution).

Flywheel's current preview-supported target is Linux x86_64 with Docker. Start its independently
deployed stack using Flywheel's launcher (rather than copying its Compose settings into Marina):

```bash
git clone https://github.com/h2oai/flywheel.git   # private preview — requires access
cd flywheel
./scripts/preview-up.sh marina
```

Save the generated one-time password, then exchange it for the operator token that Marina keeps
server-side:

```bash
read -rsp 'Flywheel password: ' FLYWHEEL_PASSWORD; echo
FLYWHEEL_TOKEN="$(curl --fail --silent --show-error \
  -X POST http://localhost:8088/api/auth \
  -H 'content-type: application/json' \
  --data "$(jq -n --arg login marina --arg password "$FLYWHEEL_PASSWORD" \
    '{login: $login, password: $password}')" | jq -er .token)"
unset FLYWHEEL_PASSWORD

cd ../Marina
FLYWHEEL_TOKEN="$FLYWHEEL_TOKEN" \
FLYWHEEL_RPC_URL=http://localhost:8088/rpc \
bun run start
```

Flywheel's preview launcher currently builds local images, so Marina's existing default
`localhost/h2oai/flywheel-agentd:latest` applies to that path. Set `FLYWHEEL_IMAGE` explicitly for
a remote registry or a separately versioned deployment. Docker is the baseline backend and does
not support hibernation; crosvm and vfkit remain experimental. Publication is also experimental in
the current Flywheel preview, so do not make it a baseline Marina readiness claim.

Before enabling the integration for users, run the baseline live qualification described below.
It proves the actual configured endpoint, token, image, cancellation behavior, archive transfer,
and teardown rather than assuming protocol compatibility from unit tests.

Keep the operator token in Marina. The current first-pass product boundary is one
durable Flywheel session/sandbox per Marina entity; coding sessions and projects
are contexts within that entity workspace. Mint a short-lived capability bound
to the Flywheel session for the entity that owns it:

```ts
import { FlywheelClient } from "../../src/integrations/flywheel";

const operator = new FlywheelClient({
  baseUrl: process.env.FLYWHEEL_RPC_URL ?? "http://localhost:8088/rpc",
  token: process.env.FLYWHEEL_TOKEN!,
});

const { sessionId } = await operator.createSession();
const capability = await operator.mintCapability({
  sessionId,
  scopes: [
    "sandbox:create",
    "sandbox:exec",
    "sandbox:read",
    "sandbox:stop",
    "sandbox:hibernate",
    "publish",
  ],
  ttlSeconds: 600,
});
const agent = new FlywheelClient({
  baseUrl: process.env.FLYWHEEL_RPC_URL ?? "http://localhost:8088/rpc",
  token: capability.token,
});
```

The client supports session/capability creation, sandbox creation, streamed
execution events, publishing, VM hibernation/resume, and teardown. Hibernation
is available only on crosvm/vfkit, preserves the writable filesystem but not
RAM or processes, and requires a `keepAlive` sandbox.

## Production boundary

- Never expose the operator token to an agent or browser.
- Bind capabilities to one Flywheel session and use the shortest practical TTL.
- Prefer hibernation for an idle durable entity sandbox: it preserves the writable disk but ends
  processes. Stop only for explicit teardown after work is exported or deliberate data loss is
  confirmed.
- Treat publish URLs as externally reachable and unpublish/stop them promptly.
- The MCP adapter maps stable world identity to durable Marina bindings and
  reconciles them against Flywheel's registry at startup. Bindings contain IDs,
  lifecycle state, image, and publication metadata—not credentials.
- Neither the operator token nor attenuated capability tokens are returned to
  clients or persisted. With no `FLYWHEEL_TOKEN`, no manager or outbound
  Flywheel connection is created and local Code Mode remains unchanged.

## MCP lifecycle

Call `flywheel` after `login` with one of these actions:

- `create` — optional `image` and `keep_alive` (defaults true)
- `exec` — `command`, optional `args` and `cwd`; returns streamed process output
- `publish` — `port`; returns the public URL
- `status` — reports the current entity binding without contacting Flywheel
- `hibernate` / `resume` — VM backends only
- `stop` — tears down the sandbox and removes the entity binding

The MCP tool is the low-level control-plane surface. Its `stop` action does not run Code Mode's
dirty-project/export check; use `code sandbox stop confirm` (or `discard confirm`) for coding
workspaces unless destructive teardown is intentionally being handled by the caller.

The MCP lifecycle plus durable reconciliation is the shipped control-plane
baseline. Code Mode routing and project materialization are specified by the canonical
[Code Mode × Flywheel execution plan](../design/code-flywheel-execution-plan.md).

The same manager is available through Code Mode:

- `code sandbox status`
- `code sandbox network [status]` — report the profile and whether enforcement is verified
- `code sandbox credentials` — list secret-free logical bindings
- `code sandbox start [image]`
- `code sandbox hibernate|resume`
- `code sandbox use` — explicitly select Flywheel for the active coding session
- `code sandbox local` — explicitly return that session to host-safe local execution
- `code sandbox stop confirm`
- `code sandbox ops inventory|metrics|reconcile` — steward fleet visibility
- `code sandbox ops reclaim [confirm]` — dry-run or apply recoverable idle hibernation
- `code sandbox ops hibernate|revoke|stop <entity-id> ... confirm` — explicit fleet controls
- `code project init <name>` — bootstrap a Git project under `/workspace/projects/<name>`
- `code project clone <public-https-url> [name]` — materialize a public repository
- `code project status|list|diff|switch|export [archive]` — inspect, select, and preserve work
- `code project import <artifact> <name>` — stage, validate, and atomically restore an archive
- `code project delete <id|name> [discard] confirm` — remove with data-loss checks
- `code project reconcile` — remove stale metadata from replacement sandboxes
- `code service start|list|status|logs|stop|restart` — manage guest-native services
- `code service probe <name> [path]` — store bounded localhost HTTP verification evidence
- `code service probes <name> [limit]` — inspect durable health history
- `code service screenshot <name> [path]` — store bounded PNG browser evidence
- `code service publish|revoke` — expose or remove a service with a declared port

Mutating actions require the existing `code.exec` competence gate. Stop is
destructive and requires the literal confirmation. Execution changes only when
an active session explicitly uses `code sandbox use`. Merely configuring
Flywheel cannot alter existing runs, and a
Flywheel failure never retries on the host. Sandbox runs retain normalized
command output plus typed Flywheel event-kind evidence. Deadlines abort the
`Exec` stream; Flywheel binds that cancellation to the exact sandbox process,
so timed-out work is stopped remotely rather than detached. Unknown terminal
outcomes still fail closed.

Project metadata is credential-free and durable in Marina; content remains authoritative on the
Flywheel writable disk. The active guest path becomes the cwd for sandbox-backed Code Mode runs.
Switching refreshes Git status and blocks on unexported changes. Patch export stores a bounded binary
Git patch and refuses untracked files. Archive export carries complete project content over Flywheel's
typed protobuf byte stream; import checks its gzip type and member paths, extracts into a temporary
guest directory, and atomically renames it. Transfer success requires terminal process evidence,
SHA-256, and byte-count agreement. Archive v1 rejects excessive expansion/member counts, links,
devices, FIFOs, sockets, traversal, and unsafe member sizes. Transfers never touch the
Marina host workspace. Private repositories await the credential broker.
The broader Git, registry, model, cloud, storage, signing, and runtime-secret boundary is specified
in the [sandbox credential broker contract](../design/sandbox-credential-broker.md). Flywheel's
current generalized proxy has the right server-side injection model, but its authentication path is
not yet a public binding surface for persistent direct-`Exec` sandboxes; Marina does not route raw
secrets around that gap.

Managed services store only command arrays, ownership, PID/status evidence, declared ports, guest log
paths, process birth identity, and restart recipes in Marina. Status and stop verify PID plus birth
identity and refuse to signal a reused PID. Output is bounded and defensively secret-redacted. Commands
with credential-like arguments or credential-bearing URLs are refused rather than persisted. Guest
processes do not survive hibernation; Marina marks them stopped and retains an explicit restart
recipe. Startup reconciliation treats formerly running processes as unknown until reverified.
Publishing and revocation use Flywheel's versioned public API; publication requires a matching,
one-use network approval and gets a finite automatically revoked lease. The default one-hour lease
can be changed with `MARINA_FLYWHEEL_PUBLICATION_TTL_MS` (minimum one minute).
HTTP probes target only the service's declared loopback port inside its owning sandbox. Screenshot
capture uses a browser installed in that sandbox, validates the bounded transferred PNG, and fails
closed without Chromium or binary-read support.

## Fleet policy and operations

Marina applies standing-neutral global allocation and running-sandbox admission limits. Successful
work refreshes a durable activity timestamp. Idle or absolute-lifetime candidates are automatically
hibernated only when they have neither managed services nor public exposure; writable disks remain
recoverable. Operators can inspect the same decision with a dry run before applying it. Unavailable
allocations appear as review candidates and are never silently forgotten or deleted.

`MARINA_FLYWHEEL_MAX_SANDBOXES`, `MARINA_FLYWHEEL_MAX_RUNNING_SANDBOXES`,
`MARINA_FLYWHEEL_IDLE_HIBERNATE_MS`, `MARINA_FLYWHEEL_ABSOLUTE_LIFETIME_MS`, and
`MARINA_FLYWHEEL_TELEMETRY_RETENTION_MS` tune this layer. Flywheel remains authoritative for VM
CPU, RAM, disk sizing, and backend capabilities. Marina retains bounded operation outcome/latency/
byte-count telemetry and surfaces unavailable sandboxes, failed operations, and public exposure in
the existing `ops` inbox; remote stdout and credential material are excluded.

Production release evidence is generated by the opt-in
[Flywheel live qualification](./flywheel-live-qualification.md). It is independent of the default
test suite and distinguishes baseline backend support from the full clone/service/browser/publish/
hibernate matrix.
