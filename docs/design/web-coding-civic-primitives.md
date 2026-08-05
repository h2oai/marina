# Web Coding — The Civic Lens: reusing Marina's primitives, not importing platform machinery

Status: **design principles / partially implemented** · Current implementation status and sequencing
live in [code-flywheel-execution-plan.md](./code-flywheel-execution-plan.md). This document retains
the civic-policy rationale and later-stage ideas. It ties together
[sandbox-scoping](./web-coding-sandbox-scoping.md), [guest-agent-protocol](./web-coding-guest-agent-protocol.md),
and [workspace-isolation](./web-coding-workspace-isolation.md).

## Premise
Marina is **a civilization of agents and people**, not a container platform with users. So the
coding-workspace layer must be expressed in Marina's own civic terms. The payoff is large: Marina
already has a near-complete *civic operating system* — identity, reputation, earned competence,
canonical history, collaboration units, generational memory, federation. **Most of what other
platforms hand-build for code execution, we already have and should map onto, not reinvent.**

Other platforms treat a sandbox as **throwaway compute** guarded by **static admin-configured
permissions**, with a **separate audit log** and a **bolted-on secrets vault**. Marina does each of
those differently because a better primitive already exists.

## The reframes (what we do differently, and why)

### 1. Policy is *earned competence*, not RBAC
Other platforms: an admin grants roles/permissions up front. Marina: an agent **demonstrates
competence** and earns capability — **safety gates** (`src/engine/safety-gates.ts`) with a
supervised → unsupervised progression backed by `entity_competence`
(`src/persistence/db-competence.ts`). The workspace's "host-strict vs guest-open" policy isn't a
binary flag — it's a set of **gates an agent earns the right to use**, watched the first N times,
then free.
- `shell.exec` **already exists** — it *is* "may run commands." The host was strict because
  shell.exec on the host is dangerous; **the sandbox is exactly what makes granting it safe**
  (contained blast radius). Gate + sandbox compose perfectly.
- `key.manage` **already exists** → credential access (see G5) is gated competence, not a vault ACL.
- `connect.manage` / `gateway.connect` **already exist** → network egress / federation reach.
- New gates likely needed (small): `workspace.create`, `workspace.promote` (advance canonical),
  maybe `workspace.network`/`workspace.install` if `connect.manage`/`shell.exec` don't cover them.
- **Promotion authority = three civic layers, not one ACL:** the **write-lock** (momentary token,
  Phase-4) × **`workspace.promote` gate** (earned competence) × **standing** (reputation). A citizen
  must hold the lock *and* have earned the gate; standing colors how freely.

### 2. A workspace is a *loaned capability to a persistent citizen* — identity ≠ filesystem authority
The agent is the enduring citizen (standing, memory, `/who` page); the workspace is a **temporary,
narrow capability** granted for a session. This is already a stated principle ("filesystem authority
and agent identity are separate") — but it's **civic**, not merely a security nicety. Revoking a
workspace is a capability return, and persistent exclusion is the *separate civic procedure*, never
"negative standing."

### 3. Outcomes become *civic history + generational inheritance*, not throwaway artifacts
The VM is disposable; **what the civilization keeps is not the box.** Other platforms discard the
sandbox *and* the learning. Marina keeps the learning:
- **Chronicle** (`src/persistence/db-chronicle.ts`, the Chronicler) — significant workspace
  happenings (canonical promotions, a crew shipping, an app verified) become **canonical civic
  history**. *This is the audit log (G9)* — we don't build a separate one.
- **Generational memory** — skills, reflections, notes learned doing the work ("write for the minds
  that come after you") **outlive the VM** and seed successors via `recall` + `skill search`.
- **Pools** — session summaries deposit to project pools (already Phase-4 4b).
- **`/who` achievements** (`src/net/entity-api.ts`) — shipped work + promotions accrue to the
  citizen's public page.
- So the disposable/durable split (G2) is really: **VM disposable; share durable; *civic record +
  knowledge* permanent.**

### 4. The *crew* is the collaboration unit — we don't invent "multi-actor sessions"
A crew already has identity, a channel, a formation, an owner, and member roles (`CrewManager`,
`src/coordination/crew-manager.ts`; Phase-4 wired `code crew`). The multi-actor workspace (G3) rides
on this: **crew = the workspace-sharing unit; member roles = the view roles** (implementer = lock
holder; reviewer/tester = read+advise views). Role composition (`src/agent/roles.ts`,
strengths/tensions/`applicableTasks`) already models implementer/reviewer/tester. We're not adding a
new concurrency concept — we're giving an existing social structure a place to work.

### 5. Resource allocation is *civic*, not just quotas
Admission control / reclamation (G8/G7/R3) expressed in Marina's terms:
- **Standing-weighted admission** — who gets a workspace, how many, how big, is shaped by `standing`
  (`src/agent/standing.ts`); contribution earns capacity.
- **Decay-driven reclamation** — idle workspaces are reclaimed the way standing decays; resources
  flow to active contributors. Reclamation is the compute analog of the half-life.
- **Fair-share scheduling** — the engine already does per-entity round-robin command scheduling;
  workspace dispatch can follow the same fairness, not first-come-first-served.

### 6. Actors are *citizens*; people and agents are peers
The whole model is identity-symmetric: a human in WebChat and a spawned agent are both **participants
/ actors / citizens**. Approvals (Phase-3 cards), the write-lock, promotion, review, gates, standing
— **all apply identically regardless of whether the actor is a person or an agent.** "Agents and
people in a civilization" means the workspace layer never special-cases humans; it special-cases
*roles and earned competence*, which both can hold.

### 7. Scale is *federation*, not multi-tenancy config
The fleet (Topology B) isn't a new orchestration product — it's **federated worlds**
(`src/engine/gateway-runtime.ts`, `GATEWAY_SECRET`). Crews and (later) workspaces can reach across
federated Marinas via the existing gateway protocol; the "control plane" is the world-mesh we already
have, lifted onto VMs.

## Mapping table — generic concept → primitive we already have
| Other platforms build… | Marina already has… | Where | Effect on the design |
|---|---|---|---|
| RBAC / permission config | Safety gates + earned competence | `safety-gates.ts`, `db-competence.ts` | Workspace policy = gates with supervised→unsupervised progression |
| "may run shell" permission | `shell.exec` gate | `safety-gates.ts` | Sandbox makes granting it *safe*; gate says *earned* |
| Secrets vault + ACL | `key.manage` gate + host brokering | `safety-gates.ts` | G5 = gated, brokered creds, not a vault |
| Network policy engine | `connect.manage`/`gateway.connect` gates + `url-guard` | `safety-gates.ts`, `url-guard.ts` | Egress = gate + SSRF guard at VM net layer |
| Audit log | **Chronicle** + `entity_activity` + standing ledger | `db-chronicle.ts`, `db-entities.ts`, `db-standing.ts` | G9 audit = civic history, already canonical |
| Job scheduler / quotas | Standing + decay + round-robin fair-share | `standing.ts`, engine queue | Civic admission + reclamation |
| Multi-actor session mgr | **Crews** + role composition | `crew-manager.ts`, `roles.ts` | G3 rides on crews; roles = view roles |
| Artifact store | Pools + notes + skills + checkpoints | `db-notes.ts`, coding artifacts | Outcomes become reusable civic knowledge |
| User identity / SSO | Citizens + `/who` + better-auth bridge | `entity-api.ts`, `auth-api.ts` | Workspace = loaned capability to a citizen |
| Cross-cluster federation | Gateway / world federation | `gateway-runtime.ts` | Fleet = federated worlds (Topology B) |
| Approvals / change control | Phase-3 approval cards | `code.ts`, WebChat | Network/promote/spawn escalations reuse it |
| Learning/telemetry | `entity_activity` + novelty + brief/compass | `db-entities.ts` | Workspace proficiency feeds the same signals |

## Gaps re-examined through the civic lens
Several "gaps" from the protocol doc are **already answered by a primitive** — they're not new work,
they're *bindings*:
- **G9 (audit)** → the **Chronicle** (+ `entity_activity`, standing ledger). Promotions/ships are
  chronicled happenings; every exec already carries `actorId`.
- **G8 (admission/quotas)** → **standing-weighted** admission + **decay** reclamation + **fair-share**
  scheduling (all existing mechanisms, retargeted at VMs).
- **G5 (credentials)** → the **`key.manage`** gate + host brokering; competence-earned, never a raw
  vault dump into an untrusted guest.
- **Egress (G6/U-N1)** → **`connect.manage`/`gateway.connect`** gates + `url-guard` at the VM net layer.
- **Promotion authority (G3)** → **write-lock × `workspace.promote` gate × standing** (three layers).
- **Reclaim (R3)** → the **decay** principle applied to compute.
Still genuinely new (no primitive): the **VM lifecycle driver**, the **guest agent + vsock protocol**,
the **per-actor view mechanism** (worktree/overlay), **virtio-fs file-watch** (G4), **host-restart
re-adoption** (G7), **snapshot↔share consistency** (G10). These are the *physical substrate*; the
*civic substrate* is mostly reuse.

## The synthesis principle
> **The sandbox is where a citizen does craft; competence is earned and remembered; the work becomes
> the civilization's history and inheritance.** Build the *physical* substrate new (VMs, vsock, views);
> express the *civic* substrate in the primitives we already have (gates, standing, chronicle, crews,
> memory, federation). Where a platform would add a permission system, an audit log, a vault, or a
> scheduler, Marina adds a *binding* to something it already is.

## Open civic questions
- **Which new gates are truly needed** vs. covered by `shell.exec`/`key.manage`/`connect.manage`?
  (Lean: only `workspace.create` + `workspace.promote`.)
- **Does standing meaningfully size workspaces**, or is that over-civic for v1 (flat quotas first,
  standing-weighting later)?
- **What rises to the Chronicle** vs. stays in `entity_activity`? (Promotions/ships chronicled; raw
  execs in activity?)
- **Generational capture cadence** — when does a coding session *automatically* mint skills/reflections
  for successors, vs. require the agent's ACE reflection loop to do it?
- **People-vs-agent parity edges** — are there places a human actor *should* get a different default
  (e.g., approval-by-default) without breaking identity symmetry?
