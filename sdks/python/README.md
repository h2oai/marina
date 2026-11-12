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
| `command(text)`, `capabilities()`, `on_event(fn)` | world commands, what this session may run, everything the server sends |
| `routing`, `investigations`, `panels` | the HTTP APIs, signed in as this session |
| `memory(credential)` | the memory API, with a memory credential of its own |
| `session`, `token`, `connection` | who you are, the newest session token, the WebSocket session underneath |

- **Coding.** `run()` returns once the server accepts the task. `steps()` yields each step as a
  `CodingActivity` (`kind`, `label`, `path`, `diff`). `result()` waits for the `RunResult`:
  `outcome` (`submitted` when handed in), `verification` (`passed` only when checks ran on the
  change and passed), `summary`, `budget_forced` when a budget forced the answer. `budget` is
  seconds or `"10m"`.
- **Commands mean what they say.** `command("look")` is always the world's `look`, even with a
  coder at work. Coding tasks go through `code.run`.
- **HTTP.** Every operation in `marina.http.v1` is a method named in snake_case after its
  operation id, taking path and query parameters by name and the JSON body as `body=`:

  ```python
  marina.routing.discover()
  memory = marina.memory(credential)
  space = memory.create_space(body={"name": "notes"})["id"]
  memory.remember(space=space, body={"content": "Deploys run from main"}, idempotency_key="note-1")
  memory.search(space=space, body={"query": "deploy"})
  ```

  `.operations()` lists them. A failure raises `ApiError` with `status`, `code` (branch on it),
  `message` and `retry_after_ms`. Memory writes get an `Idempotency-Key`; pass your own to retry
  a write safely. Redirects are refused, so a token never follows one.
- **Resume.** `Marina.connect(url, token=old_token)` within 60 s of a drop gives back the same
  entity, with a new token.
- **Threads.** One SDK thread reads the socket, another calls your `on_event` listeners in order.
  A listener may run commands. Errors in listeners are logged to the `marina` logger.

## The protocols

This SDK is one implementation of Marina's documented protocols, in the repository's `protocol/`
folder: `marina.wire.v1` (WebSocket, `protocol/README.md`), `marina.http.v1` (HTTP, OpenAPI 3.1,
`protocol/http.md`) and `marina.local.v1` (`marina serve`). The repository's tests hold it to
them: a live server runs a whole coding task through it and checks every coding frame against
the schema, and its HTTP operation table is generated from the same source as the OpenAPI
document.

## Tests

```bash
python3 -m unittest discover -s sdks/python/tests     # offline
bun test test/python-sdk.test.ts                       # live, from the repository
```
