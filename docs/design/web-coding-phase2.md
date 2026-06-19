# Web Coding — Phase 2 (WebChat Coding MVP)

Status: **draft / in progress** · Parent design: [web-coding-cli.md](./web-coding-cli.md) §"Phase 2: WebChat Coding MVP"

Phase 2's goal (verbatim from the parent doc): *"usable Claude/Codex-style coding chat
inside the dashboard, backed by Marina state."* This document records what Phase 2
already delivered, what remains, and a concrete build order for the rest. It supersedes
nothing — Phases 1 and 3 are done; this fills the WebChat surface between them.

## What Phase 2 already ships

Verified against `dashboard/src/components/WebChat.tsx` (≈639 lines added in `4f118a4`,
+29 in `66753b6`):

- **Coding-event renderers** — `renderCodeMessage` (`WebChat.tsx:1239`) renders every
  coding event type with a distinct icon, status badge, and failure styling:
  `command`, `verification`, `readiness`, `patch`, `tree`, `session`, `model`, `skill`,
  `profile`, `artifact`. Diffs render with `+/-/@@` syntax coloring (`renderCodeBlock`,
  `:1076`); command output and plain text get their own variants.
- **Session header / status chip bar** — the code-context chips (`:956`–`:1012`) show the
  active session id, session status, workspace cwd, model target, latest artifact
  (kind/status/lifecycle), and a pending-patch count.
- **Inline tool calls, logs, diffs, and attachments** — path chips (`:1337`), exit
  code / duration / timeout / truncation footers (`:1358`), per-event log rows
  (`renderCodeEvents`, `:1220`), check grids, and artifact rows all render inline.
- **Actionable next-step suggestions** — `renderCodeActions(code.commands)` turns the
  command's suggested follow-ups (e.g. `code status`, `code show <id>`) into clickable
  chips. Approvals currently surface this way: `code approve <id>` / `code deny <id>`
  arrive as suggested commands rather than dedicated buttons.
- **Transport** — events flow over the existing WS perception stream tagged with
  `coding_session_id` (`src/types.ts:42`); no polling needed for live updates.

So the **live, append-only coding transcript is done**. The gaps are all about
*navigating state that scrolled off* and *first-class affordances*.

## What remains in Phase 2

Mapped to the parent doc's Phase 2 checklist (`web-coding-cli.md:835`–`843`):

| Item | Status | Note |
|------|--------|------|
| WebChat renderers for coding events | ✅ done | `renderCodeMessage` |
| Session header/status chip in rich mode | ✅ done | code-context chip bar |
| Render tool calls, logs, diffs, approvals, attachments inline | ✅ done | inline in the transcript |
| **StatusOverlay views: session list, artifact list, diff/log inspection** | ❌ **todo** | needs a coding snapshot API + overlay |
| **Slash palette for active coding sessions** | ❌ **todo** | only the brief-driven `CompassSuggestion` exists today |
| **Persist active coding session id in localStorage** | ❌ **todo** | only view-mode is persisted (`MODE_STORAGE_KEY`) |
| Dedicated approval cards w/ approve/deny buttons | ➖ Phase 3 | inline command chips cover the MVP; multiuser decision UI is Phase 3 |

### Blocking dependency: a coding snapshot API

The existing overlays (tasks/boards/channels/groups/media) are **not** built from the WS
stream — they fetch a REST snapshot through react-query hooks
(`dashboard/src/hooks/use-status-cards.ts`) backed by `/api/coordination/*` routes in
`src/net/dashboard-api.ts`. The coding equivalent does **not** exist yet: Phase 1 took a
command-first path and skipped the `/api/coding/*` snapshot endpoints its own exit
criteria listed. The session/artifact overlays therefore can't be built until this lands.

The DB helpers are already in place — no schema work:
`MarinaDB.listCodingSessions` (`database.ts:3432`), `getCodingSession` (`:3426`),
`listCodingArtifacts` (`:3568`), `getCodingArtifact` (`:3562`), `listCodingEvents` (`:3497`).

## Build order

### Task 1 — Coding snapshot API (`src/net/dashboard-api.ts`)
Mirror the `/api/coordination/*` shape. Three read-only, auth-gated GET routes:

- `GET /api/coding/sessions?createdBy=&limit=` → `{ items: CodingSessionRow[], total }`
- `GET /api/coding/session/:id` → `{ session, events, artifacts }` (bounded limits)
- `GET /api/coding/session/:id/artifacts?kind=&limit=` → `CodingArtifactRow[]`

Privacy filter the same way `/who` does (no connection_id / raw input / internal tokens).
Tests in a new `test/coding-api.test.ts` following `test/dashboard-api*.test.ts`.

### Task 2 — Snapshot hooks (`dashboard/src/hooks/use-coding.ts`)
`useCodingSessionsSnapshot(enabled)` and `useCodingSessionDetail(id, enabled)` — same
`authFetch` + react-query pattern as `use-status-cards.ts`, `staleTime` ~15s. Add the row
types to `dashboard/src/lib/types.ts` mirroring `CodingSessionRow`/`CodingArtifactRow`.

### Task 3 — Overlays (`WebChat.tsx`)
Extend `OverlayType` (`:66`) with `"coding-sessions"` and `"coding-artifacts"`. Add a
`renderCodingOverlay()` alongside `renderTasksOverlay` (`:1401`):
- **Session list** — id, title, status, workspace, updated-at; click → resume + close.
- **Artifact list** — for the active session, grouped by kind; click an artifact → its
  full content (diff/log) in a scrollable inspector (reuse `renderCodeBlock`).
- Wire open-triggers in the command interceptor (`:520`–`:545`) so `code sessions` /
  `code show <id>` open the overlay instead of (or alongside) emitting to the transcript.

### Task 4 — Active-session persistence (`WebChat.tsx`)
Add a `CODING_SESSION_STORAGE_KEY` (scoped per instance, like the tour keys). Persist the
active `coding_session_id` whenever a `session`-typed code event arrives; on mount, restore
it into the context bar so a reload doesn't lose the active session. Clear on `code exit`.

### Task 5 — Coding-aware slash palette (`WebChat.tsx`)
When a coding session is active, surface a coding command palette (start/files/read/search/
diff/run/verify/patch/approve/exit) next to the existing `CompassSuggestion` block (`:1923`).
Source the verbs from the active profile's alias map so Codex/Claude/Pi vocab stays correct.

## Exit criteria

A user in the dashboard can: open a coding session, watch work stream inline (already
true), **and** — pull up a list of their sessions, jump back into one after a reload, open
any past artifact's full diff/log from an overlay, and drive the session from a slash
palette without memorizing the `code` subcommands. All backed by Marina DB state, not
client memory.

## Out of scope (later phases)

- Multiuser approval cards with decision routing — Phase 3 (`web-coding-cli.md:846`).
- Agent/crew spawn UI — Phase 4. (Backend `code spawn` now enforces the `agent.spawn`
  safety gate; see `src/engine/commands/code.ts` `runApprovedSpawnRequest`.)
- ACP/MCP rewiring through coding sessions, transcript import/export — Phase 5.
