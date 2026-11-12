# Marina for Java

Run coding tasks, send commands and use Marina's HTTP APIs from Java. No dependencies: the JDK
only (its own HTTP and WebSocket client), Java 17 or newer.

```java
import ai.h2o.marina.*;
import java.nio.file.Path;

// A Marina for this folder: the same server and saved sessions `marina .` uses.
try (Marina marina = Marina.local(Path.of("my-project"))) {
  CodingRun run = marina.code().run(
      "The last page drops its final item; fix it", Coding.Options.defaults().budget("10m"));
  for (CodingActivity step : run.steps()) System.out.println(step.label());
  RunResult result = run.result();
  System.out.println(result.outcome() + " " + result.verification() + " " + result.summary());
  System.out.println(marina.code().diff());
  marina.code().review(result.runId(), "approve");
} // closing stops the folder's server
```

`Marina.local(folder)` runs `marina serve <folder> --json`, so the `marina` CLI must be installed.
Use `LocalOptions.defaults().command(List.of(...))` to say how to run it, e.g.
`List.of("bun", "run", "/path/to/marina/scripts/marina.ts")`. To use a server that is already
running, connect to it instead:

```java
Marina marina = Marina.connect("ws://localhost:3300", "builder");
System.out.println(marina.command("look").text()); // one world command; throws CommandException if refused
```

## Install

Not on Maven Central yet. From a Marina checkout, `sdks/java` is a plain Maven project
(`ai.h2o:marina-sdk`) with no dependencies; or compile its sources into your build:

```bash
javac --release 17 -d build $(find sdks/java/src/main -name '*.java')
```

## What `marina` offers

| On `marina` | What it is |
|---|---|
| `code().run(task, Coding.Options...)` | a coding task: `steps()`, `events()`, `result()`, `steer()`, `stop()` |
| `code().diff()`, `code().review(runId, verdict)`, `code().onExecApproval(fn)` | the change, your verdict, and answers to the coder's requests to run other commands |
| `command(text)`, `capabilities()`, `onEvent(fn)` | world commands, what this session may run, everything the server sends |
| `routing()`, `investigations()`, `panels()` | the HTTP APIs, signed in as this session |
| `memory(credential)` | the memory API, with a memory credential of its own |
| `session()`, `token()`, `connection()` | who you are, the newest session token, the WebSocket session underneath |

- **Coding.** `run()` returns once the server accepts the task. `steps()` yields each
  `CodingActivity` (`kind`, `label`, `path`, `diff`). `result()` waits for the `RunResult`:
  `outcome` (`submitted` when handed in), `verification` (`passed` only when checks ran on the
  change and passed), `summary`, `budgetForced` when a budget forced the answer. Options:
  `verification("checks" | "candidate" | "delivery")`, `budget("10m")`, `timeout(Duration)`.
- **Commands mean what they say.** `command("look")` is always the world's `look`, even with a
  coder at work. Coding tasks go through `code().run`.
- **HTTP.** Every operation in `marina.http.v1` is called by its operation id, with path and query
  parameters by name and the JSON body (maps and lists):

  ```java
  marina.routing().call("discover");
  HttpApi memory = marina.memory(credential);
  Object space = ((Map<?, ?>) memory.call("createSpace", Map.of(), Map.of("name", "notes"))).get("id");
  memory.call("remember", Map.of("space", space), Map.of("content", "Deploys run from main"), "note-1");
  memory.call("search", Map.of("space", space), Map.of("query", "deploy"));
  ```

  `operations()` lists them; `Operations.ALL` describes each. A failure throws `ApiException`
  with `status()`, `code()` (branch on it), `detail()` and `retryAfterMs()`. Memory writes get an
  `Idempotency-Key`; pass your own (the last argument) to retry a write safely. Redirects are
  refused, so a token never follows one. Replies are `Json` values: `Map`, `List`, `String`,
  `Long`, `Double`, `Boolean`, `null`.
- **Resume.** `Marina.connect(url, Marina.ConnectOptions.token(oldToken))` within 60 s of a drop
  gives back the same entity, with a new token.
- **Threads.** The socket's thread hands frames to the SDK in order; your `onEvent` listeners run
  on one SDK thread, in order, and may run commands. Errors in listeners are logged to the
  `ai.h2o.marina` logger. Every error is an unchecked `MarinaException`.

## The protocols

This SDK is one implementation of Marina's documented protocols, in the repository's `protocol/`
folder: `marina.wire.v1` (WebSocket), `marina.http.v1` (HTTP, OpenAPI 3.1) and `marina.local.v1`
(`marina serve`). The repository's tests hold it to them: a live server runs a whole coding task
through it and checks every coding frame against the schema, and its `Operations` table is
generated from the same source as the OpenAPI document.

## Tests

```bash
bun test test/java-sdk.test.ts        # from the repository: compiles, unit tests, live tests
```
