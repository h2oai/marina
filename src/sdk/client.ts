import type { Score } from "../coordination/score";
import type { ScoreRun } from "../coordination/score-executor";
import type { EntityId, Perception, RoomId } from "../types";
import { type RunScoreDeps, runScore } from "./conduct";

export type { Perception };

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SessionInfo {
  entityId: EntityId;
  token: string;
  name: string;
}

export interface RoomView {
  id: RoomId;
  short: string;
  long: string;
  items: Record<string, string>;
  exits: string[];
  entities: { id: EntityId; name: string; short: string }[];
}

export interface ClientOptions {
  autoReconnect?: boolean;
  reconnectDelay?: number;
  /** Ping keepalive interval in ms (default: 30000, 0 to disable) */
  pingInterval?: number;
  /** Connection timeout in ms (default: 30000) */
  connectTimeout?: number;
  /** Max reconnect attempts before giving up (default: 10) */
  maxReconnectAttempts?: number;
  /** Max delay between reconnect attempts in ms (default: 30000) */
  maxReconnectDelay?: number;
  /** Command response buffer window in ms (default: 500) */
  commandDrainTimeout?: number;
  /** Callback fired immediately after WebSocket opens, before any login message is sent. */
  onOpen?: (ws: WebSocket) => void;
  /** Internal-agent token. Sent with login/auth messages so the engine can
   * exempt internal room/crew agents from instance login limits. */
  internalToken?: string;
}

type PerceptionHandler = (p: Perception) => void;

export type ClientEventMap = {
  connect: [SessionInfo];
  disconnect: [];
  perception: [Perception];
  error: [Error];
  reconnect_failed: [];
};

type ClientEventName = keyof ClientEventMap;

// ─── MarinaClient ──────────────────────────────────────────────────────────

export class MarinaClient {
  private ws: WebSocket | null = null;
  private url: string;
  private options: Required<Omit<ClientOptions, "onOpen" | "internalToken">> &
    Pick<ClientOptions, "onOpen" | "internalToken">;
  private session: SessionInfo | null = null;
  private handlers: PerceptionHandler[] = [];
  private commandResolvers: Array<{
    resolve: (perceptions: Perception[]) => void;
    buffer: Perception[];
    timeout: ReturnType<typeof setTimeout>;
  }> = [];
  private connected = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private eventListeners = new Map<ClientEventName, Array<(...args: unknown[]) => void>>();

  constructor(url: string, options?: ClientOptions) {
    this.url = url.replace(/\/$/, "");
    this.options = {
      autoReconnect: options?.autoReconnect ?? true,
      reconnectDelay: options?.reconnectDelay ?? 3000,
      pingInterval: options?.pingInterval ?? 30000,
      connectTimeout: options?.connectTimeout ?? 30000,
      maxReconnectAttempts: options?.maxReconnectAttempts ?? 10,
      maxReconnectDelay: options?.maxReconnectDelay ?? 30000,
      commandDrainTimeout: options?.commandDrainTimeout ?? 500,
      onOpen: options?.onOpen ?? undefined,
      internalToken: options?.internalToken ?? undefined,
    };
  }

  /** Check if connected to the server. */
  isConnected(): boolean {
    return this.connected;
  }

  /** Get the server URL. */
  getUrl(): string {
    return this.url;
  }

  // ─── Event Emitter ─────────────────────────────────────────────────────

  /** Subscribe to a client event. */
  on<K extends ClientEventName>(event: K, handler: (...args: ClientEventMap[K]) => void): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event)!.push(handler as (...args: unknown[]) => void);
  }

  /** Unsubscribe from a client event. */
  off<K extends ClientEventName>(event: K, handler: (...args: ClientEventMap[K]) => void): void {
    const listeners = this.eventListeners.get(event);
    if (!listeners) return;
    const idx = listeners.indexOf(handler as (...args: unknown[]) => void);
    if (idx !== -1) listeners.splice(idx, 1);
  }

  private emit<K extends ClientEventName>(event: K, ...args: ClientEventMap[K]): void {
    const listeners = this.eventListeners.get(event);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try {
        listener(...args);
      } catch {
        // Don't let listener errors crash the client
      }
    }
  }

  /** Connect and login with a character name. */
  async connect(name: string): Promise<SessionInfo> {
    await this.ensureWebSocket();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeInternalHandler(handler);
        reject(new Error("Connection timed out"));
      }, this.options.connectTimeout);

      const handler = (p: Perception) => {
        if (p.kind === "system" && p.data?.entityId) {
          clearTimeout(timer);
          this.removeInternalHandler(handler);
          this.reconnectAttempts = 0;
          this.session = {
            entityId: p.data.entityId as EntityId,
            token: (p.data.token as string) ?? "",
            name,
          };
          this.startPing();
          this.emit("connect", this.session);
          resolve(this.session);
        }
        if (p.kind === "error" || p.kind === "auth_error") {
          clearTimeout(timer);
          this.removeInternalHandler(handler);
          reject(new Error((p.data?.text as string) ?? "Login failed"));
        }
      };
      this.addInternalHandler(handler);
      this.send({ type: "login", name, internalToken: this.options.internalToken });
    });
  }

  /** Reconnect using a previously issued session token. */
  async reconnect(token: string): Promise<SessionInfo> {
    await this.ensureWebSocket();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeInternalHandler(handler);
        reject(new Error("Reconnection timed out"));
      }, this.options.connectTimeout);

      const handler = (p: Perception) => {
        if (p.kind === "system" && p.data?.entityId) {
          clearTimeout(timer);
          this.removeInternalHandler(handler);
          this.reconnectAttempts = 0;
          this.session = {
            entityId: p.data.entityId as EntityId,
            token,
            name: (p.data?.text as string)?.match(/as (\w+)/)?.[1] ?? "",
          };
          this.startPing();
          this.emit("connect", this.session);
          resolve(this.session);
        }
        if (p.kind === "error" || p.kind === "auth_error") {
          clearTimeout(timer);
          this.removeInternalHandler(handler);
          reject(new Error((p.data?.text as string) ?? "Reconnection failed"));
        }
      };
      this.addInternalHandler(handler);
      this.send({ type: "auth", token, internalToken: this.options.internalToken });
    });
  }

  /** Send a command and collect resulting perceptions. */
  async command(cmd: string): Promise<Perception[]> {
    if (!this.session) throw new Error("Not connected. Call connect() first.");
    this.send({ type: "command", command: cmd });

    return new Promise((resolve) => {
      const entry = {
        resolve,
        buffer: [] as Perception[],
        timeout: setTimeout(() => {
          const idx = this.commandResolvers.indexOf(entry);
          if (idx !== -1) this.commandResolvers.splice(idx, 1);
          resolve(entry.buffer);
        }, this.options.commandDrainTimeout),
      };
      this.commandResolvers.push(entry);
    });
  }

  /** Subscribe to all incoming perceptions. */
  onPerception(handler: PerceptionHandler): void {
    this.handlers.push(handler);
  }

  /** Remove a perception handler. */
  offPerception(handler: PerceptionHandler): void {
    const idx = this.handlers.indexOf(handler);
    if (idx !== -1) this.handlers.splice(idx, 1);
  }

  /** Get current session info. */
  getSession(): SessionInfo | null {
    return this.session;
  }

  /** Disconnect from the server gracefully. */
  disconnect(): void {
    this.stopPing();
    this.options.autoReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Send quit command before closing to clean up server-side entity
    if (this.session && this.ws && this.connected) {
      this.send({ type: "command", command: "quit" });
    }
    this.connected = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.session = null;
    this.emit("disconnect");
  }

  // ─── Internal WebSocket Management ────────────────────────────────────

  private internalHandlers: PerceptionHandler[] = [];

  private addInternalHandler(h: PerceptionHandler): void {
    this.internalHandlers.push(h);
  }

  private removeInternalHandler(h: PerceptionHandler): void {
    const idx = this.internalHandlers.indexOf(h);
    if (idx !== -1) this.internalHandlers.splice(idx, 1);
  }

  private async ensureWebSocket(): Promise<void> {
    if (this.ws && this.connected) return;

    return new Promise((resolve, reject) => {
      const wsUrl = `${this.url}/ws`;
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.connected = true;
        this.reconnectAttempts = 0;
        if (this.options.onOpen) {
          this.options.onOpen(this.ws!);
        }
        resolve();
      };

      this.ws.onmessage = (event) => {
        try {
          const p = JSON.parse(event.data as string) as Perception;
          this.dispatchPerception(p);
        } catch {
          // Ignore non-JSON messages
        }
      };

      this.ws.onclose = () => {
        const wasConnected = this.connected;
        this.connected = false;
        this.stopPing();

        if (wasConnected) {
          this.emit("disconnect");
        }

        if (this.options.autoReconnect && this.session) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = () => {
        this.emit("error", new Error("WebSocket connection failed"));
        reject(new Error("WebSocket connection failed"));
      };
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      this.emit("reconnect_failed");
      return;
    }

    // Clear any pending reconnect
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    // Exponential backoff: baseDelay * 2^attempts, capped at maxReconnectDelay
    const delay = Math.min(
      this.options.reconnectDelay * 2 ** this.reconnectAttempts,
      this.options.maxReconnectDelay,
    );
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureWebSocket()
        .then(() => {
          if (this.session?.token) {
            this.send({ type: "auth", token: this.session.token });
          }
        })
        .catch(() => {
          // scheduleReconnect will be called again via onclose
        });
    }, delay);
  }

  private dispatchPerception(p: Perception): void {
    // Internal handlers (for connect/reconnect flows)
    for (const h of [...this.internalHandlers]) {
      h(p);
    }

    // Command resolvers (buffer perceptions for command responses)
    for (const resolver of this.commandResolvers) {
      resolver.buffer.push(p);
    }

    // User handlers
    for (const h of this.handlers) {
      try {
        h(p);
      } catch {
        // Don't let user handler errors crash the client
      }
    }

    // Event emitter
    this.emit("perception", p);
  }

  private send(data: Record<string, unknown>): void {
    if (this.ws && this.connected) {
      this.ws.send(JSON.stringify(data));
    }
  }

  // ─── Ping Keepalive ──────────────────────────────────────────────────────

  private startPing(): void {
    this.stopPing();
    if (this.options.pingInterval > 0) {
      this.pingTimer = setInterval(() => {
        this.send({ type: "ping" });
      }, this.options.pingInterval);
    }
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * Send a `tell` to `target` and synchronously wait for the first tell
   * back from that same target — eliminates the multi-tick handoff that
   * normally separates a coordinator's ask from a specialist's reply.
   *
   * Crew-fast-dispatch primitive (see docs/crew-fast-dispatch-design.md):
   * by registering the perception listener BEFORE firing the command we
   * avoid the race where the reply arrives before the listener is armed.
   * The caller's LLM turn is held open inside this single tool call so
   * the round-trip pays one continuation-prompt cost instead of two.
   *
   * Resolves with the raw reply message text (the recipient's
   * `tell <coordinator> <text>`'s `text`). Rejects with an explanatory
   * Error on timeout. Failure modes the caller may want to handle:
   *   - target offline: no perception will match; caller times out
   *   - target ignored you: same as offline
   *   - target replies with multiple tells: only the first is consumed
   */
  async tellAndAwait(target: string, message: string, timeoutMs = 30_000): Promise<string> {
    if (!this.session) throw new Error("Not connected. Call connect() first.");

    let settled = false;
    let resolveReply: (text: string) => void = () => {};
    let rejectReply: (err: Error) => void = () => {};
    const replyPromise = new Promise<string>((res, rej) => {
      resolveReply = res;
      rejectReply = rej;
    });

    const handler = (p: Perception): void => {
      if (settled) return;
      if (p.kind !== "message") return;
      if (p.tag !== "tell") return;
      const data = p.data as Record<string, unknown> | undefined;
      if (data?.senderName !== target) return;
      const text =
        (typeof data?.message === "string" && data.message) ||
        (typeof data?.text === "string" && data.text) ||
        "";
      settled = true;
      clearTimeout(timer);
      this.offPerception(handler);
      resolveReply(typeof text === "string" ? text : String(text));
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      this.offPerception(handler);
      rejectReply(new Error(`tellAndAwait: no reply from "${target}" within ${timeoutMs}ms`));
    }, timeoutMs);

    this.onPerception(handler);

    // Fire the tell. command() resolves on perception drain — if the engine
    // refuses (e.g. target offline) the immediate ack carries the error
    // and the listener simply never matches; caller times out with the
    // explanatory message above. Don't fail-fast on the ack here because
    // an `Online (...)` notification from elsewhere can race the actual
    // tell error and we'd false-negative.
    await this.command(`tell ${target} ${message}`);

    return replyPromise;
  }
}

// ─── MarinaAgent (typed command helpers) ───────────────────────────────────

export class MarinaAgent extends MarinaClient {
  /** Look at the current room or a specific target. */
  async look(target?: string): Promise<RoomView | Perception[]> {
    const cmd = target ? `look ${target}` : "look";
    const perceptions = await this.command(cmd);
    const roomP = perceptions.find((p) => p.kind === "room");
    if (roomP) {
      return roomP.data as unknown as RoomView;
    }
    return perceptions;
  }

  /** Move in a direction. */
  async move(direction: string): Promise<Perception[]> {
    return this.command(direction);
  }

  /** Say something to the room. */
  async say(message: string): Promise<void> {
    await this.command(`say ${message}`);
  }

  /** Send a private message. */
  async tell(target: string, message: string): Promise<void> {
    await this.command(`tell ${target} ${message}`);
  }

  /** Send a message to a channel. */
  async channel(name: string, message: string): Promise<void> {
    await this.command(`channel send ${name} ${message}`);
  }

  /** Get list of online entities. */
  async who(): Promise<Perception[]> {
    return this.command("who");
  }

  /** Get help. */
  async help(command?: string): Promise<Perception[]> {
    return this.command(command ? `help ${command}` : "help");
  }

  /** Check inventory. */
  async inventory(): Promise<Perception[]> {
    return this.command("inventory");
  }

  // ─── Cognition ──────────────────────────────────────────────────────────

  /** Take a note anchored to the current room. */
  async think(
    action: "note" | "recall" | "reflect",
    text: string,
    opts?: { importance?: number; type?: string; modifier?: "recent" | "important" },
  ): Promise<Perception[]> {
    switch (action) {
      case "note": {
        let cmd = `note ${text}`;
        if (opts?.importance !== undefined) cmd += ` importance ${opts.importance}`;
        if (opts?.type) cmd += ` type ${opts.type}`;
        return this.command(cmd);
      }
      case "recall": {
        let cmd = `recall ${text}`;
        if (opts?.modifier) cmd += ` ${opts.modifier}`;
        return this.command(cmd);
      }
      case "reflect":
        return this.command(text ? `reflect ${text}` : "reflect");
    }
  }

  /** Context-aware guidance — what to do next. */
  async next(): Promise<Perception[]> {
    return this.command("next");
  }

  /** World orientation signal. */
  async brief(mode?: "compass" | "full"): Promise<Perception[]> {
    return this.command(mode === "full" ? "brief full" : "brief");
  }

  /** Quest operations. */
  async quest(action?: string, name?: string): Promise<Perception[]> {
    const sub = action ?? "status";
    const cmd = sub === "start" && name ? `quest start ${name}` : `quest ${sub}`;
    return this.command(cmd);
  }

  /** Examine a target. */
  async examine(target: string): Promise<Perception[]> {
    return this.command(`examine ${target}`);
  }

  /** Board operations. */
  async board(sub: string, ...args: string[]): Promise<Perception[]> {
    return this.command(`board ${sub} ${args.join(" ")}`.trim());
  }

  /** Task operations. */
  async task(sub: string, ...args: string[]): Promise<Perception[]> {
    return this.command(`task ${sub} ${args.join(" ")}`.trim());
  }

  /** Group operations. */
  async group(sub: string, ...args: string[]): Promise<Perception[]> {
    return this.command(`group ${sub} ${args.join(" ")}`.trim());
  }

  /** Macro operations. */
  async macro(sub: string, ...args: string[]): Promise<Perception[]> {
    return this.command(`macro ${sub} ${args.join(" ")}`.trim());
  }

  /** Global search. */
  async search(query: string): Promise<Perception[]> {
    return this.command(`search ${query}`);
  }

  /** Save a note (tagged with current room). */
  async note(text: string): Promise<Perception[]> {
    return this.command(`note ${text}`);
  }

  /** List all personal notes. */
  async notes(): Promise<Perception[]> {
    return this.command("note list");
  }

  /** Experiment operations. */
  async experiment(sub: string, ...args: string[]): Promise<Perception[]> {
    return this.command(`experiment ${sub} ${args.join(" ")}`.trim());
  }

  /** Bookmark current room or manage bookmarks. */
  async bookmark(sub?: string, ...args: string[]): Promise<Perception[]> {
    if (!sub) return this.command("bookmark");
    return this.command(`bookmark ${sub} ${args.join(" ")}`.trim());
  }

  /** Export a board's posts. */
  async exportBoard(name: string, format?: string): Promise<Perception[]> {
    return this.command(`export ${name}${format ? ` ${format}` : ""}`);
  }

  /** Create a task bundle (parent container). */
  async taskBundle(title: string, description?: string): Promise<Perception[]> {
    const desc = description ? ` | ${description}` : "";
    return this.command(`task bundle ${title}${desc}`);
  }

  /** Assign a task to a bundle. */
  async taskAssign(taskId: number, bundleId: number): Promise<Perception[]> {
    return this.command(`task assign ${taskId} ${bundleId}`);
  }

  /** List children of a task bundle. */
  async taskChildren(bundleId: number): Promise<Perception[]> {
    return this.command(`task children ${bundleId}`);
  }

  /** Vote on a board post with optional numeric score (1-10). */
  async boardScore(postId: number, direction: string, score?: number): Promise<Perception[]> {
    const scorePart = score ? ` ${score}` : "";
    return this.command(`board vote ${postId} ${direction}${scorePart}`);
  }

  /** Get score breakdown for a board post. */
  async boardScores(postId: number): Promise<Perception[]> {
    return this.command(`board scores ${postId}`);
  }

  /** Core memory operations. */
  async memory(sub: string, ...args: string[]): Promise<Perception[]> {
    return this.command(`memory ${sub} ${args.join(" ")}`.trim());
  }

  /** Scored note retrieval. */
  async recall(query: string, mode?: "recent" | "important"): Promise<Perception[]> {
    const modifier = mode ? ` ${mode}` : "";
    return this.command(`recall ${query}${modifier}`);
  }

  /** Create a reflection from recent notes. */
  async reflect(topic?: string): Promise<Perception[]> {
    return this.command(topic ? `reflect ${topic}` : "reflect");
  }

  /** Note with importance and type. */
  async typedNote(text: string, importance?: number, type?: string): Promise<Perception[]> {
    const imp = importance ? ` importance ${importance}` : "";
    const t = type ? ` type ${type}` : "";
    return this.command(`note ${text}${imp}${t}`);
  }

  /** Link two notes. */
  async noteLink(id1: number, id2: number, rel: string): Promise<Perception[]> {
    return this.command(`note link ${id1} ${id2} ${rel}`);
  }

  /** Correct a note. */
  async noteCorrect(id: number, newText: string): Promise<Perception[]> {
    return this.command(`note correct ${id} ${newText}`);
  }

  /** Trace note graph. */
  async noteTrace(id: number): Promise<Perception[]> {
    return this.command(`note trace ${id}`);
  }

  /** Shared memory pool operations. */
  async pool(sub: string, ...args: string[]): Promise<Perception[]> {
    return this.command(`pool ${sub} ${args.join(" ")}`.trim());
  }

  /**
   * Run a Score live — dispatch each step to its worker via tellAndAwait and
   * thread accessed outputs forward. This is the act of conducting: a Score
   * becomes a running organization. Supply `resolveAssignee` to map role:/model:
   * assignees to concrete agents. See src/sdk/conduct.ts.
   */
  async conduct(score: Score, opts: Omit<RunScoreDeps, "tellAndAwait"> = {}): Promise<ScoreRun> {
    return runScore(score, {
      ...opts,
      tellAndAwait: (target, message, timeoutMs) => this.tellAndAwait(target, message, timeoutMs),
    });
  }

  // ─── Canvas & Assets ─────────────────────────────────────────────────────

  /** Upload an asset from a URL. Returns the asset upload response. */
  async uploadAsset(url: string): Promise<Perception[]> {
    return this.command(`canvas asset upload ${url}`);
  }

  /** List uploaded assets. */
  async listAssets(): Promise<Perception[]> {
    return this.command("canvas asset list");
  }

  /** Delete an asset by ID. */
  async deleteAsset(assetId: string): Promise<Perception[]> {
    return this.command(`canvas asset delete ${assetId}`);
  }

  /** Create a new canvas. */
  async createCanvas(name: string, description?: string): Promise<Perception[]> {
    const desc = description ? ` ${description}` : "";
    return this.command(`canvas create ${name}${desc}`);
  }

  /** List all canvases. */
  async listCanvases(): Promise<Perception[]> {
    return this.command("canvas list");
  }

  /** Publish an asset to a canvas as a typed node. */
  async publishToCanvas(type: string, assetId: string, canvas?: string): Promise<Perception[]> {
    const target = canvas ? ` ${canvas}` : "";
    return this.command(`canvas publish ${type} ${assetId}${target}`);
  }

  /** Get canvas info including nodes. */
  async canvasInfo(name: string): Promise<Perception[]> {
    return this.command(`canvas info ${name}`);
  }

  /** List nodes on a canvas. */
  async canvasNodes(name: string): Promise<Perception[]> {
    return this.command(`canvas nodes ${name}`);
  }

  /** Delete a canvas. */
  async deleteCanvas(name: string): Promise<Perception[]> {
    return this.command(`canvas delete ${name}`);
  }

  // ─── Shell ─────────────────────────────────────────────────────────────

  /** Run a shell command. */
  async run(cmd: string): Promise<Perception[]> {
    return this.command(`run ${cmd}`);
  }

  /** Run a shell command quietly (suppress output). */
  async runQuiet(cmd: string): Promise<Perception[]> {
    return this.command(`run quiet ${cmd}`);
  }

  /** Shell management operations. */
  async shell(sub: string, ...args: string[]): Promise<Perception[]> {
    return this.command(`shell ${sub} ${args.join(" ")}`.trim());
  }

  /** Execute multiple commands in sequence. */
  async batch(...commands: string[]): Promise<Perception[]> {
    return this.command(`batch ${commands.join(" ; ")}`);
  }

  /**
   * Wait for the next incoming perception matching a predicate.
   * Rejects after `timeoutMs` (default 30 seconds).
   */
  async waitForMessage(
    predicate: (p: Perception) => boolean,
    timeoutMs = 30_000,
  ): Promise<Perception> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.offPerception(handler);
        reject(new Error("waitForMessage timed out"));
      }, timeoutMs);

      const handler = (p: Perception) => {
        if (predicate(p)) {
          clearTimeout(timer);
          this.offPerception(handler);
          resolve(p);
        }
      };
      this.onPerception(handler);
    });
  }

  /**
   * Wait for a `tell` (private message) from any sender (or a specific sender).
   * Returns the text of the message.
   */
  async waitForTell(from?: string, timeoutMs = 30_000): Promise<string> {
    const p = await this.waitForMessage(
      (p) =>
        p.kind === "message" &&
        (p.data as Record<string, unknown>)?.subkind === "tell" &&
        (from === undefined || (p.data as Record<string, unknown>)?.from === from),
      timeoutMs,
    );
    return ((p.data as Record<string, unknown>)?.text as string) ?? "";
  }

  /** Gracefully quit and disconnect. */
  async quit(): Promise<void> {
    await this.command("quit");
    this.disconnect();
  }
}
