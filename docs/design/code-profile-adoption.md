# Code Profile Adoption Map

## Purpose

Code Mode profiles are migration ramps, not separate coding systems. Each profile should preserve a
familiar prompt, vocabulary, and working rhythm while routing to the same Marina primitives:
sessions, workspace reads, search, diffs, command-output artifacts, patch proposals, approvals, and
history.

The adoption curve should be measured by how often a user can type the thing they already know and
land on the correct Marina action without learning a new command taxonomy first.

Profiles are interface adapters, not vendor bindings. A `claude>`, `codex>`, or `pi>` prompt should
preserve enough syntax and rhythm for migration, but the durable contract is the Marina primitive:
sessions, artifacts, events, approvals, and workspace capabilities. This lets Marina connect many
LLMs and coding styles without locking the civilization layer to one provider's CLI semantics.

## Compatibility Grade Model

| Grade | Meaning |
| --- | --- |
| `native` | A Marina primitive with equivalent or stronger semantics. |
| `adapter` | A familiar verb maps cleanly to a Marina action. |
| `narrow` | The command is useful today, but does not yet replicate the richer behavior users may expect from another tool. |
| `planned` | Important for coding-agent effectiveness, but not implemented yet. |

## Current Profiles

| Profile | Prompt | User expectation | Marina equivalent | Current fit |
| --- | --- | --- | --- | --- |
| `marina` | `code>` | Explicit native primitives | `start`, `files`, `read`, `search`, `diff`, `run`, `patch`, `apply`, `history` | Strong baseline |
| `pi` | `pi>` | Lightweight harness vocabulary | Aliases over read, diff, run, artifacts, history, steering | Good vocabulary bridge |
| `claude` | `claude>` | Conversational coding loop with planning, review, shell, compacting | Steering events, diff review, patch proposals, allowlisted runs | Good entry bridge; needs richer plans/todos |
| `codex` | `codex>` | Concise CLI task loop: inspect, patch, run, verify | File listing, reads, search, diffs, verification commands, stored artifacts | Strong local-loop bridge |

## Verb Mapping

| Familiar action | `marina` | `pi` | `claude` | `codex` | Canonical Marina primitive | Grade | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Enter coding mode | `code` | `code profile use pi`, then `code` | `code profile use claude`, then `code` | `code profile use codex`, then `code` | `active_modal=code` | `native` | Implemented |
| Select workspace | `workspace use` | `workspace use` | `workspace use` | `workspace use` | Session workspace root from configured roots | `native` | Implemented |
| Diagnose setup | `doctor` | `doctor` | `doctor` | `doctor` | Workspace readiness report | `native` | Implemented |
| Start work | `start` or `new` | `start` | `start` | `start` | `coding_session` row plus `session_started` event | `native` | Implemented |
| Ask code model | `ask` | `ask` | `ask` | `ask` | Direct Marina model response artifact | `native` | Implemented |
| Assign live agent | `assign` | `assign` | `assign` | `assign` | Existing Marina agent attention packet plus session binding | `native` | Implemented |
| List sessions | `list` or `sessions` | `tree` | `list` | `list` | `listCodingSessions` | `adapter` | Implemented |
| Resume work | `resume` or `use` | `switch` | `resume` | `resume` | `coding_session_id` entity property | `adapter` | Implemented |
| Inspect files | `files` or `ls` | `files` | `files` | `inspect` | Workspace file listing | `adapter` | Implemented |
| Read file | `read` or `cat` | `open` | `open` | `view` or `open` | Path-confined workspace read | `adapter` | Implemented |
| Search | `search` | `grep` | `grep` | `rg` or `grep` | Workspace text search | `adapter` | Implemented |
| Review changes | `diff` | `changes` | `review` | `changes` | Git diff artifact/display | `narrow` | Implemented |
| Run a command | `run` | `exec` | `bash` or `shell` | `exec` or `shell` | Allowlisted workspace command output artifact | `narrow` | Implemented |
| Run app smoke | `run app` | `exec app` | `bash dev` | `run app` | Container/userland-gated app-run artifact | `planned` | Disabled in host mode |
| Observe behavior | `observe` | `note` | `/verify` observation step | browser/test note | Observation artifact | `narrow` | Implemented |
| Run tests | `test` or `run test` | `exec test` | `bash test` | `test`, `verify`, or `check` | `bun run test` through allowlist | `narrow` | Implemented |
| Typecheck | `typecheck` or `run typecheck` | `exec typecheck` | `bash typecheck` | `typecheck` | `bun run typecheck` through allowlist | `narrow` | Implemented |
| Propose edit | `patch` or `propose` | `proposal` | `edit` | `patch` | Stored pending unified-diff artifact | `narrow` | Implemented |
| Accept edit | `apply` | `accept` | `accept` | `accept` | Apply stored patch | `adapter` | Implemented |
| Reject edit | `reject` | `decline` | `reject` | `reject` | Mark stored patch rejected | `adapter` | Implemented |
| View outputs | `artifacts` or `show` | `outputs` | `show` | `show` | Coding artifact listing/display | `adapter` | Implemented |
| Record direction | `steer` or `note` | `follow`, `followup`, or `note` | `plan`, `think`, `compact`, or `note` | `plan` or `note` | `session_steered` event and typed artifacts | `native` | Implemented |
| Exit mode | `exit`, `back`, or `world` | `exit` | `exit` | `exit` | Clear active modal | `native` | Implemented |

## Adoption Curve

### Stage 1: Prompt And Alias Familiarity

Goal: a migrating user can enter Code Mode, see their expected prompt, and type familiar commands.

Covered now:

- Stored per-user `code_profile`.
- Stored per-user selected workspace for new sessions.
- WebChat and telnet prompt labels.
- Profile-specific help, aliases, and steering vocabulary.
- Core local coding loop: inspect, read, search, diff, run, patch, apply, reject, history.
- Strategy routing for direct model prompts and assignment to existing live Marina agents.
- Assigned live agents are bound into the coding session when their adapter exposes an entity id.
- The default single-agent driver uses a compact `coding-agent` role with a persisted, live-streamed
  inspect → plan → patch → verify → summary lifecycle.
- Full and crew agents have a structured `marina_code` tool; minimal agents keep
  `marina_command` as the compact fallback.
- Workspace onboarding does not assume Marina was launched inside a repo; `code workspace` and
  `code doctor` make the active root explicit.

Remaining:

- Profile-specific examples in richer WebChat UI.
- Import/export of a user's alias preferences beyond the built-in profile.
- Per-profile grade scoring for commands whose vendor behavior has not been fully audited.

### Stage 2: Workflow Equivalence

Goal: common tool habits feel equivalent, not merely aliased.

Gaps:

- Claude-style `plan`, `think`, and `compact` are currently steering events. They should become
  first-class plan/summary artifacts when the session transcript model lands.
- Codex-style `verify` currently maps to tests. It should eventually inspect project metadata and
  choose test, typecheck, lint, or build based on the workspace.
- Pi-style `tree` currently maps to event history. It should eventually show a session artifact tree
  with branches, checkpoints, and outputs.
- Spawn and crew strategies should reuse existing Marina safety gates and conductor Scores rather
  than bypassing agent governance from inside Code Mode.
- Coding skills need a two-layer import model: base Marina skills in the existing skill/memory
  substrate, plus profile/session skills that add coding aliases, steering, and reusable loops.
- Cursor-style workflows are not represented yet because Cursor is primarily editor/workspace UI.
  The Marina equivalent is likely file overlays, selection-aware edits, and ACP/editor integration,
  not only CLI aliases.

### Stage 3: Native Marina Superpowers

Goal: users keep their familiar profile but start relying on Marina capabilities other tools do not
make central.

Native differentiators to expose through every profile:

- Multiuser shared coding sessions with visible participants and handoffs.
- Agent collaborators as Marina entities with memory, standing, tasks, and room presence.
- Durable artifacts for patches, command output, plans, screenshots, and summaries.
- Shared approval cards for risky commands, file writes, network, secrets, and commits.
- Session forks across worktrees or userland workspace checkpoints.
- Publishing outputs to boards, channels, canvas, chronicle, and project tasks.

## Implementation Priority

1. Add `code profile compare` and `code profile help <name>` using this mapping.
2. Store profile preferences as an editable per-user alias map layered over the built-ins.
3. Promote steering into typed artifacts: `plan`, `summary`, `handoff`, and `decision`.
4. Add session tree/checkpoint views so `pi tree`, `claude compact`, and `codex resume` become
   substantively useful, not just vocabulary-compatible.
5. Add Cursor/editor profile later through ACP and file-selection context rather than a prompt-only
   alias profile.

## Evaluation Questions

- Can a user complete inspect, edit, test, and apply without reading Marina-specific help?
- Which familiar commands fall through to help or unknown command?
- Which aliases create surprising side effects?
- Does the prompt make the active mode obvious in WebChat, telnet, and future editor clients?
- Are profile differences only vocabulary, or do they eventually shape artifact views and defaults?
- Can teams mix profiles in one shared session without fragmenting the canonical transcript?
