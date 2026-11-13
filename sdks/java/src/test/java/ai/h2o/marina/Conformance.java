// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;

/**
 * The Java SDK's conformance driver (protocol/conformance.md), using the SDK's public API only.
 *
 * <pre>java -cp classes ai.h2o.marina.Conformance &lt;scenario&gt; &lt;server url&gt; '&lt;args JSON&gt;'</pre>
 */
public final class Conformance {
  private static final BufferedReader STDIN =
      new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
  private static Map<String, Object> args = Map.of();
  private static String url = "";
  private static String name = "javadriver";

  private Conformance() {}

  public static void main(String[] argv) {
    String scenario = argv.length > 0 ? argv[0] : "";
    url = argv.length > 1 ? argv[1] : "";
    args = Json.object(Json.parse(argv.length > 2 ? argv[2] : "{}"));
    name = String.valueOf(args.getOrDefault("name", "javadriver"));
    try {
      Map<String, Object> report =
          switch (scenario) {
            case "coding" -> coding();
            case "commands" -> commands();
            case "reconnect" -> reconnect();
            case "agent" -> agent();
            case "memory" -> memory();
            case "panels" -> panels();
            case "routing" -> routing();
            case "local" -> local();
            default -> throw new IllegalArgumentException("unknown scenario " + scenario);
          };
      say(Map.of("report", report));
      System.exit(0);
    } catch (Throwable t) {
      java.io.StringWriter trace = new java.io.StringWriter();
      t.printStackTrace(new java.io.PrintWriter(trace));
      say(Map.of("error", trace.toString()));
      System.exit(1);
    }
  }

  private static void say(Map<String, Object> line) {
    System.out.println(Json.write(line));
    System.out.flush();
  }

  /** Tell the test we are waiting, then wait for its "go" line. */
  private static Map<String, Object> ready(Map<String, Object> info) throws Exception {
    say(Map.of("ready", info));
    String line = STDIN.readLine();
    if (line == null) return Map.of();
    Map<String, Object> go = Json.object(Json.object(Json.parse(line)).get("go"));
    return go == null ? Map.of() : go;
  }

  private static boolean until(BooleanSupplier check, long ms) throws InterruptedException {
    long end = System.currentTimeMillis() + ms;
    while (!check.getAsBoolean() && System.currentTimeMillis() < end) Thread.sleep(20);
    return check.getAsBoolean();
  }

  private static String text(CommandResult frames) {
    List<String> lines = new ArrayList<>();
    for (Map<String, Object> f : frames) {
      Object data = f.get("data");
      Map<String, Object> d = Json.object(data);
      lines.add(d != null && d.get("text") != null ? String.valueOf(d.get("text")) : "");
    }
    return String.join("\n", lines);
  }

  /** A typed record with the protocol's field names, no null fields, without {@code raw}. */
  private static Object wire(Object record) {
    Map<String, Object> out = Json.object(Json.unbind(record));
    if (out != null) out.remove("raw");
    return out;
  }

  static Map<String, Object> coding() throws Exception {
    try (Marina marina = Marina.connect(url, name)) {
      ready(Map.of("entity", marina.session().entityId()));
      List<Map<String, Object>> frames = Collections.synchronizedList(new ArrayList<>());
      marina.onEvent(
          f -> {
            if (Wire.classify(f) == Wire.Kind.CODE) frames.add(f);
          });
      CodingRun run =
          marina
              .code()
              .run(
                  String.valueOf(args.get("task")),
                  Coding.Options.defaults().verification("candidate").timeout(Duration.ofMinutes(2)));
      List<CodeEvent> events = new ArrayList<>();
      for (CodeEvent e : run.events()) events.add(e);
      RunResult result = run.result();
      List<Object> steps = new ArrayList<>();
      for (CodeEvent e : events) if (e.activity() != null) steps.add(wire(e.activity()));
      CodeEvent last = events.isEmpty() ? null : events.get(events.size() - 1);
      Map<String, Object> report = new LinkedHashMap<>();
      report.put("run_id", run.runId());
      report.put("result", result.raw());
      report.put("typed_result", wire(result));
      report.put("submitted", result.submitted());
      report.put("summary", result.summary());
      report.put("steps", steps);
      report.put("last_event_run", last != null && last.result() != null ? last.result().runId() : null);
      report.put("diff", marina.code().diff());
      marina.code().review(result.runId(), "approve");
      // Wait for the listener thread to hand over every frame it has.
      Thread.sleep(100);
      synchronized (frames) {
        report.put("frames", new ArrayList<>(frames));
      }
      return report;
    }
  }

  static Map<String, Object> commands() {
    try (Marina marina = Marina.connect(url, name)) {
      String look = text(marina.command("look"));
      String refused = "";
      try {
        marina.command("frobnicate the moon");
      } catch (CommandException e) {
        refused = e.getMessage();
      }
      Map<String, Object> manifest = marina.capabilities();
      CommandForms.Form form = null;
      for (CommandForms.Form f : CommandForms.forms(manifest, "say"))
        if (form == null && f.syntax().startsWith("say ")) form = f;
      if (form == null) throw new IllegalStateException("no say form");
      CommandForms.Field field = form.field("message");
      if (field == null) field = form.fields().get(0);
      CommandForms.Composed missing = CommandForms.compose(form, Map.of(), Map.of());
      CommandForms.Composed composed = CommandForms.compose(form, Map.of(field.id(), "hello from " + name), Map.of());
      String said = text(marina.command(composed.command()));
      Map<String, Object> report = new LinkedHashMap<>();
      report.put("look", look);
      report.put("refused", refused);
      report.put("capability_count", Json.array(manifest.get("commands")).size());
      report.put("composed", composed.command());
      report.put("missing_errors", missing.errors().size());
      report.put("said", said);
      return report;
    }
  }

  static Map<String, Object> reconnect() throws Exception {
    try (Marina marina = Marina.connect(url, name)) {
      String entity = marina.session().entityId();
      String token = marina.token();
      AtomicInteger reconnects = new AtomicInteger();
      marina.onReconnect(session -> reconnects.incrementAndGet());
      ready(Map.of("entity", entity));
      boolean back = until(() -> reconnects.get() > 0 && marina.isConnected(), 30_000);
      boolean look = back && !marina.look().isEmpty();
      Map<String, Object> report = new LinkedHashMap<>();
      report.put("reconnected", back);
      report.put("same_entity", marina.session().entityId().equals(entity));
      report.put("token_changed", !marina.token().equals(token));
      report.put("look_ok", look);
      return report;
    }
  }

  static Map<String, Object> agent() throws Exception {
    try (Marina marina = Marina.connect(url, name)) {
      String peer = String.valueOf(args.get("peer"));
      String reply = marina.tellAndAwait(peer, "ping", Duration.ofSeconds(15));
      ready(Map.of("listening", true));
      String heard = marina.waitForTell(peer, Duration.ofSeconds(15));
      marina.tell(peer, "answer: " + heard);
      Map<String, Object> report = new LinkedHashMap<>();
      report.put("reply", reply);
      report.put("heard", heard);
      return report;
    }
  }

  static Map<String, Object> memory() {
    try (Marina marina = Marina.connect(url, name)) {
      Http.MemoryApi memory = marina.memory(String.valueOf(args.get("credential")));
      String space = memory.createSpace(Http.CreateSpaceRequest.of(name + "-space")).id();
      Http.MemoryRecordInput input = Http.MemoryRecordInput.of("Deploys run from main");
      Http.MemoryReceipt first = memory.remember(space, input, "conf-1");
      Http.MemoryReceipt again = memory.remember(space, input, "conf-1");
      Http.MemoryRecord record = memory.get(space, first.id());
      Http.MemorySearchResult found = memory.search(space, Http.MemorySearchInput.of("deploy"));
      AtomicInteger waits = new AtomicInteger();
      int count = ((Number) args.getOrDefault("burst", 140L)).intValue();
      for (int i = 0; i < count; i++) {
        Http.MemoryRecordInput note = Http.MemoryRecordInput.of("note " + i);
        MemoryRetry.run(
            () -> memory.remember(space, note),
            5,
            ms -> {
              waits.incrementAndGet();
              Thread.sleep(ms);
            });
      }
      Map<String, Object> report = new LinkedHashMap<>();
      report.put("space", space);
      report.put("receipt_id", first.id());
      report.put("replayed", first.id().equals(again.id()) && java.util.Objects.equals(first.version(), again.version()));
      report.put("content", record.content());
      report.put("found", Json.write(found).contains("Deploys run from main"));
      report.put("written", count);
      report.put("rate_limit_waits", waits.get());
      return report;
    }
  }

  static Map<String, Object> panels() throws Exception {
    try (Marina marina = Marina.connect(url, name)) {
      List<PanelChangeEvent> seen = Collections.synchronizedList(new ArrayList<>());
      AtomicBoolean snapshot = new AtomicBoolean();
      Runnable stop = marina.panels().watchChanges(seen::add, () -> snapshot.set(true));
      until(snapshot::get, 10_000);
      marina.command("canvas create " + name + "board");
      marina.command("canvas post on:" + name + "board hello from " + name);
      boolean got =
          until(
              () -> {
                synchronized (seen) {
                  return seen.stream().anyMatch(e -> e.canvasId() != null);
                }
              },
              10_000);
      stop.run();
      LinkedHashSet<String> types = new LinkedHashSet<>();
      synchronized (seen) {
        for (PanelChangeEvent e : seen) types.add(e.type());
      }
      Map<String, Object> report = new LinkedHashMap<>();
      report.put("snapshot", snapshot.get());
      report.put("got_canvas_event", got);
      report.put("event_types", new ArrayList<>(types));
      return report;
    }
  }

  static Map<String, Object> routing() {
    try (Marina marina = Marina.connect(url, name)) {
      Http.RoutingApi routing = marina.routing();
      Http.RoutingSession a = routing.joinSession(Http.RoutingJoin.of(name + "-a", "A", "service"));
      Http.RoutingSession b = routing.joinSession(Http.RoutingJoin.of(name + "-b", "B", "service"));
      routing.publish(
          a.id(), Http.PublishRequest.of(List.of(Http.RoutingEventInput.of("e1", "output", Map.of("text", "hello")))));
      Http.RoutingMessage sent = routing.send(a.id(), Http.RoutingSend.of("m1", b.id(), "note", "hi"));
      Http.InboxResponse inbox = routing.inbox(b.id());
      routing.acknowledgeMessage(b.id(), sent.id());
      Http.RoutingEventPage events = routing.events(a.id());
      Map<String, Object> report = new LinkedHashMap<>();
      report.put("session_a", a.id());
      report.put("inbox_has_message", Json.write(inbox).contains(sent.id()));
      report.put("published", Json.write(events).contains("hello"));
      return report;
    }
  }

  static Map<String, Object> local() throws Exception {
    List<String> command = new ArrayList<>();
    for (Object part : Json.array(args.get("command"))) command.add(String.valueOf(part));
    Path folder = Path.of(String.valueOf(args.get("folder")));
    Marina.LocalOptions options = Marina.LocalOptions.defaults().fresh(true).command(command);
    Map<String, Object> report = new LinkedHashMap<>();
    long pid;
    try (Marina marina = Marina.local(folder, options)) {
      HttpResponse<String> status =
          HttpClient.newHttpClient()
              .send(
                  HttpRequest.newBuilder(URI.create(marina.httpUrl() + "/api/setup-status")).build(),
                  HttpResponse.BodyHandlers.ofString());
      pid = ((Number) Json.object(Json.parse(status.body())).get("pid")).longValue();
      String refused = "";
      try {
        marina.code().run("Add a README");
      } catch (MarinaException e) {
        refused = e.getMessage();
      }
      report.put("name", marina.session().name());
      report.put("refused", refused);
      report.put("look", !marina.look().isEmpty());
    }
    report.put("stopped", ProcessHandle.of(pid).map(h -> !h.isAlive()).orElse(true));
    String missing = "";
    try {
      Marina.local(folder.resolve("missing"), Marina.LocalOptions.defaults().command(command)).close();
    } catch (MarinaException e) {
      missing = e.getMessage();
    }
    report.put("missing", missing);
    return report;
  }
}
