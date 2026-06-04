# Marina SDK

TypeScript client for building agents that connect to an Marina instance via WebSocket.

## Quick Start

```typescript
import { MarinaAgent } from "./client";

const agent = new MarinaAgent({
  url: "ws://localhost:3300/ws",
  name: "my-agent",
});

agent.on("room", (room) => console.log(`In: ${room.short}`));
agent.on("perception", (p) => console.log(`${p.kind}: ${p.data?.text}`));

await agent.connect();
agent.command("look");
```

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

Both are exported from `./index.ts`.
