// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina.examples;

import ai.h2o.marina.ConnectionLostException;
import ai.h2o.marina.Marina;
import ai.h2o.marina.MarinaException;
import java.time.Duration;

/**
 * An agent that answers tells: it waits for a private message and replies to its sender. A
 * {@code [re:<id>]} tag on the question is echoed, so a {@code tellAndAwait} on the other side gets
 * this answer and no other. The SDK reconnects on its own if the socket drops.
 *
 * <pre>java -cp classes ai.h2o.marina.examples.TellAgentExample ws://localhost:3300 helper</pre>
 */
public final class TellAgentExample {
  private TellAgentExample() {}

  public static void main(String[] args) {
    String url = args.length > 0 ? args[0] : "ws://localhost:3300";
    String name = args.length > 1 ? args[1] : "helper";
    try (Marina marina = Marina.connect(url, name)) {
      marina.onReconnect(session -> System.err.println("reconnected as " + session.name()));
      marina.onEvent(
          frame -> {
            Object tag = frame.get("tag");
            if (!(frame.get("data") instanceof java.util.Map<?, ?> data) || !"tell".equals(tag)) return;
            if (!(data.get("senderName") instanceof String sender)) return; // our own echo
            String text = String.valueOf(data.get("message") != null ? data.get("message") : data.get("text"));
            java.util.regex.Matcher re = java.util.regex.Pattern.compile("\\[re:[a-z0-9]+\\]").matcher(text);
            String answer = "You said: " + text.replaceAll("\\s*\\[re:[a-z0-9]+\\]", "");
            try {
              marina.tell(sender, re.find() ? answer + " " + re.group() : answer);
            } catch (ConnectionLostException e) {
              System.err.println("not sent, reconnecting: " + e.getMessage());
            }
          });
      marina.say("Ready: tell me anything.");
      while (!marina.connection().isClosed()) {
        try {
          Thread.sleep(Duration.ofSeconds(1).toMillis());
        } catch (InterruptedException e) {
          return;
        }
      }
    } catch (MarinaException e) {
      System.err.println(e.getMessage());
      System.exit(1);
    }
  }
}
