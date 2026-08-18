// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import type { MarinaDB } from "../persistence/database";
import type { Entity, EntityId } from "../types";
import type { QuestDef } from "../world/world-definition";
import type { CrewManager } from "./crew-manager";
import type { Task, TaskManager } from "./task-manager";

export type WorkItemKind =
  | "quest_step"
  | "claimed_task"
  | "review_task"
  | "crew_active"
  | "crew_idle"
  | "canvas_intent"
  | "goal_missing"
  | "bounty"
  | "open_task"
  | "social"
  | "channel_join"
  | "memory_seed"
  | "explore"
  | "canvas_contribute"
  | "default";

export interface WorkItem {
  kind: WorkItemKind;
  title: string;
  detail?: string;
  action: string;
  priority: number;
  ref?: string;
}

export interface WorkLoopDeps {
  db?: MarinaDB;
  taskManager?: TaskManager;
  crewManager?: CrewManager;
  quests?: QuestDef[];
  startRoom?: string;
  peers?: Entity[];
}

const INTENT_TIMEOUT_MS = 5 * 60 * 1000;

export function listWorkItems(entity: Entity, deps: WorkLoopDeps, limit = 12): WorkItem[] {
  const items: WorkItem[] = [];
  const db = deps.db;

  const activeQuestId = entity.properties.active_quest as string | undefined;
  if (activeQuestId && deps.quests) {
    const quest = deps.quests.find((q) => q.id === activeQuestId);
    const incomplete = quest?.steps.find((step) => !step.check(entity));
    if (quest && incomplete) {
      items.push({
        kind: "quest_step",
        title: `Quest "${quest.name}"`,
        detail: incomplete.description,
        action: incomplete.hint,
        priority: 100,
        ref: quest.id,
      });
    }
  }

  if (db) {
    for (const claim of db.getActiveClaimsByName(entity.name).slice(0, 5)) {
      items.push({
        kind: "claimed_task",
        title: `Active task #${claim.task_id}: ${claim.title}`,
        detail: claim.progress > 0 ? `${claim.progress}% complete` : undefined,
        action: `task info ${claim.task_id}`,
        priority: claim.status === "submitted" ? 88 : 95,
        ref: `task:${claim.task_id}`,
      });
    }
  }

  if (deps.taskManager) {
    for (const item of reviewItems(entity.id, deps.taskManager)) items.push(item);
  }

  if (deps.crewManager) {
    const crews = deps.crewManager.forAgent(entity.name);
    for (const crew of crews) {
      if (crew.state === "active") {
        items.push({
          kind: "crew_active",
          title: `Crew ${crew.name} is active`,
          detail: crew.goal || undefined,
          action: crew.channelId
            ? `channel history ${crew.channelId}`
            : `crew dispatch ${crew.name} ${crew.goal || "next step"}`,
          priority: 90,
          ref: `crew:${crew.id}`,
        });
      } else if (crew.state === "assembling") {
        items.push({
          kind: "crew_idle",
          title: `Crew ${crew.name} is assembled but idle`,
          detail: crew.goal || undefined,
          action: `crew dispatch ${crew.name} ${crew.goal || "begin"}`,
          priority: 86,
          ref: `crew:${crew.id}`,
        });
      }
    }
  }

  if (db) {
    for (const intent of db
      .listCanvasIntents({
        statuses: ["pending"],
        limit: 5,
        expireActiveMs: INTENT_TIMEOUT_MS,
      })
      .filter((intent) => intent.creatorName !== entity.name)) {
      items.push({
        kind: "canvas_intent",
        title: `Pending canvas intent on ${intent.canvasName}`,
        detail: intent.intent.prompt,
        action: `canvas intent claim ${intent.nodeId.slice(0, 8)} or canvas intent list`,
        priority: 85,
        ref: `canvas_intent:${intent.nodeId}`,
      });
    }
  }

  if (db && !db.getCoreMemory(entity.name, "goal")) {
    items.push({
      kind: "goal_missing",
      title: "No goal set",
      action: "memory set goal <what you want to accomplish>",
      priority: 70,
    });
  }

  if (deps.taskManager) {
    const open = deps.taskManager.list({ status: "open", orderByStanding: true, limit: 10 });
    for (const task of open.slice(0, 5)) {
      items.push(taskToWorkItem(task, task.validationMode === "bounty" ? "bounty" : "open_task"));
    }
  }

  if (db) {
    const notes = db.getNotesByEntity(entity.name, 1);
    if (notes.length === 0) {
      items.push({
        kind: "memory_seed",
        title: "No observations recorded yet",
        action: "note <what you see> importance 5 type observation",
        priority: 45,
      });
    } else {
      const commands = db.getActivityByType(entity.name, "command", 50);
      if (!commands.some((c) => c.key === "recall")) {
        items.push({
          kind: "memory_seed",
          title: "You have notes but have not searched them",
          action: "recall <topic>",
          priority: 42,
        });
      }
    }
  }

  if (deps.startRoom && entity.room === deps.startRoom && !entity.properties.quest_move) {
    items.push({
      kind: "explore",
      title: "You have not explored yet",
      action: "north",
      priority: 40,
    });
  }

  const peers = (deps.peers ?? []).filter((peer) => peer.id !== entity.id);
  if (peers.length > 0) {
    const peer = peers[0]!;
    items.push({
      kind: "social",
      title: `You are not alone: ${peers.map((p) => p.name).join(", ")}`,
      action: `tell ${peer.name} what are you working on?`,
      priority: 38,
    });
  }

  if (db && db.getEntityChannels(entity.id).length === 0) {
    items.push({
      kind: "channel_join",
      title: "Not in any channels",
      action: "channel join general",
      priority: 34,
    });
  }

  if (db) {
    const feedCanvas = db.getCanvasByName("feed");
    if (feedCanvas) {
      const hasPublished = db
        .getNodesByCanvas(feedCanvas.id)
        .some((node) => node.creator_name === entity.name);
      if (!hasPublished) {
        items.push({
          kind: "canvas_contribute",
          title: "Canvas has activity but you have not contributed",
          action: "canvas list",
          priority: 25,
        });
      }
    }
  }

  items.push({
    kind: "default",
    title: "Explore, observe, communicate, remember",
    action: "look",
    priority: 0,
  });

  return items.sort((a, b) => b.priority - a.priority).slice(0, limit);
}

export function nextWorkItem(entity: Entity, deps: WorkLoopDeps): WorkItem {
  return listWorkItems(entity, deps, 1)[0]!;
}

function reviewItems(entityId: EntityId, tasks: TaskManager): WorkItem[] {
  const items: WorkItem[] = [];
  for (const task of tasks.list({ limit: 100 })) {
    if (task.creatorId !== entityId) continue;
    const submitted = tasks.getClaims(task.id).filter((claim) => claim.status === "submitted");
    for (const claim of submitted) {
      items.push({
        kind: "review_task",
        title: `${claim.entityName} submitted task #${task.id}: ${task.title}`,
        action: `task info ${task.id}`,
        priority: 92,
        ref: `task:${task.id}`,
      });
    }
  }
  return items;
}

function taskToWorkItem(task: Task, kind: "bounty" | "open_task"): WorkItem {
  const standing = task.standing > 0 ? ` !${task.standing}` : "";
  return {
    kind,
    title: `${kind === "bounty" ? "Bounty" : "Open task"} #${task.id}: ${task.title}`,
    detail: kind === "bounty" ? `standing${standing}` : undefined,
    action: `task claim ${task.id}`,
    priority: kind === "bounty" ? 60 + Math.min(task.standing, 20) : 50 + task.priority,
    ref: `task:${task.id}`,
  };
}
