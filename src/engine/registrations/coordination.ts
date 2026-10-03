// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { resolveEvidence } from "../../decisions/evidence";
import type { EntityId } from "../../types";
import { setChallengeHost } from "../challenges";
import { arenaCommand } from "../commands/arena";
import { boardCommand } from "../commands/board";
import { challengeCommand } from "../commands/challenge";
import { channelCommand } from "../commands/channel";
import { conductCommand } from "../commands/conduct";
import { crewCommand } from "../commands/crew";
import { decisionCommand } from "../commands/decision";
import { experimentCommand } from "../commands/experiment";
import { exportCommand } from "../commands/export-cmd";
import { forecastCommand } from "../commands/forecast";
import { gateCommand } from "../commands/gate";
import { groupCommand } from "../commands/group";
import { inheritanceCommand } from "../commands/inheritance";
import { intellectCommand } from "../commands/intellect";
import { journeyCommand } from "../commands/journey";
import { macroCommand } from "../commands/macro";
import { observeCommand } from "../commands/observe";
import { projectCommand } from "../commands/project";
import { provenanceCommand } from "../commands/provenance";
import { recruitCommand } from "../commands/recruit";
import { standingCommand } from "../commands/standing";
import { taskCommand } from "../commands/task";
import { traceCommand } from "../commands/trace";
import { witnessCommand } from "../commands/witness";
import type { Engine } from "../engine";
import { tryLog } from "../errors";

export function registerCoordinationCommands(engine: Engine): void {
  // Project command (requires task + group managers)
  if (engine.taskManager && engine.groupManager && engine.db) {
    engine.commands.registerBuiltin(
      projectCommand({
        getEntity: (id) => engine.entities.get(id as EntityId),
        db: engine.db,
        taskManager: engine.taskManager,
        groupManager: engine.groupManager,
      }),
    );
  }

  // Export command (only if boards available)
  if (engine.boardManager) {
    engine.commands.registerBuiltin(
      exportCommand(engine.boardManager, (id) => engine.entities.get(id as EntityId)),
    );
  }

  // Agent playground commands
  engine.commands.registerBuiltin(
    experimentCommand({
      getEntity: (id) => engine.entities.get(id as EntityId),
      db: engine.db,
    }),
  );
  engine.commands.registerBuiltin(
    observeCommand({
      getEntity: (id) => engine.entities.get(id as EntityId),
      findEntity: (name) => engine.findEntityGlobal(name),
      db: engine.db,
      getOnlineAgents: () => engine.getOnlineAgents(),
      getRoomShort: (id) => engine.rooms.get(id)?.module.short,
      getEventLog: () =>
        engine.eventLog.map((e) => ({
          type: e.type,
          entity: "entity" in e ? e.entity : undefined,
          input: "input" in e ? e.input : undefined,
          timestamp: e.timestamp,
        })),
    }),
  );
  engine.commands.registerBuiltin(
    traceCommand({
      db: engine.db,
      getEventLog: () => engine.getEventLog(),
      getEntityName: (id) => engine.entities.get(id)?.name,
      getOtlpStatus: () => engine.getOtlpExporterStatus(),
    }),
  );
  if (engine.db) {
    engine.commands.registerBuiltin(
      intellectCommand({
        db: engine.db,
        getEntity: (id) => engine.entities.get(id as EntityId),
      }),
    );
    engine.commands.registerBuiltin(provenanceCommand(engine.db));
    engine.commands.registerBuiltin(
      journeyCommand({
        db: engine.db,
        getEntity: (id) => engine.entities.get(id as EntityId),
      }),
    );
  }
  engine.commands.registerBuiltin(
    inheritanceCommand({
      db: engine.db,
      getEntity: (id) => engine.entities.get(id as EntityId),
    }),
  );

  // Coordination commands (only if db-backed)
  if (engine.channelManager) {
    engine.commands.registerBuiltin(
      channelCommand(
        engine.channelManager,
        (id) => engine.entities.get(id as EntityId),
        (event) => engine.logEvent(event),
      ),
    );
  }
  if (engine.crewManager && engine.channelManager) {
    const channels = engine.channelManager;
    engine.commands.registerBuiltin(
      crewCommand({
        crews: engine.crewManager,
        channels,
        getEntity: (id) => engine.entities.get(id as EntityId),
        findAgentByName: (name) => engine.entities.findAgentByName(name),
        db: engine.db,
      }),
    );
    engine.commands.registerBuiltin(
      recruitCommand({
        crews: engine.crewManager,
        channels,
        getEntity: (id) => engine.entities.get(id as EntityId),
        findAgentByName: (name) => engine.entities.findAgentByName(name),
        listAgents: () => engine.agentRuntime.list(),
        db: engine.db,
      }),
    );
  }
  if (engine.db) {
    engine.commands.registerBuiltin(
      standingCommand({
        db: engine.db,
        getEntity: (id) => engine.entities.get(id as EntityId),
        findAgentByName: (name) => engine.entities.findAgentByName(name),
      }),
    );
    engine.commands.registerBuiltin(
      witnessCommand({
        db: engine.db,
        getEntity: (id) => engine.entities.get(id as EntityId),
        getAllEntities: () => engine.entities.all(),
        resolveEntityIdByName: (name) =>
          engine.entities.findAgentByName(name)?.id ??
          engine.entities.all().find((e) => e.name.toLowerCase() === name.toLowerCase())?.id,
      }),
    );
    engine.commands.registerBuiltin(
      gateCommand({
        db: engine.db,
        getEntity: (id) => engine.entities.get(id as EntityId),
        resolveEntity: (name) =>
          engine.entities.findAgentByName(name) ??
          engine.entities.all().find((e) => e.name.toLowerCase() === name.toLowerCase()),
        spawnedBy: (name) => engine.db?.getAgentConfig(name)?.spawned_by || undefined,
      }),
    );
    engine.commands.registerBuiltin(
      conductCommand({
        db: engine.db,
        getEntity: (id) => engine.entities.get(id as EntityId),
        listAgents: () => engine.agentRuntime.list(),
        logEvent: (event) => engine.logEvent(event),
      }),
    );
  }
  if (engine.boardManager) {
    engine.commands.registerBuiltin(
      boardCommand(
        engine.boardManager,
        (id) => engine.entities.get(id as EntityId),
        (event) => engine.logEvent(event),
      ),
    );
  }
  if (engine.groupManager) {
    engine.commands.registerBuiltin(
      groupCommand(engine.groupManager, (name) => engine.findEntityGlobal(name)),
    );
  }
  // Challenges: a refusal asks the requester's creator and the admins, and an
  // approval re-runs the held action (src/engine/challenges.ts). Nothing waits.
  setChallengeHost(
    {
      get db() {
        return engine.db;
      },
      getEntity: (id) => engine.entities.get(id as EntityId),
      findEntity: (name) => engine.findEntityGlobal(name),
      connectedEntities: () =>
        engine.entities.all().filter((e) => engine._connections.isEntityConnected(e.id)),
      isConnected: (id) => engine._connections.isEntityConnected(id as EntityId),
      send: (id, text) => engine.sendToEntity(id as EntityId, text, "challenge"),
      // Through admission + FIFO: the re-run lines up behind anything the
      // requester already queued instead of interleaving with it. The held
      // input already passed modal routing, so it re-runs verbatim (the pass
      // is keyed on that exact input) with its request-local coding target.
      redispatch: async (id, raw, options) => {
        const admitted = await engine.dispatchCommand(id as EntityId, raw, {
          ...options,
          bypassModal: true,
        });
        if (!admitted)
          throw new Error("World command capacity reached; inspect state before retrying.");
      },
      creatorOf: (entity) => engine.db?.getAgentConfig(entity.name)?.spawned_by || undefined,
    },
    engine,
  );
  engine.commands.registerBuiltin(
    challengeCommand({ getEntity: (id) => engine.entities.get(id as EntityId) }),
  );
  engine.commands.registerBuiltin(
    forecastCommand({
      get db() {
        return engine.db;
      },
      getEntity: (id) => engine.entities.get(id as EntityId),
    }),
  );
  engine.commands.registerBuiltin(
    arenaCommand({
      get store() {
        return engine.db;
      },
      get notes() {
        return engine.db;
      },
    }),
  );
  const resolveCitedEvidence = (actor: { name: string; id: string }, text: string) =>
    engine.db ? resolveEvidence(engine.db, actor, text) : [];
  engine.commands.registerBuiltin(
    decisionCommand({
      getEntity: (id) => engine.entities.get(id),
      resolveEvidence: resolveCitedEvidence,
      logEvent: (event) => engine.logEvent(event),
      get store() {
        return engine.db;
      },
      get settings() {
        const db = engine.db;
        return db
          ? {
              db,
              isInternal: (id: string) => !!engine.getConnectionForEntity(id as never)?.internal,
            }
          : undefined;
      },
    }),
  );

  if (engine.taskManager) {
    engine.commands.registerBuiltin(
      taskCommand(
        engine.taskManager,
        (name) => engine.findEntityGlobal(name),
        (event) => engine.logEvent(event),
        resolveCitedEvidence,
        (row) =>
          tryLog(engine.logger, "decisions", "Judge observation not recorded", () => {
            engine.db?.recordJudgeObservation(row);
          }),
        (work) => engine.trackBackground(work),
      ),
    );
  }
  if (engine.macroManager) {
    engine.commands.registerBuiltin(
      macroCommand(
        engine.macroManager,
        engine.commands,
        (name) =>
          engine.rooms.all().some((room) => {
            const commands = room.module.commands;
            return !!commands && Object.hasOwn(commands, name);
          }),
        (roomId) => engine.rooms.all().some((room) => room.id === roomId),
      ),
    );
  }
}
