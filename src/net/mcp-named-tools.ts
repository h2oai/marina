// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RateLimiter } from "../auth/rate-limiter";
import { describeCommand } from "../engine/command-manifest";
import type { Engine } from "../engine/engine";
import { unsplitChainNote } from "../sdk/command-chain";
import { NAMED_COMMAND_FORMS } from "../sdk/named-command-forms";
import { guarded, quoteArg, textArg } from "./mcp-arguments";
import { mcpNamedCommandSchema } from "./mcp-command-schema";
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

  /** The command ran as typed; an unsplit `;` chain only earns one appended line. */
  function withChainNote(input: string, result: McpResult): McpResult {
    if (!input.includes(";")) return result;
    const note = unsplitChainNote(input, engine.commands.allBuiltins().map(describeCommand));
    if (!note) return result;
    return { ...result, content: [...result.content, { type: "text", text: note }] };
  }

  // ── Cognition ─────────────────────────────────────────────────────────

  mcp.tool(
    "think",
    "Your cognitive tool — take notes, recall memories, or reflect on what you know. " +
      "Use 'note' to record observations, 'recall' to search memories, 'reflect' to synthesize, " +
      "'context' for the unified, budgeted view across canonical memory tiers (skills, [trusted], " +
      "[evidence] durable records + sources, [proposal] assistance answers, [unverified] own notes) " +
      "returned as structuredContent.context (schema marina.memory.context.v1).",
    mcpNamedCommandSchema(NAMED_COMMAND_FORMS.think),
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
    mcpNamedCommandSchema(NAMED_COMMAND_FORMS.memory),
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

  mcp.tool(
    "next",
    describeTool("next"),
    mcpNamedCommandSchema(NAMED_COMMAND_FORMS.next),
    async (_args, extra) => runCmd(extra, "next"),
  );

  mcp.tool(
    "brief",
    describeTool("brief"),
    mcpNamedCommandSchema(NAMED_COMMAND_FORMS.brief),
    async ({ mode }, extra) => {
      const cmd = mode === "full" ? "brief full" : "brief";
      return runCmd(extra, cmd);
    },
  );

  mcp.tool(
    "quest",
    describeTool("quest"),
    mcpNamedCommandSchema(NAMED_COMMAND_FORMS.quest),
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
    mcpNamedCommandSchema(NAMED_COMMAND_FORMS.look),
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ target }, extra) => {
      const cmd = target ? `look ${target}` : "look";
      return runCmd(extra, cmd);
    },
  );

  mcp.tool(
    "move",
    describeTool("move"),
    mcpNamedCommandSchema(NAMED_COMMAND_FORMS.move),
    async ({ direction }, extra) => runCmd(extra, direction),
  );

  mcp.tool(
    "say",
    describeTool("say"),
    mcpNamedCommandSchema(NAMED_COMMAND_FORMS.say),
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async ({ message }, extra) => runCmd(extra, `say ${message}`),
  );

  mcp.tool(
    "tell",
    describeTool("tell"),
    mcpNamedCommandSchema(NAMED_COMMAND_FORMS.tell),
    async ({ target, message }, extra) =>
      guarded(() =>
        runCmd(extra, `tell ${quoteArg(target, "target")} ${textArg(message, "message")}`),
      ),
  );

  mcp.tool(
    "who",
    describeTool("who"),
    mcpNamedCommandSchema(NAMED_COMMAND_FORMS.who),
    async (_args, extra) => runCmd(extra, "who"),
  );

  mcp.tool(
    "examine",
    "Examine an entity or item in detail.",
    mcpNamedCommandSchema(NAMED_COMMAND_FORMS.examine),
    async ({ target }, extra) =>
      guarded(() => runCmd(extra, `examine ${quoteArg(target, "target")}`)),
  );

  // ── Coordination ──────────────────────────────────────────────────────

  mcp.tool(
    "channel",
    describeTool("channel"),
    mcpNamedCommandSchema(NAMED_COMMAND_FORMS.channel),
    async ({ input }, extra) => runCmd(extra, `channel ${input}`),
  );

  mcp.tool(
    "board",
    describeTool("board"),
    mcpNamedCommandSchema(NAMED_COMMAND_FORMS.board),
    async ({ input }, extra) => runCmd(extra, `board ${input}`),
  );

  mcp.tool(
    "group",
    describeTool("group"),
    mcpNamedCommandSchema(NAMED_COMMAND_FORMS.group),
    async ({ input }, extra) => runCmd(extra, `group ${input}`),
  );

  mcp.tool(
    "task",
    describeTool("task"),
    mcpNamedCommandSchema(NAMED_COMMAND_FORMS.task),
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async ({ input }, extra) => runCmd(extra, `task ${input}`),
  );

  mcp.tool(
    "crew",
    describeTool("crew"),
    mcpNamedCommandSchema(NAMED_COMMAND_FORMS.crew),
    async ({ input }, extra) => runCmd(extra, `crew ${input}`),
  );

  mcp.tool(
    "evolve",
    describeTool("evolve"),
    mcpNamedCommandSchema(NAMED_COMMAND_FORMS.evolve),
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async ({ input }, extra) => runCmd(extra, `evolve ${input}`),
  );

  mcp.tool(
    "market",
    describeTool("market"),
    mcpNamedCommandSchema(NAMED_COMMAND_FORMS.market),
    async ({ input }, extra) => runCmd(extra, `market ${input}`),
  );

  // ── Canvas & Media ─────────────────────────────────────────────────────

  mcp.tool(
    "canvas",
    describeTool("canvas"),
    mcpNamedCommandSchema(NAMED_COMMAND_FORMS.canvas),
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async ({ input }, extra) => runCmd(extra, `canvas ${input}`),
  );

  // ── Building ──────────────────────────────────────────────────────────

  mcp.tool(
    "build",
    describeTool("build"),
    mcpNamedCommandSchema(NAMED_COMMAND_FORMS.build),
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
    mcpNamedCommandSchema(NAMED_COMMAND_FORMS.flywheel),
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
    mcpNamedCommandSchema(NAMED_COMMAND_FORMS.command),
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async ({ input }, extra) => withChainNote(input, await runInput(extra, input)),
  );

  mcp.tool(
    "batch",
    describeTool("batch"),
    mcpNamedCommandSchema(NAMED_COMMAND_FORMS.batch),
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
    mcpNamedCommandSchema(NAMED_COMMAND_FORMS.probe),
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
    mcpNamedCommandSchema(NAMED_COMMAND_FORMS.watch_create),
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
    mcpNamedCommandSchema(NAMED_COMMAND_FORMS.watch_list),
    async (_args, extra) => runCmd(extra, "watch list"),
  );

  mcp.tool(
    "watch_due",
    "List watches whose cadence has elapsed. Each line is a ready-to-paste probe command.",
    mcpNamedCommandSchema(NAMED_COMMAND_FORMS.watch_due),
    async ({ limit }, extra) => {
      const cmd = limit !== undefined ? `watch due limit:${limit}` : "watch due";
      return runCmd(extra, cmd);
    },
  );

  mcp.tool(
    "watch_retire",
    "Retire a watch spec — future probes skip it. Use when a watch is duplicate, " +
      "stale, or persistently failing.",
    mcpNamedCommandSchema(NAMED_COMMAND_FORMS.watch_retire),
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
    mcpNamedCommandSchema(NAMED_COMMAND_FORMS.help),
    async ({ command }, extra) => {
      const cmd = command ? `help ${command}` : "help";
      return runCmd(extra, cmd);
    },
  );

  mcp.tool(
    "quit",
    describeTool("quit"),
    mcpNamedCommandSchema(NAMED_COMMAND_FORMS.quit),
    async (_args, extra) => {
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
    },
  );
}
