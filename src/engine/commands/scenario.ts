// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { bold, dim, header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";
import type { ConnectorRuntime } from "../connector-runtime";

/**
 * Scenario command — drives the society-of-agents forecasting pipeline.
 *
 * Five subcommands, all single-word imperatives (TTS-friendly):
 *   scenario extract <url>          — fetch a URL into the scenario-graph board for entity extraction
 *   scenario extract board <name>   — re-extract from an existing board post
 *   scenario personas               — request persona drafting from extracted entities
 *   scenario inject <key>=<value>   — inject a counterfactual event into the running scenario
 *   scenario status                 — show scenario state across all four boards
 *   scenario report                 — request the synthesized forecast report
 *
 * Each subcommand composes existing primitives: board posts, tasks, notes,
 * channel broadcasts. No new tables, no new event types. The cognitive
 * heavy-lifting (entity extraction, persona drafting, debate, synthesis) is
 * done by the scenario-conductor agent reading these board posts and tasks
 * during its normal continuation prompt cycle.
 *
 * This is THE primitive the markets/Kalshi/Polymarket frequency-betting
 * stack is built on top of: a calibrated, evidence-linked, agent-society
 * forecast for any prediction market question.
 */

const HELP = `Drive a scenario simulation — extract seed material, draft personas, inject counterfactuals, synthesize forecast.

Usage:
  scenario extract <url>             — fetch URL and post raw text to scenario-graph for entity extraction
  scenario extract board <name>      — re-trigger extraction from an existing scenario-graph post
  scenario personas                  — request persona drafting from extracted entities
  scenario inject <key>=<value>      — inject a counterfactual event into the running scenario
  scenario status                    — show scenario state (entities, personas, events, report)
  scenario report                    — request the synthesized forecast report

Examples:
  scenario extract https://kalshi.com/markets/will-fed-cut-rates
  scenario extract board scenario-graph
  scenario personas
  scenario inject fed_rate=cut
  scenario status
  scenario report

Note: these commands auto-create the boards they use (scenario-graph,
scenario-personas, scenario-events, scenario-report) and the scenario-feed
channel on first use.`;

const SCENARIO_GRAPH_BOARD = "scenario-graph";
const SCENARIO_PERSONAS_BOARD = "scenario-personas";
const SCENARIO_EVENTS_BOARD = "scenario-events";
const SCENARIO_REPORT_BOARD = "scenario-report";
const SCENARIO_FEED_CHANNEL = "scenario-feed";
const SCENARIO_PROJECT_NAME = "Scenario Forecasting";

const MAX_SOURCE_LENGTH = 12_000; // truncate raw seed material

export function scenarioCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  db: MarinaDB;
  connectorRuntime?: ConnectorRuntime;
}): CommandDef {
  return {
    name: "scenario",
    aliases: ["sc"],
    help: HELP,
    handler: async (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase();

      if (!sub || sub === "help") {
        ctx.send(input.entity, HELP);
        return;
      }

      switch (sub) {
        case "extract":
          return handleExtract(ctx, input.entity, entity, tokens.slice(1), deps);
        case "personas":
          return handlePersonas(ctx, input.entity, entity, deps);
        case "inject":
          return handleInject(ctx, input.entity, entity, tokens.slice(1), deps);
        case "status":
          return handleStatus(ctx, input.entity, deps);
        case "report":
          return handleReport(ctx, input.entity, entity, deps);
        default:
          ctx.send(input.entity, `Unknown subcommand: ${sub}\n\n${HELP}`);
      }
    },
  };
}

// ─── Boards (idempotent ensure) ─────────────────────────────────────────────

function ensureBoard(db: MarinaDB, name: string): string {
  const existing = db.getBoardByName(name);
  if (existing) return existing.id;
  const id = `board:${name}`;
  db.createBoard({ id, name, scopeType: "global" });
  return id;
}

function ensureScenarioBoards(db: MarinaDB): {
  graph: string;
  personas: string;
  events: string;
  report: string;
} {
  return {
    graph: ensureBoard(db, SCENARIO_GRAPH_BOARD),
    personas: ensureBoard(db, SCENARIO_PERSONAS_BOARD),
    events: ensureBoard(db, SCENARIO_EVENTS_BOARD),
    report: ensureBoard(db, SCENARIO_REPORT_BOARD),
  };
}

function getScenarioGroupId(db: MarinaDB): string | undefined {
  const project = db.getProjectByName(SCENARIO_PROJECT_NAME);
  return project?.group_id ?? undefined;
}

// ─── extract ────────────────────────────────────────────────────────────────

async function handleExtract(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  tokens: string[],
  deps: {
    db: MarinaDB;
    connectorRuntime?: ConnectorRuntime;
  },
): Promise<void> {
  const { db } = deps;
  const arg = tokens[0];

  if (!arg) {
    ctx.send(eid, "Usage: scenario extract <url> | scenario extract board <name>");
    return;
  }

  const boards = ensureScenarioBoards(db);

  // Mode 1: re-extract from an existing board
  if (arg.toLowerCase() === "board") {
    const boardName = tokens[1] ?? SCENARIO_GRAPH_BOARD;
    const board = db.getBoardByName(boardName);
    if (!board) {
      ctx.send(eid, `Board "${boardName}" not found.`);
      return;
    }
    const posts = db.listBoardPosts(board.id, { limit: 5 });
    const rawPosts = posts.filter((p) => (p.title ?? "").startsWith("RAW:"));
    if (rawPosts.length === 0) {
      ctx.send(
        eid,
        `No raw seed posts found on "${boardName}". Use 'scenario extract <url>' first.`,
      );
      return;
    }
    const target = rawPosts[0]!;
    createExtractionTask(db, entity, target.id, target.title ?? "(untitled)");
    ctx.send(
      eid,
      `${header("Re-extraction queued")}\n${separator()}\n  ${dim("Board:")} ${boardName}\n  ${dim("Post:")} #${target.id} ${target.title ?? ""}\n\n${dim("Conductor will pick up the task and re-extract entities into [entity:] notes.")}`,
    );
    return;
  }

  // Mode 2: fetch a URL
  if (!deps.connectorRuntime) {
    ctx.send(eid, "Web fetch unavailable (no connector runtime).");
    return;
  }

  const url = arg.startsWith("http") ? arg : `https://${arg}`;
  ctx.send(eid, dim(`Fetching ${url}...`));

  const result = await deps.connectorRuntime.httpGet(url, eid);
  if ("error" in result) {
    ctx.send(eid, `Fetch failed: ${result.error}`);
    return;
  }
  if (result.status !== 200) {
    ctx.send(eid, `Fetch failed (HTTP ${result.status}).`);
    return;
  }

  const extracted = extractReadableText(result.body);
  const truncated =
    extracted.text.length > MAX_SOURCE_LENGTH
      ? `${extracted.text.slice(0, MAX_SOURCE_LENGTH)}\n\n... (truncated from ${extracted.text.length} chars)`
      : extracted.text;

  const title = `RAW: ${extracted.title ?? url}`.slice(0, 200);
  const body = `Source: ${url}\n${extracted.title ? `Title: ${extracted.title}\n` : ""}${extracted.wordCount} words\n\n---\n\n${truncated}`;

  const postId = db.createBoardPost({
    boardId: boards.graph,
    authorId: eid,
    authorName: entity.name,
    title,
    body,
    tags: ["seed", "raw"],
  });

  createExtractionTask(db, entity, postId, title);

  ctx.send(
    eid,
    `${header("Seed material posted")}\n${separator()}\n  ${dim("Source:")} ${url}\n  ${dim("Words:")} ${extracted.wordCount}\n  ${dim("Board:")} ${SCENARIO_GRAPH_BOARD} (post #${postId})\n  ${dim("Task:")} created — conductor will extract entities\n\n${dim("Next: 'scenario personas' once entities are written.")}`,
  );
  // Engine fires a board_post event for every createBoardPost — no custom
  // event needed, no core EngineEvent union change required.
}

function createExtractionTask(db: MarinaDB, entity: Entity, postId: number, title: string): number {
  const groupId = getScenarioGroupId(db);
  return db.createTask({
    groupId,
    title: `Extract entities from ${title.slice(0, 60)}`,
    description: `Read board post #${postId} on ${SCENARIO_GRAPH_BOARD} (the raw seed material). For each distinct entity (person, organization, instrument, mechanism, claim, stakeholder), write a note prefixed \`[entity: <name>]\` with their role, stance, and source. Link entities with \`note link <a> <b> related_to|affects|opposes|supports|derived_from\`. The goal is a queryable knowledge graph successors can walk without re-reading the source.`,
    creatorId: entity.id,
    creatorName: entity.name,
    standing: 5,
  });
}

// ─── personas ───────────────────────────────────────────────────────────────

function handlePersonas(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: { db: MarinaDB },
): void {
  const { db } = deps;
  ensureScenarioBoards(db);
  const groupId = getScenarioGroupId(db);

  // Surface how many entities we have
  const entityNotes = db.searchAllNotes("[entity:", 50);
  const entityCount = entityNotes.length;

  const taskId = db.createTask({
    groupId,
    title: "Draft personas from extracted entities",
    description: `Read the [entity:] notes (use 'recall [entity:]' to find them). For each major stakeholder or perspective relevant to the central question, draft a persona post on ${SCENARIO_PERSONAS_BOARD} with: (1) name, (2) stance — bull/bear/neutral/specialist, (3) reasoning prompt that captures their worldview, (4) cited [entity:] notes they care about. Cover the realistic spread (devil's advocate, mainstream, contrarian, expert). After drafting, spawn the personas via 'agent spawn <name>' with role researcher and set their goal to participate in the scenario debate.`,
    creatorId: entity.id,
    creatorName: entity.name,
    standing: 5,
  });

  ctx.send(
    eid,
    `${header("Persona drafting queued")}\n${separator()}\n  ${dim("Entities found:")} ${entityCount}${entityCount === 0 ? dim(" — run 'scenario extract' first to populate") : ""}\n  ${dim("Task:")} #${taskId}\n  ${dim("Board:")} ${SCENARIO_PERSONAS_BOARD}\n\n${dim("Conductor will draft personas and post them for spawning approval.")}`,
  );
}

// ─── inject ─────────────────────────────────────────────────────────────────

function handleInject(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  tokens: string[],
  deps: { db: MarinaDB },
): void {
  const { db } = deps;
  const raw = tokens.join(" ").trim();

  if (!raw) {
    ctx.send(eid, "Usage: scenario inject <key>=<value>  (e.g. 'scenario inject fed_rate=cut')");
    return;
  }

  // Parse key=value, lenient. Allow spaces around =.
  const eq = raw.indexOf("=");
  if (eq <= 0 || eq === raw.length - 1) {
    ctx.send(eid, "Format: <key>=<value>. Example: 'scenario inject fed_rate=cut'");
    return;
  }
  const key = raw.slice(0, eq).trim();
  const value = raw.slice(eq + 1).trim();

  const boards = ensureScenarioBoards(db);
  const timestamp = new Date().toISOString();
  const title = `EVENT: ${key}=${value}`.slice(0, 200);
  const body = `Counterfactual event injected by ${entity.name} at ${timestamp}.\n\n${key}: ${value}\n\nPersonas should react to this as a world fact in their next debate turn. Conductor: incorporate this event into the synthesized report's evidence chain.`;

  const postId = db.createBoardPost({
    boardId: boards.events,
    authorId: eid,
    authorName: entity.name,
    title,
    body,
    tags: ["scenario-event", "counterfactual"],
  });

  // Importance 9 [scenario-event] note so recall surfaces it strongly during debate.
  const noteContent = `[scenario-event] ${key}=${value} (injected ${timestamp})`;
  db.createNote(entity.name, noteContent, undefined, {
    importance: 9,
    noteType: "decision",
  });

  // Broadcast on the scenario-feed channel so listening agents see immediately.
  const channel = db.getChannelByName(SCENARIO_FEED_CHANNEL);
  if (channel) {
    db.addChannelMessage(channel.id, eid, entity.name, `[event] ${key}=${value}`);
  }

  ctx.send(
    eid,
    `${header("Event injected")}\n${separator()}\n  ${dim("Key:")} ${bold(key)}\n  ${dim("Value:")} ${bold(value)}\n  ${dim("Board:")} ${SCENARIO_EVENTS_BOARD} (post #${postId})\n  ${dim("Channel:")} ${SCENARIO_FEED_CHANNEL}\n\n${dim("Personas will see this on next tick.")}`,
  );
  // board_post + channel_message events fire automatically via createBoardPost
  // and addChannelMessage — successors learn about events through normal feed.
}

// ─── status ─────────────────────────────────────────────────────────────────

function handleStatus(ctx: RoomContext, eid: EntityId, deps: { db: MarinaDB }): void {
  const { db } = deps;
  const boards = ensureScenarioBoards(db);

  const graph = db.listBoardPosts(boards.graph, { limit: 100 });
  const personas = db.listBoardPosts(boards.personas, { limit: 100 });
  const events = db.listBoardPosts(boards.events, { limit: 100 });
  const reports = db.listBoardPosts(boards.report, { limit: 100 });

  const rawSeeds = graph.filter((p) => (p.title ?? "").startsWith("RAW:")).length;
  const entityNotes = db.searchAllNotes("[entity:", 200).length;
  const project = db.getProjectByName(SCENARIO_PROJECT_NAME);

  const lines: string[] = [
    header("Scenario status"),
    separator(),
    `  ${dim("Project:")}     ${project ? project.name : dim("(no scenario project seeded)")}`,
    `  ${dim("Seed posts:")}  ${rawSeeds} raw / ${graph.length} total on ${SCENARIO_GRAPH_BOARD}`,
    `  ${dim("Entities:")}    ${entityNotes} [entity:] notes in the graph`,
    `  ${dim("Personas:")}    ${personas.length} drafts on ${SCENARIO_PERSONAS_BOARD}`,
    `  ${dim("Events:")}      ${events.length} counterfactual events on ${SCENARIO_EVENTS_BOARD}`,
    `  ${dim("Reports:")}     ${reports.length} synthesized reports on ${SCENARIO_REPORT_BOARD}`,
    "",
  ];

  if (rawSeeds === 0) {
    lines.push(dim("  Next: 'scenario extract <url>' to seed the graph."));
  } else if (entityNotes === 0) {
    lines.push(
      dim("  Next: conductor extracting entities — wait or 'scenario extract board' to retrigger."),
    );
  } else if (personas.length === 0) {
    lines.push(dim("  Next: 'scenario personas' to draft stakeholders."));
  } else if (reports.length === 0) {
    lines.push(dim("  Next: 'scenario report' to synthesize the forecast."));
  } else {
    const last = reports[0]!;
    lines.push(dim(`  Latest report: #${last.id} ${last.title ?? ""}`));
  }

  ctx.send(eid, lines.join("\n"));
}

// ─── report ─────────────────────────────────────────────────────────────────

function handleReport(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: { db: MarinaDB },
): void {
  const { db } = deps;
  ensureScenarioBoards(db);
  const groupId = getScenarioGroupId(db);

  const taskId = db.createTask({
    groupId,
    title: "Synthesize scenario forecast report",
    description: `Recall broadly across the scenario — \`[entity:]\` notes, \`[scenario-event]\` notes, persona positions, debate summaries. Write the synthesized forecast to the ${SCENARIO_REPORT_BOARD} board. The report MUST include: (1) the central question, (2) calibrated probability or outcome distribution, (3) key drivers with cited evidence, (4) what new evidence would change the answer, (5) confidence level. Link the report to every cited source note via \`note link <report_id> <source_id> derived_from\` so the evidence chain is auditable. Do NOT round to 50% to hedge — calibration is the deliverable.`,
    creatorId: entity.id,
    creatorName: entity.name,
    standing: 7,
    priority: 8,
  });

  ctx.send(
    eid,
    `${header("Report synthesis queued")}\n${separator()}\n  ${dim("Task:")} #${taskId}\n  ${dim("Board:")} ${SCENARIO_REPORT_BOARD}\n\n${dim("Conductor will recall, synthesize, and write the calibrated forecast.")}`,
  );
}

// ─── HTML readability extraction ────────────────────────────────────────────
// (mirrors the implementation in commands/web.ts — kept inline so this file
// has no cross-command dependency. If a third caller appears, factor out.)

interface ExtractedContent {
  text: string;
  title?: string;
  wordCount: number;
}

function extractReadableText(html: string): ExtractedContent {
  let text = html;

  const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch?.[1] ? titleMatch[1].replace(/\s+/g, " ").trim() : undefined;

  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, "");
  text = text.replace(/<header[\s\S]*?<\/header>/gi, "\n");
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  const articleMatch = text.match(/<(?:article|main)[^>]*>([\s\S]*?)<\/(?:article|main)>/i);
  if (articleMatch?.[1] && articleMatch[1].length > 200) {
    text = articleMatch[1];
  }

  text = text.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, "\n\n## $1\n\n");
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1");
  text = text.replace(/<\/?(p|div|br|tr|blockquote|section|article)[^>]*>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = decodeEntities(text);
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n[ \t]+/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  return { text, title, wordCount };
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number.parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(Number.parseInt(h, 16)));
}
