# Contributing to Marina

Thanks for thinking about contributing. This guide is the fastest path from "fresh clone" to "shipped PR." It is deliberately short — depth lives in [CLAUDE.md](CLAUDE.md) and [docs/](docs/).

## Before you start

1. Read [README.md](README.md) end-to-end. It is the source of truth for what Marina is and is not.
2. Skim [CLAUDE.md](CLAUDE.md) for architectural rules and conventions — most "why is the code shaped this way" questions are answered there.
3. Search [issues](../../issues) and [PRs](../../pulls) for prior art before opening a new one.

## Development setup

You need [Bun](https://bun.sh) ≥ 1.1.0 (`engines.bun` in `package.json`).

```bash
bun install
bun run start          # launches the server on :3300
```

In a second terminal:

```bash
bun run dashboard:dev  # vite at :5173
```

## Verification — run these before every PR

```bash
bun run typecheck      # tsc --noEmit
bun run lint           # biome check
bun run format         # biome format --write (run before committing)
bun run test           # full backend test suite
cd dashboard && bun run test   # frontend smoke tests
```

CI runs the same commands. All four must pass.

## Code style

- Formatter: **Biome** — line width 100, indent 2 spaces. `bun run format` fixes most issues automatically.
- Imports: alphabetical by path (Biome's `organizeImports`).
- TypeScript: strict mode. Prefer narrow types over `any`. Branded ID types (`EntityId`, `RoomId`) — cast at boundaries: `"e_1" as EntityId`.
- Error handling: use `getErrorMessage()` for extraction; wrap non-critical DB operations in `tryLog()` / `tryLogAsync()`.

## Architecture rules

These are easier to get right than to undo later. The full list is in [CLAUDE.md](CLAUDE.md) under "Architecture Rules"; the highlights:

- **Migrations are append-only.** Never modify an existing migration once it has been released. Add a new entry to the `migrations` array in `src/persistence/database.ts`.
- **One file per command** in `src/engine/commands/`. Register it in `src/engine/command-registry.ts`.
- **MCP tools** go through `runCmd()` in `src/net/mcp-server.ts` — that wrapper enforces rate limits.
- **Use `minRank` / `gate` on `CommandDef`** for permission gates. Don't add custom rank checks in handlers.
- **Tick budget**: room `onTick` handlers must complete within 200 ms total. Async work is fine as long as it throttles.

### Coding-agent instructions

This repo is agent-friendly by design: [CLAUDE.md](CLAUDE.md) holds the full conventions and
[AGENTS.md](AGENTS.md) is the cross-tool quick reference (read natively by Codex, Cursor, Zed,
Gemini CLI, and others). If your change alters build commands, architecture rules, or key file
locations, update both files in the same PR so agents don't work from stale instructions.

## Pull request process

1. Branch from `main`. Keep PRs scoped — one concern per PR.
2. Add or update tests in `test/`. Helpers live in `test/helpers.ts`.
3. If you touched docs, run a sanity pass on broken links and code blocks.
4. Open the PR with a description that explains *why*, not just *what*. The diff already shows the what.
5. CI is required green. Reviewers may ask for changes; treat the request as the work, not a critique.

## Reporting bugs

Open an issue with:

- What you ran (exact command).
- What you expected.
- What happened (full output, ideally with `LOG_LEVEL=debug`).
- Environment: Bun version, OS, world (`MARINA_WORLD`), upstream model provider if any.

## Security

For anything that looks like a vulnerability — **do not open a public issue**. See [SECURITY.md](SECURITY.md) for the disclosure process.

## License

By contributing, you agree your contribution is licensed under the project's [Apache License 2.0](LICENSE), per Section 5 of that license.
