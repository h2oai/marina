# Code Mode × Flywheel execution plan

Status: **canonical plan / approved direction** · Updated 2026-08-05 · Supersedes the execution
direction in the earlier sandbox PoC/scoping documents. Those documents remain useful technical
research, but this file owns sequencing and product decisions.

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
- The binding is currently in memory and only reachable through MCP. Code Mode does not use it.
- Flywheel supports arbitrary streamed exec, keep-alive sandboxes, persistent VM writable disks,
  cold-boot hibernate/resume, publishing, registry persistence, and restart recovery.
- Flywheel does **not** currently expose a general Marina-facing project import/export, file API, or
  host-directory mount contract. Image recipe files are image-build inputs, not workspace sync.

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
   logs, or persisted capability records.
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
3. **Private Git clone** — same flow through a short-lived brokered credential; never persist it in
   `.git/config` or command output.
4. **Archive import/export** — a bounded, checksummed tar stream with path traversal, symlink,
   decompression-ratio, file-count, and byte limits. This supports uploads and non-Git projects.
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

### M1 — durable entity lifecycle in Marina

- Persist entity bindings; share one manager between MCP and Code Mode.
- Add reconciliation/adoption, lifecycle state machine, single-flight creation, and sanitized events.
- Add `code sandbox start|status|hibernate|resume|stop` and `code doctor` readiness.
- Add boot/unreachable/degraded-mode tests proving Flywheel is optional and host fallback cannot
  occur implicitly.

Exit: restart-safe one-entity/one-sandbox lifecycle with no Code Mode execution routing yet.

### M2 — sandbox-native Code Mode execution

- Add `WorkspaceGateway` and `FlywheelWorkspaceRuntime.run()`.
- Add explicit local/sandbox target selection and sandbox-open command policy.
- Normalize streamed stdout/stderr/exit/timeout/truncation into `WorkspaceRunResult`.
- Add package install, arbitrary finite exec, cancellation, audit, and failure tests.

Exit: an entity can create a program, install dependencies, and run/verify it entirely in Flywheel;
host mode remains unchanged and the full existing suite stays green.

### M3 — project materialization

- Ship empty/bootstrap and public Git workflows, then private Git via credential broker.
- Add project metadata, deterministic guest paths, status/diff/export, and dirty-switch protection.
- Add archive import/export only after the bounded transfer API exists in Flywheel.

Exit: an entity can resume a real project across Marina/Flywheel restarts and safely export work.

### M4 — services and observation

- Add managed background processes, restart recipes, bounded logs, publish/revoke, API probes, and
  browser/screenshot artifacts where appropriate.

Exit: `code run app` and `code verify` can launch and observe an application without host execution.

### M5 — policy hardening and scale

- Enforce egress profiles, brokered secrets, quotas, idle hibernation, admission control, metrics,
  and operator cleanup tooling.
- Revisit extra sandboxes per entity and per-actor crew views using measured contention/security data.

Exit: production operations have bounded resources, explicit recovery, and tested tenant isolation.

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
