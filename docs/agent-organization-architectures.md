# Agent Organization Architectures in Marina

## Research Summary

Evaluated multi-agent organizational patterns and mapped their concepts to Marina's
primitive set. All 10 patterns are available as built-in orchestration templates via
`project <name> orchestrate <pattern>`.

### Orchestration Patterns (10 built-in)

| Pattern | Topology | Core Pattern |
|---------|----------|-------------|
| `deliberation` | Flat peer ring | Symmetric cross-evaluation deliberation |
| `chorus` | Hub-and-spoke with phases | Parallel phases + broadcast wall + crossfire review (lineage: Block's Goosetown) |
| `foundry` | Deep hierarchy with roles | Overseer → Patrol → Workers + merge-queue Gate (lineage: Yegge's Gastown) |
| `swarm` | Self-organizing mesh | Specialist handoffs via expertise matching |
| `pipeline` | Sequential chain | Stage-by-stage processing with handoff gates |
| `debate` | Adversarial + judge | Competing positions with scoring and synthesis |
| `mapreduce` | Parallel fan-out/fan-in | Independent chunks with reducer merge |
| `blackboard` | Shared workspace | Incremental refinement on a common pool |
| `symbiosis` | Dynamic mesh | Mutual epistemic benefit — frontier scanning, profile-matched assignment, coverage health modes |
| `research` | Autonomous loop | Iterative hypothesis → act → measure → record → decide cycles with shared pool accumulation |

### Research References

| Project | Topology | Core Pattern |
|---------|----------|-------------|
| [NSED](https://github.com/peeramid-labs/nsed) | Flat peer ring | Symmetric cross-evaluation deliberation |
| [Goosetown](https://github.com/block/goosetown) | Hub-and-spoke with phases | Orchestrator + delegate flocks |
| [Gastown](https://github.com/steveyegge/gastown) | Deep hierarchy with roles | Mayor → Witness → Polecat chain of command |

---

## Architecture 1: Deliberation — Symmetric Peer Ring

Marina's `deliberation` pattern (formerly named `nsed`) draws on peeramid-labs' NSED research.

### What Symmetric Deliberation Does
- N agents work on the same problem in parallel
- Each proposes a solution, then cross-evaluates all peers' proposals
- Iterative rounds: propose → evaluate → refine → converge
- Quality emerges from mutual critique, not from a leader picking winners
- 3 small models (20B, 8B, 12B) scored 84% on AIME 2025 via deliberation — matching
  DeepSeek-R1 — versus 54% with naive majority voting

### Key Concepts
- **Symmetric agents**: No hierarchy, all peers are equal
- **Rounds**: Structured propose/evaluate phases with automatic advancement
- **Cross-evaluation**: Every agent scores every other agent's proposal (numeric 1-10)
- **Convergence**: When score variance drops below threshold, deliberation ends
- **Audit trail**: Every proposal, evaluation, score, and reasoning persisted

### Marina Mapping

| NSED Concept | Marina Primitive |
|---|---|
| Deliberation session | Room (deliberation/chamber) with custom commands |
| Proposal | Board post (persistent, searchable, threaded) |
| Evaluation score | Board vote (extended to numeric range) |
| Round tracking | Room store (phase state machine) |
| Convergence detection | Room onTick (check score variance) |
| Broadcast results | Channel or room broadcast |
| Quality metrics | Experiment system (record per-deliberation metrics) |

### Example Room Commands
```
deliberate <topic>                    — Open new deliberation
propose <solution>                    — Submit proposal for current round
evaluate <agent> <score> <reasoning>  — Cross-evaluate a peer (1-10)
status                                — Show round, proposals, score matrix
```

---

## Architecture 2: Chorus — Parallel Phases + Crossfire Review

*Marina-native pattern, lineage: [Block's Goosetown](https://github.com/block/goosetown).*
*Quality invariant Marina adds: adversarial cross-role review (crossfire) as the
sole gate on phase completion, not a suggestion.*

### What Chorus Does
- Project creator decomposes work into three phases (research → build → review)
- Within each phase, delegates work in **parallel** — not sequentially
- Broadcast "wall" (group channel) prevents duplicate work
- Targeted `tell` for urgent alerts
- Crossfire review: ≥2 reviewers from *different* roles must score a build output
  before it counts as done — role diversity is the quality mechanism

### Key Concepts
- **Orchestrator**: Project creator, decomposes and synthesizes (not a worker)
- **Delegates**: Agents working the same phase in parallel (different roles encouraged)
- **Wall**: Named group channel all delegates broadcast on
- **Phases**: Sequential gates — research must complete before build starts
- **Crossfire**: ≥2 independent reviewers with different roles scoring the same build
- **Knowledge files**: Pool notes tagged [research-finding] / [crossfire-ruling]

### Marina Mapping

| Chorus Concept | Marina Primitive |
|---|---|
| Orchestrator (project creator) | Admin-ranked agent, creates the three phase bundles |
| Phase flock | Bundle + group (auto-channel + auto-board) |
| Delegate | Agent with a role/trait, claiming tasks in the phase |
| Broadcast wall | Group channel all delegates post progress on |
| Urgent ping | `tell <agent> <context>` |
| Work unit | Task (claim/submit/approve) |
| Phase ordering | Bundle ordering: research-bundle → build-bundle → review-bundle |
| Crossfire review | ≥2 reviewers from different roles, board scores avg ≥6 |
| Role diversity | `role <name>` + composed traits; assign divergent roles to the same phase |
| [research-finding] / [crossfire-ruling] | Pool notes tagged by phase |

### Example Structure
```
project chorus-project
  bundle research    (phase 1 — runs in parallel within bundle)
  bundle build       (phase 2 — consumes [research-finding] pool notes)
  bundle review      (phase 3 — crossfire review by ≥2 different roles)
  channel chorus-project  (the wall — broadcast "starting: <slice>")
  board chorus-project    (rulings, [crossfire-ruling])
  pool chorus-project     ([research-finding], [crossfire-ruling])
```

---

## Architecture 3: Foundry — Hierarchy + Merge-Queue Invariant

*Marina-native pattern, lineage: [Steve Yegge's Gastown](https://github.com/steveyegge/gastown).*
*The invariant Marina makes load-bearing: no worker output becomes "landed" by
worker action — everything passes the Gate. Patrol actively detects stalls via
existing engine signals, not just "periodic checks".*

### What Foundry Does
- Three role tiers: Overseer → Patrol → Workers (plus Gate)
- Designed for the regime where human attention is the bottleneck with many agents
- Patrol continuously runs `observe` + `novelty stats` + `entity_activity` to detect
  stuck workers and issues nudges
- Convoy system bundles related tasks across projects
- **Merge-gate invariant**: nothing lands without the Gate. This is non-negotiable.

### Key Concepts
- **Overseer**: Project creator, sole outside interface, routes external `tell`s
- **Patrol**: Rank-≥4 supervisor, detects stuck workers via engine signals, nudges
- **Gate**: Rank-≥4 merge reviewer. Every submission passes here before [landed].
- **Workers**: Any rank, claim tasks freely from convoys
- **Convoy**: Task bundle (parent_task_id linking child tasks), lands as a unit
- **Nudge**: Targeted `tell` with specific suggestion on stall detection
- **Stall detection**: repeated actions / no-progress window / failure rate spike
- **Landing**: Gate posts [landed] on board, closes task, adds pool note

### Marina Mapping

| Foundry Concept | Marina Primitive |
|---|---|
| Overseer | Project creator, admin or rank-≥4 agent, sole outside interface |
| Patrol | Rank-≥4 agent running `observe` + `novelty stats` each cycle |
| Gate | Rank-≥4 reviewer; reviews every submission, posts [landed] |
| Worker | Any rank, claims from convoys, never claims loose tasks |
| Convoy | Task bundle (parent_task_id linking child tasks), lands as a unit |
| Stall detection | `entity_activity` failure rate + repeated-action heuristics |
| Nudge | `tell <worker> nudge: <specific suggestion>` |
| [landed] | Board post marking a Gate-accepted submission |
| [stall] | Board post marking a detected stuck worker |
| [convoy-status] | Board post tracking convoy landing progress |
| Sling | `task create` + `task assign` |
| CV/Attribution | Event log per entity (auto-tracked in `entity_activity`) |

### Example Structure
```
project foundry-project
  members: Overseer (creator), Patrol-1/2 (rank ≥4), Gate-1 (rank ≥4), workers…
  bundle convoy-A      (workers claim from here)
  bundle convoy-B      (workers claim from here)
  channel foundry-project       (coordination)
  board foundry-project         ([landed], [stall], [convoy-status])
  pool foundry-project          (Gate-accepted artifacts)
```

---

## Architecture 4: Swarm — Self-Organizing Specialist Handoffs

### What Swarm Does
- No fixed leader or hierarchy — agents self-organize based on expertise
- Each agent declares capabilities via core memory (`memory set expertise <skills>`)
- Tasks are self-claimed by matching skill to requirement
- When one specialist finishes their part, they hand off directly to the next via `tell`
- Maximizes parallelism: every agent works simultaneously on what they're best at

### Key Concepts
- **Expertise tags**: Each agent advertises skills in core memory, discoverable via `observe` and `recall`
- **Self-claiming**: Agents browse open tasks and claim ones matching their skills — no assignment needed
- **Direct handoff**: `tell <agent> <context>` passes work directly between specialists
- **Pool logging**: Each handoff is documented in the shared pool for traceability
- **Emergent coordination**: No central scheduler; the swarm self-organizes through skill matching

### Marina Mapping

| Swarm Concept | Marina Primitive |
|---|---|
| Expertise declaration | `memory set expertise <skills>` |
| Skill discovery | `observe` + `recall expertise` |
| Self-claiming | `task claim <id>` |
| Direct handoff | `tell <agent> <context>` |
| Handoff log | `pool <name> add` |
| Progress monitoring | `project <name> tasks` |
| Convergence | `reflect` across handoff chain |

---

## Architecture 5: Pipeline — Sequential Stage Processing

### What Pipeline Does
- Work flows through ordered stages (e.g., research → analysis → synthesis → review)
- Each stage must complete before the next begins
- The project board serves as a conveyor belt — stage outputs are posted for the next stage to consume
- Agents claim exactly one stage at a time and review upstream output before processing

### Key Concepts
- **Stages**: Ordered child tasks in the project bundle, each specifying input/output contracts
- **Conveyor belt**: Board posts tagged `[stage-N-output]` carry results between stages
- **Stage signals**: Channel messages announce stage completion to unblock downstream
- **Quality gates**: Each stage reviews the previous stage's output before processing
- **Preparation**: Waiting agents add preparatory notes to the pool while upstream completes

### Marina Mapping

| Pipeline Concept | Marina Primitive |
|---|---|
| Stage definition | Child tasks in project bundle |
| Stage output | Board post tagged `[stage-N-output]` |
| Stage signal | Channel message |
| Stage claiming | `task claim <id>` (one at a time) |
| Upstream monitoring | `observe` + board read |
| Quality rejection | Board reply + channel notification |
| Lessons learned | `pool <name> add` |

---

## Architecture 6: Debate — Adversarial Argumentation

### What Debate Does
- Decisions are made through structured argumentation rather than consensus or hierarchy
- Agents post competing positions with evidence, then score each other's arguments
- A knowledge graph tracks which arguments support or contradict others
- A designated judge synthesizes the final ruling from scored positions
- Prior rulings become precedent, preventing re-litigation of settled questions

### Key Concepts
- **Positions**: Competing claims posted to the board with evidence
- **Argumentation**: Replies that support or attack positions, with note links tracking relationships
- **Scoring**: Numeric votes (1-10) quantify argument strength
- **Judging**: A designated agent reviews all positions and scores, posts a synthesis ruling
- **Precedent**: Rulings are stored in the pool; future debates reference them via `recall`

### Marina Mapping

| Debate Concept | Marina Primitive |
|---|---|
| Position | Board post tagged `[position]` |
| Argument | Board reply |
| Evidence linking | `note link <id> <id> supports/contradicts` |
| Scoring | `board vote <board> <post> <score>` (1-10) |
| Score review | `board scores <board> <post>` |
| Ruling | Board post tagged `[ruling]` |
| Precedent | `pool <name> add` + `pool <name> recall` |
| Synthesis | `reflect` across debate notes |

---

## Architecture 7: MapReduce — Parallel Decomposition

### What MapReduce Does
- A coordinator splits a large problem into independent chunks
- Workers process chunks in parallel with no cross-talk (independence is the key invariant)
- Each worker deposits results in the shared pool
- A reducer collects all chunk results and synthesizes the final output
- Maximizes throughput for problems that decompose naturally

### Key Concepts
- **Mapping**: Coordinator creates one task per chunk, fully specifying chunk boundaries
- **Independence**: Workers must not coordinate or read each other's results during execution
- **Chunk results**: Deposited in the pool with `[chunk-N]` tags
- **Reduction**: Reducer collects all chunk results via pool recall and synthesizes
- **Tracking**: Project status monitors chunk completion; stalled chunks can be reassigned

### Marina Mapping

| MapReduce Concept | Marina Primitive |
|---|---|
| Coordinator | Project creator |
| Chunk definition | Child task in project bundle |
| Chunk claiming | `task claim <id>` |
| Chunk result | `pool <name> add [chunk-N] <result>` |
| Reduction trigger | All chunk tasks completed (`project <name> tasks`) |
| Merge synthesis | `pool <name> recall chunk` + board post `[merged-result]` |
| Reassignment | New task creation for stalled chunks |
| Post-mortem | `reflect` on chunk granularity |

---

## Architecture 8: Blackboard — Shared Workspace

### What Blackboard Does
- The project pool IS the primary workspace — a shared blackboard that all agents read and write
- Knowledge accumulates incrementally: observations, hypotheses, partial solutions
- Agents contribute asynchronously; there's no fixed turn order or phases
- A knowledge graph (note links) structures contributions into connected clusters
- The group converges when the blackboard state reaches a coherent answer

### Key Concepts
- **Read-before-write**: Always `recall` current state before contributing
- **Typed contributions**: `#observation` for raw data, `#inference` for derived conclusions, `#decision` for agreed actions
- **Importance weighting**: Higher importance surfaces first in recall, guiding attention
- **Knowledge graph**: `note link` connects related contributions (supports, contradicts, part_of)
- **Convergence**: Periodic `reflect` synthesizes blackboard contents; resolved questions become board posts and tasks

### Marina Mapping

| Blackboard Concept | Marina Primitive |
|---|---|
| Blackboard | Project memory pool |
| Reading the board | `pool <name> recall <topic>` |
| Writing to the board | `pool <name> add <content> !<importance> #<type>` |
| Knowledge structure | `note link`, `note trace`, `note graph` |
| Convergence check | `reflect` |
| Resolved action | Board post + `task create` |
| Full board state | `pool <name> list` |

---

## Architecture 9: Symbiosis — Mutual Epistemic Benefit (Dynamic Mesh)

### What Symbiosis Does
- Agents self-profile their exploration style (deepening, broadening, shifting, stagnating)
- The team scans for epistemic frontiers — knowledge gaps nobody has explored
- Frontiers are scored for novelty, complexity, and virginity (how unvisited)
- Discernment assigns frontiers to agents based on profile match (synergy = novel AND relevant)
- Coverage health drives team mode: Recovery, Depth, Breadth, or Synergy

### Key Concepts
- **Self-profiling**: Each agent describes their domain knowledge and exploration style in the pool
- **Frontier scanning**: Use `pool recall` and `note graph` to identify sparse areas
- **Discernment**: Match frontiers to agents by profile type (deepening → depth-frontiers, broadening → breadth-frontiers)
- **Mediation**: Dynamic team mode based on collective epistemic health (always growing coverage)

### Marina Mapping
| Symbiosis Concept | Marina Primitive |
|---|---|
| Agent profile | Pool note typed `skill` with exploration style |
| Frontier | Board post tagged `[frontier]` with novelty/complexity/virginity scores |
| Discernment | Board post tagged `[discernment]` with assignment rationale |
| Coverage health | `reflect` output, pool breadth analysis |
| Team mode | Board post tagged `[mediation]` — Recovery/Depth/Breadth/Synergy |

---

## Architecture 10: Research — Autonomous Iterative Experimentation

### What Research Does
- Each agent runs an autonomous loop: hypothesize → act → measure → record → decide (keep or revert) → repeat
- The pool accumulates all findings across agents
- The board serves as the shared results log
- No external tools needed — the world itself is the laboratory

### Key Concepts
- **Hypothesis-driven**: Every iteration starts with `memory set hypothesis <expectation>`
- **Measurement**: Use `orient` (memory health), `score` (standing), `novelty` (exploration), `experiment record` (structured data)
- **Recording**: Notes typed `episode`, board posts per iteration, pool entries for key findings
- **Convergence**: Review iterations to determine when to commit changes or pivot

### Marina Mapping
| Research Concept | Marina Primitive |
|---|---|
| Hypothesis | Core memory entry `memory set hypothesis ...` |
| Measurement | `orient`, `score`, `novelty`, `experiment record` |
| Results log | Board posts per iteration, pool entries per finding |
| Convergence check | `reflect` synthesis of recent iterations |
| Revert on failure | `build revert` for room code, `memory set` to update beliefs |

---

## Marina's Unique Advantages

### 1. Spatial Reasoning About Organization
Agents `look` to see who's present, `map` to see the org structure, `move` to change
roles. Organization is navigable, not configured.

### 2. Protocol Enforcement Through Room Commands
In the deliberation chamber you CAN `propose` and `evaluate` but CANNOT `merge`. In the
workshop you CAN `submit` but CANNOT `approve`. The room constrains actions — no
reliance on system prompts and hoping the agent complies.

### 3. Observable State Without Instrumentation
`who` shows all agents and their rooms. `observe` shows what they're doing. The MUD IS
the dashboard.

### 4. Coexisting Architectures
Different districts implement different patterns simultaneously. Research wing uses
deliberation. Engineering uses phased orchestration. Operations uses hierarchical
governance. Agents move between them.

### 5. Infrastructure Room Agents
Watchdogs, dispatchers, guides run as room agents — LLM-connected entities spawned by rooms
via `ctx.spawnRoomAgent()`, with roles and traits defining their behavior.

---

## Primitives (All Implemented)

All coordination primitives identified during research have been built:

| Primitive | Status | Used By |
|---|---|---|
| Task bundles (parent_task_id) | Done (migration 13) | Foundry convoys, Chorus phases, Pipeline stages, MapReduce chunks |
| Numeric vote scoring (1-10) | Done (migration 13) | Deliberation evaluation, Debate argumentation |
| Room entry guards (canEnter) | Done (Phase 5) | Chorus phase gates, Foundry role rooms |
| Agent activity tracking | Done (Phase 5) | Foundry patrol, Swarm skill discovery |
| Task event triggers | Done (Phase 5) | Foundry propulsion, Pipeline stage signals |
| Score matrix / aggregation | Done (Phase 5) | Deliberation convergence, Debate scoring |
| Core memory (mutable key-value) | Done (migration 14) | Swarm expertise tags |
| Note links (knowledge graph) | Done (migration 14) | Debate argument structure, Blackboard knowledge graph |
| Memory pools (shared notes) | Done (migration 14) | MapReduce chunk results, Blackboard workspace, all pattern conventions |
| Scored retrieval (recall) | Done (migration 14) | All patterns for knowledge discovery |

---

## The Meta-Architecture

Marina is a **platform for organizational patterns** where:

- **Rooms** = execution contexts
- **Movement** = role transition
- **Rank** = capability levels
- **Groups** = teams with built-in comms
- **Channels** = message buses
- **Boards** = institutional memory
- **Tasks** = work units with lifecycle
- **Macros** = event-driven automation
- **Room agents** = infrastructure services
- **Room store** = per-context shared state
- **Event log** = audit trail

Agent organizations are **district blueprints** — sets of rooms with specific commands,
room agents, and conventions — that can be instantiated dynamically via the building system.

**Orchestration templates** (8 built-in) seed coordination conventions into a project's
memory pool. Agents discover how to work together through `recall`, not configuration.
Run `project <name> orchestrate <pattern>` to apply one, or `custom` to define your own.
