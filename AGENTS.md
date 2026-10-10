# Repository Guidelines

> **Full conventions live in [CLAUDE.md](CLAUDE.md)** — despite the name, it applies to every
> coding agent (Codex, Cursor, Zed, Gemini CLI, …), not just Claude. It carries the complete
> architecture rules, memory-tier semantics, and a key-file map. Long-form design, history, and
> per-feature walkthroughs live in [docs/architecture/](docs/architecture/README.md). This file is
> the quick reference; when the two disagree, CLAUDE.md wins.

## Project Structure & Module Organization
- `src/` contains the Bun TypeScript backend; note submodules for `agent/`, `engine/`, `world/`, and network adapters under `net/`.
- `dashboard/` houses the Vite + Bun powered UI; it is a member of the single root Bun workspace (one root `bun install`) with its own `package.json` and vitest suite.
- `test/` holds backend specs; helper utilities live in `test/helpers.ts`.
- `worlds/` and `seeds/` ship canonical world content—never commit generated `marina.db*` files or the local `data/` directory (both are gitignored).
- `docs/`, `examples/`, and `scripts/` capture reference material, sample flows, and operational tooling.

## Build, Test, and Development Commands
- `bun install` installs workspace dependencies (Bun ≥ 1.4.2 required).
- `bun run dev` starts the simulation server on `:3300`; use `bun run dashboard:dev` for the web UI on `:5173`.
- `bun run build` produces a Bun-compatible bundle in `dist/`; `bun run dashboard:build` emits the production UI.
- `bun run test` exercises backend tests; add `cd dashboard && bun run test` for UI smoke coverage.
- `bun run bench` runs the benchmark harness; `bun run clean` resets local databases and scratch data.

## Coding Style & Naming Conventions
- Formatter and linter: [Biome](https://biomejs.dev). Run `bun run format` before commits; line width 100, indent 2 spaces.
- Stick to strict TypeScript; prefer branded ID types (`RoomId`, `EntityId`) at boundaries.
- File names stay lower-case with hyphens (`telnet-server.ts`); tests mirror sources (`src/net/url-guard.ts` → `test/url-guard.test.ts`).
- Import order is alphabetical by path, enforced by Biome’s `organizeImports`.

## Testing Guidelines
- Use Bun’s native test runner with `*.test.ts` files in `test/`; shared utilities live in `test/helpers.ts`.
- Keep assertions deterministic; poll with `until()` from `test/helpers.ts` instead of real sleeps, and use `createTestEngine()` (`test/engine-fixture.ts`) for an isolated world.
- Maintain coverage for new branches and command handlers; add regression tests when fixing bugs.

## Architecture Rules (must-follow)
- **Migrations are append-only**: add to `FORWARD_MIGRATIONS` in `src/persistence/schema.ts` (re-exported by `database.ts`); never modify an existing migration or the schema-137 baseline; `schema-history.ts` preserves upgrades from older databases.
- **Commands**: one file per command in `src/engine/commands/`, registered in `src/engine/command-registry.ts` → `registerBuiltinCommands()`.
- **Permissions**: `minRank` (and optional `gate`) on `CommandDef` is the permission gate — don't add custom rank checks inside handlers.
- **DB naming**: the groups table is `groups_` (trailing underscore — `groups` is an SQL keyword). New FTS5 tables need insert/update/delete triggers.
- **DB modules**: query logic lives in `src/persistence/db-*.ts` standalone functions; `MarinaDB` delegates to them.
- **MCP tools**: new world commands need no MCP schema — `category`/`help`/`usage` on `CommandDef` publish them via `src/net/mcp-world-tools.ts`; execution always goes through the rate-limited `runCmd()` / `cmdTool()` helpers.
- **Tick budget**: room `onTick` handlers must complete within 200ms total.
- **Errors**: use `getErrorMessage()` for extraction; wrap non-critical DB ops in `tryLog()` / `tryLogAsync()`.
- **Sandbox execution**: never silently fall back from requested sandbox execution to host execution, and never imply host/guest file coherence.

## Commit & Pull Request Guidelines
- Use feature branches and pull requests for every change; never push directly to `main`.
- Commit/push requests mean publishing the feature branch and opening or updating its PR. Leave it for review unless merge is explicitly requested; required CI must pass on the latest revision. Never bypass checks, reviews, or branch protection.
- Follow Conventional Commits (`type(scope): short explanation`), matching existing history (`feat(webchat): …`).
- Squash work into logical commits; run `bun run typecheck`, `bun run lint`, `bun run format`, and tests before pushing.
- PRs must explain the why, link relevant issues, and include screenshots for UI or dashboard changes.
- Mark migrations, config changes, and new worlds clearly in the description; flag breaking changes up top.

## Environment & Configuration Tips
- Copy `.env.example` (a short starter) to `.env`; every setting is documented in `config/environment.reference` (generated page: `docs/reference/environment.md`, regenerate with `bun run docs:api`). Key knobs include `MARINA_WORLD`, `MARINA_NAME`, and port variables.
- Run `bun run init` to seed starter data; never commit `.env` files or generated SQLite artifacts.
- See `SECURITY.md` for vulnerability disclosure; route secrets through environment variables, not checked-in files.
