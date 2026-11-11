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
```

In another terminal, after `bun run setup:cli`:

```bash
marina connect TerminalResident
```

For project coding in a fullscreen terminal, use the [terminal workspace](#terminal-workspace-tui).

Use separate residents for independent active clients. Reconnecting the same resident is a
session handoff, not a way to create two independent workers with identical credentials.

## Terminal workspace (TUI)

The terminal workspace is a fullscreen view for coding in a project folder. It keeps the
coding conversation, the World conversation, pending requests and a published panel in panes
around one composer. Your coding task keeps running while you read or reply in the World.
It is the coding view of the dashboard, not all of it; see [what it does not show](#what-the-tui-does-not-show).

### Start it

Install the `marina` command once from the checkout (`bun install`, then `bun run setup:cli`).
Then run one of these. Start a local Marina for this folder and open the workspace:

```bash
cd /path/to/project
marina --tui
```

The same, from the Marina checkout:

```bash
bun run code /path/to/project --tui
```

Attach to a world that is already running (missing values are prompted for):

```bash
marina attach --tui
```

Or name the world, the participant and the session:

```bash
marina attach ws://localhost:3300/ws --name Builder --session <id> --tui
```

Open straight into a use-case mode (implies `--tui`):

```bash
marina --mode operate
```

`--tui` works with the other coding options, such as `--agent claude|codex|pi`, `--model` and
`--driver crew`. See [Coding](coding.md) for those options. Without `--tui` you get the scrollback
terminal, which has the same controls on the normal screen. The workspace needs an interactive
terminal. One-shot `-p`, pipes and redirected output keep plain text. `NO_COLOR=1` turns off colour.

### The layout

| Area | What it shows |
|---|---|
| Header | The tabs **Coding · World · Requests · Panel**, with unread counts on tabs you are not looking at |
| Coding pane | Your coding session: the agent's replies, tool activity, checks and review results |
| World pane | Messages, tells and world command output. Reply here without leaving your task |
| Requests (F7) | Questions and held actions waiting for your answer. A new request never takes over your draft |
| Panel (F8) | A text view of a [published panel](published-panels.md), with its fields and actions |
| Composer | One line editor for each conversation, with the destination named above it |
| Footer | Folder, status and the keys |

The pane marked `●` receives your input. Each pane keeps its own scroll position, and each
conversation keeps its own draft and history when you switch.

### Modes

A mode arranges the screen for one kind of work and leaves out the rest. Switching modes never
starts, stops or changes a worker: the coding session keeps running in every mode. Press **F3**
to cycle, type `/mode <name>`, or start with `--mode <name>`.

| Mode | Shows | The composer starts in |
|---|---|---|
| `coding` (default) | The coding conversation alone. The World is cut down to one line above the composer: the latest message addressed to you (a tell, or a message naming you), with a count. F6 opens the full World and clears it | Coding |
| `operate` | A live board beside the World: Attention (requests to answer, held actions, alerts), Agents, Spend and Status. It shows the same data as the dashboard, refreshed every few seconds. Shift+PageUp / Shift+PageDown scroll the board | World, for commands such as `challenge approve <token>` or `agent stop <name>` |
| `coordinate` | Who is working on what, beside the World. **Streams** lists participant sessions (Claude, Codex, pi …) with the ones asking you or failing first. **Tasks** lists open and claimed tasks with the ones waiting for your review first. Streams needs a signed-in world account | World, for `tell <name> <message>` and `task approve <id> <claimant>`; `/agents` and `/use` reach native sessions |
| `memory` | Curating what the world knows. **Dreams** lists recent dreams with the proposals waiting for you first. **Memory** shows counts only: unresolved contradictions, stale and duplicate records, records with sources, open memory jobs. Both are scoped to what you may see | World, for `memory recall <query>`, `memory dream adopt <id>` and `note conflicts` |
| `investigate` | After the fact. **Traces** lists recent execution traces, with failed runs and failed checks first; it needs operator read, and otherwise says so. **Feed** shows the activity feed, newest first | World, for `trace show <id>`, `trace find status=failed` and `feed list since:2h` |

In `coding`, `/layout split` (or F2) still puts the whole World beside Coding when you want it.
In every mode but `coding` the board sits beside the World from 80 columns; narrower, the World is shown alone.
More modes for other kinds of work are planned.

### Keys

| Key | Action |
|---|---|
| F1 | Help |
| F2 | Cycle layouts: auto, focus, split (`/layout auto\|focus\|split`) |
| F3 | Cycle modes (`/mode coding\|operate\|coordinate\|memory\|investigate`) |
| Shift+PageUp / Shift+PageDown | Scroll a mode's board |
| F6 | Switch the composer between Coding and World |
| F7 | Open pending requests |
| F8 | Focus the published panel. Tab / Shift+Tab move between fields, Space toggles, Enter reviews |
| Alt+Left / Alt+Right | Switch panel views |
| PageUp / PageDown | Scroll the focused pane |
| Alt+Up / Alt+Down | Load an older or newer page of local history (`/view older`, `/view newer`) |
| `/` | Command suggestions. Up/Down to choose, Tab or Enter to insert, Enter again to send |
| Shift+Enter or a trailing `\` | Add a line to the draft. A paste stays a draft until you send it |
| Ctrl+C | Interrupt the worker. A second Ctrl+C exits |
| q or Esc | Close the diff view |
| Ctrl+D | Exit from an empty composer |

If your terminal does not pass function keys, use `/view coding|world|approvals|panel` and `/layout`.
Exiting restores your shell and does not print unsent drafts.

### Slash commands

`/help` shows the essentials and `/help all` lists every control. The ones used most:

| Command | Does |
|---|---|
| plain text, `/task <request>` | Start or continue a coding task. `/task` works toward a verified candidate |
| `/plan <request>` | Research and propose, without writing files |
| `/diff`, `/checks`, `/review` | See what changed, run the project's checks, review the result. `/diff` opens a scrollable diff view |
| `/status`, `/project` | Session, workspace and model; project readiness and how it is verified |
| `/agents`, `/spawn claude\|codex\|pi`, `/use`, `/stop` | Native agents in their own Git worktrees |
| `/continue`, `/resume <name-or-id>` | Resume this folder's Marina session or a recorded native session |
| `/model [<id>]`, `/fast`, `/harness` | Show or switch the model and runtime |
| `/cost`, `/compact` | Today's spend against the cap; compact the context now |
| `/live [status\|agents\|spend\|alerts\|readiness\|world\|me]` | The dashboard's live data, drawn as a card in the focused pane |
| `/world <command>` | Run any world command, such as `task list` or `memory recall …` |
| `/memory [save <line> \| recall <query>]` | Save to this folder's memory, or recall from it |
| `/panel …` | Open, use and close [published panels](published-panels.md) |
| `/dashboard` | Open the browser dashboard signed in, on the same world |
| `/quit` | Exit. A connected world keeps running |

### What the TUI does not show

Some dashboard views have no pane yet. You can still reach most of their data as text with
`/world <command>` or `/live`, or with `/dashboard`:

| Dashboard view | In the terminal |
|---|---|
| Participant Streams | `coordinate` mode, or `/live streams`; `/agents` and `/use` for native agents |
| Memory workspace, dreams | `memory` mode, or `/live dreams`, `/live memory`; `/memory`, `/world memory dream log` |
| Traces, logs, activity feed | `investigate` mode, or `/live traces`, `/live feed`; `/world trace …`, `/world feed list …`. Logs stay in the browser |
| Ops, health, spend | `operate` mode, or `/live status`, `/live readiness`, `/live alerts`, `/cost` |
| Canvas, media, Admin settings | Browser dashboard only |

`marina connect` is the world REPL. It uses the scrollback screen and has no fullscreen mode.

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

Desktop packaging uses **Electrobun 2.0.5** and Hutch's generated SDK. Marina retains its
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
