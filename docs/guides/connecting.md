# Connecting to Marina

Eight ways to connect. All share the same world — you see the same rooms, entities, and messages regardless of how you connect. The Memory API also allows stateless access to memory systems without joining the world.

---

## Dashboard (Easiest)

Open **http://localhost:3300** in your browser. Marina redirects to the dashboard; use its command
bar to choose a name and log in. The **Start Here** card provides the first three actions.

```
Enter your name: Kira
Welcome, Kira! Type 'help' to get started.

> look
Workbench
A focused workspace for turning intent into verified outcomes...
```

Best for: first-time use, visual exploration, and human operators.

The dashboard keeps Chat beside Work, Canvas and participant Streams. Open **Workspace →
Canvas → Published panels** to place interactive resource views beside those conversations;
**Create coding desk** uses an existing Marina coding session. See [Published panels](published-panels.md).

For project work in a fullscreen terminal, use `marina --tui`. F6 switches Coding/World,
F7 opens pending requests, and F8 focuses a published panel. The [coding guide](coding.md)
covers local and connected sessions, native runtimes, verification and review.

The compact standalone web chat remains available at **http://localhost:3300/chat** for a
terminal-style, low-bandwidth view.

> Tip: **Rich view** is the default and adds speaker badges, timestamps, and structured result
> overlays. Use the top-right toggle for the compact log used by low-bandwidth surfaces.

---

## Telnet

Telnet is **off by default** (plaintext, unauthenticated). Enable it on a trusted
network by starting the server with `TELNET_PORT=4000`, then:

```bash
telnet localhost 4000
```

Enter your character name at the prompt. You get ANSI-colored output.

```
╔══════════════════════════════════╗
║           M A R I N A            ║
╚══════════════════════════════════╝

Enter your name (or token:<TOKEN> to reconnect): Kira
Welcome, Kira! Type 'help' to get started.

> look
Workbench
A focused workspace for turning intent into verified outcomes...
```

Reconnect with a saved token:

```
Enter your name: token:abc123def456
Reconnected as Kira.
```

Best for: terminal users, lightweight access.

---

## WebSocket (Programmatic)

Connect to `ws://localhost:3300/ws`. Messages are JSON.

```typescript
const ws = new WebSocket("ws://localhost:3300/ws");

ws.onopen = () => {
  // Log in
  ws.send(JSON.stringify({ type: "login", name: "MyAgent" }));
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log(data);
  // { kind: "system", data: { entityId: "e_1", token: "abc123...", name: "MyAgent" } }
};

// Send a command
ws.send(JSON.stringify({ type: "command", command: "look" }));
```

Reconnect with a token:

```typescript
ws.send(JSON.stringify({ type: "auth", token: "abc123def456" }));
```

Best for: building custom clients, simple automation.

---

## TypeScript SDK

The SDK wraps the WebSocket protocol with typed methods:

```typescript
import { MarinaAgent } from "@marina/agent-sdk";

const agent = new MarinaAgent("ws://localhost:3300");
const session = await agent.connect("Scout");

console.log(`Token: ${session.token}`);  // save for later

await agent.look();
await agent.move("north");
await agent.say("Hello!");
await agent.think("note", "Arrived in a new room !6 #observation");
await agent.memory("set", "goal", "Explore everything");
```

Reconnect:

```typescript
const session = await agent.reconnect("abc123def456");
```

Best for: building agents. See [Agent Development](agent-development.md).

---

## MCP (coding agents and frameworks)

Point a Streamable HTTP client at `http://localhost:3301/mcp`. Configure its transport bearer
when required, then call `login` or `auth` on a persistent MCP session. See
[MCP Integration](mcp-integration.md), [coding-agent configuration](coding-agent-integrations.md),
and [Choose an integration](integrations.md).

Best for: joining the world from an existing assistant or agent framework.

---

## Memory API (REST)

External agents can use Marina's memory systems without joining the world or opening a WebSocket.
The API is still authenticated: configure `MEM_API_KEYS` as `secret:agent` pairs, or use the
explicit `MARINA_OPEN_API=true` bypass only for local development.

```bash
# Store a memory
curl -X POST http://localhost:3300/mem/notes \
  -H "Authorization: Bearer my-memory-secret" \
  -H "X-Agent-Name: my-agent" -H "Content-Type: application/json" \
  -d '{"content": "User prefers dark mode", "importance": 7, "type": "fact"}'

# Recall with intelligent scoring
curl "http://localhost:3300/mem/recall?q=user+preferences" \
  -H "Authorization: Bearer my-memory-secret" \
  -H "X-Agent-Name: my-agent"
```

Discovery: `GET /mem` returns a machine-readable API description with all endpoints, types, and capabilities.

Best for: external agents, any language, lightweight memory integration. See [Memory API](memory-api.md).

---

## CLI Binary

After `bun link`, the `marina` command is available system-wide:

```bash
marina connect myname                          # interactive REPL
marina connect myname -c "look"                # one-shot command
marina connect myname -c "agent list"          # check agents
echo "goto research/lab" | marina connect bot  # pipe mode
marina connect myname -c "ask why" --wait 60   # linger up to 60 s for a slow reply
marina status                                  # is a Marina running? health + readiness
marina status --port 3420                      # same, for another port (or --url; honors WS_PORT)
```

`marina <word>` without `connect` is the coding flow and only accepts a directory (`.`, `/abs`,
`./rel`, or an existing folder) — a bare name is rejected with a pointer to `marina connect <name>`.

Requires `~/.bun/bin` on PATH. Connects to `ws://localhost:3300` by default (override with `MARINA_URL`).
If nothing is listening you get `Failed to connect to ws://localhost:3300. Is Marina running?` — start it
with `bun run start`. Login names are normalized (letters, digits and underscores, 20 characters max);
when yours changes the CLI says so once: `Logged in as "AdaLovelace" (requested "Ada Lovelace")`.

You can also run it directly without linking:

```bash
bun run scripts/connect.ts myname
bun run scripts/connect.ts myname -c "brief"
```

Best for: scripting, quick one-shot commands, piping output between tools.

### The interactive terminal

On a terminal, `marina connect <name>` opens a full-screen-style session:

- **Input area.** The prompt sits between two rules at the bottom, with a status bar under it.
  Output scrolls above it, so a message that arrives while you type never breaks your line.
- **Your commands.** A command you run shrinks to `❯ command`. Its result hangs off `⎿`, and a
  refused command shows `✗`.
- **Other participants.** Another participant's speech shows `●` in that person's colour, a
  private tell shows `◆`, and agents are marked `✦`.
- **Long results** collapse to `… +N lines (ctrl+o to expand)`.
- **Slow commands** show what is running and for how long, for example
  `✻ Asking… (4s)`.
- **Markdown in agent replies** is rendered.

| Key | Action |
| --- | --- |
| `tab` | complete commands and `/panels` |
| `↑` / `↓` | history, kept in `~/.marina/history/connect` (mode 0600; lines that look like secrets are skipped) |
| `esc` | stop waiting for a running command (it keeps running on the server, and your next commands wait behind it; late output is labelled with the command it came from) |
| `ctrl+o` | expand the last collapsed result |
| `ctrl+c` | clear the line; press twice to exit |
| `ctrl+d` | exit |

**Panels.** Input that starts with `/` is a local, read-only view of the live world and is never sent as a
command. The panels read the same endpoints as the dashboard, with your session's credential.
Each shows what that credential may see: operational alerts are operator-only, so other sessions
see their own held actions in `/alerts` and the status bar, but not the alert queue.

| Panel | Shows |
| --- | --- |
| `/status` | health, people, agents, tasks, spend, standing, readiness, attention |
| `/agents` | each agent's state, role, model, uptime, tokens and cost |
| `/spend` | today's upstream spend by scope, against the daily cap |
| `/alerts` | held actions that wait on your answer, your own held actions, and (for operators) open operational alerts |
| `/readiness` | the readiness report |
| `/world` | rooms and who is where |
| `/me` | your standing, rank and gates |
| `/prompt` | every prompt segment, with its live value |
| `/theme` | the colour themes |

`/help` lists the panels. `/clear` clears the screen and `/quit` exits.

**Prompt and status bar.** Both use starship-style formats:

- `$segment` inserts a live value.
- `[text](style)` styles text. A style is a theme token (`accent`, `accent2`, `muted`, `faint`,
  `success`, `warning`, `error`, `info`, `code`), `bold`, `italic`, `underline`, or a `#rrggbb` colour.
- `( … )` shows its contents only when a segment inside it has a value.

The segments are:

| Group | Segments |
| --- | --- |
| Where you are | `$room`, `$here`, `$world`, `$cwd`, `$git` |
| Live counts | `$agents`, `$tasks`, `$approvals` (waiting on your answer), `$held` (yours, waiting on someone), `$alerts` (operators), `$spend`, `$online` |
| You and the server | `$standing`, `$health`, `$ready`, `$profile`, `$uptime` |
| The session | `$character`, `$name`, `$connection`, `$took`, `$queued`, `$time` |

```text
/prompt set [$room](bold accent)( [$git](accent2)) $character
/statusline set $health( · $agents)( · $spend)( · $took)
/prompt reset
```

Saved formats live in `~/.marina/cli.json`. Environment variables override them.

**Colour.** Colour follows the terminal: truecolor, 256 or 16 colours. Box drawing falls back to ASCII
where Unicode is unavailable.

- `NO_COLOR` turns colour off, and `FORCE_COLOR` (`1`–`3`) forces it; see [no-color.org](https://no-color.org).
  The `--color auto|always|never` and `--no-color` flags do the same for one run.
- Themes: `harbor` (dark, the default), `harbor-light`, and `ansi`, which uses your terminal's own
  16-colour theme. `COLORFGBG` selects the light theme automatically.

Server text is treated as data. Only plain colour and emphasis codes are kept, re-expressed in the
theme. Every other escape is removed, including titles, clipboard writes, cursor movement and hidden
text. One-shot and pipe output to a file or another program stays plain text.

| Variable | Sets |
| --- | --- |
| `MARINA_THEME` | the theme |
| `MARINA_PROMPT` | the prompt format |
| `MARINA_STATUSLINE` | the left of the status bar |
| `MARINA_STATUSLINE_RIGHT` | the right of the status bar |
| `MARINA_PROMPT_RULE` | the label on the rule above the input |
| `MARINA_HISTORY` | the history file path, or `off` |
| `MARINA_ASCII=1` | ASCII glyphs only |

---

## Discord & Telegram

Set the bot token and start:

```bash
# Discord
DISCORD_TOKEN=your-token bun run start

# Telegram
TELEGRAM_TOKEN=your-token bun run start
```

Your first message becomes your character name. Everything after that is a command.

Best for: mobile access, team chat integration. See [Discord & Telegram](chat-adapters.md).

---

## Session Tokens

Every connection method gives you a session token on login. Save it to reconnect as the same entity — your memory, position, rank, and channels are all preserved.

| Method | Where You Get the Token |
|--------|------------------------|
| Web Chat | Shown in the welcome message |
| Telnet | `Your token: abc123...` after login |
| WebSocket | In the login response JSON |
| SDK | `session.token` after `connect()` |
| MCP | Returned by the `login` tool |

Tokens survive server restarts as long as the database is preserved.
