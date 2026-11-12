// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina;

import java.time.Duration;
import java.util.Iterator;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * One coding task, from dispatch to its Run result.
 *
 * <pre>{@code
 * CodingRun run = marina.code().run("Fix the off-by-one in paginate()");
 * for (CodingActivity step : run.steps()) System.out.println(step.label());
 * RunResult result = run.result();
 * }</pre>
 */
public final class CodingRun {
  private static final Object END = new Object();
  private final Coding coding;
  private final String sessionId;
  private final BlockingQueue<Object> queue = new LinkedBlockingQueue<>();
  private final CompletableFuture<RunResult> result = new CompletableFuture<>();
  private volatile String runId;
  private volatile boolean read;

  CodingRun(Coding coding, String sessionId) {
    this.coding = coding;
    this.sessionId = sessionId;
  }

  /** The run's id once the server has accepted it ({@code task_run_...}), or null. */
  public String runId() {
    return runId;
  }

  public boolean isDone() {
    return result.isDone();
  }

  /** Every coding event of this run's session while it runs, in order. Blocks; read once. */
  public Iterable<CodeEvent> events() {
    if (read) throw new MarinaException("A run's events can be read once.");
    read = true;
    return () ->
        new Iterator<>() {
          private Object next;

          @Override
          public boolean hasNext() {
            if (next == null) {
              try {
                next = queue.take();
              } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new MarinaException("Interrupted", e);
              }
            }
            return next != END;
          }

          @Override
          public CodeEvent next() {
            if (!hasNext()) throw new NoSuchElementException();
            CodeEvent event = (CodeEvent) next;
            next = null;
            return event;
          }
        };
  }

  /** Only the coder's steps (reads, edits with their diffs, checks). Blocks; read once. */
  public Iterable<CodingActivity> steps() {
    Iterable<CodeEvent> events = events();
    return () ->
        new Iterator<>() {
          private final Iterator<CodeEvent> it = events.iterator();
          private CodingActivity next;

          @Override
          public boolean hasNext() {
            while (next == null && it.hasNext()) next = it.next().activity();
            return next != null;
          }

          @Override
          public CodingActivity next() {
            if (!hasNext()) throw new NoSuchElementException();
            CodingActivity step = next;
            next = null;
            return step;
          }
        };
  }

  /** Wait for the Run result (completed or failed). */
  public RunResult result() {
    try {
      return result.get();
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new MarinaException("Interrupted", e);
    } catch (java.util.concurrent.ExecutionException e) {
      if (e.getCause() instanceof MarinaException m) throw m;
      throw new MarinaException(String.valueOf(e.getCause()), e.getCause());
    }
  }

  /** Wait at most {@code timeout} for the Run result. */
  public RunResult result(Duration timeout) {
    try {
      return result.get(timeout.toMillis(), TimeUnit.MILLISECONDS);
    } catch (TimeoutException e) {
      throw new CodingTimeoutException("The coding run has not finished yet.");
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new MarinaException("Interrupted", e);
    } catch (java.util.concurrent.ExecutionException e) {
      if (e.getCause() instanceof MarinaException m) throw m;
      throw new MarinaException(String.valueOf(e.getCause()), e.getCause());
    }
  }

  /** Redirect the coder while it works. */
  public void steer(String direction) {
    coding.steer(direction);
  }

  /** Stop the coder. The result still arrives, as {@code failed}. */
  public void stop() {
    coding.stop();
  }

  // On the socket thread: quick, never blocking. True once the run has ended.
  boolean receive(Map<String, Object> frame) {
    CodeEvent event = Wire.codeEvent(frame);
    if (event == null) return false;
    if (sessionId != null && event.sessionId() != null && !sessionId.equals(event.sessionId()))
      return false;
    if (runId == null && "code_lifecycle".equals(event.event()) && event.runId() != null && event.result() == null)
      runId = event.runId();
    if (event.result() != null && runId != null && !runId.equals(event.result().runId()))
      return false; // another run's late end
    queue.add(event);
    if (event.result() == null || runId == null) return false;
    finish(event.result(), null);
    return true;
  }

  void finish(RunResult value, RuntimeException error) {
    boolean changed = error == null ? result.complete(value) : result.completeExceptionally(error);
    if (changed) queue.add(END);
  }
}
