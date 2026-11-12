# Marina for Python

Run coding tasks, send commands and use Marina's HTTP APIs from Python. No dependencies: the
standard library only, Python 3.10 or newer.

```python
from marina import Marina

# A Marina for this folder: the same server and saved sessions `marina .` uses.
with Marina.local("./my-project") as marina:
    run = marina.code.run("The last page drops its final item; fix it", budget="10m")
    for step in run.steps():
        print(step.label)              # "Edit paginate.py", "Run checks on a snapshot of the change"
    result = run.result()
    print(result.outcome, result.verification, result.summary)   # submitted passed ...
    print(marina.code.diff())
    marina.code.review(result.run_id, "approve")
# leaving the block stops the folder's server
```

`Marina.local(folder)` runs `marina serve <folder> --json`, so the `marina` CLI must be installed.
Pass `command=[...]` to say how to run it, e.g. `["bun", "run", "/path/to/marina/scripts/marina.ts"]`.
To use a server that is already running, connect to it instead:

```python
marina = Marina.connect("ws://localhost:3300", name="builder")
print(marina.command("look").text)   # one world command; raises CommandError if refused
```

## Install

The package is not on PyPI yet. From a Marina checkout:

```bash
pip install ./sdks/python
```

Or put `sdks/python/src` on `PYTHONPATH`. There is nothing else to install.

## What `marina` offers

| On `marina` | What it is |
|---|---|
| `code.run(task, verification=, budget=, timeout=)` | a coding task: `steps()`, `events()`, `result()`, `steer()`, `stop()` |
| `code.diff()`, `code.review(run_id, verdict)`, `code.on_exec_approval(fn)` | the change, your verdict, and answers to the coder's requests to run other commands |
| `command(text)`, `capabilities()`, `forms(name)`, `on_event(fn)` | world commands, what this session may run, a command's typed forms, everything the server sends |
| `tell`, `say`, `tell_and_await`, `wait_for_tell` | talking to other participants |
| `look`, `who`, `note`, `recall`, `task(...)` | shortcuts, each one world command |
| `routing`, `investigations`, `panels` | the HTTP APIs, typed, signed in as this session; `panels.watch_changes` |
| `memory(credential)` | the memory API, typed, with a memory credential of its own |
| `session`, `token`, `connection`, `on_reconnect(fn)` | who you are, the newest session token, the WebSocket session underneath, its resumes |

- **Coding.** `run()` returns once the server accepts the task. `steps()` yields each step as a
  `CodingActivity` (`kind`, `label`, `path`, `diff`). `result()` waits for the `RunResult`:
  `outcome` (`submitted` when handed in), `verification` (`passed` only when checks ran on the
  change and passed), `summary`, `budget_forced` when a budget forced the answer. `budget` is
  seconds or `"10m"`.
- **Commands mean what they say.** `command("look")` is always the world's `look`, even with a
  coder at work. Coding tasks go through `code.run`.
- **HTTP.** Every operation in `marina.http.v1` is a typed method named in snake_case after its
  operation id: path parameters first, then the JSON body, query parameters by keyword. The
  request and reply types are `TypedDict`s in `marina.models`, generated from the OpenAPI
  document, so a type checker knows every field:

  ```python
  from marina.models import MemoryRecordInput

  marina.routing.discover(limit=20)
  memory = marina.memory(credential)
  space = memory.create_space({"name": "notes"})["id"]
  record: MemoryRecordInput = {"content": "Deploys run from main"}
  receipt = memory.remember(space, record, idempotency_key="note-1")   # a MemoryReceipt
  memory.search(space, {"query": "deploy"})
  ```

  `.operations()` lists them; `.call("operationId", **params)` reaches one by name, including
  any newer than this SDK. A failure raises `ApiError` with `status`, `code` (branch on it),
  `message` and `retry_after_ms`; an unreachable server raises `NetworkError`. Memory writes get
  an `Idempotency-Key`; pass your own to retry a write safely. Redirects are refused, so a token
  never follows one.
- **Memory retry.** `retry_memory(operation)` sends the same request again on 408, 429, 502, 503
  and 504 and on network failures, backing off 250 ms doubling to 2 s, 5 attempts. A named rate
  limit (`429 rate_limited` with `retry_after_ms`) is waited out exactly and uses no attempt, up
  to 30 s of such waits; a server asking for more than 5 s gets its error raised to you. Keep the
  idempotency key the same on every try:

  ```python
  from marina import retry_memory

  retry_memory(lambda: memory.remember(space, {"content": "x"}, idempotency_key="note-2"))
  ```
- **Reconnect.** A dropped socket resumes the session on its own with the newest token: after
  3 s, doubling to 30 s, at most 10 attempts. `session.token` is always the newest (each token
  works once). A command sent meanwhile raises `ConnectionLost` at once: retry it after
  `on_reconnect(fn)` fires. A coding run carries on across a resume; it fails only if resuming
  gives up or you `close()`, which never reconnects. `Marina.connect(url, auto_reconnect=False)`
  turns it off. `Marina.connect(url, token=old_token)` within 60 s of a drop resumes by hand.
- **Agents.** `tell(target, text)` and `say(text)` send; `tell_and_await(target, question,
  timeout=30)` sends and returns the reply. It tags the question ` [re:<id>]` and takes a reply
  echoing the tag at once; an untagged reply wins after `grace` (1.5 s); notices ("I've spent my
  model-call budget") and tells older than the question are never the reply. Raises
  `TellTimeout`. `wait_for_tell(from_=None, timeout=30)` returns the next tell to you.

  ```python
  answer = marina.tell_and_await("helper", "Which branch deploys?")
  question = marina.wait_for_tell("helper")
  marina.tell("helper", f"answer: {question}")
  ```
- **Typed command forms.** Each command in `capabilities()` carries its `forms`, the grammar
  broken into fields. `compose_command(form, values, enabled)` fills one in, with the TypeScript
  SDK's checks; `values` are keyed by field id or label, `enabled` turns optional groups on:

  ```python
  from marina import compose_command

  form = next(f for f in marina.forms("say") if f["syntax"].startswith("say "))
  composed = compose_command(form, {"message": "hello"})
  if not composed.errors:
      marina.command(composed.command)
  ```
- **Panel events.** `stop = marina.panels.watch_changes(on_event, on_snapshot)` follows
  `/dashboard-ws`. `on_snapshot()` runs each time the stream opens; `on_event(event)` names what
  changed (`type`, `canvasId`, ...) and is never content: read the panel again. A dropped stream
  reopens after 1 s, doubling to 15 s. `stop()` ends it.
- **Threads.** One SDK thread reads the socket, another calls your `on_event` listeners in order.
  A listener may run commands. Errors in listeners are logged to the `marina` logger.

## Examples

- `examples/coding.py <folder> "<task>"`: one coding task through `Marina.local`, its steps and
  its change.
- `examples/answer_tells.py <url> <name>`: an agent that answers every tell, echoing the
  question's correlation tag.

## The protocols

This SDK is one implementation of Marina's documented protocols, in the repository's `protocol/`
folder: `marina.wire.v1` (WebSocket, `protocol/README.md`), `marina.http.v1` (HTTP, OpenAPI 3.1,
`protocol/http.md`) and `marina.local.v1` (`marina serve`). The repository's tests hold it to
them: a live server runs a whole coding task through it and checks every coding frame against
the schema, its HTTP operation table and typed models are generated from the same source as the
OpenAPI document, and it passes the same conformance scenarios as every other Marina SDK
(`protocol/conformance.md`, driver `tests/conformance.py`).

## Tests

```bash
python3 -m unittest discover -s sdks/python/tests     # offline
bun test test/python-sdk.test.ts                       # live, from the repository
bun test test/sdk-conformance.test.ts                  # the conformance scenarios, every SDK
```
