# Marina for Rust

Run coding tasks, send commands and use Marina's HTTP APIs from Rust. A blocking API (the SDK
runs its own threads); Rust 1.88 or newer. Dependencies: `serde_json`, `tungstenite` and `ureq`,
with `rustls` for `wss://` and `https://`.

```rust
use marina_sdk::{Marina, RunOptions, Verdict};
use std::time::Duration;

fn main() -> marina_sdk::Result<()> {
    // A Marina for this folder: the same server and saved sessions `marina .` uses.
    let marina = Marina::local("my-project")?;
    let options = RunOptions { budget: Some(Duration::from_secs(600)), ..Default::default() };
    let run = marina.code().run("The last page drops its final item; fix it", options)?;
    for step in run.steps() {
        println!("{}", step.label);
    }
    let result = run.result()?;
    println!("{:?} {:?} {:?}", result.outcome, result.verification, result.summary);
    println!("{}", marina.code().diff(None)?);
    marina.code().review(&result.run_id, Verdict::Approve)?;
    Ok(())
} // dropping `marina` stops the folder's server
```

`Marina::local(folder)` runs `marina serve <folder> --json`, so the `marina` CLI must be
installed. Set `LocalOptions.command` to say how to run it, e.g.
`vec!["bun".into(), "run".into(), "/path/to/marina/scripts/marina.ts".into()]`. To use a server
that is already running, connect to it instead:

```rust
let marina = marina_sdk::Marina::connect("ws://localhost:3300", "builder")?;
println!("{}", marina.command("look")?.text()); // one world command; Err(Error::Command) if refused
```

## Install

Not on crates.io yet. From a Marina checkout:

```toml
[dependencies]
marina-sdk = { path = "path/to/marina/sdks/rust" }
```

## What `marina` offers

| On `marina` | What it is |
|---|---|
| `code().run(task, RunOptions)` | a coding task: `steps()`, `events()`, `result()`, `result_timeout()` |
| `code().diff(path)`, `code().review(run_id, verdict)`, `code().on_exec_approval(fn)` | the change, your verdict, and answers to the coder's requests to run other commands |
| `command(text)`, `capabilities()`, `capability_manifest()`, `on_event(fn)` | world commands, what this session may run (raw or typed), everything the server sends |
| `tell`, `say`, `tell_and_await`, `wait_for_tell` | talk to other participants; ask and wait for the answer |
| `look`, `note`, `recall` | common commands (more on `connection()`: `go`, `who`, `channel_send`, `next`, `brief`, `help`) |
| `routing()`, `investigations()`, `panels()` | the HTTP APIs, typed, signed in as this session |
| `memory(credential)` | the memory API, typed, with a memory credential of its own |
| `watch_changes(on_event, on_snapshot)` | the live panel event stream |
| `on_reconnect(fn)`, `is_connected()` | the SDK resuming a dropped session |
| `session()`, `token()`, `connection()` | who you are, the newest session token, the WebSocket session underneath |

- **Coding.** `run()` returns once the server accepts the task. `steps()` yields each
  `CodingActivity` (`kind`, `label`, `path`, `diff`). `result()` waits for the `RunResult`:
  `outcome` (`submitted` when handed in), `verification` (`passed` only when checks ran on the
  change and passed), `summary`, `budget_forced` when a budget forced the answer. `RunResult`
  serializes with the protocol's field names (`runId`, ...). `RunOptions`: `verification`
  (`Checks`, `Candidate`, `Delivery`), `budget`, `timeout`.
- **Commands mean what they say.** `command("look")` is always the world's `look`, even with a
  coder at work. Coding tasks go through `code().run`.
- **HTTP.** Every operation in `marina.http.v1` is a typed method on `MemoryApi`,
  `RoutingApi`, `InvestigationsApi` or `PanelsApi`, with its request and reply models
  (`marina_sdk::models`, generated from the OpenAPI document): path parameters first, then
  query parameters as `Option`, then the body, then the `Idempotency-Key` for memory writes.

  ```rust
  use marina_sdk::models::{CreateSpaceRequest, MemoryRecordInput, MemorySearchInput};
  let memory = marina.memory(&credential);
  let space = memory.create_space(&CreateSpaceRequest { name: "notes".into() }, None)?.id;
  let note = MemoryRecordInput { content: "Deploys run from main".into(), ..Default::default() };
  let receipt = memory.remember(&space, &note, Some("note-1"))?;
  let found = memory.search(&space, &MemorySearchInput { query: "deploy".into(), ..Default::default() })?;
  ```

  Models use the wire's field names renamed to snake_case; an optional field is an `Option`
  left out when `None`; enum values are `String` (the server may add some) and unions
  `serde_json::Value`. For an operation newer than the SDK, `call` and `call_with_key` take
  any operation by id or snake_case name, with parameters by name and a JSON body
  (`memory.call("search", &[("space", json!(space))], Some(json!({ "query": "deploy" })))`);
  `operations()` lists them. A failure is `Error::Api { status, code, message, retry_after_ms }`
  (branch on `code`), or `Error::Transport` when the request or reply did not get through.
  Memory writes get an `Idempotency-Key`; pass your own to retry a write safely. Redirects are
  refused, so a token never follows one.
- **Memory retry.** `retry_memory(|| memory.remember(&space, &note, Some("note-1")), 5,
  std::thread::sleep)` sends the same request (and key) again on 408, 429, 502, 503, 504 and
  transport errors. A named rate limit (`429 rate_limited` with `retry_after_ms`) is waited out
  exactly (plus 5 ms) without using an attempt, up to 30 s of such waits; other failures back
  off 250 ms doubling to 2 s; a server wait over 5 s comes back as the error.
- **Reconnect.** When the socket drops, the SDK resumes the session on its own with the newest
  token (each token works once): backoff from 3 s doubling to 30 s, at most 10 attempts, then
  `on_reconnect` callbacks run. A command sent while disconnected fails at once with
  `Error::ConnectionLost`; retry it. A coding run in progress survives a resumed session; it
  fails only when reconnecting gives up or on `close()`. `close()` (or dropping `Marina`) never
  reconnects. To resume yourself later, `Marina::connect_with(url,
  ConnectOptions::token(&old_token))` within 60 s of a drop gives back the same entity.
- **Talking to others.** `tell_and_await(peer, "question", timeout)` tags the question
  ` [re:<id>]` and returns the reply with the tag removed: a reply echoing the tag wins at once,
  an untagged one is held 1.5 s in case a tagged one follows, notices ("I've spent my
  model-call budget ...") are never an answer, and a tell older than the question is ignored
  (`TellAwaitOptions` for strict correlation and the rest). `wait_for_tell(Some(peer),
  timeout)` returns the text of the next tell to you; a wait that ends empty is
  `Error::Timeout`. `tell_of(frame)` reads a tell in your own `on_event` listener.
- **Typed command forms.** `capability_manifest()` reads every command's forms;
  `compose_command(form, &values, &enabled)` fills one (values by field id or label, optional
  groups by id) with the TypeScript SDK's validation, returning the command line and any
  `errors` by field.
- **Panel events.** `watch_changes(on_event, on_snapshot)` follows `/dashboard-ws` with this
  session's token, reconnecting with backoff (1 s doubling to 15 s). An event is a hint to read
  again, never content; `on_snapshot` runs on every (re)connection. Stop the returned
  `PanelWatch` (or drop it).
- **Threads.** One SDK thread owns the socket; your `on_event` listeners run on another, in
  order, and may run commands. Dropping `Marina` closes it.

## Examples

In `examples/`: `local_coding` (a coding program on `Marina::local`), `tell_agent` (an agent
that answers tells), and `conformance`, the driver the repository's conformance suite runs
(`protocol/conformance.md`).

## The protocols

This SDK is one implementation of Marina's documented protocols, in the repository's `protocol/`
folder: `marina.wire.v1` (WebSocket), `marina.http.v1` (HTTP, OpenAPI 3.1) and `marina.local.v1`
(`marina serve`). The repository's tests hold it to them: a live server runs a whole coding task
through it and checks every coding frame against the schema, and its operation table is
generated from the same source as the OpenAPI document.

## Tests

```bash
cargo test --manifest-path sdks/rust/Cargo.toml   # offline
bun test test/rust-sdk.test.ts                     # live, from the repository
bun test test/sdk-conformance.test.ts              # the conformance scenarios, every SDK
```
