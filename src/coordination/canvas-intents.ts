// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { tryLog } from "../engine/errors";
import { Logger } from "../engine/logger";
import type { MarinaDB } from "../persistence/database";
import type { CanvasIntentData, CanvasNodeRow } from "../persistence/db-canvas";
import type { EngineEvent, EntityId, RoomId } from "../types";

const logger = new Logger();
type IntentEvent = Extract<EngineEvent, { type: "canvas_intent" }>;

/** Ingress authenticates the actor and authorizes the canvas before calling. */
export interface CanvasIntentContext {
  db: MarinaDB;
  actor: { id?: EntityId; name: string; room?: RoomId };
  logEvent?: (event: IntentEvent) => void;
}

function publish(context: CanvasIntentContext, node: CanvasNodeRow, intent: CanvasIntentData) {
  context.logEvent?.({
    type: "canvas_intent",
    entity: context.actor.id ?? (node.creator_name as EntityId),
    canvasId: node.canvas_id,
    nodeId: node.id,
    prompt: intent.prompt,
    status: intent.status,
    timestamp: node.updated_at,
  });
}

export function claimIntent(context: CanvasIntentContext, nodeId: string) {
  const result = context.db.claimCanvasIntent(nodeId, context.actor.name);
  if (result.ok) publish(context, result.node, result.intent);
  return result;
}

export function failIntent(context: CanvasIntentContext, nodeId: string, reason: string) {
  const result = context.db.failCanvasIntent(nodeId, reason, Date.now(), context.actor.name);
  if (result.ok) publish(context, result.node, result.intent);
  return result;
}

export function completeIntent(
  context: CanvasIntentContext,
  nodeId: string,
  params: { result: string; resultType?: string; resultData?: Record<string, unknown> },
) {
  const { db, actor } = context;
  const result = db.completeCanvasIntent(nodeId, { ...params, completerName: actor.name });
  if (!result.ok) return result;

  publish(context, result.node, result.intent);
  // Exactly one successful transition earns memory, on either ingress. It
  // earns no standing: completion is self-reported and the intent's owner
  // never accepts it (`helping_act` is retired, src/agent/standing.ts).
  if (actor.id && actor.room) {
    tryLog(logger, "canvas", "Could not remember completed intent", () => {
      const memory =
        params.resultType === "a2ui"
          ? `[intent-done-rich] "${result.intent.prompt.slice(0, 120)}" → A2UI result (node ${result.resultNode.id.slice(0, 8)}..)`
          : `[intent-done] "${result.intent.prompt.slice(0, 120)}" → ${params.result.slice(0, 200)}`;
      db.createNote(actor.name, memory, actor.room!, { importance: 7, noteType: "episode" });
    });
  }
  return result;
}
