import {
  Bot,
  ChevronDown,
  ChevronRight,
  Compass,
  Square,
  Trash2,
  TriangleAlert,
  Users,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";
import { useEntityBrief, useEntityDetail } from "../hooks/use-api";
import {
  type ActivityItem,
  type ActivityKind,
  useEntityActivity,
} from "../hooks/use-entity-activity";
import { useKeyboardNav } from "../hooks/use-keyboard-nav";
import { useInvalidateOnEvent } from "../hooks/use-realtime";
import { useWorldState } from "../hooks/use-world-state";
import { deleteApi, postApi } from "../lib/api";
import type { DashboardEvent } from "../lib/types";
import { cn, formatTime } from "../lib/utils";
import { AgentPanel } from "./AgentPanel";
import { GlassPanel } from "./GlassPanel";
import { WhoLink } from "./WhoLink";

export function EntityRoster({ backContent }: { backContent?: ReactNode }) {
  const entities = useWorldState((s) => s.entities);
  const thinkingAgents = useWorldState((s) => s.thinkingAgents);
  const selectedEntity = useWorldState((s) => s.selectedEntity);
  const selectEntity = useWorldState((s) => s.selectEntity);
  const selectRoom = useWorldState((s) => s.selectRoom);

  const sorted = [...entities].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "agent" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const onActivate = useCallback(
    (index: number) => {
      const ent = sorted[index];
      if (!ent) return;
      selectEntity(selectedEntity === ent.name ? null : ent.name);
    },
    [sorted, selectEntity, selectedEntity],
  );

  const { highlightedIndex, onKeyDown, containerRef } = useKeyboardNav({
    items: sorted,
    onActivate,
  });

  return (
    <GlassPanel title="Entities" icon={<Users size={14} />} backContent={backContent}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: list container with roving keyboard nav over child roster rows, not click-activation */}
      <div ref={containerRef} onKeyDown={onKeyDown} className="flex flex-col outline-none">
        {sorted.length === 0 && (
          <div className="p-2 text-text-dim text-[11px]">No entities online</div>
        )}
        <AnimatePresence initial={false}>
          {sorted.map((e, idx) => {
            const isSelected = selectedEntity === e.name;
            const isHighlighted = highlightedIndex === idx;
            return (
              <motion.div
                key={e.id}
                data-kb-item
                // No `layout`: it forced Framer Motion to measure every roster
                // row on each 2s world snapshot. Enter/exit fade is enough; rows
                // snap to position on reorder instead of animating.
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ type: "spring", stiffness: 320, damping: 30 }}
              >
                {/* biome-ignore lint/a11y/useSemanticElements: contains nested interactive elements — cannot use <button> */}
                <div
                  role="button"
                  tabIndex={-1}
                  onClick={() => selectEntity(isSelected ? null : e.name)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" || ev.key === " ") {
                      ev.preventDefault();
                      selectEntity(isSelected ? null : e.name);
                    }
                  }}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 px-2 py-1 text-left text-[12px] transition-colors hover:bg-bg-hover",
                    isSelected && "bg-bg-hover",
                    isHighlighted && "ring-1 ring-primary/40",
                  )}
                >
                  {e.agentStatus ? (
                    <span title="AI Agent">
                      <Bot size={10} className="text-accent shrink-0" />
                    </span>
                  ) : (
                    <span
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{
                        backgroundColor:
                          e.kind === "agent"
                            ? "var(--color-primary)"
                            : e.kind === "npc"
                              ? "var(--color-warning)"
                              : "var(--color-text-dim)",
                      }}
                    />
                  )}
                  <span className="flex-1 truncate text-text-bright">{e.name}</span>
                  <WhoLink name={e.name} size={10} />
                  {thinkingAgents[e.name] && (
                    <span
                      className="text-accent text-[10px] animate-pulse"
                      title="Mid-turn — agent is thinking / acting"
                    >
                      ○
                    </span>
                  )}
                  {e.agentStatus?.state === "error" && (
                    <span
                      className="shrink-0 text-red-400"
                      title={e.agentStatus.errorReason ?? "Agent is in an error state"}
                    >
                      <TriangleAlert size={10} />
                    </span>
                  )}
                  {e.agentStatus && (
                    <span className="text-accent text-[9px] truncate">
                      {e.agentStatus.model.split("/")[1] ?? e.agentStatus.model}
                    </span>
                  )}
                  <span className="truncate text-text-dim text-[10px]">{e.room.split("/")[1]}</span>
                  {e.agentStatus && (
                    <button
                      type="button"
                      title={`Stop agent ${e.name}`}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        postApi(`/api/agents/${encodeURIComponent(e.name)}/stop`);
                      }}
                      className="text-text-dim hover:text-red-400 transition-colors"
                    >
                      <Square size={10} />
                    </button>
                  )}
                  {/* Remove fully deletes the entity from the Marina. For a live
                      agent it also stops the loop and deletes its config so it
                      won't respawn — see engine.removeEntity. */}
                  <button
                    type="button"
                    title={`Remove ${e.name}`}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      if (window.confirm(`Remove entity "${e.name}"?`)) {
                        deleteApi(`/api/entities/${encodeURIComponent(e.name)}`);
                      }
                    }}
                    className="text-text-dim hover:text-red-400 transition-colors"
                  >
                    <Trash2 size={10} />
                  </button>
                  {isSelected ? (
                    <ChevronDown size={10} className="text-text-dim" />
                  ) : (
                    <ChevronRight size={10} className="text-text-dim" />
                  )}
                </div>

                <EntityActivitySnippet name={e.name} />

                {isSelected && (
                  <>
                    {e.agentStatus && <AgentPanel name={e.name} status={e.agentStatus} />}
                    {e.agentStatus && <AgentIntent name={e.name} />}
                    <EntityLiveStream name={e.name} />
                    <EntityMessageThread name={e.name} onEntityClick={selectEntity} />
                    <EntityExpandedDetail
                      name={e.name}
                      room={e.room}
                      onRoomClick={() => selectRoom(e.room)}
                    />
                  </>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </GlassPanel>
  );
}

/** Symbol + color per activity kind — keeps the row scannable. */
const KIND_MARK: Record<ActivityKind, { glyph: string; color: string }> = {
  thought: { glyph: "∙∙∙", color: "var(--color-accent)" },
  text: { glyph: "»", color: "var(--color-text-bright)" },
  say: { glyph: "say", color: "var(--color-primary)" },
  tell: { glyph: "tell", color: "var(--color-secondary)" },
  shout: { glyph: "shout", color: "var(--color-warning)" },
  emote: { glyph: "*", color: "var(--color-text-dim)" },
  broadcast: { glyph: "bcast", color: "var(--color-warning)" },
};

/**
 * One-line snippet under an entity's name row showing what it's currently
 * streaming or most-recently said. The row is the "content over motion"
 * payoff — a pulsing dot alone tells you nothing; this tells you what.
 */
function EntityActivitySnippet({ name }: { name: string }) {
  const streaming = useEntityActivity((s) => s.streaming[name]);
  const recent = useEntityActivity((s) => s.recent[name]);

  let kind: ActivityKind | null = null;
  let body = "";
  let isLive = false;

  if (streaming && (streaming.text || streaming.thought)) {
    // Prefer visible text over internal thought
    if (streaming.text) {
      kind = "text";
      body = streaming.text;
    } else {
      kind = "thought";
      body = streaming.thought;
    }
    isLive = true;
  } else {
    const latest = recent?.[0];
    if (latest) {
      kind = latest.kind;
      body = latest.body;
    }
  }

  if (!kind || !body) return null;
  const mark = KIND_MARK[kind];
  const clipped = body.length > 140 ? `${body.slice(0, 140)}…` : body;

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 px-2 pb-1 text-[10px] leading-tight",
        isLive && "animate-pulse",
      )}
    >
      <span className="shrink-0 font-semibold tabular-nums" style={{ color: mark.color }}>
        {mark.glyph}
      </span>
      <span className="truncate text-text">{clipped}</span>
    </div>
  );
}

/**
 * Live stream view inside the expanded row. Shows the currently streaming
 * delta buffer plus the most recent completed items from entityActivity.
 * Complements the API-fetched `recentActivity` list below, which is a
 * polled snapshot. This one is live.
 */
function EntityLiveStream({ name }: { name: string }) {
  const streaming = useEntityActivity((s) => s.streaming[name]);
  const recent = useEntityActivity((s) => s.recent[name]);

  const hasStreaming = streaming && (streaming.thought || streaming.text);
  const items = recent ?? [];

  if (!hasStreaming && items.length === 0) return null;

  return (
    <div className="border-t border-border bg-bg-card px-2 py-1 text-[11px]">
      <div className="text-primary text-[10px] uppercase tracking-wider mb-0.5">Live</div>
      {hasStreaming && (
        <>
          {streaming.thought && (
            <div className="flex gap-1 text-[10px] leading-tight animate-pulse">
              <span className="text-accent shrink-0">∙∙∙</span>
              <span className="text-text whitespace-pre-wrap break-words">{streaming.thought}</span>
            </div>
          )}
          {streaming.text && (
            <div className="flex gap-1 text-[10px] leading-tight animate-pulse">
              <span className="text-text-bright shrink-0">»</span>
              <span className="text-text whitespace-pre-wrap break-words">{streaming.text}</span>
            </div>
          )}
        </>
      )}
      {items.slice(0, 5).map((item) => {
        const mark = KIND_MARK[item.kind];
        return (
          <div
            key={`${item.timestamp}-${item.kind}-${item.body}`}
            className="flex gap-1 text-[10px] leading-tight"
          >
            <span className="text-text-dim shrink-0">{formatTime(item.timestamp)}</span>
            <span className="shrink-0 font-semibold" style={{ color: mark.color }}>
              {mark.glyph}
            </span>
            {item.recipient && <span className="text-secondary shrink-0">→{item.recipient}</span>}
            <span className="text-text truncate">{item.body}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Message-kind activity items — what counts as a conversation turn. */
const MESSAGE_KINDS: ReadonlySet<ActivityKind> = new Set<ActivityKind>([
  "say",
  "tell",
  "shout",
  "emote",
  "broadcast",
]);

export type ThreadPartnerKind = "entity" | "room" | "world";

export interface MessageThread {
  partner: string;
  kind: ThreadPartnerKind;
  items: ActivityItem[];
}

/**
 * Pure helper — groups activity items into conversation threads by
 * partner. Exposed for unit testing.
 *
 * - `tell <bob> …` → partner = recipient (kind: entity)
 * - `say …` / `emote …` → partner = room short-name (kind: room)
 * - `shout …` / `broadcast …` → partner = "world" (kind: world)
 *
 * Non-message kinds (thought, text) are filtered out. Threads are
 * returned sorted by most-recent-message descending; each thread caps
 * at `maxPerThread` items.
 */
export function groupMessagesByPartner(
  items: readonly ActivityItem[],
  maxPerThread = 3,
): MessageThread[] {
  if (items.length === 0) return [];
  const byPartner = new Map<string, MessageThread>();
  for (const item of items) {
    if (!MESSAGE_KINDS.has(item.kind)) continue;
    let partner: string;
    let partnerKind: ThreadPartnerKind;
    if (item.kind === "tell") {
      if (!item.recipient) continue;
      partner = item.recipient;
      partnerKind = "entity";
    } else if (item.kind === "say" || item.kind === "emote") {
      partner = item.room ? (item.room.split("/")[1] ?? item.room) : "room";
      partnerKind = "room";
    } else {
      partner = "world";
      partnerKind = "world";
    }
    const key = `${partnerKind}:${partner}`;
    const existing = byPartner.get(key);
    if (existing) {
      existing.items.push(item);
    } else {
      byPartner.set(key, { partner, kind: partnerKind, items: [item] });
    }
  }
  return [...byPartner.values()]
    .map((g) => ({ ...g, items: g.items.slice(0, maxPerThread) }))
    .sort((a, b) => (b.items[0]?.timestamp ?? 0) - (a.items[0]?.timestamp ?? 0));
}

/**
 * Per-agent message thread view inside the expanded entity row.
 * Groups the agent's recent outgoing messages by conversation partner —
 * see `groupMessagesByPartner` for the rules. Each group shows its
 * newest 3 messages; entity-partner names are clickable and select
 * that entity.
 */
/**
 * Compact per-agent intent strip: goal, focus, top task. This is the
 * *unique* content from the agent's brief compass — the counts
 * (onlineCount, openTaskCount, etc.) duplicate data visible elsewhere
 * in the dashboard. What's not elsewhere is "what is this agent
 * actually trying to do right now?"
 *
 * `useEntityBrief` is already event-driven (wired in ContextPanel's
 * CompassSection), so no poll timer.
 */
function AgentIntent({ name }: { name: string }) {
  const { data: brief } = useEntityBrief(name);
  if (!brief) return null;
  const hasGoal = !!brief.goal;
  const hasFocus = !!brief.focus;
  const hasTopTask = !!brief.topTask;
  if (!hasGoal && !hasFocus && !hasTopTask) return null;

  return (
    <div className="border-t border-border bg-bg-card px-2 py-1 text-[11px]">
      <div className="mb-0.5 flex items-center gap-1 text-accent text-[10px] uppercase tracking-wider">
        <Compass size={9} />
        <span>Intent</span>
      </div>
      <div className="flex flex-col gap-0.5">
        {hasGoal && (
          <div className="flex items-start gap-1.5 text-[10px] leading-tight">
            <span className="shrink-0 text-text-dim">goal</span>
            <span className="text-text-bright truncate">{brief.goal}</span>
          </div>
        )}
        {hasFocus && (
          <div className="flex items-start gap-1.5 text-[10px] leading-tight">
            <span className="shrink-0 text-text-dim">focus</span>
            <span className="text-primary truncate">{brief.focus}</span>
          </div>
        )}
        {hasTopTask && brief.topTask && (
          <div className="flex items-start gap-1.5 text-[10px] leading-tight">
            <span className="shrink-0 text-text-dim">task</span>
            <span className="text-text truncate flex-1">
              #{brief.topTask.id} {brief.topTask.title}
            </span>
            <TaskProgressBar progress={brief.topTask.progress} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Tiny progress bar — 32px wide, fills based on 0–100. */
function TaskProgressBar({ progress }: { progress: number }) {
  const pct = Math.max(0, Math.min(100, progress));
  const color = pct >= 100 ? "var(--color-success)" : "var(--color-primary)";
  return (
    <span className="relative inline-block h-[6px] w-8 shrink-0 overflow-hidden rounded-sm bg-bg">
      <span
        className="absolute inset-y-0 left-0 transition-all"
        style={{ width: `${pct}%`, backgroundColor: color, opacity: 0.8 }}
      />
    </span>
  );
}

function EntityMessageThread({
  name,
  onEntityClick,
}: {
  name: string;
  onEntityClick: (name: string) => void;
}) {
  const recent = useEntityActivity((s) => s.recent[name]);

  const threads = useMemo(() => groupMessagesByPartner(recent ?? []), [recent]);

  if (threads.length === 0) return null;

  return (
    <div className="border-t border-border bg-bg-card px-2 py-1 text-[11px]">
      <div className="text-primary text-[10px] uppercase tracking-wider mb-0.5">Messages</div>
      <div className="flex flex-col gap-1">
        {threads.map((thread) => (
          <MessageThreadGroup
            key={`${thread.kind}:${thread.partner}`}
            thread={thread}
            onEntityClick={onEntityClick}
          />
        ))}
      </div>
    </div>
  );
}

function MessageThreadGroup({
  thread,
  onEntityClick,
}: {
  thread: MessageThread;
  onEntityClick: (name: string) => void;
}) {
  const headerColor =
    thread.kind === "entity"
      ? "text-secondary"
      : thread.kind === "room"
        ? "text-primary"
        : "text-warning";
  const prefix = thread.kind === "entity" ? "→ " : thread.kind === "room" ? "@ " : "";

  return (
    <div>
      <div className="flex items-center gap-1 text-[10px]">
        {thread.kind === "entity" ? (
          <button
            type="button"
            onClick={() => onEntityClick(thread.partner)}
            className={cn("font-semibold hover:underline", headerColor)}
          >
            {prefix}
            {thread.partner}
          </button>
        ) : (
          <span className={cn("font-semibold", headerColor)}>
            {prefix}
            {thread.partner}
          </span>
        )}
        <span className="text-text-dim">· {thread.items.length}</span>
      </div>
      {thread.items.map((item) => {
        const mark = KIND_MARK[item.kind];
        return (
          <div
            key={`${item.timestamp}-${item.kind}-${item.body}`}
            className="flex gap-1 pl-2 text-[10px] leading-tight"
          >
            <span className="shrink-0 text-text-dim tabular-nums">
              {formatTime(item.timestamp)}
            </span>
            <span className="shrink-0" style={{ color: mark.color }}>
              {mark.glyph}
            </span>
            <span className="truncate text-text">{item.body}</span>
          </div>
        );
      })}
    </div>
  );
}

function EntityExpandedDetail({
  name,
  room,
  onRoomClick,
}: {
  name: string;
  room: string;
  onRoomClick: () => void;
}) {
  const { data, isLoading } = useEntityDetail(name);
  const [expandedNoteId, setExpandedNoteId] = useState<number | null>(null);

  // Realtime: the entity's notes, rank, and activity list are all
  // derived server-side. Any event from this entity invalidates the
  // cached detail so the expanded row reflects live state.
  useInvalidateOnEvent(
    ["entity", name],
    useCallback(
      (e: DashboardEvent) => e.entity === name || e.name === name || e.authorName === name,
      [name],
    ),
  );

  return (
    <div className="animate-fade-in border-t border-border bg-bg-card px-2 py-1 text-[11px]">
      {isLoading && <div className="text-text-dim">Loading...</div>}
      {data && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-text-dim">Room:</span>
            <button type="button" onClick={onRoomClick} className="text-secondary hover:underline">
              {room}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-text-dim">Rank:</span>
            <span className="text-text-bright">{data.rank}</span>
          </div>

          {/* Core Memory */}
          {data.coreMemory && data.coreMemory.length > 0 && (
            <div>
              <div className="text-primary text-[10px] uppercase tracking-wider mb-0.5">
                Core Memory
              </div>
              {data.coreMemory.map((m) => (
                <div key={m.key} className="flex gap-1 text-[10px] leading-tight">
                  <span className="text-secondary">{m.key}:</span>
                  <span className="text-text truncate">{m.value}</span>
                  <span className="text-text-dim">(v{m.version})</span>
                </div>
              ))}
            </div>
          )}

          {/* Recent Notes */}
          {data.notes && data.notes.length > 0 && (
            <div>
              <div className="text-primary text-[10px] uppercase tracking-wider mb-0.5">
                Notes ({data.notes.length})
              </div>
              {data.notes.slice(0, 5).map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => setExpandedNoteId(expandedNoteId === n.id ? null : n.id)}
                  className="flex w-full gap-1 text-[10px] leading-tight text-left hover:bg-bg-hover transition-colors"
                >
                  <span className="text-warning shrink-0">!{n.importance}</span>
                  <span className="text-accent shrink-0">#{n.note_type}</span>
                  <span
                    className={cn(
                      "text-text",
                      expandedNoteId === n.id ? "whitespace-pre-wrap" : "truncate",
                    )}
                  >
                    {n.content}
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Recent Activity */}
          {data.recentActivity && data.recentActivity.length > 0 && (
            <div>
              <div className="text-primary text-[10px] uppercase tracking-wider mb-0.5">
                Recent Activity
              </div>
              {data.recentActivity.slice(0, 8).map((a, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: activity slice is rendered in fixed order
                <div key={i} className="flex gap-1 text-[10px] leading-tight">
                  <span className="text-text-dim">{formatTime(a.timestamp)}</span>
                  <span className="text-text">{a.input ?? a.type}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
