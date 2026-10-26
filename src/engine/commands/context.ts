// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { buildUnifiedContext, renderUnifiedContext } from "../../memory/unified-context";
import type { MarinaDB } from "../../persistence/database";
import type { CommandUsage } from "../../sdk/command-forms";
import type { CommandDef, Entity, EntityId } from "../../types";
import { refuseCommand } from "../command-response";
import { getErrorMessage } from "../errors";
import { currentEvidenceCutoffMs, entityEvidenceFence } from "../evidence-fence";

interface ContextReader {
  db?: MarinaDB;
  getEntity: (id: EntityId) => Entity | undefined;
}

/** Caller-bound inspection; transports check the requesting connection again before delivery. */
export async function previewParticipantContext(
  deps: ContextReader,
  id: EntityId,
  options: unknown,
) {
  const entity = deps.getEntity(id);
  if (!entity || !deps.db)
    throw new Error("Memory context requires a signed-in resident and persistence.");
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw new Error("Expected context options.");
  const request = options as Record<string, unknown>;
  const { query, scope = "all", budgetBytes = 4096 } = request;
  if (typeof query !== "string" || !query.trim() || query.length > 4000)
    throw new Error("Supply a query of 1–4000 characters.");
  if (scope !== "all" && scope !== "evidence") throw new Error("Scope must be all or evidence.");
  if (
    typeof budgetBytes !== "number" ||
    !Number.isInteger(budgetBytes) ||
    budgetBytes < 256 ||
    budgetBytes > 16384
  )
    throw new Error("budgetBytes must be between 256 and 16384.");
  // A fenced resident (src/engine/evidence-fence.ts) — whether it asks through
  // the `context` command or the out-of-band `context_preview` message — sees
  // only memory known by the cutoff.
  const fence = [currentEvidenceCutoffMs(), entityEvidenceFence(id)?.cutoff].filter(
    (c): c is number => c !== undefined,
  );
  const context = await buildUnifiedContext(deps.db, entity.name, query, {
    scope,
    budgetBytes,
    creditReflections: false,
    ...(fence.length ? { asOf: Math.min(...fence) } : {}),
  });
  if (deps.getEntity(id) !== entity) throw new Error("Resident session expired.");
  return {
    schema: "marina.context.preview.v1" as const,
    request_id:
      typeof request.request_id === "string" ? request.request_id.slice(0, 100) : undefined,
    createdAt: Date.now(),
    context,
  };
}

/** `context` forms; `memory context …` (src/engine/command-families.ts) shares them. */
export const CONTEXT_USAGE: CommandUsage[] = [
  { syntax: "context <query>", effect: "read" },
  { syntax: "context api <JSON>", effect: "read" },
];

/** Inspection uses the same retrieval policy as prompt context, without recall rewards. */
export function contextCommand(deps: {
  db?: MarinaDB;
  getEntity: (id: EntityId) => Entity | undefined;
}): CommandDef {
  return {
    name: "context",
    category: "Memory",
    minRank: 0,
    help: "Preview your own query-specific memory context without awarding recall credit. Usage: context <query>\ncontext api <JSON> — query, scope (all/evidence), budgetBytes (256–16384), request_id. This is a preview, not another participant's prompt or a historical delivery receipt.",
    usage: CONTEXT_USAGE,
    handler: async (ctx, input) => {
      if (!input.args.trim()) {
        refuseCommand(ctx, input.entity, "Usage: context <query> | context api <JSON>");
        return;
      }
      let requestId: string | undefined;
      try {
        if (input.args.length > 32768) throw new Error("Context request exceeds 32768 characters.");
        const request = input.args.startsWith("api ")
          ? JSON.parse(input.args.slice(4))
          : { query: input.args };
        requestId =
          typeof request?.request_id === "string" ? request.request_id.slice(0, 100) : undefined;
        const result = await previewParticipantContext(deps, input.entity, request);
        ctx.send(
          input.entity,
          requestId
            ? ""
            : `Your memory context preview for: ${result.context.query}\n${renderUnifiedContext(result.context)}`,
          "context_preview",
          { context_preview: result },
        );
      } catch (error) {
        const message = getErrorMessage(error);
        ctx.send(input.entity, message, "context_preview", {
          context_preview: { request_id: requestId, error: message },
        });
      }
    },
  };
}
