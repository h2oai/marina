// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * One WebSocket session with a Marina server: log in, run commands, hear what it sends.
 *
 * <p>Frames reach the SDK's own waiters first, in order; your listeners then run on one SDK
 * thread, in order, and may run commands.
 *
 * <p>When the socket drops after login, the session resumes on its own with its newest token:
 * {@link #RECONNECT_ATTEMPTS} tries, {@link #reconnectDelayMs(int) 3 s doubling to 30 s} apart. A
 * command sent meanwhile fails at once with {@link ConnectionLostException}; retry it once {@link
 * #onReconnect} fires. {@link #close()} never reconnects; giving up closes the connection.
 */
public final class Connection implements AutoCloseable {
  private static final Logger LOG = Logger.getLogger("ai.h2o.marina");
  /** Seconds between keepalive pings (the server drops a socket silent for 255 s). */
  static final long PING_SECONDS = 30;
  /** Reconnect tries after a dropped socket before the connection gives up and closes. */
  public static final int RECONNECT_ATTEMPTS = 10;

  /** Who you are on this connection. {@code token} is the newest; each token works once. */
  public record Session(String entityId, String name, String token, boolean worldCommandGrammar) {}

  private final URI wsUrl;
  private final String httpUrl;
  private final String principal;
  private final String model;
  private final Duration commandTimeout;
  private final Duration connectTimeout;
  private final List<Consumer<Map<String, Object>>> waiters = new CopyOnWriteArrayList<>();
  private final List<Consumer<Map<String, Object>>> listeners = new CopyOnWriteArrayList<>();
  private final List<Runnable> onClose = new CopyOnWriteArrayList<>();
  /** In-flight waits (a login, a command) that a dropped socket ends. */
  private final List<Runnable> onDrop = new CopyOnWriteArrayList<>();
  private final List<Consumer<Session>> onReconnect = new CopyOnWriteArrayList<>();
  private final AtomicBoolean pinging = new AtomicBoolean();
  private final AtomicBoolean reconnecting = new AtomicBoolean();
  /** Which socket is current: events from an older one are ignored. */
  private final AtomicLong generation = new AtomicLong();
  private final ExecutorService events =
      Executors.newSingleThreadExecutor(daemon("marina-events"));
  private final ScheduledExecutorService pinger =
      Executors.newSingleThreadScheduledExecutor(daemon("marina-ping"));
  private final CountDownLatch closed = new CountDownLatch(1);
  private volatile WebSocket ws;
  private volatile Session session;
  /** Logged in on a live socket. */
  private volatile boolean connected;
  /** {@link #close()} was called. */
  private volatile boolean closing;
  /** A login or auth is waiting for its session frame: only then is one taken as ours. */
  private volatile boolean authenticating;
  private volatile Thread reconnector;

  public Connection(String url, String principal, String model, Duration commandTimeout) {
    String[] ends = endpoints(url);
    this.wsUrl = URI.create(ends[0]);
    this.httpUrl = ends[1];
    this.principal = principal == null ? "agent" : principal;
    this.model = model;
    this.commandTimeout = commandTimeout == null ? Duration.ofSeconds(120) : commandTimeout;
    this.connectTimeout = Duration.ofSeconds(30);
  }

  private static java.util.concurrent.ThreadFactory daemon(String name) {
    return r -> {
      Thread t = new Thread(r, name);
      t.setDaemon(true);
      return t;
    };
  }

  /** {WebSocket URL, HTTP base URL} of one server, from either form. */
  public static String[] endpoints(String url) {
    URI u = URI.create(url.replaceAll("/+$", ""));
    String scheme = u.getScheme();
    if (u.getUserInfo() != null || u.getQuery() != null || u.getFragment() != null)
      throw new IllegalArgumentException("A server URL carries no credentials, query or fragment.");
    if (scheme == null || !List.of("ws", "wss", "http", "https").contains(scheme))
      throw new IllegalArgumentException("Not a Marina server URL: " + url);
    boolean secure = scheme.equals("wss") || scheme.equals("https");
    String path = u.getRawPath() == null ? "" : u.getRawPath();
    if (path.endsWith("/ws")) path = path.substring(0, path.length() - 3);
    String base = u.getRawAuthority() + path;
    return new String[] {(secure ? "wss" : "ws") + "://" + base + "/ws", (secure ? "https" : "http") + "://" + base};
  }

  public String wsUrl() {
    return wsUrl.toString();
  }

  public String httpUrl() {
    return httpUrl;
  }

  /** The current session, or null before login. */
  public Session session() {
    return session;
  }

  public boolean isClosed() {
    return closed.getCount() == 0;
  }

  /** Logged in on a live socket (false while reconnecting, and once closed). */
  public boolean isConnected() {
    return connected && !isClosed();
  }

  /** Wait before reconnect try {@code attempt} (0-based): 3 s doubling to 30 s. */
  public static long reconnectDelayMs(int attempt) {
    return Math.min(3000L << Math.min(attempt, 20), 30_000L);
  }

  // ─── Opening ───────────────────────────────────────────────────────────

  private void open() {
    if (ws != null && !ws.isOutputClosed()) return;
    long current = generation.incrementAndGet();
    try {
      ws =
          HttpClient.newBuilder()
              .connectTimeout(connectTimeout)
              .build()
              .newWebSocketBuilder()
              .connectTimeout(connectTimeout)
              .buildAsync(wsUrl, new Reader(current))
              .get(connectTimeout.toMillis(), TimeUnit.MILLISECONDS);
    } catch (Exception e) {
      throw new ConnectionLostException("Could not reach " + wsUrl + ": " + rootMessage(e), e);
    }
    if (pinging.compareAndSet(false, true))
      pinger.scheduleAtFixedRate(
          () -> {
            if (!connected) return;
            try {
              send(Map.of("type", "ping"));
            } catch (MarinaException gone) {
              // the drop is handled where the socket reports it
            }
          },
          PING_SECONDS,
          PING_SECONDS,
          TimeUnit.SECONDS);
  }

  private static String rootMessage(Throwable e) {
    while (e.getCause() != null) e = e.getCause();
    return e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
  }

  /** Enter the world under a name (2-20 letters or digits). */
  public Session login(String name) {
    open();
    Map<String, Object> frame = new LinkedHashMap<>();
    frame.put("type", "login");
    frame.put("name", name);
    return authenticate(frame);
  }

  /** Resume a dropped session with its token, within 60 s of the drop. */
  public Session resume(String token) {
    open();
    Map<String, Object> frame = new LinkedHashMap<>();
    frame.put("type", "auth");
    frame.put("token", token);
    return authenticate(frame);
  }

  private Session authenticate(Map<String, Object> frame) {
    frame.put("principal", principal);
    if (model != null) frame.put("model", model);
    CompletableFuture<String> outcome = new CompletableFuture<>();
    Consumer<Map<String, Object>> waiter =
        f -> {
          switch (Wire.classify(f)) {
            case SESSION -> {
              if (isSessionFrame(f)) outcome.complete(null);
            }
            case AUTH_ERROR, ERROR -> {
              String text = Wire.text(f);
              outcome.complete(text.isEmpty() ? "Login refused" : text);
            }
            default -> {}
          }
        };
    Runnable lost = () -> outcome.completeExceptionally(new ConnectionLostException("The connection closed during login."));
    waiters.add(waiter);
    onDrop.add(lost);
    authenticating = true;
    try {
      send(frame);
      String refusal = await(outcome, connectTimeout, "The server did not answer the login in time.");
      if (refusal != null) throw new LoginRefusedException(refusal);
      connected = true;
      return session;
    } finally {
      authenticating = false;
      waiters.remove(waiter);
      onDrop.remove(lost);
    }
  }

  private static <T> T await(CompletableFuture<T> future, Duration timeout, String timeoutMessage) {
    try {
      return future.get(timeout.toMillis(), TimeUnit.MILLISECONDS);
    } catch (java.util.concurrent.TimeoutException e) {
      throw new ConnectionLostException(timeoutMessage);
    } catch (java.util.concurrent.ExecutionException e) {
      if (e.getCause() instanceof MarinaException m) throw m;
      throw new MarinaException(rootMessage(e), e);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new MarinaException("Interrupted", e);
    }
  }

  // ─── Commands ──────────────────────────────────────────────────────────

  /** Run one world command and wait until the server says it is done. */
  public CommandResult command(String text) {
    return command(text, null, true);
  }

  /**
   * Run one command and wait until the server says it is done.
   *
   * @param timeout null for the connection's command timeout
   * @param world true (the default elsewhere): always a world command, never a task for a coder
   *     in Code Mode
   * @throws CommandException when the server refuses or fails it
   */
  public CommandResult command(String text, Duration timeout, boolean world) {
    Session s = session;
    if (s == null) throw new ConnectionLostException("Not logged in.");
    if (!isConnected())
      throw new ConnectionLostException(
          isClosed()
              ? "Connection lost: the connection is closed."
              : "Connection lost: reconnecting. Retry the command once it is back.");
    String line = text.strip();
    if (world && s.worldCommandGrammar() && !line.startsWith("/")) line = "/" + line;
    String requestId = UUID.randomUUID().toString();
    List<Map<String, Object>> frames = java.util.Collections.synchronizedList(new ArrayList<>());
    CompletableFuture<Map<String, Object>> outcome = new CompletableFuture<>();
    Consumer<Map<String, Object>> waiter =
        f -> {
          if (requestId.equals(f.get("command_request_id"))) frames.add(f);
          Map<String, Object> result = Json.object(Wire.data(f).get("command_result"));
          if (result != null && requestId.equals(result.get("request_id"))) outcome.complete(result);
        };
    Runnable lost = () -> outcome.complete(null);
    waiters.add(waiter);
    onDrop.add(lost);
    Map<String, Object> result;
    try {
      Map<String, Object> frame = new LinkedHashMap<>();
      frame.put("type", "command");
      frame.put("command", line);
      frame.put("request_id", requestId);
      send(frame);
      try {
        result = outcome.get((timeout == null ? commandTimeout : timeout).toMillis(), TimeUnit.MILLISECONDS);
      } catch (java.util.concurrent.TimeoutException e) {
        throw new CommandException(
            "Command completion timed out; execution outcome is unknown. Inspect state before retrying.",
            snapshot(frames));
      } catch (Exception e) {
        throw new MarinaException(rootMessage(e), e);
      }
    } finally {
      waiters.remove(waiter);
      onDrop.remove(lost);
    }
    if (result == null)
      throw new CommandException(
          "Disconnected before command completion; execution outcome is unknown.", snapshot(frames));
    if (!Boolean.TRUE.equals(result.get("ok"))) {
      Object error = result.get("error");
      throw new CommandException(error == null ? "Command failed" : String.valueOf(error), snapshot(frames));
    }
    return new CommandResult(snapshot(frames));
  }

  private static List<Map<String, Object>> snapshot(List<Map<String, Object>> frames) {
    synchronized (frames) {
      return List.copyOf(frames);
    }
  }

  /** Every command this session may run, with typed forms ({@code marina.capabilities.v1}). */
  public Map<String, Object> capabilities() {
    if (!isConnected()) throw new ConnectionLostException("Connection lost: not connected.");
    String requestId = UUID.randomUUID().toString();
    CompletableFuture<Map<String, Object>> outcome = new CompletableFuture<>();
    Consumer<Map<String, Object>> waiter =
        f -> {
          Map<String, Object> reply = Json.object(Wire.data(f).get("capabilities"));
          if (reply != null && requestId.equals(reply.get("request_id"))) outcome.complete(reply);
        };
    waiters.add(waiter);
    try {
      send(Map.of("type", "capabilities", "request_id", requestId));
      Map<String, Object> reply = await(outcome, Duration.ofSeconds(10), "Capability discovery timed out.");
      if (reply.get("error") != null) throw new MarinaException(String.valueOf(reply.get("error")));
      return reply;
    } finally {
      waiters.remove(waiter);
    }
  }

  // ─── Listening ─────────────────────────────────────────────────────────

  /**
   * Call {@code listener} with every frame the server sends you (command replies excepted).
   * Returns a handle that stops listening.
   */
  public Runnable onFrame(Consumer<Map<String, Object>> listener) {
    listeners.add(listener);
    return () -> listeners.remove(listener);
  }

  /** Called once when the connection closes for good: {@link #close()}, or reconnecting gave up. */
  public void onClose(Runnable callback) {
    onClose.add(callback);
  }

  void removeOnClose(Runnable callback) {
    onClose.remove(callback);
  }

  /**
   * Called with the resumed session each time the SDK reconnects on its own after a dropped
   * socket. Returns a handle that stops listening.
   */
  public Runnable onReconnect(Consumer<Session> callback) {
    onReconnect.add(callback);
    return () -> onReconnect.remove(callback);
  }

  /** @internal SDK waiters: called on the socket's thread, in order, before listeners. */
  void addWaiter(Consumer<Map<String, Object>> waiter) {
    waiters.add(waiter);
  }

  void removeWaiter(Consumer<Map<String, Object>> waiter) {
    waiters.remove(waiter);
  }

  @Override
  public void close() {
    closing = true;
    connected = false;
    Thread r = reconnector;
    if (r != null) r.interrupt();
    WebSocket socket = ws;
    if (socket != null && !socket.isOutputClosed()) {
      try {
        socket.sendClose(WebSocket.NORMAL_CLOSURE, "").get(5, TimeUnit.SECONDS);
      } catch (Exception ignored) {
        // already gone: closing either way
      }
      socket.abort();
    }
    finish();
  }

  private void finish() {
    if (closed.getCount() == 0) return;
    connected = false;
    closed.countDown();
    pinger.shutdownNow();
    for (Runnable callback : onDrop) callback.run();
    for (Runnable callback : onClose) {
      try {
        callback.run();
      } catch (RuntimeException e) {
        LOG.log(Level.WARNING, "A close callback failed", e);
      }
    }
    events.shutdown();
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private void send(Map<String, Object> frame) {
    WebSocket socket = ws;
    if (socket == null || socket.isOutputClosed()) throw new ConnectionLostException("The connection is closed.");
    try {
      synchronized (this) {
        socket.sendText(Json.write(frame), true).get(30, TimeUnit.SECONDS);
      }
    } catch (Exception e) {
      throw new ConnectionLostException("Could not send: " + rootMessage(e), e);
    }
  }

  /** The answer to our login or auth: a session frame carrying a token, while we wait for one. */
  private boolean isSessionFrame(Map<String, Object> frame) {
    return authenticating && Wire.classify(frame) == Wire.Kind.SESSION && Wire.data(frame).get("token") instanceof String;
  }

  private void deliver(Map<String, Object> frame) {
    if (isSessionFrame(frame)) {
      Map<String, Object> data = Wire.data(frame);
      Session previous = session;
      Object name = data.get("name");
      session =
          new Session(
              String.valueOf(data.get("entityId")),
              name instanceof String n ? n : previous != null ? previous.name() : "",
              data.get("token") instanceof String t ? t : "",
              "slash-v1".equals(data.get("worldCommandProtocol")));
    }
    for (Consumer<Map<String, Object>> waiter : waiters) {
      try {
        waiter.accept(frame);
      } catch (RuntimeException e) {
        LOG.log(Level.WARNING, "An SDK waiter failed", e);
      }
    }
    Map<String, Object> data = Wire.data(frame);
    if (data.get("command_result") != null || data.get("capabilities") != null) return;
    if (events.isShutdown()) return;
    events.execute(
        () -> {
          for (Consumer<Map<String, Object>> listener : listeners) {
            try {
              listener.accept(frame);
            } catch (RuntimeException e) {
              LOG.log(Level.WARNING, "A frame listener failed", e);
            }
          }
        });
  }

  // ─── Reconnecting ──────────────────────────────────────────────────────

  /** A socket reported its end. Only the current one counts. */
  private void dropped(long socketGeneration) {
    if (socketGeneration != generation.get()) return;
    connected = false;
    for (Runnable callback : onDrop) callback.run();
    if (closing || isClosed() || reconnecting.get()) return;
    if (session == null) {
      finish();
      return;
    }
    if (!reconnecting.compareAndSet(false, true)) return;
    Thread thread = new Thread(this::reconnectLoop, "marina-reconnect");
    thread.setDaemon(true);
    reconnector = thread;
    thread.start();
  }

  private void reconnectLoop() {
    int attempt = 0;
    while (attempt < RECONNECT_ATTEMPTS) {
      try {
        Thread.sleep(reconnectDelayMs(attempt));
      } catch (InterruptedException e) {
        reconnecting.set(false);
        return;
      }
      attempt++;
      if (closing || isClosed()) {
        reconnecting.set(false);
        return;
      }
      Session s = session;
      try {
        WebSocket old = ws;
        if (old != null && !old.isOutputClosed()) old.abort();
        resume(s.token());
      } catch (MarinaException failed) {
        LOG.log(Level.FINE, "Reconnect try " + attempt + " failed: " + failed.getMessage());
        WebSocket current = ws;
        if (current != null) current.abort();
        continue;
      }
      reconnecting.set(false);
      if (!connected) {
        // dropped again before we noticed: keep trying, from the start
        if (!reconnecting.compareAndSet(false, true)) return;
        attempt = 0;
        continue;
      }
      Session back = session;
      for (Consumer<Session> callback : onReconnect) {
        try {
          callback.accept(back);
        } catch (RuntimeException e) {
          LOG.log(Level.WARNING, "A reconnect callback failed", e);
        }
      }
      return;
    }
    reconnecting.set(false);
    LOG.log(Level.WARNING, "Gave up reconnecting to " + wsUrl + " after " + RECONNECT_ATTEMPTS + " tries");
    finish();
  }

  private final class Reader implements WebSocket.Listener {
    private final StringBuilder partial = new StringBuilder();
    private final long socketGeneration;

    Reader(long socketGeneration) {
      this.socketGeneration = socketGeneration;
    }

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
        try {
          Map<String, Object> frame = Json.object(Json.parse(text));
          if (frame != null) deliver(frame);
        } catch (IllegalArgumentException notJson) {
          // not JSON: not part of the protocol
        }
      }
      webSocket.request(1);
      return null;
    }

    @Override
    public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
      dropped(socketGeneration);
      return null;
    }

    @Override
    public void onError(WebSocket webSocket, Throwable error) {
      dropped(socketGeneration);
    }
  }
}
