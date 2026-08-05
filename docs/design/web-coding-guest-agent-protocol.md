# Web Coding — Guest-Agent ↔ Host Protocol (proposal, no code)

Status: **historical protocol research / Flywheel-owned layer** · The canonical Marina plan is
[code-flywheel-execution-plan.md](./code-flywheel-execution-plan.md). Marina no longer owns a
parallel guest-agent protocol; applicable transport requirements belong in Flywheel. This document
remains a threat-model and use-case input.
This is the **versioned compatibility contract** between the bundled golden guest image (which
contains the *guest agent*) and the host (`SandboxWorkspaceRuntime` inside Marina). Because the
image and host ship together per Marina release, this protocol is the single thing that must be
designed for stability and forward/backward compatibility.

Goal of this doc: **capture the use cases exhaustively first**, then sketch a message model that
covers them. No wire format, no code yet.

---

## 1. Trust boundary (drives everything)
- **The guest is UNTRUSTED.** It runs agent-driven, possibly hostile code. The host must treat
  every guest-originated byte as adversarial input: bounded message sizes, no host-side path
  resolution from guest-supplied paths, per-stream backpressure/quotas, no guest ability to make
  the host act outside the workspace.
- **vsock is the only channel.** Host↔guest only; never network-exposed. No inbound network path
  from guest to host. A per-VM **boot token** (host-generated, handed in via kernel cmdline /
  cloud-init, presented by the agent on handshake) authenticates *which VM* a connection is, so a
  stray process can't impersonate the agent channel.
- **Capability, not ambient authority.** The guest receives only what the host injects for this
  session (workspace mount, scoped secrets, egress policy). Filesystem authority and agent
  identity are separate (a persistent Marina citizen gets a *temporary, narrow* workspace).

## 2. The host/guest split — keep the protocol SMALL
virtio-fs shares the workspace **bidirectionally and coherently**: files the host writes appear
in the guest and vice-versa. Therefore **most `WorkspaceRuntime` methods stay host-side over the
share and need NO protocol**:

| `WorkspaceRuntime` op | Where it runs | On the protocol? |
|---|---|---|
| `read` / `list` / `search` / `diff` | **Host**, directly on the virtio-fs share | No |
| `checkPatch` / `applyPatch` / `reversePatch` (git apply) | **Host**, on the share | No |
| file-change notifications (for dashboard/graph) | **Host** watches the share (fsnotify) | No |
| **`run` (execute commands)** | **Guest** (the isolation boundary) | **Yes — the core** |
| getPolicy | Host (`WorkspaceGateway`) | No |
| cleanup / lifecycle | Both | Yes (lifecycle) |

So the protocol's mandatory surface is: **lifecycle + execution + a few control concerns
(secrets, port-forward, events, resource/idle)**. Everything filesystem is host-side. This is the
key simplification and the reason the attack surface stays small.

*(Caveat to decide: virtio-fs cache coherence mode, and whether the host should mutate the share
while the guest runs. Default stance: host mutations (patch apply) happen between exec runs, not
during; revisit if we need concurrent host-write + guest-run.)*

---

## 3. Use-case catalog (the part that must be perfect)
Grouped by concern. Each is a requirement the protocol must satisfy.

### 3.1 Lifecycle & handshake
- **U-L1 Boot & connect.** VM boots → guest agent starts → dials host vsock port → presents boot
  token. Host accepts exactly one agent per VM.
- **U-L2 Handshake / capability negotiation.** Agent advertises: protocol version, image
  version/digest, guest arch (x86_64/arm64), kernel version, available toolchains (bun, node,
  python, git, rg, …), Rosetta availability (Apple Silicon). Host advertises: protocol version it
  speaks, session context (see U-L3). Both pick the highest common protocol version.
- **U-L3 Session bind.** Host tells the agent: session id, participant/actor identities allowed,
  workspace mount info (tag → guest path, ro/rw), policy mode (**host-strict vs guest-open**),
  env baseline, resource limits.
- **U-L4 Readiness.** Agent signals "ready to accept work" (mount verified, init complete).
- **U-L5 Heartbeat / health.** Periodic liveness both ways; host detects a hung/dead guest.
- **U-L6 Graceful shutdown / reclaim.** Host asks the agent to quiesce (stop accepting work,
  flush, terminate children) before VM stop. Tied to idle reclaim (U-R3).
- **U-L7 Quiesce for snapshot / resume.** Host asks the agent to reach a snapshot-safe state;
  later "resumed" after restore. (Feeds the open snapshot/update question.)
- **U-L8 Time sync hint.** Surface clock skew after suspend/restore (VMMs offer timesync; agent
  may need to re-sync dependent state).

### 3.2 Execution — the core
- **U-X1 Start a finite command.** argv, cwd (within workspace), env overlay, timeout, max-output,
  pipe-vs-pty, optional stdin, **actorId** (which agent/participant issued it). Returns a process
  handle/id.
- **U-X2 Stream output.** Ordered, chunked stdout/stderr tagged by stream + sequence; explicit
  **truncation** signal when over max-output; **timeout** signal; final **exit** (code, signal,
  durationMs). Mirrors today's `WorkspaceRunResult`.
- **U-X3 Stdin / interactive input.** Client→guest byte stream to a running process (REPLs, tools
  that read stdin).
- **U-X4 PTY / TUI.** Allocate a pseudo-terminal; carry terminal resize events; for interactive
  CLIs and TUIs. (vfkit/crosvm-agnostic — it's inside the guest.)
- **U-X5 Cancel / signal.** Send SIGINT/SIGTERM/SIGKILL to a process or its tree; host-driven
  cancel (the `code` cancel affordance, runaway protection).
- **U-X6 Concurrent processes.** Multiple processes in one workspace at once (a build + a test + a
  dev server), each independently streamed/controlled. The protocol is multiplexed.
- **U-X7 Long-running services (`code run app`).** Start a server/daemon that **persists across
  turns**, distinct from finite commands: keep-alive, stream logs continuously, query status,
  stop later. Must be modeled separately from U-X1 (the design explicitly wants servers ≠ finite
  commands).
- **U-X8 Environment & toolchain selection.** Per-exec env, working dir, and (later) selecting a
  language/toolchain version available in the image.

### 3.3 Policy, secrets, identity
- **U-P1 Actor-tagged dispatch + write-lock.** A shared crew session = **one workspace VM with
  multiple actors**. Every exec carries `actorId`; the **host `WorkspaceGateway` enforces the
  Phase-4 write-lock and host-strict/guest-open policy BEFORE dispatch** — the protocol *carries*
  identity, the host *decides*. The guest never self-authorizes.
- **U-P2 Scoped secret injection.** Inject per-session secrets (git creds, API keys) **on demand,
  ephemerally**, scoped to a process or the session — never baked into the image. Revocable.
- **U-P3 Human-in-the-loop escalation (optional).** A guest action may request host authorization
  (e.g., first network egress, a `git push`, accessing a named secret) → host may surface a Marina
  **approval card** → grant/deny flows back. Lean: pre-grant where possible (U-P2, U-N1); use this
  only for genuinely interactive approvals.

### 3.4 Network & ports
- **U-N1 Egress policy.** "Guest-open" execution still must not bypass SSRF/`url-guard`. Enforce
  at the **VM network layer** (NAT through a host egress proxy that applies `url-guard`), *not* via
  per-call protocol messages. Protocol may report egress denials for the transcript.
- **U-N2 Port-forward (ingress to the app).** Expose a guest service port (a dev server from
  `code run app`) to the host/dashboard — vsock-tunneled or via VMM networking. Open/close/list
  forwards. Essential for app preview/observation.

### 3.5 Observation & verification (the deferred "verify app behavior")
- **U-O1 App observation.** Reaching `code run app` for browser/TUI/API checks = U-N2 (port-fwd)
  + U-X (run a headless browser / curl inside the guest) + artifacts written to the **share**
  (screenshots, reports the host reads directly). No special protocol beyond exec + port-forward
  + shared-FS artifacts. Captured here so it isn't reinvented.

### 3.6 Events back to Marina
- **U-E1 Execution events → coding transcript.** process started / output / exited, denials,
  service up/down map onto Marina's existing `coding_events`/feed for the WebChat transcript.
  Mostly derivable from U-X streams; this use case is about *what the host forwards*, not new guest
  messages.
- **U-E2 Resource/usage telemetry.** Periodic CPU/mem/disk usage per workspace (for limits,
  idle detection, dashboard).

### 3.7 Resource, limits, reclamation
- **U-R1 Limits.** CPU/mem/disk caps — set at VM creation (VMM-level), reported via U-E2.
- **U-R2 Output/stream quotas.** Per-process and per-connection backpressure + caps (anti-DoS from
  untrusted guest).
- **U-R3 Idle reclaim.** Agent reports idleness; host reclaims/suspends the VM after a TTL keyed to
  the participant/session (Decision #5). Resume via snapshot (U-L7) or cold boot.

### 3.8 Failure & resilience
- **U-F1 Connection loss.** VM crash / agent crash → host detects (U-L5), marks workspace failed,
  surfaces it, can restart/rebuild. In-flight processes are considered lost.
- **U-F2 Reconnect semantics.** Whether the agent may reconnect and re-attach to still-running
  processes after a transient host-side disconnect (decide: re-attach vs treat as terminal). Lean:
  best-effort re-attach for long-running services (U-X7); finite commands treated as terminal.
- **U-F3 Orphan cleanup.** On session end / actor removal, kill that actor's processes; on VM
  teardown, everything dies with the VM (free isolation win).

---

## 4. Message model (conceptual — no wire format)
The use cases need four interaction shapes; all multiplexed over **one vsock connection** (logical
channels by id), so concurrent processes/tunnels don't head-of-line block each other:

1. **Unary request/response** — handshake, session bind, start-process, signal, secret-provision,
   open/close port-forward, quiesce, status. (Bounded, validated host-side.)
2. **Server-stream** — process stdout/stderr, service logs, usage telemetry, events.
3. **Client-stream / bidirectional** — stdin, PTY I/O + resize.
4. **Byte tunnel** — port-forward payloads (U-N2).

This shape maps cleanly onto **gRPC-over-vsock** (unary + server/client/bidi streaming, codegen,
backpressure) — the leading transport candidate — vs. a **custom length-prefixed framed protocol**
(no dep, full control, but we reimplement streaming/flow-control). **Transport choice is an open
decision** (§6); the *use cases and message families below are transport-independent.*

### Message families (direction · kind · carries) — sketch, not final
| Family | Op (examples) | Dir | Kind | Carries |
|---|---|---|---|---|
| Handshake | `Hello`, `Accept` | g↔h | unary | versions, image digest, arch, toolchains, boot token |
| Session | `BindSession`, `Ready`, `Quiesce`, `Resume`, `Shutdown` | h→g | unary | session id, actors, mount info, policy mode, limits |
| Health | `Ping`/`Pong`, `Heartbeat` | g↔h | unary/stream | liveness, timestamps |
| Exec | `StartProcess`, `Exited` | h→g / g→h | unary | argv, cwd, env, timeout, actorId, pty?, handle/id; exit code/signal/duration |
| Exec I/O | `Stdout`,`Stderr`,`Stdin`,`Pty`,`Resize` | g↔h | stream | stream id, seq, bytes, truncation/timeout flags |
| Control | `Signal`(INT/TERM/KILL), `Cancel` | h→g | unary | process/tree id, signal |
| Service | `StartService`,`ServiceStatus`,`StopService`,`ServiceLog` | h↔g | unary+stream | long-running handle, status, logs |
| Secrets | `ProvideSecret`,`RevokeSecret` | h→g | unary | scoped secret ref, lifetime |
| Net | `OpenForward`,`CloseForward`,`ForwardData`,`EgressDenied` | h↔g | unary+tunnel | guest port, host endpoint, bytes |
| Approvals | `RequestAuthorization`,`AuthorizationResult` | g→h→g | unary | action, reason, grant/deny |
| Telemetry | `Usage` | g→h | stream | cpu/mem/disk, idle |

---

## 5. Versioning & compatibility (the contract's whole point)
- **Single integer protocol version + capability flags.** Handshake negotiates the highest common
  version; capabilities allow additive features without a version bump.
- **Image ↔ host pinning.** The golden image records the protocol version it implements; the host
  records the range it supports. Mismatch beyond the supported range → host refuses the VM and
  surfaces a clear "image too old/new, update Marina" error (feeds the snapshot/update story).
- **Additive-by-default.** New message families/fields must be optional; never repurpose a field.
  This is what lets a bundled image keep working across a Marina point-release.

---

## 6. Open decisions (to resolve before building)
- **Transport:** gRPC-over-vsock (mature streaming, dep + vsock plumbing) vs. a custom framed
  protocol (no dep, we own flow-control). Leaning gRPC for the streaming maturity; needs a vsock
  transport shim on both ends.
- **Dial direction:** guest-dials-host (proposed — simpler host listen + token) vs. host-dials-guest.
- **Re-attach (U-F2):** may a reconnecting agent re-attach to running services, or is every
  disconnect terminal? Lean: re-attach only for long-running services.
- **virtio-fs coherence mode** and the host-mutate-during-guest-run stance (§2 caveat).
- **PTY scope:** do we need full PTY/TUI in v1, or pipe-only first with PTY as a capability flag?
- **Secret model:** push-at-start (env) vs pull-on-demand (agent asks) vs a guest secrets broker.
- **Approval granularity (U-P3):** which actions are pre-granted vs human-in-the-loop.

---

## 6.5 How it takes shape in use — scenario walkthroughs (gap hunt)
Each scenario traces the full stack (Marina → `WorkspaceGateway` → `WorkspaceRuntime`/VMM →
guest agent over vsock → share) and flags where a step has no home in §1–§5.

**S1 — Solo agent, first session.** Alice runs `code start`. Host must *create* the workspace
**before** any vsock exists: provision a host dir (empty? clone a repo? a template?), then boot a
VM and virtio-fs-mount it. → **GAP G1: workspace provisioning/seeding** (source of initial
content + creds to fetch it) is entirely missing — the catalog starts at "VM boots," but
something must populate the workspace first.

**S2 — Install deps, then idle-reclaim, then resume.** Alice runs `bun install`; tests pass; she
goes idle; host reclaims the VM (U-R3); later she returns. If `node_modules` landed on the
**share** it survives; if it landed in the guest **rootfs** it's gone. → **GAP G2: persistence
model** — exactly what survives teardown (share = durable host storage) vs what's ephemeral
(guest rootfs, installed system packages, running services) is undefined, and it silently governs
correctness. Likely foundational: *workspace = durable share; VM = disposable.*

**S3 — Crew on one shared session (write-lock × exec).** Bob holds the write lock; Carol reviews;
Dave runs tests. Carol's `diff` is host-side (fine). But Dave's `code run test` **executes in the
guest and can write files** (coverage, snapshots) to the shared workspace — Dave isn't the writer.
U-P1 gates *dispatch by actor*, but we can't statically know an exec mutates. → **GAP G3:
multi-actor exec side-effects** — the Phase-4 lock was defined on *patch-apply*, not arbitrary
exec. Either non-writers run against a copy-on-write/overlay view, or we accept shared-FS races.
This **reopens the deferred worktree question** and is the biggest unresolved tension.

**S4 — Two concurrent processes (single actor).** A `dev` build and a `test` run at once (U-X6)
both write the tree. → **GAP G3b: concurrent-write coherence** even within one actor.

**S5 — Long-running dev server + live edit.** `code run app` starts a server (U-X7), port-forwarded
to the dashboard (U-N2). Alice edits a file on the host; the in-guest watcher should hot-reload. But
**inotify/fsnotify over virtio-fs is historically unreliable**. → **GAP G4: file-change
notification *into* the guest** — watch-mode/HMR may not fire; may need a host→guest "files changed"
hint or a polling fallback. Real DX pain.

**S6 — Private repo + registry + runtime API key.** Clone needs a git token; `bun install` needs
broad public egress; the app under test needs its own API key at runtime. Injecting raw secrets
into an **untrusted** guest means hostile code can exfiltrate them. → **GAP G5: host-side
credential brokering** — prefer a host git-credential-helper / registry proxy so the guest never
sees raw long-lived tokens; accept that *runtime* keys the app genuinely needs are exfiltratable
and must be narrowly scoped + audited. → **GAP G6: egress granularity** — "guest-open" vs
url-guard: allow-all-public (needed for installs) vs allowlist; who configures it.

**S7 — Marina (host) restarts while VMs run.** A deploy/crash restarts the Marina process. Are the
running workspace VMs orphaned or re-adopted? U-F2 covered *guest* disconnect, not *host* restart.
→ **GAP G7: host-restart re-adoption** — a persisted VM registry so Marina re-attaches to live
workspaces on boot (and reaps true orphans).

**S8 — Ten participants at once.** Decision #5 gives each participant a VM → RAM pressure. → **GAP
G8: admission control & quotas** (max concurrent VMs, queue/deny, per-host budget) + **GAP G8b:
warm pool** to hide boot latency.

**S9 — Operator oversight.** An operator wants to list every live workspace, inspect/kill a stuck
one, and answer "who ran what" (civic-substrate audit). → **GAP G9: operator control plane +
audit log** — list/inspect/kill workspaces; every exec already carries `actorId` (U-P1), so an
audit trail (who/what/when, tied to standing) is cheap and should be explicit.

**S10 — Snapshot resume.** U-L7 snapshots VM memory+rootfs, but the workspace lives on the
**external share**. If the share changed between snapshot and restore, the restored VM's in-memory
view is inconsistent; and a golden-image update invalidates old snapshots. → **GAP G10: snapshot
consistency** between VM memory-state and the external share (+ image-version coupling).

**Minor:** **G11 workspace reset** (clean state = git-clean on the share + optional VM rebuild for
guest state); **G12 binary/non-UTF-8 exec output** handling in a text transcript; **G13 surfacing
interactive guest prompts** (`[y/N]`, `npm login`) to the Marina user via stdin/PTY round-trip.

## 6.6 Gaps surfaced — fold into the design
| ID | Gap | Severity | Lives in | Resolution direction |
|----|-----|----------|----------|----------------------|
| **G1** | Workspace provisioning / seeding (source + fetch creds) | **High** | Host runtime (pre-vsock) | New lifecycle stage *before* boot: empty / clone / template; clone via host credential broker (G5) |
| **G2** | Persistence model: durable share vs ephemeral VM | **High (foundational)** | Runtime + image | Lock the rule: *workspace state = the share; VM is disposable*; deps must land on the share to persist; document what's lost on teardown |
| **G3** | Multi-actor / concurrent exec side-effects vs write-lock | **High (open)** | Gateway + runtime | Decide: overlay/CoW per non-writer vs accept shared-FS; reconciles with the deferred **worktree** decision |
| **G4** | File-change notification *into* the guest (HMR/watch) | Medium | Protocol + image | Host→guest `FilesChanged` hint family; polling fallback; pick virtio-fs cache mode accordingly |
| **G5** | Host-side credential brokering (untrusted guest) | **High (security)** | Host runtime | git-credential-helper / registry proxy on the host; never inject raw long-lived tokens; scope+audit runtime keys |
| **G6** | Egress policy granularity | Medium | Gateway + net | Allow-all-public vs allowlist; per-session config; report denials (U-N1) |
| **G7** | Host-restart re-adoption of live VMs | Medium | Host runtime | Persisted VM registry; re-attach on Marina boot; reap orphans |
| **G8** | Admission control / quotas (+ warm pool) | Medium | Host runtime | Max concurrent VMs, queue/deny, per-host RAM budget; optional pre-warm |
| **G9** | Operator control plane + audit log | Medium | Host + Marina | list/inspect/kill workspaces; exec audit (actorId→standing) |
| **G10** | Snapshot ↔ external-share consistency | Medium | Runtime | Couple snapshot to share revision + image version; invalidate on mismatch |
| **G11–13** | Reset / binary output / interactive prompts | Low | Mixed | Reset = git-clean(+rebuild); stream raw bytes, render safely; PTY round-trip to user |

**Takeaways that change the shape:**
- **Two foundational rules to lock before anything else:** *(a)* **workspace = durable host share,
  VM = disposable** (G2) — it dictates where deps install and what survives; *(b)* **the protocol
  begins at provisioning, not at boot** (G1) — add a pre-boot lifecycle stage.
- **G3 forces the worktree decision we deferred.** Multi-actor crews on one workspace can't safely
  share a single mutable FS during concurrent exec. The cleanest fit with the rest: per-actor
  working **views** (leading mechanism: **git worktree**; alternatives: overlayfs CoW / host CoW
  clone), merged only through the existing patch-apply/write-lock path, with Phase-3 checkpoints as
  the canonical revisions. **Designed in full in
  [web-coding-workspace-isolation.md](./web-coding-workspace-isolation.md)** — it reuses our
  existing primitives (checkpoint = revision, write-lock+patch-apply = promotion) and only *adds*
  per-actor views.
- **G5 reframes secrets:** in an untrusted guest, *broker* don't *inject*. This is a real change to
  U-P2's "inject scoped secret" — most credential use (git, registries) should never put a raw
  token in the guest at all.

## 7. Alignment notes
- Reuses, doesn't fork, the coding plan's vocabulary: the host side is `SandboxWorkspaceRuntime`
  behind `WorkspaceRuntime`; policy/identity/write-lock enforcement is the `WorkspaceGateway`
  (host-side, pre-dispatch — U-P1).
- The **golden guest image (Decision #6)** carries this agent; the protocol version is bundled with
  it. The same agent + protocol run identically under vfkit (macOS) and crosvm (Linux/Windows) —
  host drivers differ, the guest contract does not.
- Honors the host/guest split: filesystem ops stay host-side over the share; only execution and
  control cross the vsock boundary.
