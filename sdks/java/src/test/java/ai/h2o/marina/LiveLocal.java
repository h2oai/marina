// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina;

import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Live: Marina.local from Java. Driven by test/java-sdk.test.ts. args: folder, then the marina
 * command as JSON. The test sets HOME and blank provider keys.
 */
public final class LiveLocal {
  public static void main(String[] args) {
    Path folder = Path.of(args[0]);
    List<String> command = new java.util.ArrayList<>();
    for (Object part : Json.array(Json.parse(args[1]))) command.add((String) part);
    Marina.LocalOptions options = Marina.LocalOptions.defaults().fresh(true).command(command);
    Map<String, Object> report = new LinkedHashMap<>();
    long pid;
    try (Marina marina = Marina.local(folder, options)) {
      report.put("name", marina.session().name());
      pid = marina.server().pid();
      try {
        marina.code().run("Add a README");
      } catch (CommandException e) {
        report.put("refused", e.getMessage());
      }
      report.put("look", !marina.command("look").isEmpty());
    }
    report.put("stopped", ProcessHandle.of(pid).map(h -> !h.isAlive()).orElse(true));
    try {
      Marina.local(folder.resolve("missing"), options).close();
    } catch (MarinaException e) {
      report.put("missing", e.getMessage());
    }
    System.out.println(Json.write(report));
    System.exit(0);
  }
}
