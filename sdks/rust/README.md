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
| `command(text)`, `capabilities()`, `on_event(fn)` | world commands, what this session may run, everything the server sends |
| `routing()`, `investigations()`, `panels()` | the HTTP APIs, signed in as this session |
| `memory(credential)` | the memory API, with a memory credential of its own |
| `session()`, `token()`, `connection()` | who you are, the newest session token, the WebSocket session underneath |

- **Coding.** `run()` returns once the server accepts the task. `steps()` yields each
  `CodingActivity` (`kind`, `label`, `path`, `diff`). `result()` waits for the `RunResult`:
  `outcome` (`submitted` when handed in), `verification` (`passed` only when checks ran on the
  change and passed), `summary`, `budget_forced` when a budget forced the answer. `RunResult`
  serializes with the protocol's field names (`runId`, ...). `RunOptions`: `verification`
  (`Checks`, `Candidate`, `Delivery`), `budget`, `timeout`.
- **Commands mean what they say.** `command("look")` is always the world's `look`, even with a
  coder at work. Coding tasks go through `code().run`.
- **HTTP.** Every operation in `marina.http.v1` is called by its operation id or snake_case name,
  with path and query parameters by name and the JSON body:

  ```rust
  use serde_json::json;
  marina.routing().call("discover", &[], None)?;
  let memory = marina.memory(&credential);
  let space = memory.call("create_space", &[], Some(json!({ "name": "notes" })))?["id"].clone();
  let note = json!({ "content": "Deploys run from main" });
  memory.call_with_key("remember", &[("space", space.clone())], Some(note), Some("note-1"))?;
  memory.call("search", &[("space", space)], Some(json!({ "query": "deploy" })))?;
  ```

  `operations()` lists them. A failure is `Error::Api { status, code, message, retry_after_ms }`;
  branch on `code`. Memory writes get an `Idempotency-Key`; pass your own to retry a write
  safely. Redirects are refused, so a token never follows one.
- **Resume.** `Marina::connect_with(url, ConnectOptions::token(&old_token))` within 60 s of a
  drop gives back the same entity, with a new token.
- **Threads.** One SDK thread owns the socket; your `on_event` listeners run on another, in
  order, and may run commands. Dropping `Marina` closes it.

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
```
