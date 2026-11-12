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
| `command(text)`, `capabilities()`, `forms(command)`, `onEvent(fn)` | world commands, what this session may run, a command's typed forms, everything the server sends |
| `tell(target, text)`, `say(text)`, `tellAndAwait(target, text, timeout)`, `waitForTell(from, timeout)` | private messages and room speech; ask and wait for the answer |
| `look()`, `who()`, `note(text)`, `recall(query)`, `channel(name, text)`, `task(sub, args...)` | shortcuts for common commands |
| `routing()`, `investigations()`, `panels()` | the HTTP APIs, typed, signed in as this session; `panels().watchChanges(...)` |
| `memory(credential)` | the memory API, typed, with a memory credential of its own |
| `onReconnect(fn)`, `isConnected()` | the session resuming on its own after a dropped socket |
| `session()`, `token()`, `connection()` | who you are, the newest session token, the WebSocket session underneath |

- **Coding.** `run()` returns once the server accepts the task. `steps()` yields each
  `CodingActivity` (`kind`, `label`, `path`, `diff`). `result()` waits for the `RunResult`:
  `outcome` (`submitted` when handed in), `verification` (`passed` only when checks ran on the
  change and passed), `summary`, `budgetForced` when a budget forced the answer. Options:
  `verification("checks" | "candidate" | "delivery")`, `budget("10m")`, `timeout(Duration)`.
- **Commands mean what they say.** `command("look")` is always the world's `look`, even with a
  coder at work. Coding tasks go through `code().run`.
- **HTTP, typed.** Every operation in `marina.http.v1` is a method named by its operation id, with
  its request and reply as records (in `Http`, generated from the OpenAPI document):

  ```java
  Http.MemoryApi memory = marina.memory(credential);
  String space = memory.createSpace(Http.CreateSpaceRequest.of("notes")).id();
  Http.MemoryReceipt receipt =
      memory.remember(space, Http.MemoryRecordInput.of("Deploys run from main").withTier("fact"), "note-1");
  Http.MemorySearchResult found = memory.search(space, Http.MemorySearchInput.of("deploy"));
  Http.RoutingSession a = marina.routing().joinSession(Http.RoutingJoin.of("my-a", "A", "service"));
  ```

  Path parameters come first, then query parameters (an overload leaves them out), the body, and
  for memory writes the `Idempotency-Key`: pass your own to retry a write safely (an overload
  makes a fresh one). Records have a nullable field per JSON field, camelCase (`spaceId` for
  `space_id`); build one with `of(required...)` and `withX(...)`. Enums are `String` (the server
  may add values), unions are `Object` (the raw JSON value). `Json.bind(value, Type.class)` and
  `Json.unbind(record)` convert between records and JSON values.
- **HTTP, untyped.** `call(operationId, params, body, key)` on each group stays for anything newer
  than this SDK, with path and query parameters by name and the body as maps, lists or records;
  `operations()` lists the ids and `Operations.ALL` describes each. Replies are `Json` values:
  `Map`, `List`, `String`, `Long`, `Double`, `Boolean`, `null`.
- **HTTP errors.** A failure throws `ApiException` with `status()`, `code()` (branch on it),
  `detail()` and `retryAfterMs()`. Redirects are refused, so a token never follows one.
- **Memory retry.** `MemoryRetry.run(() -> memory.remember(space, input, key))` sends the same
  request and key again on 408, 429, 502, 503 and 504 and on network errors: a named rate limit
  (`429 rate_limited` with `retry_after_ms`) is waited out exactly and uses no attempt (up to 30 s
  of such waits); other failures back off 250 ms doubling to 2 s, 5 attempts; a server wait over
  5 s is thrown back to you. `MemoryRetry.run(op, attempts, sleeper)` takes your own count and
  sleeper.
- **Reconnect.** When the socket drops, the SDK resumes the session on its own with the newest
  token: up to 10 tries, 3 s apart doubling to 30 s. `onReconnect(fn)` hears each return. A
  command sent meanwhile fails at once with `ConnectionLostException`; retry it once you are back.
  A coding run in flight carries on. `close()` never reconnects; giving up closes the connection.
- **Resume.** `Marina.connect(url, Marina.ConnectOptions.token(oldToken))` within 60 s of a drop
  gives back the same entity, with a new token.
- **Asking another participant.** `tellAndAwait("helper", "status?", Duration.ofSeconds(30))`
  sends the question with a `[re:<id>]` tag and returns the answer without it. A reply that echoes
  the tag wins at once; an untagged one is accepted after 1.5 s. Tells from before the question
  and notices ("I've spent my model-call budget", `[notice] ...`) are never the answer.
  `Tells.Options` turns correlation off or makes it strict. `waitForTell("helper", timeout)` waits
  for the next tell to you (any sender when `null`) and returns its text.
- **Typed command forms.** `forms("say")` reads a command's forms from `capabilities()`; each has
  `syntax`, `fields` (`id`, `label`, `kind`, `choices`, ...) and optional `groups`.
  `CommandForms.compose(form, values, enabled)` fills one in (values by field id or label, optional
  groups switched on by id) with the TypeScript SDK's checks; `ok()` says whether `command()` is
  ready to run, `errors()` says why not, by field id.

  ```java
  CommandForms.Form say = marina.forms("say").get(0);
  CommandForms.Composed c = CommandForms.compose(say, Map.of("message", "hello"), Map.of());
  if (c.ok()) marina.command(c.command());
  ```
- **Panel changes.** `marina.panels().watchChanges(event -> ..., () -> ...)` follows
  `/dashboard-ws`: each `PanelChangeEvent` (`type`, `canvasId`, `nodeId`, ...) is a hint to read
  again, never content; the second callback runs each time the stream (re)starts. It reconnects
  with backoff (1 s doubling to 15 s). It returns a handle that stops watching.
- **Threads.** The socket's thread hands frames to the SDK in order; your `onEvent` listeners run
  on one SDK thread, in order, and may run commands. Errors in listeners are logged to the
  `ai.h2o.marina` logger. Every error is an unchecked `MarinaException`.

## Examples

`src/test/java/ai/h2o/marina/examples/`: `CodingExample` (a coding task in a folder with
`Marina.local`) and `TellAgentExample` (an agent that answers tells). The repository's tests
compile them.

## The protocols

This SDK is one implementation of Marina's documented protocols, in the repository's `protocol/`
folder: `marina.wire.v1` (WebSocket), `marina.http.v1` (HTTP, OpenAPI 3.1) and `marina.local.v1`
(`marina serve`). The repository's tests hold it to them: a live server runs a whole coding task
through it and checks every coding frame against the schema, and its `Operations` table and `Http`
models are generated from the same source as the OpenAPI document. It passes the SDK conformance
suite (`protocol/conformance.md`) that every Marina SDK runs; its driver is
`src/test/java/ai/h2o/marina/Conformance.java`.

## Tests

```bash
bun test test/java-sdk.test.ts        # from the repository: compiles, unit tests, live tests
bun test test/sdk-conformance.test.ts # the conformance scenarios, every SDK
```
