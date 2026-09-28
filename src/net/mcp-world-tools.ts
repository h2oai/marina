// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { version as MARINA_VERSION } from "../../package.json";
import type { RateLimiter } from "../auth/rate-limiter";
import { commandManifest, describeCommand } from "../engine/command-manifest";
import type { Engine } from "../engine/engine";
import { getErrorMessage } from "../engine/errors";
import { Logger } from "../engine/logger";
import { onboardParticipant, participantOrientation } from "../engine/onboarding";
import { composeCommand } from "../sdk/command-forms";
import type { EntityId } from "../types";
import { consumeHttpRate } from "./http-utils";
import { commandFormFingerprint, mcpCommandSchema } from "./mcp-command-schema";
import { registerMemoryTools } from "./mcp-memory-tools";
import { registerNamedWorldTools } from "./mcp-named-tools";
import { cmdTool, drainPerceptions } from "./mcp-session";
import { errorText, type McpResult, type McpSession, text } from "./mcp-types";

const logger = new Logger();

export function createWorldMcpServer(
  engine: Engine,
  sessions: Map<string, McpSession>,
  rateLimiter: RateLimiter,
): McpServer {
  const mcp = new McpServer(
    { name: "marina", version: MARINA_VERSION },
    { capabilities: { tools: {} } },
  );

  function getSession(extra: { sessionId?: string; signal?: AbortSignal }): McpSession | undefined {
    if (!extra.sessionId) return undefined;
    return sessions.get(extra.sessionId);
  }

  function describeTool(name: string): string {
    const command = engine.commands.getDef(name);
    return command
      ? describeCommand(command).description +
          "\nThis named tool preserves its existing parameter contract; capabilities and invoke expose all current forms."
      : "Command unavailable in this world; refresh capabilities.";
  }

  /** Local wrapper that captures rateLimiter from closure. */
  function runCmd(
    extra: { sessionId?: string; signal?: AbortSignal },
    command: string,
    context?: McpSession["context"],
    inspection?: "capabilities" | "context",
    prepare?: (id: EntityId) => string | McpResult,
  ): Promise<McpResult> {
    const worldCommand = command.startsWith("/") ? command : `/${command}`;
    return cmdTool(
      engine,
      sessions,
      extra,
      worldCommand,
      rateLimiter,
      context,
      inspection,
      prepare,
    );
  }

  /** Free text escape hatches intentionally keep the resident's current modal grammar. */
  function runInput(
    extra: { sessionId?: string; signal?: AbortSignal },
    command: string,
  ): Promise<McpResult> {
    return runCmd(extra, "", undefined, undefined, () => command);
  }

  async function initializeContext(
    extra: { sessionId?: string; signal?: AbortSignal },
    session: McpSession,
    task: string | undefined,
    mode: "auto" | "manual" | "off",
  ): Promise<McpResult | undefined> {
    const entity = session.entityId ? engine.entities.get(session.entityId) : undefined;
    if (!entity) return undefined;
    const preferences: NonNullable<McpSession["context"]> = {
      mode,
      query: task ?? "",
      querySource: task ? "explicit" : "goal",
      scope: "all",
      budgetBytes: 2048,
    };
    session.context = preferences;
    if (mode === "off") return undefined;
    try {
      preferences.query =
        task ?? engine.db?.getCoreMemory(entity.name, "goal")?.value?.trim().slice(0, 4000) ?? "";
    } catch (error) {
      logger.warn("mcp", `Initial task context unavailable: ${getErrorMessage(error)}`);
      return text("Optional task context unavailable. Your world login succeeded.");
    }
    const query = preferences.query;
    if (!query)
      return mode === "auto"
        ? text(
            "Automatic task context is ready. Set your own goal with memory set goal, or use context with an explicit query. Manual and off modes remain available.",
          )
        : undefined;
    return runCmd(
      extra,
      `context api ${JSON.stringify({ query, budgetBytes: 2048 })}`,
      preferences,
      "context",
    );
  }

  registerMemoryTools(mcp, async (request, extra) => {
    const result = await runCmd(extra, `/memory api ${JSON.stringify(request)}`);
    // Missing persistence or a failed world session must not look like a
    // successful memory write to a coding agent.
    return result.structuredContent ? result : { ...result, isError: true };
  });

  const generatedTools = new Map<string, RegisteredTool>();
  function invokeForm(
    extra: { sessionId?: string; signal?: AbortSignal },
    command: string,
    syntax: string,
    values: Record<string, unknown> = {},
    enabled: string[] = [],
    fingerprint?: string,
  ): Promise<McpResult> {
    return runCmd(extra, "", undefined, undefined, (id) => {
      const entity = engine.entities.get(id)!;
      const entry = commandManifest(engine.commands, {
        roomCommands: engine.getEntityRoom(entity.id)?.module.commands,
      }).find((def) => def.name === command);
      const form = entry?.forms?.find((candidate) => candidate.syntax === syntax);
      if (
        !form ||
        (fingerprint &&
          commandFormFingerprint(form, engine.commands.revision, entry?.owner) !== fingerprint)
      )
        return errorText(
          "Unknown or changed form. Refresh capabilities; room overrides may require plain command input.",
        );
      if (
        Object.keys(values).some((key) => !form.fields.some((field) => field.id === key)) ||
        enabled.some((key) => !form.groups.some((group) => group.id === key))
      )
        return errorText("Unknown field or optional group.");
      const composed = composeCommand(
        form,
        Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)])),
        Object.fromEntries(enabled.map((id) => [id, true])),
      );
      if (Object.keys(composed.errors).length) return errorText(JSON.stringify(composed.errors));
      if (
        enabled.some((id) => {
          const parent = form.groups.find((group) => group.id === id)?.parent;
          return parent && !enabled.includes(parent);
        })
      )
        return errorText("Enable the parent group before its nested options.");
      // The selected schema names a world action even while a modal is active.
      return `/${composed.command}`;
    });
  }

  // Canonical discovery and structured execution work for builtins and live extensions.
  // Existing named tools remain compatibility adapters over runCmd.
  mcp.tool(
    "capabilities",
    "Discover live commands, JSON invocation schemas, aliases, scope, rank and gates. Request a command for its forms; set expose with one exact syntax to generate a focused typed MCP tool. Existing named tools are compatibility adapters.",
    {
      command: z.string().optional(),
      syntax: z.string().optional(),
      expose: z
        .boolean()
        .default(false)
        .describe(
          "Publish one selected syntax as a typed MCP tool, generated from its live manifest. At most 12 focused tools are retained per session.",
        ),
    },
    async ({ command, syntax, expose }, extra) => {
      const result = await runCmd(extra, "help catalog", undefined, "capabilities");
      const manifest = result.structuredContent;
      if (!manifest || !Array.isArray(manifest.commands)) return result;
      const commands = manifest.commands.filter(
        (entry) => !command || entry.name === command || entry.aliases.includes(command),
      );
      let toolName: string | undefined;
      if (expose) {
        const entry = commands.length === 1 && command ? commands[0] : undefined;
        const form = entry?.forms?.find(
          (candidate: { syntax: string }) => candidate.syntax === syntax,
        );
        if (!entry || !form)
          return errorText("Select a current command and exact syntax before exposing its tool.");
        const hash = createHash("sha256").update(form.syntax).digest("hex").slice(0, 10);
        toolName = `world_${entry.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32)}_${hash}`;
        generatedTools.get(toolName)?.remove();
        generatedTools.delete(toolName);
        if (generatedTools.size >= 12) {
          const oldest = generatedTools.keys().next().value!;
          generatedTools.get(oldest)!.remove();
          generatedTools.delete(oldest);
        }
        const fingerprint = commandFormFingerprint(form, engine.commands.revision, entry.owner);
        generatedTools.set(
          toolName,
          mcp.registerTool(
            toolName,
            {
              title: form.syntax,
              description: form.description ?? entry.description ?? entry.help,
              inputSchema: mcpCommandSchema(form),
              annotations: { readOnlyHint: form.effect === "read" },
            },
            async ({ values, enabled }, call) =>
              invokeForm(call, entry.name, form.syntax, values, enabled, fingerprint),
          ),
        );
      }
      const value = {
        ...manifest,
        ...(toolName ? { tool: toolName } : {}),
        commands: command
          ? commands
          : commands.map(({ forms, ...entry }) => ({
              ...entry,
              actions: forms?.map((form: { syntax: string }) => form.syntax),
            })),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(value) }, ...result.content.slice(1)],
        structuredContent: value,
      };
    },
  );
  mcp.tool(
    "invoke",
    "Execute a live capability form. Get its syntax and field ids from capabilities(command). Values use those field ids; enable optional groups by id. Selection and composition never bypass execution gates.",
    {
      command: z.string(),
      syntax: z.string(),
      values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      enabled: z.array(z.string()).optional(),
    },
    async ({ command, syntax, values = {}, enabled = [] }, extra) =>
      invokeForm(extra, command, syntax, values, enabled),
  );

  mcp.tool(
    "context",
    "Preview your own unified memory context for an explicit task/query. mode auto appends freshly authorized task context to later tool responses; manual retrieves only here; off disables automatic context. Call before a decision to inform it.",
    {
      query: z.string().max(4000).optional(),
      mode: z.enum(["auto", "manual", "off"]).default("manual"),
      scope: z.enum(["all", "evidence"]).default("all"),
      budgetBytes: z.number().int().min(256).max(16384).default(2048),
    },
    async ({ query = "", mode, scope, budgetBytes }, extra) => {
      if (mode !== "off" && !query.trim())
        return errorText("Provide the task or query whose memory context you need.");
      return runCmd(
        extra,
        mode === "off"
          ? "help context"
          : `context api ${JSON.stringify({ query, scope, budgetBytes })}`,
        { mode, query, scope, budgetBytes },
        "context",
      );
    },
  );

  // ── Bootstrap ─────────────────────────────────────────────────────────

  mcp.tool(
    "login",
    "Log into Marina with a character name. Must be called before other tools.",
    {
      name: z.string().describe("Character name (2-20 alphanumeric characters)"),
      task: z
        .string()
        .trim()
        .min(1)
        .max(4000)
        .optional()
        .describe("Explicit task query for initial memory context"),
      contextMode: z.enum(["manual", "auto", "off"]).default("auto"),
    },
    async ({ name, task, contextMode }, extra) => {
      const session = getSession(extra);
      if (!session) return text("Error: no active MCP session.");
      if (session.entityId) return text(`Already logged in. Entity: ${session.entityId}`);
      if (!consumeHttpRate("mcpSession", session.throttleKey)) {
        return errorText("Rate limited. Please slow down.");
      }
      const result = engine.login(session.connId, name);
      if ("error" in result) return text(result.error);
      session.context = undefined;
      session.entityId = result.entityId;
      await onboardParticipant(engine, result.entityId, "mcp", false);
      const output = drainPerceptions(session);
      const tokenNote = result.token ? `\nSession token: \`${result.token}\`` : "";
      const response: McpResult = {
        ...text(`Logged in as **${name}** (${result.entityId}).${tokenNote}\n\n${output}`),
        structuredContent: {
          onboarding: participantOrientation(engine, result.entityId, "mcp", false),
        },
      };
      const initial = await initializeContext(extra, session, task, contextMode);
      if (initial) response.content.push(...initial.content);
      return response;
    },
  );

  mcp.tool(
    "auth",
    "Reconnect using a previously issued session token.",
    {
      token: z.string().describe("Session token from a previous login"),
      task: z.string().trim().min(1).max(4000).optional(),
      contextMode: z.enum(["manual", "auto", "off"]).default("auto"),
    },
    async ({ token, task, contextMode }, extra) => {
      const session = getSession(extra);
      if (!session) return text("Error: no active MCP session.");
      if (session.entityId) return text(`Already logged in. Entity: ${session.entityId}`);
      if (!consumeHttpRate("mcpSession", session.throttleKey)) {
        return errorText("Rate limited. Please slow down.");
      }
      const result = engine.reconnect(session.connId, token);
      if ("error" in result) return text(result.error);
      session.context = undefined;
      session.entityId = result.entityId;
      await onboardParticipant(engine, result.entityId, "mcp", true);
      const output = drainPerceptions(session);
      const response: McpResult = {
        ...text(`Reconnected as **${result.name}** (${result.entityId}).\n\n${output}`),
        structuredContent: {
          onboarding: participantOrientation(engine, result.entityId, "mcp", true),
        },
      };
      const initial = await initializeContext(extra, session, task, contextMode);
      if (initial) response.content.push(...initial.content);
      return response;
    },
  );

  registerNamedWorldTools(mcp, { engine, rateLimiter, getSession, describeTool, runCmd, runInput });
  return mcp;
}
