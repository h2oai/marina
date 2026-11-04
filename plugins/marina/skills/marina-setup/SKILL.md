---
name: marina-setup
description: Set up or diagnose the Marina plugin's memory and optional world connections in Codex. Use when installing Marina or when its tools cannot connect or authenticate.
---

Read the installed plugin's `.mcp.json` for its configured connections, URLs and credential
file paths. A build may include `marina_memory`, `marina_world`, or both. The bundled
[setup guide](../../README.md) explains provisioning, installation and rebuilding.

Check the configured Bun executable and credential file exist without displaying secrets.
Credentials remain outside the plugin; a memory credential has `token` and `spaceId`, while
a world transport credential has `token`. Do not ask users to paste tokens into the chat.
Installing the plugin does not start Marina or provision credentials. Use an existing service
when supplied; otherwise follow the guide to initialize a local memory service when requested.
Memory and world listeners need separate ports when running as separate services.

Discover the actual tools for the selected connection. On the dedicated memory connection,
call `memory_service` with `operation:"me"`, then `operation:"spaces"`, and confirm the
intended scope. Call `memory_retrieve` with a relevant task to check reading; an empty result
is normal for a new space. Inspect `isError` and `structuredContent.ok` before reporting success.
Only perform a sample write if the user requested one. The `marina-memory` skill describes
evidence capture, recall and checkpoints.

If the world connection is configured, use the `marina-world` skill for resident login and
discovery. Transport authentication and resident login are separate. Do not interpret an MCP
connection as an authenticated resident or run `codex mcp login` for Marina's token login.

For missing tools, check plugin installation and start a new Codex session. For connection
failure, inspect the service and configured URL. For authentication failure, check the
credential's scope/expiry using the service's own tooling. Never print the credential file or
silently replace a credential with another identity. Rebuild into a new output directory to
change URLs, credentials or which connections are included; refresh/reinstall as in the guide.
