import type { CrewManager } from "../../coordination/crew-manager";
import type { GroupManager } from "../../coordination/group-manager";
import type { TaskManager } from "../../coordination/task-manager";
import {
  A,
  bold,
  bullet,
  category,
  dim,
  entity as fmtEntity,
  header,
  id,
  label,
  sectionHead,
  status,
} from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";
import { getRank } from "../permissions";

interface BriefDeps {
  getEntity: (id: EntityId) => Entity | undefined;
  db?: MarinaDB;
  taskManager?: TaskManager;
  getOnlineAgents: () => Entity[];
  groupManager?: GroupManager;
  crewManager?: CrewManager;
  subscribeBrief?: (entityId: EntityId, interval: number) => void;
  unsubscribeBrief?: (entityId: EntityId) => void;
  isBriefSubscribed?: (entityId: EntityId) => boolean;
  hasLlmKeys?: boolean;
}

/**
 * Brief: lightweight orientation signal.
 *
 * On login (auto-sent), outputs a single-line compass — just enough for
 * the agent to know what continuation commands to issue. No walls of text.
 *
 * When invoked manually (`brief full`), shows the full briefing with details.
 * `brief watch [N]` subscribes to periodic compass pulses.
 * `brief unwatch` stops the subscription.
 */
export function briefCommand(deps: BriefDeps): CommandDef {
  return {
    name: "brief",
    aliases: ["sitrep", "compass"],
    help: "Get oriented. Shows the current shape of the world — who is here, what exists, where to go next. Use 'brief watch [N]' for periodic updates, 'brief unwatch' to stop.",
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const sub = input.tokens[0]?.toLowerCase();

      if (sub === "watch") {
        return handleWatch(ctx, input.entity, input.tokens, deps);
      }
      if (sub === "unwatch") {
        return handleUnwatch(ctx, input.entity, deps);
      }
      if (sub === "social") {
        return sendSocialBrief(ctx, input.entity, entity, deps);
      }

      const full = input.tokens.length > 0;
      if (full) {
        sendFullBrief(ctx, input.entity, entity, deps);
      } else {
        sendCompass(ctx, input.entity, entity, deps);
      }
    },
  };
}

function handleWatch(ctx: RoomContext, eid: EntityId, tokens: string[], deps: BriefDeps): void {
  if (!deps.subscribeBrief) {
    ctx.send(eid, "Brief watch is not available.");
    return;
  }

  const MIN_INTERVAL = 30;
  const MAX_INTERVAL = 600;
  const DEFAULT_INTERVAL = 120;

  let interval = DEFAULT_INTERVAL;
  if (tokens.length > 1) {
    const parsed = Number.parseInt(tokens[1]!, 10);
    if (Number.isNaN(parsed) || parsed < MIN_INTERVAL || parsed > MAX_INTERVAL) {
      ctx.send(
        eid,
        `Interval must be ${MIN_INTERVAL}-${MAX_INTERVAL} ticks. Default: ${DEFAULT_INTERVAL}.`,
      );
      return;
    }
    interval = parsed;
  }

  deps.subscribeBrief(eid, interval);
  ctx.send(eid, `Watching: compass every ${interval} ticks.`);
}

function handleUnwatch(ctx: RoomContext, eid: EntityId, deps: BriefDeps): void {
  if (!deps.unsubscribeBrief) {
    ctx.send(eid, "Brief watch is not available.");
    return;
  }

  if (deps.isBriefSubscribed?.(eid)) {
    deps.unsubscribeBrief(eid);
    ctx.send(eid, "Stopped watching.");
  } else {
    ctx.send(eid, "Not currently watching.");
  }
}

/**
 * Social brief: factual summary of social state.
 * Who is in the room, who is online, recent channel activity.
 * No scoring, no priorities — just facts for the agent to decide what matters.
 */
function sendSocialBrief(ctx: RoomContext, eid: EntityId, _entity: Entity, deps: BriefDeps): void {
  const lines: string[] = [header("Social"), ""];

  // Entities in room
  const roomEntities = ctx.entities ?? [];
  if (roomEntities.length > 0) {
    const names = roomEntities.map((e) => (e.id === eid ? `${e.name} (you)` : e.name));
    lines.push(`${bold("In room:")} ${names.join(", ")}`);
  } else {
    lines.push(`${bold("In room:")} ${dim("empty")}`);
  }

  // Online agents
  const online = deps.getOnlineAgents();
  if (online.length > 0) {
    lines.push(
      `${bold("Online:")} ${online.map((e) => e.name).join(", ")} ${dim(`(${online.length})`)}`,
    );
  }

  ctx.send(eid, lines.join("\n"));
}

/** Bootstrap: terse first-login orientation for new entities. */
function sendBootstrap(ctx: RoomContext, eid: EntityId, _entity: Entity, deps: BriefDeps): void {
  const lines: string[] = [
    header("Welcome to Marina."),
    "You think, therefore you are here.",
    "",
    "Set your purpose. Build your memory. Collaborate or work independently.",
    "",
    category("Get started:"),
    `  1. ${bold("memory set goal <your purpose>")} — define what you're here to do`,
    `  2. ${bold("pool guide recall <topic>")} — read what predecessors learned (memory, tasks, navigation, communication, pools, building)`,
    `  3. ${bold("next")} — context-aware suggestion for your next action`,
    "",
    category("Commands:"),
    `  ${dim("navigate:")} look, north/south/east/west, map`,
    `  ${dim("communicate:")} say <text>, tell <name> <text>, channel join general`,
    `  ${dim("remember:")} note <text>, recall <query>, memory set <key> <value>`,
    `  ${dim("work:")} task list, task claim <id>, project list`,
    `  ${dim("learn:")} help, ask <question>, web search <query>`,
    `  ${dim("grow:")} evolve — your self-improvement loop + next step, skill list`,
  ];

  // Arrival digest — recent canonical history so newcomers have shared social
  // context. Narrative + digest only (engine event entries are noisy templated
  // titles and don't give the arrival a sense of the polity's interpretation).
  if (deps.db) {
    const recent = [
      ...deps.db.queryChronicle({ kind: "digest", limit: 2 }),
      ...deps.db.queryChronicle({ kind: "narrative", limit: 3 }),
    ]
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 3);
    if (recent.length > 0) {
      lines.push("");
      lines.push(category("Recent chronicle:"));
      for (const e of recent) {
        const title = e.title.length > 80 ? `${e.title.slice(0, 77)}…` : e.title;
        lines.push(`  ${dim(`#${e.id}`)} [${e.kind}] ${title}`);
      }
      lines.push(dim("  → chronicle  ·  recap chronicle day  ·  chronicle show <id>"));
    }
  }

  ctx.send(eid, lines.join("\n"));
}

/** Compass: single-line signal with counts, no content dump. */
function sendCompass(ctx: RoomContext, eid: EntityId, entity: Entity, deps: BriefDeps): void {
  if (entity.properties._isFirstLogin) {
    entity.properties._isFirstLogin = undefined;
    sendBootstrap(ctx, eid, entity, deps);
    return;
  }

  const parts: string[] = [];

  const online = deps.getOnlineAgents();
  const otherCount = online.filter((e) => e.id !== eid).length;
  parts.push(otherCount > 0 ? `${bold(String(otherCount))} online` : dim("alone"));

  let hasMemory = false;
  if (deps.db) {
    const db = deps.db;
    const projects = db.listProjects().filter((p) => p.status === "active");
    if (projects.length > 0) parts.push(`${bold(String(projects.length))} projects`);

    if (deps.taskManager) {
      const open = deps.taskManager.list({ status: "open" });
      const bounties = open.filter((t) => t.validationMode === "bounty");
      if (bounties.length > 0 && open.length > bounties.length) {
        parts.push(
          `${bold(String(bounties.length))} bounties, ${open.length - bounties.length} tasks`,
        );
      } else if (bounties.length > 0) {
        parts.push(`${bold(String(bounties.length))} bounties`);
      } else if (open.length > 0) {
        parts.push(`${bold(String(open.length))} open tasks`);
      }
    }

    // Personal: show claimed task count
    const myClaims = db.getActiveClaimsByName(entity.name);
    if (myClaims.length > 0) parts.push(`${bold(String(myClaims.length))} yours`);

    // Staffing signal: projects with more open tasks than members
    if (deps.taskManager && deps.groupManager) {
      const needHelp = countUnderstaffedProjects(db, deps.taskManager, deps.groupManager);
      if (needHelp > 0) parts.push(`${A.yellow}${needHelp} need help${A.reset}`);
    }

    const pools = db.listMemoryPools();
    if (pools.length > 0) parts.push(`${pools.length} pools`);

    // Canvas intents — signal for agents to investigate + timeout stale claims
    const INTENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    let pendingIntents = 0;
    for (const canvas of db.listCanvases({ limit: 50 })) {
      for (const node of db.getNodesByCanvas(canvas.id)) {
        try {
          const parsed = JSON.parse(node.data);
          if (!parsed.intent) continue;

          // Timeout: reset stale active intents back to pending
          if (parsed.intent.status === "active") {
            const claimedAt = parsed.intent.claimedAt ?? node.updated_at;
            if (Date.now() - claimedAt > INTENT_TIMEOUT_MS) {
              parsed.intent.status = "pending";
              parsed.intent.claimedBy = undefined;
              parsed.intent.claimedAt = undefined;
              db.updateNode(node.id, { data: JSON.stringify(parsed) });
            }
          }

          if (parsed.intent.status === "pending") pendingIntents++;
        } catch {
          /* skip malformed data */
        }
      }
    }
    if (pendingIntents > 0) {
      parts.push(
        `${A.yellow}${pendingIntents} pending intent${pendingIntents > 1 ? "s" : ""}${A.reset}`,
      );
    }

    const memoryCount = db.listCoreMemory(entity.name).length;
    if (memoryCount > 0) {
      parts.push(`${memoryCount} memories`);
      hasMemory = true;
    }
  }

  const compass = parts.join(` ${dim("\u00b7")} `);

  // After the compass line, show the agent's goal if they have one
  const lines: string[] = [`${A.bold}${A.cyan}[${A.reset}${compass}${A.bold}${A.cyan}]${A.reset}`];
  if (deps.db) {
    const goalEntry = deps.db.getCoreMemory(entity.name, "goal");
    if (goalEntry) {
      lines.push(`${category("Goal:")} ${goalEntry.value.slice(0, 80)}`);
    }

    // Show highest-priority active goal from tasks
    const myClaims = deps.db.getActiveClaimsByName(entity.name);
    if (myClaims.length > 0) {
      const topTask = myClaims[0]!;
      const prog = topTask.progress > 0 ? ` ${topTask.progress}%` : "";
      lines.push(`${category("Task:")} ${topTask.title}${prog}`);
    }

    // Curiosity signal — entropy-based boredom detection (passive, no prescription)
    const commandDist = deps.db.getActivityByType(entity.name, "command", 50);
    if (commandDist.length >= 5) {
      const counts = commandDist.map((c) => c.count);
      const total = counts.reduce((a, b) => a + b, 0);
      if (total > 20) {
        const n = counts.length;
        let h = 0;
        for (const c of counts) {
          if (c === 0) continue;
          const p = c / total;
          h -= p * Math.log2(p);
        }
        const normalized = n > 1 ? h / Math.log2(n) : 0;
        if (normalized < 0.3) {
          lines.push(dim("[low action diversity]"));
        }
      }
    }
  }

  // Crew context — agents in crews need to see who they're working with.
  if (deps.crewManager) {
    const myCrews = deps.crewManager.forAgent(entity.name);
    if (myCrews.length > 0) {
      for (const crew of myCrews) {
        const others = crew.members.filter((m) => m.agentName !== entity.name);
        const otherNames = others.map((m) => m.agentName).join(", ") || dim("(alone)");
        lines.push(
          `${category("Crew:")} ${crew.name} ${dim(`[${crew.formation}]`)} → ${crew.goal || dim("(no goal)")} · with ${otherNames}`,
        );
      }
    }
  }

  // Admin signal: no LLM keys configured (show to rank 8+ guardians)
  if (deps.hasLlmKeys === false && getRank(entity) >= 8) {
    lines.push(dim("[no LLM keys — agents unavailable. Use 'key add' or set ANTHROPIC_API_KEY]"));
  }

  if (!hasMemory) {
    lines.push(dim("Hint: help | pool guide recall getting started | brief full"));
  }

  ctx.send(eid, lines.join("\n"));
}

/** Full brief: invoked manually via `brief full` or `sitrep full`. */
function sendFullBrief(ctx: RoomContext, eid: EntityId, entity: Entity, deps: BriefDeps): void {
  const lines: string[] = [header("Briefing")];

  const online = deps.getOnlineAgents();
  if (online.length > 1) {
    const others = online.filter((e) => e.id !== eid);
    const names = others
      .slice(0, 10)
      .map((e) => fmtEntity(e.name))
      .join(", ");
    const more = others.length > 10 ? dim(` (+${others.length - 10} more)`) : "";
    lines.push(`${category("Online:")} ${names}${more}`);
  } else {
    lines.push(`${category("Online:")} ${dim("you are the only entity here")}`);
  }

  if (!deps.db) {
    ctx.send(eid, lines.join("\n"));
    return;
  }
  const db = deps.db;

  // ─── Your context (personal state) ──────────────────────────────────

  const memories = db.listCoreMemory(entity.name);
  if (memories.length > 0) {
    lines.push("", sectionHead("Your Memory"));
    for (const m of memories.slice(0, 8)) {
      lines.push(label(m.key, m.value.slice(0, 60)));
    }
  }

  const myClaims = db.getActiveClaimsByName(entity.name);
  if (myClaims.length > 0) {
    lines.push("", sectionHead("Your Tasks"));
    for (const c of myClaims.slice(0, 5)) {
      const st = c.status === "submitted" ? ` ${status("submitted", "info")}` : "";
      lines.push(bullet(`${id(c.task_id)} ${c.title}${st}`));
    }
  }

  if (deps.crewManager) {
    const myCrews = deps.crewManager.forAgent(entity.name);
    if (myCrews.length > 0) {
      lines.push("", sectionHead("Your Crews"));
      for (const crew of myCrews) {
        const myMember = crew.members.find((m) => m.agentName === entity.name);
        const myRole = myMember?.role ?? "member";
        const others =
          crew.members
            .filter((m) => m.agentName !== entity.name)
            .map((m) => `${m.agentName} (${m.role})`)
            .join(", ") || dim("(alone)");
        lines.push(
          bullet(
            `${crew.name} ${dim(`[${crew.formation}/${crew.state}]`)} as ${myRole} → ${crew.goal || dim("(no goal)")}`,
          ),
          `    ${dim("with:")} ${others}`,
          `    ${dim("channel:")} ${crew.channelId ?? dim("(unallocated)")}`,
        );
      }
    }
  }

  // Canvas intents — show pending/active intents for agents to act on
  const intentItems: {
    nodeId: string;
    canvasName: string;
    prompt: string;
    intentStatus: string;
    claimedBy?: string;
  }[] = [];
  for (const canvas of db.listCanvases({ limit: 50 })) {
    for (const n of db.getNodesByCanvas(canvas.id)) {
      try {
        const p = JSON.parse(n.data);
        if (p.intent && (p.intent.status === "pending" || p.intent.status === "active")) {
          intentItems.push({
            nodeId: n.id,
            canvasName: canvas.name,
            prompt: p.intent.prompt,
            intentStatus: p.intent.status,
            claimedBy: p.intent.claimedBy,
          });
        }
      } catch {
        /* skip */
      }
    }
  }
  if (intentItems.length > 0) {
    lines.push("", sectionHead("Canvas Intents"));
    for (const i of intentItems.slice(0, 5)) {
      const who = i.claimedBy ? ` [${i.claimedBy}]` : "";
      const prompt = i.prompt.length > 50 ? `${i.prompt.slice(0, 47)}...` : i.prompt;
      const st =
        i.intentStatus === "active"
          ? status(i.intentStatus, "active")
          : status(i.intentStatus, "warn");
      lines.push(bullet(`${st} ${bold(i.nodeId.slice(0, 8))}${who} — ${prompt}`));
    }
    if (intentItems.length > 5) {
      lines.push(dim(`  ...and ${intentItems.length - 5} more`));
    }
  }

  const recentNotes = db.getNotesByEntity(entity.name, 5);
  if (recentNotes.length > 0) {
    lines.push("", sectionHead("Recent Notes"));
    for (const n of recentNotes) {
      const age = formatAge(n.created_at);
      const type = n.note_type ? ` ${status(n.note_type, "info")}` : "";
      const preview = n.content.slice(0, 60) + (n.content.length > 60 ? "..." : "");
      lines.push(bullet(`${id(n.id)}${type} ${preview} ${dim(`(${age})`)}`));
    }
  }

  const recentActivity = db.getRecentActivity(entity.name, 5);
  if (recentActivity.length > 0) {
    const summaries: string[] = [];
    for (const a of recentActivity) {
      if (a.activity_type === "room_visit") {
        summaries.push(`visited ${a.activity_key}`);
      } else if (a.activity_type === "command") {
        summaries.push(`${a.activity_key} ${dim(`(x${a.count})`)}`);
      }
    }
    if (summaries.length > 0) {
      lines.push("", `${category("Recent:")} ${summaries.join(", ")}`);
    }
  }

  // ─── World state ────────────────────────────────────────────────────

  const projects = db.listProjects().filter((p) => p.status === "active");
  if (projects.length > 0) {
    lines.push("", sectionHead("Projects"));
    for (const p of projects.slice(0, 5)) {
      const orch = p.orchestration !== "custom" ? ` ${status(p.orchestration, "info")}` : "";
      const desc = p.description.slice(0, 50) || dim("(no description)");
      lines.push(bullet(`${bold(p.name)}${orch}: ${desc}`));
    }
    if (projects.length > 5) lines.push(dim(`  (+${projects.length - 5} more)`));
  }

  if (deps.taskManager) {
    const allTasks = deps.taskManager.list({ orderByStanding: true });
    const tasks = allTasks.filter((t) => t.status === "open" || t.status === "claimed");
    if (tasks.length > 0) {
      const open = tasks.filter((t) => t.status === "open").length;
      const claimed = tasks.filter((t) => t.status === "claimed").length;
      const bounties = tasks.filter((t) => t.validationMode === "bounty").length;
      const taskParts = [`${bold(String(open))} open`, `${claimed} in progress`];
      if (bounties > 0) taskParts.push(`${bold(String(bounties))} bounties`);
      lines.push("", `${sectionHead("Tasks")} ${dim(taskParts.join(", "))}`);

      // Top 3 highest-standing open tasks
      const topTasks = tasks.filter((t) => t.status === "open").slice(0, 3);
      for (const t of topTasks) {
        const bounty =
          t.validationMode === "bounty" && t.standing > 0
            ? ` ${status(`!${t.standing}`, "warn")}`
            : "";
        lines.push(bullet(`${id(t.id)} ${t.title}${bounty}`));
      }
    }
  }

  // ─── Staffing ───────────────────────────────────────────────────────

  if (deps.taskManager && deps.groupManager) {
    const staffing = getStaffingInfo(db, deps.taskManager, deps.groupManager);
    if (staffing.length > 0) {
      lines.push("", sectionHead("Staffing"));
      for (const s of staffing.slice(0, 5)) {
        const warn = s.openTasks > s.members;
        const counts = warn
          ? `${A.yellow}${s.openTasks} open${A.reset}, ${s.members} members`
          : `${s.openTasks} open, ${s.members} members`;
        lines.push(bullet(`${bold(s.name)} ${status(s.orchestration, "info")} ${counts}`));
      }
    }
  }

  // ─── Standing leaders ───────────────────────────────────────────────

  const leaders = db.getStandingLeaderboard(3);
  if (leaders.length > 0) {
    const leaderStr = leaders
      .map((l) => `${fmtEntity(l.entityName)} ${dim(`(${l.total})`)}`)
      .join(", ");
    lines.push("", `${category("Standing:")} ${leaderStr}`);
  }

  // ─── Room templates ─────────────────────────────────────────────────

  const templates = db.getAllRoomTemplates();
  if (templates.length > 0) {
    lines.push("", `${category("Room templates:")} ${templates.length} available`);
  }

  // ─── Pools ──────────────────────────────────────────────────────────

  const pools = db.listMemoryPools();
  if (pools.length > 0) {
    const poolSummaries = pools.slice(0, 8).map((p) => {
      const notes = db.getPoolNotes(p.id, 1);
      const st = notes.length > 0 ? status("active", "active") : dim("empty");
      return `${p.name} ${st}`;
    });
    lines.push("", `${category("Pools:")} ${poolSummaries.join(", ")}`);
  }

  // Recent world activity from the feed — keeps agents aware of what's
  // happening without them needing to explicitly `feed list`. Previously
  // the feed was a DB artifact agents never incorporated into their
  // compass; they were blind to world events unless they looked.
  try {
    const recentFeed = db.queryFeedEvents({ limit: 5 });
    if (recentFeed.length > 0) {
      lines.push("", sectionHead("Recent World Activity"));
      for (const e of recentFeed) {
        const ageMin = Math.max(1, Math.round((Date.now() - e.created_at) / 60000));
        const actor = e.entity ? fmtEntity(e.entity) : dim("—");
        lines.push(bullet(`${dim(`${ageMin}m ago`)} ${actor} ${category(e.kind)}`));
      }
    }
  } catch {
    // Feed query failure is non-critical — brief still renders without it.
  }

  if (memories.length === 0 && projects.length === 0) {
    lines.push(
      "",
      dim("New here? Try:"),
      bullet(bold("pool guide recall getting started")),
      bullet(bold("help")),
      bullet(bold("look")),
    );
  }

  ctx.send(eid, lines.join("\n"));
}

/** Count active projects where open tasks > group members */
function countUnderstaffedProjects(
  db: MarinaDB,
  taskManager: TaskManager,
  groupManager: GroupManager,
): number {
  const projects = db.listProjects().filter((p) => p.status === "active" && p.group_id);
  let count = 0;
  for (const p of projects) {
    const openTasks = taskManager.list({ status: "open", groupId: p.group_id! }).length;
    if (openTasks === 0) continue;
    const members = groupManager.getMembers(p.group_id!).length;
    if (openTasks > members) count++;
  }
  return count;
}

/** Get staffing info for active projects */
function getStaffingInfo(
  db: MarinaDB,
  taskManager: TaskManager,
  groupManager: GroupManager,
): { name: string; orchestration: string; openTasks: number; members: number }[] {
  const projects = db.listProjects().filter((p) => p.status === "active" && p.group_id);
  const result: { name: string; orchestration: string; openTasks: number; members: number }[] = [];
  for (const p of projects) {
    const openTasks = taskManager.list({ status: "open", groupId: p.group_id! }).length;
    const members = groupManager.getMembers(p.group_id!).length;
    if (openTasks > 0 || members > 0) {
      result.push({
        name: p.name,
        orchestration: p.orchestration ?? "custom",
        openTasks,
        members,
      });
    }
  }
  return result;
}

function formatAge(timestamp: number): string {
  const ms = Date.now() - timestamp;
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
