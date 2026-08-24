# Memory API

Use Marina's memory systems from any agent, any framework, any language. Store notes, recall with intelligent scoring, build knowledge graphs, manage mutable state, and share memory across agents — all through a simple REST API.

No SDK required. No world participation needed. Just HTTP.

---

## Quick Start

### 1. Start Marina

```bash
MEM_API_KEYS=local-memory-secret:my-agent bun run start
```

The Memory API is available at `http://localhost:3300/mem/`.

### 2. Store a memory

```bash
curl -X POST http://localhost:3300/mem/notes \
  -H "Authorization: Bearer local-memory-secret" \
  -H "Content-Type: application/json" \
  -d '{"content": "User prefers dark mode and compact layouts", "importance": 7, "type": "fact"}'
```

### 3. Recall it later

```bash
curl "http://localhost:3300/mem/recall?q=user+preferences" \
  -H "Authorization: Bearer local-memory-secret"
```

The recall engine automatically detects your query intent and adjusts scoring weights. Ask "how to deploy" and relevance dominates. Ask "when did I last deploy" and recency dominates. Ask "should I use Redis or Memcached" and importance dominates.

That's it. Your agent now has persistent, intelligent memory.

---

## Authentication

Two modes, depending on your setup:

### Development-open mode

Open mode is enabled only when `MARINA_OPEN_API=true` and `MEM_API_KEYS` is not set. Pass the
agent's identity in a header:

```bash
MARINA_OPEN_API=true bun run start

curl http://localhost:3300/mem/notes \
  -H "X-Agent-Name: my-agent"
```

Each agent name gets its own memory namespace. This bypass is for local development; do not use it
as authentication on a public host.

### Keyed Mode (production)

Set `MEM_API_KEYS` as comma-separated `secret:agent-name` pairs:

```bash
MEM_API_KEYS=sk-abc123:scout,sk-def456:archivist bun run start
```

Then authenticate with Bearer tokens:

```bash
curl http://localhost:3300/mem/notes \
  -H "Authorization: Bearer sk-abc123"
```

The token maps to an agent namespace automatically — no `X-Agent-Name` needed.

---

## API Reference

Base URL: `http://localhost:3300/mem`

All request/response bodies are JSON. All timestamps are Unix milliseconds.

### Discovery

```
GET /mem
```

Returns a machine-readable API description with all endpoints, types, and capabilities. Point your agent at this URL first — it has everything needed to self-integrate.

```
GET /mem/health
```

Returns `{"status": "ok", "service": "marina-mem", "version": 1}`. No auth required.

---

### Notes

Notes are your agent's episodic and procedural memory. Each has content, an importance score (1-10), and a type.

**Note types:** `observation`, `fact`, `decision`, `inference`, `skill`, `episode`, `principle`

#### Create a note

```
POST /mem/notes
```

```json
{
  "content": "The staging environment has 2x less memory than production",
  "importance": 8,
  "type": "fact",
  "links": [
    {"target": 3, "relationship": "contradicts"}
  ]
}
```

Only `content` is required. `importance` defaults to 5, `type` defaults to `observation`. The optional `links` array creates knowledge graph edges to existing notes in the same request.

**Response** (201):
```json
{
  "id": 12,
  "note": {
    "id": 12,
    "entity_name": "my-agent",
    "content": "The staging environment has 2x less memory than production",
    "importance": 8,
    "note_type": "fact",
    "created_at": 1743580800000
  }
}
```

#### List notes

```
GET /mem/notes?limit=50
```

Returns your most recent notes, newest first. Max limit: 200.

#### Get a single note

```
GET /mem/notes/:id
```

Returns the note and all its knowledge graph links.

#### Delete a note

```
DELETE /mem/notes/:id
```

---

### Recall

The core of the memory system. Recall uses 3-factor weighted scoring:

- **Importance** — how important you marked the note (1-10)
- **Recency** — how recently the note was created or accessed
- **Relevance** — full-text search match quality (SQLite FTS5)

```
GET /mem/recall?q=<query>
```

**Query parameters:**
| Param | Description |
|-------|-------------|
| `q` | Search query (required) |
| `wi` | Importance weight override (0-1) |
| `wr` | Recency weight override (0-1) |
| `wrel` | Relevance weight override (0-1) |

**Response:**
```json
{
  "query": "deployment process",
  "weights": {
    "weightImportance": 0.2,
    "weightRecency": 0.2,
    "weightRelevance": 0.6
  },
  "results": [
    {
      "id": 7,
      "content": "Deploy steps: build → test → stage → canary → promote",
      "importance": 9,
      "note_type": "skill",
      "score": 0.847,
      "created_at": 1743580800000
    }
  ],
  "count": 1
}
```

#### Intent detection

If you don't override weights, the system auto-detects your query intent:

| Query pattern | Behavior | Example |
|---------------|----------|---------|
| "when did", "recently", "yesterday" | Recency-heavy (0.6) | "when did I last see errors" |
| "how to", "steps to", "procedure" | Relevance-heavy (0.6) | "how to configure Redis" |
| "should I", "decision", "trade-off" | Importance-heavy (0.5) | "should I use SQL or NoSQL" |
| "what is", "define", "explain" | Balanced importance + relevance | "what is our caching strategy" |

#### Spreading activation

After scoring, the top 5 results activate their knowledge graph neighbors. Connected notes get a boosted score (0.3 damping factor) and may appear in results even without a direct keyword match. This is how your agent discovers related context it didn't explicitly search for.

---

### Knowledge Graph

Notes can be linked with typed relationships, forming a navigable graph.

**Relationship types:** `supports`, `contradicts`, `caused_by`, `related_to`, `part_of`, `supersedes`

#### Link two notes

```
POST /mem/notes/:id/link
```

```json
{
  "target": 3,
  "relationship": "supports"
}
```

Both notes must belong to your agent.

#### Trace the graph

```
GET /mem/notes/:id/trace?depth=2
```

Returns a BFS traversal of connected notes up to the specified depth (max 5). Each entry includes the note, its links, and the traversal depth.

```json
{
  "root": 7,
  "depth": 2,
  "graph": [
    {
      "note": {"id": 7, "content": "...", "importance": 9},
      "links": [
        {"source_id": 7, "target_id": 3, "relationship": "supports"}
      ],
      "depth": 0
    },
    {
      "note": {"id": 3, "content": "...", "importance": 6},
      "links": [],
      "depth": 1
    }
  ]
}
```

---

### Core Memory

Mutable key-value store for your agent's current state — goals, roles, hypotheses, configuration. Every update is versioned with full history.

#### Set a value

```
PUT /mem/core/goal
```

```json
{"value": "Reduce p99 latency below 50ms"}
```

#### Get a value

```
GET /mem/core/goal
```

```json
{
  "entity_name": "my-agent",
  "key": "goal",
  "value": "Reduce p99 latency below 50ms",
  "version": 3,
  "created_at": 1743580800000,
  "updated_at": 1743667200000
}
```

#### List all keys

```
GET /mem/core
```

#### Delete a key

```
DELETE /mem/core/goal
```

#### View version history

```
GET /mem/core/goal/history?limit=10
```

Returns the change log: what the value was before and after each update.

---

### Memory Pools

Shared memory spaces that multiple agents can read and write. Use pools for team knowledge, project context, coordination conventions, or any shared state.

#### Create a pool

```
POST /mem/pools
```

```json
{"name": "project-alpha"}
```

#### List pools

```
GET /mem/pools
```

#### Add a note to a pool

```
POST /mem/pools/project-alpha/notes
```

```json
{
  "content": "The migration must complete before Thursday's release freeze",
  "importance": 9,
  "type": "decision"
}
```

#### List pool notes

```
GET /mem/pools/project-alpha/notes?limit=100
```

#### Recall from a pool

```
GET /mem/pools/project-alpha/recall?q=migration+timeline
```

Same 3-factor scoring and intent detection as personal recall.

#### Pool info

```
GET /mem/pools/project-alpha
```

---

### Stats

```
GET /mem/stats
```

Returns aggregate stats for your agent's memory namespace:

```json
{
  "agent": "my-agent",
  "notes": 47,
  "links": 23,
  "coreKeys": 5,
  "pools": 2
}
```

---

## Background: How Memory Works

Marina's memory system is designed for long-running autonomous agents. Understanding these mechanics helps you get more value from the API.

### Importance decay

Notes that are never recalled gradually lose importance. Orphan notes (0-2 links) decay after 7 days. Well-linked notes (3+ links) survive 14 days before decaying. Notes that are recalled frequently get boosted instead. This means the knowledge graph isn't just for navigation — linking notes to each other is a form of long-term memory protection.

### Note types matter

Types aren't just labels. Use `skill` for procedural knowledge ("how to deploy"), `fact` for stable truths, `decision` for choices made, `inference` for derived conclusions, `observation` for raw data, `episode` for synthesized reflections, and `principle` for guiding rules.

### Pools as coordination

When multiple agents share a pool, they discover each other's contributions through recall. Orchestration conventions, project decisions, and collective findings accumulate in pools and are retrieved by relevance — not by timestamp. This means agents naturally find the most important shared context without scrolling through logs.

---

## Integration Examples

### Python (requests)

```python
import requests

BASE = "http://localhost:3300/mem"
HEADERS = {"X-Agent-Name": "my-agent", "Content-Type": "application/json"}

# Store
requests.post(f"{BASE}/notes", json={
    "content": "User prefers dark mode",
    "importance": 6,
    "type": "fact"
}, headers=HEADERS)

# Recall
resp = requests.get(f"{BASE}/recall", params={"q": "user preferences"}, headers=HEADERS)
for note in resp.json()["results"]:
    print(f"[{note['score']:.2f}] {note['content']}")
```

### JavaScript/TypeScript (fetch)

```typescript
const BASE = "http://localhost:3300/mem";
const headers = { "X-Agent-Name": "my-agent", "Content-Type": "application/json" };

// Store
await fetch(`${BASE}/notes`, {
  method: "POST",
  headers,
  body: JSON.stringify({ content: "Cache hit rate dropped to 60%", importance: 8 }),
});

// Recall
const res = await fetch(`${BASE}/recall?q=cache+performance`, { headers });
const { results } = await res.json();
```

### curl (one-liners)

```bash
# Health check
curl http://localhost:3300/mem/health

# Store a note
curl -X POST http://localhost:3300/mem/notes \
  -H "X-Agent-Name: bot" -H "Content-Type: application/json" \
  -d '{"content":"Deployment succeeded","type":"observation"}'

# Recall
curl "http://localhost:3300/mem/recall?q=deployment" -H "X-Agent-Name: bot"

# Set core memory
curl -X PUT http://localhost:3300/mem/core/status \
  -H "X-Agent-Name: bot" -H "Content-Type: application/json" \
  -d '{"value":"monitoring"}'

# Create a shared pool
curl -X POST http://localhost:3300/mem/pools \
  -H "X-Agent-Name: bot" -H "Content-Type: application/json" \
  -d '{"name":"team-knowledge"}'
```

### Claude Desktop / Claude Code (MCP)

If you're using Marina's MCP server, memory is already built in via the `think` and `memory` tools. The REST API is for agents that connect independently — no MCP or world participation required.

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MEM_API_KEYS` | *(none)* | Comma-separated `secret:agent` pairs. If unset, requests remain closed unless `MARINA_OPEN_API=true`. |

The Memory API runs on the same port as the main server (default 3300). No additional configuration needed.
