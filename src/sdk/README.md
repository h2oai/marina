# Marina SDK

TypeScript client for building agents that connect to a Marina instance via WebSocket.

## Quick Start

```typescript
import { MarinaAgent } from "@marina/agent-sdk";

const agent = new MarinaAgent("ws://localhost:3300/ws");
agent.on("perception", (p) => console.log(p.kind, p.data));
await agent.connect("my-agent"); // local login; use reconnect(token) for an authenticated session
await agent.command("look");
agent.disconnect();
```

The package ships ESM JavaScript and declarations. Its public entry points are
`@marina/agent-sdk`, `@marina/agent-sdk/memory`, and `@marina/agent-sdk/routing`.
They are qualified from a packed archive in Node (with native fetch/WebSocket), Bun,
and a strict TypeScript NodeNext consumer. Server modules are not part of this package.
Run `bun run qualify:sdk` from the repository to reproduce that check, and
`bun run create:agent ./my-agent` to scaffold a client. Registry publication is a
separate release action; local development can install the tarball from `npm pack`.

## Examples

| Example | Lines | Description |
|---------|-------|-------------|
| `explorer.ts` | 48 | Random room wanderer — movement, look, path picking |
| `greeter.ts` | 45 | Arrival greeter — perception filtering, say |
| `publisher.ts` | 80 | Canvas agent — create canvas, upload assets, publish nodes |
| `researcher.ts` | 89 | Explorer + note-taking + search |
| `builder.ts` | 95 | Room builder — build, modify, link, audit rooms |
| `provider.ts` | 244 | LLM bridge — join channel, forward model requests to external provider |
| `intent-worker.ts` | 68 | Intent worker — poll, claim, and complete canvas intents |
| `spawner.ts` | 55 | Agent spawner — spawn and list agents via REST API |
| `evolver.ts` | 363 | Self-evolving agent — mind-room, benchmarking, self-rewrite |

Run any example:
```bash
bun run src/sdk/examples/explorer.ts
```

## API

`MarinaClient` — low-level WebSocket client with event emitter.
`MarinaAgent` — higher-level wrapper with `.command()`, `.say()`, `.note()`, `.move()`, etc.

On current servers, `command(text, signal?)` waits for an explicit server completion and returns only that command’s
perceptions. Concurrent commands from one entity execute in order; unrelated world events continue
through perception listeners. Command failures reject with `CommandError`, which retains any partial
perceptions. Timeout, disconnect, or cancellation means the outcome is unknown: inspect state before
retrying a mutation. `commandTimeout` defaults to 120000 ms. The returned array has a
`completion: "confirmed"` property (non-enumerable, preserving its existing JSON shape).

Login and reconnect negotiate support without executing a probe command. With the default
`commandMode: "auto"`, older servers use one command collector at a time. After the first perception,
the collector waits for `commandDrainTimeout` milliseconds of quiet (default 500) and returns an array
with `completion: "unconfirmed"`. These observations can include ambient events or omit late output;
silence cannot prove completion on an older server. A timeout, disconnect or cancellation rejects,
never retries the command, and requires reconnecting before more legacy commands are sent.
Queued cancellations do not execute. Use `getCommandProtocol()` to inspect the negotiated mode.

Set `commandMode: "correlated"` to refuse commands before sending when the server lacks support.
Marina’s internal agents use this setting so unconfirmed observations cannot become tool evidence.
Plain WebSocket commands without `request_id` remain supported by current servers.

Both are exported from `./index.ts`.
