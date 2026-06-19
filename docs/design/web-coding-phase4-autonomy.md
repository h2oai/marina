# Web Coding — Phase 4 completion: autonomous crew + write-safety

Status: **in progress** · Branch: `feat/coding-phase3-4` (extends PR #49) · Parent:
[web-coding-phase3-4.md](./web-coding-phase3-4.md)

This closes the two gaps that made Phase 4 feel incomplete. They are coupled: making
`code crew <goal>` form a team **automatically** immediately creates the parallel-edit
hazard, so autonomy and write-safety ship together.

**Decisions (locked with the operator):**
- **Crew sourcing = hybrid**: recruit idle coding agents first, then spawn the missing
  roles **through the `agent.spawn` safety gate**. Never bypass governance.
- **Write-safety = role-based single-writer**: one member holds the session write lock at a
  time; others read/advise via artifacts. No worktree/merge machinery. The lock is **null
  by default**, so existing solo sessions are unaffected (and all existing tests pass).

Out of scope (still): worktree isolation, merge queues, dependency installs beyond a safe
default, ACP/MCP rewiring (Phase 5), read-API confidentiality (parked by operator).

## Track A — write-lock substrate (`src/persistence/database.ts`)
Runs first; B and C build on it.

- **Migration 49** (append to the `migrations` array after version 48):
  `ALTER TABLE coding_sessions ADD COLUMN writer TEXT;` (nullable, default NULL).
- Add `writer: string | null` to the **`CodingSessionRow`** interface (~:4361). Confirm
  `getCodingSession` / `listCodingSessions` (SELECT *) surface it.
- Extend **`updateCodingSession`** (~:3445) patch type with `writer?: string | null` (it
  must accept explicit `null` to clear the lock — guard with `!== undefined`, not truthiness).
- That's the whole substrate. NULL `writer` = open session = no lock (back-compat).

In notes: confirm migration version number, the exact updateCodingSession patch key, and
that null-clearing works.

## Track B — autonomous assembly + lock enforcement (`src/engine/commands/code.ts`)
Build against Track A's `updateCodingSession({ writer })` and `session.writer`.

### B1 — Autonomous `code crew <goal>` (no `with` clause)
When no members are named, assemble the crew automatically (hybrid):
- Target roles: a default coding crew from `CODING_ROLES` — at minimum
  `implementer`, `reviewer`, `tester` (planner optional). 
- For each role: **recruit** an existing suitable coding agent (use `deps.listAgents` /
  `deps.findAgentByName`; prefer idle agents not already assigned). If none, **spawn** one
  via the gated path: `checkGate(deps.db, eid, "agent.spawn")` → if `ok`, `agentRuntime.spawn({...})`
  with the role + a session/goal-scoped attention, and `recordDemonstration` when
  `supervisedOnly`. (Mirror `runApprovedSpawnRequest`; the gate IS the governance — autonomous
  assembly does not need the manual per-agent approval artifact.)
- If the gate blocks spawning AND no recruits are available for a role, skip that role; if
  **zero** members can be assembled, degrade to today's `crew_plan`-only behavior with a
  clear message ("need agent.spawn competence or online coding agents").
- With ≥1 assembled member and crewManager+channelManager present: create + dispatch the
  crew exactly as the existing `dispatchCodingCrew` does (reuse it), emit `crew_dispatched`.
  Extend `crew_dispatched` metadata.members entries with `source: "recruited" | "spawned"`.
- `code crew <goal> with <agents>` (explicit) still works unchanged.
- **Set the write lock** on dispatch: `updateCodingSession(session.id, { writer: <implementer agent name> })`
  (the member with role implementer, else the first member). Announce who holds the lock.

### B2 — Write-lock enforcement (the mutating path)
- In `applyPatch` (~:3421) and any other path that mutates the workspace (apply/approve of a
  patch, checkpoint revert that writes): if `session.writer` is non-null AND
  `entity.name !== session.writer`, **refuse**: "`<writer>` holds the write lock for this
  session — request a handoff (`code handoff`) or have the owner reassign (`code writer <name>`)."
  When `session.writer` is null, impose **no** restriction (preserves all current behavior).
- Read/search/diff/verify/run remain open to all members regardless of the lock.

### B3 — Lock transfer commands
- `code writer` — show the current lock holder (or "open").
- `code writer <agent>` — reassign the lock. Allowed by the current lock holder OR the
  session creator/owner. Emits a `writer_changed` event/artifact.
- `code handoff <notes> [to <agent>]` — when `to <agent>` is given, transfer the write lock
  to that agent in addition to writing the existing handoff artifact.

### B4 — dependency-install safe default
Confirm the workspace command runner (`codeRunPolicy`/`run`) does not auto-run package
installs without approval. If it already restricts to pinned/approved commands, just note
that; do not loosen it. (Safe default = installs are not auto-allowed.)

### Tests (extend test/code-crew.test.ts or add test/code-writelock.test.ts)
- Lock: writer-set session refuses patch apply by a non-writer; allows the writer; **null
  writer = unrestricted** (assert an existing solo flow still applies a patch).
- Autonomous assembly: mock `agentRuntime`+`crewManager`+`channelManager`; `code crew <goal>`
  with no members spawns/recruits and dispatches (assert `crew_dispatched` + writer set to
  implementer). Gate-blocked + no recruits → degrades to `crew_plan`, no throw.
- `code writer <agent>` transfers; non-holder/non-owner is refused.
Keep the agent.spawn gate tests green.

In notes: list new subcommands, the writer metadata/event names, and any CodeDeps changes.

## Track C — UI (`dashboard/src/components/WebChat.tsx`)
Build against the artifact/session shapes above.
- **Write-lock chip**: when the active session has a non-null `writer`, show a "writer:
  <name>" chip in the code-context chip bar (the session detail from
  `GET /api/coding/session/:id` now carries `writer`; the code-context/session events should
  too — read defensively). Distinct styling (e.g. a lock icon) so it's obvious who can write.
- **Crew card**: extend the existing `crew_dispatched` card to show each member's
  `source` (recruited/spawned) when present.
- Optional: a small "request handoff" affordance on the writer chip that sends `code writer <me>`
  or `code handoff` — only if it fits cleanly; not required.

## Exit criteria
- `code crew <goal>` with NO `with` clause assembles a crew (recruit + gated spawn),
  dispatches it, and sets the implementer as write-lock holder — or degrades cleanly when
  it can't.
- A non-writer crew member cannot apply patches; the writer can; solo (null-writer) sessions
  are completely unaffected.
- `code writer`/`code handoff to` transfer the lock.
- typecheck clean, lint clean, dashboard build OK, full backend suite green.
