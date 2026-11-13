# SDK conformance

Every Marina SDK (TypeScript, Python, Java, Rust) runs the same scenarios against a live server
and must produce the same report. "Parity" means this list passes for every language, checked by
the same assertions in `test/sdk-conformance.test.ts`. A new SDK, or a new language feature, adds
its driver here first.

## The driver

Each SDK ships one driver program that uses only the SDK's public API:

```text
<driver> <scenario> <server url> '<args JSON>'
```

It talks to the test in JSON lines:

- On stdout it prints `{"ready": {...}}` when it needs the test to act. It then reads one line
  from stdin, `{"go": {...}}`, and carries on.
- It ends with `{"report": {...}}` and exit code 0. On failure it prints `{"error": "..."}` and
  exits non-zero.
- Other stdout lines are ignored. Logs belong on stderr.

`args.name` is always the login name the driver uses (`tsdriver`, `pydriver`, `javadriver`,
`rsdriver`). The fixture makes that name an operator of the world.

## Scenarios

| Scenario | Args | The driver does | Report |
|---|---|---|---|
| `coding` | `task` | Connect. Print `ready {entity}`; the test grants `code.exec`. Run the task with `verification: candidate`, read every event, get the result, read the diff, approve the run. Record every `code` frame from the event listener. | `run_id`, `result` (the server's Run result, as sent), `typed_result` (the SDK's typed result serialized with the protocol's field names, no null fields), `submitted`, `summary`, `steps` (each activity, protocol field names, no null fields), `last_event_run`, `diff`, `frames` |
| `commands` | | Run `look`; run `frobnicate the moon` and catch the refusal; read the capabilities; find the `say` command's form whose syntax starts with `say `; compose it with no values (expect one error), then with the `message` field set to `hello from <name>`; run the composed command. | `look` (text), `refused` (the error message), `capability_count`, `composed`, `missing_errors` (number of errors), `said` (text) |
| `reconnect` | | Connect; print `ready {entity}`. The test drops the socket from the server side. Wait (up to 30 s) for the SDK to reconnect on its own, then run `look`. | `reconnected`, `same_entity`, `token_changed`, `look_ok` (all `true`) |
| `agent` | `peer` | `tell_and_await(peer, "ping")`: the peer answers `pong`, echoing the correlation tag. Print `ready {listening: true}`, then `wait_for_tell(peer)`: the peer asks `question?`. Answer with `tell(peer, "answer: <question>")`. | `reply` (`pong`), `heard` (`question?`) |
| `memory` | `credential`, `burst` | With the memory credential: create a space; `remember` a record (`Deploys run from main`) twice with one idempotency key; `get` it; `search` for `deploy`. Then write `burst` records one after another, each through the SDK's memory retry, counting the rate-limit waits. | `space`, `receipt_id`, `replayed`, `content`, `found`, `written`, `rate_limit_waits` (> 0) |
| `panels` | | Watch the live panel event stream; wait for its snapshot; run `canvas create <name>board` and `canvas post on:<name>board hello`; wait for an event naming a canvas. | `snapshot`, `got_canvas_event`, `event_types` |
| `routing` | | With the typed routing calls: join sessions A and B; publish an output event from A; send a note A → B; read B's inbox; acknowledge; read A's events. | `session_a`, `inbox_has_message`, `published` |
| `local` | `folder`, `command` | `Marina.local(folder, fresh, command)` on a clean machine (the test clears `HOME` and provider keys). Try a coding task (refused: no model), run `look`, close, check the server process is gone, then try a folder that does not exist. | `name` (`coder`), `refused`, `look`, `stopped`, `missing` |

The memory and routing scenarios use the SDK's typed HTTP methods, not a generic call: they are
how the conformance suite checks the generated models.

## What every SDK offers

In each language's own naming (`waitForTell` / `wait_for_tell`):

- **Front door.** `Marina.connect(url, name | token)`, `Marina.local(folder, options)`,
  `command(text)` (world grammar: the `/` prefix), `capabilities()`, `onEvent(listener)`,
  `close()`.
- **Reconnect.** After a dropped socket the SDK resumes the session with its newest token on its
  own: backoff from 3 s doubling to 30 s, at most 10 attempts, the newest token kept, a reconnect
  event raised. A command sent while disconnected fails at once with "connection lost"; the
  caller retries it.
- **Coding.** `code.run(task, verification, budget, timeout)` with `events`, `steps`, `result`,
  `steer`, `stop`; `code.diff`, `code.review`, `code.onExecApproval`.
- **Agent helpers.** `tell`, `say`, `tellAndAwait(target, message, timeout)` (correlation tag
  `[re:<id>]`, notices ignored, the same rules as the TypeScript SDK) and
  `waitForTell(from, timeout)`.
- **Typed command forms.** `composeCommand(form, values, enabled)` over the forms the
  capabilities reply carries, with the TypeScript SDK's validation rules.
- **HTTP.** Every `marina.http.v1` operation as a typed method, generated from the OpenAPI
  document with its request and reply models; a generic call stays for anything newer.
- **Memory retry.** The same request and key again on 408, 429, 502, 503 and 504. A named rate
  limit (`429 rate_limited` with `retry_after_ms`) is waited out exactly (plus 5 ms) and does not
  use up an attempt, up to 30 s of such waits in all; other failures back off 250 ms doubling to
  2 s, 5 attempts; a server wait over 5 s is handed back to the caller.
- **Panel events.** `watchChanges(onEvent, onSnapshot)` on `/dashboard-ws?token=…`, reconnecting
  with backoff; an event is a hint to read again, never content.
