# Marina desktop development

Marina uses **Electrobun 2.0.2**, with Hutch managing the native build and SDK.
The main process remains **Bun**: the same engine, SQLite persistence, dashboard,
participation contracts and coding commands run inside the native application.

## Develop and verify

Use the exact Bun version in the repository's `.bun-version` for packaging:

```bash
bun install --frozen-lockfile
cd marina-desktop
bun run sync
bun run typecheck
bun run test
bun run start
```

`sync` downloads the release-paired Hutch/Cottontail toolchain and projects the
SDK into `.hutch/devkit`. It generates `.hutch/tsconfig.sdk.json` from that SDK's
export map, without the `baseUrl` option removed in TypeScript 7. Generated SDK
files are ignored by Git; do not import the npm bootstrap as the runtime SDK.
Use `electrobun/main` for the native process and `electrobun/view` for the webview.
`hutch.config.ts` retains Bun as the workspace package manager.

The package scripts run the CLI bootstrap through Bun. They build the shared
`dashboard/src` application, prepare room modules and assets, then invoke Hutch.
There is no separately maintained desktop dashboard. The local RPC adapter
carries chat, onboarding, capabilities, context, canvas events and API requests.
The dashboard uses a reserved internal HTTP origin for SDK calls from `views://`;
the adapter handles those requests locally. External HTTP requests retain their
original destination.
Signed-in API calls retain the resident's identity, including private streams
and inventory. The native operator credential stays in the main process.

```bash
bun run build:dev       # native development bundle, no launch
bun run build:canary    # prerelease installer and update payloads
bun run build:stable    # stable-channel artifacts
```

From the repository root, `bash marina-desktop/scripts/build.sh canary` adds
workspace installation, backend/desktop type checks, lint and tests before
packaging. See `--help` for selective skips and generated-output cleanup.

## Runtime and resources

Electrobun 2.0.2 normally ships Bun 1.4.0; Marina requires the newer version in
`.bun-version`. The `postBuild` hook replaces the **app's copy** of Bun with the
build executable, checks its version/platform/architecture, then updates runtime
metadata before wrapping, signing or packaging. It never modifies the shared
Hutch toolchain cache. A `Resources/marina-runtime.json` receipt records both
versions and the executable hash **before signing**. OS signing can change those
bytes; release attestations cover the final distribution artifacts.

Use the package scripts, not a raw `electrobun build`, so the hook receives the
build executable. A missing or mismatched runtime fails the build. The v1 Bun
FFI patch is retired: v2 provides the native string conversion fixes and uses
core-owned numeric object IDs. Tests exercise callbacks through a compiled C
fixture, including cancelled file dialogs and tray events.

World definitions and inline rooms are bundled with the engine. External room
directories are compiled into `dist/rooms`, including their runtime imports.
LICENSE and NOTICE are included in the app. Fonts are cached for offline use;
a failed optional font download falls back to system fonts.

App identity remains `dev.marina.desktop`. Existing preferences and databases
remain in the same OS data directory. Linux also honors an absolute
`XDG_DATA_HOME`; its default remains `~/.local/share/marina`. Window replacement
creates the new window before closing the old one. Quit requests veto native
teardown until the engine drains pending work and closes persistence.

## Platforms and release validation

The release workflow builds **macOS Apple Silicon**, **Windows x64**, and
**Linux x64**. Electrobun v2 does not publish an Intel Mac toolchain; Intel Mac
users can use Marina's web dashboard and terminal. Upstream also distributes a
Linux arm64 toolchain, but Marina does not yet have that native release CI target.

Linux needs GTK 3, WebKitGTK 4.1, Ayatana AppIndicator and librsvg. For example:

```bash
# Ubuntu/Debian
sudo apt install libgtk-3-0 libwebkit2gtk-4.1-0 libayatana-appindicator3-1 librsvg2-2
# Arch/CachyOS
sudo pacman -S gtk3 webkit2gtk-4.1 libayatana-appindicator librsvg
```

A Linux native smoke test launches a disposable copy of the actual development
package with isolated XDG directories under `build/native-smoke-*`. A browser probe
is injected only into that copy. It logs in and sends `look` through the rendered
chat, checks RPC snapshots, private streams, inventory and separate network
participation, captures a screenshot when ImageMagick is installed, checks
shutdown and runs SQLite integrity verification:

```bash
bun run build:dev
xvfb-run -a -s '-screen 0 1440x1000x24' bun scripts/native-smoke.ts
```

Pass an extracted release's `bin/launcher` as the script's first argument to test
that package. Completion is observed through a normal in-world message from the
native chat to the network resident, without requiring release console logging.

It does not use an existing Marina database. Evidence paths are printed at the
end. The desktop CI job runs this alongside the SDK and participation tests.

Hutch puts native bundles in `build/` and distribution files in `artifacts/`.
Preserve **all** installer, archive, metadata and update-payload filenames. The
release workflow inventories build inputs, attests the final files, and attaches
the verification bundles. Tagged releases remain drafts.

macOS signing requires `ELECTROBUN_DEVELOPER_ID` and its certificate in the build
machine's keychain. Notarization also requires `APPLE_ID`, `APPLE_TEAM_ID`, and
`APPLE_PASSWORD`. Without these the local build is unsigned; a stable channel
name alone does not mean a signed or notarized release. Validate those steps on
the native target before publishing. Windows installer signing is not configured.

`release.baseUrl` remains unset and delta-patch generation is disabled: this
migration does not introduce a public update feed. Installing over an earlier
release, native dialogs, OS signing and updates still need target-OS acceptance
testing. Linux validation does not certify macOS or Windows.

See the [interface guide](../docs/guides/interfaces.md) and
[upstream v2 migration guide](https://framework.blackboard.sh/electrobun/guides/migrating-to-v2/).
