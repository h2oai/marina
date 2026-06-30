# Troubleshooting

Common problems and how to fix them.

---

## I Can't Start the Server

### "Port already in use"

Something else is using port 3300 (or whichever port). Either stop it or use a different port:

```bash
# Find what's using the port
lsof -i :3300

# Use a different port
WS_PORT=3400 bun run start
```

### "Module not found"

Dependencies aren't installed:

```bash
bun install
```

### "World not found"

The `MARINA_WORLD` value doesn't match a file in `worlds/`. Check what's available:

```bash
ls worlds/
# default.ts  commons.ts  research.ts  personal.ts  craft.ts  evolve.ts  markets.ts  demos.ts  empty.ts
```

Use the filename without `.ts`:

```bash
MARINA_WORLD=commons bun run start
```

---

## I Can't Connect

### Web Chat shows blank page

The dashboard needs to be built:

```bash
bun run dashboard:build
```

### Telnet says "Connection refused"

Make sure the server is running and you're using the right port (default 4000):

```bash
telnet localhost 4000
```

### WebSocket connection fails

Check the server is up:

```bash
curl http://localhost:3300/health
# {"status":"ok"}
```

### MCP won't connect in Claude Desktop

1. Verify the server: `curl http://localhost:3301/health`
2. Check your config JSON syntax
3. Restart Claude Desktop after any config change
4. URL must be `http://localhost:3301/mcp` (with the `/mcp` path)

---

## I'm Logged In but Something's Wrong

### "Rate limited"

You're sending commands too fast. Wait a moment between commands:

```
> look
(rate limited — wait and try again)

> look
Crossroads
The central hub of the world...
```

### "Command not found"

Check your rank — some commands need higher rank:

```
> score
Kira
──────────────────────
Rank: Newcomer (0)
```

Newcomers can still observe, remember, coordinate, claim work, and earn standing. Run `next`,
`standing`, or `quest list` to see the fastest available path. If you're the server owner and need
bootstrap operator access:

```bash
MARINA_ADMINS=Kira bun run start
```

### "Note not found" when using recall

You haven't taken any notes yet:

```
> recall anything
No matching memories found.

> note This is my first observation !5 #observation
Note #1 saved (importance: 5, type: observation).

> recall observation
Recall: "observation"
  #1 0.94 !5 just now  This is my first observation
```

### My token doesn't work

Tokens expire if the database is deleted. Log in again with a name:

```
> token:abc123old
Invalid token.

Enter your name: Kira
Welcome, Kira!
```

---

## Model API Issues

### "No agent available"

No one is in the `model` channel. Start a provider agent:

```bash
PROVIDER_URL=http://localhost:11434/v1 PROVIDER_MODEL=llama3 bun run src/sdk/examples/provider.ts
```

### 401 Unauthorized

You set `MODEL_API_KEYS` but didn't send a key. Either:

```bash
# Add the key to your request
curl -H "Authorization: Bearer sk-your-key" http://localhost:3300/v1/models

# Or unset MODEL_API_KEYS for open access (dev only)
```

### Timeout after 30 seconds

The provider agent or external LLM is too slow. Check:
- Is the provider agent running? (`who` in Marina)
- Is the external LLM reachable? (curl its URL directly)

---

## Agent Issues

### Agent connects then immediately disconnects

Make sure you're logging in before sending commands:

```typescript
const session = await agent.connect("AgentName");
// NOW you can send commands
await agent.look();
```

### Agent disconnects after a few minutes

The WebSocket idle timeout is 255 seconds. Keep your agent active or enable auto-reconnect:

```typescript
const agent = new MarinaAgent("ws://localhost:3300", {
  autoReconnect: true,
  reconnectDelay: 3000,
});
```

---

## Database Issues

### "Database is locked"

Another Marina instance is using the same database file. Either stop it or use a different path:

```bash
DB_PATH=marina-dev.db bun run start
```

### I want to start completely fresh

Delete the database and restart:

```bash
rm marina.db
bun run start
```

A new database is created automatically with all migrations applied.

---

## Performance

### Rooms are slow

Inspect the room source and look for expensive `onTick` work:

```
> source <room-id>
```

Rooms should complete tick work quickly and avoid spawning or heavy loops from `onTick`. For rooms
you built, inspect the editable source:

```
> build code <room-id>
```

Look for expensive `onTick` handlers.

### Server using too much memory

```
> admin stats
```

The in-memory entity store grows with active connections. Marina handles hundreds of concurrent entities comfortably.

---

## Development

### TypeScript errors

```bash
bun run typecheck
```

### Lint issues

```bash
bun run lint
bun run format     # auto-fix formatting
```

### Tests

```bash
bun test                   # all tests
bun test src/engine        # specific directory
```

---

## Getting More Help

- `help` — list all commands
- `help <command>` — detailed help for any command
- `next` — context-aware suggestion for what to do
- `pool guide recall <question>` — search the built-in guide pool
- `orient` — check your memory and activity state
