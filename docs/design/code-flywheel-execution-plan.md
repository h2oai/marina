# Code Mode × Flywheel execution plan

Status: **canonical plan / M1–M4 functional slices shipped / production hardening active** · Updated
2026-08-05 · Supersedes the execution direction in the earlier sandbox PoC/scoping documents. Those
documents remain useful technical research, but this file owns sequencing and product decisions.

## Outcome

Every Marina entity can have one durable Flywheel coding sandbox. Humans and agents use the same
Code Mode workflow to create or resume it, materialize a project, install dependencies, edit and run
code, publish an app when authorized, and hibernate it when idle. Marina remains the authority for
identity, policy, collaboration, approvals, artifacts, and civic history; Flywheel owns isolated
compute, process execution, persistent guest storage, hosting, and sandbox lifecycle.

The first implementation is deliberately **one sandbox per entity**, not per task or coding session.
Coding sessions and projects are contexts inside that entity workspace. This matches Marina's civic
identity model and the integration already shipped, controls resource growth, and lets a person or
agent carry a working environment between related tasks. A later policy may allocate extra isolated
sandboxes for mutually untrusted projects or high-concurrency crews without changing the API shape.

## Current baseline (ground truth)

- Code Mode is agentic by default and already has durable sessions, typed events/artifacts,
  approvals, checkpoints, a write lock, agent/crew drivers, workspace selection, and an extracted
  `WorkspaceRuntime` contract.
- `LocalWorkspace` still provides host-side file operations and a conservative allowlisted `run()`.
- Marina has a dependency-free Flywheel Connect client and an identity-bound `FlywheelManager`.
  With `FLYWHEEL_TOKEN`, its MCP tool can create, exec, publish, inspect, hibernate, resume, and stop.
- The manager retains the operator token, mints session-bound ten-minute capabilities, refreshes
  them before expiry, and never returns credentials to an entity.
- Entity bindings are durable in Marina, contain no credentials, and reconcile against Flywheel's
  registry when the optional integration starts. Unreachable or missing sandboxes become explicitly
  unavailable and never fall back to host execution. Code Mode routes finite commands through an
  explicitly selected sandbox target and uses the active durable project as its guest cwd.
- Flywheel supports arbitrary streamed exec, keep-alive sandboxes, persistent VM writable disks,
  cold-boot hibernate/resume, publishing, registry persistence, and restart recovery.
- Marina now implements bounded guest binary read/write over Flywheel's typed `Exec` byte stream and
  uses it for complete project archives and browser evidence. Flywheel still has no first-class
  workspace/file-transfer or host-directory mount RPC; the Exec adapter is an intentionally bounded
  bridge, not a claim of live workspace synchronization.
- Durable project metadata, empty/public-Git materialization, safe switching, patch/archive
  import/export, managed services, publish/revoke, probes, and browser screenshots have landed.
  Private Git and other credentialed resources remain closed pending the broker contract.

## 2026-08-05 implementation review

Commits `5c85aef` and `76dcded` moved the integration from control-plane scaffolding to a usable
credential-free coding workflow. Review validation: 2,271 Marina tests pass across 143 files, the
focused Flywheel/project/service suites pass, and TypeScript and Biome checks are clean.

The shipped slices are strong enough for controlled use, but “M1–M4 complete” means **functional
scope complete**, not production hardening complete. The review found these explicit residual risks:

- Archive transfer is compressed-byte and path-list bounded, but does not yet enforce an independent
  expanded-byte budget, member-count budget, file-type policy, or explicit symlink/hardlink policy.
- Public Git URL validation rejects obvious credential and private-address forms, but application
  parsing is not a network boundary: DNS resolution/rebinding, IPv6/private ranges, redirects, and
  egress destinations must be enforced by Flywheel's network layer.
- Managed services persist guest PIDs and restart recipes. PID-only liveness/control can mistake PID
  reuse for the original process; production control needs a Flywheel process handle or verified
  process birth identity/supervisor record.
- Binary read/write uses ordinary Exec processes. It needs authoritative terminal-status, digest,
  byte-count, cancellation, and partial-cleanup evidence before larger or security-sensitive use.
- Unit and mocked integration coverage is comprehensive, but the release gate still needs a repeatable
  live Marina↔Flywheel matrix across supported backends, restart, hibernate, timeout, and failure modes.
- Quotas, idle policy, operator inventory/reclamation, metrics, and alerts are not yet productionized.

## Locked decisions

1. **Flywheel is the canonical sandbox substrate.** Marina will not independently drive vfkit,
   crosvm, Docker, or guest-agent transports. Those belong behind Flywheel.
2. **One sandbox per entity for v1.** The durable binding is keyed by Marina entity ID. A sandbox
   may serve many sequential coding sessions and projects, but only one project is active at a time.
3. **Sandbox use is explicit at first.** `LocalWorkspace` remains available for trusted operator
   work. Code Mode shows its execution target and never silently falls back from requested sandbox
   execution to host execution.
4. **Sandbox-native execution.** Installs, generated programs, tests, build tools, dev servers, and
   agentic subprocesses run in Flywheel. Host execution keeps its strict allowlist.
5. **Marina authorizes; Flywheel enforces isolation.** `code.exec` remains required. Creation,
   network/credential binding, publishing, and destructive teardown use existing safety gates and
   approval flows; new gates are added only when existing semantics are genuinely insufficient.
6. **No raw secrets in the guest by default.** Git/provider credentials are short-lived and
   purpose-bound through a broker/proxy. They are never embedded in command arguments, artifacts,
   logs, or persisted capability records. The complete cross-product contract covers Git, package
   registries, model/cloud APIs, storage, signing, and app runtime access in
   [sandbox-credential-broker.md](./sandbox-credential-broker.md).
7. **No fake workspace coherence.** Host files and sandbox files are distinct until a versioned
   materialization/synchronization contract exists. The UI always names the authoritative copy.
8. **Hibernate is normal idle lifecycle.** It preserves the writable disk but not processes. Resume
   is a reboot, so services must be explicitly restarted.
9. **Stop is destructive and explicit.** Stop discards the durable guest workspace and requires a
   confirmation/approval when it contains unexported work.
10. **The products remain independent.** This integration is additive for both products. Marina
    boots and retains local Code Mode without Flywheel; Flywheel serves any conforming consumer
    without Marina. Neither product shares the other's database, imports its internal types, or
    assumes control of its lifecycle.

## Independent products invariant

“Flywheel is the canonical sandbox substrate” means Marina does not duplicate Flywheel's backend,
VMM, guest-agent, or sandbox-lifecycle machinery. It does **not** mean Flywheel is required to run
Marina. Likewise, Marina is Flywheel's reference consumer, not part of Flywheel's runtime.

The integration must preserve these boundaries:

- Marina starts normally with no Flywheel configuration and exposes all non-sandbox features.
- Local Code Mode remains a first-class, tested runtime with its current host-safe policy.
- Flywheel starts normally without Marina and exposes the same generic Connect API and SDKs to all
  consumers. Its public protocol contains no Marina-specific entity, standing, approval, or Code
  Mode fields.
- The products have separate processes, configuration, persistence, migrations, release artifacts,
  and lifecycle ownership. A convenience bundle may compose them but cannot become the only
  supported installation.
- Integration crosses only versioned public interfaces. Marina adapts its entity/session context to
  Flywheel session IDs locally; Flywheel never reads Marina's database or calls Marina internals.
- Flywheel types and backend details do not leak into Marina's user-facing Code Mode contract.
- Flywheel absence or failure degrades only sandbox-backed operations. Marina health, local Code
  Mode, agents, worlds, memory, collaboration, and APIs remain operational.
- A requested sandbox operation fails visibly when Flywheel is unavailable. Marina never silently
  executes it on the host.
- Each repository keeps its standalone suite independent. Cross-product live tests are an explicit
  integration job and are not prerequisites for running either product's unit tests.

| Marina | Flywheel | Required behavior |
| --- | --- | --- |
| running | absent/unconfigured | full Marina; local Code Mode available; sandbox reported unconfigured |
| running | configured and healthy | local and Flywheel sandbox targets available |
| running | configured but unreachable | Marina healthy; sandbox unavailable with actionable remediation; no host fallback |
| absent | running | full standalone Flywheel API/SDK behavior for other consumers |
| composed bundle | running | integrated experience using the same public interface as separate deployment |

## Architecture

```text
human or agent
      │
      ▼
Marina Code Mode ── session/task/project context, approvals, artifacts, audit
      │
      ▼
WorkspaceGateway ── identity + gate + policy + target selection
      │
      ├── LocalWorkspace (trusted host path; strict allowlist)
      │
      └── FlywheelWorkspaceRuntime (entity binding; guest-open policy)
                 │
                 ▼
         FlywheelManager ── operator token + attenuated capability
                 │
                 ▼
         Flywheel sandbox ── persistent disk, exec, process stream, publish
```

`WorkspaceGateway` is the policy seam, not another executor. `FlywheelWorkspaceRuntime` adapts Code
Mode operations to the entity sandbox. Flywheel remains the only layer that knows backend details.

## Workspace materialization contract

This is the critical dependency for real project work. Support these sources in order:

1. **Empty/bootstrap workspace** — create files and programs entirely in the sandbox. This unlocks
   safe arbitrary code and agentic jobs without synchronization.
2. **Public Git clone** — clone a URL into a deterministic project directory in the sandbox.
3. **Archive import/export** — shipped as a bounded Exec-stream bridge with staged promotion. Expanded
   size, member-count, special-file, symlink/hardlink, and digest enforcement are M5 release gates.
4. **Private Git clone** — same flow through a short-lived brokered credential; never persist it in
   `.git/config` or command output. This remains blocked on the cross-product broker contract.
5. **Optional host share/mount** — only after Flywheel exposes a backend-neutral mount contract and
   its threat model is complete. It is not required for the first useful release.

Each entity sandbox uses `/workspace/projects/<project-id>`. Marina persists a project record with
source type, sanitized source locator, guest path, base revision/checksum, active branch, and last
successful import/export. Project switching validates a clean/exported state or requests approval.

For Git projects, Git is the synchronization and promotion protocol. Marina surfaces status/diff,
creates commits only with explicit attribution, and exports via push or archive. It never claims a
host checkout and sandbox checkout are live mirrors.

## Durable state

Add a Marina record keyed uniquely by `entity_id`:

- Flywheel session ID and sandbox ID
- image and backend capability flags
- lifecycle state: `creating | running | hibernated | unavailable | stopping`
- active project ID and guest cwd
- creation, last-use, hibernation, and reconciliation timestamps
- last known Flywheel error (sanitized)

Do **not** persist operator or capability tokens. On Marina restart, reconcile the record against
Flywheel's registry. Adopt a matching running/hibernated sandbox, mark missing state unavailable, and
never create a replacement until reconciliation finishes. Creation uses a DB uniqueness constraint
plus an in-process single-flight guard.

## Code Mode behavior

- `code sandbox start [image]` creates or adopts the entity sandbox.
- `code sandbox status` reports target, lifecycle, project, cwd, persistence, and remediation.
- `code sandbox use` selects Flywheel for new/current Code Mode execution after readiness checks.
- `code sandbox local` selects the trusted local runtime; it is never an error fallback.
- `code sandbox hibernate|resume|stop` controls lifecycle with the rules above.
- `code project init|clone|import|status|export|switch` manages sandbox projects.
- `code run`, `verify`, `test`, `lint`, and `typecheck` route through the selected runtime.
- Package-manager commands and arbitrary commands are permitted only in the sandbox policy. Commands
  remain argument arrays—no implicit shell. A shell is an explicit command and separately audited.
- Long-running processes get stable IDs, bounded logs, `list/logs/stop`, and ownership by the entity
  sandbox plus originating coding session. Hibernation terminates them and records restart recipes.
- Publish requires an explicit port, authorization, an expiry, and visible revocation. Published
  URLs are treated as externally reachable.

## Policy and audit invariants

- Every operation carries the Marina actor/entity ID and active coding session ID into events.
- `code.exec` governs execution in both runtimes. Supervised demonstrations remain meaningful.
- Network is denied or constrained by default where the backend supports it. Enabling general egress,
  binding credentials, and publishing are distinct approved actions.
- Output is size/time bounded and secret-redacted before persistence. Binary/large output becomes a
  storage artifact with a bounded preview.
- Significant lifecycle, publish, project promotion, and shipped outcomes feed Marina activity and
  Chronicle; raw stdout does not become Chronicle history.
- One entity cannot address, inspect, publish, resume, or stop another entity's sandbox.
- A crew uses the task owner's entity sandbox in v1 and retains Marina's single-writer policy.
  Concurrent per-actor filesystem views remain a later isolation phase, not a v1 claim.

## Delivery milestones

### M0 — plan and contract synchronization (this document)

- Make this the canonical direction; mark contradictory VMM-direct/per-session plans historical.
- Record the actual shipped baseline and Flywheel API gaps.

Exit: roadmap and integration docs point to one decision set.

### M1 — durable entity lifecycle in Marina — functional slice complete

Status: **complete** — durable credential-free bindings, startup reconciliation, explicit
unavailable state, single-flight creation, no-host-fallback coverage, one manager shared by MCP and
Code Mode, readiness reporting, and lifecycle commands have landed. Execution routing remains M2.

- Persist entity bindings; share one manager between MCP and Code Mode.
- Add reconciliation/adoption, lifecycle state machine, single-flight creation, and sanitized events.
- Add `code sandbox start|status|hibernate|resume|stop` and `code doctor` readiness.
- Add boot/unreachable/degraded-mode tests proving Flywheel is optional and host fallback cannot
  occur implicitly.

Exit: restart-safe one-entity/one-sandbox lifecycle with no Code Mode execution routing yet.

### M2 — sandbox-native Code Mode execution — functional slice complete

Status: **complete** — sessions persist an explicit local or Flywheel target, `WorkspaceGateway`
routes finite commands without fallback, exit status is recovered through an argument-safe audited
wrapper, typed event kinds are stored with command evidence, and deadlines abort the stream. Flywheel
binds stream cancellation to the exact remote process and waits for its backend stop attempt, so a
Marina timeout is cancellation rather than detach. Local mode is unchanged.

- Add `WorkspaceGateway` and `FlywheelWorkspaceRuntime.run()`.
- Add explicit local/sandbox target selection and sandbox-open command policy.
- Normalize streamed stdout/stderr/exit/timeout/truncation into `WorkspaceRunResult`.
- Add package install, arbitrary finite exec, cancellation, audit, and failure tests.

Exit: an entity can create a program, install dependencies, and run/verify it entirely in Flywheel;
host mode remains unchanged and the full existing suite stays green.

### M3 — project materialization — credential-free functional slice complete

Status: **functional slice complete for the credential-free public contract** — durable metadata, deterministic
guest paths, empty Git bootstrap, public
credential-free HTTPS clone, active-project cwd routing, restart recovery, live dirty-switch
protection, bounded diff inspection, bounded tracked-work patch export, and complete bounded archive
export/import with staged atomic promotion are implemented. Private Git remains a credential-broker
extension rather than an unsafe M3 fallback.

- Ship empty/bootstrap and public Git workflows, then private Git via credential broker.
- Add project metadata, deterministic guest paths, status/diff/export, and dirty-switch protection.
- Carry archive bytes over Flywheel's typed `Exec` byte stream with strict Marina-side bounds.

Exit: an entity can resume a real project across Marina/Flywheel restarts and safely export work.

### M4 — services and observation — functional slice complete

Status: **functional slice complete** — entity-owned services have durable IDs and restart recipes, execute in the
active guest project, retain bounded guest logs, support live status/stop/restart, declare ports, and
can publish/revoke through Flywheel. Hibernate records them stopped because process state does not
survive cold boot. Localhost HTTP probes now create bounded, redacted verification artifacts.
Guest-local Chromium screenshots are transferred as bounded typed bytes, PNG-validated, persisted as
artifacts, and cleaned from the guest. Images without Chromium fail closed with explicit remediation.

- Add managed background processes, restart recipes, bounded logs, publish/revoke, API probes, and
  browser/screenshot artifacts where appropriate.

Exit: `code run app` and `code verify` can launch and observe an application without host execution.

### M5 — production hardening and release evidence

M5 is now the active milestone and is divided into independently testable gates.

#### M5a — transfer integrity and project durability

Status: **implementation in progress** — bounded reads now require an authoritative successful
Flywheel process terminal event and carry observed SHA-256/byte-count evidence. Uploads are staged,
atomically renamed, and independently verified in the guest. Archive v1 enforces compressed,
expanded, member-count, per-member, compression-ratio, path, and regular-file/directory-only policy
before extraction. Project deletion and replacement-sandbox metadata reconciliation are scoped by
entity plus sandbox identity. Disk-full/live interruption evidence remains part of M5e.

- Add expanded-byte and member-count budgets before extraction; reject devices, FIFOs, sockets,
  absolute paths, traversal, and unsafe symlink/hardlink targets.
- Add SHA-256 plus declared/observed byte counts to every upload/download and require an authoritative
  successful process terminal event. Fail closed on missing/contradictory evidence.
- Make archive format/version explicit and test interruption, disk-full, cancellation, cleanup, and
  atomic promotion. Add a first-class Flywheel transfer RPC only if it materially improves this
  contract; keep Marina's product model provider-neutral.
- Add project delete/archive and stale-metadata reconciliation without risking another entity or a
  replacement sandbox.

Exit: malicious or interrupted transfers cannot escape, exhaust unbounded guest storage, silently
truncate, or mark incomplete work exported.

#### M5b — network and credential boundary

Status: **policy-visible, fail-closed foundation shipped** — Marina persists and reports the
provider-owned network profile and logical credential-binding schema without storing secret
material. Because Flywheel's public direct-sandbox API does not yet expose network-profile or
credential-broker binding, Marina refuses those mutations rather than claiming enforcement.
Service publication, the network expansion Marina can currently control, requires a matching
one-use approval and receives a finite lease.

- Implement the versioned broker in `sandbox-credential-broker.md` for private Git first, then
  package registries and model/cloud APIs. Persist only logical binding metadata.
- Enforce DNS/IP/redirect-aware egress at Flywheel's network boundary, including IPv4/IPv6 private,
  link-local, metadata, loopback, and rebinding cases. Marina URL parsing remains defense in depth.
- Make no-network/restricted/general profiles visible in `code sandbox status`; require explicit
  approval for profile expansion, credential binding, and publish.
- Add output/header/URL redaction fixtures and prove credentials never enter command arguments,
  process listings, Git config, logs, artifacts, DB exports, or model context.

Exit: private Git works without guest-visible upstream credentials, and network authority is
enforced below untrusted guest code rather than inferred from Marina-side validation.

#### M5c — managed-process correctness

Status: **functional lifecycle slice complete** — managed services persist Linux process birth
identity alongside PID. Status and stop re-read `/proc/<pid>/stat`; identity mismatch becomes
`unknown` and Marina refuses to signal the reused PID. Startup reconciliation marks previously
running services unknown until checked, logs remain bounded, probe history is durable, and published
services have automatically revoked leases. A future first-class Flywheel process handle can replace
this adapter without changing the Marina service model.

- Replace PID-only ownership with a Flywheel process handle or `(pid, start identity)` verified by a
  supervisor. Stop/restart must never signal an unrelated reused PID.
- Reconcile services after Marina restart and sandbox resume; report `unknown` until identity is
  proven. Preserve explicit restart recipes but never auto-restart without policy.
- Add command-level cancellation/status for finite executions, bounded log rotation, publication
  expiry, automatic revoke on stop/hibernate, and health-probe history.

Exit: process lifecycle remains correct across PID reuse, process exit, Marina restart, Flywheel
restart, hibernation, and publication teardown.

#### M5d — resource operations and civic policy

- Add per-entity CPU/memory/disk/process/time quotas, admission control, idle hibernation, absolute
  TTLs, and standing-neutral v1 defaults. Measure before introducing standing-weighted capacity.
- Add operator inventory, force-reconcile, hibernate, revoke, export-before-delete guidance, and
  orphan/stale-resource reclamation with dry-run support.
- Emit metrics and alerts for creation latency/failure, active/hibernated count, execution duration,
  timeout/cancellation, transfer bytes/failures, disk pressure, publish exposure, and reconciliation.
- Define activity versus Chronicle events and retention; raw stdout remains out of Chronicle.

Exit: operators can bound, observe, reconcile, and safely reclaim every sandbox resource.

#### M5e — live compatibility and release gate

- Build a repeatable live suite against a separately started Flywheel: create → project bootstrap and
  clone → install → finite run → service/probe/screenshot/publish/revoke → archive round trip →
  hibernate/resume → stop.
- Exercise supported Flywheel backends and explicitly record unsupported capability degradation.
- Test Marina absent, Flywheel absent, unreachable service, token expiry, stream disconnect, timeout,
  restart ordering, stale registry rows, disk full, and partial transfer.
- Verify composed and separate deployments behave identically over the public API. Keep both products'
  standalone suites mandatory and independent.
- Add operator/user quickstarts and `code doctor` remediation for every failed prerequisite.

Exit: the full matrix is repeatable in CI or a documented release environment with retained evidence;
no known failure mode silently falls back, loses unexported work, leaks authority, or leaves exposure.

Only after M5 evidence should we revisit extra sandboxes per entity or per-actor crew views.

## Independence acceptance tests

Before every integration milestone is considered complete:

1. Run Marina's full suite with no Flywheel environment variables or process; behavior outside the
   new sandbox surface must be unchanged.
2. Run Flywheel's full suite with no Marina process, credentials, fixtures, or packages.
3. Start Marina with an unreachable Flywheel endpoint; readiness must degrade, local mode must work,
   and sandbox-selected execution must fail before any host process is spawned.
4. Exercise the same Marina integration against a separately started Flywheel and a convenience
   composed deployment; observable behavior must match.
5. Inspect both dependency graphs and persistence migrations: neither may acquire the other's
   internal package or database schema.

## Failure and recovery requirements

- Flywheel unavailable: report sandbox unavailable; never execute on the host implicitly.
- Capability expiry: refresh once; on authorization failure stop and surface remediation, not tokens.
- Stream disconnect: mark outcome unknown, query/reconcile when supported, and avoid blind re-exec of
  non-idempotent commands.
- Marina crash: reconcile persisted bindings before accepting lifecycle mutations.
- Flywheel crash: adopt registry state; hibernated disks remain resumable where supported.
- Partial project import: stage into a temporary guest path, verify, then atomically rename.
- Stop failure: retain the binding in an error state so operators can retry; never forget a possibly
  live sandbox.

## Deferred—not forgotten

- Per-task/per-session sandboxes and concurrent sandboxes per entity.
- Per-actor crew worktrees/overlays and promotion queues.
- Direct host-directory mounts and live bidirectional synchronization.
- Marina-managed VMM drivers, golden images, and guest protocols (Flywheel owns these).
- Warm pools, snapshots with RAM, cross-world fleet scheduling, and IDE/ACP terminal streaming.

These are extensions of the entity-workspace model, not prerequisites for the first useful system.
