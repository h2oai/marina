// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Check, Copy } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import type { ChatMessage, StoredPerception } from "../hooks/use-chat-state";
import { useFeedState } from "../hooks/use-feed-state";
import { linkifyHtml } from "../lib/linkify";
import { parseSpeech } from "../lib/perception";
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

interface CanvasTimelineItem {
  id: number | string;
  timestamp: number;
  canvasId: string;
  nodeId: string;
  summary?: string;
  actor?: string | null;
  kind: string;
}

type TimelineItem =
  | {
      type: "chat";
      key: string;
      timestamp: number;
      message: ChatMessage;
      index: number;
    }
  | {
      type: "canvas";
      key: string;
      timestamp: number;
      event: CanvasTimelineItem;
    };

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
  const canvasTimeline = useMemo<CanvasTimelineItem[]>(() => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    const seen = new Set<string>();
    const entries: CanvasTimelineItem[] = [];
    for (const event of feedEvents) {
      if (event.timestamp < cutoff) continue;
      const payload = event.payload as Record<string, unknown> | null;
      if (!payload) continue;
      const canvasId = payload.canvasId;
      const nodeId = payload.nodeId;
      if (!canvasId || !nodeId) continue;
      const entry: CanvasTimelineItem = {
        id: event.id,
        timestamp: event.timestamp,
        canvasId: String(canvasId),
        nodeId: String(nodeId),
        summary: event.summary,
        actor: event.entity ?? null,
        kind: event.kind,
      };
      const dedupeKey = `${entry.canvasId}:${entry.nodeId}:${entry.timestamp}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      entries.push(entry);
    }
    return entries.sort((a, b) => a.timestamp - b.timestamp).slice(-40);
  }, [feedEvents]);

  const timelineItems = useMemo<TimelineItem[]>(() => {
    if (viewMode !== "rich") return [];
    const chatItems: TimelineItem[] = messages.map((m, idx) => ({
      type: "chat",
      key: `chat-${idx}-${m.timestamp ?? idx}`,
      timestamp: m.timestamp ?? idx,
      message: m,
      index: idx,
    }));
    const canvasItems: TimelineItem[] = canvasTimeline.map((event) => ({
      type: "canvas",
      key: `canvas-${event.id}-${event.nodeId}`,
      timestamp: event.timestamp,
      event,
    }));
    return [...chatItems, ...canvasItems].sort((a, b) => a.timestamp - b.timestamp);
  }, [messages, canvasTimeline, viewMode]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: autoscroll fires on content-length change (and mode switch), keyed on the lengths rather than the ref or full arrays
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [viewMode, timelineItems.length, messages.length]);

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

  const renderCompactMessage = (m: ChatMessage, i: number) => (
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

  const renderMovementMessage = (m: ChatMessage, i: number) => (
    <div
      key={i}
      className="group relative my-1 rounded-md border border-border/60 bg-bg/40 px-3 py-1.5 text-[11px] italic text-text-dim"
    >
      <span>{m.text ?? ""}</span>
      <span className="absolute right-2 top-1 text-[9px] uppercase tracking-wide text-text-dim/70">
        {formatTimestamp(m.timestamp)}
      </span>
      <button
        type="button"
        onClick={() => copy(messageText(m), i)}
        title="Copy message"
        aria-label="Copy message"
        className="absolute right-1.5 bottom-1.5 rounded p-0.5 text-text-dim opacity-0 transition-opacity hover:text-primary focus:opacity-100 group-hover:opacity-100"
      >
        {copied === i ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </div>
  );

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
    const meta = parseSpeech(m.text, m.tag, perception);
    const timestamp = formatTimestamp(m.timestamp);
    const bubbleTone =
      meta?.tone === "shout"
        ? "border-yellow-500/60 bg-yellow-950/20 text-yellow-50"
        : meta?.tone === "emote"
          ? "border-cyan-500/40 bg-cyan-950/10 text-cyan-100"
          : meta?.tone === "broadcast"
            ? "border-blue-500/60 bg-blue-950/15 text-blue-100"
            : meta?.perspective === "self"
              ? "border-primary/60 bg-primary/10 text-primary"
              : "border-border bg-bg/70 text-text";

    const badge =
      meta?.channel ??
      perception.tag ??
      (meta?.tone === "broadcast" ? "broadcast" : meta?.tone === "shout" ? "shout" : undefined);

    const heading = meta?.speaker ?? (meta?.tone === "broadcast" ? "Broadcast" : "");

    const body = meta?.body ?? m.text ?? "";

    return (
      <div
        key={i}
        className={`group relative my-1 rounded-md border px-3 py-2 shadow-sm ${bubbleTone}`}
      >
        <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-text-dim/80">
          <div className="flex items-center gap-1.5">
            {badge && (
              <span className="rounded bg-bg/40 px-1.5 py-0.5 text-[9px] font-semibold text-current">
                {badge}
              </span>
            )}
            {heading && <span className="text-[10px] font-semibold text-current">{heading}</span>}
          </div>
          <span>{timestamp}</span>
        </div>
        <div className="mt-1 text-sm leading-relaxed text-inherit">
          {renderTextContent(body, "text-sm leading-relaxed text-inherit")}
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
    const code = perception.data?.code as CodeMessageData | undefined;
    if (code?.type) return renderCodeMessage(m, i, perception, code);
    switch (perception.kind) {
      case "room":
        return renderRoomMessage(m, i, perception);
      case "movement":
        return renderMovementMessage(m, i);
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
      {viewMode === "compact"
        ? messages.map((m, i) => renderCompactMessage(m, i))
        : timelineItems.map((item) =>
            item.type === "chat" ? (
              renderRichMessage(item.message, item.index)
            ) : (
              <CanvasNodeEmbed
                key={item.key}
                canvasId={item.event.canvasId}
                nodeId={item.event.nodeId}
                actor={item.event.actor}
                summary={item.event.summary}
                kind={item.event.kind}
                timestamp={item.event.timestamp}
              />
            ),
          )}
    </div>
  );
}
