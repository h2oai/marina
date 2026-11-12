// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Live: a coding run through the Java SDK. Driven by test/java-sdk.test.ts.
 *
 * <p>args: server url, task, memory credential. Prints {"entity": ...}, waits for a line on stdin
 * (the test grants code.exec), then prints one JSON report.
 */
public final class LiveCoding {
  public static void main(String[] args) throws Exception {
    String url = args[0], task = args[1], credential = args[2];
    Map<String, Object> report = new LinkedHashMap<>();
    List<Map<String, Object>> frames = Collections.synchronizedList(new ArrayList<>());
    Marina marina = Marina.connect(url, "jbuilder");
    System.out.println(Json.write(Map.of("entity", marina.session().entityId())));
    System.out.flush();
    new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8)).readLine();
    try {
      marina.onEvent(f -> {
        if (Wire.classify(f) == Wire.Kind.CODE) frames.add(f);
      });
      try {
        marina.code().run("   ");
      } catch (IllegalArgumentException e) {
        report.put("empty", e.getMessage());
      }
      CodingRun run =
          marina.code().run(task, Coding.Options.defaults().verification("candidate").timeout(Duration.ofMinutes(2)));
      List<CodeEvent> events = new ArrayList<>();
      for (CodeEvent e : run.events()) events.add(e);
      RunResult result = run.result();
      report.put("run_id", run.runId());
      report.put("result", result.raw());
      report.put("submitted", result.submitted());
      report.put("summary", result.summary());
      List<Map<String, Object>> steps = new ArrayList<>();
      for (CodeEvent e : events) {
        CodingActivity a = e.activity();
        if (a == null) continue;
        Map<String, Object> step = new LinkedHashMap<>();
        step.put("kind", a.kind());
        step.put("label", a.label());
        if (a.path() != null) step.put("path", a.path());
        if (a.diff() != null) step.put("diff", a.diff());
        if (a.more() != null) step.put("more", a.more());
        if (a.quiet() != null) step.put("quiet", a.quiet());
        steps.add(step);
      }
      report.put("steps", steps);
      CodeEvent last = events.isEmpty() ? null : events.get(events.size() - 1);
      report.put("last_event_run", last != null && last.result() != null ? last.result().runId() : null);
      report.put("diff", marina.code().diff());
      marina.code().review(result.runId(), "approve");
      report.put("look", marina.command("look").text());
      try {
        marina.command("frobnicate the moon");
      } catch (CommandException e) {
        report.put("refused", e.getMessage());
      }
      report.put("discover", marina.routing().call("discover"));
      report.put("capability_count", Json.array(marina.capabilities().get("commands")).size());

      HttpApi memory = marina.memory(credential);
      String space = String.valueOf(Json.object(memory.call("createSpace", Map.of(), Map.of("name", "jspace"))).get("id"));
      Object first = memory.call("remember", Map.of("space", space), Map.of("content", "Deploys run from main"), "j-1");
      Object again = memory.call("remember", Map.of("space", space), Map.of("content", "Deploys run from main"), "j-1");
      Object found = memory.call("search", Map.of("space", space), Map.of("query", "deploy"));
      report.put(
          "memory",
          Map.of("replayed", Json.write(first).equals(Json.write(again)), "found", Json.write(found).contains("Deploys run from main")));

      String entity = marina.session().entityId(), token = marina.token();
      marina.close();
      try (Marina resumed = Marina.connect(url, Marina.ConnectOptions.token(token))) {
        report.put(
            "resumed",
            Map.of("same", resumed.session().entityId().equals(entity), "new_token", !resumed.token().equals(token)));
      }
    } finally {
      marina.close();
    }
    synchronized (frames) {
      report.put("frames", new ArrayList<>(frames));
    }
    System.out.println(Json.write(report));
    System.out.flush();
    System.exit(0);
  }
}
