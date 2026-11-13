// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.function.Supplier;
import java.util.logging.Level;
import java.util.logging.Logger;

/** Published panels: the typed calls ({@link Http.PanelsApi}) and the live change stream. */
public class PanelsGroup extends HttpGroup {
  private static final Logger LOG = Logger.getLogger("ai.h2o.marina");

  protected PanelsGroup(String baseUrl, Supplier<String> token) {
    super(baseUrl, token, "panels");
  }

  /** Wait before the {@code attempt}-th reconnect of the change stream: 1 s doubling to 15 s. */
  public static long watchDelayMs(int attempt) {
    return Math.min(1000L << Math.min(attempt, 20), 15_000L);
  }

  /**
   * Follow {@code /dashboard-ws}: {@code onEvent} gets each change (a hint to read again), {@code
   * onSnapshot} runs each time the stream (re)starts, when anything may have changed. It
   * reconnects on its own with backoff, signing in with the newest session token. Callbacks run on
   * one SDK thread, in order. Returns a handle that stops watching.
   */
  public Runnable watchChanges(Consumer<PanelChangeEvent> onEvent, Runnable onSnapshot) {
    Watch watch = new Watch(onEvent, onSnapshot);
    watch.connect();
    return watch::stop;
  }

  private final class Watch {
    private final Consumer<PanelChangeEvent> onEvent;
    private final Runnable onSnapshot;
    private final ExecutorService callbacks = Executors.newSingleThreadExecutor(daemon("marina-panels"));
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(daemon("marina-panels-retry"));
    private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build();
    private volatile boolean stopped;
    private volatile WebSocket socket;
    private int attempts;

    Watch(Consumer<PanelChangeEvent> onEvent, Runnable onSnapshot) {
      this.onEvent = onEvent;
      this.onSnapshot = onSnapshot;
    }

    void connect() {
      if (stopped) return;
      String base = baseUrl().replaceFirst("^http", "ws");
      String token = token();
      URI uri =
          URI.create(base + "/dashboard-ws" + (token == null || token.isEmpty() ? "" : "?token=" + URLEncoder.encode(token, StandardCharsets.UTF_8)));
      Listener listener = new Listener();
      client
          .newWebSocketBuilder()
          .connectTimeout(Duration.ofSeconds(15))
          .buildAsync(uri, listener)
          .whenComplete(
              (ws, error) -> {
                if (error != null) {
                  retry(listener);
                  return;
                }
                socket = ws;
                if (stopped) ws.abort();
              });
    }

    synchronized void retry(Listener from) {
      if (stopped || from.retried) return;
      from.retried = true;
      try {
        timer.schedule(this::connect, watchDelayMs(attempts++), TimeUnit.MILLISECONDS);
      } catch (java.util.concurrent.RejectedExecutionException stopping) {
        // stopped meanwhile
      }
    }

    void stop() {
      stopped = true;
      timer.shutdownNow();
      WebSocket ws = socket;
      if (ws != null) ws.abort();
      callbacks.shutdown();
    }

    private void handle(String text) {
      Map<String, Object> message;
      try {
        message = Json.object(Json.parse(text));
      } catch (IllegalArgumentException malformed) {
        return; // a malformed frame cannot change what may be read
      }
      if (message == null) return;
      if ("snapshot".equals(message.get("type"))) {
        synchronized (this) {
          attempts = 0;
        }
        run(onSnapshot);
      }
      if ("event".equals(message.get("type"))) {
        PanelChangeEvent event = PanelChangeEvent.from(Json.object(message.get("data")));
        if (event != null) run(() -> onEvent.accept(event));
      }
    }

    private void run(Runnable callback) {
      if (stopped || callbacks.isShutdown()) return;
      try {
        callbacks.execute(
            () -> {
              if (stopped) return;
              try {
                callback.run();
              } catch (RuntimeException e) {
                LOG.log(Level.WARNING, "A panel change callback failed", e);
              }
            });
      } catch (java.util.concurrent.RejectedExecutionException stopping) {
        // stopped meanwhile
      }
    }

    private final class Listener implements WebSocket.Listener {
      private final StringBuilder partial = new StringBuilder();
      volatile boolean retried;

      @Override
      public void onOpen(WebSocket webSocket) {
        webSocket.request(1);
      }

      @Override
      public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
        partial.append(data);
        if (last) {
          String text = partial.toString();
          partial.setLength(0);
          if (!stopped) handle(text);
        }
        webSocket.request(1);
        return null;
      }

      @Override
      public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
        retry(this);
        return null;
      }

      @Override
      public void onError(WebSocket webSocket, Throwable error) {
        retry(this);
      }
    }
  }

  private static java.util.concurrent.ThreadFactory daemon(String name) {
    return r -> {
      Thread t = new Thread(r, name);
      t.setDaemon(true);
      return t;
    };
  }
}
