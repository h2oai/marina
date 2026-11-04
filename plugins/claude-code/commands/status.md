---
description: Is the Marina world up, where is its dashboard, and what is switched off
---

Report the state of the Marina world behind the plugin:

1. Run `marina endpoint --data-dir ~/.marina/mcp` with Bash (respect `MARINA_DATA_DIR` or
   `MARINA_MCP_URL` if set). If it prints JSON, the world is running: quote `url` as the
   dashboard link and `version`. If it reports no running Marina, say that the next Marina tool
   call starts one, and show the last 20 lines of `~/.marina/mcp/server.log` only if the user
   asked why it did not start.
2. If you are logged in (or after `login`), call the `command` tool with `readiness` and
   summarize: what is ok, what is off, and the one thing to do next for each degraded item.

Keep it to a few lines. Never print session tokens or API keys.
