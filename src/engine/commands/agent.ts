import type { AgentRuntime } from "../../agent/agent-runtime";
import { MAX_AGENTS } from "../../agent/agent-runtime";
import { isSeedDisabled, listDisabledSeedAgents, setSeedDisabled } from "../../agent/seed-registry";
import { getStanding } from "../../agent/standing";
import { bold, dim, header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, EngineEvent, Entity, EntityId, RoomContext } from "../../types";
import { MAX_SPAWN_DEPTH, STANDING_PER_SPAWNED_CHILD } from "../constants";
import { getRank } from "../permissions";
import { checkGate, recordDemonstration, SAFETY_GATES } from "../safety-gates";

export function agentCommand(deps: {
  agentRuntime: AgentRuntime;
  getEntity: (id: EntityId) => Entity | undefined;
  logEvent: (event: EngineEvent) => void;
  db?: MarinaDB;
}): CommandDef {
  return {
    name: "agent",
    aliases: [],
    minRank: 0,
    help: `Manage AI agents in the world.
Usage:
  agent list                                 — list running agents
  agent status <name>                        — detailed agent status
  agent diagnose <name>                      — lifecycle health and remediation
  agent spawn <name> [model <m>] [role <r>] [goal <g>] [key <k>]
  agent stop <name>                          — stop a running agent (transient; reseeds on restart)
  agent disable <name>                        — retire a seeded agent so it stays gone across restarts
  agent enable <name>                         — clear a disable; the agent returns on next restart/room entry
  agent attention <name> <message>           — send attention to agent
  agent attention-mode <name> focused|balanced|open
  agent restart <name>                       — restart in place, preserving config/focus
  agent failover <name> <provider/model>     — restart on a fallback provider/model
  agent focus <name> <description>           — set agent focus
  agent config <name> model|role|key <value> — reconfigure agent`,
    handler: async (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;
      const rank = getRank(entity);
      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase();

      if (!sub || sub === "list") {
        return handleList(ctx, input.entity, deps);
      }

      switch (sub) {
        case "status":
          return handleStatus(ctx, input.entity, tokens[1], deps);

        case "diagnose":
          return handleStatus(ctx, input.entity, tokens[1], deps);

        case "spawn":
          // Permission is the `agent.spawn` safety gate (standing + supervised
          // demonstrations), checked inside handleSpawn so a demonstration can
          // be recorded only after a clean spawn. Falls back to the legacy
          // builder-rank check when no standing substrate (db) is wired.
          return handleSpawn(ctx, input.entity, entity, rank, tokens.slice(1), deps);

        case "stop": {
          if (rank < 4) {
            ctx.send(input.entity, "Requires builder rank (4) or higher.");
            return;
          }
          return handleStop(ctx, input.entity, tokens[1], deps);
        }

        case "restart": {
          if (rank < 4) {
            ctx.send(input.entity, "Requires builder rank (4) or higher.");
            return;
          }
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: agent restart <name>");
            return;
          }
          try {
            await deps.agentRuntime.restart(name);
            ctx.send(
              input.entity,
              `Agent ${bold(name)} restarted with configuration and focus preserved.`,
            );
          } catch (error) {
            ctx.send(
              input.entity,
              `Restart failed: ${error instanceof Error ? error.message : error}`,
            );
          }
          return;
        }

        case "failover": {
          if (rank < 4) {
            ctx.send(input.entity, "Requires builder rank (4) or higher.");
            return;
          }
          const name = tokens[1];
          const model = tokens[2];
          if (!name || !model?.includes("/")) {
            ctx.send(input.entity, "Usage: agent failover <name> <provider/model>");
            return;
          }
          try {
            await deps.agentRuntime.restart(name, { model });
            ctx.send(
              input.entity,
              `Agent ${bold(name)} failed over to ${model}; role, goal, room, and focus were preserved.`,
            );
          } catch (error) {
            ctx.send(
              input.entity,
              `Failover failed: ${error instanceof Error ? error.message : error}`,
            );
          }
          return;
        }

        case "attention-mode": {
          if (rank < 4) {
            ctx.send(input.entity, "Requires builder rank (4) or higher.");
            return;
          }
          const name = tokens[1];
          const mode = tokens[2] as "focused" | "balanced" | "open" | undefined;
          if (!name || !mode || !["focused", "balanced", "open"].includes(mode)) {
            ctx.send(input.entity, "Usage: agent attention-mode <name> focused|balanced|open");
            return;
          }
          try {
            deps.agentRuntime.setAttentionMode(name, mode);
            ctx.send(input.entity, `Agent ${bold(name)} attention mode set to ${mode}.`);
          } catch (error) {
            ctx.send(
              input.entity,
              `Attention update failed: ${error instanceof Error ? error.message : error}`,
            );
          }
          return;
        }

        case "attention-feedback": {
          if (rank < 4) {
            ctx.send(input.entity, "Requires builder rank (4) or higher.");
            return;
          }
          const name = tokens[1];
          const feedback = tokens[2] as "useful" | "noise" | undefined;
          if (!name || !feedback || !["useful", "noise"].includes(feedback)) {
            ctx.send(input.entity, "Usage: agent attention-feedback <name> useful|noise");
            return;
          }
          try {
            const threshold = deps.agentRuntime.recordAttentionFeedback(name, feedback);
            ctx.send(
              input.entity,
              `Agent ${bold(name)} learned from ${feedback}; attention threshold is now ${threshold}.`,
            );
          } catch (error) {
            ctx.send(
              input.entity,
              `Attention feedback failed: ${error instanceof Error ? error.message : error}`,
            );
          }
          return;
        }

        case "disable": {
          if (rank < 4) {
            ctx.send(input.entity, "Requires builder rank (4) or higher.");
            return;
          }
          return handleDisable(ctx, input.entity, tokens[1], deps);
        }

        case "enable": {
          if (rank < 4) {
            ctx.send(input.entity, "Requires builder rank (4) or higher.");
            return;
          }
          return handleEnable(ctx, input.entity, tokens[1], deps);
        }

        case "attention": {
          if (rank < 4) {
            ctx.send(input.entity, "Requires builder rank (4) or higher.");
            return;
          }
          const name = tokens[1];
          const message = tokens.slice(2).join(" ");
          if (!name || !message) {
            ctx.send(input.entity, "Usage: agent attention <name> <message>");
            return;
          }
          return handleAttention(ctx, input.entity, name, message, deps);
        }

        case "focus": {
          if (rank < 4) {
            ctx.send(input.entity, "Requires builder rank (4) or higher.");
            return;
          }
          const name = tokens[1];
          const description = tokens.slice(2).join(" ");
          if (!name || !description) {
            ctx.send(input.entity, "Usage: agent focus <name> <description>");
            return;
          }
          return handleFocus(ctx, input.entity, name, description, deps);
        }

        case "config": {
          if (rank < 4) {
            ctx.send(input.entity, "Requires builder rank (4) or higher.");
            return;
          }
          return handleConfig(ctx, input.entity, tokens.slice(1), deps);
        }

        default:
          ctx.send(
            input.entity,
            "Usage: agent list | agent status|diagnose <name> | agent spawn|stop|restart <name> ... | agent failover <name> <provider/model> | agent attention <name> <msg> | agent attention-mode <name> focused|balanced|open | agent focus <name> <desc> | agent config <name> ...",
          );
      }
    },
  };
}

// ─── Subcommand Handlers ────────────────────────────────────────────────────

function handleList(
  ctx: RoomContext,
  eid: EntityId,
  deps: { agentRuntime: AgentRuntime; db?: MarinaDB },
): void {
  const agents = deps.agentRuntime.list();
  const disabled = listDisabledSeedAgents(deps.db);
  if (agents.length === 0 && disabled.length === 0) {
    ctx.send(eid, "No agents running.");
    return;
  }

  const lines = [header("Agents"), separator()];
  for (const a of agents) {
    const upMin = Math.round(a.uptime / 60000);
    lines.push(
      `${bold(a.name)} ${dim(`[${a.healthState ?? a.state}]`)} ${a.model} ${a.role ? `role:${a.role}` : ""} ${dim(`${upMin}m · ${a.toolCalls} calls`)}`,
    );
    if (a.focus) lines.push(`  ${dim(`focus: ${a.focus}`)}`);
  }
  lines.push(separator(), dim(`${agents.length} agent(s) running`));
  if (disabled.length > 0) {
    lines.push(
      dim(
        `disabled (won't reseed): ${disabled.join(", ")} — re-enable with \`agent enable <name>\``,
      ),
    );
  }
  ctx.send(eid, lines.join("\n"));
}

function handleStatus(
  ctx: RoomContext,
  eid: EntityId,
  name: string | undefined,
  deps: { agentRuntime: AgentRuntime; db?: MarinaDB },
): void {
  if (!name) {
    ctx.send(eid, "Usage: agent status <name>");
    return;
  }
  const agent = deps.agentRuntime.get(name);
  if (!agent) {
    ctx.send(eid, `Agent "${name}" is not running.`);
    return;
  }

  const s = agent.getStatus();
  const upMin = Math.round(s.uptime / 60000);
  const usage = deps.db?.getPrimitiveUsageSummary(s.name);
  const lines = [
    header(`Agent: ${s.name}`),
    separator(),
    `${bold("State:")} ${s.state}`,
    `${bold("Health:")} ${s.healthState ?? s.state}${s.diagnosis ? ` — ${s.diagnosis}` : ""}`,
    `${bold("Model:")} ${s.model}`,
    `${bold("Role:")} ${s.role || dim("none")}`,
    `${bold("Focus:")} ${s.focus || dim("none")}`,
    `${bold("Goal:")} ${s.goal || dim("none")}`,
    `${bold("Uptime:")} ${upMin}m`,
    `${bold("Tool calls:")} ${s.toolCalls}`,
    ...(usage
      ? [
          `${bold("Primitive evidence (7d):")} ${usage.meaningfulActions}/${usage.commands} meaningful · ${usage.primitiveDiversity} families · ${usage.communications} communications`,
          `${bold("Tool provenance (7d):")} ${usage.marinaToolCalls}/${usage.toolCalls} Marina tools · ${usage.reasoningOnlyCalls} think-only`,
        ]
      : []),
    `${bold("Errors:")} ${s.errors}`,
    `${bold("Attention:")} ${s.attentionMode ?? "balanced"} · threshold ${s.attentionThreshold ?? 50} · ${s.queuedPerceptions ?? 0} queued · ${s.droppedPerceptions ?? 0} dropped`,
    `${bold("Entity ID:")} ${s.entityId || dim("not connected")}`,
  ];
  ctx.send(eid, lines.join("\n"));
}

/**
 * Concurrent children an agent may keep alive. Operators holding the gate by
 * grant (no standing behind it) are exempt — the budget guards against
 * autonomous runaway, not trusted operators. Earned spawners get
 * floor(standing / STANDING_PER_SPAWNED_CHILD), at least 1, clamped to the
 * global agent cap. Pure for testability.
 */
export function spawnBudget(standing: number, grantedOperator: boolean): number {
  if (grantedOperator) return MAX_AGENTS;
  return Math.min(MAX_AGENTS, Math.max(1, Math.floor(standing / STANDING_PER_SPAWNED_CHILD)));
}

/**
 * Count an entity's depth in the spawn lineage by walking the
 * agent_configs.spawned_by chain to its root. Operators/humans (not in
 * agent_configs) and world-seeded agents (spawned_by "system") resolve to
 * depth 0. A cycle/self-reference guard caps the walk defensively.
 */
export function lineageDepth(db: MarinaDB, name: string): number {
  let depth = 0;
  let current = name;
  const seen = new Set<string>([name]);
  // Hard cap the walk at MAX_SPAWN_DEPTH + 1 hops — we only need to know
  // whether the cap is reached, not the full depth of a pathological chain.
  while (depth <= MAX_SPAWN_DEPTH) {
    const cfg = db.getAgentConfig(current);
    const parent = cfg?.spawned_by;
    if (!parent || parent === "system" || seen.has(parent)) break;
    seen.add(parent);
    depth++;
    current = parent;
  }
  return depth;
}

async function handleSpawn(
  ctx: RoomContext,
  eid: EntityId,
  spawner: Entity,
  rank: number,
  tokens: string[],
  deps: {
    agentRuntime: AgentRuntime;
    logEvent: (event: EngineEvent) => void;
    db?: MarinaDB;
  },
): Promise<void> {
  // Permission: the `agent.spawn` safety gate. Assembling a team is an
  // earned, organizer-level capability — gated by standing plus supervised
  // demonstrations, not a flat rank. When no db is wired (no standing
  // substrate), fall back to the legacy builder-rank (4) check so behavior
  // degrades gracefully rather than opening up.
  //
  // This gate is enforced imperatively here rather than via the declarative
  // `CommandDef.gate` field, by design: `spawn` is a subcommand of `agent`
  // (whose other subcommands — list/stop — must stay rank 0), and the spawn
  // flow needs the gate *result* (`supervisedOnly`) to drive the
  // demonstration-recording loop below. The declarative field gates whole
  // commands and discards that result, so it can't express this.
  let pendingDemo = false;
  if (deps.db) {
    const gate = checkGate(deps.db, eid, "agent.spawn");
    if (!gate.ok) {
      ctx.send(eid, gate.reason ?? "Not permitted to spawn agents.");
      return;
    }
    pendingDemo = gate.supervisedOnly === true;

    // Lineage depth cap — emergence, not a fork bomb. An agent at or beyond
    // MAX_SPAWN_DEPTH may not spawn further. Operators/humans aren't in the
    // spawned_by chain, so they resolve to depth 0 and are unaffected.
    const depth = lineageDepth(deps.db, spawner.name);
    if (depth >= MAX_SPAWN_DEPTH) {
      ctx.send(
        eid,
        `Spawn depth limit reached (${MAX_SPAWN_DEPTH}). You are ${depth} level(s) deep in a spawn lineage — delegate to an existing agent instead of spawning deeper.`,
      );
      return;
    }

    // Standing-scaled spawn budget — reputation sizes the team. Operators who
    // hold the gate by grant (unsupervised competence without the standing to
    // back it) are exempt: this guards against autonomous runaway, not trusted
    // operators. Earned spawners get floor(standing / STANDING_PER_SPAWNED_CHILD),
    // at least 1, clamped to the global agent cap.
    const standing = getStanding(deps.db, eid);
    const granted =
      deps.db.getCompetence(eid, "agent.spawn")?.supervised_only === 0 &&
      standing < SAFETY_GATES["agent.spawn"]!.minStanding;
    const budget = spawnBudget(standing, granted);

    const live = new Set(deps.agentRuntime.list().map((a) => a.name));
    const liveChildren = deps.db
      .getAgentConfigsBySpawnedBy(spawner.name)
      .filter((c) => live.has(c.name)).length;
    if (liveChildren >= budget) {
      ctx.send(
        eid,
        `Spawn budget reached (${liveChildren}/${budget}). Raise your standing to grow your team, or stop an agent you spawned.`,
      );
      return;
    }
  } else if (rank < 4) {
    ctx.send(eid, "Requires builder rank (4) or higher.");
    return;
  }

  if (!deps.agentRuntime.isAvailable()) {
    ctx.send(
      eid,
      "No LLM API keys configured. Set ANTHROPIC_API_KEY, GEMINI_API_KEY, or another provider key.",
    );
    return;
  }

  const name = tokens[0];
  if (!name) {
    ctx.send(
      eid,
      "Usage: agent spawn <name> [model <model>] [role <role>] [goal <goal>] [key <key>]",
    );
    return;
  }

  // Parse optional keyword arguments
  const opts: Record<string, string> = {};
  for (let i = 1; i < tokens.length - 1; i++) {
    const key = tokens[i]?.toLowerCase();
    if (key && ["model", "role", "goal", "key"].includes(key)) {
      // goal consumes the rest of the tokens
      if (key === "goal") {
        opts[key] = tokens.slice(i + 1).join(" ");
        break;
      }
      opts[key] = tokens[i + 1] ?? "";
      i++;
    }
  }

  ctx.send(
    eid,
    `Spawning ${bold(name)} (${opts.model || "google/gemini-2.0-flash"}${opts.role ? `, ${opts.role}` : ""})...`,
  );

  try {
    const handle = await deps.agentRuntime.spawn({
      name,
      model: opts.model,
      role: opts.role,
      goal: opts.goal,
      keyName: opts.key,
      spawnedBy: spawner.name,
    });

    const status = handle.getStatus();
    deps.logEvent({
      type: "agent_spawn",
      entity: (status.entityId ?? eid) as EntityId,
      name,
      model: status.model,
      role: status.role,
      timestamp: Date.now(),
    });

    // Record the supervised demonstration only after a clean spawn — once
    // demoThreshold accumulates, agent.spawn flips to unsupervised.
    if (pendingDemo && deps.db) {
      recordDemonstration(deps.db, eid, "agent.spawn");
    }

    ctx.send(eid, `Agent ${bold(name)} spawned and running.`);
  } catch (error) {
    ctx.send(eid, `Failed to spawn agent: ${error instanceof Error ? error.message : error}`);
  }
}

async function handleStop(
  ctx: RoomContext,
  eid: EntityId,
  name: string | undefined,
  deps: {
    agentRuntime: AgentRuntime;
    logEvent: (event: EngineEvent) => void;
  },
): Promise<void> {
  if (!name) {
    ctx.send(eid, "Usage: agent stop <name>");
    return;
  }

  const agent = deps.agentRuntime.get(name);
  if (!agent) {
    ctx.send(eid, `Agent "${name}" is not running.`);
    return;
  }

  const status = agent.getStatus();
  try {
    await deps.agentRuntime.stop(name);

    deps.logEvent({
      type: "agent_stop",
      entity: (status.entityId ?? eid) as EntityId,
      name,
      reason: "manual",
      timestamp: Date.now(),
    });

    ctx.send(eid, `Agent ${bold(name)} stopped.`);
  } catch (error) {
    ctx.send(eid, `Failed to stop agent: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Retire a seeded agent durably: persist a disable marker (so the world seed,
 * autorespawn, and room-agent spawn all skip it across restarts) and stop the
 * running instance. The opposite of `stop`, which is transient.
 */
async function handleDisable(
  ctx: RoomContext,
  eid: EntityId,
  name: string | undefined,
  deps: { agentRuntime: AgentRuntime; logEvent: (event: EngineEvent) => void; db?: MarinaDB },
): Promise<void> {
  if (!name) {
    ctx.send(eid, "Usage: agent disable <name>");
    return;
  }
  if (!deps.db) {
    ctx.send(eid, "Disable requires a database (persisted markers).");
    return;
  }
  setSeedDisabled(deps.db, name, true);
  // Stop the running instance if present (this also deletes its saved config).
  const agent = deps.agentRuntime.get(name);
  if (agent) {
    try {
      await deps.agentRuntime.stop(name);
    } catch {
      // Marker is set regardless — it won't come back on the next boot.
    }
  }
  ctx.send(
    eid,
    `Agent ${bold(name)} disabled — it won't be reseeded or respawned. Re-enable with ${bold(`agent enable ${name}`)}.`,
  );
}

/** Clear a disable marker; the agent returns on the next restart / room entry. */
function handleEnable(
  ctx: RoomContext,
  eid: EntityId,
  name: string | undefined,
  deps: { db?: MarinaDB },
): void {
  if (!name) {
    ctx.send(eid, "Usage: agent enable <name>");
    return;
  }
  if (!deps.db) {
    ctx.send(eid, "Enable requires a database (persisted markers).");
    return;
  }
  if (!isSeedDisabled(deps.db, name)) {
    ctx.send(eid, `Agent ${bold(name)} is not disabled.`);
    return;
  }
  setSeedDisabled(deps.db, name, false);
  ctx.send(
    eid,
    `Agent ${bold(name)} enabled — it returns on the next restart (seeded agents) or room entry (room hosts). ` +
      `If disabled via MARINA_DISABLED_AGENTS, remove it from that env too.`,
  );
}

async function handleAttention(
  ctx: RoomContext,
  eid: EntityId,
  name: string,
  message: string,
  deps: { agentRuntime: AgentRuntime },
): Promise<void> {
  const agent = deps.agentRuntime.get(name);
  if (!agent) {
    ctx.send(eid, `Agent "${name}" is not running.`);
    return;
  }
  await agent.sendAttention(message);
  ctx.send(eid, `Attention sent to ${bold(name)}.`);
}

function handleFocus(
  ctx: RoomContext,
  eid: EntityId,
  name: string,
  description: string,
  deps: { agentRuntime: AgentRuntime },
): void {
  const agent = deps.agentRuntime.get(name);
  if (!agent) {
    ctx.send(eid, `Agent "${name}" is not running.`);
    return;
  }
  agent.setFocus(description);
  ctx.send(eid, `Focus set for ${bold(name)}: ${description}`);
}

async function handleConfig(
  ctx: RoomContext,
  eid: EntityId,
  tokens: string[],
  deps: { agentRuntime: AgentRuntime },
): Promise<void> {
  const name = tokens[0];
  const field = tokens[1]?.toLowerCase();
  const value = tokens.slice(2).join(" ");

  if (!name || !field || !value) {
    ctx.send(eid, "Usage: agent config <name> model|role|key <value>");
    return;
  }

  if (!deps.agentRuntime.get(name)) {
    ctx.send(eid, `Agent "${name}" is not running.`);
    return;
  }

  const opts: { model?: string; role?: string; keyName?: string } = {};
  switch (field) {
    case "model":
      opts.model = value;
      break;
    case "role":
      opts.role = value;
      break;
    case "key":
      opts.keyName = value;
      break;
    default:
      ctx.send(eid, `Unknown config field: ${field}. Use: model, role, key`);
      return;
  }

  ctx.send(eid, `Reconfiguring ${bold(name)}...`);
  try {
    await deps.agentRuntime.reconfigure(name, opts);
    ctx.send(eid, `Agent ${bold(name)} reconfigured (${field} = ${value}).`);
  } catch (error) {
    ctx.send(eid, `Reconfigure failed: ${error instanceof Error ? error.message : error}`);
  }
}
