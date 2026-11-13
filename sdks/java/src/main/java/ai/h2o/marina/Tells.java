// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina;

import java.security.SecureRandom;
import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Private messages ({@code tell}s): asking another participant and waiting for the answer, the
 * same rules as the TypeScript SDK's {@code tellAndAwait}. {@link Marina#tellAndAwait} and {@link
 * Marina#waitForTell} use it.
 */
public final class Tells {
  private Tells() {}

  /** A tell starting with this is a lifecycle notice, never an answer. */
  public static final String NOTICE_PREFIX = "[notice]";

  /** Notices agents send today ("I've spent my model-call budget", ...): never an answer. */
  public static final List<Pattern> NOTICE_PATTERNS =
      List.of(
          Pattern.compile("^\\[notice\\]", Pattern.CASE_INSENSITIVE),
          Pattern.compile("^I've spent my model-call budget\\b"),
          Pattern.compile("^I've hit a .+ and paused\\b"),
          Pattern.compile("^I've hit \\d+ consecutive upstream errors\\b"));

  /** After the first untagged reply, how long a tagged one may still win. */
  public static final Duration GRACE = Duration.ofMillis(1500);

  private static final String ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
  private static final SecureRandom RANDOM = new SecureRandom();
  private static final ScheduledExecutorService TIMERS =
      Executors.newSingleThreadScheduledExecutor(
          r -> {
            Thread t = new Thread(r, "marina-tell-timer");
            t.setDaemon(true);
            return t;
          });

  /** True when {@code text} is a known system notice rather than a reply. */
  public static boolean isNotice(String text) {
    String trimmed = text.stripLeading();
    for (Pattern p : NOTICE_PATTERNS) if (p.matcher(trimmed).find()) return true;
    return false;
  }

  /** A six-character base-36 id for a {@code [re:<id>]} tag. */
  public static String newCorrelationId() {
    StringBuilder out = new StringBuilder(6);
    for (int i = 0; i < 6; i++) out.append(ALPHABET.charAt(RANDOM.nextInt(256) % ALPHABET.length()));
    return out.toString();
  }

  /** The tag appended to a correlated tell: {@code " [re:<id>]"}. */
  public static String correlationTag(String id) {
    return " [re:" + id + "]";
  }

  private static Pattern tagPattern(String id) {
    return Pattern.compile("\\s*\\[?re:" + Pattern.quote(id) + "\\]?");
  }

  /** True when {@code text} carries {@code re:<id>}, bracketed or bare. */
  public static boolean hasCorrelationTag(String text, String id) {
    return tagPattern(id).matcher(text).find();
  }

  /** {@code text} without any {@code [re:<id>]} / {@code re:<id>}, trimmed. */
  public static String stripCorrelationTag(String text, String id) {
    return tagPattern(id).matcher(text).replaceAll(Matcher.quoteReplacement("")).strip();
  }

  /**
   * Options for {@link Marina#tellAndAwait(String, String, Duration, Options)}.
   *
   * @param correlate tag the question with {@code [re:<id>]} and prefer a reply that echoes it
   *     (default true); an untagged reply is accepted after {@code grace}
   * @param strictCorrelation accept only a reply that echoes the tag
   * @param grace how long an untagged reply waits for a tagged one (default 1.5 s)
   * @param ignoreNotices never treat a notice ({@link #isNotice}) as the answer (default true)
   */
  public record Options(boolean correlate, boolean strictCorrelation, Duration grace, boolean ignoreNotices) {
    public static Options defaults() {
      return new Options(true, false, GRACE, true);
    }

    public Options correlate(boolean value) {
      return new Options(value, strictCorrelation, grace, ignoreNotices);
    }

    public Options strictCorrelation(boolean value) {
      return new Options(correlate, value, grace, ignoreNotices);
    }

    public Options grace(Duration value) {
      return new Options(correlate, strictCorrelation, value, ignoreNotices);
    }

    public Options ignoreNotices(boolean value) {
      return new Options(correlate, strictCorrelation, grace, value);
    }
  }

  /** The text of a tell frame: {@code data.message}, else {@code data.text}, else "". */
  static String text(Map<String, Object> frame) {
    Map<String, Object> data = Wire.data(frame);
    if (data.get("message") instanceof String m && !m.isEmpty()) return m;
    if (data.get("text") instanceof String t && !t.isEmpty()) return t;
    return "";
  }

  /** The sender of a tell to you, or null (an echo of one you sent names none). */
  static String sender(Map<String, Object> frame) {
    if (!"tell".equals(frame.get("tag"))) return null;
    return Json.string(Wire.data(frame).get("senderName"));
  }

  /**
   * Decides which incoming tell answers one question. Pure: frames in, the answer out (see {@link
   * Marina#tellAndAwait}).
   */
  static final class Await {
    final String outgoing;
    private final String correlationId;
    private final String target;
    private final long sentAt;
    private final Options options;
    private boolean armed;
    String candidate;

    Await(String target, String message, long sentAt, Options options, String correlationId) {
      this.correlationId = options.correlate() || options.strictCorrelation() ? correlationId : null;
      this.outgoing = this.correlationId != null ? message + correlationTag(this.correlationId) : message;
      this.target = target.toLowerCase(Locale.ROOT);
      this.sentAt = sentAt;
      this.options = options;
    }

    /** What a frame means: null (nothing), or the answer; sets {@link #candidate} for an untagged one. */
    String accept(Map<String, Object> frame) {
      if (!"message".equals(frame.get("kind")) || !"tell".equals(frame.get("tag"))) return null;
      String text = text(frame);
      String sender = Json.string(Wire.data(frame).get("senderName"));
      if (sender == null) {
        // our own echo ("You tell <target>: <outgoing>"): any later tell from the target is fresh
        if (!armed && text.contains(outgoing)) armed = true;
        return null;
      }
      if (!sender.toLowerCase(Locale.ROOT).equals(target)) return null;
      if (!armed && !(frame.get("timestamp") instanceof Number ts && ts.longValue() >= sentAt)) return null;
      if (options.ignoreNotices() && isNotice(text)) return null;
      if (correlationId == null || hasCorrelationTag(text, correlationId)) return answer(text);
      if (options.strictCorrelation() || candidate != null) return null;
      candidate = text;
      return null;
    }

    String answer(String text) {
      return correlationId != null ? stripCorrelationTag(text, correlationId) : text;
    }
  }

  static String tellAndAwait(Connection connection, String target, String message, Duration timeout, Options options) {
    if (connection.session() == null) throw new ConnectionLostException("Not logged in.");
    Options o = options == null ? Options.defaults() : options;
    long sentAt = System.currentTimeMillis();
    long deadline = sentAt + timeout.toMillis();
    Await await = new Await(target, message, sentAt, o, newCorrelationId());
    CompletableFuture<String> reply = new CompletableFuture<>();
    ScheduledFuture<?>[] grace = new ScheduledFuture<?>[1];
    Consumer<Map<String, Object>> waiter =
        frame -> {
          if (reply.isDone()) return;
          String answer;
          boolean held;
          synchronized (await) {
            boolean before = await.candidate != null;
            answer = await.accept(frame);
            held = !before && await.candidate != null;
          }
          if (answer != null) reply.complete(answer);
          else if (held) {
            long wait = Math.min(Math.max(0, o.grace().toMillis()), Math.max(0, deadline - System.currentTimeMillis()));
            grace[0] =
                TIMERS.schedule(
                    () -> {
                      synchronized (await) {
                        reply.complete(await.answer(await.candidate));
                      }
                    },
                    wait,
                    TimeUnit.MILLISECONDS);
          }
        };
    connection.addWaiter(waiter);
    try {
      connection.command("tell " + target + " " + await.outgoing);
      long left = deadline - System.currentTimeMillis();
      try {
        return reply.get(Math.max(0, left), TimeUnit.MILLISECONDS);
      } catch (TimeoutException e) {
        synchronized (await) {
          if (await.candidate != null) return await.answer(await.candidate);
        }
        throw new MarinaException("tellAndAwait: no reply from \"" + target + "\" within " + timeout.toMillis() + "ms");
      } catch (ExecutionException e) {
        throw new MarinaException(String.valueOf(e.getCause()), e.getCause());
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        throw new MarinaException("Interrupted", e);
      }
    } finally {
      connection.removeWaiter(waiter);
      if (grace[0] != null) grace[0].cancel(false);
    }
  }

  static String waitForTell(Connection connection, String from, Duration timeout) {
    String key = from == null ? null : from.toLowerCase(Locale.ROOT);
    CompletableFuture<String> heard = new CompletableFuture<>();
    Consumer<Map<String, Object>> waiter =
        frame -> {
          String sender = sender(frame);
          if (sender == null || (key != null && !sender.toLowerCase(Locale.ROOT).equals(key))) return;
          Map<String, Object> data = Wire.data(frame);
          Object text = data.get("message") != null ? data.get("message") : data.get("text");
          heard.complete(text == null ? "" : String.valueOf(text));
        };
    Runnable lost = () -> heard.completeExceptionally(new ConnectionLostException("The connection closed while waiting for a tell."));
    connection.addWaiter(waiter);
    connection.onClose(lost);
    try {
      return heard.get(timeout.toMillis(), TimeUnit.MILLISECONDS);
    } catch (TimeoutException e) {
      throw new MarinaException("waitForTell: no tell" + (from == null ? "" : " from \"" + from + "\"") + " within " + timeout.toMillis() + "ms");
    } catch (ExecutionException e) {
      if (e.getCause() instanceof MarinaException m) throw m;
      throw new MarinaException(String.valueOf(e.getCause()), e.getCause());
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new MarinaException("Interrupted", e);
    } finally {
      connection.removeWaiter(waiter);
      connection.removeOnClose(lost);
    }
  }
}
