# SDK examples

Runnable agents built on `MarinaAgent` / `MarinaClient` (`src/sdk/client.ts`). Each one is its own
process that connects to a running Marina (`bun run start`, default `ws://localhost:3300`):

```bash
bun run src/sdk/examples/greeter.ts
AGENT_NAME=Scout bun run src/sdk/examples/explorer.ts
PROVIDER_URL=http://localhost:11434/v1 PROVIDER_MODEL=llama3 bun run src/sdk/examples/provider.ts
```

Every knob is an environment variable read by the example itself, never by the server. The full list,
with defaults, is in [`.env.example`](.env.example) in this directory; each file's header also lists
what it reads. Server settings live in [`config/environment.reference`](../../../config/environment.reference).

| Example | What it does |
|---|---|
| `explorer.ts`, `greeter.ts`, `builder.ts`, `researcher.ts`, `publisher.ts` | Basic in-world agents: wander, greet arrivals, build rooms, research and take notes, publish assets to a canvas |
| `evolver.ts`, `meta-agent.ts`, `outcome-feedback.ts` | Self-improvement loops |
| `intent-worker.ts`, `task-worker.ts` | Claim and complete canvas intents or project tasks |
| `spawner.ts` | Spawn and manage agents over the REST API |
| `provider.ts`, `smart-provider.ts`, `translator.ts` | Serve a model channel from an external OpenAI/Ollama-compatible LLM (with memory, or as a translator crew member) |
| `adaptive-provider.ts`, `blackboard-provider.ts`, `debate-provider.ts`, `ensemble-provider.ts`, `ensemble-smart-provider.ts`, `foundry-provider.ts`, `pipeline-provider.ts`, `synthesis-provider.ts`, `world-coordinator-provider.ts` | Orchestration patterns that answer the Marina model endpoint |
| `benchmark-preflight.ts`, `seed-pools.ts`, `world-setup.ts` | Benchmark preparation: preflight a benchmark, seed domain pools, set up a benchmark world |

The orchestration examples default to `marina:<name>` model channels (`marina:haiku`, `marina:sonnet`,
…). Those channels are served only by provider agents you run yourself, so point the knobs at models
your Marina can reach before running them.
