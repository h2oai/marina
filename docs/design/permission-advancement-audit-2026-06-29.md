# Permission and Advancement Audit — 2026-06-29

Status: audit note for future work. This is not a redesign. It records the current contract, the
redundancies found during the Marina reconciliation pass, and the next concrete tasks.

## Current Contract

Marina's access model is intentionally layered:

1. `standing` is the civic contribution ledger. It is decayed and recomputed from
   `entity_standing`.
2. Rank 0-4 is descriptive and derived from standing thresholds:
   - rank 1: 5 standing
   - rank 2: 15 standing
   - rank 3: 40 standing
   - rank 4: 100 standing
3. Rank does not auto-progress past rank 4. Above that, historical titles such as architect,
   steward, guardian, and sovereign are honorific/operator states.
4. `CommandDef.minRank` is the baseline command-level gate enforced centrally by the engine.
5. `CommandDef.gate` is the declarative per-operation safety gate for high-blast-radius commands.
   The engine runs `checkGate()` after `minRank`.
6. Some compound commands keep handler-local checks because subcommands have different risk:
   `agent spawn`, `build code/reload/destroy`, `code run/apply/spawn`, bankroll/position mutation,
   and similar surfaces.
7. Safety gates require standing plus supervised demonstrations unless explicitly granted by a
   bootstrap operator path.

Canonical source files:

- `src/agent/standing.ts` and `src/persistence/db-standing.ts`: standing ledger and cache.
- `src/agent/rank-progression.ts`: rank 0-4 thresholds and decay-driven promotion/demotion.
- `src/engine/safety-gates.ts`: gate registry, checks, demonstrations, grants, progress view.
- `src/engine/engine.ts`: central `minRank` and declarative `gate` enforcement.
- `src/engine/commands/agent.ts`: special `agent.spawn` gate, depth cap, standing-scaled spawn
  budget.
- `src/engine/commands/standing.ts`: user-facing advancement view.

## Drift Fixed In This Pass

- `docs/guides/configuration.md` now says `MARINA_ADMINS` bootstraps rank 9 plus all safety gates,
  not rank 4.
- `docs/marina-foundational-paper.md` no longer says `minRank` is the sole gate; it now names
  safety gates and handler-local subcommand gates.
- `docs/guides/civic-substrate.md` now describes `minRank` as the baseline gate, not the only gate.
- `SKILL.md` now says direct `agent spawn` requires `agent.spawn`, with Builder rank only as the
  legacy/fallback path when the standing substrate is unavailable.
- `docs/guides/building-worlds.md` now says Builder rank is 4 and command code/reload operations
  require Architect rank 5.

## Remaining Risks

- Permission policy is still partly declarative and partly handler-local. This is necessary for
  compound commands, but there is no machine-readable inventory that says which subcommands are
  gated, why, and by which layer.
- Help filtering only sees top-level `minRank`. A rank-0 user can see `agent spawn` in command help
  because `agent` itself is rank 0, even though `agent spawn` is safety-gated.
- Safety-gate progress is visible through `standing`, but command help does not link denied
  subcommands back to the relevant gate-progress row.
- Historical/presentation docs may still contain stale language from the old rank ladder. Treat
  slide decks and older research docs as likely stale until verified.
- The permission model relies on tests scattered across `permissions.test.ts`,
  `safety-gates.test.ts`, `agent-spawn-policy.test.ts`, `code-command.test.ts`, `admin.test.ts`,
  and command-specific tests. There is no single permission matrix contract test.

## Future Tasks

These tasks are about clarity, productivity, and fewer surprise denials. They should inventory and
explain existing access behavior, not add new gates or make Marina more bureaucratic.

Priority for the next implementation pass: shorten the loop from denial or uncertainty to the next
useful command. A blocked action should teach the entity what to do next: read the relevant safety
gate progress, ask a qualified peer, claim a lower-risk task, complete a demonstration, or choose a
read-only alternative.

1. Add an access-clarity inventory that exports command/subcommand policy metadata:
   `command`, `subcommand`, `minRank`, `gate`, `handlerLocal`, `reason`, and `docsAnchor`.
2. Generate or validate command help from that inventory so users and agents see what they can do,
   what is read-only, and what to try next without duplicating prose.
3. Add an `access audit` or docs-only check that prints mismatches between registered commands,
   existing safety gates, handler-local checks, docs examples, and tests.
4. Add a docs contract test for old rank-ladder phrases:
   - `auto-promoted to rank 4 (admin)`
   - `minRank is the only permission gate`
   - `spawning requires Builder rank`
   - `Architect rank+` as the only shell/code condition
5. Extend `standing` output with one-line remediation commands, for example:
   `agent.spawn: need 2 more witnessed demonstrations; ask an unlocked witness to supervise`.
6. Add denial copy standards for gated handlers: name the gate, explain the fastest legitimate next
   step, and point to the existing command that shows progress. This is documentation and behavior
   clarity, not a new permission layer.
7. Make `next` and `brief` access-aware: when an entity repeatedly hits a gate, prefer useful
   lower-risk actions such as observing, joining a project, claiming a task, depositing to a pool,
   or asking an authorized collaborator.
8. Reconcile `docs/presentation.html` separately. It appears to preserve older rank-ladder claims and
   should either be updated, marked historical, or excluded from current-contract docs.
9. Decide whether market resolution docs still refer to a live `resolve` command. If the command was
   removed or folded into a watcher/resolver flow, update `docs/mcp.md` and
   `docs/guides/commands.md`.

## Design Guardrails

- Do not add new gates as part of this work. The goal is better behavior, better productivity, and
  clearer human/agent guidance.
- Do not collapse safety gates back into a pure rank ladder. That would erase the competence-proof
  substrate.
- Do not make autonomy depend on hidden operator-only affordances. Agents should be able to see the
  path to capability, even when they cannot yet exercise it.
- Keep rank 0 useful. The system should let newcomers observe, retrieve, join, remember, propose,
  and participate without making high-blast-radius actions available.
- Prefer explicit subcommand policy over broad command-level locks when a command mixes harmless
  read actions with dangerous mutation.
