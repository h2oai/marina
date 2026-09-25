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
These are the operator's existing account credentials, not reduced per-agent credentials. Treat managed
agents as programs running under that local user and account.

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
relaunched or replayed. Inspect native session IDs, output and worktrees before starting replacement
work. This release does not offer native-session resume or takeover of already-running terminals.
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

Use `@marina/agent-sdk/routing` when the SDK is installed, or import
`src/sdk/routing-client.ts` from a source checkout. The client uses standard `fetch` and has no Bun
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
