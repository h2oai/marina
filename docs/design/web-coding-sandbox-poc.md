# Web Coding — Simplest Sandbox PoC

Status: **historical PoC / superseded** · The direct-vfkit PoC is no longer the implementation
path. Flywheel now owns sandbox backends and Marina already ships its control-plane client. See the
canonical [Code Mode × Flywheel execution plan](./code-flywheel-execution-plan.md). This document is
retained for its useful success criteria and host/guest separation research.

## Framing (what this is really for)
The primary consumer is a **coding agent inside Marina** (the `code` command / coding tools), not an
external IDE client. And **most coding work does not need a sandbox at all** — reading, searching,
diffing, and running the trusted pinned commands (`typecheck`/`lint`/`test`) on the operator's own
repo is fine on the host. The sandbox is a capability an agent **reaches for when the work warrants
it** (untrusted/agent-generated code, arbitrary exec, installs, network, `run app`). So:

> **The sandbox is opt-in. `LocalWorkspaceRuntime` stays the default; nothing changes for the common
> case.** The PoC proves we *can* route a session into a microVM when we choose to.

## PoC goal (one sentence)
A coding agent's `code run`/`code verify` executes **inside a vfkit microVM** — golden Linux guest,
workspace mounted via virtio-fs, command + output streamed over a vsock guest agent — behind the
`WorkspaceRuntime` interface, **selectable per session**, with the local path unchanged as default.

## Minimal scope (only this)
1. **`WorkspaceRuntime` interface + `LocalWorkspaceRuntime`.** Extract today's `LocalWorkspace`
   behind the interface (Layer 1). **No behavior change** — pure refactor, regression-safe. Needed
   regardless; valuable on its own; everything else plugs in here.
2. **`SandboxWorkspaceRuntime` (macOS/vfkit only).** Same interface; `run()` goes to the VM. FS ops
   (`read`/`list`/`search`/`diff`/patch) stay **host-side over the share** (per the protocol's
   host/guest split) — so only **execution** crosses into the VM. This keeps the PoC tiny.
3. **One golden guest image, one arch.** Minimal Linux + `bun` + `git` + the guest agent. Built once.
4. **Minimal guest agent.** Dial host over vsock → handshake (protocol version) → receive **one**
   exec request → run it in the workspace mount → stream stdout/stderr + exit. Nothing else.
5. **Minimal protocol subset over vsock.** `Hello/Accept`, `StartProcess`, `Stdout`/`Stderr`,
   `Exited`. Simplest viable transport (framed JSON-lines is fine for the PoC; gRPC-vs-custom is a
   *later* decision — don't let it block the PoC).
6. **virtio-fs mount** of the session workspace dir (host → guest, rw).
7. **Opt-in selection.** A per-session flag / env (e.g. `MARINA_CODE_SANDBOX=vfkit`) routes `run()`
   to the sandbox; default unset → local path.

The PoC may run the **existing allowlisted commands** in the VM first (proves transport + mount +
exec). "Relax to arbitrary exec inside the guest" is the *very next* increment (just skip the
allowlist on the sandbox path) — not part of the first green light.

## Explicitly OUT of the PoC (deferred, all designed elsewhere)
crosvm / Linux / Windows hosts · the own-VZ helper (use the vfkit binary) · PTY/TUI · stdin ·
long-running services · port-forward · secrets / credential brokering · network egress policy
(start with NAT-default or no-network) · **crews / multi-actor / per-actor views / write-lock /
overlays** (solo only — the isolation model's "solo = canonical-direct, zero overhead") · snapshots ·
warm pool · admission control · host-restart re-adoption · file-watch/HMR · observation/screenshots ·
**civic gating** (use a plain opt-in flag for the PoC; bind to the `shell.exec`/`workspace.*` gates +
standing afterward).

## Single success criterion
From a coding agent's perspective, `code run test` (or `code verify`) on an opted-in session
**executes inside the vfkit microVM** against the virtio-fs-mounted workspace and streams back the
same `WorkspaceRunResult` (stdout/stderr/exit/duration) — **indistinguishable from the local runtime
except that it ran in a VM** — while default (non-opted-in) sessions still use the local path with
**zero change** (full existing test suite green).

## Environment reality (important)
**vfkit is macOS-only; this dev environment is Linux.** But the golden image + guest agent + vsock
protocol + virtio-fs are **host-uniform** (Decision #6) — only the VMM driver is host-specific. So:
- The **valuable, reusable core** (image, guest agent, protocol, `WorkspaceRuntime` wiring) can be
  developed and validated **here on Linux/KVM** (crosvm or even plain QEMU) without a Mac.
- The **vfkit driver** is then a thin host-specific addition validated **on a Mac**.
- Recommendation: build steps 1 and the host-uniform parts of 3–6 against whatever VMM is available
  on the dev box; add the vfkit driver (step 2's macOS specifics) on a Mac. Same guest contract, so
  no rework. *(If we want a single-machine PoC right now, it would be Linux/KVM, not vfkit — but the
  guest-side work is identical either way.)*

## Build order (smallest steps)
1. **Layer 1 refactor** — `WorkspaceRuntime` + `LocalWorkspaceRuntime`; route `code` through it;
   prove the full suite stays green (no behavior change). *Ship this first regardless.*
2. **Guest image + guest agent** — minimal Linux, agent dials vsock, runs one command, streams.
3. **Host driver (PoC)** — boot the VM, virtio-fs-mount the workspace, vsock-connect, implement
   `SandboxWorkspaceRuntime.run()`; FS ops delegate to the local/share path.
4. **Opt-in wiring** — the per-session flag; default off.
5. **Green light** — opted-in `code run test` runs in the VM and streams; default sessions unchanged.

## Why this is the right first slice
- Exercises **every proposed technique** end-to-end (microVM, golden image, virtio-fs, vsock guest
  agent, exec streaming) at the **minimum** size.
- Lands the **`WorkspaceRuntime` abstraction** that *everything* (sandbox, future crosvm, views,
  civic gating) depends on — and which is independently useful even if the VM work paused.
- Honors the core truth: **sandbox is opt-in; the common case needs none.** No regression risk to
  the 99% local path.
- Proves the **host-uniform guest contract** once, so adding crosvm (Linux/Windows) and the native
  VZ helper later is incremental, not architectural.
