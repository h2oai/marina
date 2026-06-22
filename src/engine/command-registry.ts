import { getInternalModelToken } from "../agent/agent-runtime";
import { registerBuiltinResolvers } from "../resolvers";
import type { EntityId, RoomId } from "../types";
import { adapterCommand } from "./commands/adapter";
import { adminCommand } from "./commands/admin";
import { agentCommand } from "./commands/agent";
import { askCommand } from "./commands/ask";
import { bankrollCommand } from "./commands/bankroll";
import { batchCommand } from "./commands/batch";
import { benchmarkCommand } from "./commands/benchmark";
import { boardCommand } from "./commands/board";
import { bookmarkCommand } from "./commands/bookmark";
import { briefCommand } from "./commands/brief";
import { buildCommand } from "./commands/build";
import { calcCommand } from "./commands/calc";
import { canvasCommand } from "./commands/canvas";
import { channelCommand } from "./commands/channel";
import { chronicleCommand } from "./commands/chronicle";
import { codeCommand } from "./commands/code";
import { conductCommand } from "./commands/conduct";
import { connectCommand } from "./commands/connect";
import { crewCommand } from "./commands/crew";
import { debriefCommand } from "./commands/debrief";
import { digCommand } from "./commands/dig";
import { emoteCommand } from "./commands/emote";
import { evolveCommand } from "./commands/evolve";
import { experimentCommand } from "./commands/experiment";
import { exportCommand } from "./commands/export-cmd";
import { feedCommand } from "./commands/feed";
import { gatewayCommand } from "./commands/gateway";
import { gotoCommand } from "./commands/goto";
import { groupCommand } from "./commands/group";
import { helpCommand } from "./commands/help";
import { ignoreCommand, isIgnoring } from "./commands/ignore";
import { imageCommand } from "./commands/image";
import { inventoryCommand } from "./commands/inventory";
import { dropCommand, getCommand, giveCommand } from "./commands/items";
import { keyCommand } from "./commands/key";
import { linkCommand } from "./commands/link";
import { lookCommand } from "./commands/look";
import { lsCommand } from "./commands/ls";
import { macroCommand } from "./commands/macro";
import { mapCommand } from "./commands/map";
import { marketCommand } from "./commands/market";
import { memoryCommand } from "./commands/memory";
import { moveCommand } from "./commands/move";
import { nextCommand } from "./commands/next";
import { noteCommand } from "./commands/note";
import { noveltyCommand } from "./commands/novelty";
import { observeCommand } from "./commands/observe";
import { orientCommand } from "./commands/orient";
import { poolCommand } from "./commands/pool";
import { positionCommand } from "./commands/position";
import { probeCommand } from "./commands/probe";
import { projectCommand } from "./commands/project";
import { questCommand } from "./commands/quest";
import { quitCommand } from "./commands/quit";
import { rankCommand } from "./commands/rank";
import { readinessCommand } from "./commands/readiness";
import { recallCommand } from "./commands/recall";
import { recapCommand } from "./commands/recap";
import { recruitCommand } from "./commands/recruit";
import { reflectCommand } from "./commands/reflect";
import { roleCommand } from "./commands/role";
import { runCommand } from "./commands/run";
import { sayCommand } from "./commands/say";
import { scenarioCommand } from "./commands/scenario";
import { scoreCommand } from "./commands/score";
import { searchCommand } from "./commands/search";
import { shareCommand } from "./commands/share";
import { shellCommand } from "./commands/shell";
import { shoutCommand } from "./commands/shout";
import { skillCommand } from "./commands/skill";
import { sourceCommand } from "./commands/source";
import { standingCommand } from "./commands/standing";
import { systemPromptCommand } from "./commands/system-prompt";
import { taskCommand } from "./commands/task";
import { replyCommand, tellCommand } from "./commands/tell";
import { traitCommand } from "./commands/trait";
import { usecaseCommand } from "./commands/usecase";
import { timeCommand, uptimeCommand } from "./commands/utility";
import { videoCommand } from "./commands/video";
import { watchCommand } from "./commands/watch";
import { webCommand } from "./commands/web";
import { whoCommand } from "./commands/who";
import type { Engine } from "./engine";
import { computeReadiness } from "./readiness";

export function registerBuiltinCommands(engine: Engine): void {
  // Resolver registry is module-scoped; idempotent so multiple engine
  // instances in the same process (tests) don't double-register.
  registerBuiltinResolvers();

  // Look command (with optional board listing)
  engine.commands.registerBuiltin(
    lookCommand(
      (entityId) => engine.getEntityRoom(entityId),
      engine.boardManager
        ? (roomId) => engine.boardManager!.getBoardsForScope("room", roomId)
        : undefined,
    ),
  );

  engine.commands.registerBuiltin(
    moveCommand({
      getEntity: (id) => engine.entities.get(id),
      getRoom: (entityId) => engine.getEntityRoom(entityId),
      getRoomById: (id) => engine.rooms.get(id),
      moveEntity: (entityId, to) => engine.entities.move(entityId, to),
      buildContext: (room) => engine.buildContext(room),
      sendLook: (entityId) => engine.sendLook(entityId),
    }),
  );

  engine.commands.registerBuiltin(
    lsCommand({
      getEntityRoom: (entityId) => engine.getEntityRoom(entityId),
      getAllRooms: () => engine.rooms.all(),
      getAllEntities: () => engine.entities.all(),
      getEntitiesInRoom: (room) => engine.entities.inRoom(room),
      getRoomBoards: engine.boardManager
        ? (roomId) => engine.boardManager!.getBoardsForScope("room", roomId)
        : undefined,
    }),
  );

  engine.commands.registerBuiltin(
    gotoCommand({
      getEntity: (id) => engine.entities.get(id),
      getRoomById: (id) => engine.rooms.get(id),
      hasRoom: (id) => engine.rooms.has(id),
      moveEntity: (entityId, to) => engine.entities.move(entityId, to),
      buildContext: (room) => engine.buildContext(room),
      sendLook: (entityId) => engine.sendLook(entityId),
      getAllEntities: () => engine.entities.all(),
      getEntityRoom: (entityId) => engine.getEntityRoom(entityId),
    }),
  );

  engine.commands.registerBuiltin(sayCommand((id) => engine.entities.get(id)));
  engine.commands.registerPrefixAlias("'", "say");
  engine.commands.registerBuiltin(
    shoutCommand({
      getEntity: (id) => engine.entities.get(id),
      broadcastAll: (senderId, msg, tag?) => {
        const sender = engine.entities.get(senderId);
        const senderName = sender?.name;
        for (const entity of engine.entities.all()) {
          if (entity.kind === "agent" && entity.id !== senderId) {
            if (senderName && isIgnoring(entity, senderName)) continue;
            engine.sendToEntity(entity.id, msg, tag);
          }
        }
      },
    }),
  );
  const tellDeps = {
    getEntity: (id: EntityId) => engine.entities.get(id),
    findEntityGlobal: (name: string) => {
      const e = engine.findEntityGlobal(name);
      return e ? { id: e.id, name: e.name } : undefined;
    },
    sendGlobal: (
      target: EntityId,
      msg: string,
      senderId: EntityId,
      tag?: string,
      metadata?: Record<string, unknown>,
    ) => {
      const targetEntity = engine.entities.get(target);
      const sender = engine.entities.get(senderId);
      if (targetEntity && sender && isIgnoring(targetEntity, sender.name)) return;
      engine.sendToEntity(target, msg, tag, metadata);
    },
  };
  engine.commands.registerBuiltin(tellCommand(tellDeps));
  engine.commands.registerBuiltin(replyCommand(tellDeps));
  engine.commands.registerBuiltin(
    whoCommand(
      () => engine.getOnlineAgents(),
      (roomId) => engine.rooms.get(roomId as RoomId)?.module.short,
      (entityName) => engine.db?.getLastActivityAt(entityName) ?? null,
      engine.crewManager ? () => engine.crewManager!.list() : undefined,
    ),
  );
  engine.commands.registerBuiltin(
    helpCommand(
      () => engine.commands.allBuiltins(),
      (id) => {
        const e = engine.entities.get(id as EntityId);
        return e ? ((e.properties.rank as number) ?? 0) : 0;
      },
    ),
  );
  engine.commands.registerBuiltin(imageCommand(engine));
  engine.commands.registerBuiltin(videoCommand(engine));
  engine.commands.registerBuiltin(inventoryCommand((id) => engine.entities.get(id)));
  engine.commands.registerBuiltin(emoteCommand((id) => engine.entities.get(id)));
  engine.commands.registerBuiltin(
    calcCommand({ getEntity: (id) => engine.entities.get(id as EntityId) }),
  );
  engine.commands.registerBuiltin(timeCommand());
  engine.commands.registerBuiltin(uptimeCommand(() => engine.getUptime()));
  engine.commands.registerBuiltin(
    ignoreCommand({
      getEntity: (id) => engine.entities.get(id),
      findEntityGlobal: (name) => engine.findEntityGlobal(name),
    }),
  );
  engine.commands.registerBuiltin(
    briefCommand({
      getEntity: (id) => engine.entities.get(id),
      db: engine.db,
      taskManager: engine.taskManager,
      getOnlineAgents: () => engine.getOnlineAgents(),
      groupManager: engine.groupManager,
      crewManager: engine.crewManager,
      subscribeBrief: (eid, interval) => engine.subscribeBrief(eid, interval),
      unsubscribeBrief: (eid) => engine.unsubscribeBrief(eid),
      isBriefSubscribed: (eid) => engine.isBriefSubscribed(eid),
      hasLlmKeys: engine.agentRuntime.isAvailable(),
    }),
  );
  engine.commands.registerBuiltin(
    scoreCommand({
      getEntity: (id) => engine.entities.get(id),
      getRoomShort: (id) => engine.rooms.get(id as RoomId)?.module.short,
    }),
  );
  engine.commands.registerBuiltin(
    mapCommand({
      getEntityRoom: (id) => {
        const room = engine.getEntityRoom(id);
        if (!room) return undefined;
        return { id: room.id, short: room.module.short, exits: room.module.exits ?? {} };
      },
      getRoomShort: (id) => engine.rooms.get(id)?.module.short,
    }),
  );
  engine.commands.registerBuiltin(
    getCommand({
      getEntity: (id) => engine.entities.get(id),
      findObjectInRoom: (name, room) => {
        const inRoom = engine.entities.inRoom(room);
        const lower = name.toLowerCase();
        return inRoom.find((e) => e.kind === "object" && e.name.toLowerCase().startsWith(lower));
      },
    }),
  );
  engine.commands.registerBuiltin(
    dropCommand({
      getEntity: (id) => engine.entities.get(id),
      getEntityById: (id) => engine.entities.get(id),
    }),
  );
  engine.commands.registerBuiltin(
    giveCommand({
      getEntity: (id) => engine.entities.get(id),
      getEntityById: (id) => engine.entities.get(id),
      findEntityInRoom: (name, room) => engine.entities.findByName(name, room),
    }),
  );

  // Rank command
  engine.commands.registerBuiltin(
    rankCommand({
      findEntity: (name) => engine.findEntityGlobal(name),
      db: engine.db,
    }),
  );

  // Quest command
  engine.commands.registerBuiltin(
    questCommand({
      getEntity: (id) => engine.entities.get(id),
      db: engine.db,
      quests: engine.world?.quests ?? [],
    }),
  );

  // Link command (account linking for external adapters)
  engine.commands.registerBuiltin(
    linkCommand({
      getEntity: (id) => engine.entities.get(id),
      db: engine.db,
    }),
  );

  // Knowledge base commands
  engine.commands.registerBuiltin(
    noteCommand({
      getEntity: (id) => engine.entities.get(id as EntityId),
      db: engine.db,
      logEvent: (event) => engine.logEvent(event),
    }),
  );
  engine.commands.registerBuiltin(
    feedCommand({
      getEntity: (id) => engine.entities.get(id as EntityId),
      db: engine.db,
    }),
  );
  // Chronicle — the canonical, append-only record of the Marina.
  // Read at rank 0; write commands gated to entities with role=chronicler.
  // Citation flows `chronicled` standing via the name → id resolver.
  // See docs/chronicle.md.
  if (engine.db) {
    engine.commands.registerBuiltin(
      chronicleCommand({
        getEntity: (id) => engine.entities.get(id as EntityId),
        db: engine.db,
        resolveEntityIdByName: (name) =>
          engine.entities.findAgentByName(name)?.id ??
          engine.entities.all().find((e) => e.name === name)?.id,
      }),
    );
  }
  // Probe command (resolver dispatch — point-in-time observation primitive).
  // Requires db; handler writes Sample notes and emits feed events.
  if (engine.db) {
    engine.commands.registerBuiltin(
      probeCommand({
        getEntity: (id) => engine.entities.get(id as EntityId),
        db: engine.db,
        logEvent: (event) => engine.logEvent(event),
      }),
    );
  }
  // Watch command (declarative observation requests on cadence). Specs live
  // in the shared `watches` pool; the watching role consumes them.
  if (engine.db) {
    engine.commands.registerBuiltin(
      watchCommand({
        getEntity: (id) => engine.entities.get(id as EntityId),
        db: engine.db,
      }),
    );
  }
  engine.commands.registerBuiltin(
    searchCommand({
      getEntity: (id) => engine.entities.get(id as EntityId),
      db: engine.db,
      getAllRooms: () =>
        engine.rooms.all().map((r) => ({
          id: r.id,
          short: r.module.short,
          long: typeof r.module.long === "string" ? r.module.long : "",
        })),
    }),
  );
  engine.commands.registerBuiltin(
    bookmarkCommand({
      getEntity: (id) => engine.entities.get(id as EntityId),
      getRoomShort: (id) => engine.rooms.get(id)?.module.short,
    }),
  );

  // Memory commands
  engine.commands.registerBuiltin(
    memoryCommand({
      getEntity: (id) => engine.entities.get(id as EntityId),
      db: engine.db,
    }),
  );
  engine.commands.registerBuiltin(
    recallCommand({
      getEntity: (id) => engine.entities.get(id as EntityId),
      db: engine.db,
      taskManager: engine.taskManager,
      logEvent: (event) => engine.logEvent(event),
    }),
  );
  engine.commands.registerBuiltin(
    reflectCommand({
      getEntity: (id) => engine.entities.get(id as EntityId),
      db: engine.db,
      logEvent: (event) => engine.logEvent(event),
    }),
  );
  engine.commands.registerBuiltin(
    poolCommand({
      getEntity: (id) => engine.entities.get(id as EntityId),
      db: engine.db,
      logEvent: (event) => engine.logEvent(event),
    }),
  );
  engine.commands.registerBuiltin(
    noveltyCommand({
      getEntity: (id) => engine.entities.get(id as EntityId),
      db: engine.db,
      getTotalRoomCount: () => engine.rooms.all().length,
    }),
  );
  if (engine.db) {
    engine.commands.registerBuiltin(
      marketCommand({
        getEntity: (id) => engine.entities.get(id as EntityId),
        db: engine.db,
        logEvent: (event) => engine.logEvent(event),
      }),
    );
    engine.commands.registerBuiltin(
      scenarioCommand({
        getEntity: (id) => engine.entities.get(id as EntityId),
        db: engine.db,
        connectorRuntime: engine.connectorRuntime,
      }),
    );
    engine.commands.registerBuiltin(
      bankrollCommand({
        getEntity: (id) => engine.entities.get(id as EntityId),
        db: engine.db,
      }),
    );
    engine.commands.registerBuiltin(
      positionCommand({
        getEntity: (id) => engine.entities.get(id as EntityId),
        db: engine.db,
      }),
    );
  }
  if (engine.db && engine.benchmarkRunner) {
    engine.commands.registerBuiltin(
      benchmarkCommand({
        getEntity: (id) => engine.entities.get(id as EntityId),
        db: engine.db,
        runner: engine.benchmarkRunner,
        listOrchestrations: () => {
          const cm = engine.channelManager;
          if (!cm) return [];
          const onlineIds = new Set(engine.getOnlineAgents().map((e) => e.id));
          const orchs: string[] = [];
          for (const ch of cm.getAllChannels()) {
            if (!ch.name.startsWith("model-")) continue;
            if (ch.name.startsWith("model-conv-")) continue;
            const online = cm.getMembers(ch.id).filter((m) => onlineIds.has(m as never)).length;
            if (online > 0) orchs.push(`marina:${ch.name.slice("model-".length)}`);
          }
          return orchs;
        },
        logEvent: (event) => engine.logEvent(event),
      }),
    );
  }
  engine.commands.registerBuiltin(
    nextCommand({
      getEntity: (id) => engine.entities.get(id as EntityId),
      db: engine.db,
      taskManager: engine.taskManager,
      quests: engine.world?.quests ?? [],
      startRoom: engine.config.startRoom,
    }),
  );
  engine.commands.registerBuiltin(
    askCommand({
      getEntity: (id) => engine.entities.get(id as EntityId),
      db: engine.db,
      taskManager: engine.taskManager,
      answerQuestion:
        process.env.MARINA_ASK_MODEL === "false"
          ? undefined
          : (query, context) => answerViaLocalModel(query, context),
    }),
  );
  // recap/debrief/share/dig — the named-verb stdlib that sits next to ask.
  // Cheap, composable views over existing primitives (recall, pool, web)
  // so agents don't have to remember the longer forms.
  engine.commands.registerBuiltin(
    recapCommand({
      getEntity: (id) => engine.entities.get(id as EntityId),
      db: engine.db,
    }),
  );
  engine.commands.registerBuiltin(
    debriefCommand({
      getEntity: (id) => engine.entities.get(id as EntityId),
      db: engine.db,
      taskManager: engine.taskManager,
    }),
  );
  engine.commands.registerBuiltin(
    evolveCommand({
      getEntity: (id) => engine.entities.get(id as EntityId),
      db: engine.db,
    }),
  );
  engine.commands.registerBuiltin(
    shareCommand({
      getEntity: (id) => engine.entities.get(id as EntityId),
      db: engine.db,
      logEvent: (event) => engine.logEvent(event),
    }),
  );
  engine.commands.registerBuiltin(
    digCommand({
      getEntity: (id) => engine.entities.get(id as EntityId),
      db: engine.db,
      connectorRuntime: engine.connectorRuntime,
      answerQuestion:
        process.env.MARINA_ASK_MODEL === "false"
          ? undefined
          : (query, context) => answerViaLocalModel(query, context),
    }),
  );
  engine.commands.registerBuiltin(
    skillCommand({
      getEntity: (id) => engine.entities.get(id as EntityId),
      db: engine.db,
      logEvent: (event) => engine.logEvent(event),
    }),
  );
  engine.commands.registerBuiltin(
    orientCommand({
      getEntity: (id) => engine.entities.get(id as EntityId),
      db: engine.db,
      taskManager: engine.taskManager,
      getTotalRoomCount: () => engine.rooms.all().length,
    }),
  );

  // Project command (requires task + group managers)
  if (engine.taskManager && engine.groupManager && engine.db) {
    engine.commands.registerBuiltin(
      projectCommand({
        getEntity: (id) => engine.entities.get(id as EntityId),
        db: engine.db,
        taskManager: engine.taskManager,
        groupManager: engine.groupManager,
        promote: (eid, rank) => engine.maybePromote(eid, rank),
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
  if (engine.taskManager) {
    engine.commands.registerBuiltin(
      taskCommand(
        engine.taskManager,
        (name) => engine.findEntityGlobal(name),
        (event) => engine.logEvent(event),
        (eid, rank) => engine.maybePromote(eid, rank),
      ),
    );
  }
  if (engine.macroManager) {
    engine.commands.registerBuiltin(macroCommand(engine.macroManager, engine.commands));
  }

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
        registerCommand: (def) => engine.commands.registerBuiltin(def),
        unregisterCommand: (name) => engine.commands.unregisterBuiltin(name),
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
    }),
  );

  // Canvas command (asset management + canvas)
  engine.commands.registerBuiltin(
    canvasCommand({
      getEntity: (id) => engine.entities.get(id as EntityId),
      findEntityGlobal: (name) => engine.findEntityGlobal(name),
      db: engine.db,
      storage: engine.storage,
      logEvent: (event) => engine.logEvent(event as import("../types").EngineEvent),
      scratchRoot: "data/scratch",
    }),
  );

  // Shell commands (run + shell management)
  engine.commands.registerBuiltin(
    runCommand({
      getEntity: (id) => engine.entities.get(id as EntityId),
      shellRuntime: engine.shellRuntime,
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
  engine.commands.registerBuiltin(
    codeCommand({
      agentRuntime: engine.agentRuntime,
      answerPrompt: answerCodeViaLocalModel,
      channelManager: engine.channelManager,
      crewManager: engine.crewManager,
      findAgentByName: (name) => engine.entities.findAgentByName(name),
      listAgents: () => engine.agentRuntime.list(),
      getEntity: (id) => engine.entities.get(id as EntityId),
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
  engine.commands.registerBuiltin(readinessCommand({ readiness: () => computeReadiness(engine) }));

  // Use-case command (one-shot project + task + agent scaffolding)
  if (engine.db && engine.taskManager && engine.groupManager) {
    engine.commands.registerBuiltin(
      usecaseCommand({
        getEntity: (id) => engine.entities.get(id as EntityId),
        db: engine.db,
        taskManager: engine.taskManager,
        groupManager: engine.groupManager,
        agentRuntime: engine.agentRuntime,
        logEvent: (event) => engine.logEvent(event as import("../types").EngineEvent),
        promote: (eid, rank) => engine.maybePromote(eid, rank),
      }),
    );
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

async function answerViaLocalModel(query: string, context: string): Promise<string | undefined> {
  const port = Number(process.env.WS_PORT) || 3300;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  try {
    const messages = [
      {
        role: "system",
        content:
          "You are Marina's simple ask surface. Answer the user's question directly and concisely. " +
          "If provided, use Marina world context first. If the answer is general knowledge, answer from your model knowledge. " +
          "Do not mention internal commands unless the user asks about Marina.",
      },
      ...(context.trim()
        ? [
            {
              role: "system",
              content: `Marina world context:\n${context}`,
            },
          ]
        : []),
      { role: "user", content: query },
    ];

    const resp = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getInternalModelToken()}`,
      },
      body: JSON.stringify({
        model: "marina",
        messages,
        temperature: 0.2,
        max_tokens: 600,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) return undefined;

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function answerCodeViaLocalModel(request: {
  actor: string;
  profile: string;
  prompt: string;
  sessionId: string;
  workspaceRoot: string;
}): Promise<string | undefined> {
  const port = Number(process.env.WS_PORT) || 3300;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);

  try {
    const messages = [
      {
        role: "system",
        content:
          "You are Marina Code Mode running through Marina's vendor-neutral model surface. " +
          "Help with software work inside a persistent coding session. Be concrete and concise. " +
          "You do not have direct workspace tools in this direct path; ask the user to use code read/search/diff/run/patch when needed, " +
          "or suggest assigning the session to a live Marina agent for tool-using work.",
      },
      {
        role: "system",
        content: [
          `Coding session: ${request.sessionId}`,
          `Requester: ${request.actor}`,
          `Profile: ${request.profile}`,
          `Workspace: ${request.workspaceRoot}`,
        ].join("\n"),
      },
      { role: "user", content: request.prompt },
    ];

    const resp = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getInternalModelToken()}`,
      },
      body: JSON.stringify({
        model: "marina",
        messages,
        temperature: 0.2,
        max_tokens: 1000,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) return undefined;

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : undefined;
  } finally {
    clearTimeout(timeout);
  }
}
