// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { bold, dim, header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity } from "../../types";

/** A one-sentence front door that preserves the existing command parser. */
export function desireCommand(deps: {
  db: MarinaDB;
  getEntity: (id: string) => Entity | undefined;
  interpretDesire?: (expression: string, context: string) => Promise<string | undefined>;
  captureCognition?: boolean;
}): CommandDef {
  return {
    name: "desire",
    aliases: ["pursue"],
    category: "Cognition",
    minRank: 0,
    help: "Begin with one ordinary-language desire. Usage: desire <what you want to explore, understand, decide, improve, or create>",
    handler: async (ctx, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;
      const expression = input.args.trim();
      if (!expression) {
        ctx.send(
          input.entity,
          "What would you like to explore, understand, decide, improve, or create?\n\nUsage: desire <one sentence>",
        );
        return;
      }
      if (expression.length > 4000) {
        ctx.send(input.entity, "A desire must be 4,000 characters or fewer.");
        return;
      }
      const journey = deps.db.createJourney({
        requesterId: entity.id,
        requesterName: entity.name,
        expression,
      });
      const inputEvent = deps.captureCognition
        ? deps.db.appendCognitiveEvent({
            kind: "input",
            actorId: entity.id,
            journeyId: journey.id,
            payload: { expression },
          })
        : undefined;
      ctx.send(
        input.entity,
        [
          header("Your journey has begun"),
          separator(),
          `${bold("You said:")} ${journey.expression}`,
          `${bold("Current state:")} expressed`,
          "",
          "Marina has preserved your words. No autonomous work is claimed until evidence of action exists.",
          dim(`Add context: journey steer ${journey.id} <context or correction>`),
          dim(`See progress: journey progress ${journey.id}`),
          dim(`See the best result: journey result ${journey.id}`),
        ].join("\n"),
      );

      if (!deps.interpretDesire) return;
      const context = collectContext(deps.db, entity.name, expression);
      try {
        const response = await deps.interpretDesire(expression, context);
        if (!response?.trim()) return;
        const grounding = parseGroundingResponse(response);
        if (deps.captureCognition) {
          deps.db.appendCognitiveEvent({
            kind: "output",
            actorId: "marina:model",
            journeyId: journey.id,
            parentIds: inputEvent ? [inputEvent.id] : [],
            payload: { ...grounding },
          });
        }
        const event = deps.db.appendJourneyEvent({
          journeyId: journey.id,
          kind: "grounding",
          summary: grounding.understanding,
          actorId: "marina:model",
          actorName: "Marina model",
        });
        const outcome = deps.db.appendJourneyEvent({
          journeyId: journey.id,
          kind: grounding.kind === "question" ? "waiting" : "result",
          summary: grounding.text,
          actorId: "marina:model",
          actorName: "Marina model",
          data: {
            partial: grounding.kind === "result",
            initial: true,
            ...(grounding.kind === "question" ? { waitingFor: "requester" } : {}),
          },
        });
        ctx.send(
          input.entity,
          [
            header("Marina's initial understanding"),
            separator(),
            grounding.understanding,
            "",
            dim(`Grounding evidence: journey_event:${event.id}`),
            grounding.kind === "question"
              ? `${bold("One material question:")} ${grounding.text}`
              : `${bold("First useful result (partial):")} ${grounding.text}`,
            dim(`Outcome evidence: journey_event:${outcome.id}`),
            dim(`Correct or add context: journey steer ${journey.id} <context>`),
          ].join("\n"),
        );
      } catch {
        // The preserved journey remains useful in world-only mode. The initial
        // response already makes no autonomous-work claim.
      }
    },
  };
}

interface GroundingResponse {
  understanding: string;
  kind: "question" | "result";
  text: string;
}

function parseGroundingResponse(raw: string): GroundingResponse {
  const bounded = raw.trim().slice(0, 12_000);
  const json = bounded.match(/\{[\s\S]*\}/)?.[0];
  if (json) {
    try {
      const value = JSON.parse(json) as Record<string, unknown>;
      const understanding = cleanModelField(value.understanding);
      const kind =
        value.kind === "question" ? "question" : value.kind === "result" ? "result" : null;
      const text = cleanModelField(value.text);
      if (understanding && kind && text) return { understanding, kind, text };
    } catch {
      // Fall through to a useful partial result rather than losing model work.
    }
  }
  const fallback = bounded.slice(0, 4000);
  return {
    understanding: "Marina interpreted the desire and began a first cognitive pass.",
    kind: "result",
    text: fallback,
  };
}

function cleanModelField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, 4000) : undefined;
}

function collectContext(db: MarinaDB, entityName: string, expression: string): string {
  const lines: string[] = [];
  for (const note of db.recallNotes(entityName, expression).slice(0, 4)) {
    lines.push(`[personal-note:${note.id}] ${note.content}`);
  }
  for (const hit of db.globalSearch(expression).slice(0, 4)) {
    lines.push(`[world:${hit.type}:${hit.context}] ${hit.title}`);
  }
  return lines.join("\n").slice(0, 6000);
}
