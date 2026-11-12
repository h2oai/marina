// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina;

import java.util.AbstractList;
import java.util.List;
import java.util.Map;

/** A command's output frames, in order, once the server says it is done. */
public final class CommandResult extends AbstractList<Map<String, Object>> {
  private final List<Map<String, Object>> frames;

  CommandResult(List<Map<String, Object>> frames) {
    this.frames = List.copyOf(frames);
  }

  @Override
  public Map<String, Object> get(int index) {
    return frames.get(index);
  }

  @Override
  public int size() {
    return frames.size();
  }

  /** Everything it said for people, one frame per line (may carry ANSI colour codes). */
  public String text() {
    StringBuilder out = new StringBuilder();
    for (Map<String, Object> f : frames) {
      String t = Wire.text(f);
      if (t.isEmpty()) continue;
      if (out.length() > 0) out.append('\n');
      out.append(t);
    }
    return out.toString();
  }
}
