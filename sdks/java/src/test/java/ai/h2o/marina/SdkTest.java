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
    } finally {
      server.stop(0);
    }
  }
}
