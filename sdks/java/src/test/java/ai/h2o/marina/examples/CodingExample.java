// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina.examples;

import ai.h2o.marina.Coding;
import ai.h2o.marina.CodingActivity;
import ai.h2o.marina.CodingRun;
import ai.h2o.marina.Marina;
import ai.h2o.marina.RunResult;
import java.nio.file.Path;

/**
 * Run one coding task in a folder with the folder's own Marina, print each step, show the change
 * and approve it.
 *
 * <pre>java -cp classes ai.h2o.marina.examples.CodingExample my-project "Fix the failing test"</pre>
 *
 * Needs the {@code marina} CLI on PATH and a model provider (a key in the environment, or {@code
 * marina init}).
 */
public final class CodingExample {
  private CodingExample() {}

  public static void main(String[] args) {
    Path folder = Path.of(args.length > 0 ? args[0] : ".");
    String task = args.length > 1 ? args[1] : "Add a README that says what this project does";
    try (Marina marina = Marina.local(folder)) {
      // Answer the coder's requests to run commands outside its allowlist: here, only tests.
      marina.code().onExecApproval(request -> request.argv().size() > 1 && request.argv().get(1).equals("test"));
      CodingRun run = marina.code().run(task, Coding.Options.defaults().budget("10m"));
      for (CodingActivity step : run.steps()) System.out.println("  " + step.label());
      RunResult result = run.result();
      System.out.println(result.outcome() + " (checks: " + result.verification() + "): " + result.summary());
      System.out.println(marina.code().diff());
      if (result.submitted()) marina.code().review(result.runId(), "approve");
    }
  }
}
