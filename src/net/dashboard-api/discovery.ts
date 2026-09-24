// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { getStanding } from "../../agent/standing";
import { listWorkItems } from "../../coordination/work-loop";
import { categorizeCommand } from "../../engine/commands/help";
import type {
  CommandCatalogEntry,
  DiscoveryResult,
  EntityPreview,
  QuestProgress,
} from "../discovery-types";
import { authorizeEntityRead, type DashboardRouteContext, json } from "./shared";

/** Read-only discovery. Execution still goes through the ordinary command router. */
export async function handleDiscoveryRoutes(
  ctx: DashboardRouteContext,
): Promise<Response | undefined> {
  const { engine, db, memory, callerId, method, url } = ctx;
  if (method !== "GET") return undefined;
  if (url.pathname === "/api/command-catalog") {
    const catalog: CommandCatalogEntry[] = engine.commands.allBuiltins().map((cmd) => ({
      name: cmd.name,
      aliases: cmd.aliases ?? [],
      category: categorizeCommand(cmd),
      help: cmd.help,
      minRank: cmd.minRank ?? 0,
      gate: cmd.gate,
    }));
    return json(catalog);
  }
  const questMatch = url.pathname.match(/^\/api\/entities\/([^/]+)\/quests$/);
  const previewMatch = url.pathname.match(/^\/api\/entities\/([^/]+)\/preview$/);
  if (previewMatch) {
    const name = decodeURIComponent(previewMatch[1]!);
    const entity = engine.findEntityGlobal(name);
    if (!entity) return json({ error: "Entity not found" }, 404);
    const privateVisible = authorizeEntityRead(engine, db, callerId, name) === null;
    const work =
      privateVisible && db
        ? listWorkItems(entity, {
            db,
            taskManager: engine.taskManager,
            crewManager: engine.crewManager,
            quests: engine.world?.quests ?? [],
            startRoom: engine.config.startRoom,
            peers: engine.entities.inRoom(entity.room),
          })
        : [];
    const preview: EntityPreview = {
      name: entity.name,
      rank: entity.properties.rank ?? 0,
      standing: db ? Math.round(getStanding(db, entity.id) * 10) / 10 : null,
      inventory: privateVisible
        ? entity.inventory.map((id) => engine.entities.get(id)?.name ?? id)
        : null,
      task: work.find((item) => item.kind === "claimed_task")?.title ?? null,
      crew:
        work.find((item) => item.kind === "crew_active" || item.kind === "crew_idle")?.title ??
        null,
      privateVisible,
    };
    return json(preview);
  }
  if (questMatch) {
    const name = decodeURIComponent(questMatch[1]!);
    const denied = authorizeEntityRead(engine, db, callerId, name);
    if (denied) return denied;
    const entity = engine.findEntityGlobal(name);
    if (!entity) return json({ error: "Entity not found" }, 404);
    const completed = entity.properties.completed_quests ?? [];
    const quests: QuestProgress[] = (engine.world?.quests ?? []).map((quest) => ({
      id: quest.id,
      name: quest.name,
      active: entity.properties.active_quest === quest.id,
      completed: completed.includes(quest.id),
      steps: quest.steps.map((step) => ({
        id: step.id,
        description: step.description,
        hint: step.hint,
        done: completed.includes(quest.id) || step.check(entity),
      })),
    }));
    return json(quests);
  }
  if (url.pathname !== "/api/search") return undefined;
  const query = (url.searchParams.get("q") ?? "").trim();
  if (query.length > 200) return json({ error: "Search is limited to 200 characters" }, 400);
  if (query.length < 2) return json([]);
  const matches = (value: string) => value.toLowerCase().includes(query.toLowerCase());
  const results: DiscoveryResult[] = [];
  for (const entity of engine.entities
    .all()
    .filter((e) => matches(e.name))
    .slice(0, 10)) {
    results.push({
      kind: "entity",
      id: entity.name,
      title: entity.name,
      detail: `${entity.kind} · ${entity.room}`,
    });
  }
  for (const room of engine.rooms
    .all()
    .filter((r) => matches(`${r.id} ${r.module.short}`))
    .slice(0, 10)) {
    results.push({ kind: "room", id: room.id, title: room.module.short, detail: room.id });
  }
  if (db) {
    // Reuse task FTS; never forward the unscoped message/pool hits from globalSearch.
    for (const hit of db.globalSearch(query).filter((hit) => hit.type === "task")) {
      results.push({
        kind: "task",
        id: hit.id,
        title: hit.title,
        detail: hit.context,
        command: `task info ${hit.id}`,
      });
    }
    for (const note of db
      .searchAllNotes(query, 200)
      .filter(
        (note) => !db.isServiceMemoryNote(note.id) && note.tier !== "process" && memory.read(note),
      )
      .slice(0, 10)) {
      results.push({
        kind: "note",
        id: String(note.id),
        title: note.content.slice(0, 160),
        detail: `Note #${note.id} · ${note.entity_name}`,
        command: `note explain ${note.id}`,
      });
    }
    for (const board of db
      .getAllBoards()
      .filter((b) => matches(b.name))
      .slice(0, 10)) {
      results.push({
        kind: "board",
        id: board.name,
        title: board.name,
        detail: "Board",
        command: `board read ${board.name}`,
      });
    }
    for (const channel of db
      .getAllChannels()
      .filter((c) => matches(c.name))
      .slice(0, 10)) {
      results.push({
        kind: "channel",
        id: channel.name,
        title: channel.name,
        detail: "Channel",
        command: `channel history ${channel.name}`,
      });
    }
  }
  return json(results);
}
