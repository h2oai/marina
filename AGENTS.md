# Repository Guidelines

## Project Structure & Module Organization
- `src/` contains the Bun TypeScript backend; note submodules for `agent/`, `engine/`, `world/`, and network adapters under `net/`.
- `dashboard/` houses the Vite + Bun powered UI; treat it as a standalone workspace with its own `package.json`.
- `test/` holds backend specs; helper utilities live in `test/helpers.ts`.
- `worlds/`, `data/`, and `seeds/` ship canonical content and databases—never commit generated `marina.db*` files.
- `docs/`, `examples/`, and `scripts/` capture reference material, sample flows, and operational tooling.

## Build, Test, and Development Commands
- `bun install` installs workspace dependencies (Bun ≥ 1.1.0 required).
- `bun run dev` starts the simulation server on `:3300`; use `bun run dashboard:dev` for the web UI on `:5173`.
- `bun run build` produces a Bun-compatible bundle in `dist/`; `bun run dashboard:build` emits the production UI.
- `bun run test` exercises backend tests; add `cd dashboard && bun run test` for UI smoke coverage.
- `bun run bench` runs the benchmark harness; `bun run clean` resets local databases and scratch data.

## Coding Style & Naming Conventions
- Formatter and linter: [Biome](https://biomejs.dev). Run `bun run format` before commits; line width 100, indent 2 spaces.
- Stick to strict TypeScript; prefer branded ID types (`RoomId`, `EntityId`) at boundaries.
- File names stay lower-case with hyphens (`telnet-server.ts`); tests mirror sources (`engine-state.test.ts`).
- Import order is alphabetical by path, enforced by Biome’s `organizeImports`.

## Testing Guidelines
- Use Bun’s native test runner with `*.test.ts` files in `test/`; colocate fixtures under `test/fixtures/`.
- Keep assertions deterministic; stub time and randomness with helpers in `test/helpers.ts`.
- Maintain coverage for new branches and command handlers; add regression tests when fixing bugs.

## Commit & Pull Request Guidelines
- Follow Conventional Commits (`type(scope): short explanation`), matching existing history (`feat(webchat): …`).
- Squash work into logical commits; run `bun run typecheck`, `bun run lint`, `bun run format`, and tests before pushing.
- PRs must explain the why, link relevant issues, and include screenshots for UI or dashboard changes.
- Mark migrations, config changes, and new worlds clearly in the description; flag breaking changes up top.

## Environment & Configuration Tips
- Copy `.env.example` when available; key knobs include `MARINA_WORLD`, `MARINA_NAME`, and port variables.
- Run `bun run init` to seed starter data; never commit `.env` files or generated SQLite artifacts.
- See `SECURITY.md` for vulnerability disclosure; route secrets through environment variables, not checked-in files.
