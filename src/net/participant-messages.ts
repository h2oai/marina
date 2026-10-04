// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { parseTraceLinks } from "../agent/execution-trace";
import type { RateLimiter } from "../auth/rate-limiter";
import { commandManifest } from "../engine/command-manifest";
import { commandCompletion, withCommandResponse } from "../engine/command-response";
import { previewParticipantContext } from "../engine/commands/context";
import type { Engine } from "../engine/engine";
import { getErrorMessage } from "../engine/errors";
import { onboardParticipant } from "../engine/onboarding";
import { ownedTraceLinks, runWithTraceLinks } from "../engine/trace-context";
import { type CodingCommandTarget, parseCodingCommandTarget } from "../sdk/command-target";
import type { Perception } from "../types";

export interface ParticipantMessage {
  type: string;
  name?: string;
  command?: string;
  token?: string;
  internalToken?: string;
  request_id?: string;
  coding_target?: unknown;
  trace_links?: unknown;
  capability_key?: string;
  options?: Record<string, unknown>;
}

/** One participation protocol for the network and the native desktop bridge.
 * Transport admission, origin checks and gateway authentication stay at ingress.
 * Queued execution revalidates the connection before entering the engine.
 */
export function handleParticipantMessage(
  engine: Engine,
  ws: { data: { connId: string }; readonly readyState: number; send(data: string): unknown },
  parsed: ParticipantMessage,
  rateLimiter?: RateLimiter,
): void {
  const connId = ws.data.connId;
  if (!parsed || typeof parsed !== "object" || ws.readyState !== 1) return;
  if (parsed.type === "login" && parsed.name) {
    const result = engine.login(connId, parsed.name, parsed.internalToken);
    if ("error" in result) {
      ws.send(
        JSON.stringify({
          kind: "auth_error",
          timestamp: Date.now(),
          data: { text: result.error },
        }),
      );
      return;
    }
    ws.send(
      JSON.stringify({
        kind: "system",
        timestamp: Date.now(),
        data: {
          text: `Logged in as ${result.name}.`,
          entityId: result.entityId,
          name: result.name,
          token: result.token,
          commandProtocol: "correlated-v1",
          worldCommandProtocol: "slash-v1",
          codingTargetProtocol: "session-run-v1",
          activeEvolutionSessions: engine.getActiveEvolutionSessions(result.name),
        },
      }),
    );
    void onboardParticipant(engine, result.entityId, "websocket", false);
    return;
  }

  if (parsed.type === "auth" && parsed.token) {
    const result = engine.reconnect(connId, parsed.token, parsed.internalToken);
    if ("error" in result) {
      ws.send(
        JSON.stringify({
          kind: "auth_error",
          timestamp: Date.now(),
          data: { text: result.error },
        }),
      );
      return;
    }
    ws.send(
      JSON.stringify({
        kind: "system",
        timestamp: Date.now(),
        data: {
          text: `Reconnected as ${result.name}.`,
          entityId: result.entityId,
          name: result.name,
          token: result.token,
          commandProtocol: "correlated-v1",
          worldCommandProtocol: "slash-v1",
          codingTargetProtocol: "session-run-v1",
          activeEvolutionSessions: engine.getActiveEvolutionSessions(result.name),
        },
      }),
    );
    void onboardParticipant(engine, result.entityId, "websocket", true);
    return;
  }

  if (parsed.type === "context_preview") {
    const id = engine.getConnectionEntity(connId);
    const requestId =
      typeof parsed.request_id === "string" ? parsed.request_id.slice(0, 100) : undefined;
    const deliver = (result: unknown) => {
      if (engine.getConnectionEntity(connId) !== id) return;
      ws.send(
        JSON.stringify({
          kind: "system",
          timestamp: Date.now(),
          tag: "context_preview",
          data: { context_preview: result },
        }),
      );
    };
    if (!id || (rateLimiter && !rateLimiter.consume(id))) {
      deliver({
        request_id: requestId,
        error: id ? "Rate limited. Please slow down." : "Sign in to preview context.",
      });
      return;
    }
    void previewParticipantContext(
      { db: engine.db, getEntity: (entityId) => engine.entities.get(entityId) },
      id,
      { ...parsed.options, request_id: requestId },
    ).then(deliver, (error) => deliver({ request_id: requestId, error: getErrorMessage(error) }));
    return;
  }
  if (parsed.type === "capabilities") {
    const id = engine.getConnectionEntity(connId);
    const entity = id ? engine.entities.get(id) : undefined;
    if (!entity || (rateLimiter && !rateLimiter.consume(entity.id))) {
      ws.send(
        JSON.stringify({
          kind: "system",
          timestamp: Date.now(),
          tag: "capabilities",
          data: {
            capabilities: {
              request_id: parsed.request_id,
              error: entity
                ? "Rate limited. Please slow down."
                : "Sign in to discover capabilities.",
            },
          },
        }),
      );
      return;
    }
    const roomCommands = engine.getEntityRoom(entity.id)?.module.commands;
    const key = JSON.stringify([
      engine.commands.epoch,
      engine.commands.revision,
      entity.room,
      entity.properties.rank,
      entity.properties.active_modal,
      Object.keys(roomCommands ?? {}),
    ]);
    const manifest = {
      schema: "marina.capabilities.v1",
      request_id: parsed.request_id,
      revision: engine.commands.revision,
      key,
      ...(parsed.capability_key === key
        ? { unchanged: true }
        : {
            commands: commandManifest(engine.commands, {
              rank: entity.properties.rank,
              modal: entity.properties.active_modal,
              roomCommands,
            }),
          }),
    };
    ws.send(
      JSON.stringify({
        kind: "system",
        timestamp: Date.now(),
        tag: "capabilities",
        data: { capabilities: manifest },
      }),
    );
    return;
  }

  if (parsed.type === "command" && typeof parsed.command === "string") {
    const requestId = typeof parsed.request_id === "string" ? parsed.request_id : undefined;
    const send = (p: Perception) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(p));
    };
    const refuse = (message: string) => {
      if (requestId) send(commandCompletion(requestId, message));
      else send({ kind: "error", timestamp: Date.now(), data: { text: message } });
    };
    if (requestId && requestId.length > 100) {
      refuse("Command request ID exceeds 100 characters.");
      return;
    }
    let codingTarget: CodingCommandTarget | undefined;
    try {
      if (parsed.coding_target !== undefined)
        codingTarget = parseCodingCommandTarget(parsed.coding_target);
    } catch (error) {
      refuse(getErrorMessage(error));
      return;
    }
    const entityId = engine.getConnectionEntity(connId);
    if (entityId) {
      // Rate limit check
      if (rateLimiter && !rateLimiter.consume(entityId)) {
        refuse("Rate limited. Please slow down.");
        return;
      }
      const command = parsed.command;
      // Request traces this command serves: only ones Marina delivered
      // to this entity survive (a forged link is dropped).
      const traceLinks = ownedTraceLinks(entityId, parseTraceLinks(parsed.trace_links));
      const admitted = engine.submitCommand(entityId, command, async () => {
        // A queued command must never execute under a replaced/disconnected session.
        const execute = async () => {
          if (engine.getConnectionEntity(connId) !== entityId || ws.readyState !== 1)
            throw new Error("Command connection closed before execution.");
          await runWithTraceLinks(entityId, traceLinks, () =>
            engine.processCommand(entityId, command, { codingTarget }),
          );
        };
        if (requestId) await withCommandResponse(connId, requestId, execute, send);
        else await execute();
      });
      if (!admitted) refuse("World command capacity reached; command did not execute.");
    } else {
      refuse("You're not logged in. Enter your name to begin.");
    }
  }
}
