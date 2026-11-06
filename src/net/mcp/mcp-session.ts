// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { agentPeerText, isPeerSpeech } from "../../agent/peer-text";
import { renderCommandResult } from "../../agent/tools/shared";
import type { RateLimiter } from "../../auth/rate-limiter";
import { commandManifest } from "../../engine/command-manifest";
import { previewParticipantContext } from "../../engine/commands/context";
import type { Engine } from "../../engine/engine";
import { getErrorMessage } from "../../engine/errors";
import { Logger } from "../../engine/logger";
import { buildUnifiedContext, renderUnifiedContext } from "../../memory/unified-context";
import type { MemoryOperationResult } from "../../sdk/memory-operations";
import type { EntityId, Perception } from "../../types";
import { stripAnsi } from "../ansi";
import { formatPerception } from "../formatter";
import { receiptForUnifiedContext } from "../memory/memory-receipt";
import { mcpAdmission } from "./mcp-admission";
import { memoryMcpResult } from "./mcp-memory-tools";
import { errorText, type McpResult, type McpSession, text } from "./mcp-types";

const logger = new Logger();

/**
 * A perception as an MCP agent reads it, as the in-process agents read it
 * (`src/agent/tools/shared.ts`): a peer's message is the server's own line,
 * one line (` ⏎ ` for its breaks) or structured (`MARINA_PEER_RENDER`), with
 * no Markdown tag in front (a channel's tag is already in the line); anything
 * else is the shared Markdown form.
 */
function agentPerceptionText(p: Perception, self?: string): string {
  if (isPeerSpeech(p))
    return agentPeerText(p, stripAnsi((p.data?.text as string) ?? ""), { self }) || `[${p.kind}]`;
  return formatPerception(p, "markdown");
}

function renderPerceptions(perceptions: Perception[], self?: string): string {
  return perceptions.map((p) => agentPerceptionText(p, self)).join("\n\n");
}

export function drainPerceptions(session: McpSession, self?: string): string {
  const perceptions = session.perceptionBuffer.splice(0);
  if (perceptions.length === 0) return "(no output)";
  return renderPerceptions(perceptions, self);
}

/**
 * Resolves the session and entity for an MCP tool call.
 * Returns the session + entityId, or an error result to return immediately.
 */
function withSession(
  sessions: Map<string, McpSession>,
  extra: { sessionId?: string; signal?: AbortSignal },
): { session: McpSession; entityId: EntityId } | { error: McpResult } {
  if (!extra.sessionId) return { error: text("Error: no active MCP session.") };
  const session = sessions.get(extra.sessionId);
  if (!session) return { error: text("Error: no active MCP session.") };
  if (!session.entityId) return { error: text("Not logged in. Use the 'login' tool first.") };
  return { session, entityId: session.entityId };
}

/** Shorthand: resolve session, check rate limit, run command, drain output. */
export async function cmdTool(
  engine: Engine,
  sessions: Map<string, McpSession>,
  extra: { sessionId?: string; signal?: AbortSignal },
  cmd: string,
  rateLimiter?: RateLimiter,
  contextUpdate?: McpSession["context"],
  inspection?: "capabilities" | "context",
  prepare?: (id: EntityId) => string | McpResult,
): Promise<McpResult> {
  const resolved = withSession(sessions, extra);
  if ("error" in resolved) return { ...resolved.error, isError: true };
  if (rateLimiter && !rateLimiter.consume(`mcp:${resolved.entityId}`)) {
    return { ...text("Rate limited. Please slow down."), isError: true };
  }
  const session = resolved.session;
  const admission = mcpAdmission(engine).enter(session);
  const busy = (message: string): McpResult => ({
    ...errorText(message),
    structuredContent: {
      error: { code: "mcp_overloaded", retryable: true, retryAfterMs: 1000, executed: false },
    },
  });
  if (!admission)
    return busy(
      "World command capacity reached. Retry after one second; this command did not execute.",
    );
  const pending = session.commandTail.then(async () => {
    // Cancellation before admission must not execute a queued mutation. Once a
    // handler starts, its completion still owns the FIFO slot (no Promise.race).
    if (extra.signal?.aborted) return errorText("Request cancelled before execution.");
    if (!admission.canStart())
      return busy("Queue wait expired. Retry this command; it did not execute.");
    // Revoked/evicted sessions cannot use either command output or context.
    if (
      engine.getConnectionEntity(session.connId) !== resolved.entityId ||
      !engine.entities.get(resolved.entityId)
    )
      return errorText("Session expired. Reconnect before using world tools.");
    // Resolve the form after earlier commands finish: a queued move or extension
    // reload must not execute a schema from the participant's previous room.
    if (prepare) {
      const prepared = prepare(resolved.entityId);
      if (typeof prepared !== "string") return prepared;
      cmd = prepared;
    }
    if (contextUpdate) session.context = contextUpdate;
    if (inspection === "context" && contextUpdate?.mode === "off") {
      session.perceptionBuffer.push({
        kind: "system",
        timestamp: Date.now(),
        data: { text: "Automatic task context is off." },
      });
    } else if (inspection) {
      const entity = engine.entities.get(resolved.entityId)!;
      try {
        const data =
          inspection === "capabilities"
            ? {
                capabilities: {
                  schema: "marina.capabilities.v1",
                  revision: engine.commands.revision,
                  commands: commandManifest(engine.commands, {
                    rank: entity.properties.rank,
                    modal: entity.properties.active_modal,
                    roomCommands: engine.getEntityRoom(entity.id)?.module.commands,
                  }),
                },
              }
            : {
                context_preview: await previewParticipantContext(
                  { db: engine.db, getEntity: (id) => engine.entities.get(id) },
                  entity.id,
                  contextUpdate,
                  "mcp",
                ),
              };
        if (engine.getConnectionEntity(session.connId) !== entity.id)
          return errorText("Session expired.");
        const preview = "context_preview" in data ? data.context_preview : undefined;
        session.perceptionBuffer.push({
          kind: "system",
          timestamp: Date.now(),
          data: {
            ...data,
            text: preview
              ? renderUnifiedContext(preview.context)
              : JSON.stringify(data.capabilities),
          },
        });
      } catch (error) {
        return errorText(getErrorMessage(error));
      }
    } else if (!(await engine.dispatchCommand(resolved.entityId, cmd, { notify: false }))) {
      // The session queue orders this client's calls; the engine's per-entity
      // FIFO also orders them against every other ingress of the same entity.
      return busy("World command capacity reached. Retry after one second; it did not execute.");
    }
    const perceptions = session.perceptionBuffer.splice(0);
    const envelope = perceptions.map((p) => p.data?.memory_service).findLast(Boolean) as
      | MemoryOperationResult
      | undefined;
    const preview = perceptions.map((p) => p.data?.context_preview).findLast(Boolean) as
      | Record<string, unknown>
      | undefined;
    const capabilities = perceptions.map((p) => p.data?.capabilities).findLast(Boolean) as
      | Record<string, unknown>
      | undefined;
    const memory = perceptions.map((p) => p.data?.memory).findLast(Boolean) as
      | Record<string, unknown>
      | undefined;
    // Fenced and escaped by the command's trust class, exactly as an
    // in-process agent's tool result is (`renderCommandResult`).
    const self = engine.entities.get(resolved.entityId)?.name;
    const rendered =
      perceptions.length && !inspection
        ? renderCommandResult(cmd, renderPerceptions(perceptions, self))
        : renderPerceptions(perceptions, self) || "(no output)";
    const result: McpResult =
      envelope && !inspection
        ? memoryMcpResult(envelope)
        : {
            ...text(rendered),
            ...(preview
              ? { structuredContent: preview, isError: !!preview.error }
              : capabilities
                ? { structuredContent: capabilities }
                : memory?.schema === "marina.memory.command.v1"
                  ? { structuredContent: { ...memory } }
                  : {}),
          };
    if (
      perceptions.some(
        (perception) => perception.kind === "error" || perception.kind === "auth_error",
      )
    )
      result.isError = true;
    const options = session.context;
    if (
      options?.mode === "auto" &&
      !extra.signal?.aborted &&
      !/^(memory\s+)?context\s/i.test(cmd.replace(/^\//, "")) &&
      !result.isError
    ) {
      try {
        const entity = engine.entities.get(resolved.entityId);
        if (entity && engine.db && engine.getConnectionEntity(session.connId) === entity.id) {
          const query =
            options.querySource === "goal"
              ? engine.db.getCoreMemory(entity.name, "goal")?.value?.trim().slice(0, 4000)
              : options.query;
          if (!query) return result;
          // Shared retrieval checks data/authority revisions and temporal expiry on every reuse.
          const context = await buildUnifiedContext(engine.db, entity.name, query, {
            ...options,
            creditReflections: false,
            surface: "mcp",
          });
          if (engine.getConnectionEntity(session.connId) === entity.id) {
            const receipt = receiptForUnifiedContext(context, crypto.randomUUID());
            result.content.push({
              type: "text",
              text: `Task memory context for your next decision (not the preceding action):\n${renderUnifiedContext(context)}\nDelivery receipt: ${JSON.stringify(receipt)}`,
            });
          }
        }
      } catch (error) {
        // A retrieval failure must never turn an already committed mutation into an apparent failure.
        logger.warn("mcp", `Context enrichment unavailable: ${getErrorMessage(error)}`);
        result.content.push({
          type: "text",
          text: "Optional task context unavailable. The tool result above is unchanged.",
        });
      }
    }
    return result;
  });
  const completion = pending.finally(admission.release);
  // allow-empty-catch: queue tail only; the caller awaits `completion` and sees its error
  session.commandTail = completion.catch(() => undefined);
  return completion;
}
