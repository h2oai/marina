import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { RateLimiter } from "../auth/rate-limiter";
import { WS_IDLE_TIMEOUT_SECONDS } from "../engine/constants";
import type { Engine } from "../engine/engine";
import type { Connection, EntityId, Perception } from "../types";
import {
  buildConnectManifest,
  handleSkillRequest,
  negotiateConnectCapabilities,
  registerConnectEndpoint,
} from "./connect-api";

// ─── Session State ────────────────────────────────────────────────────────────

interface McpSession {
  connId: string;
  entityId: EntityId | null;
  perceptionBuffer: Perception[];
  transport: WebStandardStreamableHTTPServerTransport;
  mcp: McpServer;
}

let mcpIdCounter = 0;

import { formatPerception } from "./formatter";

// ─── Helpers ──────────────────────────────────────────────────────────────────

type McpResult = { content: [{ type: "text"; text: string }] };

function text(msg: string): McpResult {
  return { content: [{ type: "text" as const, text: msg }] };
}

function drainPerceptions(session: McpSession): string {
  const perceptions = session.perceptionBuffer.splice(0);
  if (perceptions.length === 0) return "(no output)";
  return perceptions.map((p) => formatPerception(p, "markdown")).join("\n\n");
}

/**
 * Resolves the session and entity for an MCP tool call.
 * Returns the session + entityId, or an error result to return immediately.
 */
function withSession(
  sessions: Map<string, McpSession>,
  extra: { sessionId?: string },
): { session: McpSession; entityId: EntityId } | { error: McpResult } {
  if (!extra.sessionId) return { error: text("Error: no active MCP session.") };
  const session = sessions.get(extra.sessionId);
  if (!session) return { error: text("Error: no active MCP session.") };
  if (!session.entityId) return { error: text("Not logged in. Use the 'login' tool first.") };
  return { session, entityId: session.entityId };
}

/** Shorthand: resolve session, check rate limit, run command, drain output. */
function cmdTool(
  engine: Engine,
  sessions: Map<string, McpSession>,
  extra: { sessionId?: string },
  cmd: string,
  rateLimiter?: RateLimiter,
): McpResult {
  const resolved = withSession(sessions, extra);
  if ("error" in resolved) return resolved.error;
  if (rateLimiter && !rateLimiter.consume(`mcp:${resolved.entityId}`)) {
    return text("Rate limited. Please slow down.");
  }
  engine.processCommand(resolved.entityId, cmd);
  return text(drainPerceptions(resolved.session));
}

// ─── McpServerAdapter ─────────────────────────────────────────────────────────

export class McpServerAdapter {
  // biome-ignore lint: Bun.serve return type
  private server: any = null;
  private sessions = new Map<string, McpSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private engine: Engine,
    private port: number,
    private rateLimiter?: RateLimiter,
  ) {}

  start(): void {
    const engine = this.engine;
    const sessions = this.sessions;
    const self = this;

    const serverOptions = {
      port: this.port,
      idleTimeout: WS_IDLE_TIMEOUT_SECONDS,

      async fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === "/health") {
          return Response.json({
            status: "ok",
            protocol: "mcp",
            sessions: sessions.size,
            rooms: engine.rooms.size,
            entities: engine.entities.size,
          });
        }

        // Connect manifest
        if (url.pathname === "/api/connect") {
          return buildConnectManifest(req, engine);
        }
        if (url.pathname === "/api/connect/negotiate") {
          return negotiateConnectCapabilities(req);
        }

        // Skill document
        if (url.pathname === "/api/skill") {
          return handleSkillRequest();
        }

        if (url.pathname === "/mcp") {
          const sessionId = req.headers.get("mcp-session-id");
          const session = sessionId ? sessions.get(sessionId) : undefined;

          if (session) {
            return session.transport.handleRequest(req);
          }

          // New session
          const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized(newSessionId: string) {
              const connId = `mcp_${++mcpIdCounter}`;
              const newSession: McpSession = {
                connId,
                entityId: null,
                perceptionBuffer: [],
                transport,
                mcp,
              };

              const conn: Connection = {
                id: connId,
                protocol: "mcp",
                entity: null,
                connectedAt: Date.now(),
                send(perception: Perception) {
                  newSession.perceptionBuffer.push(perception);
                },
                close() {
                  sessions.delete(newSessionId);
                  engine.removeConnection(connId);
                },
              };

              engine.addConnection(conn);
              sessions.set(newSessionId, newSession);
            },
            onsessionclosed(closedSessionId: string) {
              const s = sessions.get(closedSessionId);
              if (s) {
                engine.removeConnection(s.connId);
                sessions.delete(closedSessionId);
              }
            },
          });

          const mcp = self.createMcpServer();
          await mcp.connect(transport);

          return transport.handleRequest(req);
        }

        return new Response("Marina MCP Server — connect via MCP protocol at /mcp", {
          status: 200,
        });
      },
    } satisfies Parameters<typeof Bun.serve>[0];

    try {
      this.server = Bun.serve(serverOptions);
    } catch (error) {
      // Some Bun builds intermittently fail to bind port 0 during rapid test and
      // restart cycles. Preserve explicit-port failures, but make ephemeral-port
      // startup resilient by retrying a bounded set of high local ports.
      if (this.port !== 0) throw error;
      let lastError = error;
      for (let attempt = 0; attempt < 8 && !this.server; attempt++) {
        const fallbackPort = 40_000 + Math.floor(Math.random() * 20_000);
        try {
          this.server = Bun.serve({ ...serverOptions, port: fallbackPort });
        } catch (candidateError) {
          lastError = candidateError;
        }
      }
      if (!this.server) throw lastError;
    }

    // Periodic cleanup of stale MCP sessions (every 5 minutes)
    this.cleanupTimer = setInterval(() => this.cleanupStaleSessions(), 300_000);

    this.port = this.server.port ?? this.port;
    registerConnectEndpoint(this.engine, "mcp", this.port);
    console.log(`MCP server listening on http://localhost:${this.port}/mcp`);
  }

  getPort(): number {
    return this.port;
  }

  /** Remove MCP sessions whose connections are no longer in the engine. */
  private cleanupStaleSessions(): void {
    for (const [sessionId, session] of this.sessions) {
      // Check if the engine still knows about this connection
      const connections = this.engine.getConnections();
      if (!connections.has(session.connId)) {
        this.sessions.delete(sessionId);
        session.mcp.close().catch(() => {});
      }
    }
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    for (const [, session] of this.sessions) {
      this.engine.removeConnection(session.connId);
      session.mcp.close().catch(() => {});
    }
    this.sessions.clear();

    if (this.server) {
      this.server.stop();
      this.server = null;
    }
  }

  // ─── MCP Server & Tool Registration ──────────────────────────────────────

  private createMcpServer(): McpServer {
    const engine = this.engine;
    const sessions = this.sessions;
    const rateLimiter = this.rateLimiter;

    const mcp = new McpServer(
      { name: "marina", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );

    function getSession(extra: { sessionId?: string }): McpSession | undefined {
      if (!extra.sessionId) return undefined;
      return sessions.get(extra.sessionId);
    }

    /** Local wrapper that captures rateLimiter from closure. */
    function runCmd(extra: { sessionId?: string }, command: string): McpResult {
      return cmdTool(engine, sessions, extra, command, rateLimiter);
    }

    // ── Bootstrap ─────────────────────────────────────────────────────────

    mcp.tool(
      "login",
      "Log into Marina with a character name. Must be called before other tools.",
      { name: z.string().describe("Character name (2-20 alphanumeric characters)") },
      async ({ name }, extra) => {
        const session = getSession(extra);
        if (!session) return text("Error: no active MCP session.");
        if (session.entityId) return text(`Already logged in. Entity: ${session.entityId}`);
        const result = engine.login(session.connId, name);
        if ("error" in result) return text(result.error);
        session.entityId = result.entityId;
        engine.sendLook(result.entityId);
        engine.sendBrief(result.entityId);
        const output = drainPerceptions(session);
        const tokenNote = result.token ? `\nSession token: \`${result.token}\`` : "";
        const quickRef = [
          "",
          "",
          "## Now",
          "Use the **think** tool to take notes and recall memories.",
          "Use the **memory** tool to set your goal and track beliefs.",
          "Use the **next** tool when you need guidance on what to do.",
          "Use the **brief** tool to get world orientation at any time.",
          "Use the **canvas** tool to publish media, browse the feed, or build interactive UIs.",
          "Use **command** for any other engine command (try: `help`).",
        ].join("\n");
        return text(
          `Logged in as **${name}** (${result.entityId}).${tokenNote}${quickRef}\n\n${output}`,
        );
      },
    );

    mcp.tool(
      "auth",
      "Reconnect using a previously issued session token.",
      { token: z.string().describe("Session token from a previous login") },
      async ({ token }, extra) => {
        const session = getSession(extra);
        if (!session) return text("Error: no active MCP session.");
        if (session.entityId) return text(`Already logged in. Entity: ${session.entityId}`);
        const result = engine.reconnect(session.connId, token);
        if ("error" in result) return text(result.error);
        session.entityId = result.entityId;
        engine.sendLook(result.entityId);
        engine.sendBrief(result.entityId);
        const output = drainPerceptions(session);
        return text(`Reconnected as **${result.name}** (${result.entityId}).\n\n${output}`);
      },
    );

    // ── Cognition ─────────────────────────────────────────────────────────

    mcp.tool(
      "think",
      "Your cognitive tool — take notes, recall memories, or reflect on what you know. " +
        "Use 'note' to record observations, 'recall' to search memories, 'reflect' to synthesize.",
      {
        action: z.enum(["note", "recall", "reflect"]).describe("Cognitive action to perform"),
        text: z
          .string()
          .describe(
            "For note: what you observed. For recall: search query. For reflect: optional topic.",
          ),
        importance: z
          .number()
          .min(1)
          .max(10)
          .optional()
          .describe("Note importance 1-10 (default 5)"),
        type: z
          .enum(["observation", "fact", "decision", "inference", "skill", "episode", "principle"])
          .optional()
          .describe("Note type (default: observation)"),
        modifier: z
          .enum(["recent", "important"])
          .optional()
          .describe("Recall modifier — weight recent or important notes"),
      },
      async ({ action, text: content, importance, type: noteType, modifier }, extra) => {
        switch (action) {
          case "note": {
            let cmd = `note ${content}`;
            if (importance !== undefined) cmd += ` importance ${importance}`;
            if (noteType) cmd += ` type ${noteType}`;
            return runCmd(extra, cmd);
          }
          case "recall": {
            let cmd = `recall ${content}`;
            if (modifier) cmd += ` ${modifier}`;
            return runCmd(extra, cmd);
          }
          case "reflect": {
            const cmd = content ? `reflect ${content}` : "reflect";
            return runCmd(extra, cmd);
          }
        }
      },
    );

    mcp.tool(
      "memory",
      "Manage your core memory — mutable key-value beliefs, goals, and working state. " +
        "Always set a goal first. Update as your understanding evolves.",
      {
        action: z.enum(["set", "get", "list", "delete", "history"]).describe("Memory operation"),
        key: z.string().optional().describe("Memory key (e.g. 'goal', 'ally', 'plan')"),
        value: z.string().optional().describe("Value to store (required for 'set')"),
      },
      async ({ action, key, value }, extra) => {
        switch (action) {
          case "set": {
            if (!key || !value) return text("Both key and value required for memory set.");
            return runCmd(extra, `memory set ${key} ${value}`);
          }
          case "get": {
            if (!key) return text("Key required for memory get.");
            return runCmd(extra, `memory get ${key}`);
          }
          case "list":
            return runCmd(extra, "memory list");
          case "delete": {
            if (!key) return text("Key required for memory delete.");
            return runCmd(extra, `memory delete ${key}`);
          }
          case "history": {
            if (!key) return text("Key required for memory history.");
            return runCmd(extra, `memory history ${key}`);
          }
        }
      },
    );

    mcp.tool(
      "next",
      "Context-aware guidance — tells you the single best thing to do right now based on " +
        "your goal, objectives, claimed tasks, and exploration state.",
      {},
      async (_args, extra) => runCmd(extra, "next"),
    );

    mcp.tool(
      "brief",
      "World orientation signal. Default: compact compass (who is online, counts of projects, " +
        "tasks, pools). Use mode 'full' for detailed briefing with your memory, tasks, " +
        "projects, staffing, and standing.",
      {
        mode: z.enum(["compass", "full"]).optional().describe("Briefing depth (default: compass)"),
      },
      async ({ mode }, extra) => {
        const cmd = mode === "full" ? "brief full" : "brief";
        return runCmd(extra, cmd);
      },
    );

    mcp.tool(
      "quest",
      "Guided objectives and onboarding checklists — track structured workflows with step-by-step progress. " +
        "Complete the onboarding checklist to earn Canvas rank.",
      {
        action: z
          .enum(["status", "list", "start", "complete", "abandon"])
          .optional()
          .describe("Quest action (default: status)"),
        name: z.string().optional().describe("Quest name (for 'start' action)"),
      },
      async ({ action, name }, extra) => {
        const sub = action ?? "status";
        const cmd = sub === "start" && name ? `quest start ${name}` : `quest ${sub}`;
        return runCmd(extra, cmd);
      },
    );

    // ── World ─────────────────────────────────────────────────────────────

    mcp.tool(
      "look",
      "Look at the current room or examine a specific target.",
      { target: z.string().optional().describe("Optional target to look at") },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async ({ target }, extra) => {
        const cmd = target ? `look ${target}` : "look";
        return runCmd(extra, cmd);
      },
    );

    mcp.tool(
      "move",
      "Move in a direction (north, south, east, west, up, down, etc.).",
      { direction: z.string().describe("Direction to move") },
      async ({ direction }, extra) => runCmd(extra, direction),
    );

    mcp.tool(
      "say",
      "Say something to everyone in the current room.",
      { message: z.string().describe("Message to say") },
      { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      async ({ message }, extra) => runCmd(extra, `say ${message}`),
    );

    mcp.tool(
      "tell",
      "Send a private message to another entity.",
      {
        target: z.string().describe("Name of the entity to message"),
        message: z.string().describe("Private message to send"),
      },
      async ({ target, message }, extra) => runCmd(extra, `tell ${target} ${message}`),
    );

    mcp.tool("who", "List all currently online entities.", {}, async (_args, extra) =>
      runCmd(extra, "who"),
    );

    mcp.tool(
      "examine",
      "Examine an entity or item in detail.",
      { target: z.string().describe("Name of the entity or item to examine") },
      async ({ target }, extra) => runCmd(extra, `examine ${target}`),
    );

    // ── Coordination ──────────────────────────────────────────────────────

    mcp.tool(
      "channel",
      "Real-time messaging channels: list, join, leave, send, history. " +
        "Usage: channel <subcommand> [args]",
      {
        input: z.string().describe("Channel subcommand and arguments, e.g. 'send general Hello!'"),
      },
      async ({ input }, extra) => runCmd(extra, `channel ${input}`),
    );

    mcp.tool(
      "board",
      "Persistent message boards for async discussion: list, read, post, reply, search, vote. " +
        "Usage: board <subcommand> [args]",
      {
        input: z
          .string()
          .describe("Board subcommand and arguments, e.g. 'post general My Title | Body text'"),
      },
      async ({ input }, extra) => runCmd(extra, `board ${input}`),
    );

    mcp.tool(
      "group",
      "Groups for coordination — auto-creates a channel and board: list, create, join, leave, " +
        "invite, info. Usage: group <subcommand> [args]",
      {
        input: z
          .string()
          .describe("Group subcommand and arguments, e.g. 'create mygroup My Group Name'"),
      },
      async ({ input }, extra) => runCmd(extra, `group ${input}`),
    );

    mcp.tool(
      "task",
      "Task tracking: list, create, claim, submit, approve, reject, cancel, bundle. " +
        "Usage: task <subcommand> [args]",
      {
        input: z
          .string()
          .describe(
            "Task subcommand and arguments, e.g. 'create Fix the bug | Detailed description'",
          ),
      },
      { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      async ({ input }, extra) => runCmd(extra, `task ${input}`),
    );

    mcp.tool(
      "crew",
      "Multi-agent crews: runtime containers with formations (nsed, chorus, foundry, swarm, " +
        "pipeline, debate, mapreduce, blackboard, symbiosis, research, freeform). Subcommands: " +
        "create, invite, invitations, join, decline, dispatch, info, leave, formation, persist, complete, dissolve. " +
        "Usage: crew <subcommand> [args]",
      {
        input: z
          .string()
          .describe(
            "Crew subcommand and arguments, e.g. 'create alpha alice,bob formation=pipeline -- ship phase'",
          ),
      },
      async ({ input }, extra) => runCmd(extra, `crew ${input}`),
    );

    mcp.tool(
      "evolve",
      "Opt-in native evolution protocols: sessions, create, start, status, analyze, propose, " +
        "evaluate, decide, pause, resume, complete. Uses the same participant permissions and " +
        "world-command path as humans, in-system Pi agents, and SDK clients. Acceptance records " +
        "a decision but never activates or promotes a candidate.",
      {
        input: z
          .string()
          .describe(
            "Evolution subcommand and arguments, e.g. 'propose PromptTrial | hypothesis | note:7'",
          ),
      },
      { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      async ({ input }, extra) => runCmd(extra, `evolve ${input}`),
    );

    mcp.tool(
      "market",
      "Prediction markets: discovery, leaderboards, and forecasts. " +
        "Subcommands: list [open|resolved] | search <query> | view <id> | leaderboard | " +
        "score [entity] | forecast <id>. The `forecast` subcommand runs TabH2O against " +
        "past resolved markets in the same category to produce a calibrated YES/NO " +
        "probability — ground your positions in it and cite the resulting inference note.",
      {
        input: z
          .string()
          .describe(
            "Market subcommand and arguments, e.g. 'forecast market:tech' or 'list resolved'",
          ),
      },
      async ({ input }, extra) => runCmd(extra, `market ${input}`),
    );

    // ── Canvas & Media ─────────────────────────────────────────────────────

    mcp.tool(
      "canvas",
      "Shared visual surface for rich media, feeds, and interactive UIs. " +
        "Subcommands: create <name> [desc] | list | info <name> | " +
        "publish <type> <asset_id> [canvas] [reply:<node_id>] | " +
        "nodes <name> | layout <grid|timeline|feed> <name> | delete <name> | " +
        "asset upload <url> | asset list | asset info <id> | asset delete <id> | " +
        "intent list [canvas] | intent claim <node_id> | intent fail <node_id> [reason] | " +
        "intent complete <node_id> [--type <type>] <result> | " +
        "intent complete-rich <node_id> <a2ui_json>. " +
        "Node types: image, video, pdf, audio, document, text, embed, frame, a2ui. " +
        "The 'feed' canvas auto-populates from board posts, channel messages, task events, " +
        "and market activity. Use 'reply:<node_id>' to thread replies on any node. " +
        "Use 'intent list' to discover nodes with pending work requests from humans, " +
        "'intent claim' to take ownership, 'intent fail' to report inability to complete, " +
        "'intent complete' to deliver text results, " +
        "and 'intent complete-rich' to deliver rich A2UI component results.",
      {
        input: z
          .string()
          .describe(
            "Canvas subcommand and arguments, e.g. 'publish text <asset_id> feed' " +
              "or 'asset upload https://example.com/image.png' or 'layout feed feed'",
          ),
      },
      { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      async ({ input }, extra) => runCmd(extra, `canvas ${input}`),
    );

    // ── Building ──────────────────────────────────────────────────────────

    mcp.tool(
      "build",
      "Extend the world: create rooms, modify descriptions, link exits, edit room code, " +
        "manage templates, create dynamic commands. Usage: build <subcommand> [args]",
      {
        input: z
          .string()
          .describe("Build subcommand and arguments, e.g. 'space my/room A Custom Room'"),
      },
      { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      async ({ input }, extra) => runCmd(extra, `build ${input}`),
    );

    // ── Escape hatch ──────────────────────────────────────────────────────

    mcp.tool(
      "command",
      "Send any raw command to the engine. Use for commands without a dedicated tool " +
        "(e.g. pool, project, orient, score, map, inventory, macro, connect, experiment). " +
        "Type 'help' to see all available commands.",
      { input: z.string().describe("Raw command string to send") },
      { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      async ({ input }, extra) => runCmd(extra, input),
    );

    mcp.tool(
      "batch",
      "Execute multiple commands in sequence, separated by semicolons. " +
        "Example: look ; north ; look ; note Found something",
      {
        input: z.string().describe("Commands separated by semicolons, e.g. 'look ; north ; look'"),
      },
      { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      async ({ input }, extra) => runCmd(extra, `batch ${input}`),
    );

    // ── Resolver / watch (point-in-time observation primitive) ────────────

    mcp.tool(
      "probe",
      "Invoke a resolver against external state and persist the result as a Sample. " +
        "Resolvers turn 'is this market resolved?', 'has this URL changed?', 'what's the " +
        "current value of X?' into a uniform Sample. resolved/changed Samples auto-fire " +
        "the calibration loop. Use kind='resolving' for Kalshi/Polymarket markets; pass " +
        "watch:<note-id> to link the sample to a watch spec.",
      {
        kind: z.string().describe("Resolver kind (e.g. 'resolving', 'echoing')"),
        args: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Resolver-specific args as key:value pairs (e.g. {venue:'kalshi', ticker:'KXFED-26MAR'})",
          ),
        watch: z
          .number()
          .optional()
          .describe("Watch spec note id to link this sample to (for cadenced probes)"),
      },
      async ({ kind, args, watch }, extra) => {
        const argTokens = args
          ? Object.entries(args)
              .map(([k, v]) => `${k}:${v}`)
              .join(" ")
          : "";
        const watchTok = watch !== undefined ? ` watch:${watch}` : "";
        return runCmd(extra, `probe ${kind} ${argTokens}${watchTok}`.trim());
      },
    );

    mcp.tool(
      "watch_create",
      "Create a declarative watch spec. The watching role probes it on cadence; the " +
        "framework auto-retires on closure. Use this for any 'tell me when X' need: " +
        "market resolution intake, time-series sampling, citation tracing, web monitoring.",
      {
        kind: z.string().describe("Resolver kind to invoke on cadence"),
        args: z
          .record(z.string(), z.string())
          .describe("Resolver args (passed to probe each cycle)"),
        cadence: z
          .string()
          .optional()
          .describe("How often to probe: 30s, 5m, 1h, 7d, or 'once' for one-shot. Default: once."),
        retirement: z
          .string()
          .optional()
          .describe(
            "When to retire: 'resolved' (default), 'forever', '5' (after N samples), '7d' (after duration)",
          ),
        notify: z
          .string()
          .optional()
          .describe("Entity or channel to notify on closure (tell or post)"),
      },
      async ({ kind, args, cadence, retirement, notify }, extra) => {
        const argTokens = Object.entries(args)
          .map(([k, v]) => `${k}:${v}`)
          .join(" ");
        const meta = [
          cadence ? `cadence:${cadence}` : "",
          retirement ? `retirement:${retirement}` : "",
          notify ? `notify:${notify}` : "",
        ]
          .filter(Boolean)
          .join(" ");
        return runCmd(extra, `watch create ${kind} ${argTokens} ${meta}`.trim());
      },
    );

    mcp.tool(
      "watch_list",
      "List all active watch specs (cadence + last sample + due status).",
      {},
      async (_args, extra) => runCmd(extra, "watch list"),
    );

    mcp.tool(
      "watch_due",
      "List watches whose cadence has elapsed. Each line is a ready-to-paste probe command.",
      {
        limit: z.number().optional().describe("Maximum entries to return (default 10, max 50)"),
      },
      async ({ limit }, extra) => {
        const cmd = limit !== undefined ? `watch due limit:${limit}` : "watch due";
        return runCmd(extra, cmd);
      },
    );

    mcp.tool(
      "watch_retire",
      "Retire a watch spec — future probes skip it. Use when a watch is duplicate, " +
        "stale, or persistently failing.",
      {
        id: z.number().describe("Watch spec note id (from watch_list)"),
        reason: z.string().optional().describe("Why retiring — recorded in audit trail"),
      },
      async ({ id, reason }, extra) => {
        const cmd = reason ? `watch retire ${id} reason:${reason}` : `watch retire ${id}`;
        return runCmd(extra, cmd);
      },
    );

    // ── Session ───────────────────────────────────────────────────────────

    mcp.tool(
      "help",
      "Get help about available commands.",
      { command: z.string().optional().describe("Specific command to get help for") },
      async ({ command }, extra) => {
        const cmd = command ? `help ${command}` : "help";
        return runCmd(extra, cmd);
      },
    );

    mcp.tool("quit", "Disconnect from Marina and end your session.", {}, async (_args, extra) => {
      const session = getSession(extra);
      if (!session) return text("Error: no active MCP session.");
      if (!session.entityId) return text("Not logged in.");
      const entityId = session.entityId;
      session.entityId = null;
      engine.removeConnection(session.connId);
      return text(`Disconnected entity ${entityId}. Session ended.`);
    });

    return mcp;
  }
}
