// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MacroManager } from "../coordination/macro-manager";
import type { MarinaDB } from "../persistence/database";
import { classifyPrimitive } from "../telemetry/primitive-usage";
import type { CommandContext, EngineEvent, Entity, EntityId, RoomContext, RoomId } from "../types";
import type { EntityManager } from "../world/entity-manager";
import type { RoomManager } from "../world/room-manager";
import { getAutonomyPosture } from "./autonomy";
import type { CommandRouter } from "./command-router";
import { trackQuestProgress } from "./commands/quest";
import { getErrorMessage, tryLog } from "./errors";
import type { Logger } from "./logger";
import { getRank, rankName } from "./permissions";
import { checkGateForExecution, recordGateExecution } from "./safety-gates";
import { isLocalUngated } from "./trust-profile";

/** Admission/FIFO/drain belongs to CommandCoordinator; execution policy lives here. */
export interface CommandPhaseHost {
  readonly entities: Pick<EntityManager, "get">;
  readonly rooms: Pick<RoomManager, "get">;
  readonly commands: Pick<CommandRouter, "parse" | "getDef" | "resolve">;
  readonly db?: MarinaDB;
  readonly macroManager?: Pick<MacroManager, "getByName">;
  readonly logger: Logger;
  promptVersion(name: string): string | undefined;
  sendToEntity(id: EntityId, message: string): void;
  processCommand(id: EntityId, raw: string): Promise<void>;
  buildCommandContext(room: RoomId, entity: EntityId): CommandContext | undefined;
  buildContext(room: RoomId): RoomContext | undefined;
  logEvent(event: EngineEvent): void;
}

export class CommandPhaseCoordinator {
  constructor(private readonly host: CommandPhaseHost) {}

  /** Process a single command immediately */
  async execute(entityId: EntityId, raw: string, opts?: { bypassModal?: boolean }): Promise<void> {
    const commandStartedAt = Date.now();
    const entity = this.host.entities.get(entityId);
    if (!entity) return;

    // Engine-initiated housekeeping (brief heartbeat, login look) must not be
    // captured by an entity's active modal — inside Code Mode the rewrite
    // would turn "brief" into the coding task `code brief`.
    const routedRaw = opts?.bypassModal ? raw : this.routeModalCommand(entity, raw);
    const input = this.host.commands.parse(routedRaw, entityId, entity.room);

    if (!input.verb) return;
    const def = this.host.commands.getDef(input.verb);

    const recordUsage = (success: boolean) => {
      if (!this.host.db) return;
      const classification = classifyPrimitive(routedRaw, def?.name);
      const promptVersion =
        entity.kind === "agent" ? this.host.promptVersion(entity.name) : undefined;
      tryLog(this.host.logger, "telemetry", "Primitive usage recording failed", () => {
        this.host.db!.recordPrimitiveUsage({
          actorId: String(entityId),
          actorName: entity.name,
          actorKind: entity.kind,
          source: "command",
          ...classification,
          success,
          latencyMs: Date.now() - commandStartedAt,
          createdAt: commandStartedAt,
          promptVersion,
        });
      });
    };

    const room = this.host.rooms.get(entity.room);
    const handler = this.host.commands.resolve(input.verb, room?.module.commands);

    if (!handler) {
      // Macro fallback: entity macros first, then system macros
      if (this.host.macroManager) {
        const macro =
          this.host.macroManager.getByName(input.verb, entityId as string) ??
          this.host.macroManager.getByName(input.verb, "system");
        if (macro) {
          const commands = macro.command
            .split(";")
            .map((c) => c.trim())
            .filter(Boolean);
          for (const cmd of commands) {
            this.host.processCommand(entityId, cmd);
          }
          return;
        }
      }
      this.host.sendToEntity(entityId, `Unknown command: ${input.verb}. Type "help" for commands.`);
      recordUsage(false);
      return;
    }

    // Enforce minRank on built-in commands. Under the `earned` / `open`
    // autonomy postures, a command that declares a safety gate defers its
    // rank check to the gate — auto-derived rank caps at 4 while gated
    // commands historically demanded 5, which double-locked the ladder the
    // gate registry promised. The gate (with its standing floor, witness
    // path, and destructive-core carve-out) is the real authority; the rank
    // gate remains for ungated commands and for the default guarded posture.
    if (def?.minRank && def.minRank > 0) {
      const rank = getRank(entity);
      const gateIsAuthority = Boolean(
        def.gate && this.host.db && getAutonomyPosture() !== "guarded",
      );
      // LOCAL profile: rank floors are off for the operator's own instance
      // (loopback logins are also promoted to sovereign at login).
      if (rank < def.minRank && !gateIsAuthority && !isLocalUngated()) {
        this.host.sendToEntity(
          entityId,
          `You must be at least ${rankName(def.minRank)} (rank ${def.minRank}) to use "${def.name}".`,
        );
        recordUsage(false);
        return;
      }
    }

    // Enforce safety gate if declared. A gate is a per-operation competence
    // proof — see src/engine/safety-gates.ts. Self-certification stays closed
    // (a standing-only holder is refused in guarded posture with no window),
    // but the ladder is now walkable: `checkGateForExecution` authorizes via
    // unsupervised competence, an operator-declared open posture (non-core
    // gates), a live witness-granted supervision window, or — under the
    // `earned` posture — optimistic supervision whose demonstration counts
    // only after a qualified witness attests it. `recordGateExecution`
    // writes the competence consequence of whichever path authorized us.
    if (def?.gate && this.host.db) {
      const result = checkGateForExecution(this.host.db, entityId, def.gate);
      if (!result.ok) {
        this.host.sendToEntity(entityId, result.reason ?? `Gate "${def.gate}" denied.`);
        recordUsage(false);
        return;
      }
      recordGateExecution(this.host.db, entityId, def.gate, result, `command:${def.name}`);
    }

    const ctx =
      this.host.buildCommandContext(entity.room, entityId) ?? this.host.buildContext(entity.room);
    if (!ctx) return;

    let handlerThrew = false;
    try {
      const result = handler(ctx, input);
      // Await async handlers so callers that `await processCommand` get
      // proper sequencing. Non-awaiting callers ignore the returned Promise
      // and behavior is unchanged for them.
      if (result instanceof Promise) {
        try {
          await result;
        } catch (err) {
          handlerThrew = true;
          const msg = getErrorMessage(err);
          this.host.logger.error("command", `Async error in "${input.verb}"`, { error: msg });
          this.host.sendToEntity(entityId, `Command error: ${msg}`);
        }
      }
    } catch (err) {
      const msg = getErrorMessage(err);
      this.host.logger.error("command", `Error in "${input.verb}"`, { error: msg });
      this.host.sendToEntity(entityId, `Command error: ${msg}`);
      // Track failed command
      if (this.host.db) {
        const entity = this.host.entities.get(entityId);
        if (entity) {
          tryLog(this.host.logger, "tick", "Activity tracking failed", () => {
            this.host.db!.trackActivity(entity.name, "command", input.verb, false);
          });
        }
      }
      recordUsage(false);
      return;
    }

    // Track quest progress based on command type
    this.trackQuest(entityId, input.verb, routedRaw);

    // Track activity for novelty scoring (with success)
    if (this.host.db) {
      const entity = this.host.entities.get(entityId);
      if (entity) {
        tryLog(this.host.logger, "tick", "Activity tracking failed", () => {
          this.host.db!.trackActivity(entity.name, "command", input.verb, true);
          this.host.db!.trackActivity(entity.name, "room_visit", entity.room);
        });
      }
    }

    // NOTE: no self-reported demonstration recording here. Gated commands are
    // unattended dangerous ops (see the gate check above) — self-recording a
    // demonstration on a clean run is exactly the self-certification path that
    // let a standing-only entity auto-unlock a gate. Competence is earned only
    // via operator grant / rank promotion / witnessed demonstration.
    recordUsage(!handlerThrew);

    this.host.logEvent({
      type: "command",
      entity: entityId,
      input: routedRaw,
      timestamp: Date.now(),
    });
  }

  private routeModalCommand(entity: Entity, raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return raw;
    // Explicit world input has the same meaning before, during and after a modal.
    // Normal command permissions still run after routing; this only chooses the grammar.
    if (trimmed.startsWith("/") && trimmed.length > 1) return trimmed.slice(1).trim();

    const activeModal = entity.properties.active_modal;
    if (activeModal !== "code") return raw;

    const verb = trimmed.split(/\s+/, 1)[0]?.toLowerCase();
    if (!verb || verb === "code") return raw;

    if (verb === "exit" || verb === "back" || verb === "world") {
      return "code exit";
    }
    if (verb === "help" || verb === "?") {
      return "code help";
    }

    return `code ${trimmed}`;
  }

  private trackQuest(entityId: EntityId, verb: string, raw?: string): void {
    const entity = this.host.entities.get(entityId);
    if (!entity?.properties.active_quest) return;

    if (verb === "look" || verb === "l") {
      trackQuestProgress(entity, "look");
    } else if (verb === "say" || verb === "'") {
      trackQuestProgress(entity, "say");
    } else if (verb === "examine" || verb === "ex" || verb === "x") {
      trackQuestProgress(entity, "examine");
    } else if (
      [
        "move",
        "go",
        "north",
        "south",
        "east",
        "west",
        "up",
        "down",
        "n",
        "s",
        "e",
        "w",
        "u",
        "d",
        "northeast",
        "northwest",
        "southeast",
        "southwest",
        "ne",
        "nw",
        "se",
        "sw",
      ].includes(verb)
    ) {
      trackQuestProgress(entity, "move", entity.room);
    } else if (verb === "memory") {
      const lower = raw?.toLowerCase() ?? "";
      if (lower.startsWith("memory set ") || lower.startsWith("memory set\t")) {
        trackQuestProgress(entity, "memory_set");
      }
    } else if (verb === "note") {
      const lower = raw?.toLowerCase().trim() ?? "";
      const noteSubs = [
        "list",
        "search",
        "space",
        "delete",
        "link",
        "trace",
        "graph",
        "correct",
        "types",
        "evolve",
      ];
      const firstToken = lower.split(/\s+/)[1] ?? "";
      if (lower !== "note" && !noteSubs.includes(firstToken)) {
        trackQuestProgress(entity, "note_create");
      }
    } else if (verb === "recall") {
      trackQuestProgress(entity, "recall");
    } else if (verb === "reflect") {
      trackQuestProgress(entity, "reflect");
    } else if (verb === "project") {
      const lower = raw?.toLowerCase().trim() ?? "";
      if (lower.includes(" join")) {
        trackQuestProgress(entity, "project_join");
      }
    } else if (verb === "task") {
      const lower = raw?.toLowerCase().trim() ?? "";
      if (lower.startsWith("task claim ")) {
        trackQuestProgress(entity, "task_claim");
      } else if (lower.startsWith("task submit ")) {
        trackQuestProgress(entity, "task_submit");
      }
    } else if (verb === "pool") {
      const lower = raw?.toLowerCase().trim() ?? "";
      if (lower.includes(" add ")) {
        trackQuestProgress(entity, "pool_add");
      }
    } else if (verb === "channel") {
      const lower = raw?.toLowerCase().trim() ?? "";
      if (lower.startsWith("channel send ")) {
        trackQuestProgress(entity, "channel_send");
      }
    }
  }
}
