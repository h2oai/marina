// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** The server refused or failed a command. {@link #frames()} holds what it sent first. */
public class CommandException extends MarinaException {
  private static final long serialVersionUID = 1L;

  private final String reason;
  private final transient List<Map<String, Object>> frames;

  public CommandException(String reason, List<Map<String, Object>> frames) {
    super(describe(reason, frames));
    this.reason = reason;
    this.frames = List.copyOf(frames);
  }

  /** The server's reason, without the output that came with it. */
  public String reason() {
    return reason;
  }

  public List<Map<String, Object>> frames() {
    return frames;
  }

  private static String describe(String message, List<Map<String, Object>> frames) {
    String head = message.strip();
    List<String> texts = new ArrayList<>();
    for (Map<String, Object> f : frames) {
      String t = Wire.text(f);
      if (!t.isEmpty()) texts.add(t);
    }
    String echo = null;
    for (String t : texts) {
      if (!head.isEmpty() && t.strip().startsWith(head)) {
        echo = t;
        break;
      }
    }
    List<String> rest = new ArrayList<>();
    for (String t : texts) if (t != echo && !t.strip().equals(head)) rest.add(t);
    String headline = echo != null ? echo.strip() : message;
    return rest.isEmpty()
        ? headline
        : headline
            + "\n\nPartial command output (completed actions are not rolled back):\n"
            + String.join("\n\n", rest);
  }
}
