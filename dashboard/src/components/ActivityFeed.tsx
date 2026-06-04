import { ScrollText } from "lucide-react";
import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { parseMessage } from "../hooks/use-entity-activity";
import { useKeyboardNav } from "../hooks/use-keyboard-nav";
import { useWorldState } from "../hooks/use-world-state";
import type { DashboardEvent } from "../lib/types";
import { EventLine } from "./EventLine";
import { GlassPanel } from "./GlassPanel";

export function ActivityFeed({ backContent }: { backContent?: React.ReactNode }) {
  const events = useWorldState((s) => s.eventFeed);
  const entities = useWorldState((s) => s.entities);
  const selectEntity = useWorldState((s) => s.selectEntity);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep scroll pinned to the top so the newest event is always visible.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, []);

  const onActivate = useCallback(
    (index: number) => {
      const event = events[index];
      if (!event?.entity) return;
      const name = entities.find((e) => e.id === event.entity)?.name;
      if (name) selectEntity(name);
    },
    [events, entities, selectEntity],
  );

  const { highlightedIndex, onKeyDown, containerRef } = useKeyboardNav({
    items: events,
    onActivate,
  });

  const resolveEntityName = useMemo(() => {
    return (id: string) => entities.find((e) => e.id === id)?.name;
  }, [entities]);

  return (
    <GlassPanel title="Activity" icon={<ScrollText size={14} />} backContent={backContent}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: scroll container with roving keyboard nav over child rows, not click-activation */}
      <div
        ref={(el) => {
          (scrollRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
          (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
        }}
        onKeyDown={onKeyDown}
        className="flex flex-col overflow-auto outline-none"
      >
        {events.length === 0 && (
          <div className="p-2 text-text-dim text-[11px]">Waiting for events...</div>
        )}
        {events.map((event, i) => (
          <motion.div
            key={`${event.timestamp}-${event.type}-${event.entity ?? ""}-${event.input ?? event.content ?? event.summary ?? ""}`}
            initial={{ opacity: 0, y: -16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 28 }}
          >
            <EventLine
              event={event}
              resolveEntityName={resolveEntityName}
              onEntityClick={selectEntity}
              kbItem
              highlighted={highlightedIndex === i}
            />
          </motion.div>
        ))}
      </div>
    </GlassPanel>
  );
}

/** Format a short, content-bearing line for any DashboardEvent.
 *
 * Rule of thumb: the row should answer "who did what, with what content?"
 * in one line. Previously the feed showed only event-type tags; every
 * case here extracts the actual payload so the reader learns something
 * beyond "something happened".
 */
export function formatEvent(
  event: DashboardEvent,
  resolveEntityName: (id: string) => string | undefined,
): { color: string; prefix: string; suffix: string } {
  const entityName = event.entity ? (resolveEntityName(event.entity) ?? event.entity) : undefined;
  const room = event.room?.split("/")[1] ?? event.room ?? "";

  const clip = (s: string, n = 100): string => (s.length > n ? `${s.slice(0, n)}…` : s);

  switch (event.type) {
    case "say":
    case "shout":
    case "emote":
    case "broadcast": {
      const { body } = parseMessage(event.type, event.input);
      const verb = event.type;
      const color =
        event.type === "shout"
          ? "text-warning"
          : event.type === "emote"
            ? "text-text-dim"
            : event.type === "broadcast"
              ? "text-warning"
              : "text-primary";
      return {
        color,
        prefix: entityName ?? "",
        suffix: ` ${verb}: ${clip(body || event.input || "")}`,
      };
    }
    case "tell": {
      const { body, recipient } = parseMessage("tell", event.input);
      return {
        color: "text-secondary",
        prefix: entityName ?? "",
        suffix: recipient ? ` → ${recipient}: ${clip(body)}` : ` tell: ${clip(body)}`,
      };
    }
    case "command":
      return {
        color: "text-primary",
        prefix: entityName ?? "",
        suffix: ` > ${clip(event.input ?? "")}`,
      };
    case "entity_enter":
      return {
        color: "text-secondary",
        prefix: entityName ?? "",
        suffix: ` → ${room}`,
      };
    case "entity_leave":
      return {
        color: "text-secondary",
        prefix: entityName ?? "",
        suffix: ` left ${room}`,
      };
    case "connect":
      return { color: "text-success", prefix: "", suffix: `${event.connectionId} connected` };
    case "disconnect":
      return { color: "text-danger", prefix: "", suffix: `${event.connectionId} disconnected` };
    case "agent_error":
      return {
        color: "text-red-400",
        prefix: event.name ?? "",
        suffix: ` error: ${clip(event.error ?? "unknown")}`,
      };
    case "agent_turn_start":
      return { color: "text-accent", prefix: event.name ?? "", suffix: " thinking…" };
    case "agent_turn_end":
      return {
        color: "text-text-dim",
        prefix: event.name ?? "",
        suffix: event.toolCount ? ` turn done (${event.toolCount} tools)` : " turn done",
      };
    case "rank_change": {
      const arrow = event.direction === "promoted" ? "↑" : "↓";
      return {
        color: event.direction === "promoted" ? "text-warning" : "text-text-dim",
        prefix: event.name ?? "",
        suffix: ` rank ${event.oldRank}${arrow}${event.newRank}`,
      };
    }
    case "task_claimed":
    case "task_submitted":
    case "task_approved":
    case "task_rejected":
      return {
        color: "text-accent",
        prefix: entityName ?? "",
        suffix: ` ${event.type.replace("task_", "")} task #${event.taskId}`,
      };
    case "note_created": {
      const importance = event.importance != null ? `!${event.importance} ` : "";
      const kind = event.noteType ? `#${event.noteType} ` : "";
      return {
        color: "text-accent",
        prefix: event.authorName ?? entityName ?? "",
        suffix: ` note ${importance}${kind}${clip(event.content ?? "")}`,
      };
    }
    case "note_deleted":
      return {
        color: "text-text-dim",
        prefix: entityName ?? "",
        suffix: ` deleted note #${event.noteId}`,
      };
    case "note_link_created":
      return {
        color: "text-accent",
        prefix: entityName ?? "",
        suffix: ` link ${event.sourceId} —[${event.relationship}]→ ${event.targetId}`,
      };
    case "note_link_deleted":
      return {
        color: "text-text-dim",
        prefix: entityName ?? "",
        suffix: ` unlink ${event.sourceId} —[${event.relationship}]→ ${event.targetId}`,
      };
    case "recall_trace": {
      const n = event.activatedNoteIds?.length ?? 0;
      return {
        color: "text-secondary",
        prefix: entityName ?? "",
        suffix: ` recall "${clip(event.query ?? "", 60)}" (${n} notes)`,
      };
    }
    case "channel_message":
      return {
        color: "text-primary",
        prefix: entityName ?? "",
        suffix: ` #${event.kind ?? "channel"}: ${clip(event.content ?? "")}`,
      };
    case "board_post":
      return {
        color: "text-accent",
        prefix: entityName ?? "",
        suffix: ` post: ${clip(event.content ?? event.summary ?? "")}`,
      };
    case "pool_note":
      return {
        color: "text-accent",
        prefix: entityName ?? "",
        suffix: ` pool note ${event.importance != null ? `!${event.importance} ` : ""}${clip(event.content ?? "")}`,
      };
    case "canvas_edge_created":
      return {
        color: "text-secondary",
        prefix: entityName ?? "",
        suffix: ` edge [${event.relationship}]`,
      };
    case "canvas_edge_deleted":
      return {
        color: "text-text-dim",
        prefix: entityName ?? "",
        suffix: ` edge removed [${event.relationship}]`,
      };
    case "canvas_intent":
      return {
        color: "text-warning",
        prefix: entityName ?? "",
        suffix: ` intent: ${clip(event.summary ?? event.input ?? "")}`,
      };
    case "market_position":
      return {
        color: "text-accent",
        prefix: entityName ?? "",
        suffix: ` market: ${event.direction ?? "?"} ${event.importance ?? ""}`.trim(),
      };
    case "crew_created": {
      const formation = event.formation ? `/${event.formation}` : "";
      const lifetime = event.lifetime ? `/${event.lifetime}` : "";
      return {
        color: "text-accent",
        prefix: entityName ?? "",
        suffix: ` formed crew "${event.name ?? event.crew}"${formation}${lifetime}`,
      };
    }
    case "crew_member_joined":
      return {
        color: "text-secondary",
        prefix: event.agentName ?? "",
        suffix: ` joined crew "${event.crew}"${event.role ? ` as ${event.role}` : ""}`,
      };
    case "crew_member_left":
      return {
        color: "text-text-dim",
        prefix: event.agentName ?? "",
        suffix: ` left crew "${event.crew}"${event.reason ? ` (${event.reason})` : ""}`,
      };
    case "crew_state_changed":
      return {
        color: "text-text-dim",
        prefix: "",
        suffix: `crew "${event.crew}" ${event.from} → ${event.to}`,
      };
    case "crew_completed": {
      const noteHint = event.resultNoteId ? ` (note #${event.resultNoteId})` : "";
      return {
        color: "text-success",
        prefix: "",
        suffix: `crew "${event.crew}" completed${noteHint}`,
      };
    }
    case "crew_dissolved":
      return {
        color: "text-text-dim",
        prefix: "",
        suffix: `crew "${event.crew}" dissolved${event.reason ? `: ${event.reason}` : ""}`,
      };
    case "crew_stage_completed":
      return {
        color: "text-accent",
        prefix: event.agentName ?? "",
        suffix: ` completed stage "${event.stage}" in crew "${event.crew}"`,
      };
    case "crew_artifact_deposited":
      return {
        color: "text-accent",
        prefix: event.agentName ?? "",
        suffix: ` deposited ${event.kind ?? "artifact"} "${event.artifactRef}" in crew "${event.crew}"`,
      };
    case "crew_member_stalled": {
      const offense = event.offenseCount ? ` (offense ${event.offenseCount})` : "";
      return {
        color: event.offenseCount && event.offenseCount >= 3 ? "text-warning" : "text-text-dim",
        prefix: event.agentName ?? "",
        suffix: ` flagged as stalled in crew "${event.crew}"${offense}${event.reason ? `: ${event.reason}` : ""}`,
      };
    }
    case "feed_event":
      return {
        color: "text-text",
        prefix: entityName ?? "",
        suffix: ` ${event.kind ?? "event"}: ${clip(event.summary ?? "")}`,
      };
    default: {
      const label = event.type.replace(/_/g, " ");
      const bodyPart = event.input ? `: ${clip(event.input)}` : "";
      return {
        color: "text-text-dim",
        prefix: entityName ?? "",
        suffix: entityName ? ` ${label}${bodyPart}` : `${label}${bodyPart}`,
      };
    }
  }
}
