# Releasing Marina

A maintainer checklist for cutting a Marina release, in order. It describes the tooling that
exists today; steps without tooling are listed under [Release steps without tooling](#release-steps-without-tooling).
[Release qualification](release-qualification.md) defines the test gate this checklist runs;
[Compatibility and upgrades](compatibility.md) defines what a release may change.

Everything here needs only a GitHub repository, its Actions runners and a local checkout. No
cloud account is part of the release path. Deploying a released revision anywhere is the
operator's choice; the repository's **Deploy to EC2** workflow is the maintainers' own optional
deployment, not a release step, and a fork never needs it.

## How a release is made

A release is one pull request titled `release: X.Y.Z` that bumps every version and finalizes
the changelog, followed by an annotated `vX.Y.Z` tag on the merged commit. Past releases
(`v0.5.0` to `v0.8.0`) followed this shape; the tag message is a one-line summary ending
"See CHANGELOG.md." Marina follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html);
while it is 0.x, a minor release may remove deprecated surfaces under the
[version policy](compatibility.md#public-contract-and-version-policy).

## 1. Pre-flight

1. **`main` is green.** The latest `main` commit must pass CI, Secret scan and Supply Chain,
   and the most recent Nightly run must pass its `qualify:release` job:

   ```bash
   gh run list --branch main --workflow CI --limit 1
   gh run list --branch main --workflow "Supply Chain" --limit 1
   gh run list --workflow Nightly --limit 1
   ```

2. **Run the deterministic release gate** on a clean checkout of the release commit:

   ```bash
   bun install --frozen-lockfile
   bun run qualify:release
   ```

   It needs the pinned Syft scanner ([supply-chain verification](supply-chain.md)) and Chromium
   for the browser suite. A missing prerequisite is a failure, not a skip. It covers the SBOM,
   `check:versions`, `schema:check`, `qualify:sdk`, typecheck, lint, backend and dashboard tests,
   the dashboard build, `qualify:server`, the browser suite, the site build and `bun audit`.

3. **Qualify the packaged artifacts** you intend to ship:

   ```bash
   docker build -t marina-release .
   bun run qualify:image marina-release   # CONTAINER_RUNTIME=podman also works
   bun run qualify:native                 # builds dist/marina and runs it outside the checkout
   ```

4. **Run the provider-backed qualifications that match the release's claims.** These spend
   money or need a live target, so they are not in `qualify:release`. Do not describe a skipped
   or unavailable gate as passed; keep reports outside the public checkout.

   | Script | Needs |
   | --- | --- |
   | `qualify:prompt` | A running instance serving `marina:answerer`; `--url`/`--key` or `MARINA_URL` and `MODEL_API_KEYS` |
   | `qualify:autonomy` / `qualify:evolution` | A running instance with live agents (URL argument or `MARINA_URL`) |
   | `qualify:agents:handoff --directory PATH` | `OPENAI_API_KEY`; a new directory outside the checkout |
   | `qualify:coding --directory PATH --budget-usd N` | `OPENAI_API_KEY`; see [live model command acceptance](release-qualification.md#live-model-command-acceptance) |
   | **Live model acceptance** workflow | Manual dispatch on `main`; the `live-model` environment, `OPENAI_API_KEY` and `LIVE_EVIDENCE_PUBLIC_KEY` |
   | `qualify:decisions --backend …` | Credentials for each backend compared (for example `OPENROUTER_API_KEY`) |
   | `qualify:investigations:live --model M --budget-usd N --live` | Model provider credentials plus `TAVILY_API_KEY` (default retriever) or `OPENROUTER_API_KEY` |
   | `qualify:memory:benchmark` with `--model`/`--judge` | A running instance; see [memory-delta benchmark](release-qualification.md#memory-delta-benchmark) |
   | `qualify:flywheel` | A live Flywheel target; see [Flywheel live qualification](../integrations/flywheel-live-qualification.md) |

   `qualify:sdk`, `qualify:server`, `qualify:native`, `qualify:participation:load` and
   `qualify:investigations` need no provider and already run in pull-request CI or
   `qualify:release`. The memory qualifications are described in the
   [scripts reference](scripts.md#evaluate-and-qualify); run the ones a memory claim depends on.

## 2. Bump the version

Work on a branch (for example `release/X.Y.Z`); never push to `main`. There is no version-bump
script. Change the version by hand in:

- every versioned `package.json` that `bun run check:versions` lists (the root, `dashboard`,
  `examples/coding-agent-demo`, `examples/usecase-ui`, the three `extensions/*`,
  `marina-desktop`, `site` and `src/sdk`);
- `extensions/marina-market/marina-plugin.json` (`version`);
- `src/routing/agent-adapters.ts` (the app-server `clientInfo` version).

Then refresh the workspace entries in `bun.lock` and check:

```bash
bun install
bun run check:versions
bun install --frozen-lockfile
git grep -n '"OLD.VERSION"' -- ':!CHANGELOG.md' ':!bun.lock'   # anything left is deliberate or a miss
```

Leave compatibility floors alone (for example marina-market's `minMarinaVersion` default) and
version fixtures in tests; name them in the release PR body.

## 3. Finalize the changelog

In `CHANGELOG.md`:

1. Rename `## [Unreleased]` to `## [X.Y.Z] — YYYY-MM-DD` and add a fresh empty
   `## [Unreleased]` above it.
2. Start the version with `### Upgrade notes`: behaviour a living world notices on upgrade,
   new migrations, changed defaults, deprecations with their replacement, and operator action
   required. Link the upgrade procedure in [Compatibility and upgrades](compatibility.md#verified-upgrade-and-rollback);
   a dedicated [upgrading guide](upgrading.md) is being added separately and becomes the link
   target once it exists.
3. Make sure every merged user-visible PR since the last tag has an entry
   (`git log --oneline vPREVIOUS..HEAD`), under Keep a Changelog headings (`Added`, `Changed`,
   `Fixed`, `Security`, `Performance`).
4. Update the compare links at the bottom: `[Unreleased]` compares `vX.Y.Z...HEAD` and a new
   `[X.Y.Z]` line compares `vPREVIOUS...vX.Y.Z`.

Before opening the release PR run `bun run format`, `bun run typecheck`,
`bun --no-env-file test test/docs-contract.test.ts` and `bun run test:fast`. Merge it only after
required checks pass on its latest revision.

## 4. Tag and publish the GitHub release

Tag the merged release commit on `main` with an annotated tag:

```bash
git fetch origin && git checkout --detach origin/main
git log -1 --oneline                      # must be the "release: X.Y.Z" commit
git tag -a vX.Y.Z -m "Marina X.Y.Z — <one-line summary>. See CHANGELOG.md."
git push origin vX.Y.Z
```

Extract the release notes from the changelog and create the release:

```bash
awk '/^## \[X.Y.Z\]/{f=1;next} /^## \[/{f=0} f' CHANGELOG.md > /tmp/marina-X.Y.Z-notes.md
gh release create vX.Y.Z --verify-tag --title "Marina X.Y.Z" \
  --notes-file /tmp/marina-X.Y.Z-notes.md
```

Earlier versions were published as tags only, without a GitHub release object.

## 5. Artifacts built by workflows

Pushing `vX.Y.Z` triggers **Supply Chain** (`supply-chain.yml`), which:

- generates the CycloneDX repository inventory (`bun run sbom`);
- builds the dashboard and memory bundle and packs `marina.tgz` (`bun pm pack`);
- signs SLSA build provenance and an SBOM statement bound to the package digest.

It uploads them as workflow artifacts (`marina-package-<sha>`, `marina-attestations-<sha>`,
retained 90 days); it does not attach them to the release. To ship them, download and attach:

```bash
gh run list --workflow "Supply Chain" --event push --limit 5    # find the tag's run id
gh run download RUN_ID --dir dist/release
gh release upload vX.Y.Z dist/release/marina-package-*/* dist/release/marina-attestations-*/*
```

Users verify them as described in [supply-chain verification](supply-chain.md#verify-a-downloaded-package).
No workflow builds, signs or publishes a container image, standalone executable or SDK
package for a server tag.

## 6. SDK

`@marina/agent-sdk` (`src/sdk/package.json`) is not published to a package registry and has no
publish workflow. `qualify:sdk` (part of `qualify:release`) builds it, packs it and imports the
packed archive from a clean Node consumer. To attach the SDK tarball to the release:

```bash
bun run build:sdk
mkdir -p dist/release
(cd src/sdk && npm pack --ignore-scripts --pack-destination ../../dist/release)
gh release upload vX.Y.Z dist/release/marina-agent-sdk-X.Y.Z.tgz
```

## 7. Desktop

**Desktop Release** (`desktop-release.yml`) runs on a `desktop-v*` tag or manual dispatch
(`canary` or `stable`). It builds macOS arm64, Windows x64 and Linux x64 with
`bun run build:<env>` in `marina-desktop`, inventories and attests every file, and, for a tag,
creates a **draft** GitHub release with all payloads. To build the desktop app for X.Y.Z:

```bash
git tag -a desktop-vX.Y.Z -m "Marina desktop X.Y.Z"
git push origin desktop-vX.Y.Z
```

macOS signing needs the `ELECTROBUN_DEVELOPER_ID` secret and certificate; notarization also needs
`APPLE_ID`, `APPLE_TEAM_ID` and `APPLE_PASSWORD`. Without them the build is unsigned. Windows
signing and an update feed are not configured. Check each installer on its target OS before
publishing the draft; see the [desktop README](../../marina-desktop/README.md).

## 8. Documentation site

**Deploy site** (`site-deploy.yml`) publishes the site to GitHub Pages on every push to `main`
that touches `site/`, `docs/guides/` or the generated API reference, so the release PR's merge
normally redeploys it. Redeploy by hand if needed and check the result:

```bash
gh workflow run site-deploy.yml
gh run list --workflow "Deploy site" --limit 1
```

## 9. Security fixes and advisories

Handle vulnerabilities through [coordinated disclosure](../../SECURITY.md):

1. Triage the report in its private GitHub security advisory.
2. Develop the fix in the advisory's temporary private fork, with its tests, so neither the fix
   nor the problem is public before release.
3. Merge the fix, cut a release containing it, and describe the operator action under
   `### Security` and `### Upgrade notes` in the changelog without exploit detail.
4. Publish the advisory at the same time as the release, naming the fixed version and crediting
   the reporter unless they asked otherwise.

A security fix may shorten a deprecation window only with an explicit upgrade advisory
([version policy](compatibility.md#public-contract-and-version-policy)).

## 10. After the release

- Confirm the tag, the GitHub release and its assets, the Supply Chain attestations and the site.
- `main` stays at the released version with an empty `## [Unreleased]`; there is no `-dev`
  version bump. The next release PR moves the version.
- Every user-visible PR adds a line under `[Unreleased]` (the PR template asks).

## Release steps without tooling

These release steps have no tooling today:

- **Public container image.** The `Dockerfile` is qualified (`qualify:image`, Trivy Image Scan)
  but no workflow builds, signs or publishes an image for a tag; users build it themselves.
- **SDK publishing.** `@marina/agent-sdk` and the `extensions/*` packages are not published to a
  registry; the tarball is attached by hand.
- **Standalone executable.** `bun run build:native` builds `dist/marina` and CI qualifies it on
  Linux, but no workflow builds, signs or attaches executables for other platforms.
- **Server release assets.** The signed `marina.tgz` and its attestations stay workflow artifacts
  until a maintainer attaches them; no workflow creates the server's GitHub release.
- **Version bump and notes.** No script bumps versions or extracts release notes.
- **Desktop.** Windows signing, a desktop update feed and target-OS install-over-upgrade
  acceptance are not configured; desktop tags (`desktop-v*`) are separate from server tags.
- **Upgrade fixtures per release.** Database upgrades are qualified from fixed fixtures, not from
  a snapshot of every released version.
