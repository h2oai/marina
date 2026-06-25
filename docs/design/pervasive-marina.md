# Pervasive Marina — a substrate you use as little or as much as you want

Status: **north star.** Not a single feature — the direction the seams are already
bending toward. This doc names the end state, shows what already exists, and
sequences the gaps so each step is shippable on its own.

## The vision (in the user's words)
> Launch a Marina in any folder. It federates with other Marinas. You start it in
> a directory like `claude`/`codex` — but you can also move to sandboxes or
> arbitrary filesystems, all from within any Marina session. It is pervasive. You
> use as little or as much of Marina as you need, at any time.

The shape: a **spectrum**, not a product tier.

```
one agent, one folder, ephemeral   ←——————————————→   a federated civilization
  `marina .` (like claude)            persistent world      worlds across hosts,
  code mode, no world overhead        + memory + civics      sandboxes, filesystems
```

You opt in to depth. The minimum is "an agent in this directory." The maximum is
"a federation of persistent worlds." Same substrate; you pay only for what you use.

## The two load-bearing seams (already built)
The vision is reachable because the hard abstractions already exist:

1. **`WorkspaceRuntime`** (`src/coding/local-workspace.ts`) — the filesystem +
   exec surface a coding session works against, behind an interface
   (`WorkspaceFiles` + `WorkspaceExec`). `LocalWorkspace` is the host impl.
   **This is the "arbitrary filesystems / sandboxes" seam.** A `SandboxWorkspace`
   (vfkit/crosvm) or `RemoteWorkspace` (over the gateway / SSH / FUSE) implements
   the same contract — code mode doesn't change. The 6 `web-coding-sandbox-*`
   design docs are the plan for the sandboxed impl.
2. **The code-mode driver** (`coding_sessions.driver`, `doCode`) — single agent →
   crew → multi-agent/multi-backend, swappable per session. **This is the "as
   little or as much" seam for *compute*** (one model vs many, one host vs many).

Plus the supporting pieces: **gateway federation** (`gateway-runtime.ts`),
**self-proxy + compat/ACP** (`marina/default`, `/v1/*`, ACP stdio — Marina as a
model endpoint *and* an editor agent), **worlds** (`MARINA_WORLD`, from `empty`
to `default`), and the **civic substrate** you bolt on only when you want
persistence/memory/standing.

## The gaps, sequenced (each independently shippable)
1. ✅ **Zero-config `marina <dir>` ("claude in a folder") — first cut shipped.**
   `bun run code [dir]` (`scripts/code.ts`) boots an ephemeral folder-scoped
   instance (empty world, no room agents, throwaway DB, local user = operator via
   `MARINA_ADMINS`) and drops straight into agentic Code Mode for that directory.
   Next: bind it to the `marina` bin as `marina code <dir>`, and an option to
   persist/resume per-folder sessions instead of ephemeral.
2. **`SandboxWorkspace` (the FS/exec isolation impl).** Implement the
   `WorkspaceRuntime` contract over a microVM (vfkit on macOS, crosvm on
   Linux/WSL2) with a virtio-fs/FUSE share. Then `code workspace use sandbox:<id>`
   moves a live session into isolation with no other code change. (Design: the 6
   `docs/design/web-coding-*` docs.)
3. **`RemoteWorkspace` (move to arbitrary filesystems from within a session).** The
   same contract proxied to another host — over the gateway to a peer Marina, or
   SSH/agent. This is where "move between marinas from a session" + "arbitrary
   filesystems" meet: a session whose workspace lives elsewhere, driven from here.
4. **Federation hardening.** `GATEWAY_SECRET` today authenticates the *handshake*,
   not the relayed actions (see the Security notes / the earlier audit). A real
   cross-instance trust boundary needs a dedicated authenticated transport before
   workspaces/sessions can safely span instances.
5. **Capability negotiation ("use as little as you need").** A session/instance
   declares which layers it wants (workspace-only · +memory · +civics · +federation)
   so a folder-scoped agent stays light while a civilization opts into everything.

## The throughline
Every recent change is a step along this line, not a detour:
- **Agentic Code Mode + driver seam** → the "claude in a folder" experience + the
  compute spectrum.
- **Liveness/latency observability** → you can see a pervasive fleet's health.
- **Dashboard spawn authz + origin grouping** → safe, legible multi-agent populations.
- **Backup/export covering the civic substrate** → instances are portable (a
  prerequisite for moving/federating them).

So the work isn't "build pervasiveness" — it's keep widening these seams until the
spectrum is continuous. Start at gap #1 (the front door) or #3 (the seam that most
directly delivers "move to arbitrary filesystems from within a session").
