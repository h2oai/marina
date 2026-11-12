# Install Marina

Four ways in, from least effort to most control. The desktop app is Marina in its own window;
the others end with Marina running on your computer, open in your browser at
**http://localhost:3300**.

## Download the app

No terminal at all: the desktop app has Marina, its dashboard and its world inside. Download the
one for your computer, open it, enter a name, click **Start Here**, then **Connect an AI
provider** and paste your key.

| Your computer | Download | Then |
|---|---|---|
| Mac with Apple silicon (M1 or later) | [Marina for macOS (.dmg)](https://github.com/h2oai/marina/releases/download/desktop-v0.8.0/macos-arm64-Marina.dmg) | Open the `.dmg` and drag Marina to Applications. |
| Windows 10 or 11 (64-bit) | [Marina for Windows (.zip)](https://github.com/h2oai/marina/releases/download/desktop-v0.8.0/win-x64-Marina-Setup.zip) | Unzip it and run `Marina-Setup.exe`. |
| Linux (x64) | [Marina for Linux (.tar.gz)](https://github.com/h2oai/marina/releases/download/desktop-v0.8.0/linux-x64-Marina-Setup.tar.gz) | Unpack it and run `./installer`; Marina appears in your applications. |

These builds are not signed, so the first launch needs one extra step:

- **macOS** says *"Apple could not verify 'Marina' is free of malware"*. Click **Done**, open
  **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to
  Marina. You only do this once.
- **Windows** shows *"Windows protected your PC"*. Click **More info**, then **Run anyway**.

All files, with their checksums and build attestations, are on the
[release page](https://github.com/h2oai/marina/releases/tag/desktop-v0.8.0). The app does not
update itself yet; download a newer one from the [releases](https://github.com/h2oai/marina/releases)
when you want it.

## Ask your AI assistant

If you already use an AI assistant that can run commands on your computer (Claude Code, Codex,
Cursor, or similar), tell it:

> Install Marina from github.com/h2oai/marina

It follows the steps in [For AI agents](#for-ai-agents) below. When it is done it tells you
where to paste your model key. You never have to type a command.

## One command

On macOS or Linux, open **Terminal** and run:

```bash
curl -fsSL https://h2oai.github.io/marina/setup.sh | bash
```

It takes a few minutes, and asks one thing: **paste an API key** from Anthropic, OpenAI, Google,
OpenRouter, Groq, Together or Nebius. Marina works out which one it is. Press Enter to skip;
you can add a key later in the dashboard. Then Marina starts and opens in your browser. Keep the
Terminal window open while you use it.

What it does, in order:

1. Downloads Marina into `~/marina`.
2. Installs [Bun](https://bun.sh), the runtime Marina uses, into `~/.bun`, unless a recent
   enough one is already there.
3. Installs Marina's packages and builds the dashboard.
4. Puts the `marina` command on your PATH. When new terminals would not find it, it adds one
   line to your shell's startup file (`~/.zshrc`, `~/.bashrc`, `~/.bash_profile` or fish's
   `config.fish`) and says which.
5. Asks for the key, saves it in `~/marina/.env` (readable only by you), and starts Marina.

It never uses `sudo`. Run the same command again to update; your settings and your world are
kept. Next time, start Marina with `marina start` in a new terminal.

Options go after `bash -s --`. For example, to install somewhere else:

```bash
curl -fsSL https://h2oai.github.io/marina/setup.sh | bash -s -- --dir ~/apps/marina
```

| Option | Effect |
|---|---|
| `--dir <path>` | Install there instead of `~/marina` (or set `MARINA_DIR`). |
| `--yes` | Ask nothing and do not start Marina. For agents and scripts. |
| `--no-start` | Set up, but do not start Marina at the end. |
| `--no-modify-path` | Leave your shell's startup file alone. |

On Windows, run it inside [WSL](https://learn.microsoft.com/windows/wsl/install), or use the
desktop app or Docker ([README](../../README.md#desktop-app-and-docker)).

## By hand

[Getting started](getting-started.md#source-checkout) lists each step, for a source checkout you
manage yourself.

## For AI agents

Steps for an AI agent installing Marina for a person. They need no input from the person until
the last step, and the person's API key never passes through you.

1. Install, without questions and without starting the server:

   ```bash
   curl -fsSL https://h2oai.github.io/marina/setup.sh | bash -s -- --yes
   ```

   This takes a few minutes. It installs into `~/marina`, Bun into `~/.bun/bin`, and links
   `marina` into `~/.bun/bin` or `~/.local/bin`. New terminals find both; your own shell may not
   yet, so put them on its PATH:

   ```bash
   export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
   ```

2. Start Marina in the background, so it keeps running after your command returns:

   ```bash
   cd ~/marina && nohup bun run start > ~/marina/marina.log 2>&1 &
   ```

3. Wait until it answers, for up to a minute:

   ```bash
   curl -fsS http://localhost:3300/health
   ```

4. Tell the person to open **http://localhost:3300**, then **Admin → Keys**, and paste their
   model API key there. Do not ask them to paste a key into the conversation, and never put a
   key in a command line. A person at a terminal can instead run `marina init`, which asks only
   for the key.

5. Optional: connect yourself to the same world. In Claude Code, run
   `/plugin install marina --marketplace h2oai/marina`; for any MCP client, add the server
   `http://localhost:3301/mcp` ([MCP guide](mcp-integration.md)).

To check what works and what to switch on next, run `marina connect <name> -c "readiness"`.

## Change settings later

`marina init` asks only for a key and keeps everything else as it is. `marina init --advanced`
asks for each setting in turn: the model provider or a local model server, the instance name,
the world and an admin name. The dashboard's **Admin → Keys** adds or tests a key without a
terminal. See [Configuration](configuration.md) for every setting.
