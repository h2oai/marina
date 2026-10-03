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
Tool-based clients can also select `commandGrammar: "world"` to keep canonical commands such as
`memory`, `tell` and `look` working while the resident is in Code Mode. This requires the server's
`worldCommandProtocol: "slash-v1"` advertisement and fails before sending on unsupported servers.
Human clients keep the default `"modal"` grammar. Structured `memoryService()` calls select world
grammar automatically on current servers, so memory access never becomes a coding task.
Marina’s internal agents use this setting so unconfirmed observations cannot become tool evidence.
Plain WebSocket commands without `request_id` remain supported by current servers.

For supported coding operations, `command(text, { codingTarget: { sessionId, runId? }, signal? })`
addresses a session without selecting it. For example:

```typescript
await agent.command("code status", { codingTarget: { sessionId: "code_session_id" } });
```

The caller must own the session or be its bound coding agent. An optional `runId` must still be
the active attempt when execution starts. Existing gates and writer locks apply. Targeted requests
require explicit `code …` input and server advertisement of `codingTargetProtocol: "session-run-v1"`;
the SDK refuses unsupported servers before sending. Selection changes, settings, recruitment and
lifecycle commands do not accept a target. Untargeted commands and the `command(text, signal)`
signature remain supported. See the repository's coding guide for the supported operations.

## Published panels and Coding desks

`MarinaPanelClient` uses the existing Canvas HTTP API with the caller's credential.
`codingDesk()` creates a validated A2UI document for an existing Marina coding session:

```typescript
import { codingDesk, MarinaPanelClient } from "@marina/agent-sdk";

const panels = new MarinaPanelClient({ url: marinaUrl, token: residentToken });
const catalog = await panels.resources(); // Shared with canvas resources and the dashboard
const node = await panels.publish(canvasId, codingDesk({
  sessionId,
  // Optional: taskId, participantId, title.
}));
const current = await panels.get(canvasId, node.id);
```

Use IDs from your Marina instance. The desk includes coding activity, recorded checks, a reviewed
request composer, optional task evidence and participant messaging, and world activity. Publishing
does not start a worker. Opening or closing the view does not control its lifecycle.

`get()` reads a publication; `revise(canvasId, nodeId, revision, document)` rejects stale revisions.
`watchChanges(onEvent, onReconnect)` returns an unsubscribe function and uses the authenticated
dashboard WebSocket. Events are invalidation hints: reread affected resources with the reader's
credential, including after reconnect, rather than treating notices as resource contents.

Public definitions should reference private resources instead of copying their contents. Source
IDs confer no authority; reads and reviewed actions retain their normal server permissions.
See [Published panels](../../docs/guides/published-panels.md) for source types, document limits,
action contracts, browser layouts and terminal controls.

These clients and helpers are exported from `./index.ts`.

Catalog references (`{kind: "resource", resource: "coding.session", params: {id: sessionId}}`) can supply component bindings or Resource views. The source reads the existing API as the viewer. Use `codingDesk` for rich coding activity and reviewed, explicitly targeted requests, whether the repository is Marina itself or another project.
