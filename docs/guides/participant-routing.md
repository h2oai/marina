# Participant routing

Marina can register external participants, retain their published output, queue directed messages,
and connect them to its existing conversations. Participants can be coding agents, services, humans,
CI jobs, or other clients. The protocol does not prescribe a model, repository, terminal, or participant
count. Several participants can share one authenticated Marina account without replacing its world
connection.

An optional local supervisor launches Claude Code, Codex and pi and captures their native output in the
dashboard. The generic routing API remains available to arbitrary clients. Registering a participant
alone does not capture or take over an existing terminal. Marina's existing agents, chat, commands,
tasks, memory, and Canvas continue to operate normally.

## Work from the terminal

Run `marina --agent claude`, `marina --agent codex`, or `marina --agent pi` in a project
to use the local supervisor from the normal coding terminal. `/spawn` adds a worker,
`/use` switches targets, and `/dashboard` opens the authenticated Streams workspace.
See [the coding guide](coding.md#start-in-your-project-folder) for workspace isolation,
saved harnesses and shutdown behavior. The standalone `marina supervise` and generic
`marina route` interfaces below remain available.

## Work from the dashboard

Participant output can also be composed with coding activity, task evidence and world events in
[published panels](published-panels.md). A Coding desk's optional participant view uses the same
routing identity and delivery receipts as Streams. Reviewed messages require an owned sender;
runtime controls retain their ownership and gate checks. Publishing or closing a panel neither
registers nor stops a participant. Use repeated Streams tiles for independent conversation drafts.

Install and authenticate the native agent CLIs you want to use, then start Marina and authenticate a
world account. From your Marina checkout:

```sh
bun run scripts/marina.ts connect Alice -c "look"
bun run scripts/marina.ts supervise --name Alice --root /absolute/path/to/project
```

Keep the supervisor running. Open **Workspace → Streams**, select **Local agents**, choose an installed
agent type, enter a name and task, and click **Launch agent**. Repeat for as many participants as your
machine and provider accounts support. Select an agent to read its output, send follow-up instructions,
interrupt its turn, stop its process, or answer a native permission/question request. Pending prompts
wait while an agent is busy; approval, interrupt and stop requests have priority.

The supervisor discovers available executables from `PATH`. Its adapter registry is independent of the
participant protocol; additional adapter types do not require a different transport or dashboard.
The implemented adapters use Claude Code's official Agent SDK, Codex app-server, and pi RPC.
An optional model field selects a native model; leaving it empty uses the agent's default.

Each launch defaults to an isolated **Git worktree at committed HEAD**. Uncommitted source changes are
not copied. An explicit **Shared project directory** choice supports non-Git projects and coordinated
work in one directory. Launch directories must resolve inside the configured root, including through
symlinks. Worktrees are retained after stopping so you can review their changes; no automatic merge or
deletion occurs. The stream records the actual directory and native session ID.

The supervisor is an explicit local host execution service, not a container sandbox. The launch root
restricts workspace selection; it does not sandbox native tools. Claude retains user/project settings
with normal permission prompts. Codex starts with workspace-write sandboxing and on-request approvals.
pi retains its settings and extensions; its permission behavior depends on those extensions. Supported
native requests appear as **Allow once / Decline** or an answer form. For Claude and Codex structured
questions, the form asks for JSON keyed by the question text or ID shown in the request. Unsupported
Codex approval methods fail closed and publish an `approval.unsupported` event.

Runtime controls require the participant owner's account and Marina's existing `code.exec` gate;
launch also requires `agent.spawn`. Ordinary messages cannot masquerade as runtime controls.
Agents receive `MARINA_URL`, `MARINA_TOKEN` and `MARINA_SESSION_ID` plus CLI coordination instructions.
With supervised residents off (the default) these are the operator's existing account credentials,
not reduced per-agent credentials. Treat managed agents as programs running under that local user and
account.

### Supervised residents (experimental)

With `MARINA_SUPERVISED_RESIDENTS=on` on the server **and** in the supervisor's environment, every
launched agent is its own world account instead of acting through the operator's:

- **Enrolment.** Between joining its run session and starting the native process, the supervisor
  calls `POST /api/routing/residents`. The caller must be a person (an agent account is refused) and
  pass its own `agent.spawn` gate. One transaction saves an agent config with `spawned_by` = the
  caller, `runtime` = `supervised` and `vendor` = the adapter id, creates the owned agent principal,
  binds the run session, and issues a workload credential (scope `world:connect`, at most 24 hours).
  The credential is returned once; the server stores only its hash. Owner, lineage and challenge
  routing resolve through the same `spawned_by` chain as any spawned agent.
- **Supervision credential.** At start the supervisor exchanges your world session for its own
  routing credential (`POST /api/routing/supervision`; a person only, at most 24 hours, renewed at
  80 % of its lifetime, revoked when the supervisor stops). Marina keeps one world session per
  account, so logging in again as yourself — `marina connect <you>` in another terminal, the
  dashboard — replaces your session; the supervisor keeps running on its credential and can still
  renew and revoke its residents. The credential is accepted only under `/api/routing/`: it is not a
  world session (no login, reconnect, command or challenge), and it cannot send controls, messages
  or channel posts, which come from your own session. A renewal that fails is retried while the
  credential is live and never falls back to your session. A server with residents off (or an older
  server) offers no endpoint, and the supervisor keeps using your session token as before.
- **Names.** A launch may ask for a name (`name` in the launch control); otherwise the server picks a
  pronounceable word-list name that is free in the world and never contains the vendor. Relaunching
  or resuming your own resident reuses its account. A name held by another account — a person, an
  in-process agent, or someone else's resident, in any letter case — is refused.
- **Presence.** The supervisor holds one world connection per resident, as an `agent` principal with
  the resident's credential. The resident arrives in your current room (or the `room` named in the
  launch control) and moves like anyone else. It is an agent: it never answers a held action, is
  never made sovereign under the local profile, and keeps its stored rank. Rosters show it as
  `Wren [claude]` (`who`, `look`, `agent list`, `orient`, the dashboard entity card); commands take
  the plain name.
- **Credential.** The native process holds no world credential at all. Every inherited variable
  carrying the operator's credential is dropped and `MARINA_TOKEN` is removed; instead
  `MARINA_RELAY_SOCKET` names the resident's command relay, a Unix socket the supervisor opens in a
  fresh `0700` directory under `XDG_RUNTIME_DIR` (else `~/.marina/relay`; never the temp directory,
  which agent sandboxes replace), the socket itself `0600`. Any process running as your OS user can
  use it, the same reach that user already has over the agent's files and process. Inside the
  process, `marina connect -c "<command>"` (or a pipe of commands) sends each world command over the
  relay; it runs on the resident's own held connection through the normal dispatch path — rank,
  gates, challenges and audit apply as the resident — and prints the reply. A name argument is
  optional and ignored there. A sandbox that refuses every socket connection (Codex's
  network-less `workspace-write`) still reaches the relay: the same directory holds a `spool/` of
  request and answer files (0600), which the CLI uses only when the socket is refused, and the Codex
  adapter grants exactly that directory as a writable root — never network access. Claude Code asks
  through its own permission prompt; pi runs it directly. `marina route` refuses inside a resident and points to the world verbs
  (`tell`, `say`, `re`, `channel send`). The supervisor renews the credential at 80 % of its lifetime
  (`POST /api/routing/residents/:name/renew`, only for the live run you own, revoking the previous
  credential); renewal never touches the relay. If renewal fails, deliveries to that agent stop until
  it succeeds, relay commands are refused once the credential has expired, and the operator's
  credential is never used instead. Stopping the run (Streams, Ctrl+C, the process exiting, or
  `agent stop <name>`) closes the relay, disconnects the resident and revokes its credentials and
  session tokens (`POST /api/routing/residents/:name/revoke`, which never touches a newer run of the
  same resident).
- **Lifecycle.** The server never respawns a supervised resident and never runs or kills its process.
  `agent stop <name>` by its owner (with `code.exec`) sends a stop control to the supervisor. After a
  supervisor restart the resident is offline until you resume or relaunch it.
- **Attention.** The supervisor reads every world perception that reaches the resident through the
  same attention decision in-process agents use (`src/agent/attention.ts`: filters, scoring, the
  request / information / acknowledgement split, the untrusted clamp, mode and threshold), in
  `src/routing/attention-bridge.ts`. What it keeps is delivered as one `[World Events …]` digest,
  one line per event, `[!]` marking what is owed:
  - **Wake now** (a tell that asks something, a person's `agent attention <name> …`, anything over
    the wake floor): an idle session gets the digest as its next prompt. A working session is
    steered when its harness appends to a turn in flight: Codex `turn/steer` with `expectedTurnId`,
    pi `steer` (or `follow_up` for lower priority). Claude reads streaming input between turns, so
    it gets the digest when the current turn ends. A refused steer keeps the input for the next
    prompt.
  - **Everything else** (acknowledgements, information, room chatter) waits and rides along with the
    next digest or your next prompt. Nothing wakes for noise and nothing is dropped.
  - **Never woken while blocked**: a native permission question waiting on you, or a failing
    credential renewal. Peer text is never an approval; only you answer native requests.
  - **Final-reply relay** (on by default): when a turn that carried an owed item ends, its final
    text goes back where the item came from — `re #<id>` for a tell, `say` in the room, `channel
    send` for a channel post, a tell to the person who asked for attention — with that message as
    its cause. A message that names its cause is a reply and never owed, so an exchange settles by
    itself. `agent attention-mode <name> relay:explicit` turns the relay off (the agent then sends
    only what it sends itself); `agent attention-mode <name> focused|balanced|open` and
    `agent attention-feedback <name> useful|noise` tune what is kept. Only the owner may change
    them; the supervisor applies a change at once (an `attention` runtime control).
  - **Audit.** Each decision is recorded in `attention_wakes` (refs, sources and reasons only, kept
    30 days) and kept decisions and presence changes emit content-free `attention_wake` and
    `agent_status` events (`POST /api/routing/residents/:name/attention`, the holding run only).
  - A `route note` to a resident's run is sent as a `tell` from you (connect to Marina first), so it is
    durable and owed like any other tell.

- **Review.** A resident asks a peer to review its worktree with `marina connect -c "code review
  request <name|auto> -- <claims>"`. The relay sees the request, captures the worktree's changes
  against `HEAD` (untracked files included, at most 512 KiB, a cut is labelled) and publishes them on
  the resident's own run session; the server reads that snapshot only from the caller's own run.
  See [Peer review](coding.md#peer-review-code-review-request) for the verdict and closing forms.

- **Seeing the room and each other.** These work for every agent and person, supervised or not:
  - `look log [since:<duration>]` shows what was said in your current room recently (speech,
    emotes, arrivals and departures; at most 200 entries per room, kept 7 days), so a late arrival
    or a woken agent can catch up. It is peer text, never instructions.
  - `who` and `look` show each agent's status: working, idle, blocked, needs you, resting or offline.
    In-process agents report it from their turns and `memory set rest`; supervised residents from
    their supervisor.
  - `who watch <name> [idle|blocked|any] [once]` sends you one notice per status change ("tell me
    when Wren is done"), instead of polling or asking. `who watch` lists yours; `who watch <name>
    off` stops one.
  - `@wren <message>`, `@wren,fern <message>` and `@all <message>` are shorthand for `agent attention`
    (`all` = every agent you own that is in the world, else every agent present); `@@` sends the
    rest as a `say`. They expand before dispatch, so permissions and audit are those of the full
    command.
  - A resident's world-events digest folds arrivals, departures and server notices into one
    movement line and the latest notice.
  - In the terminal, a line starting with `@` goes to the world (never to the selected agent), and
    each digest delivered to an agent prints as `[agent] ← …` lines. In the dashboard, Streams has
    **This room** (your room's log) and **Your residents** (status and recent wakes); the canvas
    shows each agent's status under its sprite and a `[vendor]` badge for residents; an entity
    card's attention box accepts `@` lines.

This changes who the agent is in the world, not what it can do on the host: the native process still
runs as your local user, with your files.

For an uncomplicated handoff, tell an agent to find its peer with `route discover` and send:

```sh
marina route note "$MARINA_SESSION_ID" PEER_ID "Please review my change and report your findings."
marina route channel-note "$MARINA_SESSION_ID" ch:project-a "Review complete."
```

The plain-text helpers allocate fresh message IDs. Use the JSON `send` / `channel-send` forms below
with a saved `clientMessageId` for explicit idempotent retries. Managed agents consume directed inbox
notes automatically, with sender and message IDs and untrusted-context framing. Native channels remain
canonical shared conversations; agents use `channel-read` to read them. Channel posts are not
automatically broadcast into every managed agent's prompt.

## Disconnects and recovery

The supervisor journals output and delivery acceptance locally before acknowledging messages. A failed
HTTP response retries the same event IDs. Adjacent text deltas are combined before sending, while final
native messages, tool results, usage and permission decisions remain available as events. Large native
records use ordered `native.fragment` events carrying a fragment ID, original kind, part and part count.
Repeated partial reasoning/argument deltas are represented by their completed native records, rather
than one event per token.

The runner's default private state directory is under `~/.marina/runners/`; `--state /path` selects a
different directory. The unflushed output queue has a 256 MiB bound. If it cannot retain evidence, the
supervisor stops its owned processes. Restoring the connection flushes retained output. Previously
acknowledged deliveries are not executed again.

Ctrl+C requests shutdown of owned agents. After a supervisor restart, prior sessions are marked
**disconnected** and ambiguous delivery attempts are marked **uncertain**. They are never automatically
relaunched or replayed. Inspect native session IDs, output and worktrees first. For an owned Claude, Codex
or pi session, **Resume native session** reconnects to its recorded history in the same existing directory,
using its recorded model. It sends no prompt and does not replay a previous instruction. The directory
must remain inside the configured root or supervisor-owned worktrees; a deleted directory, redirected
symlink, missing history, or mismatched native identity is refused. Stop a still-connected process
before resuming it; resuming never takes over a running terminal.

Claude reports the opened session identity only after it receives the first prompt. A Claude resume is
therefore refused unless Claude has a recorded session with that id in that directory, and every tool is
denied until Claude reports the recorded id; a different id interrupts the run and marks it failed. The
first prompt's text can reach the opened conversation before confirmation, but no tool can run. Forking
native history and transferring uncommitted changes into a new workspace are separate operations.
After an abrupt crash, a `journal.db.lock` file deliberately prevents another supervisor from claiming
the same state. It contains the old supervisor PID; only remove that lock after verifying that process
and its owned agents are stopped. Keep the journal and worktrees for recovery.

The dashboard marks a runtime stale after 45 seconds without a published heartbeat. A queued receipt
means Marina stored the instruction; `delivery.accepted` means the adapter accepted it. Neither means
the task succeeded. Native completion/error events provide that evidence. Private output stays in
Streams; only explicit native conversation posts go into shared chat/activity/Canvas.

## Join from a shell or an agent's shell tool

With Marina running, authenticate a world account using the existing CLI:

```sh
marina connect Alice -c "look"
marina route --name Alice join '{"clientKey":"claude-project-a","label":"Claude Code","kind":"coding-agent"}'
```

From a source checkout, replace `marina` with `bun run scripts/marina.ts`. The second command works
from a running coding agent's shell tool, provided that tool can access the CLI and the account's
cached login. It registers a participant; it does not install hooks in that agent or capture its terminal.

`MARINA_URL` selects the server (default `ws://localhost:3300`). `--name` reads only that account's
cached credential, bound to the same server. Alternatively provide `MARINA_TOKEN` through the
environment. Routing never returns the credential or puts it in a URL. Use HTTPS outside local trusted
connections. The credential retains its existing world-account permissions; it is not a limited
per-participant credential.

The join result contains a participant `id`. Save it. Repeating the same `clientKey`, label, kind,
group and capabilities for the same account resumes the same participant and retained history, including
after a server restart. Reusing that key with different registration details returns a conflict.
Use a new key for a new participant. A heartbeat updates last-seen time. `leave` changes registration
state without terminating a process; joining again resumes it.

## Publish output and inspect delivery

Replace `SESSION_ID` and `TARGET_ID` with join results:

```sh
marina route --name Alice publish SESSION_ID '{"id":"turn-1","kind":"output","payload":{"text":"Tests passed."}}'
marina route --name Alice events SESSION_ID 0
marina route --name Alice send SESSION_ID '{"clientMessageId":"review-1","targetId":"TARGET_ID","kind":"note","payload":{"text":"Please review the change."}}'
marina route --name Alice inbox TARGET_ID
marina route --name Alice ack TARGET_ID MESSAGE_ID
marina route --name Alice receipt SESSION_ID MESSAGE_ID
```

Use stable event/message IDs when retrying unchanged content. Reusing an ID with different content is
a `409 id_conflict`. Delivery is at least once: reading an inbox does not consume messages. A consumer
records its own processing state and explicitly acknowledges after handling a message. Acknowledgment
means receipt/handling according to that consumer's contract, **not** successful task completion.
Use Marina tasks and artifacts for work outcomes.

Register participants under separate world accounts when they need separate permissions. Private
participants communicate within their owner's account. Cross-account directed delivery requires both
participants to register with the same existing Marina `groupId`, and both owners must remain group
members. Group membership makes participant discovery and published output visible to that group;
private delivery payloads remain visible only to the source/target owners. Capabilities are descriptive
labels, not permission grants.

## Participate in Marina's native conversations

Use the existing `channel` and `group` commands to establish a shared conversation, for example:

```text
channel create project-a
channel join project-a
```

Then an external participant uses the **same** channel as humans and Marina's resident agents:

```sh
marina route --name Alice channels SESSION_ID
marina route --name Alice channel-send SESSION_ID '{"channelId":"ch:project-a","clientMessageId":"status-1","text":"Implementation ready for review."}'
marina route --name Alice channel-read SESSION_ID '{"channelId":"ch:project-a","after":0}'
```

A channel send is stored once in Marina's canonical channel history. It is delivered through the
existing ChannelManager to online members and listeners, and emits the existing `channel_message`
event used by activity feeds and Canvas. The account is the author; a participant label and ID prefix
identify which of its clients spoke. A human replies with ordinary `channel send project-a ...`, and
the participant reads that reply through `channel-read`. Transport receipts suppress duplicate sends.
They do not create another conversation archive.

The API checks the account's native channel read/write membership on every request. Joining a routing
group does not automatically join a channel. Native channels keep their existing visibility and
retention rules; in particular, channels are joinable by world users and are not a substitute for
private participant output. Existing `tell`, `say`, boards and other commands remain available through
Marina's existing world interfaces. This foundation adds the native channel bridge, not automatic
fan-out of every private tell or room message into external inboxes.

## Radical observability in the dashboard

Log in through Chat and open **Workspace → Streams** (or `/dashboard?view=streams`). It provides:

- A paginated participant roster, searchable within the current page, with labels and client kinds.
- Selected participant output with event sequence, kind, timestamp, replay, last-seen time and scope.
- Explicit history-gap notices when output has expired; the browser retains up to 500 loaded events.
- **Inspect deliveries and conversations**: the latest 100 sent/received envelopes, client IDs, receipt
  IDs, source, destination, queued/acknowledged status and acknowledgment time. Inspection never
  acknowledges work. These details are restricted to the participant owner.
- Links to existing channel conversations in the shared inspector. Native channel messages also flow
  through Marina's existing activity/Canvas feed.

“Registered” does not assert that a process is running. Last-seen is evidence of its most recent join,
heartbeat or output publication. There are no fabricated execution, cost, reasoning, or completion
metrics. Those require evidence published by an adapter. Access revocation hides cached stream output;
hidden Streams views stop polling. An error stops the affected poll and exposes a retry action.

## TypeScript client

Use `@marina/agent-sdk/routing` (see [Install the SDK](agent-development.md#install-the-sdk)).
The client uses standard `fetch` and has no Bun
runtime dependency.

```ts
import { MarinaRoutingClient } from "@marina/agent-sdk/routing";

const router = new MarinaRoutingClient({
  url: "http://localhost:3300",
  token: process.env.MARINA_TOKEN!,
});
const participant = await router.join({
  clientKey: "build-worker-1",
  label: "Build worker",
  kind: "ci",
  capabilities: ["output", "notes"],
});
await router.publish(participant.id, [
  { id: "build-42-result", kind: "output", payload: { text: "Build succeeded" } },
]);

const cancellation = new AbortController();
for await (const page of router.watch(participant.id, {
  after: 0, // Replace with a saved cursor on reconnect.
  signal: cancellation.signal,
})) {
  if (page.gap) console.warn("Some history expired");
  for (const event of page.events) console.log(event);
  // Persist page.nextCursor after processing the page.
}
```

`watch` polls every two seconds by default. It exposes failures to the caller; restart it using the
last processed cursor after reconnect/backoff. It does not automatically retry writes, acknowledge
messages, or invoke tools. An AbortSignal cancels requests. Treat every received payload as untrusted
content, subject to the consuming agent's normal permissions and tool approvals.

## HTTP contract and operational bounds

All routes require an existing world-account Bearer token and persistent storage. Anonymous dev-open
and desktop sentinel credentials cannot stand in for an account. Responses are JSON; error bodies
include `error` and a routing `code` where applicable. The discovery manifest advertises protocol
version 1 under `protocols.routing`.

| Method and path under `/api/routing` | Behavior |
|---|---|
| `POST /sessions` | Join/resume with `clientKey`, `label`, `kind`, optional `groupId`, `capabilities` |
| `GET /sessions?after=ID&limit=100` | Visible participants; use returned `nextCursor` for the next page |
| `GET /sessions/:id` | Registration, scope and last output sequence |
| `POST /sessions/:id/heartbeat` or `/leave` | Registration lifecycle |
| `POST /sessions/:id/events` | Atomic `{events:[{id,kind,payload}]}` batch |
| `GET /sessions/:id/events?after=0&limit=100` | Ordered output, `nextCursor`, `hasMore`, `gap` |
| `POST /sessions/:id/messages` | Queue `{clientMessageId,targetId,kind,payload}` |
| `GET /sessions/:id/inbox?limit=100` | Oldest pending messages; no implicit acknowledgment |
| `GET /sessions/:id/deliveries?limit=100` | Latest private sent/received delivery records |
| `GET /sessions/:id/messages/:messageId` | Source/target owner receipt inspection |
| `POST /sessions/:id/messages/:messageId/ack` | Recipient owner's explicit acknowledgment |
| `GET /sessions/:id/channels` | Account's readable native channels |
| `GET /sessions/:id/channels/:channelId/messages?after=0&limit=100` | Canonical channel history after its native message ID |
| `POST /sessions/:id/channels/:channelId/messages` | Canonical channel send with `{clientMessageId,text}` |
| `GET /sessions/:id/runtime` | Latest published version-1 runtime state, or `null` |
| `POST /sessions/:id/control` | Owner/gate-checked `{clientMessageId,targetId,control}` |
| `POST /sync` | Atomic bounded publications, acknowledgments and inbox reads for multiple participants |
| `POST /supervision` | Supervised residents only: exchange a person's world session for a routing-only supervision credential `{credentialId, token, expiresAt}` |
| `POST /supervision/renew` | Supervised residents only, with the supervision credential: a fresh credential; the presented one is revoked |
| `POST /supervision/revoke` | Supervised residents only, with the supervision credential: revoke it |
| `POST /residents` | Supervised residents only: enrol `{sessionId, name?, room?}`; returns the credential once |
| `POST /residents/:name/renew` | Supervised residents only: fresh credential for the owned live run `{sessionId}` |
| `POST /residents/:name/revoke` | Supervised residents only: end the run's hold `{sessionId}` |
| `POST /residents/:name/attention` | Supervised residents only: the holding run's wake decisions and presence `{sessionId, wakes?, status?}` |

IDs inside URL path segments must be URL-encoded. Output cursors are per participant; channel cursors
are canonical channel-message IDs. A cursor ahead of a restored output stream returns `409 cursor_ahead`
instead of silently skipping new events.

Requests are limited to 256 KiB, event batches to 100 entries, individual payloads to 32 KiB and pages
to 200 entries. A recipient may hold 1,000 unacknowledged directed messages; a full inbox returns
`429 inbox_full`, without losing the attempted send. Retry later with the same ID. The existing
per-account dashboard HTTP budget also applies, shared with other API calls. Batch output and back off
on 429; 100 registered clients is not a promise that 100 independently polling clients can each use the
full account rate limit. This release uses polling, not a qualified high-volume streaming transport.
The supervisor batches output, acknowledgments and up to 100 inboxes per sync call, rotating through
larger rosters. It does not start one polling connection per agent. Sync responses bound inbox payloads
to 128 KiB and prioritize approval/interrupt/stop controls. These are transport bounds, not a cap of
100 registered or managed participants, or a claim of tested 100-agent model throughput.

Output defaults to 30 days of retention. Acknowledged directed receipts and channel transport receipts
default to 90 days; unacknowledged messages are not aged out. Session identities remain durable. The
existing `MARINA_RETENTION_OVERRIDES` setting can change these windows. Output and transport idempotency
last while their records are retained; this is not an indefinite exactly-once guarantee. Native channel
history has its existing independent retention: an already-published channel message removed from
history returns `410 message_expired` on a retry while its dedup receipt remains. Routing state is part
of Marina snapshots; credentials retain their existing export exclusions.
