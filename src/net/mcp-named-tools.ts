// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RateLimiter } from "../auth/rate-limiter";
import type { Engine } from "../engine/engine";
import { guarded, quoteArg, textArg } from "./mcp-arguments";
import { errorText, type McpResult, type McpSession, text } from "./mcp-types";

/** Compatibility contracts only. New commands use generated capabilities/invoke forms. */
export function registerNamedWorldTools(
  mcp: McpServer,
  deps: {
    engine: Engine;
    rateLimiter: RateLimiter;
    getSession(extra: { sessionId?: string }): McpSession | undefined;
    describeTool(name: string): string;
    runCmd(
      extra: { sessionId?: string; signal?: AbortSignal },
      command: string,
    ): Promise<McpResult>;
    runInput(
      extra: { sessionId?: string; signal?: AbortSignal },
      command: string,
    ): Promise<McpResult>;
  },
) {
  const { engine, rateLimiter, getSession, describeTool, runCmd, runInput } = deps;

  // ── Cognition ─────────────────────────────────────────────────────────

  mcp.tool(
    "think",
    "Your cognitive tool — take notes, recall memories, or reflect on what you know. " +
      "Use 'note' to record observations, 'recall' to search memories, 'reflect' to synthesize, " +
      "'context' for the unified, budgeted view across canonical memory tiers (skills, [trusted], " +
      "[evidence] durable records + sources, [proposal] assistance answers, [unverified] own notes) " +
      "returned as structuredContent.context (schema marina.memory.context.v1).",
    {
      action: z
        .enum(["note", "recall", "reflect", "context"])
        .describe("Cognitive action to perform"),
      text: z
        .string()
        .describe(
          "For note: what you observed. For recall/context: search query. For reflect: optional topic.",
        ),
      scope: z
        .enum(["all", "evidence"])
        .optional()
        .describe("For context: 'all' (default) or 'evidence' (durable tiers only)"),
      budget: z
        .number()
        .int()
        .min(256)
        .max(65536)
        .optional()
        .describe("For context: total content byte budget (default 4096)"),
      importance: z.number().min(1).max(10).optional().describe("Note importance 1-10 (default 5)"),
      type: z
        .enum(["observation", "fact", "decision", "inference", "skill", "episode", "principle"])
        .optional()
        .describe("Note type (default: observation)"),
      modifier: z
        .enum(["recent", "important"])
        .optional()
        .describe("Recall modifier — weight recent or important notes"),
    },
    async (
      { action, text: content, importance, type: noteType, modifier, scope, budget },
      extra,
    ) => {
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
        case "context": {
          if (!content.trim())
            return { ...text("Query required for think context."), isError: true };
          let cmd = `recall ${content} ${scope === "evidence" ? "evidence" : "all"}`;
          if (budget !== undefined) cmd += ` budget ${budget}`;
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
    async ({ action, key, value }, extra) =>
      guarded(() => {
        switch (action) {
          case "set": {
            if (!key || !value) return text("Both key and value required for memory set.");
            return runCmd(extra, `memory set ${quoteArg(key, "key")} ${textArg(value, "value")}`);
          }
          case "get": {
            if (!key) return text("Key required for memory get.");
            return runCmd(extra, `memory get ${quoteArg(key, "key")}`);
          }
          case "list":
            return runCmd(extra, "memory list");
          case "delete": {
            if (!key) return text("Key required for memory delete.");
            return runCmd(extra, `memory delete ${quoteArg(key, "key")}`);
          }
          case "history": {
            if (!key) return text("Key required for memory history.");
            return runCmd(extra, `memory history ${quoteArg(key, "key")}`);
          }
        }
      }),
  );

  mcp.tool("next", describeTool("next"), {}, async (_args, extra) => runCmd(extra, "next"));

  mcp.tool(
    "brief",
    describeTool("brief"),
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
    describeTool("quest"),
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
    describeTool("look"),
    { target: z.string().optional().describe("Optional target to look at") },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ target }, extra) => {
      const cmd = target ? `look ${target}` : "look";
      return runCmd(extra, cmd);
    },
  );

  mcp.tool(
    "move",
    describeTool("move"),
    { direction: z.string().describe("Direction to move") },
    async ({ direction }, extra) => runCmd(extra, direction),
  );

  mcp.tool(
    "say",
    describeTool("say"),
    { message: z.string().describe("Message to say") },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async ({ message }, extra) => runCmd(extra, `say ${message}`),
  );

  mcp.tool(
    "tell",
    describeTool("tell"),
    {
      target: z.string().describe("Name of the entity to message"),
      message: z.string().describe("Private message to send"),
    },
    async ({ target, message }, extra) =>
      guarded(() =>
        runCmd(extra, `tell ${quoteArg(target, "target")} ${textArg(message, "message")}`),
      ),
  );

  mcp.tool("who", describeTool("who"), {}, async (_args, extra) => runCmd(extra, "who"));

  mcp.tool(
    "examine",
    "Examine an entity or item in detail.",
    { target: z.string().describe("Name of the entity or item to examine") },
    async ({ target }, extra) =>
      guarded(() => runCmd(extra, `examine ${quoteArg(target, "target")}`)),
  );

  // ── Coordination ──────────────────────────────────────────────────────

  mcp.tool(
    "channel",
    describeTool("channel"),
    {
      input: z.string().describe("Channel subcommand and arguments, e.g. 'send general Hello!'"),
    },
    async ({ input }, extra) => runCmd(extra, `channel ${input}`),
  );

  mcp.tool(
    "board",
    describeTool("board"),
    {
      input: z
        .string()
        .describe("Board subcommand and arguments, e.g. 'post general My Title | Body text'"),
    },
    async ({ input }, extra) => runCmd(extra, `board ${input}`),
  );

  mcp.tool(
    "group",
    describeTool("group"),
    {
      input: z
        .string()
        .describe("Group subcommand and arguments, e.g. 'create mygroup My Group Name'"),
    },
    async ({ input }, extra) => runCmd(extra, `group ${input}`),
  );

  mcp.tool(
    "task",
    describeTool("task"),
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
    describeTool("crew"),
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
    describeTool("evolve"),
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
    describeTool("market"),
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
    describeTool("canvas"),
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
    describeTool("build"),
    {
      input: z
        .string()
        .describe("Build subcommand and arguments, e.g. 'space my/room A Custom Room'"),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async ({ input }, extra) => runCmd(extra, `build ${input}`),
  );

  // ── Isolated execution ────────────────────────────────────────────────

  mcp.tool(
    "flywheel",
    "Run and host work in an identity-scoped Flywheel sandbox. Every action is an engine " +
      "command (`code sandbox …`, `code run …`, `code service publish …`), so the same " +
      "rank, transport and `code.exec` competence gates apply as for any other client. " +
      "Actions: create, exec, publish, status, hibernate, resume, stop.",
    {
      action: z.enum(["create", "exec", "publish", "status", "hibernate", "resume", "stop"]),
      image: z.string().optional().describe("Sandbox image override for create"),
      command: z.string().optional().describe("Command for exec (runs `code run <command>`)"),
      args: z.array(z.string()).optional().describe("Arguments for exec"),
      service: z
        .string()
        .optional()
        .describe("Declared `code service` name to publish (for action=publish)"),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async ({ action, image, command, args, service }, extra) =>
      guarded(() => {
        switch (action) {
          case "create":
            return runCmd(
              extra,
              image ? `code sandbox start ${quoteArg(image, "image")}` : "code sandbox start",
            );
          case "exec": {
            if (!command) return errorText("command is required for action=exec.");
            const argv = [command, ...(args ?? [])].map((a, i) =>
              quoteArg(a, i === 0 ? "command" : `args[${i - 1}]`),
            );
            return runCmd(extra, `code run ${argv.join(" ")}`);
          }
          case "publish":
            if (!service) return errorText("service is required for action=publish.");
            return runCmd(extra, `code service publish ${quoteArg(service, "service")}`);
          case "status":
            return runCmd(extra, "code sandbox status");
          case "hibernate":
            return runCmd(extra, "code sandbox hibernate");
          case "resume":
            return runCmd(extra, "code sandbox resume");
          case "stop":
            return runCmd(extra, "code sandbox stop confirm");
        }
      }),
  );

  // ── Escape hatch ──────────────────────────────────────────────────────

  mcp.tool(
    "command",
    "Send any raw command to the engine. Use for commands without a dedicated tool " +
      "(e.g. pool, project, orient, score, map, inventory, macro, connect, experiment). " +
      "Type 'help' to see all available commands.",
    { input: z.string().describe("Raw command string to send") },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async ({ input }, extra) => runInput(extra, input),
  );

  mcp.tool(
    "batch",
    describeTool("batch"),
    {
      input: z.string().describe("Commands separated by semicolons, e.g. 'look ; north ; look'"),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async ({ input }, extra) => runInput(extra, `batch ${input}`),
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
    async ({ kind, args, watch }, extra) =>
      guarded(() => {
        const argTokens = args
          ? Object.entries(args)
              .map(([k, v]) => `${quoteArg(k, "args key")}:${quoteArg(String(v), `args.${k}`)}`)
              .join(" ")
          : "";
        const watchTok = watch !== undefined ? ` watch:${Math.trunc(watch)}` : "";
        return runCmd(extra, `probe ${quoteArg(kind, "kind")} ${argTokens}${watchTok}`.trim());
      }),
  );

  mcp.tool(
    "watch_create",
    "Create a declarative watch spec. The watching role probes it on cadence; the " +
      "framework auto-retires on closure. Use this for any 'tell me when X' need: " +
      "market resolution intake, time-series sampling, citation tracing, web monitoring.",
    {
      kind: z.string().describe("Resolver kind to invoke on cadence"),
      args: z.record(z.string(), z.string()).describe("Resolver args (passed to probe each cycle)"),
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
    async ({ kind, args, cadence, retirement, notify }, extra) =>
      guarded(() => {
        const argTokens = Object.entries(args)
          .map(([k, v]) => `${quoteArg(k, "args key")}:${quoteArg(v, `args.${k}`)}`)
          .join(" ");
        const meta = [
          cadence ? `cadence:${quoteArg(cadence, "cadence")}` : "",
          retirement ? `retirement:${quoteArg(retirement, "retirement")}` : "",
          notify ? `notify:${quoteArg(notify, "notify")}` : "",
        ]
          .filter(Boolean)
          .join(" ");
        return runCmd(extra, `watch create ${quoteArg(kind, "kind")} ${argTokens} ${meta}`.trim());
      }),
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
    async ({ id, reason }, extra) =>
      guarded(() => {
        const cmd = reason
          ? `watch retire ${Math.trunc(id)} reason:${quoteArg(reason, "reason")}`
          : `watch retire ${Math.trunc(id)}`;
        return runCmd(extra, cmd);
      }),
  );

  // ── Session ───────────────────────────────────────────────────────────

  mcp.tool(
    "help",
    describeTool("help"),
    { command: z.string().optional().describe("Specific command to get help for") },
    async ({ command }, extra) => {
      const cmd = command ? `help ${command}` : "help";
      return runCmd(extra, cmd);
    },
  );

  mcp.tool("quit", describeTool("quit"), {}, async (_args, extra) => {
    const session = getSession(extra);
    if (!session) return text("Error: no active MCP session.");
    if (!session.entityId) return text("Not logged in.");
    if (rateLimiter && !rateLimiter.consume(`mcp:${session.entityId}`)) {
      return errorText("Rate limited. Please slow down.");
    }
    const entityId = session.entityId;
    session.entityId = null;
    session.context = undefined;
    engine.removeConnection(session.connId);
    return text(`Disconnected entity ${entityId}. Session ended.`);
  });
}
