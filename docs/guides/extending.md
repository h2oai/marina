# Extending Marina

Use a command extension when you need a new verb, an external world when you need
different content, and the SDK when your agent can run as a separate process.
Extensions and worlds execute trusted host code. Only operators choose their paths;
command rank and safety gates still apply to callers. This API reduces dependencies
on Engine internals; it is not a JavaScript sandbox.

## Commands and resolvers

Create a directory with `marina-plugin.json`:

```json
{ "name": "hello", "version": "1.0.0", "apiVersion": 1, "entry": "index.mjs" }
```

```js
// index.mjs
export default {
  activate(context) {
    context.registerCommand({
      name: "hello", help: "Greet the current caller", minRank: 0,
      run(caller) { caller.reply(`Hello, ${caller.caller.name}`); }
    });
    context.registerWidget({
      id: "health", title: "Instance readiness", slot: "sidebar", source: "readiness"
    });
    return () => { /* stop extension resources here */ };
  }
};
```

Set `MARINA_PLUGINS=./plugins/hello` and start Marina. Multiple directories are
comma-separated. The loader validates API version 1, command permissions and all
names/aliases before registration. A collision fails startup and unwinds registrations;
extensions cannot replace builtins or remove another owner's commands. Shutdown aborts
`context.signal`, calls cleanup and removes registrations. Timers and external clients
must honor that signal or be closed by cleanup.

Types are exported by `@marina/agent-sdk`: `MarinaExtension`, `ExtensionContext`,
`ExtensionCommand`, `ExtensionResolver`, and `ExtensionWidget`. Resolver callbacks
receive arguments and the previous sample, without Engine or database access.
Commands receive a caller snapshot, room ID, reply callback and `durableMemory.run(request)`.
The memory API binds the caller to its durable world account; it does not grant another
owner's records or bypass space ACLs. New fields are additive within API version 1;
removing or changing existing contracts requires a new version.

Two optional federation hooks exist for extensions that host or join gated worlds
(for example the separately installed `extensions/marina-market`). With neither
registered, the gateway handshake is unchanged:

- `registerGatewayAdmission(check)`: an inbound peer's `gateway_auth` may carry an
  opaque `entitlement`. The check runs only after the `GATEWAY_SECRET` comparison
  and can only refuse; it never admits a peer the secret refused. While a check is
  registered, a `Gateway_` login waits for its verdict. A missing proof, a throw,
  a malformed verdict or a 15 s timeout refuses the peer.
- `registerGatewayProof(provider)`: returns the JSON value this instance sends as
  `entitlement` when it dials a peer (`undefined` sends nothing).

Each hook can be registered once per instance and is removed on shutdown. Like
`GATEWAY_SECRET`, the admission check gates the gateway handshake only. A hard
boundary also needs `MARINA_AUTH=better-auth` without open login.

Widgets render escaped text from the existing authenticated `world` or `readiness`
endpoints. Slots are `sidebar` and `admin-tab`; the latter is listed only to operators.
No remote component path, HTML injection or private event subscription is accepted.
Trusted, locally bundled React panels use `dashboard/src/lib/panel-registry.tsx`.
The builtin composition in `workspace-panels-registry.tsx` uses that same manifest:

```tsx
import { dashboardPanels } from "./lib/panel-registry";
import { HealthPanel } from "./panels/HealthPanel";

const dispose = dashboardPanels.register({
  id: "team-health", title: "Team health", slot: "sidebar", component: HealthPanel,
});
if (import.meta.hot) import.meta.hot.dispose(dispose);
```

Import this setup from the dashboard entry point and rebuild the dashboard. Slots
are `sidebar`, `admin-tab`, and `grid` (grid panels also need positions in the host's
layout presets). `modes` can restrict a grid panel to `workspace` or the deprecated
`legacy` layout. Components receive focus props and, for grid panels, world data.
Registration rejects duplicate IDs and string/URL components, returns an owned
cleanup function, and updates mounted slots. Fetch data through the authenticated
API helpers; a panel slot is not authorization. Server extension manifests never
resolve to React components. This requires local source in the dashboard bundle.

Existing `build command` remains available for governed, database-backed command
creation and reload. Those commands have separate ownership from installed extensions.

## World packages

`MARINA_WORLD` accepts a builtin slug, `./a-directory`, an absolute module path, or
`npm:@myorg/my-world`. The npm form resolves an already-installed package from the
instance directory; startup never downloads a package. A directory can specify
`marinaWorld` or `main` in `package.json`, otherwise it loads `index.ts`.

The module exports a default `WorldDefinition` with `name`, `startRoom`, `rooms`,
`quests`, and `guideNotes`. Relative `roomsDir` resolves beside its entry module.
Start with the small `worlds/empty.ts` definition, then add rooms. `seed` must be
idempotent; `afterAgentsReady` remains an optional trusted lifecycle hook.
`test/extensions.test.ts` contains runnable directory and installed-package fixtures.

## A first contribution

Read the invariants in `CLAUDE.md`, then choose one boundary:

- Command behavior: `src/engine/commands/`, wired through the appropriate domain in
  `src/engine/registrations/`.
- Durable memory API: `src/memory/` and `src/sdk/memory-client.ts`. New writes use
  `durableMemory.run`; numeric-note authoring is deprecated. Existing adapters
  preserve owner and pool predicates and commit synchronously with canonical records.
- Auth/session policy: `auth-coordinator.ts`; command authorization and execution:
  `command-phase-coordinator.ts`; scheduling: `command-coordinator.ts` or `tick-scheduler.ts`.
- UI navigation: `use-dashboard-navigation.ts`; panel composition: the panel registry.

Run the affected test files while iterating, then `bun run typecheck`, `bun run lint`
and the required release checks. A migration count is history, not a requirement to
memorize old SQL: append a new migration and include a populated upgrade fixture.


Canonical extension memory example:

```js
context.registerCommand({
  name: "keep-evidence", help: "Save a durable memory", minRank: 0,
  async run(caller, text) {
    const saved = await caller.durableMemory.run({
      operation: "remember", input: { content: text },
    });
    caller.reply(`Saved record ${saved.result.id}`);
  },
});
```

The same `durableMemory` interface is available in dynamic `CommandContext`. Unlike
`ctx.notes.add`, it returns a service receipt asynchronously and writes no legacy copy.
