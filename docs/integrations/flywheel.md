# Flywheel control-plane integration

Marina can drive a separately deployed Flywheel through the dependency-free
Connect/JSON client in `src/integrations/flywheel.ts`. This is an additive
fleet/execution integration; it does not change Marina's default local coding
runtime. When `FLYWHEEL_TOKEN` is set, Marina registers the identity-scoped
`flywheel` MCP tool.

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
- Always stop the sandbox in cleanup, including after failed execution.
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

The MCP lifecycle plus durable reconciliation is the shipped control-plane
baseline. Code Mode routing and project materialization are specified by the canonical
[Code Mode × Flywheel execution plan](../design/code-flywheel-execution-plan.md).

The same manager is available through Code Mode:

- `code sandbox status`
- `code sandbox start [image]`
- `code sandbox hibernate|resume`
- `code sandbox use` — explicitly select Flywheel for the active coding session
- `code sandbox local` — explicitly return that session to host-safe local execution
- `code sandbox stop confirm`

Mutating actions require the existing `code.exec` competence gate. Stop is
destructive and requires the literal confirmation. Execution changes only when
an active session explicitly uses `code sandbox use`. Merely configuring
Flywheel cannot alter existing runs, and a
Flywheel failure never retries on the host. Sandbox runs retain normalized
command output plus typed Flywheel event-kind evidence. Deadlines abort the
`Exec` stream; Flywheel binds that cancellation to the exact sandbox process,
so timed-out work is stopped remotely rather than detached. Unknown terminal
outcomes still fail closed.
