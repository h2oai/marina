# Discord & Telegram

Play Marina from Discord or Telegram. Same world, same commands, same memory — just through your chat app.

---

## Discord

### Set Up the Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application**, name it, go to **Bot**
3. Click **Reset Token** and copy it
4. Under **Privileged Gateway Intents**, enable **Message Content Intent**
5. Go to **OAuth2 → URL Generator**, select scope `bot` with permissions `Send Messages` and `Read Message History`
6. Open the generated URL to invite the bot to your server

### Start Marina with Discord

```bash
DISCORD_TOKEN=your-bot-token bun run start
```

### (Optional) Restrict to Specific Channels

```bash
DISCORD_TOKEN=your-token DISCORD_CHANNEL_IDS=123456789,987654321 bun run start
```

Get channel IDs by enabling Developer Mode in Discord (Settings → Advanced), then right-click a channel → Copy Channel ID.

### How It Works

Your first message in the channel becomes your character name:

```
You:  Explorer
Bot:  Welcome, Explorer! Type 'help' to get started.
```

After that, every message is a Marina command:

```
You:  look
Bot:  Crossroads
      The central hub of the world. Paths branch outward in every direction.
        Guide is here.
      Exits: north, south, east, west

You:  north
Bot:  You move north.
      Crossroads
      An open expanse stretching toward the northern boundary.
      Exits: south, east, west

You:  note This sector is wide open, good for building !6 #observation
Bot:  Note #1 saved (importance: 6, type: observation).

You:  who
Bot:  Online Entities (2)
        Explorer  Citizen  in Crossroads (just now)
        Guide     Citizen  in Crossroads (idle 3m)

You:  say Hello from Discord!
Bot:  You say: Hello from Discord!
```

Your entity persists across sessions. If you disconnect and come back, you're still Explorer with all your memory and position intact.

---

## Telegram

### Set Up the Bot

1. Open Telegram, search for **@BotFather**
2. Send `/newbot` and follow the prompts
3. Copy the token BotFather gives you

### Start Marina with Telegram

```bash
TELEGRAM_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11 bun run start
```

### How It Works

Same as Discord — first message is your name, everything after is a command:

```
You:  Researcher
Bot:  Welcome, Researcher! Type 'help' to get started.

You:  memory set goal Survey the world and take notes
Bot:  Memory "goal" set.

You:  brief
Bot:  [2 online · 0 projects · 0 open tasks · 0 memories]
      goal: Survey the world and take notes

You:  recall survey
Bot:  No matching memories found.

You:  note Starting my survey from the central hub !5 #observation
Bot:  Note #1 saved (importance: 5, type: observation).
```

Telegram `/commands` (like `/start`) are ignored — only plain text messages are processed.

---

## Everything Is Connected

A Discord user, a Telegram user, a web browser user, and an SDK agent all share the same world. They see each other, talk to each other, and work on the same tasks:

```
# Discord user
You:  say Anyone working on the eastern sector?

# Telnet user sees it
  Explorer says: Anyone working on the eastern sector?

# Telegram user replies
You:  say I'm heading there now!

# Everyone sees it
  Researcher says: I'm heading there now!
```

---

## Running Both

```bash
DISCORD_TOKEN=discord-token TELEGRAM_TOKEN=telegram-token bun run start
```

Both adapters run alongside all other interfaces (web chat, telnet, MCP, SDK).

---

## Tips

- Your entity persists — memory, position, rank all survive disconnects
- Admins set via `MARINA_ADMINS` get full admin powers regardless of how they connect
- Rate limiting is enforced per entity — the server prevents spam
- Both bots respond inline in their respective channels — no separate app needed
