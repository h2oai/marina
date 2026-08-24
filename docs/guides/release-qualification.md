# Release qualification

Run the deterministic public-release gate from the repository root:

```bash
bun run qualify:release
```

It must complete TypeScript checking, Biome, all backend tests, all dashboard unit tests, the
production dashboard build, the production-browser Canvas/dashboard suite, the public documentation
site build, and the Bun dependency audit. A missing browser is a failed prerequisite, not a skipped
success; set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` when the environment supplies Chromium outside
Playwright.

Provider-backed prompt, autonomy, evolution, and Flywheel qualifications remain separate because
they require credentials or a live target. Run only the gates that match the claim being released:

```bash
bun run qualify:prompt
bun run qualify:autonomy
bun run qualify:evolution
bun run qualify:flywheel
```

Do not describe an unavailable or skipped live gate as passed. Preserve its output, relevant trace
IDs, artifacts, environment prerequisites (never secret values), source commit, and evidence
checkpoint with the release record. World Collective comparisons should cite the exact baseline and
candidate variant IDs and retain the promotion rationale and evidence references.
