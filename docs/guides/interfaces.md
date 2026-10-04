# Dashboard, desktop and terminal

Marina's interfaces are views onto a living world. A coding task can continue while you read
messages, inspect a published panel or follow another participant. The browser, desktop and
terminal share server command, identity and resource contracts; their presentation differs.

| Capability | Browser dashboard | Electrobun desktop | Terminal/TUI |
|---|---|---|---|
| World commands, login and context | WebSocket, inline discovery and context UI | Same dashboard source; shared participation handler over native RPC | Current WebSocket SDK and world commands |
| Coding tasks and verification | Coding desk and chat | Same dashboard components | Coding view, `/status`, `/verify`, `/review` |
| Messages and other participants | Chat and participant Streams | Same dashboard components | World view alongside Coding, unread indicators |
| Published panels | Interactive resource panels and canvas placement | Bundled dashboard renderer | Text projection and supported actions through `/panel` |
| Spatial layout and rich media | Browser canvas, tiling and media | Same UI bundle, native-webview support varies | No pixel/HTML canvas parity; inspect the same authorized resources |
| Deployment | Browser connects to a server | Embedded local engine or remote-server mode | Start locally or connect to a server |

Published panel definitions select supported resources/renderers/actions. They are not arbitrary
remote JavaScript. A panel placement does not create a new agent or change a coding session's
owner. See [published panels](published-panels.md) and [participant routing](participant-routing.md).

## Browser and terminal together

Build the browser bundle from the same checkout as the server:

```bash
bun run dashboard:build
bun run start
# In another terminal, after bun link:
marina connect TerminalResident
```

For project coding, run `marina . --tui` in the project directory. Use `--url` as documented in
[Coding](coding.md) when connecting to an existing world. F6 switches Coding/World, F7 opens
pending requests, and F8 focuses a published panel. `/view` and `/panel` provide alternatives
when your terminal does not pass function keys. These views preserve drafts while events arrive.
Wide TUIs display Coding and World together. F2 cycles automatic, focused and split layouts;
`/layout auto|focus|split` offers the same choice. Focus selects the composer destination, while
each pane retains its own scroll position. Requests and panels can sit beside the World stream.

Use separate residents for independent active clients. Reconnecting the same resident is a
session handoff, not a way to create two independent workers with identical credentials.

## Desktop development and packaging

```bash
bun install --frozen-lockfile
cd marina-desktop
bun run sync
bun run typecheck
bun run test
bun run build:dashboard
bun run start
```

The desktop Vite build consumes `dashboard/src`, not a separately maintained UI. Its app version
comes from `marina-desktop/package.json`; the bundled Bun version comes from `.bun-version`.
The local chat bridge and WebSocket server use the same handler for onboarding, capability
discovery, context previews, correlated commands and explicit coding session/run targets.
The local host drains work before closing persistence. Native socket relays detach their
listeners when closed; a late connection response cannot reopen a closed view.

Desktop packaging uses **Electrobun 2.0.2** and Hutch's generated SDK. Marina retains its
Bun main process and packages the exact `.bun-version` runtime through a verified pre-packaging
hook. The v1 FFI patch is removed. Release CI targets Apple Silicon macOS, Windows x64 and
Linux x64; v2 does not distribute an Intel Mac toolchain. On Intel Macs, use the web dashboard
or terminal. The Linux native smoke test uses an isolated database and checks startup,
participation and graceful shutdown. See the [desktop development notes](../../marina-desktop/README.md)
for prerequisites, SDK synchronization, runtime provenance and release validation.

The shared UI source and passing protocol tests do not certify every desktop platform. Before
distributing an installer, validate native startup, reconnect, Coding desk/targeted commands,
context, live canvas updates, assets, shutdown/reopen, signing and updates on each target OS.
The repository's native FFI tests stub the OS window library; they do not launch an actual window.
Remote mode uses the selected server's dashboard/version. Bundled local mode uses the packaged
build; rebuild it to pick up UI/backend changes. An update feed and signing must be configured
for a release—they are not enabled by a source checkout.

## Verify interface changes

The backend participation and coding-target tests protect the shared execution contract;
desktop bridge tests exercise native RPC without opening a window. Dashboard component tests
and Playwright journeys cover browser interaction. Terminal tests cover rendering, input and
panel actions. Use [Testing](testing.md) for the supported runners, and [Release qualification](release-qualification.md)
for the full release process. Keep these checks alongside any interface-specific change.
