# Web Coding — Sandbox Scoping: vfkit + crosvm microVMs via Flywheel

Status: **scoping / investigation** (no code) · Relates to: [web-coding-cli.md](./web-coding-cli.md)
Phase 5 "sandbox/container backend" and the deferred Flywheel evaluation.

## Goal & constraints
Run coding workspaces inside a real isolation boundary (boot a Linux guest, mount the
workspace, run untrusted agent-driven code, stream results back) on **macOS, Linux, and
Windows desktops** (all first-class — see Decisions), while keeping Marina **completely
standalone** — no cloud sandbox service, no mandatory external dependency at runtime. The
VM ships **bundled** so a freshly obtained Marina runs sandboxed workspaces immediately, with
no user setup.

## The two candidates — and why they're a *pair*, not a choice
The key finding: **the candidates are complementary by host OS, not redundant.** Neither
covers both desktops alone; together they (plus Linux) cover everything.

| | **vfkit** (crc-org) | **crosvm** (google) |
|---|---|---|
| Host OS | **macOS only** | **Linux + Windows** (not macOS) |
| Hypervisor | Apple `Virtualization.framework` | Linux: KVM · Windows: **WHPX** / HAXM |
| Language | Go (CLI **and** `pkg/config` Go API) | Rust |
| License | **Apache-2.0** | **BSD-3-Clause** |
| FS share | **virtio-fs** (`--device virtio-fs,sharedDir=…,mountTag=…`) | virtio-fs **and** virtio-9p |
| Host↔guest control | **RESTful API** (`--restful-uri`) + **vsock** (`virtio-vsock`) | control socket; vsock |
| Networking | NAT, unix-socket (gvproxy), fd | virtio-net (vhost / slirp) |
| Guests | Linux (EFI/direct kernel), macOS | Linux (ARCVM/Crostini heritage), others |
| Extras | Rosetta x86→arm64 on Apple Silicon | broad device model |
| Min host | macOS 13+ for Linux EFI guests | Win 11 24H2 + "Windows Hypervisor Platform" feature enabled |

Both permissive-licensed (Apache-2.0 / BSD-3) → safe to bundle/redistribute in a standalone
product. **Coverage map: vfkit → macOS · crosvm → Windows + Linux.** That is the whole
rationale for adopting both.

## Where this slots in — two layers of work

### Layer 1 — Marina has NO execution abstraction yet (must build first)
Today all workspace command execution is hardcoded: `LocalWorkspace.run()` →
`runWorkspaceCommand()` → `Bun.spawn()` on the **host process**, fenced only by a strict
allowlist (bun: build/lint/test/typecheck + `bun test <path>`; a git subset), path
confinement (`realpathSync`, no `..`), shell-metachar blocking, timeout, and 64KB output cap
(`src/coding/local-workspace.ts`). The master plan already *names* the intended abstraction —
**`WorkspaceRuntime`** (the multi-provider interface) and **`WorkspaceGateway`** (the policy
layer between `CodingSessionManager` and the runtime) — but **neither is implemented**; a
sandbox backend has nothing to plug into yet. (This doc adopts those existing names; it does
NOT introduce a new `WorkspaceRuntime` term — see *Alignment with the coding plan*.)

**Prerequisite:** extract the `WorkspaceRuntime` interface from `LocalWorkspace`
(read/run/search/diff/checkPatch/applyPatch/reversePatch/getPolicy/cleanup), ship
`LocalWorkspaceRuntime` (today's behavior, default), and stand up the `WorkspaceGateway` policy
seam; then add a `SandboxWorkspaceRuntime` that delegates to Flywheel. This is the unblocking
step and is valuable on its own.

### Layer 2 — Flywheel as the microVM execution substrate
Flywheel (Go, ConnectRPC) already has the right shape: `SandboxService` (factory) → `Sandbox`
(Start/Stop + process exec + event subscription) → `SandboxedProcess` (exec + stream), in
`services/types.go`. It is **transport-agnostic** — proven by three existing backends:
`docker` (socket), `e2b` (remote HTTP + SSH bridge), `local_sandbox` (os/exec). A microVM
backend is the natural fourth family. Marina talks to Flywheel over ConnectRPC; the
`SandboxWorkspaceRuntime` from Layer 1 is the client.

> **NOTE:** Layer 2 (and the "Can Flywheel be improved?" section below) describe the path
> *if we keep Flywheel*. That premise is now challenged — see **"Reconsideration: do we even
> need Flywheel?"** immediately below.

## Reconsideration: do we even need Flywheel? (near-term: probably not)
Raised in review: if vfkit/crosvm give a **complete VM sandbox**, what does Flywheel add?
Re-examined against the locked decisions, most of Flywheel's value is **redundant for the
near-term Topology A**:

| Flywheel provides | Near-term status |
|---|---|
| Multi-backend abstraction (docker/e2b/local + microVM) | Redundant — Marina's own `WorkspaceRuntime` is that seam; microVM is the only backend we want, `LocalWorkspaceRuntime` already covers local |
| Event model + execution persistence | Redundant — Marina already has `coding_events`/artifacts/feed |
| Multi-tenant orchestration | Redundant near-term — Marina sits above and owns per-participant workspaces (Decision #5) |
| VM lifecycle (boot/stop/pool) | Needed, but VMM-specific and small; lives equally well in a TS `SandboxWorkspaceRuntime` |
| **Guest agent + vsock I/O bridge** | **NOT provided by Flywheel** — net-new either way (we flagged it as a Flywheel *gap*) |

Plus the cost of keeping it: a **Go process + ConnectRPC IPC + a second bundled binary + a
co-designed protocol**, when Marina is TS/Bun. vfkit exposes a Go `pkg/config` API *and* a REST
control API; crosvm has a control socket — Marina can drive both directly. Flywheel never saved
us the expensive part (the guest agent + vsock bridge is ours regardless).

**Conclusion (near-term): drop Flywheel from the Topology-A path.** Marina drives vfkit/crosvm
directly behind its own `WorkspaceRuntime` + `WorkspaceGateway`, with a guest agent Marina owns.
This removes a whole language boundary and two duplicate layers (events, tenancy). The
"Layer 2 / Can Flywheel be improved?" sections below are retained as the *fallback design* if
that conclusion is reversed.

**Where Flywheel could still earn a place (revisit later, do not build now):**
- **The fleet layer (Topology B):** orchestrating many *Marina-world* VMs is a genuinely
  different, higher job than per-workspace sandboxing — Flywheel's multi-tenant orchestration
  does something Marina doesn't. This is its strongest future case.
- **Non-VM backends** (cloud e2b / docker) — but that contradicts the standalone-microVM decision.
- **Cross-product reuse** — other H2O products wanting one execution substrate (org concern).
- Keep Flywheel as a **design reference** for execution/event/lifecycle patterns regardless.

This **supersedes Decision #4** for the near term: Marina owns the microVM runtime directly;
Flywheel is reconsidered only at the fleet layer.

## Can Flywheel be improved to facilitate this? Yes — concretely
Flywheel's interfaces are extensible, but three real gaps must be closed for microVMs:

1. **First-class filesystem-mount abstraction.** Each backend handles FS ad hoc today; there
   is no `Mount`/shared-dir concept on the `Sandbox` interface. virtio-fs workspace mounting
   needs to be a declared capability: add a mount spec to sandbox creation
   (`{ hostPath, guestPath, mountTag, readOnly }`) so vfkit (`virtio-fs,sharedDir`) and crosvm
   (`--shared-dir`) implement it uniformly. **This is the single most important Flywheel change**
   and it benefits docker/local too.
2. **Process I/O over a guest transport.** `SandboxedProcess` streams via `io.Reader`; for a
   VM that stream must originate *inside the guest*. Needs a small **guest agent** + a bridge
   over **vsock** (both VMMs support it) or SSH, mapping guest stdout/stderr/exit back onto
   Flywheel's existing event channel (`Data_Stdout`/`Data_Stderr`/`Stop`). The event model
   itself needs **no change** — it's already generic.
3. **Runtime backend selection.** Backend choice is compile-time in `main.go`
   (`NewSandboxService`). Add a config/env switch (`docker | local | vfkit | crosvm`) and
   per-backend config structs.

New backend dirs would mirror the existing pattern:
`services/sandbox/microvm_vfkit/{service,sandbox,process}.go` and `…/microvm_crosvm/…`.

## macOS backend: how "native" to go (decided 2026-06-20)
Clarification first: **vfkit is already native** — it's a thin Go wrapper over Apple's
`Virtualization.framework` (via Go bindings), not a third-party hypervisor. So "vfkit vs
native" is a false choice; the real question is *which level of the native stack* we sit on.
Three options, increasing nativeness:

| Option | What it is | Pros | Cons |
|---|---|---|---|
| **vfkit** (binary) | Maintained Go CLI/REST over Virtualization.framework (Red Hat / podman-machine) | Lowest friction; already done & battle-tested; Intel + Apple Silicon; macOS 13+; **raw-VM → our golden image + our guest agent run as-is** | External binary to bundle/sign/version-pin |
| **Own VZ helper** | A small **Marina-owned** host binary linking `Virtualization.framework` directly (Swift, or Go via the same vz bindings vfkit uses) | **Completely native**, no external dependency; we own the exact vsock + virtio-fs + guest-agent wiring (which we're building anyway); one signed helper to notarize; Intel + Apple Silicon | We own VM-host code + Apple-API upkeep; net-new (a "minimal vfkit") |
| **Apple Containerization / `container`** | Apple's WWDC'25 framework, **v1.0 Jun 2026**; OCI containers each in a sub-second microVM via `vminitd` | Apple-maintained, highest-level, fastest boot | **Apple Silicon only + macOS 26 for full features** (excludes Intel / older macOS); **OCI + Apple's `vminitd` init forks our uniform guest contract** |

**The hidden conflict:** Apple Containerization is attractive but it is **container/OCI-shaped
and uses Apple's own `vminitd`** — adopting it would mean macOS runs a *different guest model*
than crosvm-on-Linux/Windows, **breaking the locked "one golden image + one guest agent,
authored once, identical on every host" decision.** That uniformity (reproducible execution
everywhere) is worth more than the marginal nativeness Containerization adds over a raw VZ VM.

**Decision (locked 2026-06-20):** keep the macOS leg **raw-VM** to preserve the uniform guest
contract, and get "completely native" via a **Marina-owned `Virtualization.framework` helper**
as the productionized end-state — with **vfkit as the fast PoC starting point** (same framework
underneath, so we can swap vfkit → our own helper later *without changing the guest contract or
image*). **Apple Containerization is set aside as the baseline** (HW/OS gating + guest-model
fork) but noted as a possible Mac-only optimized fast-path far later.

Scope note: this only changes the **macOS host driver**; the cross-platform shape is unchanged
(Linux/Windows stay on crosvm; the golden image + guest agent stay uniform). The host driver was
always going to differ per OS — only the guest stays the same.

## Alignment with the coding plan
This doc must sit consistently inside the existing plan
([web-coding-cli.md](./web-coding-cli.md) §Implementation Plan, plus phase2 / phase3-4 /
phase4-autonomy and the compatibility audit). How it reconciles:

- **Phase fit — this is Phase 6.** The master plan ends at **Phase 5: External Compatibility**
  (ACP/MCP) and only carries a thin "evaluate Flywheel as the executor backend" bullet, plus a
  "Sandbox/container — *Planned*" row in the compatibility audit. This work *realizes* that:
  treat it as **Phase 6 — Sandboxed Execution Substrate**, which supersedes that bullet/row.
  It depends on Phase-6-Layer-1 (the `WorkspaceRuntime` extraction), not on Phase 5.
- **Naming is reconciled, not forked.** The interface names come from the master plan, which
  already coined **`WorkspaceRuntime`** (multi-provider interface; web-coding-cli.md:205,433)
  and **`WorkspaceGateway`** (policy seam between `CodingSessionManager` and the runtime;
  :335,442). Providers: `LocalWorkspaceRuntime` (default, today's `Bun.spawn`),
  `SandboxWorkspaceRuntime` (Flywheel-backed microVM). This doc uses those; it introduces **no**
  new `WorkspaceExecutor`/`WorkspaceDriver` vocabulary.
- **It answers several of the master plan's open questions** (web-coding-cli.md:690–717):
  *userland-filesystem durability* → bundled microVM image + virtio-fs; *dependency installs* →
  safe **inside the guest** (policy relaxes, see below); *long-running processes* → owned by the
  workspace VM, keyed to the Marina session; *secrets* → bound per-session into the VM;
  *remote repos* → cloned inside the VM. **Still open:** worktree policy and the snapshot/update
  story (deferred to the plan, not resolved here).
- **It does NOT replace the Phase 4 write-lock — different scope.** Phase 4's role-based
  single-writer lock governs **one shared session workspace** where a *crew of agents
  collaborates* (one writer at a time). Per-participant sandbox VMs isolate **different
  participants** from each other. These are orthogonal and both stay: a crew sharing a session
  still uses the write-lock *inside* that one workspace VM; separate participants each get their
  own VM. The sandbox decides *who shares a workspace*; the write-lock decides *who may write to
  a shared one*.
- **Security model shifts deliberately (aligns with the deferred `code run app`).** Phase 1's
  strict allowlist (bun/git only) exists *because* execution is on the host. Inside the sandbox,
  `WorkspaceGateway` policy relaxes to **open-within-guest**, finally unlocking the
  compatibility audit's "code run app — *Planned*" and arbitrary build/test/install. The
  remaining in-guest boundary becomes **network egress** (the existing `url-guard`/SSRF posture
  carries into the guest).
- **Touches the parked confidentiality item.** Per-participant workspace isolation advances the
  read-API confidentiality concern (each participant's workspace is physically separated),
  though the read-API question itself stays parked per the operator's earlier call.

> Cross-references back into the committed plan docs (a Phase 6 entry in web-coding-cli.md, and
> pointers from the compatibility audit) should be added **once this doc settles** — it is
> deliberately uncommitted and still under active thinking.

## The net-new hard parts (true regardless of which VMM)
The rosy "just add a backend" view understates these:

- **A guest agent + golden Linux image.** Booting a VM is step one; you need a tiny init that
  mounts the virtio-fs workspace, accepts commands over vsock, runs them, and streams I/O.
  That agent + a minimal, reproducible guest image (kernel + rootfs) is net-new and must be
  **built and shipped per guest-arch** (x86_64, arm64). Image distribution bloats the product.
- **vsock plumbing** on both VMMs and a stable guest↔host protocol.
- **Windows/crosvm maturity & distribution.** crosvm's Windows host path (WHPX) is real but
  far less battle-tested than its Linux/KVM path; it requires Win 11 with the Hypervisor
  Platform feature enabled (and clashes with some VirtualBox/anti-cheat setups), and producing
  a redistributable Windows crosvm build is non-trivial (Rust + Windows toolchain). **This is
  the riskiest leg of the "both desktops" goal** — budget spike time here.
- **Resource cost & UX.** microVMs cost RAM/CPU/disk and add boot latency; need pooling/warm
  VMs and clear "starting sandbox…" UX.

## Standalone reality check
- **macOS (vfkit):** genuinely standalone — Virtualization.framework ships with the OS; bundle
  the vfkit binary + guest image. Clean.
- **Linux (crosvm/KVM):** standalone where KVM is available; this is also where Flywheel's
  existing docker/local backends already run.
- **Windows (crosvm/WHPX):** the **preferred** Windows path (keeps the same crosvm backend +
  golden image as Linux). Standalone in the "no cloud" sense, with real preconditions (Win 11,
  virtualization on, WHP feature). **WSL2 is an accepted fallback but not the recommended
  default** — only the escape hatch if crosvm/WHPX proves fragile on a given machine.

## Decisions (locked 2026-06-20)
1. **Linux is first-class**, alongside macOS and Windows. → crosvm/KVM is a *primary* target,
   not incidental; three first-class hosts: macOS (vfkit), Linux (crosvm/KVM), Windows
   (crosvm/WHPX).
2. **Bundle the VM** (golden guest image + VMM binaries) so Marina runs sandboxed workspaces
   immediately on obtain — zero user setup. Distribution-size cost accepted.
3. **WSL2 = accepted fallback, not recommended.** crosvm/WHPX is the default Windows path;
   WSL2 is only the escape hatch.
4. **We own Flywheel — go deeper, not sidecar-shallow.** The microVM backends, the FS-mount
   abstraction, the guest agent, and the vsock bridge land as **first-class Flywheel features**.
   Marina becomes Flywheel's first deep consumer, and Flywheel becomes the canonical
   standalone execution substrate. Interfaces on both sides are co-designed to fit (no
   impedance-matching wrapper).
   **[SUPERSEDED for near-term — see "Reconsideration: do we even need Flywheel?". With complete
   microVM sandboxing + Marina-above, the near-term path drops Flywheel and has Marina drive the
   VMMs directly; Flywheel is revisited only at the fleet layer (Topology B).]**
5. **Marina sits above (near-term).** A given Marina is the orchestrator that creates and
   governs **one workspace per participant** in its world (Topology A). The Flywheel-over-Marina
   world fleet (Topology B) is deferred to a later scale/multi-tenant layer. Rationale + the
   invariant that keeps both coherent are in "Near-term decision" below.
6. **One golden guest image; macOS goes raw-VM + native VZ.** Keep a single golden guest
   (kernel + rootfs + guest agent) authored once and run identically on every host — uniformity
   over marginal nativeness. macOS uses **vfkit for the PoC**, swapping to a **Marina-owned
   `Virtualization.framework` helper** for production *without changing the guest image/contract*;
   Linux/Windows use crosvm. **Apple Containerization is rejected as baseline** (Apple-Silicon /
   macOS-26 gating + its OCI/`vminitd` guest model would fork the uniform contract). Details in
   "macOS backend: how 'native' to go".
7. **No Flywheel in the near-term path.** Marina drives the VMMs directly behind its own
   `WorkspaceRuntime`/`WorkspaceGateway`; Flywheel is reconsidered only at the fleet layer
   (supersedes Decision #4). See "Reconsideration: do we even need Flywheel?".

## Design consequences of the decisions
- **One golden guest image, every host.** Because Linux is first-class and the VM is bundled,
  the guest (kernel + rootfs + guest agent) is authored **once** and boots identically under
  vfkit (macOS) and crosvm (Linux + Windows). Host-specific code shrinks to *VM launch &
  lifecycle*; everything inside the guest — virtio-fs mount, command exec, vsock streaming — is
  uniform. **Reproducible execution environment across all desktops** is a first-order benefit,
  not a side effect. Build the image per guest-arch (x86_64, arm64) only.
- **Deeper Flywheel integration model.** Marina is TS/Bun, Flywheel is Go, so a process
  boundary remains — but since we control both, the contract is **purpose-built**: Marina's
  Layer-1 `WorkspaceRuntime` is shaped to map 1:1 onto Flywheel's `Sandbox`/`SandboxedProcess`
  contract (no translation layer), and Flywheel ships as a **bundled, versioned component of
  the Marina distribution** (lifecycle-managed by Marina), not an external service. The mount
  abstraction and microVM family become core Flywheel, upstreamed and reusable.
- **Versioning/update story.** Guest image + guest agent + Flywheel + VMM binaries are versioned
  *with* Marina releases (the guest-agent↔host protocol is the compatibility contract). Needs a
  defined update/migration path (covered in the plan, not here).
- **Bundling pipeline is a real workstream.** Reproducible image build, signing/notarization
  (macOS), and packaging the right VMM per OS into the desktop artifact.

## Architectural inversion under review: Flywheel-over-Marina (world fleet)
The sections above assume **Topology A** (Marina on the host, Flywheel as a bundled
workspace-execution substrate underneath). An alternative — **Topology B** — flips it:
Flywheel is the top-level orchestrator and **each Marina world runs inside its own VM** that
Flywheel boots, so Flywheel can spawn *many* isolated Marina worlds. This had **not** been
considered before; it is captured here as an option under active review (not locked).

These are **two different isolation axes that compose**, not competitors:
- **A** isolates untrusted *coding-workspace execution* from the Marina engine.
- **B** isolates *whole Marina worlds* from each other and the host (multi-tenant fleet).

### The trap, and the rule: siblings, not nesting
If a Marina world runs in a VM **and** boots workspace microVMs *inside itself*, that is
**nested virtualization** — slow, and frequently unavailable (Windows/WHPX, some Apple Silicon
configs, cloud). **Rule: make Flywheel a flat fleet orchestrator.** Marina-world VMs and
workspace VMs are **siblings** under one Flywheel. A world that needs a sandbox calls back out
to Flywheel (over a host channel / vsock) to request a *sibling* workspace VM; Flywheel boots
it and bridges the shared workspace. No VM-in-VM.

```
            ┌──────────────────────── Flywheel (host control plane) ───────────────────────┐
            │                                                                               │
            │   [Marina world VM #1]      [Marina world VM #2]      [workspace sandbox VM]   │
            │     engine+agents+DB          engine+agents+DB          (sibling, requested    │
            │          │  └── requests sandbox ──────────────────────►  by world #1)         │
            │          └── federates (gateway protocol) ──┘                                  │
            └───────────────────────────────────────────────────────────────────────────────┘
```

### Why B is attractive
- **Fits Flywheel's actual purpose** — it is already a *multi-tenant* execution orchestrator;
  "a long-lived sandbox that happens to run a Marina" is squarely in its model (Start/Stop +
  persistent sandbox; e2b already proves long-lived remote tenants).
- **Hard isolation between worlds** — a runaway/compromised world is contained; clean
  per-world resource limits, pause, snapshot, restore.
- **Reuses Marina's existing multi-world + federation concepts** — Marina already has world
  definitions (`MARINA_WORLD`) and peer **federation** (`gateway-runtime.ts`, `GATEWAY_SECRET`).
  Topology B is the natural physical substrate for those: VM-isolated world instances that
  **federate via the existing gateway protocol**. Fleet orchestration (Flywheel) + world mesh
  (gateway) are complementary layers.
- **One golden image idea extends** — now there's *two* image kinds: a *world* image (Marina +
  guest agent) and a *workspace* image (toolchains + guest agent). Both built once per arch.

### Costs / what it would require
- **Flywheel needs a "service-sandbox" mode.** Today its sandboxes exist to *exec commands*;
  running Marina as the payload means "boot this image as a long-lived service and expose its
  ports." That + **port routing/reverse-proxy** to reach each world's dashboard/API is net-new
  Flywheel work, on top of the fleet control plane (spawn/list/pause/snapshot worlds).
- **Heavier resource profile.** A full world VM (engine+DB+agents+dashboard) is much larger
  than a workspace sandbox; "multiple Marina worlds" = multiple heavy, often always-on VMs.
  Great on a server, heavy on a laptop.
- **Bootstrapping/UX shift.** The user now launches a *control plane* that launches worlds,
  not a single Marina app. The bundled-"runs immediately" promise still holds but the bundle
  is bigger (Flywheel + world image + workspace image + VMM).
- **World state lifecycle.** Each world's DB lives on a mounted volume / disk image; Flywheel
  must own world snapshot/restore/migrate.

### Deployment-mode split (the resolution)
- **Solo desktop:** Topology A (host Marina + sibling workspace sandboxes) is lighter and is
  likely the default. Optionally a *single* world-VM if the user wants Marina itself sandboxed.
- **Fleet / server / multi-tenant:** Topology B shines — Flywheel orchestrates many
  VM-isolated, federating Marina worlds plus their sibling workspace sandboxes.
The same Flywheel + same images serve both; the difference is how many world-VMs run and
whether Marina sits on the host or in a VM. **Recommendation: design the Flywheel control
plane and the world/workspace images so A and B are the same substrate at different scale —
don't fork them.**

### Near-term decision (locked 2026-06-20): Marina sits above
A given Marina **sits above** as the orchestrator and **creates one workspace per participant**
in its world (each agent/user gets their own sandboxed workspace). Rationale: Marina owns the
participant model — identity, standing, the civic substrate, who-may-do-what — so it is the
natural authority to **provision and govern** per-participant workspaces. A Marina demoted to a
mere guest could not do this for its own citizens without awkwardly calling back out.

Concretely (Topology A, sibling model): host Marina → asks Flywheel → **one workspace VM per
participant** (or per coding session), shared-dir mounted, vsock-bridged. Workspace lifecycle
is owned by Marina and keyed to participant/session, tied into the existing **safety-gate +
standing** model (who may spawn a workspace, what it may do, when it is reclaimed).

**Invariant across A and B:** *a Marina always sits above its own participants' workspaces.*
Topology B (the Flywheel world-fleet) only adds an **outer** layer that stacks many such
Marinas as VM-isolated, federating tenants — it never changes this inner relationship.
Therefore the near-term build is Topology A, and the fleet is a later **outer wrapper, not a
redesign**. This is why Topology A "remains the best near-term architecture."

## Recommended path
1. **Build Layer 1 first** (`WorkspaceRuntime` + `LocalWorkspaceRuntime`) — unblocks
   everything, ships value immediately, no VM dependency. Default stays local. Shape its
   contract to Flywheel's `Sandbox`/`SandboxedProcess` so the sandbox executor drops in cleanly.
2. **Author the golden guest image + guest agent once**, and PoC end-to-end on **macOS/vfkit**
   (lowest-friction host): boot the guest, virtio-fs-mount a workspace, run `bun test` inside,
   stream results to Marina over vsock. This proves the *uniform guest contract*.
3. **Land the Flywheel changes as first-class features**: the FS-mount abstraction, the vsock
   I/O bridge, runtime backend selection, and the **vfkit** backend; wire
   `SandboxWorkspaceRuntime` against the co-designed contract.
4. **crosvm on Linux/KVM** — now a primary deliverable (same golden image): validates the crosvm
   backend cheaply and gives first-class Linux isolation.
5. **crosvm on Windows/WHPX** — same backend + image; spike maturity early. Ship WSL2 as the
   documented, non-default fallback.
6. **Bundling & distribution** — packaging pipeline for image + VMM + Flywheel per OS; first-run
   "works immediately"; versioned update path.
