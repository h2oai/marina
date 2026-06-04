# Examples

Standalone artifacts that show what's possible to build _on top of_ Marina, rather than _inside_ it. None of them are required to run the server — they're reference implementations of common integrations.

## What's here

- **`usecase-ui/`** — React surface that calls Marina over HTTP. Three example screens (Search, Deep Research, Predict) all backed by `usecase` recipes inside the world. Demonstrates the "renderer + launcher" pattern: the UI is intentionally thin and behavior lives in Marina commands. See its README for run instructions.

## Related places to look

These aren't under `examples/` but solve adjacent problems:

- **`scripts/`** — short, runnable CLI helpers: `acp.ts` (Agent Client Protocol bridge for Zed / VS Code), `connect.ts` (the `marina` CLI binary — REPL, one-shot, pipe modes), `init.ts` (project bootstrap), `generate-grid-rooms.ts` (programmatic room creation).
- **`skills/`** — Markdown-with-frontmatter skill packages, Claude-Code-compatible (`marina-claude`). Loaded into worlds via `seedSkills(db, dir)` so agents `skill search` and `skill import` them.
- **`worlds/`** — Each world definition is itself a worked example of how to compose rooms, projects, traits, roles, and orchestration patterns. Useful templates: `default.ts` (broad launchpad), `markets.ts` (prediction-market world), `craft.ts` (spec-driven dev), `personal.ts` (single-agent self-improvement).

## Adding a new example

Put it in its own subdirectory with a `README.md`. The convention is: an example explains what it shows, how to run it, and which Marina primitives it touches. Keep the example minimal — depth lives in the docs, not the example.
