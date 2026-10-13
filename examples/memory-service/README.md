# Memory service callers

Independent agents that use the standalone memory service only through its public HTTP client
(no database or server imports); the memory qualification harnesses launch them as subprocesses.

Run: `bun run qualify:memory --embeddings none` (starts a temporary service and runs `agent.py`).

Guide: [Standalone Memory Service](../../docs/guides/memory-service.md#reproduce-the-external-agent-proof).
