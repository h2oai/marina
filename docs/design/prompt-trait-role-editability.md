# Editing Prompts, Traits & Roles inside Marina — edit · propagate · audit · test

Status: **all four gaps built** — audit history, goal-conditional preview, propagate-on-edit
(`role reload`), and read-only `system-prompt` preview. Goal (now met): traits, roles, and the
prompts they compose are editable *inside the world*, with changes that **propagate** to running
agents (`role reload`), are **audited** (`trait`/`role history`), and can be **tested** before going
live (`role view … goal`, `system-prompt`).

## The reassuring finding: most of this already exists
A code audit (file:line below) shows the capability is largely present — the instinct to build a big
new "prompt editor" would mostly duplicate what's there.

| Capability | Traits | Roles | System prompt | Continuation prompt |
|---|---|---|---|---|
| **Edit (in-world)** | ✅ `trait create/delete` (rank 3) | ✅ `role create/edit/delete` (rank 3) | ⚠️ via the *role section* only (core is code) | ❌ code-only (a tuned state machine) |
| **Propagate (live)** | — | ✅ `agent config <name> role <r>` hot-swaps the system prompt + restarts the loop | ✅ (through role) | ❌ |
| **Audit (history)** | ✅ `trait history` | ✅ `role history` | ❌ | n/a |
| **Test (preview)** | ✅ `trait view`; `trait lint` checks shaping risks | ✅ `role view … goal`; `role lint` checks shaping risks | ✅ `system-prompt [role <name>] [goal <text>]` | ❌ |

Key code: `src/engine/commands/role.ts`, `trait.ts` (CRUD + view); `src/agent/roles.ts`
(`resolveRole`/`composeRolePrompt` — traits→prompt, synergy/tension, PRISM `applicableTasks` gating);
`src/agent/prompts/lean-system.ts` (`getLeanSystemPrompt` injects the role section); reconfigure
hot-swap in `agent-runtime.ts` + `lean-agent-adapter.ts` (`agent config role`). Editing is gated at
rank 3 today.

## The genuine gaps (what to build)
1. **Audit — there is NO edit history for traits/roles.** Saves are `INSERT OR REPLACE`; prior state
   is lost. Core memory already has the pattern to copy: `core_memory_history` +
   `getCoreMemoryHistory` + `memory history <key>` (`db-notes.ts`, `database.ts`). **This is the one
   real, bounded gap and the highest-value build.**
2. **Test — preview is static.** `role view` shows the composed prompt but not the *task-conditional*
   result (PRISM `applicableTasks` gating is applied at spawn from the goal). A
   `role view <name> goal <text>` would show what an agent *actually* gets for a given goal.
3. **Propagate — edit-then-refresh is manual/per-agent.** `agent config role` hot-swaps one agent;
   editing a role's *definition* does not refresh agents already running it. A "reconfigure agents on
   role X" (or refresh-on-edit) would close it.
4. **Prompts (system/continuation) — intentionally code-driven.** Recommendation: keep them code; the
   *role section* is the editable surface. Optionally add a read-only `system-prompt view` so an
   operator can see the full assembled prompt. Making the continuation prompt DB-editable is
   high-complexity, low-value (it's a token-budget-tuned machine) — **not recommended.**

## Build order (cheapest → most valuable; each small, reuse-based)
1. ✅ **Audit/history for traits + roles** *(built)* — migration 50 adds `trait_history` +
   `role_history` (mirroring `core_memory_history`). `saveTrait`/`saveRole` record old→new *only when
   the serialized definition changes* (so world re-seeding on boot doesn't spam history), via
   `recordEditHistory` in `db-agents.ts`. Read with `trait history <name>` / `role history <name>`
   (rank 0). History persists independently of the base table, so a delete+recreate trait keeps its
   trail.
2. ✅ **Goal-conditional preview** *(built)* — `role view <name> goal <text>` runs the same
   `inferTaskCategory` + `composeRolePrompt` PRISM gating an agent gets at spawn, prints the inferred
   task category, lists suppressed (out-of-scope) traits, and shows the effective prompt. *Test*
   behavior before assigning.
3. ✅ **Propagation on edit** *(built)* — `role reload <name>` (rank 3) finds running agents bound to
   the role (live states only) and calls `agentRuntime.reconfigure(agent, { role })`, which re-derives
   each agent's system prompt from the now-edited DB role (re-inferring task category from the agent's
   current goal). Reports which agents reloaded / failed. Edit → reload is the explicit propagate step.
4. ✅ **Read-only `system-prompt` preview** *(built)* — `system-prompt [role <name>] [goal <text>]`
   (alias `sysprompt`, rank 0) shows the fully assembled `getLeanSystemPrompt` output: base prompt with
   no role, or with a role's composed (and optionally goal-gated) section spliced in. Makes the
   otherwise-invisible system-prompt assembly inspectable without making it editable.

## Principles (so this stays Marina-shaped, not a bolted-on CMS)
- **Reuse the audit pattern** (`core_memory_history`), not a new versioning system.
- **Editing is earned** — keep the rank-3 gate (or move to a `role.edit` safety gate later); edits are
  attributable (`changed_by`).
- **Don't make the core prompts DB-editable** — the role/trait composition is the right surface;
  the system identity and the continuation machine stay code, stable and testable in CI.
- **Preview before propagate** — `view` (and goal-conditional view) is the test step; propagation is
  the explicit second action.
