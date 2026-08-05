# Flywheel control-plane integration

Marina can drive a separately deployed Flywheel through the dependency-free
Connect/JSON client in `src/integrations/flywheel.ts`. This is an additive
fleet/execution integration; it does not change Marina's default local coding
runtime and is not yet registered as an MCP tool.

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
- A future Marina command/MCP adapter should translate stable world identity to
  session ownership and persist only Flywheel IDs, not bearer tokens.
