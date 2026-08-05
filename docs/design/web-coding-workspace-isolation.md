# Web Coding — Workspace Isolation Model (G3) — proposal, no code

Status: **deferred design input** · The v1 decision is one sandbox per entity with Marina's existing
single-writer policy. Per-actor views are deferred to M5 of the canonical
[Code Mode × Flywheel plan](./code-flywheel-execution-plan.md). This document resolves the later
crew-isolation gap **G3** from
[web-coding-guest-agent-protocol.md](./web-coding-guest-agent-protocol.md) §6.6 · Reconciles the
Phase-4 write-lock ([web-coding-phase4-autonomy.md](./web-coding-phase4-autonomy.md)) and the
long-deferred "worktree policy" with sandboxing (Decisions #5–#7 in
[web-coding-sandbox-scoping.md](./web-coding-sandbox-scoping.md)).

This is a complicated platform; the goal of this doc is a model robust enough to commit to.

## 1. Problem (precise)
A crew session can have **multiple actors** (implementer/reviewer/tester) issuing exec into **one
shared workspace**, and even a single actor can run **concurrent processes** (build + test). Exec
runs *in the guest* and **writes the workspace** (coverage, snapshots, build dirs, accidental
edits). The Phase-4 write-lock was defined only on **patch-apply**, not arbitrary exec — so today
a tester's `code run test` would clobber the implementer's WIP, and there is no model for "whose
changes are whose."

**Scope of the requirement:**
- **In scope:** *cross-actor* isolation — actor A's side-effects must not corrupt actor B's view
  or the integration state.
- **Out of scope (normal dev semantics):** *intra-actor* concurrency — if one actor runs two
  builds in their own view and they race, that's the same as on any dev machine; not our problem.

## 2. Invariants the solution must hold
1. **One canonical, single-writer integration state** per session ("canonical"). It advances
   **only** by an explicit, write-lock'd promotion — never by a side-effect of exec.
2. **Every actor works in an isolated view.** Their writes (artifacts *and* edits) are private
   until promoted.
3. **Reviewers/testers see the real code under review** — views are derived from canonical
   revisions, not divergent forks. (Pure per-actor forks would defeat review.)
4. **Everything durable lives on the host share** (G2): canonical and per-actor views persist; the
   VM stays disposable.
5. **The untrusted guest never runs integration logic.** Worktree/merge/promotion are **host-side**
   git ops on the share (consistent with the protocol's host/guest split); the guest only execs
   against its mounted view.
6. **Solo degrades to zero overhead.** One participant ⇒ one view ⇒ canonical directly; the
   machinery only engages when there's actually a crew.

## 3. The model — canonical + per-actor views + promotion under the lock
- **Canonical** = the session's integration working state on the durable share. Advances in
  discrete **revisions**.
- **Per-actor view** = an isolated working copy derived from a canonical revision; the actor's exec
  runs against it; side-effects stay private.
- **Promotion** = the write-lock holder pushes their view's *source* changes into a new canonical
  revision. This **is** the existing approval + write-lock + patch-apply flow — unchanged.
- **Refresh** = when canonical advances, other actors re-derive their view onto the new revision
  (clean for reviewers/testers who only have artifacts; a 3-way merge if they made source edits).

**We already have the primitives:**
- Phase-3 **`code checkpoint`** = a canonical **revision** (the shared point reviewers refresh to).
- Phase-4 **write-lock + patch-apply** = **promotion** (who may advance canonical). G3 just
  redefines the lock's meaning from "may apply a patch" to the cleaner "**may advance canonical**."
- So G3 is **mostly additive**: add per-actor views; stop pointing non-writers at canonical. The
  promotion/checkpoint/lock machinery is reused as-is.

**What this fixes:** non-writer exec is **no longer blocked or dangerous** — Dave the tester runs
freely in *his* view; nothing he does touches Bob's WIP or canonical. The lock governs *promotion*,
not raw exec. The S3 tension disappears.

## 4. Mechanism candidates (host-side, on the share)
| Mechanism | How a view is made | Isolates | Pros | Cons |
|---|---|---|---|---|
| **Git worktree per actor** *(leading)* | `git worktree add views/<actor>` on the share; shared object store | source (tracked) + artifacts via gitignored per-worktree dirs | Battle-tested merge/conflict; no kernel tricks; everything plain dirs on the share; promotion = host-side git merge/cherry-pick under the lock; reuses checkpoints (WIP commits) | Workspace must be a git repo (we `git init` roots anyway); shared `.git` needs serialized writes (the lock already serializes promotion); deps/`node_modules` duplicated per worktree (mitigate with CoW clone below) |
| **OverlayFS CoW per actor** | lower=canonical (ro), upper=per-actor | *all* writes (incl. untracked) at the FS layer | Captures everything, even non-git side-effects; works for non-git workspaces | **upperdir can't be virtio-fs/FUSE** → needs a per-actor ext4 **disk image on the share** mounted via virtio-blk (extra moving part); promotion delta must be filtered to *source* (raw upper includes `node_modules`) → still want git to decide what's promotable |
| **Host CoW full clone** (APFS `clonefile` / btrfs/zfs reflink) | reflink-copy canonical → per-actor dir | all writes, full independence | Cheap on CoW host FS; dead simple in-guest (plain dir) | Host-FS-dependent (not all hosts CoW); merge is still a diff/patch problem (use git on top) |

**Recommendation:** lead with **git worktree per actor** — it's the most robust, reuses git's
merge machinery and our checkpoint primitive, keeps the guest out of integration logic, and stores
everything as plain dirs on the share. Use **host CoW clone** as an accelerator to make worktree/dep
duplication cheap where the host FS supports it. Keep **OverlayFS** as the fallback for **non-git**
workspaces or when full-FS (untracked-inclusive) isolation is required — accepting the
disk-image-upper nuance. **Spike all three over virtio-fs early** (esp. overlayfs upperdir + git
`.git` contention) before committing.

## 5. Topology — where the views live (ties to trust)
- **One VM, multiple in-guest views (default for a crew).** Crew members are *collaborators* in one
  session; the strong boundary is VM↔host. Each actor's worktree is mounted/`cwd`'d in the one VM.
  Cheapest; acceptable intra-crew trust.
- **VM-per-actor, shared canonical (high isolation).** When actors are *different trust domains*
  (different humans/orgs), give each their own VM with their view mounted; canonical stays on the
  host. Stronger, costlier. Selectable per session by policy.
- **Solo / per-participant (Decision #5).** One actor → its view *is* canonical (or a single
  trivial worktree). No crew machinery.

## 6. How it handles the scenarios
- **S3 (tester writes during review):** Dave execs in his worktree; coverage/snapshots land in his
  gitignored dirs; Bob's WIP and canonical untouched. No lock needed for Dave to test. ✓
- **S4 (concurrent processes, one actor):** they share that actor's view — intra-actor races are
  normal dev semantics, out of scope. Cross-actor still isolated. ✓
- **Review of live WIP:** the implementer `code checkpoint`s (a WIP commit); reviewers/testers
  **refresh** to that revision and see exactly that code. Checkpoints are the shared review points. ✓
- **Promotion:** implementer (lock holder) promotes their branch → new canonical revision (host-side
  git merge under the lock, via the existing patch-apply/approval flow). ✓
- **Lock transfer (`code writer <agent>`):** the new holder's view becomes the promotion source;
  their WIP can now be promoted. ✓
- **Refresh conflict:** rare (only if a non-writer edited source); surfaced as a git 3-way merge
  through Marina's existing conflict/approval UX. ✓

## 7. Lifecycle of a view
`create` (derive from canonical revision, host-side git/CoW) → `mount` into the VM (virtio-fs) →
`exec` (guest, actor's cwd) → `checkpoint` (optional WIP revision, shareable) → `promote`
(write-lock holder only → new canonical revision) → `refresh` (re-derive onto latest canonical) →
`discard`/`reclaim` (view persists on the share until session end or idle reclaim; canonical always
persists). All git/merge steps are **host-side**; the guest only execs.

## 8. Reconciliation with the rest of the plan
- **Phase-4 write-lock:** redefined from "may apply a patch" → "**may advance canonical**" (a strict
  superset; existing `enforceWriteLock`, `code writer`, `code handoff to` semantics carry over). Non-
  writer exec is *no longer gated* — the view makes it safe.
- **Phase-3 checkpoint/revert:** become the canonical **revision** primitive (review points + refresh
  targets). Revert = move canonical to a prior revision.
- **Decision #5 (per-participant workspace):** solo path = canonical-direct, zero overhead. Crew =
  per-actor views over a shared canonical.
- **G1/G2 (provisioning/persistence):** canonical is seeded at provisioning (G1) and is the durable
  truth on the share (G2); views are derived dirs on the same share (persist) and the VM is disposable.
- **G5 (credential brokering) & G9 (audit):** promotions are host-side and carry `actorId` → a clean
  audit trail of who advanced canonical (ties to standing); guest never holds integration creds.
- **Protocol impact (small):** the vsock protocol gains *nothing structural* — views are just
  different mount/cwd targets the host assigns per actor at `BindSession`/exec. All worktree/merge
  logic is host-side. (Optional later: a host→guest `FilesChanged` hint on refresh, i.e. gap G4.)

## 9. Open questions / spikes before committing
- **Spike:** git-worktree vs overlayfs vs CoW-clone **over virtio-fs** — perf, `.git` contention,
  overlayfs-upper-on-disk-image, APFS/btrfs reflink availability per host.
- **Dep sharing:** `node_modules`/build caches duplicated per worktree — CoW clone, a shared
  read-only dep cache, or per-actor and accept the cost?
- **Granularity of "promotable":** strictly git-tracked source (clean), or allow promoting selected
  untracked files? Lean git-tracked-only.
- **Auto-checkpoint cadence:** does the host auto-snapshot the writer's WIP so reviewers always have
  a fresh revision, or only on explicit `code checkpoint`?
- **Refresh policy:** auto-refresh non-writers on every promotion, or on demand (avoid yanking the
  ground out from a running test)?
- **VM-per-actor trigger:** what policy signal flips a crew from one-VM-multi-view to VM-per-actor
  (trust domain, operator setting, standing)?
