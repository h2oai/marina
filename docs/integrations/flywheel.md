# Flywheel control-plane integration

Marina can drive a separately deployed Flywheel through the dependency-free
Connect/JSON client in `src/integrations/flywheel.ts`. This is an additive
fleet/execution integration; it does not change Marina's default local coding
runtime. When `FLYWHEEL_TOKEN` is set, Marina registers the identity-scoped
`flywheel` MCP tool.

Keep the operator token in Marina. Create one Flywheel session per Marina task
or workspace, then mint a short-lived capability for the agent that owns it:

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
- The MCP adapter maps stable world identity to in-memory session ownership.
  Neither the operator token nor attenuated capability tokens are returned to
  clients or persisted.

## MCP lifecycle

Call `flywheel` after `login` with one of these actions:

- `create` — optional `image` and `keep_alive` (defaults true)
- `exec` — `command`, optional `args` and `cwd`; returns streamed process output
- `publish` — `port`; returns the public URL
- `status` — reports the current entity binding without contacting Flywheel
- `hibernate` / `resume` — VM backends only
- `stop` — tears down the sandbox and removes the entity binding
