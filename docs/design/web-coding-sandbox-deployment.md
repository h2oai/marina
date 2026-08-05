# Web Coding — Sandbox Deployment & Installation Challenges

Status: **deployment research / partially superseded** · Flywheel, not Marina, now owns VMM and
guest-image packaging. Marina deployment and graceful-degradation requirements still apply. See
[code-flywheel-execution-plan.md](./code-flywheel-execution-plan.md) for canonical sequencing.

The code seam (Step 1, `WorkspaceRuntime`) had **zero** deployment impact — it's type-only. But the
*sandbox direction* changes Marina from "a Bun process you can run anywhere" into something that, in
sandbox mode, needs **host virtualization**. This doc captures what that breaks and how we contain it.

## The headline tension: today's deployment can't run VMs
Current deployment (grounded in `Dockerfile` + `docker-compose.yml`):
- A **single unprivileged Bun process** (`USER bun`, UID 1000) in a Docker container.
- SQLite + assets + the Code Mode workspace on a mounted `/app/data` volume.
- Shipped to **ECR / cloud** (ECS/EC2/K8s).

A microVM (vfkit/crosvm) needs **privileged host virtualization** — `/dev/kvm` (Linux),
`Virtualization.framework` entitlements (macOS), WHPX (Windows). **None of that exists for an
unprivileged container**, and cloud instances usually lack **nested virtualization**. So sandbox mode
**cannot run inside the current container deployment.**

## The resolution: two deployment modes, graceful degradation
This is *fine* because of the opt-in design ("many things don't need a sandbox"). The sandbox is a
**capability that lights up where the host supports it**, and **degrades to today's local path
everywhere else** — never a hard install requirement.

| | **Mode A — Server / container (today, unchanged)** | **Mode B — Desktop bundled-VM (new, Decision #2)** |
|---|---|---|
| Host | unprivileged container, cloud | macOS/Linux/Windows desktop, on the host |
| Virtualization | usually none → **sandbox OFF** | present → **sandbox ON** |
| Coding exec | **local path only** (current behavior, strict allowlist) | sandboxed microVM per workspace |
| Install impact | **none** | new signed artifact (VMM + golden image) |
| Artifact | the lean Bun container as-is | a desktop bundle / installer |

**Principle:** keep the lean container exactly as it is; sandbox is additive and host-gated. A
Marina that can't virtualize still runs — it just reports the sandbox as unavailable.

## Challenge catalog
1. **Host virtualization access & privileges (per OS).**
   - *Linux:* `/dev/kvm` must exist and be accessible (the process needs `kvm` group / device perms).
     A container needs `--device /dev/kvm` + relaxed privileges — contrary to today's unprivileged image.
   - *macOS:* the app must be **signed with the `com.apple.security.virtualization` entitlement**
     (and `com.apple.vm.networking` for VM networking), hardened runtime.
   - *Windows:* the **Windows Hypervisor Platform** feature must be enabled (often a **reboot**), Win 11;
     can conflict with other hypervisors/anti-cheat.
2. **Nested virtualization in cloud/containers (the big server blocker).** Most cloud VM instances and
   all standard containers can't nest VMs. Running VMs in K8s needs **KubeVirt** or privileged pods
   with `/dev/kvm`. → Server mode realistically stays **local-path only**; sandbox is a desktop story.
3. **Bundle size & multi-arch artifacts.** Golden guest image (kernel+rootfs) is hundreds of MB **per
   arch** (x86_64 **and** arm64), plus VMM binaries (vfkit: small Go; crosvm: larger Rust, built per
   OS/arch). The desktop download balloons from a small app to hundreds of MB+.
4. **Code signing / notarization.** macOS: notarize the vfkit/native helper + virtualization
   entitlement + hardened runtime + Gatekeeper. Windows: sign the crosvm binary + installer. New
   signing infrastructure and certs.
5. **Build pipeline.** Reproducible guest-image build (kernel config, minimal rootfs, guest agent
   baked in), crosvm build matrix, signing CI — a whole new artifact pipeline beyond `bun run build`.
6. **Runtime resource footprint.** Each workspace VM costs RAM/CPU/disk beyond the Bun process. Box
   sizing changes; this is where admission control / warm-pool (gap G8) becomes a *deployment* concern.
7. **Networking & vsock host support.** vsock needs host support (`vhost_vsock` on Linux; built into
   Virtualization.framework on macOS; Hyper-V sockets on Windows). VM networking/egress proxy may need
   elevated setup (macOS `vmnet` entitlement/helper; Linux tap devices vs userspace slirp).
8. **Capability detection & graceful degradation (the key mitigation).** Marina must detect at runtime
   whether virtualization + vsock are available and **fall back to the local path** otherwise. The
   existing readiness mechanism (`src/engine/readiness.ts`, the `readiness`/`doctor`/`health` command,
   and `code doctor`) is the natural home — extend it to report **sandbox availability + remediation**
   (e.g. "no /dev/kvm", "enable WHPX", "sign with virtualization entitlement").
9. **Updates / versioning.** Guest image + guest agent + VMM are versioned with Marina (the protocol
   compatibility contract). Updates ship larger payloads; snapshots invalidate on image change (gap G10).
10. **Install-time friction & corporate policy.** Asking users to enable virtualization / join `kvm` /
    reboot for WHPX is friction; managed/locked-down machines may forbid it → those installs run
    local-only.
11. **Current Docker/compose continuity.** The `/app/data/workspace` Code Mode dir (already configured
    in compose via `MARINA_CODE_ROOTS`) is exactly what becomes the **virtio-fs share** in desktop
    mode — nice continuity. In container mode it stays a plain volume; nothing changes.

## Mitigations / principles
- **Opt-in + capability-gated:** sandbox activates only where the host supports it; everywhere else =
  local path (today's behavior). **Never a hard install requirement.**
- **Keep two artifacts:** the lean container (server, unchanged) **and** a separate desktop bundle
  (sandbox mode). Don't bloat the container with VM payloads it can't use.
- **`readiness`/`code doctor` is the contract with the operator** — it answers "is the sandbox
  available here, and if not, what do I do?" Reuse the existing pattern; don't invent a new one.
- **Defer the expensive parts** (signing, multi-arch images, the bundle pipeline) until after the PoC
  proves value. The PoC ships nothing — it uses dev-box virtualization.

## Impact on the next increment
**Increment 2 (guest core) is dev-only** — it needs `/dev/kvm` on a Linux dev box (or a Mac with
vfkit) and ships no artifact, so it carries **none** of the production deployment burden above. The
deployment challenges land at the **bundle/distribution increment**, well after the loop is proven.
First deliverable that touches deployment at all: extend `code doctor`/`readiness` to **detect and
report sandbox capability** — small, useful immediately, and the foundation for graceful degradation.
