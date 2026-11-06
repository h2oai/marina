// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Check, Copy } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { hasMarkdown } from "../../../src/sdk/message-format";
import { useChatMedia } from "../hooks/use-chat-media";
import { type ChatMessage, type StoredPerception, useChatState } from "../hooks/use-chat-state";
import { useFeedState } from "../hooks/use-feed-state";
import { type ChatMediaEntry, deriveChatMedia, mergeByTimestamp } from "../lib/chat-media";
import { identityColor, initials } from "../lib/identity-color";
import { linkifyHtml } from "../lib/linkify";
import { parseSpeech, type SpeechMeta } from "../lib/perception";
import { sanitizeChatHtml } from "../lib/sanitize";
import {
  type CodeMessageData,
  formatTimestamp,
  messageText,
  type RoomPerceptionData,
} from "../lib/webchat-format";
import { CanvasNodeEmbed } from "./CanvasNodeEmbed";
import { createCodeRenderers } from "./ChatCodeRenderers";
import { renderChatText as renderTextContent } from "./chat-render-text";
import { InvestigationCard, investigationReference } from "./investigations/InvestigationCard";
import { MessageBody } from "./MessageBody";
import { ChatMediaCard, viewableForEntry } from "./media/ChatMediaCard";
import type { ViewableAsset } from "./media/MediaViewer";

type TimelineItem =
  | {
      type: "chat";
      key: string;
      timestamp: number;
      message: ChatMessage;
      index: number;
    }
  | { type: "media"; key: string; timestamp: number; entry: ChatMediaEntry };

export function ChatMessageList({
  messages,
  viewMode,
  copy,
  copied,
  sendCommandWithOverlay,
}: {
  messages: ChatMessage[];
  viewMode: "compact" | "rich";
  copy(text: string, key: number | "all"): Promise<void>;
  copied: number | "all" | null;
  sendCommandWithOverlay(command: string, target?: { sessionId: string }): boolean;
}) {
  const outputRef = useRef<HTMLDivElement>(null);
  const feedEvents = useFeedState((s) => s.events);
  const viewer = useChatState((s) => (s.loggedIn ? s.entityName : null));
  const rich = viewMode === "rich";
  // Persisted conversation media (the viewer's, its agents' and the room
  // agents', scoped server-side and read under the viewer's credential) plus
  // a short-lived live fallback for other canvas activity.
  const media = useChatMedia(viewer, rich);
  const mediaEntries = useMemo(
    () =>
      rich ? deriveChatMedia({ assets: media.assets, jobs: media.jobs, feed: feedEvents }) : [],
    [rich, media.assets, media.jobs, feedEvents],
  );
  // The conversation's openable media, in transcript order: ←/→ in the viewer.
  const { collection, collectionIndex } = useMemo(() => {
    const list: ViewableAsset[] = [];
    const indexOf = new Map<string, number>();
    for (const entry of mediaEntries) {
      if (entry.type === "live") continue;
      const v = viewableForEntry(entry);
      if (!v) continue;
      indexOf.set(entry.key, list.length);
      list.push(v);
    }
    return { collection: list, collectionIndex: indexOf };
  }, [mediaEntries]);

  const timelineItems = useMemo<TimelineItem[]>(() => {
    if (!rich) return [];
    const chatItems: TimelineItem[] = messages.map((m, idx) => ({
      type: "chat",
      key: `chat-${idx}-${m.timestamp ?? idx}`,
      timestamp: m.timestamp ?? idx,
      message: m,
      index: idx,
    }));
    const mediaItems: TimelineItem[] = mediaEntries.map((entry) => ({
      type: "media",
      key: entry.key,
      timestamp: entry.timestamp,
      entry,
    }));
    return mergeByTimestamp(chatItems, mediaItems);
  }, [messages, mediaEntries, rich]);
  // Chat-app layout per message: who spoke (structured fields first), whether
  // the same sender just spoke in the same place (one header for the run),
  // and where a new day starts.
  const layout = useMemo(() => speechLayout(messages), [messages]);

  // Follow the newest item only: paging in earlier media must not jump the view.
  const lastKey = timelineItems[timelineItems.length - 1]?.key;
  // biome-ignore lint/correctness/useExhaustiveDependencies: autoscroll fires when the newest item changes (and on mode switch), keyed on it rather than the ref or full arrays
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [viewMode, lastKey, messages.length]);

  const msgStyle = (kind: string, tag?: string) => {
    if (tag === "tell") return "border-l-2 border-fuchsia-500 pl-2 bg-fuchsia-950/20";
    if (tag === "shout") return "border-l-2 border-yellow-400 pl-2 bg-yellow-950/20";
    if (tag === "emote") return "border-l-2 border-cyan-400 pl-2 bg-cyan-950/10 italic";
    if (tag === "say") return "border-l-2 border-gray-500 pl-2";
    if (kind === "message" && tag && !["tell", "say", "shout", "emote"].includes(tag))
      return "border-l-2 border-emerald-500 pl-2 bg-emerald-950/10";

    switch (kind) {
      case "system":
        return "border-l-2 border-primary pl-2 text-primary/90 bg-primary/5";
      case "error":
        return "border-l-2 border-red-500 pl-2 text-red-400 bg-red-950/15";
      case "room":
        return "border-l-2 border-green-600 pl-2 text-green-300/90";
      case "movement":
        return "pl-2 text-gray-600 italic text-[11px]";
      case "broadcast":
        return "border-l-2 border-blue-500 pl-2 bg-blue-950/10";
      default:
        return "text-text";
    }
  };

  const renderCompactMessage = (m: ChatMessage, i: number) => {
    const meta = layout[i]?.meta;
    if (meta?.speaker && meta.tone !== "emote" && m.perception)
      return renderCompactSpeech(m, i, meta);
    return renderCompactRaw(m, i);
  };

  /** Compact speech: one name column, then the body through the shared grammar. */
  const renderCompactSpeech = (m: ChatMessage, i: number, meta: SpeechMeta) => {
    const self = meta.perspective === "self";
    const name = self && meta.speaker === "You" ? (viewer ?? "You") : meta.speaker!;
    const mentioned = !self && mentionsViewer(meta.body, viewer);
    return (
      <div
        key={i}
        className={`group relative my-0.5 flex gap-2 rounded-sm py-0.5 pr-6 pl-2 ${msgStyle(m.kind, m.tag)} ${mentioned ? "bg-warning/10" : ""}`}
      >
        <span className="shrink-0 text-text-dim tabular-nums">{formatTimestamp(m.timestamp)}</span>
        <span className="shrink-0 font-semibold" style={{ color: identityColor(name) }}>
          {name}
          {meta.channel && <span className="font-normal text-text-dim"> #{meta.channel}</span>}
        </span>
        <MessageBody
          text={meta.body}
          viewer={viewer}
          channel={meta.channel}
          className="min-w-0 flex-1"
        />
        <button
          type="button"
          onClick={() => copy(messageText(m), i)}
          title="Copy message"
          aria-label="Copy message"
          className="absolute right-0.5 top-0.5 rounded p-0.5 text-text-dim opacity-0 transition-opacity hover:text-primary focus:opacity-100 group-hover:opacity-100"
        >
          {copied === i ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
    );
  };

  const renderCompactRaw = (m: ChatMessage, i: number) => (
    <div key={i} className="group relative">
      <div
        className={`whitespace-pre-wrap break-words rounded-sm my-0.5 py-0.5 pr-6 ${msgStyle(m.kind, m.tag)}`}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: defense-in-depth via sanitizeChatHtml — strips all but inline span/style + linkified anchors.
        dangerouslySetInnerHTML={{ __html: sanitizeChatHtml(linkifyHtml(m.html)) }}
      />
      <button
        type="button"
        onClick={() => copy(messageText(m), i)}
        title="Copy message"
        aria-label="Copy message"
        className="absolute right-0.5 top-0.5 rounded p-0.5 text-text-dim opacity-0 transition-opacity hover:text-primary focus:opacity-100 group-hover:opacity-100"
      >
        {copied === i ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </div>
  );

  const renderRoomMessage = (m: ChatMessage, i: number, perception: StoredPerception) => {
    const data = (perception.data ?? {}) as RoomPerceptionData;
    const title =
      typeof data.short === "string"
        ? data.short
        : typeof data.name === "string"
          ? data.name
          : "Room";
    const description = typeof data.long === "string" ? data.long : "";
    const objects =
      data.items && typeof data.items === "object"
        ? Object.keys(data.items as Record<string, unknown>)
        : [];
    const occupants = Array.isArray(data.entities)
      ? (data.entities as { name?: string; short?: string }[])
          .map((e) => e.short || e.name)
          .filter(Boolean)
      : [];
    const exits = Array.isArray(data.exits) ? (data.exits as string[]) : [];

    return (
      <div
        key={i}
        className="group relative my-1 rounded-md border border-border bg-bg/70 p-3 shadow-sm"
      >
        <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-text-dim">
          <div className="flex items-center gap-2 text-text">
            <span className="text-[11px]">{title}</span>
            {perception.tag && (
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[9px] font-normal text-primary">
                {perception.tag}
              </span>
            )}
          </div>
          <span className="text-[9px] font-medium text-text-dim/80">
            {formatTimestamp(m.timestamp)}
          </span>
        </div>
        {description && <div className="mt-2">{renderTextContent(description)}</div>}
        {objects.length > 0 && (
          <div className="mt-3 text-[11px] text-text">
            <span className="font-semibold text-text-bright">Objects</span>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {objects.map((obj) => (
                <span
                  key={obj}
                  className="rounded border border-border/60 bg-bg px-2 py-0.5 text-[10px] text-text-dim"
                >
                  {obj}
                </span>
              ))}
            </div>
          </div>
        )}
        {occupants.length > 0 && (
          <div className="mt-3 text-[11px] text-text">
            <span className="font-semibold text-text-bright">Present</span>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {occupants.map((entity) => (
                <span
                  key={entity}
                  className="rounded border border-border/60 bg-bg px-2 py-0.5 text-[10px] text-text-dim"
                >
                  {entity}
                </span>
              ))}
            </div>
          </div>
        )}
        {exits.length > 0 && (
          <div className="mt-3 text-[11px] text-text">
            <span className="font-semibold text-text-bright">Exits</span>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {exits.map((exit) => (
                <span
                  key={exit}
                  className="rounded border border-border/60 bg-bg px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-dim"
                >
                  {exit}
                </span>
              ))}
            </div>
          </div>
        )}
        <button
          type="button"
          onClick={() => copy(messageText(m), i)}
          title="Copy message"
          aria-label="Copy message"
          className="absolute right-2 top-2 rounded p-1 text-text-dim opacity-0 transition-opacity hover:text-primary focus:opacity-100 group-hover:opacity-100"
        >
          {copied === i ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
    );
  };

  const renderSystemMessage = (
    m: ChatMessage,
    i: number,
    tone: "system" | "error" | "broadcast",
  ) => {
    const baseClass =
      tone === "error"
        ? "border-red-500/60 bg-red-950/20 text-red-200"
        : tone === "broadcast"
          ? "border-blue-500/60 bg-blue-950/15 text-blue-100"
          : "border-primary/40 bg-primary/10 text-primary";
    return (
      <div
        key={i}
        className={`group relative my-1 rounded-md border px-3 py-2 text-sm ${baseClass}`}
      >
        <div className="flex items-center justify-between text-[10px] uppercase tracking-wide">
          <span>{tone === "error" ? "Error" : tone === "broadcast" ? "Broadcast" : "System"}</span>
          <span className="text-text-dim/70">{formatTimestamp(m.timestamp)}</span>
        </div>
        <div className="mt-1 text-sm">
          {renderTextContent(m.text ?? "", "text-sm text-inherit")}
        </div>
        <button
          type="button"
          onClick={() => copy(messageText(m), i)}
          title="Copy message"
          aria-label="Copy message"
          className="absolute right-2 top-2 rounded p-0.5 text-current opacity-0 transition-opacity hover:text-text focus:opacity-100 group-hover:opacity-100"
        >
          {copied === i ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
    );
  };

  const renderSpeechMessage = (m: ChatMessage, i: number, perception: StoredPerception) => {
    const info = layout[i];
    const meta = info?.meta ?? parseSpeech(m.text, m.tag, perception);
    // Output with no speaker (a command's result) keeps its preformatted text.
    if (!meta?.speaker || meta.tone === "emote") return renderPlainMessage(m, i, meta);
    const self = meta.perspective === "self" && meta.speaker === "You";
    const sentTell = meta.perspective === "self" && !self;
    const grouped = !!info?.grouped;
    const name = self ? (viewer ?? "You") : meta.speaker;
    const mentioned = !self && !sentTell && mentionsViewer(meta.body, viewer);
    const where = meta.channel
      ? `#${meta.channel}`
      : perception.tag === "tell"
        ? sentTell
          ? `→ ${meta.speaker}`
          : "→ you"
        : meta.tone === "shout"
          ? "shouts"
          : undefined;
    return (
      <ChatBubble
        key={i}
        name={sentTell ? "You" : name}
        colorName={name}
        body={meta.body}
        timestamp={m.timestamp}
        where={where}
        channel={meta.channel}
        mine={self || sentTell}
        tone={meta.tone}
        mentioned={mentioned}
        grouped={grouped}
        day={info?.day}
        viewer={viewer}
        copied={copied === i}
        onCopy={() => copy(messageText(m), i)}
      />
    );
  };

  /** `channel history` as a conversation: the same bubbles, grouped by sender and day. */
  const renderChannelHistory = (i: number, history: ChannelHistoryData) => (
    <div key={i} className="my-2 rounded-md border border-border/60 bg-bg/40 px-2 py-1.5">
      <div className="px-1 text-[11px] font-semibold text-text-dim">
        #{history.channel} · last {history.messages.length}
      </div>
      {historyLayout(history.messages).map(({ message, grouped, day }, j) => {
        const self = !!viewer && message.senderName === viewer;
        return (
          <ChatBubble
            // biome-ignore lint/suspicious/noArrayIndexKey: history entries never reorder
            key={j}
            name={message.senderName}
            colorName={message.senderName}
            body={message.content}
            timestamp={message.createdAt}
            channel={history.channel}
            mine={self}
            mentioned={!self && mentionsViewer(message.content, viewer)}
            grouped={grouped}
            day={day}
            viewer={viewer}
            copied={false}
            onCopy={() => copy(message.content, i)}
          />
        );
      })}
    </div>
  );

  /** Arrivals, departures, connects: scenery, a small centred line as chat apps show them. */
  const renderServiceLine = (m: ChatMessage, i: number) => (
    <div key={i} className="my-1 flex justify-center">
      <span className="max-w-[85%] truncate rounded-full bg-bg-hover/60 px-2.5 py-0.5 text-[10px] text-text-dim">
        {(m.text ?? "").replace(/\.$/, "")}
        <span className="ml-1.5 tabular-nums opacity-70">{formatTimestamp(m.timestamp)}</span>
      </span>
    </div>
  );

  /** Command output and emotes: the previous card, preformatted text kept. */
  const renderPlainMessage = (m: ChatMessage, i: number, meta: SpeechMeta | null) => {
    if (PRESENCE_TAGS.has(m.perception?.tag ?? "")) return renderServiceLine(m, i);
    const timestamp = formatTimestamp(m.timestamp);
    const tone =
      meta?.tone === "emote"
        ? "border-cyan-500/40 bg-cyan-950/10 text-cyan-100 italic"
        : meta?.tone === "broadcast"
          ? "border-blue-500/60 bg-blue-950/15 text-blue-100"
          : "border-border bg-bg/70 text-text";
    const badge = m.perception?.tag;
    const body = meta?.body ?? m.text ?? "";
    return (
      <div key={i} className={`group relative my-1 rounded-md border px-3 py-2 shadow-sm ${tone}`}>
        <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-text-dim/80">
          <div className="flex items-center gap-1.5">
            {badge && (
              <span className="rounded bg-bg/40 px-1.5 py-0.5 text-[9px] font-semibold text-current">
                {badge}
              </span>
            )}
          </div>
          <span>{timestamp}</span>
        </div>
        <div className="mt-1 text-sm leading-relaxed text-inherit">
          {/* A command's answer written in Markdown (ask, research, a pattern run) reads
              through the shared grammar; preformatted output keeps its layout. Unfolded:
              the answer is often the last part (`ask` puts its sources first). */}
          {hasMarkdown(body) ? (
            <MessageBody text={body} viewer={viewer} fold={false} />
          ) : (
            renderTextContent(body, "text-sm leading-relaxed text-inherit")
          )}
        </div>
        <button
          type="button"
          onClick={() => copy(messageText(m), i)}
          title="Copy message"
          aria-label="Copy message"
          className="absolute right-2 top-2 rounded p-0.5 text-current opacity-0 transition-opacity hover:text-text focus:opacity-100 group-hover:opacity-100"
        >
          {copied === i ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
    );
  };

  const { renderCodeMessage } = createCodeRenderers({
    copy,
    copied,
    sendCommandWithOverlay,
    renderTextContent,
  });
  const renderRichMessage = (m: ChatMessage, i: number) => {
    const perception = m.perception;
    if (!perception) return renderCompactMessage(m, i);
    const investigation = investigationReference(perception.data?.investigation);
    if (investigation) return <InvestigationCard key={i} {...investigation} />;
    const history = channelHistoryOf(perception.data);
    if (history) return renderChannelHistory(i, history);
    const code = perception.data?.code as CodeMessageData | undefined;
    if (code?.type) return renderCodeMessage(m, i, perception, code);
    switch (perception.kind) {
      case "room":
        return renderRoomMessage(m, i, perception);
      case "movement":
        return renderServiceLine(m, i);
      case "system":
        return renderSystemMessage(m, i, "system");
      case "error":
        return renderSystemMessage(m, i, "error");
      case "broadcast":
        return renderSystemMessage(m, i, "broadcast");
      default:
        return renderSpeechMessage(m, i, perception);
    }
  };

  return (
    <div
      ref={outputRef}
      className={`flex-1 overflow-y-auto px-2 py-1 ${
        viewMode === "compact" ? "font-mono text-[12px] leading-relaxed" : "font-sans text-[13px]"
      }`}
    >
      {viewMode === "compact" ? (
        messages.map((m, i) => renderCompactMessage(m, i))
      ) : (
        <>
          {media.hasEarlier && (
            <div className="flex justify-center py-1">
              <button
                type="button"
                onClick={media.loadEarlier}
                disabled={media.loadingEarlier}
                className="rounded border border-border bg-bg px-2 py-0.5 text-[11px] text-text-dim transition-colors hover:border-primary hover:text-primary disabled:opacity-60"
              >
                {media.loadingEarlier ? "Loading earlier media…" : "Show earlier media"}
              </button>
            </div>
          )}
          {timelineItems.map((item) => {
            if (item.type === "chat") return renderRichMessage(item.message, item.index);
            const entry = item.entry;
            if (entry.type === "live")
              return (
                <CanvasNodeEmbed
                  key={item.key}
                  canvasId={entry.event.canvasId}
                  nodeId={entry.event.nodeId}
                  actor={entry.event.actor}
                  summary={entry.event.summary}
                  kind={entry.event.kind}
                  timestamp={entry.event.timestamp}
                />
              );
            return (
              <ChatMediaCard
                key={item.key}
                entry={entry}
                collection={collection}
                index={collectionIndex.get(entry.key)}
                viewer={viewer}
              />
            );
          })}
        </>
      )}
    </div>
  );
}

/** Consecutive messages from one sender in one place within this window share a header. */
const GROUP_MS = 5 * 60_000;

interface SpeechLayout {
  meta: SpeechMeta | null;
  grouped: boolean;
  /** Set on the first message of a new day (after the first message). */
  day?: string;
}

/** Speaker, grouping and day breaks for each message, in order. */
export function speechLayout(messages: readonly ChatMessage[]): SpeechLayout[] {
  const out: SpeechLayout[] = [];
  let prevKey: string | undefined;
  let prevAt = 0;
  let prevDay = "";
  for (const m of messages) {
    const meta = m.perception ? parseSpeech(m.text, m.tag, m.perception) : null;
    const at = m.timestamp ?? 0;
    const day = at ? dayLabel(at) : "";
    const newDay = !!day && !!prevDay && day !== prevDay;
    const key =
      meta?.speaker && meta.tone !== "emote"
        ? `${meta.perspective}\u0000${meta.speaker}\u0000${meta.channel ?? m.tag ?? ""}`
        : undefined;
    const grouped = !!key && !newDay && key === prevKey && at - prevAt < GROUP_MS;
    out.push({ meta, grouped, ...(newDay ? { day } : {}) });
    prevKey = key;
    prevAt = at;
    if (day) prevDay = day;
  }
  return out;
}

function dayLabel(ts: number): string {
  try {
    return new Date(ts).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

function DayDivider({ label }: { label: string }) {
  return (
    <div className="my-3 flex justify-center">
      <span className="rounded-full border border-border bg-bg-card px-3 py-0.5 text-[10px] font-semibold text-text-dim">
        {label}
      </span>
    </div>
  );
}

/** Does this body @mention the viewer? */
function mentionsViewer(body: string, viewer: string | null | undefined): boolean {
  if (!viewer) return false;
  const escaped = viewer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w@])@${escaped}(?![\\w-])`, "i").test(body);
}

interface ChannelHistoryData {
  channel: string;
  messages: { senderName: string; content: string; createdAt?: number }[];
}

/** `channel history`'s structured payload, when the server sent one. */
function channelHistoryOf(data: Record<string, unknown> | undefined): ChannelHistoryData | null {
  const h = data?.channelHistory as { channel?: unknown; messages?: unknown } | undefined;
  if (!h || typeof h.channel !== "string" || !Array.isArray(h.messages)) return null;
  const messages = h.messages.filter(
    (x): x is ChannelHistoryData["messages"][number] =>
      !!x &&
      typeof (x as { senderName?: unknown }).senderName === "string" &&
      typeof (x as { content?: unknown }).content === "string",
  );
  return { channel: h.channel, messages };
}

function historyLayout(messages: ChannelHistoryData["messages"]) {
  let prev: ChannelHistoryData["messages"][number] | undefined;
  let prevDay = "";
  return messages.map((message) => {
    const day = message.createdAt ? dayLabel(message.createdAt) : "";
    const newDay = !!day && !!prevDay && day !== prevDay;
    const grouped =
      !newDay &&
      !!prev &&
      prev.senderName === message.senderName &&
      !!message.createdAt &&
      !!prev.createdAt &&
      message.createdAt - prev.createdAt < GROUP_MS;
    prev = message;
    if (day) prevDay = day;
    return { message, grouped, ...(newDay ? { day } : {}) };
  });
}

/**
 * One message as a chat bubble: an avatar and a name in the sender's colour
 * at the start of a run, the body through the shared grammar, the time inside
 * the bubble. Your own messages sit on the right; one that names you is
 * marked in the warning colour.
 */
function ChatBubble({
  name,
  colorName,
  body,
  timestamp,
  where,
  channel,
  mine,
  tone,
  mentioned,
  grouped,
  day,
  viewer,
  copied,
  onCopy,
}: {
  name: string;
  colorName: string;
  body: string;
  timestamp?: number;
  where?: string;
  /** The channel it was posted in: a bare `#12` in it may be one of its posts. */
  channel?: string;
  mine: boolean;
  tone?: SpeechMeta["tone"];
  mentioned: boolean;
  grouped: boolean;
  day?: string;
  viewer: string | null;
  copied: boolean;
  onCopy(): void;
}) {
  const color = identityColor(colorName);
  const bubbleTone =
    tone === "shout"
      ? "border-warning/50 bg-warning/10"
      : tone === "broadcast"
        ? "border-primary/40 bg-primary/10"
        : mine
          ? "border-primary/30 bg-primary/10"
          : mentioned
            ? "border-warning/60 bg-warning/10 shadow-[inset_3px_0_0_var(--color-warning)]"
            : "border-border bg-bg-card";
  return (
    <>
      {day && <DayDivider label={day} />}
      <div
        className={`group flex items-end gap-2 ${grouped ? "mt-0.5" : "mt-2"} ${mine ? "justify-end" : ""}`}
      >
        {!mine &&
          (grouped ? (
            <div className="w-7 shrink-0" aria-hidden="true" />
          ) : (
            <div
              className="flex h-7 w-7 shrink-0 select-none items-center justify-center rounded-full text-[10px] font-bold text-bg"
              style={{ backgroundColor: color }}
              aria-hidden="true"
            >
              {initials(colorName)}
            </div>
          ))}
        <div
          className={`relative min-w-0 max-w-[min(85%,44rem)] rounded-2xl border px-3 pt-1.5 pb-1 text-[13px] text-text shadow-sm ${bubbleTone} ${mine ? "rounded-br-md" : "rounded-bl-md"}`}
        >
          {!grouped && (
            <div className="mb-0.5 flex items-baseline gap-2 pr-5 text-[11px]">
              <span className="font-semibold" style={{ color }}>
                {name}
              </span>
              {where && <span className="text-text-dim">{where}</span>}
              {mentioned && (
                <span className="rounded bg-warning/20 px-1 text-[10px] font-semibold text-warning">
                  mentions you
                </span>
              )}
            </div>
          )}
          <MessageBody text={body} viewer={viewer} channel={channel} />
          <div className="mt-0.5 text-right text-[10px] leading-none text-text-dim tabular-nums">
            {formatTimestamp(timestamp)}
          </div>
          <button
            type="button"
            onClick={onCopy}
            title="Copy message"
            aria-label="Copy message"
            className="absolute right-1.5 top-1.5 rounded p-0.5 text-text-dim opacity-0 transition-opacity hover:text-text focus:opacity-100 group-hover:opacity-100"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </div>
      </div>
    </>
  );
}

/** Perception tags that only say who came or went. */
const PRESENCE_TAGS = new Set(["connect", "disconnect", "leave", "move", "arrive"]);
