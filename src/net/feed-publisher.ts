// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { recordChronicleCitation } from "../agent/standing";
import type { MarinaDB } from "../persistence/database";
import type { EngineEvent, EntityId } from "../types";
import type { CanvasBroadcaster } from "./canvas-ws";

const FEED_CANVAS_NAME = "feed";
/** Max nodes kept on the feed canvas. Older nodes are trimmed on insert. */
const FEED_CANVAS_MAX_NODES = 500;
/** Trim every Nth insert (amortizes the DELETE cost). */
const FEED_TRIM_INTERVAL = 20;

interface FeedPublisherDeps {
  db: MarinaDB;
  resolveEntity: (id: EntityId) => string | undefined;
  /**
   * Reverse lookup: participant name → entity id. Used to flow `chronicled`
   * standing to participants of engine-emitted chronicle entries. Optional —
   * without it, chronicle entries are still recorded; standing credit just
   * doesn't flow (the cost of being unable to resolve is silence, not
   * failure).
   */
  resolveEntityIdByName?: (name: string) => string | undefined;
  broadcaster?: CanvasBroadcaster;
  /**
   * Re-broadcast an engine event through the dashboard WS. Used both for
   * `feed_event` publication and for calibration follow-ups (note_created /
   * note_link_created) that close the forecast→outcome loop.
   */
  emitEvent?: (event: EngineEvent) => void;
}

/**
 * Listens to engine events and auto-publishes canvas nodes to the "feed" canvas.
 * This is the engine → canvas direction: board posts, pool notes, task updates,
 * channel messages, and other activity become canvas nodes on the feed.
 * Also persists a structured feed_event row + emits a live feed_event so the
 * dashboard timeline stays in sync.
 */
export class FeedPublisher {
  private db: MarinaDB;
  private resolveEntity: (id: EntityId) => string | undefined;
  private resolveEntityIdByName?: (name: string) => string | undefined;
  private broadcaster?: CanvasBroadcaster;
  private emitEvent?: (event: EngineEvent) => void;
  private insertsSinceTrim = 0;

  constructor(deps: FeedPublisherDeps) {
    this.db = deps.db;
    this.resolveEntity = deps.resolveEntity;
    this.resolveEntityIdByName = deps.resolveEntityIdByName;
    this.broadcaster = deps.broadcaster;
    this.emitEvent = deps.emitEvent;

    // Clean up any bloat carried over from before the cap existed.
    const existing = this.db.getCanvasByName(FEED_CANVAS_NAME);
    if (existing) this.db.trimCanvasNodes(existing.id, FEED_CANVAS_MAX_NODES);
  }

  /**
   * Create a node on the feed canvas and periodically trim the canvas back
   * to FEED_CANVAS_MAX_NODES. The feed is a write-only firehose — without
   * this, it would grow unbounded and eventually hang any client that tries
   * to load it.
   */
  private createFeedCanvasNode(params: {
    canvasId: string;
    type: string;
    data: Record<string, unknown>;
    creatorName: string;
  }): string {
    const nodeId = crypto.randomUUID();
    this.db.createNode({
      id: nodeId,
      canvasId: params.canvasId,
      type: params.type,
      data: params.data,
      creatorName: params.creatorName,
    });
    if (++this.insertsSinceTrim >= FEED_TRIM_INTERVAL) {
      this.insertsSinceTrim = 0;
      this.db.trimCanvasNodes(params.canvasId, FEED_CANVAS_MAX_NODES);
    }
    return nodeId;
  }

  /** Insert a feed_event row and broadcast the matching engine event. Returns the new row id. */
  private recordFeedEvent(params: {
    kind: string;
    entity?: string;
    ref?: string;
    summary: string;
    payload?: Record<string, unknown>;
  }): number {
    const id = this.db.insertFeedEvent({
      kind: params.kind,
      entity: params.entity,
      ref: params.ref,
      summary: params.summary,
      payload: params.payload,
    });
    this.emitEvent?.({
      type: "feed_event",
      kind: params.kind,
      entity: params.entity as EntityId | undefined,
      ref: params.ref,
      summary: params.summary,
      payload: params.payload,
      timestamp: Date.now(),
    });
    return id;
  }

  /**
   * Append a chronicle event entry. Pass 1 chronicles a small set of civic events:
   * task_approved, crew_created/completed/dissolved, market_consensus, rank_change.
   * See docs/chronicle.md for what does (and does not) belong here.
   *
   * `refs` should include the originating feed_event id and the domain ref so
   * the Chronicler agent (pass 3) can reconstruct context without re-querying.
   */
  private recordChronicleEvent(params: {
    source: string;
    title: string;
    body?: string;
    participants?: string[];
    refs?: string[];
  }): void {
    const id = this.db.appendChronicle({
      kind: "event",
      source: params.source,
      title: params.title,
      body: params.body,
      participants: params.participants,
      refs: params.refs,
    });
    // Flow `chronicled` standing to every resolvable participant. Idempotent
    // via ref=chronicle:<id> so re-emitting the same event is a no-op.
    // Skipped silently when no name resolver is available.
    if (this.resolveEntityIdByName && params.participants && params.participants.length > 0) {
      recordChronicleCitation(
        this.db,
        { id, kind: "event", participants: params.participants },
        this.resolveEntityIdByName,
      );
    }
  }

  /** Handle an engine event, publishing relevant ones to the feed canvas. */
  handleEvent(event: EngineEvent): void {
    switch (event.type) {
      case "task_claimed":
      case "task_submitted":
      case "task_approved":
      case "task_rejected":
      case "task_released":
        this.publishTaskEvent(event);
        break;
      case "board_post":
        this.publishBoardPost(event);
        break;
      case "pool_note":
        this.publishPoolNote(event);
        break;
      case "channel_message":
        this.publishChannelMessage(event);
        break;
      case "market_position":
        this.publishMarketPosition(event);
        break;
      case "market_consensus":
        this.publishMarketConsensus(event);
        break;
      case "canvas_intent":
        this.publishCanvasIntent(event);
        break;
      case "note_created":
        this.publishNoteCreated(event);
        break;
      case "note_link_created":
        this.publishNoteLinkCreated(event);
        break;
      case "rank_change":
        this.publishRankChange(event);
        break;
      case "crew_created":
        this.publishCrewCreated(event);
        break;
      case "crew_completed":
        this.publishCrewCompleted(event);
        break;
      case "crew_dissolved":
        this.publishCrewDissolved(event);
        break;
      case "model_request_lifecycle":
        this.publishModelRequestLifecycle(event);
        break;
      default:
        break;
    }
  }

  private publishModelRequestLifecycle(
    event: EngineEvent & { type: "model_request_lifecycle" },
  ): void {
    const target = event.target ? ` → ${event.target}` : "";
    const duration = event.durationMs === undefined ? "" : ` in ${event.durationMs}ms`;
    const summaries: Record<typeof event.phase, string> = {
      received: `Request received for ${event.model}`,
      routed: `Request routed${target}`,
      fast_path: `Verified fast path selected for ${event.model}`,
      completed: `Response completed${target}${duration}`,
      failed: `Request failed${target}${duration}${event.detail ? ` — ${event.detail}` : ""}`,
    };
    this.recordFeedEvent({
      kind: `model_request_${event.phase}`,
      entity: event.target,
      ref: `request:${event.requestId}`,
      summary: summaries[event.phase],
      payload: {
        requestId: event.requestId,
        model: event.model,
        phase: event.phase,
        target: event.target,
        durationMs: event.durationMs,
      },
    });
  }

  private publishRankChange(event: EngineEvent & { type: "rank_change" }): void {
    // Rank changes are a load-bearing signal in Marina — they mark
    // competence progression (or regression). Surface them in the feed
    // so other agents and dashboards notice.
    const feedId = this.recordFeedEvent({
      kind: "rank_change",
      entity: event.name,
      ref: `rank:${event.newRank}`,
      summary: `${event.name} ${event.direction} — rank ${event.oldRank} → ${event.newRank}`,
      payload: {
        oldRank: event.oldRank,
        newRank: event.newRank,
        direction: event.direction,
      },
    });
    const verb = event.direction === "promoted" ? "rose" : "fell";
    this.recordChronicleEvent({
      source: "rank_change",
      title: `${event.name} ${verb} to rank ${event.newRank}`,
      body: `${event.name}'s civic standing crossed a threshold: rank ${event.oldRank} → ${event.newRank} (${event.direction}).`,
      participants: [event.name],
      refs: [`feed:${feedId}`, `rank:${event.newRank}`],
    });
  }

  // ─── Crew lifecycle ──────────────────────────────────────────────────────
  //
  // Only lifecycle bookends land on the feed canvas (created / completed /
  // dissolved) — the in-between events (member joins, stage completions,
  // artifact deposits, stalls) are higher-frequency and stay in the
  // dashboard activity feed only. The canvas is the durable, browsable
  // record; the feed is the realtime stream.

  private publishCrewCreated(event: EngineEvent & { type: "crew_created" }): void {
    const canvas = this.ensureFeedCanvas();
    if (!canvas) return;

    const ownerName = this.resolveEntity(event.owner) ?? event.owner;
    const nodeId = this.createFeedCanvasNode({
      canvasId: canvas.id,
      type: "text",
      data: {
        ref: `crew:${event.crew}`,
        crewId: event.crew,
        crewName: event.name,
        formation: event.formation,
        lifetime: event.lifetime,
        owner: ownerName,
        feedType: "crew_created",
      },
      creatorName: ownerName,
    });

    this.broadcast({ type: "node_added", canvasId: canvas.id, node: { id: nodeId } });
    const feedId = this.recordFeedEvent({
      kind: "crew_created",
      entity: ownerName,
      ref: `crew:${event.crew}`,
      summary: `${ownerName} formed crew "${event.name}" (${event.formation}/${event.lifetime})`,
      payload: {
        crewId: event.crew,
        crewName: event.name,
        formation: event.formation,
        lifetime: event.lifetime,
      },
    });
    this.recordChronicleEvent({
      source: "crew_created",
      title: `${ownerName} formed crew "${event.name}"`,
      body: `Formation: ${event.formation}. Lifetime: ${event.lifetime}.`,
      participants: [ownerName],
      refs: [`feed:${feedId}`, `crew:${event.crew}`],
    });
  }

  private publishCrewCompleted(event: EngineEvent & { type: "crew_completed" }): void {
    const canvas = this.ensureFeedCanvas();
    if (!canvas) return;

    const nodeId = this.createFeedCanvasNode({
      canvasId: canvas.id,
      type: "text",
      data: {
        ref: `crew:${event.crew}:completed`,
        crewId: event.crew,
        resultNoteId: event.resultNoteId,
        feedType: "crew_completed",
      },
      creatorName: "system",
    });

    this.broadcast({ type: "node_added", canvasId: canvas.id, node: { id: nodeId } });
    const feedId = this.recordFeedEvent({
      kind: "crew_completed",
      ref: `crew:${event.crew}`,
      summary: `Crew "${event.crew}" completed${event.resultNoteId ? ` (note #${event.resultNoteId})` : ""}`,
      payload: { crewId: event.crew, resultNoteId: event.resultNoteId },
    });
    const refs = [`feed:${feedId}`, `crew:${event.crew}`];
    if (event.resultNoteId) refs.push(`note:${event.resultNoteId}`);
    this.recordChronicleEvent({
      source: "crew_completed",
      title: `Crew "${event.crew}" completed its work`,
      body: event.resultNoteId
        ? `Result recorded in note #${event.resultNoteId}.`
        : "Crew dissolved on completion without a result note.",
      refs,
    });
  }

  private publishCrewDissolved(event: EngineEvent & { type: "crew_dissolved" }): void {
    const canvas = this.ensureFeedCanvas();
    if (!canvas) return;

    const nodeId = this.createFeedCanvasNode({
      canvasId: canvas.id,
      type: "text",
      data: {
        ref: `crew:${event.crew}:dissolved`,
        crewId: event.crew,
        reason: event.reason,
        feedType: "crew_dissolved",
      },
      creatorName: "system",
    });

    this.broadcast({ type: "node_added", canvasId: canvas.id, node: { id: nodeId } });
    const feedId = this.recordFeedEvent({
      kind: "crew_dissolved",
      ref: `crew:${event.crew}`,
      summary: `Crew "${event.crew}" dissolved: ${event.reason}`,
      payload: { crewId: event.crew, reason: event.reason },
    });
    this.recordChronicleEvent({
      source: "crew_dissolved",
      title: `Crew "${event.crew}" dissolved`,
      body: `Reason: ${event.reason}.`,
      refs: [`feed:${feedId}`, `crew:${event.crew}`],
    });
  }

  private publishBoardPost(event: EngineEvent & { type: "board_post" }): void {
    const canvas = this.ensureFeedCanvas();
    if (!canvas) return;

    const entityName = this.resolveEntity(event.entity) ?? event.entity;
    const nodeId = this.createFeedCanvasNode({
      canvasId: canvas.id,
      type: "text",
      data: {
        ref: `board_post:${event.postId}`,
        board: event.boardName,
        title: event.title,
        body: event.body,
        author: entityName,
        feedType: "board_post",
      },
      creatorName: entityName,
    });

    this.broadcast({ type: "node_added", canvasId: canvas.id, node: { id: nodeId } });
    this.recordFeedEvent({
      kind: "board_post",
      entity: entityName,
      ref: `board_post:${event.postId}`,
      summary: `${entityName} posted "${event.title}" on ${event.boardName}`,
      payload: { boardName: event.boardName, title: event.title, postId: event.postId },
    });
  }

  private publishPoolNote(event: EngineEvent & { type: "pool_note" }): void {
    const canvas = this.ensureFeedCanvas();
    if (!canvas) return;

    const entityName = this.resolveEntity(event.entity) ?? event.entity;
    const nodeId = this.createFeedCanvasNode({
      canvasId: canvas.id,
      type: "text",
      data: {
        ref: `note:${event.noteId}`,
        pool: event.poolName,
        body: event.content,
        importance: event.importance,
        author: entityName,
        feedType: "pool_note",
      },
      creatorName: entityName,
    });

    this.broadcast({ type: "node_added", canvasId: canvas.id, node: { id: nodeId } });
    this.recordFeedEvent({
      kind: "pool_note",
      entity: entityName,
      ref: `note:${event.noteId}`,
      summary: `${entityName} added to ${event.poolName}: ${event.content.slice(0, 80)}`,
      payload: {
        poolName: event.poolName,
        noteId: event.noteId,
        importance: event.importance,
      },
    });
  }

  private publishChannelMessage(event: EngineEvent & { type: "channel_message" }): void {
    const canvas = this.ensureFeedCanvas();
    if (!canvas) return;

    const entityName = this.resolveEntity(event.entity) ?? event.entity;
    const nodeId = this.createFeedCanvasNode({
      canvasId: canvas.id,
      type: "text",
      data: {
        ref: `channel_msg:${event.messageId}`,
        channel: event.channelName,
        body: event.content,
        author: entityName,
        feedType: "channel_message",
      },
      creatorName: entityName,
    });

    this.broadcast({ type: "node_added", canvasId: canvas.id, node: { id: nodeId } });
    this.recordFeedEvent({
      kind: "channel_message",
      entity: entityName,
      ref: `channel_msg:${event.messageId}`,
      summary: `${entityName} → #${event.channelName}: ${event.content.slice(0, 80)}`,
      payload: { channelName: event.channelName, messageId: event.messageId },
    });
  }

  private publishTaskEvent(event: {
    type: string;
    entity: EntityId;
    taskId: number;
    timestamp: number;
  }): void {
    const canvas = this.ensureFeedCanvas();
    if (!canvas) return;

    const entityName = this.resolveEntity(event.entity) ?? event.entity;
    const task = this.db.getTask(event.taskId);
    const action = event.type.replace("task_", "");

    const nodeId = this.createFeedCanvasNode({
      canvasId: canvas.id,
      type: "text",
      data: {
        ref: `task:${event.taskId}`,
        title: task?.title ?? `Task #${event.taskId}`,
        action,
        author: entityName,
        feedType: "task_event",
      },
      creatorName: entityName,
    });

    this.broadcast({ type: "node_added", canvasId: canvas.id, node: { id: nodeId } });
    const feedId = this.recordFeedEvent({
      kind: event.type,
      entity: entityName,
      ref: `task:${event.taskId}`,
      summary: `${entityName} ${action} task #${event.taskId}${task?.title ? ` "${task.title}"` : ""}`,
      payload: { taskId: event.taskId, action },
    });
    // Only task_approved is chronicle-worthy — claims and submissions are intent
    // events, not outcomes. We capture outcomes; the rest stays in the feed.
    if (event.type === "task_approved") {
      this.recordChronicleEvent({
        source: "task_approved",
        title: task?.title
          ? `Task #${event.taskId} "${task.title}" was completed by ${entityName}`
          : `Task #${event.taskId} was completed by ${entityName}`,
        body: task?.title
          ? `${entityName}'s submission was approved.`
          : `Submission approved for task #${event.taskId}.`,
        participants: [entityName],
        refs: [`feed:${feedId}`, `task:${event.taskId}`],
      });
    }
  }

  private publishMarketPosition(event: EngineEvent & { type: "market_position" }): void {
    const entityName = this.resolveEntity(event.entity) ?? event.entity;

    // Persist position to DB
    const market = this.db.getMarketByRoom(event.room);
    if (market) {
      this.db.upsertPosition(
        market.id,
        entityName,
        event.direction,
        event.confidence,
        event.reasoning,
      );
    }

    // Publish to feed canvas
    const canvas = this.ensureFeedCanvas();
    if (!canvas) return;

    const nodeId = this.createFeedCanvasNode({
      canvasId: canvas.id,
      type: "text",
      data: {
        ref: `market_position:${event.room}`,
        market: event.room,
        question: event.question,
        direction: event.direction,
        confidence: event.confidence,
        reasoning: event.reasoning,
        updated: event.updated,
        author: entityName,
        feedType: "market_position",
      },
      creatorName: entityName,
    });

    this.broadcast({ type: "node_added", canvasId: canvas.id, node: { id: nodeId } });
    this.recordFeedEvent({
      kind: "market_position",
      entity: entityName,
      ref: `market_position:${event.room}`,
      summary: `${entityName} ${event.updated ? "updated" : "took"} ${event.direction.toUpperCase()} ${event.confidence}% on ${event.question.slice(0, 60)}`,
      payload: {
        room: event.room,
        direction: event.direction,
        confidence: event.confidence,
        question: event.question,
      },
    });
  }

  private publishMarketConsensus(event: EngineEvent & { type: "market_consensus" }): void {
    const canvas = this.ensureFeedCanvas();
    if (!canvas) return;

    const entityName = this.resolveEntity(event.entity) ?? event.entity;
    const nodeId = this.createFeedCanvasNode({
      canvasId: canvas.id,
      type: "text",
      data: {
        ref: `market_consensus:${event.room}`,
        market: event.room,
        question: event.question,
        yesPercent: event.yesPercent,
        noPercent: event.noPercent,
        participants: event.participants,
        agreement: event.agreement,
        author: entityName,
        feedType: "market_consensus",
      },
      creatorName: entityName,
    });

    this.broadcast({ type: "node_added", canvasId: canvas.id, node: { id: nodeId } });
    const feedId = this.recordFeedEvent({
      kind: "market_consensus",
      entity: entityName,
      ref: `market_consensus:${event.room}`,
      summary: `Consensus on ${event.question.slice(0, 60)}: YES ${event.yesPercent}% (${event.participants} participants)`,
      payload: {
        room: event.room,
        yesPercent: event.yesPercent,
        noPercent: event.noPercent,
        participants: event.participants,
      },
    });
    this.recordChronicleEvent({
      source: "market_consensus",
      title: `Consensus formed on "${event.question.slice(0, 80)}"`,
      body: `${event.participants} participant${event.participants === 1 ? "" : "s"} converged: YES ${event.yesPercent}%, NO ${event.noPercent}%. Agreement: ${event.agreement}.`,
      refs: [`feed:${feedId}`, `market:${event.room}`],
    });
  }

  private publishCanvasIntent(event: EngineEvent & { type: "canvas_intent" }): void {
    const canvas = this.ensureFeedCanvas();
    if (!canvas) return;

    const entityName = this.resolveEntity(event.entity) ?? event.entity;
    const actionMap: Record<string, string> = {
      pending: "requested intent",
      active: "claimed intent",
      done: "completed intent",
      failed: "failed intent",
    };
    const action = actionMap[event.status] ?? event.status;
    const prompt = event.prompt.length > 80 ? `${event.prompt.slice(0, 77)}...` : event.prompt;

    const nodeId = this.createFeedCanvasNode({
      canvasId: canvas.id,
      type: "text",
      data: {
        ref: `canvas_intent:${event.nodeId}`,
        action,
        prompt,
        intentStatus: event.status,
        author: entityName,
        feedType: "canvas_intent",
      },
      creatorName: entityName,
    });

    this.broadcast({ type: "node_added", canvasId: canvas.id, node: { id: nodeId } });
    this.recordFeedEvent({
      kind: "canvas_intent",
      entity: entityName,
      ref: `canvas_intent:${event.nodeId}`,
      summary: `${entityName} ${action}: ${prompt}`,
      payload: {
        canvasId: event.canvasId,
        nodeId: event.nodeId,
        intentStatus: event.status,
      },
    });
  }

  private publishNoteCreated(event: EngineEvent & { type: "note_created" }): void {
    // Only surface notes worth looking at in the feed — auto-linked low-importance
    // notes would spam the timeline.
    if (event.importance < 6) return;
    const canvas = this.ensureFeedCanvas();
    if (!canvas) return;

    const entityName = this.resolveEntity(event.entity) ?? event.authorName;
    const nodeId = this.createFeedCanvasNode({
      canvasId: canvas.id,
      type: "text",
      data: {
        ref: `note:${event.noteId}`,
        body: event.content,
        importance: event.importance,
        noteType: event.noteType,
        author: entityName,
        feedType: "note_created",
      },
      creatorName: entityName,
    });

    this.broadcast({ type: "node_added", canvasId: canvas.id, node: { id: nodeId } });
    this.recordFeedEvent({
      kind: "note_created",
      entity: entityName,
      ref: `note:${event.noteId}`,
      summary: `${entityName} noted [${event.noteType}] ${event.content.slice(0, 80)}`,
      payload: {
        noteId: event.noteId,
        importance: event.importance,
        noteType: event.noteType,
      },
    });
  }

  private publishNoteLinkCreated(event: EngineEvent & { type: "note_link_created" }): void {
    // Surface only semantic links (supports, contradicts, supersedes, part_of).
    // Auto-generated related_to links would flood the feed.
    if (event.relationship === "related_to") return;
    const canvas = this.ensureFeedCanvas();
    if (!canvas) return;

    const entityName = this.resolveEntity(event.entity) ?? event.entity;
    const nodeId = this.createFeedCanvasNode({
      canvasId: canvas.id,
      type: "text",
      data: {
        ref: `note_link:${event.sourceId}-${event.targetId}`,
        sourceId: event.sourceId,
        targetId: event.targetId,
        relationship: event.relationship,
        author: entityName,
        feedType: "note_link_created",
      },
      creatorName: entityName,
    });

    this.broadcast({ type: "node_added", canvasId: canvas.id, node: { id: nodeId } });
    this.recordFeedEvent({
      kind: "note_link_created",
      entity: entityName,
      ref: `note_link:${event.sourceId}-${event.targetId}`,
      summary: `${entityName} linked #${event.sourceId} → #${event.targetId} (${event.relationship})`,
      payload: {
        sourceId: event.sourceId,
        targetId: event.targetId,
        relationship: event.relationship,
      },
    });
  }

  private ensureFeedCanvas(): { id: string } | undefined {
    const existing = this.db.getCanvasByName(FEED_CANVAS_NAME);
    if (existing) return existing;

    const id = crypto.randomUUID();
    this.db.createCanvas({
      id,
      name: FEED_CANVAS_NAME,
      description: "Live activity feed",
      scope: "global",
      creatorName: "system",
    });
    return this.db.getCanvas(id);
  }

  private broadcast(event: { type: string; canvasId: string; [k: string]: unknown }): void {
    this.broadcaster?.broadcast(event as import("./canvas-ws").CanvasEvent);
  }
}
