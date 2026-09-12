# Symbolic memory for TypeScript, MCP, residents and humans

Marina's durable memory is text, evidence, typed claims and versioned state. Embeddings are
optional indexes. Exact symbolic queries and graph traversal work with `--embeddings none`,
without model downloads or inference. See the [service guide](memory-service.md) for provisioning
and the [current validation record](../research/memory-portable-implementation.md) for limits.

## TypeScript and JavaScript

Build the package with `bun run build:memory`. In this checkout or a package containing that
build, `marina/memory` exports a fetch-only client and public TypeScript types. It runs under
Node, Bun and browser bundlers with `fetch` and `AbortSignal.any`/`timeout` support. This source change has not been published to npm.
Keep server credentials in server code; a browser client must receive its own appropriately
scoped credential and have network/CORS access.

```typescript
import { MarinaMemoryClient } from "marina/memory";

const memory = new MarinaMemoryClient(url, token);
const evidence = await memory.capture(spaceId, {tool: "test", result: "3 pass"}, "task:123", "evidence-1");
const saved = await memory.remember(spaceId, {
  content: "The test suite passed for this revision.",
  claim: {subject: "task:123", predicate: "test:status", object: {kind: "literal", value: "passed"}},
  source_ids: [evidence.id],
}, "status-1");
const results = await memory.query(spaceId, {subject: "task:123", predicate: "test:status"});
await memory.remember(spaceId, {
  content: "Task 123 belongs to Marina.",
  claim: {subject: "task:123", predicate: "project", object: {kind: "entity", id: "project:marina"}},
}, "task-project-1");
const graph = await memory.graph(spaceId, {subject: "task:123", max_depth: 2});
await memory.saveCheckpoint(spaceId, "work", 0, {next: "review", record: saved.id}, evidence.seq, "checkpoint-1");
```

Query filters are conjunctive and exact. `1`, `"1"`, `true`, `null`, and an entity named `"1"`
are distinct objects. Symbols are case-sensitive, without stemming, alias resolution or Unicode
normalization. Use stable namespaced IDs shared by your applications. Numbers use JSON's
JavaScript numeric representation; use strings for identifiers and exact large integers.

A query page contains records, `generation` and `next_cursor`. Evidence or access changes invalidate existing
cursors with `409 query_changed`; restart to avoid silently mixing states. Checkpoint-only saves
do not invalidate new cursors. Graph paths contain
record IDs, and each edge contains the full current record. `truncated` means at least one reachable assertion was omitted by the edge or depth budget.
The boundary is checked, so a terminal node or fully visited cycle does not produce a false flag.

## MCP for external coding agents

Provision and start the memory service; no world login is needed:

```bash
bun run memory init --db data/memory.db --name coding-agent --credentials data/coding-agent.json
bun run memory serve --db data/memory.db --embeddings none
```

The stdio bridge uses only the HTTP URL and a scoped memory credential:

```bash
bun run scripts/memory-mcp.ts --url http://127.0.0.1:3301 --credentials /absolute/path/to/data/coding-agent.json
```

It exposes `memory_service`, `memory_remember`, `memory_query` and `memory_graph`. The generic
service tool accepts `{operation, space_id?, id?, input?, key?}`. Its operations match the HTTP
client: `capabilities`, `usage`, `me`, `spaces`, `create_space`, `space`, `remember`, `get`, `revise`,
`query`, `graph`, `search`, `context`, `capture`, `capture_batch`, `sources`, `source_search`, `source_range`,
`plan`, `execute_plan`, `vocabulary`, `save_vocabulary`, `checkpoint`, `save_checkpoint`,
`grant`, `forget`, `export`, `job`, `reindex`. `id` is the record, checkpoint name or job ID
as appropriate; `input` is the HTTP body, or GET options such as `version`, `after`, `limit`.
Capture uses `input: {content, session_id?}`; checkpoint writes use
`input: {expected_version, source_cursor, source_ids?, data}`. Space omission uses the configured default.

Tool replies include readable text plus `structuredContent: {ok, space_id, result}` or
`{ok:false,error:{code,message,status}}`, and `isError`. Mutations accept an idempotency `key`;
reuse it after an ambiguous failure. The bridge does not emit tokens to stdout. It fails
startup if the credential cannot read the configured space.

Claude Code supports stdio MCP servers via its `mcp add` command:

```bash
claude mcp add --transport stdio marina-memory -- bun run /absolute/path/to/Marina/scripts/memory-mcp.ts --url http://127.0.0.1:3301 --credentials /absolute/path/to/data/coding-agent.json
```

This configuration follows [Claude Code's MCP documentation](https://code.claude.com/docs/en/mcp).
For Codex, add a server entry to your Codex configuration:

```toml
[mcp_servers.marina_memory]
command = "bun"
args = ["run", "/absolute/path/to/Marina/scripts/memory-mcp.ts", "--url", "http://127.0.0.1:3301", "--credentials", "/absolute/path/to/data/coding-agent.json"]
```

The command/args configuration follows [Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
Use an absolute Bun executable path if the application cannot find it. Alternatively, set
`MARINA_MEMORY_TOKEN`, `MARINA_MEMORY_SPACE` and `MARINA_MEMORY_URL` in the bridge's environment;
keep the token out of checked-in configuration. These recipes are documented configurations;
protocol tests run an MCP SDK client, not the actual Claude or Codex applications.

## Skills

The portable [marina-memory skill](../../skills/marina-memory/SKILL.md) teaches evidence capture,
symbolic recall, checkpoint recovery and explicit correction. Copy its folder into the target
project's `.agents/skills/marina-memory` for Codex or `.claude/skills/marina-memory` for Claude.
Those discovery locations follow the [Codex skill documentation](https://learn.chatgpt.com/docs/build-skills)
and [Claude skill documentation](https://code.claude.com/docs/en/skills). Configure MCP separately;
a skill does not provide credentials or create storage by itself. No global configuration is
changed by this implementation.

## Residents and human use

The full world exposes `/v1/memory` on its HTTP/WebSocket port (normally **3300**). World MCP
is a different listener (normally **3301**, `/mcp`), with login/auth and the same four service
tools. The standalone memory server also defaults to 3301; use different ports if running both.
The stdio bridge connects to the memory **HTTP** listener, not the world MCP listener.

World commands bind to the logged-in durable world user principal and lazily create a private
`resident` space. This applies to human and agent world accounts; existing agent-runtime
principals are not silently merged into those accounts. Binding inherits the world's login
policy: passwordless world login is not a secure external identity provider. Standalone API
credentials have their own audience and cannot authorize world operations.

```text
memory service
memory claim project:marina status "active"
memory relate task:123 project project:marina
memory query {"subject":"project:marina"}
memory graph task:123
memory show RECORD_ID
memory sources incident Kestrel
memory source SOURCE_ID
memory plan Aster migration approval
memory vocabulary
memory api {"operation":"checkpoint","id":"work"}
```

Human verbs translate into the same service requests; responses retain full content, IDs and
provenance. They do not run an LLM to guess the intended mutation. An assistant using the skill
can translate natural language into explicit claims. There is no new dashboard editor.

Resident TypeScript clients can call `MarinaClient.memoryService(request)`, which waits for a
correlated reply rather than relying on the short command-output drain window. Full-profile
residents receive `marina_memory_service`; compact profiles discover the commands in their
command roster. MCP commands await completion and serialize per session to keep concurrent
replies separate. All service reads/writes retain the shared service's permission checks.

Use explicit grants to share a space between an external service principal and a world account.
Read the principal IDs through each interface's `me` operation. Existing `memory set/get`,
`note`, `recall` and pools retain their legacy interfaces; there is no bulk migration.

Resident checkpoints and completed-message journals use the private durable service. The runtime
awaits capture of each completed user, assistant and tool-result message before advancing.
Read `checkpoint.data.journal.manifest_source_id` and follow previous-manifest links for recent
messages. Every lossy context transform also awaits
capture of the complete original message array before returning a compacted view. The archive
uses ordered, UTF-8-safe source parts (`json-utf8-parts-v1`) plus a SHA-256 integrity hash in the
`resident` checkpoint. Each archive also captures an immutable manifest with
`source_ids`, `sha256` and `previous_manifest_source_id`; the checkpoint exposes its
`manifest_source_id`. Follow the manifest chain to reconstruct earlier conversations after
successive compactions. Message boundaries let growing histories reuse uploaded parts. The
checkpoint validates that all referenced sources still exist. After restart, the resident sees
its intent, archival summary and source IDs; it can read the originals through `source_range`.

A failed capture or checkpoint acknowledgment aborts compaction and retains local history.
Forgetting invalidates checkpoints. A running resident that has observed a checkpoint will
refuse to recreate it after invalidation; restart that resident before further checkpointing.
This prevents automatic re-archival of its old local buffer. It does not erase context already
held by an external client. Unfinished streaming output can still be lost on abrupt process
death; external tool effects are not transactional with their result capture. Raw archives
remain private. Existing `compactionPool` configuration still shares a bounded summary after durable
capture; this explicit opt-in is best-effort and does not publish the raw archive.

For revision-aware dependency review, bounded batch/retry contracts and operational snapshots,
see the [reliability guide](memory-service.md#reliable-corrections-and-retries).


Storage usage is available through `memory.usage()` (TypeScript/Python), the MCP service operation
`usage`, or the human command `memory usage`. Limits aggregate all spaces owned by the current
principal and include history and retry receipts. See [storage admission and recovery](memory-service.md#storage-admission-and-failure-recovery).

TypeScript callers can use `memory.withSignal(signal)` and `retryMemoryOperation(..., {signal})`
to stop local waits and retries. The memory-only MCP bridge forwards protocol cancellation;
resident journaling uses the agent runtime signal. A sent write can still commit after abort:
[reuse its original request key to recover the receipt](memory-service.md#request-cancellation).
