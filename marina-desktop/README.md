# Marina desktop development

Install all workspace dependencies once with `bun install --frozen-lockfile`
from the repository root. From `marina-desktop`, run `bun run typecheck` and
`bun run build:dashboard`; `bun run start` builds and launches the desktop app.
The complete packaging pipeline is `bash marina-desktop/scripts/build.sh` from
the repository root.

Use Bun 1.4.2 or newer for development. Desktop packages bundle the exact runtime
in the repository's `.bun-version`, through Electrobun's `build.bunVersion` option.

Electrobun is pinned to 1.18.1 to retain Intel Mac builds. Bun's persistent patch
in `patches/` updates its native SDK's pointer return types, decodes callback
strings and handles cancelled file dialogs with current Bun FFI. The patch is applied by `bun install` and
allows current Bun type definitions. Run `bun run test` to check these SDK
boundaries. These tests substitute the OS window library and invoke SDK callbacks
through a C fixture compiled by Bun; they do not launch a native UI.

Electrobun 2 uses a different toolchain and SDK layout and does not distribute an
Intel Mac toolchain. Review platform support before changing this pin; see the
[upstream migration guide](https://framework.blackboard.sh/electrobun/guides/migrating-to-v2/).
Native startup, signing, installers and updates require validation on each target OS.

The desktop bundle builds the same `dashboard/src` application as the web server.
Its local chat bridge uses the shared WebSocket participation handler for login,
onboarding, capability discovery, context previews, and correlated coding commands.
App release metadata reads the desktop package version; it is not a second manual version.
See the [interface guide](../docs/guides/interfaces.md) for the desktop, dashboard,
and terminal capabilities and their validation boundaries.
