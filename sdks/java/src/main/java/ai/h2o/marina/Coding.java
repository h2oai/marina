// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina;

import java.time.Duration;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import java.util.function.Predicate;
import java.util.regex.Pattern;

/** Code Mode for one connection: run tasks in the server's workspace and follow them. */
public final class Coding {
  /** Default wait before a run is stopped: 30 minutes. */
  public static final Duration DEFAULT_RUN_TIMEOUT = Duration.ofMinutes(30);

  private static final Pattern RUN_ID = Pattern.compile("[\\w-]{1,128}");
  private static final Pattern DURATION = Pattern.compile("\\d+(s|m|h)");
  private static final ScheduledExecutorService TIMERS =
      Executors.newSingleThreadScheduledExecutor(
          r -> {
            Thread t = new Thread(r, "marina-coding-timer");
            t.setDaemon(true);
            return t;
          });

  private final Connection connection;
  private final Set<CodingRun> active = ConcurrentHashMap.newKeySet();
  private volatile boolean opened;
  private volatile String session;
  private volatile Predicate<ExecApprovalRequest> approver;
  private volatile boolean watching;

  /** Options for {@link #run(String, Options)}. */
  public record Options(String verification, String budget, Duration timeout) {
    /** Defaults: {@code checks}, no budget, 30 minutes. */
    public static Options defaults() {
      return new Options("checks", null, DEFAULT_RUN_TIMEOUT);
    }

    /**
     * What counts as done: {@code checks} runs the project's checks on the change, {@code
     * candidate} lets the coder's own checks stand, {@code delivery} asks for the delivery
     * checklist.
     */
    public Options verification(String value) {
      return new Options(value, budget, timeout);
    }

    /** Wall-clock budget for the coder, like "90s", "10m" or "2h". */
    public Options budget(String value) {
      return new Options(verification, value, timeout);
    }

    /** Wall-clock budget for the coder. */
    public Options budget(Duration value) {
      return new Options(verification, budgetArgument(value), timeout);
    }

    /** Give up waiting after this long: the run is stopped and its result fails. */
    public Options timeout(Duration value) {
      return new Options(verification, budget, value);
    }
  }

  Coding(Connection connection) {
    this.connection = connection;
    connection.onClose(
        () -> {
          for (CodingRun run : active)
            run.finish(null, new ConnectionLostException("The connection closed before the coding run ended."));
          active.clear();
        });
  }

  /** {@code budget:} for {@code code do}: whole seconds, at least one. */
  public static String budgetArgument(Duration budget) {
    if (budget.isNegative() || budget.isZero()) throw new IllegalArgumentException("budget must be positive");
    long seconds = (budget.toMillis() + 999) / 1000;
    return Math.max(1, seconds) + "s";
  }

  /** Validates a duration like "90s", "10m" or "2h". */
  public static String budgetArgument(String budget) {
    String text = budget.strip();
    if (!DURATION.matcher(text).matches())
      throw new IllegalArgumentException("budget \"" + budget + "\" is not like 90s, 10m or 2h");
    return text;
  }

  /**
   * Enter Code Mode (once per connection). Returns the coding session id, or null when it has none
   * yet. The server picks the workspace: a local folder server codes in its folder.
   */
  public String open() {
    if (!opened) {
      for (Map<String, Object> frame : connection.command("code")) {
        Map<String, Object> code = Json.object(Wire.data(frame).get("code"));
        if (code != null && "code_mode_entered".equals(code.get("event")))
          session = Json.string(code.get("sessionId"));
      }
      opened = true;
    }
    return session;
  }

  /** Dispatch a coding task with the default options. */
  public CodingRun run(String task) {
    return run(task, Options.defaults());
  }

  /** Dispatch a coding task; returns once the server accepts it. */
  public CodingRun run(String task, Options options) {
    String text = task == null ? "" : task.strip();
    if (text.isEmpty()) throw new IllegalArgumentException("Empty task: nothing to do.");
    String verification = options.verification() == null ? "checks" : options.verification();
    if (!Set.of("checks", "candidate", "delivery").contains(verification))
      throw new IllegalArgumentException("verification is checks, candidate or delivery");
    String budget = options.budget() == null ? "" : "budget:" + budgetArgument(options.budget()) + " ";
    Duration timeout = options.timeout() == null ? DEFAULT_RUN_TIMEOUT : options.timeout();
    String sessionId = open();
    CodingRun run = new CodingRun(this, sessionId);
    AtomicReference<Consumer<Map<String, Object>>> waiter = new AtomicReference<>();
    Runnable remove =
        () -> {
          connection.removeWaiter(waiter.get());
          active.remove(run);
        };
    waiter.set(
        frame -> {
          if (run.receive(frame)) remove.run();
        });
    active.add(run);
    // On the socket thread: frames reach the run in order, before any listener.
    connection.addWaiter(waiter.get());
    ScheduledFuture<?> timer =
        TIMERS.schedule(
            () -> {
              if (run.isDone()) return;
              remove.run();
              try {
                stop();
              } catch (MarinaException ignored) {
                // the timeout below already reports the run
              }
              run.finish(null, new CodingTimeoutException("The coding run did not finish within " + timeout + "; it was stopped."));
            },
            timeout.toMillis(),
            TimeUnit.MILLISECONDS);
    try {
      // A program drives this run: nobody is at a keyboard to answer questions.
      connection.command("code do verification:" + verification + " owner:unattended " + budget + "-- " + text);
    } catch (RuntimeException e) {
      timer.cancel(false);
      remove.run();
      run.finish(null, e);
      throw e;
    }
    Thread watcher =
        new Thread(
            () -> {
              try {
                run.result();
              } catch (RuntimeException ignored) {
                // reported to whoever waits on the result
              }
              timer.cancel(false);
            },
            "marina-run-watch");
    watcher.setDaemon(true);
    watcher.start();
    return run;
  }

  /**
   * Answer the coder's requests to run commands outside its allowlist. The handler returns true to
   * run the command; false, or an exception, denies it. Without a handler the requests wait for
   * someone else to answer.
   */
  public void onExecApproval(Predicate<ExecApprovalRequest> handler) {
    approver = handler;
    if (watching) return;
    watching = true;
    connection.onFrame(
        frame -> {
          ExecApprovalRequest request = Wire.execApproval(frame);
          Predicate<ExecApprovalRequest> current = approver;
          if (request == null || current == null) return;
          try {
            connection.command(answer(current, request));
          } catch (MarinaException notSent) {
            // not delivered: the request stays open to answer again
          }
        });
  }

  /** The command that answers a request: approve only when the handler returns true. */
  static String answer(Predicate<ExecApprovalRequest> handler, ExecApprovalRequest request) {
    boolean yes;
    try {
      yes = handler.test(request);
    } catch (RuntimeException e) {
      yes = false; // a failing handler denies: never run what nobody approved
    }
    return "code " + (yes ? "exec-approve " : "exec-deny ") + request.token();
  }

  /** The session's whole change as a unified diff ("" when nothing changed). */
  public String diff() {
    return diff(null);
  }

  /** The change to one path as a unified diff. */
  public String diff(String path) {
    open();
    for (Map<String, Object> frame : connection.command(path == null ? "code diff" : "code diff " + path)) {
      Map<String, Object> code = Json.object(Wire.data(frame).get("code"));
      if (code != null && "diff".equals(code.get("type")) && code.get("content") instanceof String s) return s;
    }
    return "";
  }

  /** Record your verdict on a run's change: {@code approve} or {@code reject}. */
  public void review(String runId, String verdict) {
    if (!verdict.equals("approve") && !verdict.equals("reject"))
      throw new IllegalArgumentException("verdict is approve or reject");
    if (!RUN_ID.matcher(runId).matches()) throw new IllegalArgumentException("Not a run id: " + runId);
    connection.command("code review " + verdict + " " + runId);
  }

  /** Redirect the coder while it works. */
  public void steer(String direction) {
    connection.command("code steer " + direction);
  }

  /** Stop the coder. */
  public void stop() {
    connection.command("code stop");
  }
}
