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
Commands receive a caller snapshot, room ID and reply callback. Add capabilities
through an explicit API version change instead of importing private engine modules.

Widgets render escaped text from the existing authenticated `world` or `readiness`
endpoints. Slots are `sidebar` and `admin-tab`; the latter is listed only to operators.
No remote component path, HTML injection or private event subscription is accepted.
The internal panel registry is `dashboard/src/components/workspace-panels-registry.tsx`.

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
- Durable memory API: `src/memory/` and `src/sdk/memory-client.ts`. Use compatibility
  bridge entry points for existing numeric notes; preserve owner and pool predicates.
- Scheduling: `command-coordinator.ts` or `tick-scheduler.ts`, with narrow collaborators.
- UI navigation: `use-dashboard-navigation.ts`; panel composition: the panel registry.

Run the affected test files while iterating, then `bun run typecheck`, `bun run lint`
and the required release checks. A migration count is history, not a requirement to
memorize old SQL: append a new migration and include a populated upgrade fixture.
