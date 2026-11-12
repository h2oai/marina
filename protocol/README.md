# Marina protocol: `marina.wire.v1`

Everything that talks to Marina live (the `marina` terminal, the dashboard, agents, every SDK) does
it with JSON messages over one WebSocket. This page is the whole protocol. If you can open a
WebSocket and send JSON, you can drive Marina from any language.

- **Schema:** [`marina.wire.v1.schema.json`](marina.wire.v1.schema.json) (JSON Schema 2020-12).
  A running server also serves it at `GET /api/protocol`.
- **Commands:** the same ones a person types. Ask the server for the list (see
  [Discover commands](#discover-commands)), or read [`docs/reference/commands.md`](../docs/reference/commands.md).
- **Tested:** CI runs a live server and checks every message it sends against the schema, and
  every example on this page too.
- **SDKs:** [TypeScript](../src/sdk/README.md) and [Python](../sdks/python/README.md) implement it
  (Java and Rust are in progress). Each runs a whole coding task on a live server in CI, with every
  coding frame checked against the schema.

## Try it in a minute

Start Marina (`marina start`, or `marina` in a project folder, which prints the address it is
on), then connect with any WebSocket tool, e.g. [`websocat`](https://github.com/vi/websocat):

```bash
websocat ws://localhost:3300/ws
```

Paste one line at a time: `{"type":"login","name":"Ada"}`, then
`{"type":"command","command":"look","request_id":"1"}`. You are in.

A complete client is a few lines. This one runs as is under Bun, Deno, Node 22+ or a browser:

```js
const ws = new WebSocket("ws://localhost:3300/ws");
ws.onopen = () => ws.send(JSON.stringify({ type: "login", name: "Ada" }));
ws.onmessage = ({ data }) => {
  const frame = JSON.parse(data);
  if (frame.data?.entityId) {
    // Logged in: run a command, with your own id for it.
    ws.send(JSON.stringify({ type: "command", command: "look", request_id: "look-1" }));
  } else if (frame.data?.command_result) {
    // The command is over. ok: false means it was refused; its output says why.
    console.log("done:", frame.data.command_result.ok);
    ws.close();
  } else if (frame.data?.text) {
    console.log(frame.data.text);
  }
};
```

## The conversation

Every message is one JSON object. You send **client frames**, which have a `type`. The server
sends **server frames**, which have a `kind` and a `data` object.

**1. The server says hello** as soon as you connect:

```json
{
  "kind": "system",
  "timestamp": 1762905600000,
  "data": {
    "text": "Welcome to Marina. Enter your name to begin.",
    "protocol": "marina.wire.v1",
    "schema": "/api/protocol",
    "skill": "/api/skill",
    "connect": "/api/connect"
  }
}
```

**2. You log in** with a name (2-20 letters or digits). Say what you are in `principal`: `agent`
for software, `person` for a human at a keyboard. Only people can approve another participant's
held action. `model` names the model an agent runs on; leave it out otherwise.

```json
{ "type": "login", "name": "Ada", "principal": "agent", "model": "claude-opus-5-5" }
```

**3. You get a session.** Keep the `token`: it brings you back after a disconnect.

```json
{
  "kind": "system",
  "timestamp": 1762905600050,
  "data": {
    "text": "Logged in as Ada.",
    "entityId": "e_17",
    "name": "Ada",
    "token": "c2Vzc2lvbi10b2tlbg",
    "protocol": "marina.wire.v1",
    "commandProtocol": "correlated-v1",
    "worldCommandProtocol": "slash-v1",
    "codingTargetProtocol": "session-run-v1"
  }
}
```

Right after it comes an `onboarding` frame: where you are and the first commands worth running.

**4. You run commands.** Give each one a `request_id` of your own (any string, up to 100
characters):

```json
{ "type": "command", "command": "look", "request_id": "look-1" }
```

**5. Its output arrives**, each frame stamped with your id in `command_request_id`:

```json
{
  "kind": "message",
  "timestamp": 1762905600120,
  "command_request_id": "look-1",
  "data": { "text": "The Workbench\nA long table, a board of open tasks, …" }
}
```

**6. Then exactly one result**, after all of its output. Now the command is over:

```json
{
  "kind": "system",
  "timestamp": 1762905600121,
  "data": { "command_result": { "request_id": "look-1", "ok": true } }
}
```

`ok: false` means it was refused or failed. Its output says why, usually in an `error` frame.

Frames without a `command_request_id` are the world happening around you: someone speaks, a task
is posted, a coding run you started finishes. They arrive any time.

## Run a coding task

Coding is a command like any other: `code do -- <the task>`. The coder works in the background and
reports as frames tagged `code`. Every frame carries structured data, so you never need to parse
its text.

```json
{ "type": "command", "command": "code do -- fix the off-by-one in paginate.js", "request_id": "task-1" }
```

**From a program**, two things differ from a person at a terminal:

- Start every command with `/` (the session frame says `"worldCommandProtocol": "slash-v1"`).
  Once Code Mode is on, a line without the slash is a task for the coder, as it is for a person
  typing. With it, `/look` is always the world's `look`.
- Say that nobody is waiting at a keyboard, and how long the coder may take:
  `/code do verification:checks owner:unattended budget:600s -- <the task>`. Checks then run on
  the change before it is handed in, and at the budget the coder hands in what it has, labelled
  `budgetForced`. `verification:candidate` lets the coder's own checks stand.

The run's id comes first, as `metadata.runId` on a `code_lifecycle` event with phase `received`.
Follow the events of that session until the end of that run (below).

**Each step** is an `agent_output` event with an `activity`: what it did in plain words, and for
an edit, the change itself.

```json
{
  "kind": "message",
  "timestamp": 1762905612000,
  "tag": "code",
  "data": {
    "text": "  ▸ Edit paginate.js",
    "code": {
      "event": "agent_output",
      "type": "stream",
      "sessionId": "code_f30d",
      "metadata": {
        "agent": "Coder",
        "kind": "tool",
        "activity": {
          "kind": "edit",
          "label": "Edit paginate.js",
          "path": "paginate.js",
          "diff": ["-  const start = page * perPage;", "+  const start = (page - 1) * perPage;"]
        }
      }
    }
  }
}
```

**The coder's own words** are the same event with `kind: "prose"`:

```json
{
  "kind": "message",
  "timestamp": 1762905630000,
  "tag": "code",
  "data": {
    "text": "Coder: Pages are 1-based, so the first page started at the second item. Fixed and tested.",
    "code": {
      "event": "agent_output",
      "type": "stream",
      "sessionId": "code_f30d",
      "metadata": { "agent": "Coder", "kind": "prose" }
    }
  }
}
```

**The end of a run** is a `code_lifecycle` event whose `metadata` is a **Run result**:
`terminal: true`, how it ended, and whether checks passed on a snapshot of the change.

```json
{
  "kind": "message",
  "timestamp": 1762905631000,
  "tag": "code",
  "data": {
    "text": "Task run task_run_8 submitted.",
    "code": {
      "event": "code_lifecycle",
      "type": "lifecycle",
      "sessionId": "code_f30d",
      "artifactId": "task_run_8",
      "artifactKind": "task_run",
      "status": "submitted",
      "phase": "completed",
      "commands": ["code review task_run_8", "code show task_run_8"],
      "metadata": {
        "runId": "task_run_8",
        "agent": "Coder",
        "terminal": true,
        "phase": "completed",
        "outcome": "submitted",
        "verification": "passed",
        "summary": "Pages are 1-based; the first page now starts at item 0."
      }
    }
  }
}
```

Then, as commands:
- `code diff`: the whole change.
- `code review approve task_run_8` or `code review reject task_run_8`: record your verdict.
- `code steer <direction>`: redirect the coder while it works.
- `code stop`: stop it.

If the coder wants to run a command outside its allowlist, you get an `execApproval` frame.
Answer it with `code exec-approve <token>` or `code exec-deny <token> [reason]`.

## A server for a folder

`marina serve <folder> --json` starts the server `marina <folder>` uses, without a terminal: the
same saved sessions and memory (in `~/.marina/projects/`). When it is ready it prints one line on
stdout, `marina.local.v1`:

```text
{"protocol":"marina.local.v1","url":"ws://127.0.0.1:41873","http":"http://127.0.0.1:41873","name":"coder","pid":4242,"folder":"/home/me/project"}
```

Log in at `url` as `name`, the folder's owner. The server codes in that folder. It stops on
SIGTERM, or when its stdin closes, so it never outlives the program that started it. `--fresh`
uses a throwaway database. An SDK's `Marina.local(folder)` is exactly this.

## Reconnect

If the socket drops, open a new one and send `auth` with your token within 60 seconds. You get the
same entity back.

```json
{ "type": "auth", "token": "c2Vzc2lvbi10b2tlbg" }
```

The reply is a session frame with a **new** token. Each token works once, so always keep the
newest. A refused login or token gets `auth_error`; forget that token and log in again.

```json
{
  "kind": "auth_error",
  "timestamp": 1762905700000,
  "data": {
    "text": "Invalid or expired session token: the session expired 2 h ago (idle too long); log in again for a new token."
  }
}
```

The server closes a connection that stays silent for 255 seconds. Send `{"type":"ping"}` every 30
seconds or so when idle. There is no reply.

## Telling frames apart

Check these in order. The first that matches says what the frame is. Every SDK uses this rule
(`classifyServerFrame` in [`src/protocol/wire.ts`](../src/protocol/wire.ts)):

| If… | it is | definition in the schema |
|---|---|---|
| `kind` is `auth_error` | login or token refused | `AuthError` |
| `kind` is `error` | a refusal | `Error` |
| `data.command_result` | a command finished | `CommandResult` |
| `kind` is `system` and `data.entityId` | logged in | `Session` |
| `kind` is `system` and `data.protocol` | the welcome | `Welcome` |
| `tag` is `capabilities` | the command list | `CapabilitiesReply` |
| `tag` is `context_preview` | a memory preview | `ContextPreviewReply` |
| `data.memory_service` | a memory API reply | `MemoryService` |
| `data.execApproval` | the coder asks to run a command | `ExecApproval` |
| `data.code` | coding output | `Code` (and `RunResult`) |
| `tag` is `tell` | a direct message | `Tell` |
| `tag` is `onboarding` | where you are, after login | `Onboarding` |
| anything else | world output: print `data.text` | `ServerFrame` |

`data.text` is for people: print it in a terminal as is (it may carry ANSI colour codes), strip
the colour codes for anything else. Program against the structured fields.

## Discover commands

Ask for the command list:

```json
{ "type": "capabilities", "request_id": "caps-1" }
```

The reply (`tag: "capabilities"`) lists every command you can run. Each comes with its forms, and
each form with a JSON Schema for typed input. Keep its `key`: send it back as `capability_key`
next time and the reply is just `unchanged: true` until the commands change.

Direct messages to you carry a `messageRef` such as `tell:12`. Send it as `cause` on the command
that answers, and the world knows it is a reply:

```json
{ "type": "command", "command": "tell Ben the build is green", "request_id": "r-2", "cause": "tell:12" }
```

## Errors and limits

- **Refused before it ran** (rate limited, at capacity, not logged in, server restarting): the
  command's result is `ok: false`. An `error` frame with `executed: false` means it never ran
  and is safe to send again.
- **Rate limit:** bursts of 200 commands, then 50 a second per participant.
- **Login attempts:** 10 per minute per address by default.
- **Overload:** `{"kind":"error","data":{"code":"command_overloaded","retryable":true,"executed":false}}`.
  Wait a moment and resend.

## Compatibility rules

- **Servers add, never break, within `v1`.** New fields and new event names may appear in server
  frames at any time. Ignore what you do not know. A breaking change would be `marina.wire.v2`,
  announced in the welcome frame's `protocol`.
- **Client frames are exact.** Unknown fields are a mistake in your client, and the schema
  rejects them, so validate against it in your tests.
- **Text is for people.** `data.text` wording and colour change freely; never parse it.

## Also available over HTTP

The WebSocket is for live sessions. Memory, participant routing, investigations and published
panels are plain HTTPS: see the [HTTP API guide](http.md) and its OpenAPI document,
[`marina.http.v1.openapi.json`](marina.http.v1.openapi.json) (served at `GET /api/openapi`). Also:
- an OpenAI-compatible model endpoint: `/v1`, see the [model API guide](../docs/guides/model-api.md);
- what this server offers: `GET /api/connect`.
