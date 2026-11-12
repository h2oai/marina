// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
package ai.h2o.marina;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/**
 * One session with a Marina server, and everything it can reach.
 *
 * <pre>{@code
 * try (Marina marina = Marina.local(Path.of("my-project"))) {
 *   CodingRun run = marina.code().run("Fix the failing test", Coding.Options.defaults().budget("10m"));
 *   for (CodingActivity step : run.steps()) System.out.println(step.label());
 *   RunResult result = run.result();
 *   marina.code().review(result.runId(), "approve");
 * }
 * }</pre>
 */
public final class Marina implements AutoCloseable {
  /** The protocol {@code marina serve <folder> --json} announces. */
  public static final String LOCAL_PROTOCOL = "marina.local.v1";

  private final Connection connection;
  private final Coding code;
  private LocalServer server;
  private Http.RoutingApi routing;
  private Http.InvestigationsApi investigations;
  private Http.PanelsApi panels;

  private Marina(Connection connection, LocalServer server) {
    this.connection = connection;
    this.code = new Coding(connection);
    this.server = server;
  }

  /** Options for {@link #connect(String, ConnectOptions)}: a name to log in, or a token to resume. */
  public record ConnectOptions(String name, String token, String principal, String model, Duration commandTimeout) {
    /** Log in under this name (2-20 letters or digits). */
    public static ConnectOptions name(String name) {
      return new ConnectOptions(name, null, "agent", null, null);
    }

    /** Resume a dropped session with its token, within 60 s of the drop. */
    public static ConnectOptions token(String token) {
      return new ConnectOptions(null, token, "agent", null, null);
    }

    /** {@code agent} (default: may never approve another's held action) or {@code person}. */
    public ConnectOptions principal(String value) {
      return new ConnectOptions(name, token, value, model, commandTimeout);
    }

    /** The model this participant runs on, shown to others. */
    public ConnectOptions model(String value) {
      return new ConnectOptions(name, token, principal, value, commandTimeout);
    }

    public ConnectOptions commandTimeout(Duration value) {
      return new ConnectOptions(name, token, principal, model, value);
    }
  }

  /** Options for {@link #local(Path, LocalOptions)}. */
  public record LocalOptions(boolean fresh, List<String> command, Map<String, String> env, Duration startTimeout) {
    /** Defaults: the folder's saved database, {@code marina} on PATH, 90 s to start. */
    public static LocalOptions defaults() {
      return new LocalOptions(false, null, Map.of(), Duration.ofSeconds(90));
    }

    /** A throwaway database instead of the folder's saved one. */
    public LocalOptions fresh(boolean value) {
      return new LocalOptions(value, command, env, startTimeout);
    }

    /** How to run the Marina CLI, e.g. {@code List.of("bun", "run", "/path/to/marina/scripts/marina.ts")}. */
    public LocalOptions command(List<String> value) {
      return new LocalOptions(fresh, value, env, startTimeout);
    }

    /** Extra environment for the server (a provider key, {@code MARINA_DEFAULT_MODEL}, ...). */
    public LocalOptions env(Map<String, String> value) {
      return new LocalOptions(fresh, command, value, startTimeout);
    }

    public LocalOptions startTimeout(Duration value) {
      return new LocalOptions(fresh, command, env, value);
    }
  }

  /** Log in to a running Marina under a name. */
  public static Marina connect(String url, String name) {
    return connect(url, ConnectOptions.name(name));
  }

  /** Connect to a running Marina. */
  public static Marina connect(String url, ConnectOptions options) {
    if ((options.name() == null) == (options.token() == null))
      throw new IllegalArgumentException("Pass a name to log in, or a token to resume a session (one of them).");
    Connection connection = new Connection(url, options.principal(), options.model(), options.commandTimeout());
    try {
      if (options.token() != null) connection.resume(options.token());
      else connection.login(options.name());
    } catch (RuntimeException e) {
      connection.close();
      throw e;
    }
    return new Marina(connection, null);
  }

  /** Start a Marina for a folder and connect as its owner, with the default options. */
  public static Marina local(Path folder) {
    return local(folder, LocalOptions.defaults());
  }

  /**
   * Start a Marina for a folder and connect as its owner. It codes in that folder and keeps its
   * sessions and memory in ~/.marina/projects/ (the same home {@code marina <folder>} uses).
   * {@link #close()} stops it. Needs the {@code marina} CLI.
   */
  public static Marina local(Path folder, LocalOptions options) {
    LocalServer server = LocalServer.start(folder, options);
    try {
      Connection connection = new Connection(server.url(), "agent", null, null);
      try {
        connection.login(server.name());
      } catch (RuntimeException e) {
        connection.close();
        throw e;
      }
      return new Marina(connection, server);
    } catch (RuntimeException e) {
      server.stop();
      throw e;
    }
  }

  // ─── The session ───────────────────────────────────────────────────────

  /** The WebSocket session underneath, for anything the front door does not wrap. */
  public Connection connection() {
    return connection;
  }

  /** Code Mode: run coding tasks, follow them, review their changes. */
  public Coding code() {
    return code;
  }

  public Connection.Session session() {
    Connection.Session s = connection.session();
    if (s == null) throw new MarinaException("Not connected.");
    return s;
  }

  /** The newest session token: it signs the HTTP calls and resumes a dropped session. */
  public String token() {
    return session().token();
  }

  public String url() {
    return connection.wsUrl();
  }

  public String httpUrl() {
    return connection.httpUrl();
  }

  /** The server {@code local} started, or null. */
  public LocalServer server() {
    return server;
  }

  /**
   * Run one world command ({@code look}, {@code task list}, ...). Throws CommandException when
   * refused. Coding tasks go through {@link #code()}: in Code Mode a command is still a command.
   */
  public CommandResult command(String text) {
    return connection.command(text);
  }

  /** Every command this session may run, with typed forms and JSON Schemas. */
  public Map<String, Object> capabilities() {
    return connection.capabilities();
  }

  /** The typed forms of one command ({@code say}, {@code task}, ...), from {@link #capabilities()}. */
  public List<CommandForms.Form> forms(String command) {
    return CommandForms.forms(capabilities(), command);
  }

  /** Everything the server sends this session. Returns a handle that stops listening. */
  public Runnable onEvent(Consumer<Map<String, Object>> listener) {
    return connection.onFrame(listener);
  }

  /**
   * Called each time the SDK resumes the session on its own after a dropped socket (with the same
   * entity and a new token). Returns a handle that stops listening.
   */
  public Runnable onReconnect(Consumer<Connection.Session> listener) {
    return connection.onReconnect(listener);
  }

  /** Logged in on a live socket: false while reconnecting, and once closed. */
  public boolean isConnected() {
    return connection.isConnected();
  }

  // ─── Agent helpers ─────────────────────────────────────────────────────

  /** Send a private message. */
  public void tell(String target, String message) {
    command("tell " + target + " " + message);
  }

  /** Say something to the room. */
  public void say(String message) {
    command("say " + message);
  }

  /** {@link #tellAndAwait(String, String, Duration, Tells.Options)} with the default options. */
  public String tellAndAwait(String target, String message, Duration timeout) {
    return tellAndAwait(target, message, timeout, Tells.Options.defaults());
  }

  /**
   * Ask {@code target} and wait for the answer. The question carries a {@code [re:<id>]} tag; a
   * reply echoing it wins at once, an untagged one is accepted after a short grace. Tells from
   * before the question and notices ("I've spent my model-call budget", {@code [notice]} ...) are
   * never the answer. Returns the reply without the tag.
   *
   * @throws MarinaException when no reply arrives in time
   */
  public String tellAndAwait(String target, String message, Duration timeout, Tells.Options options) {
    return Tells.tellAndAwait(connection, target, message, timeout, options);
  }

  /** Wait for a tell from {@code from} (any sender when null); returns its text. */
  public String waitForTell(String from, Duration timeout) {
    return Tells.waitForTell(connection, from, timeout);
  }

  /** Look at the room. */
  public CommandResult look() {
    return command("look");
  }

  /** Look at someone or something. */
  public CommandResult look(String target) {
    return command("look " + target);
  }

  /** Who is online. */
  public CommandResult who() {
    return command("who");
  }

  /** Send a message to a channel. */
  public CommandResult channel(String name, String message) {
    return command("channel send " + name + " " + message);
  }

  /** Save a note to your own memory. */
  public CommandResult note(String text) {
    return command("note " + text);
  }

  /** Recall your notes about {@code query}. */
  public CommandResult recall(String query) {
    return command("recall " + query);
  }

  /** Task operations: {@code task("list")}, {@code task("claim", "12")}. */
  public CommandResult task(String sub, String... args) {
    return command(("task " + sub + " " + String.join(" ", args)).strip());
  }

  // ─── HTTP ──────────────────────────────────────────────────────────────

  /** Participant routing ({@code /api/routing}), signed in as this session. */
  public synchronized Http.RoutingApi routing() {
    if (routing == null) routing = new Http.RoutingApi(httpUrl(), this::token);
    return routing;
  }

  /** Investigations ({@code /api/investigations}), signed in as this session. */
  public synchronized Http.InvestigationsApi investigations() {
    if (investigations == null) investigations = new Http.InvestigationsApi(httpUrl(), this::token);
    return investigations;
  }

  /** Published panels ({@code /api/canvases}) and their live changes, signed in as this session. */
  public synchronized Http.PanelsApi panels() {
    if (panels == null) panels = new Http.PanelsApi(httpUrl(), this::token);
    return panels;
  }

  /** Memory ({@code /v1/memory}), with a memory credential of its own (never the session token). */
  public Http.MemoryApi memory(String credential) {
    return new Http.MemoryApi(httpUrl(), () -> credential);
  }

  /** Disconnect, and stop the server if {@link #local} started it. */
  @Override
  public void close() {
    connection.close();
    LocalServer s = server;
    server = null;
    if (s != null) s.stop();
  }

  /** A {@code marina serve <folder> --json} child and what it announced. */
  public record LocalServer(String url, String http, String name, long pid, String folder, Process process) {

    /** Run {@code marina serve <folder> --json} and wait for its announcement. */
    public static LocalServer start(Path folder, LocalOptions options) {
      List<String> argv = new ArrayList<>(options.command() != null ? options.command() : List.of("marina"));
      argv.add("serve");
      argv.add(folder.toString());
      argv.add("--json");
      if (options.fresh()) argv.add("--fresh");
      ProcessBuilder builder = new ProcessBuilder(argv);
      builder.environment().putAll(options.env() == null ? Map.of() : options.env());
      Process process;
      try {
        // stdin stays a pipe: when this program goes away it closes, and the server stops with it.
        process = builder.start();
      } catch (IOException e) {
        throw new MarinaException(
            "Could not run " + argv.get(0) + ": " + e.getMessage() + ". Install Marina, or pass LocalOptions.command(...).", e);
      }
      Deque<String> tail = new ArrayDeque<>();
      Thread drain =
          new Thread(
              () -> {
                try (BufferedReader err = new BufferedReader(new InputStreamReader(process.getErrorStream(), StandardCharsets.UTF_8))) {
                  for (String line; (line = err.readLine()) != null; ) {
                    synchronized (tail) {
                      tail.addLast(line);
                      if (tail.size() > 40) tail.removeFirst();
                    }
                  }
                } catch (IOException closed) {
                  // the child is gone: the tail keeps what arrived
                }
              },
              "marina-serve-stderr");
      drain.setDaemon(true);
      drain.start();
      CompletableFuture<String> first = new CompletableFuture<>();
      Thread reader =
          new Thread(
              () -> {
                try {
                  BufferedReader out = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8));
                  String line = out.readLine();
                  first.complete(line);
                } catch (IOException e) {
                  first.complete(null);
                }
              },
              "marina-serve-stdout");
      reader.setDaemon(true);
      reader.start();
      String line;
      try {
        line = first.get(options.startTimeout().toMillis(), TimeUnit.MILLISECONDS);
      } catch (Exception e) {
        stop(process);
        throw new MarinaException("The Marina server for " + folder + " was not ready in time." + why(tail));
      }
      if (line == null || line.isBlank()) {
        try {
          process.waitFor(5, TimeUnit.SECONDS);
          drain.join(1000);
        } catch (InterruptedException e) {
          Thread.currentThread().interrupt();
        }
        String code = process.isAlive() ? "running" : String.valueOf(process.exitValue());
        stop(process);
        throw new MarinaException("The Marina server for " + folder + " exited (" + code + ") before it was ready." + why(tail));
      }
      Map<String, Object> a;
      try {
        a = Json.object(Json.parse(line));
      } catch (IllegalArgumentException e) {
        a = null;
      }
      if (a == null || !LOCAL_PROTOCOL.equals(a.get("protocol"))) {
        stop(process);
        throw new MarinaException("marina serve said something unexpected: " + line);
      }
      return new LocalServer(
          String.valueOf(a.get("url")),
          String.valueOf(a.get("http")),
          String.valueOf(a.get("name")),
          ((Number) a.get("pid")).longValue(),
          String.valueOf(a.get("folder")),
          process);
    }

    private static String why(Deque<String> tail) {
      synchronized (tail) {
        if (tail.isEmpty()) return "";
        List<String> lines = new ArrayList<>(tail);
        return "\n" + String.join("\n", lines.subList(Math.max(0, lines.size() - 8), lines.size()));
      }
    }

    private static void stop(Process process) {
      if (!process.isAlive()) return;
      process.destroy();
      try {
        if (!process.waitFor(45, TimeUnit.SECONDS)) {
          process.destroyForcibly();
          process.waitFor();
        }
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        process.destroyForcibly();
      }
    }

    /** Stop the server and wait until it has released the folder's database. */
    public void stop() {
      stop(process);
    }
  }
}
