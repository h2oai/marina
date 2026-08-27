# Agent Memory Architectures in Marina

## Research Summary

Evaluated four reference memory architectures and mapped their concepts to in-game primitives that both human players and AI agents can use. Like the organization primitives (Phase 5), these are building blocks — not prescriptive systems. Agents self-organize their memory using these tools.

### Reference Architectures

| Architecture | Source | Core Pattern |
|---|---|---|
| **MemGPT** | [Packer et al. 2023](https://arxiv.org/abs/2310.08560) | OS-inspired tiered memory with self-editing (core/archival/recall) |
| **Generative Agents** | [Park et al. 2023](https://arxiv.org/abs/2304.03442) | Memory stream with recency/importance/relevance retrieval + reflections |
| **AgenticMemory** | [xeo-labs](https://github.com/xeo-labs/agentic-memory) | Graph-structured Zettelkasten with typed events, edges, confidence decay |
| **A-MEM** | [arxiv 2502.12110](https://arxiv.org/abs/2502.12110) | Dynamic Zettelkasten with agentic indexing and cross-linking |

### Cognitive Science Foundation

All four architectures draw from the same cognitive science taxonomy:

| Memory Type | Human Analogy | Function |
|---|---|---|
| **Working Memory** | Scratchpad / inner monologue | Short-lived, currently active context |
| **Episodic Memory** | Personal diary | Timestamped records of specific experiences |
| **Semantic Memory** | Encyclopedia | Distilled facts and knowledge, decoupled from episodes |
| **Procedural Memory** | Muscle memory / habits | Learned patterns, skills, and routines |

---

## What Already Exists in Marina

Before adding new primitives, map what's already available:

| Existing Primitive | Memory Role | Limitations |
|---|---|---|
| **Notes** (FTS) | Episodic (personal journal) | No importance, no linking, no decay |
| **Entity Properties** | Working memory (ephemeral state) | No history, no search, lost on disconnect |
| **Room Store** | Procedural (room-scoped state) | No search, no access from commands |
| **Board Posts** (FTS) | Semantic (shared knowledge) | No per-entity retrieval ranking |
| **Channel History** | Conversational recall | No search (LIKE only), TTL-based, no importance |
| **Event Log** | Raw activity stream | No importance scoring, no retrieval by relevance |
| **Experiments** | Procedural results | No generalization, no skill extraction |
| **Macros** | Procedural (command sequences) | Static, no learning or adaptation |

**Gap analysis**: The existing primitives cover storage but lack the *cognitive operations* that make memory useful — importance scoring, relevance-based retrieval, reflection/consolidation, decay, and cross-linking.

---

## Architecture 1: MemGPT-Style — Tiered Memory with Self-Editing

### What MemGPT Does
- Three tiers: **core memory** (always in context, editable), **archival memory** (infinite, searchable), **recall memory** (conversation history, searchable)
- The agent itself decides what to store, retrieve, and edit via function calls
- Core memory has fixed-size blocks (persona, human) that the agent rewrites as understanding evolves
- Archival is append-only with semantic search
- Recall is the full conversation log with text search
- Paging: old conversations evicted from context, summarized, searchable via recall

### Marina Mapping

The key insight is that MemGPT's tiers map directly to three existing + one new primitive:

| MemGPT Tier | Marina Primitive | Status |
|---|---|---|
| Core Memory (editable persona/facts) | **`memory` command** (NEW: entity-scoped key-value with edit history) | New |
| Archival Memory (append, semantic search) | **Notes** (already exists, needs importance scores) | Extend |
| Recall Memory (conversation search) | **Event Log** (already exists, needs better entity queries) | Extend |

### In-Game Commands (Proposed)

```
memory                     — View your core memory blocks
memory set <key> <value>   — Write/overwrite a core memory entry
memory get <key>           — Read a specific entry
memory delete <key>        — Remove an entry
memory list                — List all keys
memory history <key>       — View edit history for a key
```

Core memory is the agent's "scratchpad of facts" — always accessible, self-edited. Unlike notes (append-only journal), core memory entries are **mutable** with version history. An agent might maintain:
```
memory set goal "Find the decode room and solve the cipher"
memory set ally "Bob — helped me in the lab"
memory set hypothesis "The relay room requires 3 agents"
```

### What This Enables
- Agents maintain evolving beliefs (not just appended observations)
- Edit history shows how understanding changed over time
- Human players use it as a persistent scratchpad across sessions
- Combined with notes (archival) and event log (recall), gives full MemGPT stack

---

## Architecture 2: Generative Agents — Memory Stream with Scored Retrieval

### What Generative Agents Does
- **Memory stream**: Every observation appended with timestamp
- **Retrieval scoring**: `score = α·recency + β·importance + γ·relevance`
  - Recency: exponential decay from last access time
  - Importance: 1-10 poignancy score (assigned at creation)
  - Relevance: cosine similarity between query and memory embedding
- **Reflections**: Periodically synthesize observations into higher-level insights
  - Triggered when cumulative importance exceeds threshold
  - Two-step: generate questions from recent memories → generate insights
  - Reflections are themselves memories (can be reflected upon recursively)
- **Plans**: Hierarchical daily→hourly→5-minute decomposition

### Marina Mapping

The memory stream IS the notes system, but needs three additions:

| GA Concept | Marina Primitive | Status |
|---|---|---|
| Memory stream | Notes (already timestamped, FTS-searchable) | Exists |
| Importance scoring | **Note importance** (NEW: 1-10 score on creation) | New field |
| Recency decay | **Note access tracking** (NEW: last_accessed timestamp) | New field |
| Reflections | **`reflect` command** (NEW: synthesize notes into higher-level notes) | New command |
| Plans | **`memory` command** (from Architecture 1) or board posts | Reuse |
| Retrieval ranking | **`recall` command** (NEW: scored retrieval combining recency/importance/relevance) | New command |

### In-Game Commands (Proposed)

```
note <text>                       — Save observation (importance auto-scored or manual)
note <text> !<importance 1-10>    — Save with explicit importance
recall <query>                    — Retrieve notes ranked by recency+importance+relevance
recall <query> --recent           — Weight recency heavily
recall <query> --important        — Weight importance heavily
reflect                           — Generate a reflection from recent high-importance notes
reflect <topic>                   — Generate a reflection focused on a topic
```

### Retrieval Scoring (Implementable Without Embeddings)

Since we're in a MUD (text-only, no GPU), replace cosine similarity with FTS5 rank:

```
score = α · recency(note) + β · importance(note) + γ · fts5_rank(query, note)
```

Where:
- `recency(note) = e^(-λ · (now - last_accessed))` (exponential decay, λ tunable)
- `importance(note)` = 1-10 score stored on the note
- `fts5_rank(query, note)` = SQLite FTS5 BM25 rank (built-in, fast)

All three are computable in pure SQLite. No embedding model needed.

### What This Enables
- Agents retrieve contextually relevant memories, not just recent ones
- Important memories persist; trivial ones fade
- Reflections create hierarchical understanding (observations → insights → principles)
- Human players get a "journal with smart search"
- `reflect` command is useful for humans too ("what have I learned about the lab?")

---

## Architecture 3: AgenticMemory — Knowledge Graph with Typed Relationships

### What AgenticMemory Does
- Six event types: Fact, Decision, Inference, Correction, Skill, Episode
- Seven relationship types: CausedBy, Supports, Contradicts, Supersedes, RelatedTo, PartOf, TemporalNext
- Memories form a directed graph, not a flat list
- Corrections create Supersedes edges (preserving history, updating current belief)
- Confidence decay: `c(t) = c₀ · e^(-λΔt)`, reset on access
- Graph traversal queries enable reasoning chain reconstruction

### Marina Mapping

This is the most ambitious architecture. The core insight: notes can be linked to form a graph.

| AgenticMemory Concept | Marina Primitive | Status |
|---|---|---|
| Events (Fact/Decision/Inference/etc.) | Notes with a `type` field | Extend notes |
| Relationships (CausedBy/Supports/etc.) | `note link` typed edges between notes | Implemented |
| Confidence decay | Note importance + access-based decay (from Arch 2) | Reuse |
| Corrections (Supersedes) | `note correct` creates a new note and preserves the superseded record | Implemented |
| Episodes (session summaries) | **`reflect` command** (from Arch 2) with PartOf edges | Reuse |
| Graph traversal | `note trace` follows edges from a note | Implemented |

### In-Game Commands

```
note <text> !<importance> #<type>         — Save typed note (fact/decision/inference/skill)
note link <id1> <id2> <relationship>      — Create edge: supports/contradicts/caused_by/related_to
note correct <id> <new text>              — Create correction (supersedes old note, preserves history)
note trace <id>                           — Follow relationship graph from a note
note graph                                — Show overview of your knowledge graph (types + edge counts)
note conflicts                            — Review durable cross-agent/shared-pool disagreements
note resolve <case> <mode> <rationale>    — Adjudicate with provenance and verification history
```

### What This Enables
- Agents build structured knowledge bases, not just note dumps
- Contradictions are explicit (agent knows when beliefs conflict)
- Corrections preserve history (you can see *why* a belief changed)
- Graph traversal reconstructs reasoning chains ("why do I believe X?")
- Human players can build interconnected research notes

### Current Provenance and Reconciliation Layer

Notes can retain typed URL, note, message, observation, artifact, and dataset sources; source and
capturing entities; excerpts; observation time; credibility; confidence; and append-only verification
entries. Marina periodically detects opposite claims across agents and shared pools and stores them as
durable contradiction cases. `left`, `right`, `both`, and `neither` resolutions update confidence and
verification state while retaining both claims and the contradiction edge.

---

## Architecture 4: Shared Memory Spaces (Multi-Agent Extension)

### Motivation

All three architectures above are per-agent. But Marina is multi-agent. What happens when agents need shared memory?

### Research References
- Generative Agents: agents observe each other's actions (public memory stream)
- Chorus (Marina-native, lineage: Block's Goosetown): orchestrator maintains shared context across delegate agents via a broadcast wall
- Deliberation: deliberation boards are shared memory with cross-evaluation

### Marina Mapping

Boards already serve as shared memory. The extension is **scoped memory pools**:

| Concept | Implementation |
|---|---|
| Private memory | Notes (entity-scoped, as above) |
| Shared team memory | Board with group scope (exists) |
| Room-local memory | Notes tagged with room_id (exists) |
| Public memory | Board with read_rank=0 (exists) |
| Observed actions | Event log (exists, extend with `observe` command) |

The only new primitive needed: **`pool` command** — a lightweight shared note space for a group, like a collaborative scratchpad.

```
pool create <name>                — Create shared memory pool (linked to group)
pool <name> add <text> !<imp>     — Add note to shared pool
pool <name> recall <query>        — Scored retrieval from pool
pool <name> list                  — View recent entries
```

This maps to boards but with note-style importance/recall semantics instead of post/vote semantics. Implementation: just notes with a `pool_id` field instead of (or in addition to) `entity_name`.

---

## Recommended Implementation: Phased Approach

### What to Build (Migration 14 + Commands)

The four architectures converge on a small set of new primitives:

| # | Primitive | Enables | Effort |
|---|---|---|---|
| 1 | **Core memory** (`memory` command) | MemGPT core tier, working memory, scratchpad | Small — new table, CRUD command |
| 2 | **Note importance + access tracking** | GA retrieval scoring, AgenticMemory confidence | Small — ALTER TABLE, update note command |
| 3 | **Scored retrieval** (`recall` command) | GA memory stream, MemGPT archival search | Medium — scoring query in SQLite |
| 4 | **Note types + linking** | AgenticMemory knowledge graph | Medium — new edges table, link command |
| 5 | **Reflect command** | GA reflections, AgenticMemory episodes | Small — command only (synthesis is agent-side) |
| 6 | **Shared memory pools** | Multi-agent shared memory | Small — pool_id on notes |

### Database Changes (Migration 14)

```sql
-- Core memory (mutable key-value per entity)
CREATE TABLE core_memory (
  entity_name TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (entity_name, key)
);
CREATE TABLE core_memory_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_name TEXT NOT NULL,
  key TEXT NOT NULL,
  old_value TEXT NOT NULL,
  new_value TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);

-- Extend notes with importance, access tracking, type, and pool
ALTER TABLE notes ADD COLUMN importance INTEGER NOT NULL DEFAULT 5;
ALTER TABLE notes ADD COLUMN last_accessed INTEGER;
ALTER TABLE notes ADD COLUMN note_type TEXT NOT NULL DEFAULT 'observation';
ALTER TABLE notes ADD COLUMN pool_id TEXT;
ALTER TABLE notes ADD COLUMN supersedes_id INTEGER REFERENCES notes(id);

CREATE INDEX idx_notes_pool ON notes(pool_id);
CREATE INDEX idx_notes_type ON notes(note_type);
CREATE INDEX idx_notes_supersedes ON notes(supersedes_id);

-- Note relationships (knowledge graph edges)
CREATE TABLE note_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES notes(id),
  target_id INTEGER NOT NULL REFERENCES notes(id),
  relationship TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(source_id, target_id, relationship)
);

CREATE INDEX idx_note_links_source ON note_links(source_id);
CREATE INDEX idx_note_links_target ON note_links(target_id);

-- Memory pools (shared note spaces)
CREATE TABLE memory_pools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  group_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

### New Commands

| Command | Description | Architecture |
|---|---|---|
| `memory` | Core memory CRUD with edit history | MemGPT |
| `recall <query>` | Scored note retrieval (recency+importance+FTS) | Generative Agents |
| `note` (extended) | Add importance (!N), type (#type), corrections | All |
| `note link` | Create typed edges between notes | AgenticMemory |
| `note trace` | Follow knowledge graph edges | AgenticMemory |
| `reflect` | Synthesize recent notes (creates Episode-type note) | Generative Agents + AgenticMemory |
| `pool` | Shared memory spaces for groups | Multi-agent extension |

### How Each Architecture Uses the Primitives

**MemGPT pattern**: Agent uses `memory set` for core beliefs, `note` for archival storage, `recall` for retrieval, event log for conversation history. The agent's system prompt tells it to self-edit core memory as understanding changes.

**Generative Agents pattern**: Agent uses `note` with importance scores for every observation, `recall` for context-relevant retrieval, `reflect` periodically to synthesize. Plans stored via `memory set plan "..."`.

**AgenticMemory pattern**: Agent uses typed notes (`#fact`, `#decision`, `#inference`, `#skill`), `note link` to build knowledge graph, `note correct` to update beliefs with history, `note trace` to reconstruct reasoning chains.

**Multi-agent shared memory**: Groups use `pool` for collaborative knowledge bases. Agents `pool recall` to search shared context. Boards for formal proposals/evaluations (from Phase 5), pools for informal shared memory.

---

## Design Principles

1. **Primitives, not prescriptions** — Like the organization primitives, these are building blocks. The memory *architecture* lives in the agent's prompt, not in the engine. A MemGPT-style agent and a GA-style agent use the same commands differently.

2. **Human-usable** — Every command is useful for human players too. `memory` is a personal scratchpad. `recall` is smart search. `reflect` is journaling. `note link` is research organization.

3. **No embeddings required** — All retrieval uses FTS5 BM25 ranking + timestamp decay + importance weighting. Computable in pure SQLite with no ML dependencies.

4. **Forgetting is explicit** — Confidence/importance decay makes old unaccessed memories score lower in retrieval, but nothing is deleted automatically. This matches MUD conventions (persistent world) and avoids data loss.

5. **Graph optional** — The note linking system is additive. Agents that don't need knowledge graphs just use flat notes with importance + recall. The graph edges add power without complexity for those who don't use them.

---

## Sources

- [MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/abs/2310.08560) — Packer et al. 2023
- [MemGPT Technical Walkthrough](https://www.leoniemonigatti.com/blog/memgpt.html) — Monigatti 2024
- [Generative Agents: Interactive Simulacra of Human Behavior](https://arxiv.org/abs/2304.03442) — Park et al. 2023
- [AgenticMemory: Graph-Structured Memory for LLM Agents](https://github.com/xeo-labs/agentic-memory) — xeo-labs 2025
- [A-MEM: Agentic Memory with Zettelkasten](https://arxiv.org/abs/2502.12110) — 2025
- [Memory in the Age of AI Agents: A Survey](https://github.com/Shichun-Liu/Agent-Memory-Paper-List) — Liu et al. 2024
- [Letta/MemGPT Concepts](https://docs.letta.com/concepts/memgpt/) — Letta documentation
