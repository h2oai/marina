// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { MAX_AGENTS } from "../../agent/agent-runtime";
import type { EntityId } from "../../types";
import { askCommand } from "../commands/ask";
import { bankrollCommand } from "../commands/bankroll";
import { benchmarkCommand } from "../commands/benchmark";
import { contextCommand } from "../commands/context";
import { debriefCommand } from "../commands/debrief";
import { digCommand } from "../commands/dig";
import { evolveCommand } from "../commands/evolve";
import { guideCommand } from "../commands/guide";
import { marketCommand } from "../commands/market";
import { memoryCommand } from "../commands/memory";
import { nextCommand } from "../commands/next";
import { noveltyCommand } from "../commands/novelty";
import { orientCommand } from "../commands/orient";
import { poolCommand } from "../commands/pool";
import { positionCommand } from "../commands/position";
import { recallCommand } from "../commands/recall";
import { recapCommand } from "../commands/recap";
import { helperAgentName, REFLECTOR_SPAWN_BUDGET, reflectCommand } from "../commands/reflect";
import { scenarioCommand } from "../commands/scenario";
import { shareCommand } from "../commands/share";
import { skillCommand } from "../commands/skill";
import { workCommand } from "../commands/work";
import type { Engine } from "../engine";
import { trialCallBudget } from "../evolution-trial";
import { answerViaLocalModel } from "./model-helpers";

export function registerMemoryCommands(engine: Engine): void {
  engine.commands.registerBuiltin(
    contextCommand({ db: engine.db, getEntity: (id) => engine.entities.get(id) }),
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
      resolveEntityIdByName: (name) =>
        engine.entities.findAgentByName(name)?.id ??
        engine.entities.all().find((e) => e.name === name)?.id,
    }),
  );
  engine.commands.registerBuiltin(
    reflectCommand({
      getEntity: (id) => engine.entities.get(id as EntityId),
      db: engine.db,
      logEvent: (event) => engine.logEvent(event),
      // Live runtime view so `reflect` files a job only with a RUNNING
      // memory-reflector (a configured-but-stopped helper would otherwise
      // receive a durable job nobody works).
      listAgents: () =>
        (engine.agentRuntime?.list() ?? []).map((a) => ({
          name: a.name,
          role: a.role,
          state: a.state,
        })),
      // LOCAL ungated only (checked inside `reflect`): spawn the helper the
      // way `agent spawn <name> model marina/default role memory-reflector
      // budget 40` would, then wait (bounded) for its world account — the
      // runtime logs the agent in, which creates the `users` row the durable
      // job needs as worker_id.
      helpersAvailable: () => engine.agentRuntime?.isAvailable() ?? false,
      spawnHelper: async (role, requestedBy) => {
        const name = helperAgentName(role);
        const existing = engine.agentRuntime.get(name);
        if (!existing) {
          await engine.agentRuntime.spawn({
            name,
            model: "marina/default",
            role,
            budgetCalls: REFLECTOR_SPAWN_BUDGET,
            spawnedBy: requestedBy,
          });
        }
        const deadline = Date.now() + 5_000;
        for (;;) {
          const user = engine.db?.getUserByName(name);
          if (user) return { name, principalId: user.id };
          if (Date.now() >= deadline) return undefined;
          await Bun.sleep(100);
        }
      },
    }),
  );
  engine.commands.registerBuiltin(
    poolCommand({
      getEntity: (id) => engine.entities.get(id as EntityId),
      db: engine.db,
      logEvent: (event) => engine.logEvent(event),
      getCommandNames: () =>
        engine.commands.allBuiltins().flatMap((cmd) => [cmd.name, ...(cmd.aliases ?? [])]),
      resolveEntityIdByName: (name) =>
        engine.entities.findAgentByName(name)?.id ??
        engine.entities.all().find((e) => e.name === name)?.id,
    }),
  );
  engine.commands.registerBuiltin(
    guideCommand({
      getEntity: (id) => engine.entities.get(id as EntityId),
      db: engine.db,
      getCommandNames: () =>
        engine.commands.allBuiltins().flatMap((cmd) => [cmd.name, ...(cmd.aliases ?? [])]),
    }),
  );
  engine.commands.registerBuiltin(
    noveltyCommand({
      getEntity: (id) => engine.entities.get(id as EntityId),
      db: engine.db,
      getTotalRoomCount: () => engine.rooms.all().length,
      getAllCommands: () => engine.commands.allBuiltins(),
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
        describeTarget: (model) => {
          // `marina:<name>` → the online agents on its model-<name> channel.
          const cm = engine.channelManager;
          const name = /^marina:(.+)$/.exec(model)?.[1];
          if (!cm || !name) return [];
          const channel = cm.getAllChannels().find((c) => c.name === `model-${name}`);
          if (!channel) return [];
          const members = new Set(cm.getMembers(channel.id).map(String));
          return engine.agentRuntime
            .list()
            .filter((a) => a.entityId && members.has(a.entityId))
            .map((a) => ({
              agent: a.name,
              ...(a.role ? { role: a.role } : {}),
              ...(a.promptVersion ? { promptVersion: a.promptVersion } : {}),
            }));
        },
      }),
    );
  }
  engine.commands.registerBuiltin(
    nextCommand({
      getEntity: (id) => engine.entities.get(id as EntityId),
      db: engine.db,
      taskManager: engine.taskManager,
      crewManager: engine.crewManager,
      quests: engine.world?.quests ?? [],
      startRoom: engine.config.startRoom,
    }),
  );
  engine.commands.registerBuiltin(
    workCommand({
      getEntity: (id) => engine.entities.get(id as EntityId),
      db: engine.db,
      taskManager: engine.taskManager,
      crewManager: engine.crewManager,
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
      benchmarkReady: (name) => engine.benchmarkRunner?.datasetReady(name) ?? false,
      replicateDeps: () => {
        const rt = engine.agentRuntime;
        const db = engine.db;
        if (!rt?.isAvailable() || !db) return undefined;
        return {
          spawn: async (o) => {
            await rt.spawn(o);
          },
          liveChildren: (spawner) => {
            const live = new Set(rt.list().map((a) => a.name));
            return db.getAgentConfigsBySpawnedBy(spawner).filter((c) => live.has(c.name)).length;
          },
          agentsLeft: () => Math.max(0, MAX_AGENTS - rt.list().length),
        };
      },
      trialDeps: (opts) => {
        const rt = engine.agentRuntime;
        const cm = engine.channelManager;
        const runner = engine.benchmarkRunner;
        const db = engine.db;
        if (!rt?.isAvailable() || !cm || !runner || !db) return undefined;
        let lastSpawn = 0;
        const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
        return {
          spawn: async (name, role) => {
            // The runtime refuses spawns closer than 1 s apart.
            const wait = lastSpawn + 1_100 - Date.now();
            if (wait > 0) await sleep(wait);
            lastSpawn = Date.now();
            await rt.spawn({
              name,
              model: opts.agentModel,
              role,
              spawnedBy: opts.callerId,
              budgetCalls: trialCallBudget(opts.limit ?? (opts.benchmark === "smoke" ? 15 : 100)),
            });
          },
          entityIdOf: (name) => rt.get(name)?.getStatus().entityId ?? undefined,
          subjectOf: (name) => {
            const s = rt.get(name)?.getStatus();
            return {
              agent: name,
              ...(s?.role ? { role: s.role } : {}),
              ...(s?.promptVersion ? { promptVersion: s.promptVersion } : {}),
            };
          },
          createModelChannel: (name, entityId) => {
            const ch =
              cm.getChannelByName(name) ??
              cm.createChannel({ type: "model", name, retentionHours: 24 });
            cm.addMember(ch.id, entityId);
          },
          deleteModelChannel: (name) => {
            const ch = cm.getChannelByName(name);
            if (ch) cm.deleteChannel(ch.id);
          },
          startBenchmark: (model, subjects) =>
            runner.start({
              benchmark: opts.benchmark,
              model,
              subjects,
              ...(opts.limit ? { limit: opts.limit } : {}),
              ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
              ...(opts.partition ? { partition: opts.partition } : {}),
              agentId: opts.callerId,
            }).id,
          runStatus: (id) => {
            const r = db.getBenchmarkRun(id);
            return r && { status: r.status, score: r.score, answered: r.answered, total: r.total };
          },
          stop: (name) => rt.stop(name),
          sleep,
          now: () => Date.now(),
        };
      },
      notifyEvolutionState: (entityNames, state) => {
        for (const name of entityNames) {
          const target = engine.findEntityGlobal(name);
          if (!target) continue;
          engine.sendSystemControl(target.id, "evolution_session_state", state);
        }
      },
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
      getCommandNames: () =>
        engine.commands.allBuiltins().flatMap((cmd) => [cmd.name, ...(cmd.aliases ?? [])]),
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
}
