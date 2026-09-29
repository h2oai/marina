// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";
import type { MacroManager } from "../coordination/macro-manager";
import type { MarinaDB } from "../persistence/database";
import { classifyPrimitive } from "../telemetry/primitive-usage";
import type { CommandContext, EngineEvent, Entity, EntityId, RoomContext, RoomId } from "../types";
import type { EntityManager } from "../world/entity-manager";
import type { RoomManager } from "../world/room-manager";
import { raiseForCommand } from "./challenges";
import { failCommandResponse } from "./command-response";
import type { CommandRouter } from "./command-router";
import { trackQuestProgress } from "./commands/quest";
import { getErrorMessage, tryLog } from "./errors";
import { armGatePass, claimCommandPass, runCommandScope, setCurrentCommand } from "./gate-context";
import type { Logger } from "./logger";
import { getRank, rankName } from "./permissions";
import { checkGateForExecution, recordGateExecution } from "./safety-gates";
import { isLocalUngated } from "./trust-profile";

/** Admission/FIFO/drain belongs to CommandCoordinator; execution policy lives here. */
export interface CommandPhaseHost {
  readonly entities: Pick<EntityManager, "get">;
  readonly rooms: Pick<RoomManager, "get">;
  readonly commands: Pick<CommandRouter, "parse" | "resolveCommand">;
  readonly db?: MarinaDB;
  readonly macroManager?: Pick<MacroManager, "getByName">;
  readonly logger: Logger;
  promptVersion(name: string): string | undefined;
  sendToEntity(id: EntityId, message: string): void;
  /**
   * Runs a macro's expanded command INSIDE the current execution slot (never
   * re-admitted through the per-entity FIFO, which would wait on itself).
   */
  processCommand(id: EntityId, raw: string): Promise<void>;
  /** One rate-limit token per expanded macro command, as `batch` charges. */
  checkRateLimit?(id: EntityId): boolean;
  buildCommandContext(room: RoomId, entity: EntityId): CommandContext | undefined;
  buildContext(room: RoomId): RoomContext | undefined;
  logEvent(event: EngineEvent): void;
}

/** Nesting bound for macro expansion (a macro that runs a macro that runs …). */
export const MAX_MACRO_DEPTH = 8;
/** Commands one top-level macro invocation may expand to, across all nesting. */
export const MAX_MACRO_EXPANSIONS = 100;

interface MacroFrame {
  /** `entity\0name` of every macro on the current expansion path. */
  path: string[];
  /** Shared by every frame of one top-level expansion. */
  budget: { remaining: number };
}

export class CommandPhaseCoordinator {
  /**
   * The macro expansion path follows the async context, so a macro reached
   * through `batch` (or any other in-slot nested command) still sees the
   * frames above it and cannot recurse unbounded.
   */
  private readonly macroFrames = new AsyncLocalStorage<MacroFrame>();

  constructor(private readonly host: CommandPhaseHost) {}

  /**
   * Process a single command immediately. Each execution runs in its own
   * gate-context frame: its current command and armed approval are its own,
   * and a nested or interleaved command can neither read nor clear them.
   */
  execute(entityId: EntityId, raw: string, opts?: { bypassModal?: boolean }): Promise<void> {
    return runCommandScope(entityId, () => this.executeInner(entityId, raw, opts));
  }

  private async executeInner(
    entityId: EntityId,
    raw: string,
    opts?: { bypassModal?: boolean },
  ): Promise<void> {
    const commandStartedAt = Date.now();
    const entity = this.host.entities.get(entityId);
    if (!entity) return;

    // Engine-initiated housekeeping (brief heartbeat, login look) must not be
    // captured by an entity's active modal — inside Code Mode the rewrite
    // would turn "brief" into the coding task `code brief`.
    const routedRaw = opts?.bypassModal ? raw : this.routeModalCommand(entity, raw);
    const input = this.host.commands.parse(routedRaw, entityId, entity.room);

    if (!input.verb) return;
    // A room command that shadows a builtin runs under its OWN (empty)
    // definition: the builtin's rank floor and gate govern the builtin
    // handler, and a gate execution must never be credited to a room handler.
    const room = this.host.rooms.get(entity.room);
    const resolved = this.host.commands.resolveCommand(input.verb, room?.module.commands);
    const def = resolved?.def;
    const handler = resolved?.handler;

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

    if (!handler) {
      // Macro fallback: entity macros first, then system macros
      if (this.host.macroManager) {
        const macro =
          this.host.macroManager.getByName(input.verb, entityId as string) ??
          this.host.macroManager.getByName(input.verb, "system");
        if (macro) {
          await this.expandMacro(entityId, macro, recordUsage);
          return;
        }
      }
      this.host.sendToEntity(entityId, `Unknown command: ${input.verb}. Type "help" for commands.`);
      failCommandResponse(`Unknown command: ${input.verb}`);
      recordUsage(false);
      return;
    }

    // Enforce minRank on UNGATED built-in commands. A command that declares a
    // safety gate defers its rank floor to the gate in every posture: the gate
    // (standing floor, competence row, witness window, challenge approval and
    // the destructive-core carve-out under `open`) is the single authority.
    // Keeping minRank in front of it double-locked the ladder — auto-derived
    // rank caps at 4 while gated commands demand 5+, so a gate holder below
    // rank 5 could never reach the gate it had earned.
    // The input a refusal would hold: a challenge (src/engine/challenges.ts)
    // re-dispatches exactly this, and its approval leaves a single-use pass
    // for it. The pass arms the approved gates for this run only, so gate
    // checks inside the handler (agent.spawn, code.exec) see the approval.
    setCurrentCommand(entityId, routedRaw);
    const pass = claimCommandPass(entityId, routedRaw);
    armGatePass(entityId, pass);

    if (def?.minRank && def.minRank > 0 && !pass?.rankWaived) {
      const rank = getRank(entity);
      const gateIsAuthority = Boolean(def.gate && this.host.db);
      // LOCAL profile: rank floors are off for the operator's own instance
      // (loopback logins are also promoted to sovereign at login).
      if (rank < def.minRank && !gateIsAuthority && !isLocalUngated()) {
        failCommandResponse(`Rank ${def.minRank} required for ${def.name}`);
        this.host.sendToEntity(
          entityId,
          `You must be at least ${rankName(def.minRank)} (rank ${def.minRank}) to use "${def.name}".` +
            raiseForCommand({
              requesterId: entityId,
              command: routedRaw,
              reason: `rank ${def.minRank}`,
              minRank: def.minRank,
              ...(def.gate ? { gateId: def.gate } : {}),
            }),
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
        failCommandResponse(result.reason ?? `Gate "${def.gate}" denied.`);
        this.host.sendToEntity(entityId, result.reason ?? `Gate "${def.gate}" denied.`);
        recordUsage(false);
        return;
      }
      recordGateExecution(this.host.db, entityId, def.gate, result, `command:${def.name}`);
    }

    const ctx =
      this.host.buildCommandContext(entity.room, entityId) ?? this.host.buildContext(entity.room);
    if (!ctx) return;

    try {
      const result = handler(ctx, input);
      // Await async handlers so callers that `await processCommand` get
      // proper sequencing. A rejected promise is the same failure as a
      // synchronous throw: no quest progress, a failed activity row, failed
      // usage and no `command` event.
      if (result instanceof Promise) await result;
    } catch (err) {
      const msg = getErrorMessage(err);
      failCommandResponse(msg);
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
    recordUsage(true);

    this.host.logEvent({
      type: "command",
      entity: entityId,
      input: routedRaw,
      timestamp: Date.now(),
    });
  }

  /**
   * Expand a macro inside the current execution slot. Bounded three ways: a
   * macro already on the expansion path is a cycle and is refused, nesting
   * stops at MAX_MACRO_DEPTH, and one top-level invocation expands to at most
   * MAX_MACRO_EXPANSIONS commands. Each expanded command costs one rate-limit
   * token, so a macro gives no amplification over typing its commands.
   */
  private async expandMacro(
    entityId: EntityId,
    macro: { name: string; command: string },
    recordUsage: (success: boolean) => void,
  ): Promise<void> {
    const key = `${entityId}\u0000${macro.name.toLowerCase()}`;
    const parent = this.macroFrames.getStore();
    const path = parent?.path ?? [];
    const refuse = (reason: string) => {
      failCommandResponse(reason);
      this.host.sendToEntity(entityId, reason);
      recordUsage(false);
    };
    if (path.includes(key)) {
      refuse(`Macro "${macro.name}" calls itself; expansion stopped.`);
      return;
    }
    if (path.length >= MAX_MACRO_DEPTH) {
      refuse(`Macro nesting deeper than ${MAX_MACRO_DEPTH}; expansion of "${macro.name}" stopped.`);
      return;
    }
    const frame: MacroFrame = {
      path: [...path, key],
      budget: parent?.budget ?? { remaining: MAX_MACRO_EXPANSIONS },
    };
    const commands = macro.command
      .split(";")
      .map((c) => c.trim())
      .filter(Boolean);
    let rateBlocked = 0;
    let truncated = false;
    await this.macroFrames.run(frame, async () => {
      for (const cmd of commands) {
        if (frame.budget.remaining <= 0) {
          truncated = true;
          break;
        }
        if (this.host.checkRateLimit && !this.host.checkRateLimit(entityId)) {
          rateBlocked++;
          continue;
        }
        frame.budget.remaining--;
        await this.host.processCommand(entityId, cmd);
      }
    });
    if (truncated) {
      this.host.sendToEntity(
        entityId,
        `Macro "${macro.name}" stopped after ${MAX_MACRO_EXPANSIONS} expanded commands.`,
      );
    }
    if (rateBlocked > 0) {
      this.host.sendToEntity(
        entityId,
        `Macro "${macro.name}": rate-limited ${rateBlocked} command(s). Slow down.`,
      );
    }
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
