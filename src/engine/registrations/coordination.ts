// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { setApprovalNotifier } from "../../decisions/approvals";
import { resolveEvidence } from "../../decisions/evidence";
import type { EntityId } from "../../types";
import { arenaCommand } from "../commands/arena";
import { boardCommand } from "../commands/board";
import { channelCommand } from "../commands/channel";
import { conductCommand } from "../commands/conduct";
import { crewCommand } from "../commands/crew";
import { decisionCommand } from "../commands/decision";
import { experimentCommand } from "../commands/experiment";
import { exportCommand } from "../commands/export-cmd";
import { forecastCommand } from "../commands/forecast";
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
  // Decision-gate approvals: deliver `ask` holds to the agent's owner, and let
  // the owner settle them (src/decisions/approvals.ts). Unreachable owner ⇒
  // the waiting call fails closed at once instead of waiting out the timeout.
  setApprovalNotifier((request) => {
    const owner = engine.findEntityGlobal(request.ownerName);
    if (!owner || !engine._connections.isEntityConnected(owner.id)) return false;
    engine.sendToEntity(
      owner.id,
      `${request.agentName} wants to run ${request.summary}
` +
        `  ${request.reason}
` +
        `  decision approve ${request.token}  ·  decision deny ${request.token}  (expires in ${Math.round((request.expiresAt - request.createdAt) / 1000)}s)`,
      "decision",
    );
    return true;
  });
  engine.commands.registerBuiltin(forecastCommand());
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
      ),
    );
  }
  if (engine.macroManager) {
    engine.commands.registerBuiltin(macroCommand(engine.macroManager, engine.commands));
  }
}
