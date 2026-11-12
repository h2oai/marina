// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina;

import java.lang.reflect.RecordComponent;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Prints the SDK's coding shapes, for test/java-sdk.test.ts to hold against the wire schema. */
public final class Shape {
  static List<String> fields(Class<?> record) {
    List<String> names = new ArrayList<>();
    for (RecordComponent c : record.getRecordComponents()) if (!c.getName().equals("raw")) names.add(c.getName());
    names.sort(null);
    return names;
  }

  public static void main(String[] args) {
    System.out.println(
        Json.write(
            Map.of(
                "activity", fields(CodingActivity.class),
                "result", fields(RunResult.class),
                "kinds", Wire.CODING_ACTIVITY_KINDS,
                "verifications", Wire.VERIFICATIONS,
                "outcomes", Wire.RUN_OUTCOMES,
                "protocol", Wire.WIRE_PROTOCOL)));
  }
}
