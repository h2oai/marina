# Web Coding — Phase 3 completion + Phase 4 (scoped)

Status: **historical implementation record** · Branch/track references below describe the work at
the time and are not current status. See [web-coding-cli.md](./web-coding-cli.md) for the current
phase map.

This is the build contract for two parallel tracks. The **backend track** owns
`src/engine/commands/code.ts`, `src/engine/command-registry.ts`, and backend tests. The
**frontend track** owns `dashboard/src/components/WebChat.tsx` (+ `lib/types.ts` if needed).
They touch disjoint files and agree on the **artifact kinds + metadata** below so the UI can
render whatever the backend writes without a live dependency.

## Track F (frontend) — Phase 3 completion + Phase 4 UI, all in WebChat.tsx

### Phase 3 — dedicated approval cards with multiuser decision handling
Backend already exists: `code approve <id>` / `code deny <id>` mutate an `approval`-kind
artifact (status `pending` → `approved`/`denied`; the deciding entity lands in
`applied_by`/metadata). The Phase 2 API already serves artifacts via
`GET /api/coding/session/:id`. **No new backend needed.**

Render `approval`-kind (and `spawn_request`-kind, which is the same approve/deny flow)
artifacts as **interactive cards** in the WebChat coding transcript AND in the artifact
overlay:
- Show: title/what is being approved, requester (`created_by`), current status badge
  (pending=amber, approved=emerald, denied=red), and — when decided — the decider
  (`applied_by`) and decision time (`applied_at`).
- When `status === "pending"`: show **Approve** and **Deny** buttons that send
  `code approve <id>` / `code deny <id>` through the existing command path
  (`sendCommandWithOverlay`). When decided: buttons replaced by a read-only decision line
  (multiuser-aware — anyone viewing sees who decided).
- This upgrades today's behavior (approvals surfaced as plain command-suggestion chips).

### Phase 4 UI — crew & agents panel
Render these artifact kinds the backend track emits (read by kind string; tolerate absence):
- `crew_plan` — the proposed crew (goal + roles). Existing kind.
- `crew_dispatched` — **new** (Track B emits it): a real crew was created+dispatched.
  metadata: `{ crewId, crewName, channelId, members: [{agentName, role}], formation, goal }`.
  Render a "Crew dispatched" card showing crew name, members/roles, and the goal.
- `spawn_assignment` — existing; render launched coding agents (agent name + role).
- `session_task` — **new** (Track B emits it): a task linked to the session.
  metadata: `{ taskId, title }`. Render a small "Linked task #<id>" chip.

Group these into a compact "Crew & Agents" sub-section of the coding context, OR render
inline cards consistent with the existing `renderCodeMessage` styling. Reuse existing
icons (GitBranch/Network/Code2/Sparkles already imported). Keep it idiomatic.

## Track B (backend) — Phase 4 wiring in code.ts + command-registry.ts

### 4a — Real crew dispatch (`crewPlan` in code.ts)
Today `crewPlan` only writes a `crew_plan` artifact. Wire it to Marina's real crew
primitives **when available**, degrade to today's behavior otherwise.

- Plumb deps: add `crewManager?: CrewManager` and `channelManager?: ChannelManager` to
  `CodeDeps` (code.ts). Pass `crewManager: engine.crewManager` and
  `channelManager: engine.channelManager` at the `codeCommand({...})` registration in
  `command-registry.ts` (mirror how `crewCommand` receives `crews`/`channels`).
- API (from `src/coordination/crew-manager.ts`):
  - `crewManager.create({ name, goal, formation?, lifetime?, owner: EntityId, members: { agentName: string; role? }[] }): Crew`
  - `crewManager.dispatch(crewId, message, sender?: { id, name }): void`
  - `create` throws `CrewError` (duplicate_name, no_members, …) — catch and degrade.
- Syntax: `code crew <goal> [with <agentA,agentB,...>]`. Member resolution:
  - If members are named via `with …` and resolve to live agents (use the deps' agent
    lookup — add `findAgentByName`/`listAgents` to CodeDeps, mirror crewCommand), create a
    real crew (lifetime `ephemeral`, a sensible default formation e.g. `swarm` or
    `pipeline`), `dispatch` the goal, and emit a **`crew_dispatched`** artifact with the
    metadata shape above; still keep the `crew_plan` artifact as the proposal trail and
    link them (`createNoteLink` or artifact metadata `sourceArtifactId`).
  - If no members named / crewManager absent / create throws: keep current behavior (write
    `crew_plan`, tell the user how to name members or `code spawn`). **Never crash.**
- Crews need ≥1 member — autonomous team-formation from a bare goal is explicitly OUT of
  scope (see Deferred). The `with` list is how members are supplied for now.

### 4b — Session ↔ task linking + summary-to-pool
- `code task <title>` (new subcommand): `db.createTask({ title, description: "from coding session <id>", creatorId: entity.id, creatorName: entity.name })` → emit a **`session_task`** artifact `{ taskId, title }`. Link to session.
  Signature: `db.createTask(opts): number` (db-tasks.ts).
- Extend `code summary <notes>` and/or `code done`: when the session has an associated
  project/pool, deposit the summary into the pool via `db.addPoolNote(poolId, entity.name,
  content, importance?, noteType?)` AND write a personal note (`db.createNote`). Degrade
  silently when no pool/project is bound. Keep existing summary/handoff artifact behavior.
- This realizes the parent doc's "store session summaries into project pools and personal
  notes" (web-coding-cli.md:862).

### 4c — Handoff
- Verify `code handoff <notes>` writes a durable `handoff` artifact. If it already does
  (it should), leave it; optionally link the handoff to the active crew/crew_dispatched
  artifact when one exists. Minimal change.

### Backend tests
Extend `test/code-command.test.ts` (or a new `test/code-crew.test.ts`): real crew dispatch
when members named (assert a crew was created + `crew_dispatched` artifact emitted) and
graceful degradation when no crewManager (assert `crew_plan` still written, no throw);
`code task` creates a task + `session_task` artifact; summary deposits to a seeded pool.
Use a mock CrewManager/ChannelManager or the real ones from a test Engine, following the
existing test setup. All gated capabilities keep the safety-gate model intact.

## Deferred (explicitly NOT in this pass)
Worktree isolation, concurrent-edit conflict handling, dependency-install policy,
long-running process ownership, durable userland FS, autonomous crew member formation,
ACP/MCP rewiring (Phase 5). These carry open design questions (web-coding-cli.md:690–717).

## Exit criteria
- Phase 3: a pending approval renders as a card with working Approve/Deny; once decided it
  shows who decided. Verified in the dashboard build + transcript.
- Phase 4: `code crew <goal> with <agents>` dispatches a real crew (crew channel created,
  goal posted) and emits `crew_dispatched`; with no members it degrades to `crew_plan`
  without error. `code task` links a task. Summary deposits to a pool when bound.
- typecheck clean, lint clean, dashboard build OK, full backend suite green.
