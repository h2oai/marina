# Marina desktop development

Install the root, dashboard and desktop dependencies with `bun install --frozen-lockfile`
in each directory. From `marina-desktop`, run `bun run typecheck` and
`bun run build:dashboard`; `bun run start` builds and launches the desktop app.
The complete packaging pipeline is `bash marina-desktop/scripts/build.sh` from
the repository root.

Electrobun is pinned to 1.18.1 to retain Intel Mac builds. Its native SDK requires
Bun type definitions 1.3.14; the desktop TypeScript configuration resolves those
types locally so backend dependency updates do not merge incompatible FFI declarations.
TypeScript and the dashboard build tooling can be updated independently.

Electrobun 2 uses a different toolchain and SDK layout and does not distribute an
Intel Mac toolchain. Review platform support before changing this pin; see the
[upstream migration guide](https://framework.blackboard.sh/electrobun/guides/migrating-to-v2/).
Native startup, signing, installers and updates require validation on each target OS.
