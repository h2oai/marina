// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { parseExecUnrestricted } from "../../coding/exec-approver";
import { recoverCodingRuns } from "../../coding/task-run";
import { VerificationRunner } from "../../coding/verification-runner";
import { probeConfiguredProviders } from "../../net/model-api";
import type { EntityId } from "../../types";
import { adapterCommand } from "../commands/adapter";
import { adminCommand } from "../commands/admin";
import { agentCommand } from "../commands/agent";
import { batchCommand } from "../commands/batch";
import { buildCommand } from "../commands/build";
import { canvasCommand } from "../commands/canvas";
import { codeCommand } from "../commands/code";
import { connectCommand } from "../commands/connect";
import { demoCommand } from "../commands/demo";
import { gatewayCommand } from "../commands/gateway";
import { keyCommand } from "../commands/key";
import { opsCommand } from "../commands/ops";
import { productivityCommand } from "../commands/productivity";
import { quitCommand } from "../commands/quit";
import { readinessCommand } from "../commands/readiness";
import { roleCommand } from "../commands/role";
import { runCommand } from "../commands/run";
import { shellCommand } from "../commands/shell";
import { sourceCommand } from "../commands/source";
import { systemPromptCommand } from "../commands/system-prompt";
import { traitCommand } from "../commands/trait";
import { universalIntentCommands, usecaseCommand } from "../commands/usecase";
import { webCommand } from "../commands/web";
import type { Engine } from "../engine";
import { roomMacroOwner } from "../macro-expansion";
import { computeReadiness } from "../readiness";
import { answerCodeViaLocalModel, parseExecApprovalTimeout } from "./model-helpers";

export function registerOperationCommands(engine: Engine): void {
  // Build command (only if db-backed)
  if (engine.db) {
    engine.commands.registerBuiltin(
      buildCommand({
        getEntity: (id) => engine.entities.get(id as EntityId),
        db: engine.db,
        getRoom: (id) => engine.rooms.get(id),
        registerRoom: (id, module) => engine.registerRoom(id, module),
        replaceRoom: (id, module) => {
          const wrapped = engine.sandbox.wrapModule(id, module, (_roomId, error) => {
            engine.logger.error("sandbox", error);
          });
          engine.rooms.replace(id, wrapped);
        },
        entitiesInRoom: (room) => engine.entities.inRoom(room),
        registerCommand: (def) => engine.commands.registerOwned(`dynamic:${def.name}`, def, true),
        unregisterCommand: (name) => engine.commands.unregisterOwned(`dynamic:${name}`, name),
        isBuiltinCommand: (name) => engine.commands.getDef(name) !== undefined,
        clearSandboxMetrics: (roomId) => engine.sandbox.clearMetrics(roomId),
      }),
    );
  }

  // Connect command (only if db-backed)
  if (engine.db) {
    engine.commands.registerBuiltin(
      connectCommand({
        getEntity: (id) => engine.entities.get(id as EntityId),
        db: engine.db,
        connectorRuntime: engine.connectorRuntime,
      }),
    );
  }

  // Web command (search + fetch via connector runtime)
  engine.commands.registerBuiltin(
    webCommand({
      getEntity: (id) => engine.entities.get(id as EntityId),
      connectorRuntime: engine.connectorRuntime,
    }),
  );

  // Gateway command (only if db-backed)
  if (engine.db) {
    engine.commands.registerBuiltin(
      gatewayCommand({
        getEntity: (id) => engine.entities.get(id as EntityId),
        db: engine.db,
        gatewayRuntime: engine.gatewayRuntime,
        worldName: engine.world?.name ?? "Marina",
      }),
    );
  }

  // Source command (works with or without DB)
  engine.commands.registerBuiltin(
    sourceCommand({
      getEntity: (id) => engine.entities.get(id as EntityId),
      db: engine.db,
      getRoom: (id) => engine.rooms.get(id),
      getEntityRoom: (entityId) => engine.getEntityRoom(entityId),
    }),
  );

  // Quit command (graceful disconnect)
  engine.commands.registerBuiltin(
    quitCommand({
      getConnection: (id) => engine.getConnectionForEntity(id),
      removeConnection: (connId, intent) => engine.removeConnection(connId, intent),
    }),
  );

  // Batch command (multi-command execution) — each subcommand consumes
  // one rate-limit token so batching can't amplify request rate.
  engine.commands.registerBuiltin(
    batchCommand({
      processCommand: (entityId, raw) => engine.processCommand(entityId, raw),
      checkRateLimit: (entityId) => engine.checkRateLimit(entityId),
      // Resolution order mirrors the command phase: builtin / room command,
      // then the room's, the entity's own and system macros.
      isCommand: (entityId, verb) => {
        const entity = engine.entities.get(entityId);
        const room = entity ? engine.rooms.get(entity.room) : undefined;
        if (engine.commands.resolveCommand(verb, room?.module.commands)) return true;
        const macros = engine.macroManager;
        if (!macros || !entity) return false;
        return !!(
          macros.getByName(verb, roomMacroOwner(entity.room)) ??
          macros.getByName(verb, entityId as string) ??
          macros.getByName(verb, "system")
        );
      },
    }),
  );

  // Canvas command (asset management + canvas)
  engine.commands.registerBuiltin(
    canvasCommand({
      getEntity: (id) => engine.entities.get(id as EntityId),
      findEntityGlobal: (name) => engine.findEntityGlobal(name),
      db: engine.db,
      storage: engine.storage,
      logEvent: (event) => engine.logEvent(event as import("../../types").EngineEvent),
      scratchRoot: "data/scratch",
    }),
  );

  // Shell commands (run + shell management)
  engine.commands.registerBuiltin(
    runCommand({
      getEntity: (id) => engine.entities.get(id as EntityId),
      shellRuntime: engine.shellRuntime,
      db: engine.db,
    }),
  );
  engine.commands.registerBuiltin(
    shellCommand({
      getEntity: (id) => engine.entities.get(id as EntityId),
      db: engine.db,
      shellRuntime: engine.shellRuntime,
      storage: engine.storage,
      logEvent: (event) => engine.logEvent(event),
    }),
  );
  if (engine.db) {
    recoverCodingRuns(engine.db);
    engine.db.recoverCodingVerifications();
  }
  engine.commands.registerBuiltin(
    codeCommand({
      verificationRunner: engine.db
        ? new VerificationRunner(engine.db, (pending) => engine.trackBackgroundCommand(pending))
        : undefined,
      logEvent: (event) => engine.logEvent(event),
      agentRuntime: engine.agentRuntime,
      answerPrompt: answerCodeViaLocalModel,
      channelManager: engine.channelManager,
      crewManager: engine.crewManager,
      flywheel: engine.flywheel,
      findAgentByName: (name) => engine.entities.findAgentByName(name),
      listAgents: () => engine.agentRuntime.list(),
      getEntity: (id) => engine.entities.get(id as EntityId),
      // Forward a bound coding agent's live activity to the human in Code Mode.
      notify: (id, message, metadata) =>
        engine.sendToEntity(id as EntityId, message, "code", metadata),
      // LAYER 0 transport deny + interactive-approver loopback verification.
      getConnectionProtocol: (id) => engine.getConnectionForEntity(id as EntityId)?.protocol,
      getConnection: (id) => engine.getConnectionForEntity(id as EntityId),
      findEntityByName: (name) => engine.findEntityGlobal(name),
      // EXACT (case-insensitive) resolver for exec-approval identity checks —
      // never the fuzzy prefix matcher, which a name-prefix spoof could ride.
      findEntityExact: (name) => engine.entities.findAgentByName(name),
      // Headless arbitrary-exec gating (MARINA_CODE_EXEC_UNRESTRICTED). Env is
      // available at process start; identity trust folds authRequired with an
      // optional loopback-only bind.
      execUnrestrictedAllow: parseExecUnrestricted(process.env.MARINA_CODE_EXEC_UNRESTRICTED),
      // Headless identity trust is resolved PER acting connection at approval
      // time (loopback IP / in-process), never from a process-wide WS_HOST env.
      // authRequired short-circuits to trusted when every login is verified.
      authRequired: engine.config.authRequired === true,
      execApprovalTimeoutMs: parseExecApprovalTimeout(
        process.env.MARINA_CODE_EXEC_APPROVAL_TIMEOUT_MS,
      ),
      db: engine.db,
    }),
  );

  // Admin command (only if db-backed)
  if (engine.db) {
    engine.commands.registerBuiltin(
      adminCommand({
        db: engine.db,
        dbPath: engine.config.dbPath,
        worldName: engine.world?.name,
        getEntity: (id) => engine.entities.get(id as EntityId),
        findEntity: (name) => engine.findEntityGlobal(name),
        getConnections: () => engine.connections,
        removeConnection: (connId) => engine.removeConnection(connId),
        broadcastAll: (msg, tag?) => {
          for (const entity of engine.entities.all()) {
            if (entity.kind === "agent") {
              engine.sendToEntity(entity.id, msg, tag);
            }
          }
        },
        roomCount: () => engine.rooms.size,
        entityCount: () => engine.entities.size,
        getUptime: () => engine.getUptime(),
        reloadRoom: (id) => engine.reloadRoom(id),
      }),
    );
  }

  // Agent command (spawn, stop, list, status, attention, focus, config)
  engine.commands.registerBuiltin(
    agentCommand({
      agentRuntime: engine.agentRuntime,
      getEntity: (id) => engine.entities.get(id as EntityId),
      logEvent: (event) => engine.logEvent(event),
      db: engine.db,
    }),
  );

  // Readiness command (aliases doctor/health) — operator-facing capability health.
  engine.commands.registerBuiltin(
    readinessCommand({
      readiness: () => computeReadiness(engine),
      probeProviders: (providers) => probeConfiguredProviders(engine, { providers }),
      pulseHistory: (sinceMs) => engine.db?.listAutonomyPulse(sinceMs) ?? [],
    }),
  );
  if (engine.db && engine.taskManager) {
    engine.commands.registerBuiltin(productivityCommand(engine.db));
    engine.commands.registerBuiltin(
      opsCommand({
        db: engine.db,
        tasks: engine.taskManager,
        runtime: engine.agentRuntime,
        readiness: () => computeReadiness(engine),
      }),
    );
    engine.commands.registerBuiltin(
      demoCommand({
        db: engine.db,
        tasks: engine.taskManager,
        runtime: engine.agentRuntime,
        readiness: () => computeReadiness(engine),
        getEntity: (id) => engine.entities.get(id),
      }),
    );
  }

  // Use-case command (one-shot project + task + agent scaffolding)
  if (engine.db && engine.taskManager && engine.groupManager) {
    const usecaseDeps = {
      getEntity: (id: string) => engine.entities.get(id as EntityId),
      db: engine.db,
      taskManager: engine.taskManager,
      groupManager: engine.groupManager,
      agentRuntime: engine.agentRuntime,
      logEvent: (event: { type: string; entity: EntityId; timestamp: number }) =>
        engine.logEvent(event as import("../../types").EngineEvent),
    };
    engine.commands.registerBuiltin(usecaseCommand(usecaseDeps));
    for (const command of universalIntentCommands(usecaseDeps)) {
      engine.commands.registerBuiltin(command);
    }
  }

  // Role and Trait commands (composable agent identity)
  engine.commands.registerBuiltin(
    roleCommand({
      db: engine.db,
      getEntity: (id) => engine.entities.get(id as EntityId),
      listAgents: () => engine.agentRuntime.list(),
      reconfigureAgent: (name, opts) => engine.agentRuntime.reconfigure(name, opts),
    }),
  );
  engine.commands.registerBuiltin(
    traitCommand({
      db: engine.db,
      getEntity: (id) => engine.entities.get(id as EntityId),
      listAgents: () => engine.agentRuntime.list(),
    }),
  );
  engine.commands.registerBuiltin(systemPromptCommand({ db: engine.db }));

  // Key and Adapter commands (security & administration)
  engine.commands.registerBuiltin(
    keyCommand({
      db: engine.db,
      getEntity: (id) => engine.entities.get(id as EntityId),
      logEvent: (event) => engine.logEvent(event),
    }),
  );
  engine.commands.registerBuiltin(
    adapterCommand({
      db: engine.db,
      getEntity: (id) => engine.entities.get(id as EntityId),
      logEvent: (event) => engine.logEvent(event),
    }),
  );
}
