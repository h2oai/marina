// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Unit tests: no server, no dependencies. Run: {@code java -cp <classes> ai.h2o.marina.SdkTest}.
 * Exits 1 on the first failure.
 */
public final class SdkTest {
  private static int passed;

  public static void main(String[] args) throws Exception {
    test("JSON reads and writes Marina's frames", SdkTest::json);
    test("frames are classified in the protocol's order", SdkTest::classify);
    test("a step and a run's end are read", SdkTest::codingEvents);
    test("exec approvals: only true approves", SdkTest::approvals);
    test("budgets and endpoints", SdkTest::budgetsAndEndpoints);
    test("a command error states the refusal once", SdkTest::commandError);
    test("HTTP: every operation, path, query, body and key", SdkTest::http);
    test("tells: notices, correlation tags, which reply answers", SdkTest::tells);
    test("command forms compose with the TypeScript rules", SdkTest::forms);
    test("memory retry: named waits, backoff, hand-back", SdkTest::retry);
    test("reconnect and panel-stream backoff schedules", SdkTest::backoff);
    test("typed models bind and unbind with JSON names", SdkTest::models);
    System.err.println("OK " + passed + " tests");
  }

  interface Body {
    void run() throws Exception;
  }

  private static void test(String name, Body body) {
    try {
      body.run();
      passed++;
    } catch (Throwable t) {
      System.err.println("FAIL " + name);
      t.printStackTrace();
      System.exit(1);
    }
  }

  static void check(boolean ok, String what) {
    if (!ok) throw new AssertionError(what);
  }

  static void same(Object expected, Object actual) {
    if (expected == null ? actual != null : !expected.equals(actual))
      throw new AssertionError("expected " + expected + " but was " + actual);
  }

  static void throwsIllegal(Runnable r) {
    try {
      r.run();
    } catch (IllegalArgumentException expected) {
      return;
    }
    throw new AssertionError("expected IllegalArgumentException");
  }

  static void json() {
    String text =
        "{\"kind\":\"message\",\"timestamp\":1762905612000,\"data\":{\"text\":\"é \\u2192 \\\"q\\\"\\n\","
            + "\"list\":[1,2.5,-3e2,true,null,\"x\"],\"big\":12345678901234567890}}";
    Map<String, Object> frame = Json.object(Json.parse(text));
    Map<String, Object> data = Json.object(frame.get("data"));
    same(1762905612000L, frame.get("timestamp"));
    same("é → \"q\"\n", data.get("text"));
    same(List.of(1L, 2.5, -300.0, true, "x"), filterNull(Json.array(data.get("list"))));
    check(data.get("big") instanceof Double, "an integer beyond long is a double");
    same(Json.write(frame), Json.write(Json.parse(Json.write(frame))));
    same("{\"a\":[1,\"\\u0001\"],\"b\":null}", Json.write(mapOf("a", List.of(1, "\u0001"), "b", null)));
    throwsIllegal(() -> Json.parse("{\"a\":}"));
    throwsIllegal(() -> Json.parse("[1,2"));
    throwsIllegal(() -> Json.parse("{} extra"));
  }

  static List<Object> filterNull(List<Object> list) {
    List<Object> out = new ArrayList<>();
    for (Object o : list) if (o != null) out.add(o);
    return out;
  }

  static Map<String, Object> mapOf(Object... kv) {
    Map<String, Object> m = new LinkedHashMap<>();
    for (int i = 0; i < kv.length; i += 2) m.put((String) kv[i], kv[i + 1]);
    return m;
  }

  static Map<String, Object> frame(String json) {
    return Json.object(Json.parse(json));
  }

  static void classify() {
    Object[][] cases = {
      {"{\"kind\":\"auth_error\",\"data\":{\"text\":\"x\"}}", Wire.Kind.AUTH_ERROR},
      {"{\"kind\":\"error\",\"data\":{\"text\":\"x\",\"command_result\":{}}}", Wire.Kind.ERROR},
      {"{\"kind\":\"system\",\"data\":{\"command_result\":{\"request_id\":\"1\",\"ok\":true}}}", Wire.Kind.COMMAND_RESULT},
      {"{\"kind\":\"system\",\"data\":{\"entityId\":\"e_1\",\"token\":\"t\"}}", Wire.Kind.SESSION},
      {"{\"kind\":\"system\",\"data\":{\"protocol\":\"marina.wire.v1\",\"schema\":\"/api/protocol\"}}", Wire.Kind.WELCOME},
      {"{\"kind\":\"system\",\"tag\":\"capabilities\",\"data\":{}}", Wire.Kind.CAPABILITIES_REPLY},
      {"{\"kind\":\"message\",\"data\":{\"execApproval\":{\"token\":\"t\"},\"code\":{}}}", Wire.Kind.EXEC_APPROVAL},
      {"{\"kind\":\"message\",\"tag\":\"code\",\"data\":{\"code\":{\"event\":\"x\"}}}", Wire.Kind.CODE},
      {"{\"kind\":\"message\",\"tag\":\"tell\",\"data\":{}}", Wire.Kind.TELL},
      {"{\"kind\":\"room\",\"data\":{\"text\":\"A room\"}}", Wire.Kind.OUTPUT},
    };
    for (Object[] c : cases) same(c[1], Wire.classify(frame((String) c[0])));
  }

  static void codingEvents() {
    CodeEvent step =
        Wire.codeEvent(
            frame(
                "{\"kind\":\"message\",\"tag\":\"code\",\"data\":{\"text\":\"Edit a.ts\",\"code\":{\"event\":\"agent_output\","
                    + "\"type\":\"stream\",\"sessionId\":\"s\",\"metadata\":{\"kind\":\"tool\",\"activity\":{\"kind\":\"edit\","
                    + "\"label\":\"Edit a.ts\",\"path\":\"a.ts\",\"diff\":[\"-a\",\"+b\"],\"more\":2}}}}}"));
    same("tool", step.kind());
    same(new CodingActivity("edit", "Edit a.ts", "a.ts", List.of("-a", "+b"), 2L, null), step.activity());
    // A blocked run carries its phase on the event, not in the metadata.
    CodeEvent end =
        Wire.codeEvent(
            frame(
                "{\"kind\":\"message\",\"data\":{\"text\":\"t\",\"code\":{\"event\":\"code_lifecycle\",\"type\":\"lifecycle\","
                    + "\"phase\":\"failed\",\"metadata\":{\"runId\":\"task_run_1\",\"reason\":\"blocked\",\"terminal\":true,"
                    + "\"outcome\":\"interrupted\",\"taskId\":7,\"budgetForced\":{\"reason\":\"spend\",\"used\":3}}}}}"));
    RunResult r = end.result();
    same("task_run_1", r.runId());
    same("failed", r.phase());
    same(7L, r.taskId());
    same(new BudgetForced("spend", 3.0, null), r.budgetForced());
    check(!r.submitted() && !r.verified(), "not submitted, not verified");
    same("failed", r.raw().get("phase"));
    check(
        Wire.codeEvent(frame("{\"data\":{\"code\":{\"event\":\"code_lifecycle\",\"metadata\":{\"runId\":\"r\"}}}}")).result() == null,
        "no terminal flag, no end");
    check(Wire.execApproval(frame("{\"data\":{\"execApproval\":{\"token\":\"t\"}}}")) == null, "an incomplete request");
  }

  static void approvals() {
    ExecApprovalRequest request = new ExecApprovalRequest("tok", List.of("make"), "/w", "make");
    same("code exec-approve tok", Coding.answer(r -> true, request));
    same("code exec-deny tok", Coding.answer(r -> false, request));
    same(
        "code exec-deny tok",
        Coding.answer(
            r -> {
              throw new IllegalStateException("handler broke");
            },
            request));
  }

  static void budgetsAndEndpoints() {
    same("90s", Coding.budgetArgument(Duration.ofSeconds(90)));
    same("1s", Coding.budgetArgument(Duration.ofMillis(200)));
    same("10m", Coding.budgetArgument("10m"));
    throwsIllegal(() -> Coding.budgetArgument("ten minutes"));
    throwsIllegal(() -> Coding.budgetArgument(Duration.ZERO));
    same(List.of("ws://127.0.0.1:3300/ws", "http://127.0.0.1:3300"), List.of(Connection.endpoints("http://127.0.0.1:3300/")));
    same(List.of("ws://localhost:3300/ws", "http://localhost:3300"), List.of(Connection.endpoints("ws://localhost:3300/ws")));
    same(List.of("wss://m.example/world/ws", "https://m.example/world"), List.of(Connection.endpoints("wss://m.example/world")));
    throwsIllegal(() -> Connection.endpoints("ws://u:p@host"));
    throwsIllegal(() -> Marina.connect("ws://127.0.0.1:1", new Marina.ConnectOptions(null, null, "agent", null, null)));
  }

  static void commandError() {
    CommandException e =
        new CommandException(
            "No such room.",
            List.of(frame("{\"data\":{\"text\":\"No such room. Try look.\"}}"), frame("{\"data\":{\"text\":\"x\"}}")));
    check(e.getMessage().startsWith("No such room. Try look."), e.getMessage());
    check(e.getMessage().contains("x"), "keeps the other output");
    same("No such room.", e.reason());
  }

  record Seen(String method, String path, Map<String, List<String>> headers, String body) {}

  static void http() throws IOException {
    same(117, Operations.ALL.size());
    same(
        java.util.Set.of("memory", "routing", "investigations", "panels"),
        new java.util.HashSet<>(Operations.ALL.values().stream().map(Operations.Operation::tag).toList()));
    List<Seen> seen = new ArrayList<>();
    HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.createContext(
        "/",
        exchange -> {
          String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
          String path = exchange.getRequestURI().getRawPath();
          String query = exchange.getRequestURI().getRawQuery();
          seen.add(new Seen(exchange.getRequestMethod(), path + (query == null ? "" : "?" + query), exchange.getRequestHeaders(), body));
          int status = 200;
          String reply = "{\"ok\":true}";
          if (path.contains("memfail")) {
            status = 429;
            reply = "{\"error\":{\"code\":\"rate_limited\",\"message\":\"slow\",\"retry_after_ms\":1500}}";
            exchange.getResponseHeaders().add("Retry-After", "2");
          } else if (path.contains("gone")) {
            status = 404;
            reply = "{\"error\":\"No session\",\"code\":\"not_found\"}";
          } else if (path.contains("redirect")) {
            status = 302;
            exchange.getResponseHeaders().add("Location", "http://elsewhere.invalid/");
          }
          byte[] bytes = reply.getBytes(StandardCharsets.UTF_8);
          exchange.getResponseHeaders().add("Content-Type", "application/json");
          exchange.sendResponseHeaders(status, bytes.length);
          exchange.getResponseBody().write(bytes);
          exchange.close();
        });
    server.start();
    try {
      String base = "http://127.0.0.1:" + server.getAddress().getPort();
      HttpApi memory = new HttpApi(base, () -> "cred", "memory");
      memory.call("remember", Map.of("space", "a b/c"), Map.of("content", "x"), "k1");
      memory.call("get", Map.of("space", "s", "id", "r1", "version", 3));
      same("POST", seen.get(0).method());
      same("/v1/memory/spaces/a%20b%2Fc/records", seen.get(0).path());
      same(List.of("Bearer cred"), seen.get(0).headers().get("Authorization"));
      same(List.of("k1"), seen.get(0).headers().get("Idempotency-key"));
      same(Map.of("content", "x"), Json.parse(seen.get(0).body()));
      same("/v1/memory/spaces/s/records/r1?version=3", seen.get(1).path());
      check(seen.get(1).headers().get("Idempotency-key") == null, "a read takes no key");
      memory.call("createSpace", Map.of(), Map.of("name", "n"));
      check(seen.get(2).headers().get("Idempotency-key") != null, "a write without a key gets one");
      int before = seen.size();
      throwsIllegal(() -> memory.call("get", Map.of("id", "r1")));
      throwsIllegal(() -> memory.call("remember", Map.of("space", "s")));
      throwsIllegal(() -> memory.call("me", Map.of("bogus", 1)));
      throwsIllegal(() -> memory.call("discover"));
      same(before, seen.size());
      check(new HttpApi(base, () -> "t", "routing").operations().contains("discover"), "routing lists discover");
      try {
        memory.call("space", Map.of("space", "memfail"));
        throw new AssertionError("expected 429");
      } catch (ApiException e) {
        same(429, e.status());
        same("rate_limited", e.code());
        same(1500L, e.retryAfterMs());
      }
      HttpApi routing = new HttpApi(base, () -> "session-token", "routing");
      try {
        routing.call("leave", Map.of("session", "gone"), Map.of());
        throw new AssertionError("expected 404");
      } catch (ApiException e) {
        same(404, e.status());
        same("not_found", e.code());
      }
      same(List.of("Bearer session-token"), seen.get(seen.size() - 1).headers().get("Authorization"));
      try {
        memory.call("space", Map.of("space", "redirect"));
        throw new AssertionError("expected the redirect to be refused");
      } catch (ApiException e) {
        same(302, e.status());
      }
      // Typed: the same request, the record written with its JSON names, the reply bound.
      Http.MemoryApi typed = new Http.MemoryApi(base, () -> "cred");
      typed.remember("s", Http.MemoryRecordInput.of("x").withSourceIds(List.of("src")), "k2");
      Seen last = seen.get(seen.size() - 1);
      same("/v1/memory/spaces/s/records", last.path());
      same(List.of("k2"), last.headers().get("Idempotency-key"));
      same(mapOf("content", "x", "source_ids", List.of("src")), Json.parse(last.body()));
      typed.get("s", "r1", 2L);
      same("/v1/memory/spaces/s/records/r1?version=2", seen.get(seen.size() - 1).path());
      new Http.RoutingApi(base, () -> "t").acknowledgeMessage("a", "m");
      same("{}", seen.get(seen.size() - 1).body());
    } finally {
      server.stop(0);
    }
  }

  static Map<String, Object> tell(String sender, String text, long timestamp) {
    Map<String, Object> data = mapOf("text", text, "message", text);
    if (sender != null) data.put("senderName", sender);
    return mapOf("kind", "message", "tag", "tell", "timestamp", timestamp, "data", data);
  }

  static void tells() {
    check(Tells.isNotice("  [notice] paused"), "a [notice]");
    check(Tells.isNotice("I've spent my model-call budget for now"), "a budget notice");
    check(Tells.isNotice("I've hit a spend cap and paused."), "a pause notice");
    check(Tells.isNotice("I've hit 3 consecutive upstream errors"), "an upstream notice");
    check(!Tells.isNotice("pong"), "a reply");
    same(" [re:abc123]", Tells.correlationTag("abc123"));
    check(Tells.newCorrelationId().matches("[a-z0-9]{6}"), "six base-36 characters");
    check(Tells.hasCorrelationTag("pong [re:abc123]", "abc123"), "bracketed");
    check(Tells.hasCorrelationTag("pong re:abc123", "abc123"), "bare");
    check(!Tells.hasCorrelationTag("pong [re:abc124]", "abc123"), "another id");
    same("pong", Tells.stripCorrelationTag("pong [re:abc123]", "abc123"));

    long sent = 1_000_000;
    // Before our echo: an older tell from the target is stale; a newer one counts.
    Tells.Await a = new Tells.Await("Peer", "ping", sent, Tells.Options.defaults(), "abc123");
    same("ping [re:abc123]", a.outgoing);
    same(null, a.accept(tell("Peer", "old answer", sent - 5)));
    same(null, a.accept(tell("Other", "pong [re:abc123]", sent + 1)));
    same(null, a.accept(tell("Peer", "[notice] paused", sent + 1)));
    same("pong", a.accept(tell("peer", "pong [re:abc123]", sent + 1)));
    // After the echo, any tell from the target is fresh; an untagged one is held as a candidate.
    Tells.Await b = new Tells.Await("Peer", "ping", sent, Tells.Options.defaults(), "zzz999");
    same(null, b.accept(tell(null, "You tell Peer: ping [re:zzz999]", sent - 100)));
    same(null, b.accept(tell("Peer", "untagged", sent - 50)));
    same("untagged", b.candidate);
    same(null, b.accept(tell("Peer", "second untagged", sent + 1)));
    same("untagged", b.candidate);
    same("tagged", b.accept(tell("Peer", "tagged re:zzz999", sent + 2)));
    // Strict: only the tagged reply; no correlation: the first fresh reply.
    Tells.Await c = new Tells.Await("Peer", "q", sent, Tells.Options.defaults().strictCorrelation(true), "id0001");
    same(null, c.accept(tell("Peer", "untagged", sent + 1)));
    same(null, c.candidate);
    Tells.Await d = new Tells.Await("Peer", "q", sent, Tells.Options.defaults().correlate(false), "id0001");
    same("q", d.outgoing);
    same("plain", d.accept(tell("Peer", "plain", sent + 1)));
  }

  static CommandForms.Form form(String json) {
    return CommandForms.Form.from(Json.object(Json.parse(json)));
  }

  static void forms() {
    Map<String, Object> capabilities =
        frame(
            "{\"commands\":[{\"name\":\"say\",\"forms\":[{\"syntax\":\"say <message>\",\"label\":\"say <message>\","
                + "\"fields\":[{\"id\":\"field-0\",\"label\":\"message\",\"placeholder\":\"message\",\"kind\":\"text\","
                + "\"multiline\":true,\"allowNewlines\":false}],\"groups\":[],\"parts\":[{\"literal\":\"say\"},{\"field\":\"field-0\"}]}]}]}");
    CommandForms.Form say = CommandForms.forms(capabilities, "say").get(0);
    same(Map.of("field-0", "Required"), CommandForms.compose(say, Map.of(), Map.of()).errors());
    same("say hello there", CommandForms.compose(say, Map.of("field-0", "  hello there "), Map.of()).command());
    same("say hi", CommandForms.compose(say, Map.of("message", "hi"), Map.of()).command());
    same("Use a single line", CommandForms.compose(say, Map.of("field-0", "a\nb"), Map.of()).errors().get("field-0"));

    CommandForms.Form task =
        form(
            "{\"syntax\":\"task list [limit:<n>] [status:<open|done>] [meta:<json>]\",\"label\":\"x\",\"fields\":["
                + "{\"id\":\"field-0\",\"label\":\"limit\",\"placeholder\":\"n\",\"kind\":\"number\",\"multiline\":false,"
                + "\"allowNewlines\":false,\"min\":1,\"max\":50,\"integer\":true},"
                + "{\"id\":\"field-1\",\"label\":\"status\",\"placeholder\":\"open|done\",\"kind\":\"choice\","
                + "\"choices\":[\"open\",\"done\"],\"multiline\":false,\"allowNewlines\":false},"
                + "{\"id\":\"field-2\",\"label\":\"meta\",\"placeholder\":\"json\",\"kind\":\"json\",\"multiline\":true,"
                + "\"allowNewlines\":false}],"
                + "\"groups\":[{\"id\":\"option-0\",\"label\":\"limit:n\"},{\"id\":\"option-1\",\"label\":\"s\"},{\"id\":\"option-2\",\"label\":\"m\"}],"
                + "\"parts\":[{\"literal\":\"task\"},{\"literal\":\"list\"},"
                + "{\"group\":\"option-0\",\"children\":[{\"literal\":\"limit:\"},{\"field\":\"field-0\"}]},"
                + "{\"group\":\"option-1\",\"children\":[{\"literal\":\"status:\"},{\"field\":\"field-1\"}]},"
                + "{\"group\":\"option-2\",\"children\":[{\"literal\":\"meta:\"},{\"field\":\"field-2\"}]}]}");
    same("task list", CommandForms.compose(task, Map.of(), Map.of()).command());
    Map<String, Boolean> all = Map.of("option-0", true, "option-1", true, "option-2", true);
    CommandForms.Composed ok =
        CommandForms.compose(task, Map.of("field-0", "0x10", "field-1", "done", "field-2", "{ \"a\" : [1, 2] }"), all);
    same(Map.of(), ok.errors());
    same("task list limit:0x10 status:done meta:{\"a\":[1,2]}", ok.command());
    Map<String, String> bad =
        CommandForms.compose(task, Map.of("field-0", "2.5", "field-1", "maybe", "field-2", "{nope"), all).errors();
    same("Enter an integer", bad.get("field-0"));
    same("Choose one of the available values", bad.get("field-1"));
    same("Enter valid JSON", bad.get("field-2"));
    same("Enter a number between 1 and 50", CommandForms.compose(task, Map.of("field-0", "99"), all).errors().get("field-0"));
    same("Enter a number", CommandForms.compose(task, Map.of("field-0", "ten"), all).errors().get("field-0"));
    same("Use one value without spaces", CommandForms.compose(task, Map.of("field-0", "1 2"), all).errors().get("field-0"));
    same(
        Map.of("form", "Use this form's named tool, or choose a command form"),
        CommandForms.compose(form("{\"encoding\":\"named\",\"syntax\":\"x\",\"parts\":[]}"), Map.of(), Map.of()).errors());
    same(16.0, CommandForms.jsNumber("0x10"));
    same(-1500.0, CommandForms.jsNumber("-1.5e3"));
    check(Double.isNaN(CommandForms.jsNumber("12abc")), "not a number");
  }

  static ApiException limited(long ms) {
    return new ApiException(429, "rate_limited", "slow down", ms);
  }

  static void retry() {
    // Named rate-limit waits are exact (+5 ms) and use no attempt.
    List<Long> slept = new ArrayList<>();
    int[] calls = {0};
    String value =
        MemoryRetry.run(
            () -> {
              if (++calls[0] <= 6) throw limited(100);
              return "ok";
            },
            1,
            slept::add);
    same("ok", value);
    same(List.of(105L, 105L, 105L, 105L, 105L, 105L), slept);
    // Other transient failures back off 250 ms doubling to 2 s, within the attempts.
    slept.clear();
    calls[0] = 0;
    try {
      MemoryRetry.run(
          () -> {
            calls[0]++;
            throw new ApiException(503, "unavailable", "", null);
          },
          6,
          slept::add);
      throw new AssertionError("expected the last failure");
    } catch (ApiException e) {
      same(503, e.status());
    }
    same(6, calls[0]);
    same(List.of(250L, 500L, 1000L, 2000L, 2000L), slept);
    // A network error is retried; a refusal is not; a server wait over 5 s is handed back.
    slept.clear();
    calls[0] = 0;
    same(
        "back",
        MemoryRetry.run(
            () -> {
              if (++calls[0] == 1) throw new MarinaException("Could not reach", new java.io.IOException("reset"));
              return "back";
            },
            5,
            slept::add));
    same(List.of(250L), slept);
    slept.clear();
    for (MarinaException e :
        List.of(new ApiException(409, "version_conflict", "", null), limited(6000), new MarinaException("no"))) {
      try {
        MemoryRetry.run(
            () -> {
              throw e;
            },
            5,
            slept::add);
        throw new AssertionError("expected " + e);
      } catch (MarinaException thrown) {
        same(e, thrown);
      }
    }
    same(List.of(), slept);
    // Named waits stop at 30 s in all.
    slept.clear();
    try {
      MemoryRetry.run(
          () -> {
            throw limited(4000);
          },
          5,
          slept::add);
      throw new AssertionError("expected the cap");
    } catch (ApiException e) {
      same(7, slept.size());
    }
    same(500L, MemoryRetry.backoffMs(2, 300L));
    same(900L, MemoryRetry.backoffMs(1, 900L));
    throwsIllegal(() -> MemoryRetry.run(() -> "x", 0, ms -> {}));
  }

  static void backoff() {
    List<Long> delays = new ArrayList<>();
    for (int i = 0; i < Connection.RECONNECT_ATTEMPTS; i++) delays.add(Connection.reconnectDelayMs(i));
    same(List.of(3000L, 6000L, 12000L, 24000L, 30000L, 30000L, 30000L, 30000L, 30000L, 30000L), delays);
    same(10, Connection.RECONNECT_ATTEMPTS);
    same(1000L, PanelsGroup.watchDelayMs(0));
    same(8000L, PanelsGroup.watchDelayMs(3));
    same(15000L, PanelsGroup.watchDelayMs(4));
    same(15000L, PanelsGroup.watchDelayMs(60));
  }

  static void models() {
    String text =
        "{\"id\":\"r1\",\"space_id\":\"s\",\"version\":2,\"content\":\"Deploys run from main\","
            + "\"source_ids\":[\"a\",\"b\"],\"dependency_versions\":{\"r0\":1},\"metadata\":{\"k\":[1,true]},"
            + "\"stale_reason\":{\"kind\":\"superseded\"},\"something_newer\":1}";
    Http.MemoryRecord record = Json.bind(Json.parse(text), Http.MemoryRecord.class);
    same("r1", record.id());
    same("s", record.spaceId());
    same(2.0, record.version());
    same(List.of("a", "b"), record.sourceIds());
    same(Map.of("r0", 1.0), record.dependencyVersions());
    same("superseded", record.staleReason().kind());
    same(null, record.tier());
    // Back to JSON: the JSON names, no null fields, unknown fields gone.
    Map<String, Object> back = Json.object(Json.unbind(record));
    same("s", back.get("space_id"));
    check(!back.containsKey("tier") && !back.containsKey("something_newer"), "no nulls, no unknown fields");
    same(record, Json.bind(Json.parse(Json.write(record)), Http.MemoryRecord.class));
    @SuppressWarnings("unchecked")
    List<Http.MemoryReceipt> receipts =
        (List<Http.MemoryReceipt>) Json.bind(Json.parse("[{\"id\":\"x\",\"job_id\":\"j\"}]"), Json.listOf(Http.MemoryReceipt.class));
    same("j", receipts.get(0).jobId());
    same(Http.MemoryRecordInput.of("c").withTier("fact"), Json.bind(Json.parse("{\"content\":\"c\",\"tier\":\"fact\"}"), Http.MemoryRecordInput.class));
    throwsIllegal(() -> Json.bind(Json.parse("{\"id\":5}"), Http.MemoryReceipt.class));
    throwsIllegal(() -> Json.bind(Json.parse("[1]"), Http.MemoryReceipt.class));
  }
}
