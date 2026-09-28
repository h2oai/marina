// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Check, Copy, List, Lock, MessageSquareText, PanelsTopLeft, Send } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMediaJobs } from "../hooks/use-api";
import type { ChatMessage, StoredPerception } from "../hooks/use-chat-state";
import { ensureChatWs, getChatWs, useChatState } from "../hooks/use-chat-state";
import { useCodingSessionDetail, useCodingSessionsSnapshot } from "../hooks/use-coding";
import { useCommandFavorites } from "../hooks/use-command-favorites";
import { useFeedState } from "../hooks/use-feed-state";
import {
  useBoardsSnapshot,
  useChannelsSnapshot,
  useGroupsSnapshot,
  useTasksSnapshot,
} from "../hooks/use-status-cards";
import { attachedCommand, openCanvas, useWorkspaceState } from "../hooks/use-workspace-state";
import { useWorldState } from "../hooks/use-world-state";
import { authFetch, clearToken, setToken } from "../lib/api";
import { draftCommand } from "../lib/command-discovery";
import { linkifyHtml } from "../lib/linkify";
import { parseSpeech } from "../lib/perception";
import { sanitizeChatHtml } from "../lib/sanitize";
import type { MediaJob } from "../lib/types";
import {
  ANSI_RE,
  ansiToHtml,
  type CodeContextData,
  type CodeMessageData,
  codeStatusTone,
  escapeHtml,
  formatTimestamp,
  messageText,
  parseMetadata,
  type RoomPerceptionData,
  writeClipboard,
} from "../lib/webchat-format";
import { AssetViewerProvider } from "./AssetLightbox";
import { CanvasNodeEmbed } from "./CanvasNodeEmbed";
import { PinToCanvas } from "./CanvasReference";
import { createCodeRenderers } from "./ChatCodeRenderers";
import { CodingPalette, ContextualCompass } from "./ChatInputGuidance";
import { CommandFavorites, FavoriteCommandButton } from "./CommandFavorites";
import { CommandInputAssistance } from "./CommandInputAssistance";
import { BoardDetailView, ChannelDetailView } from "./CoordinationCard";
import { GlassPanel, type PanelFocusProps } from "./GlassPanel";
import { MediaJobsList } from "./MediaJobsList";
import { StatusOverlay } from "./StatusOverlay";

const API_BASE = window.location.origin;

const MODE_STORAGE_KEY = "marina-chat-mode";
const CODING_SESSION_STORAGE_PREFIX = "marina-coding-session:";
type ChatViewMode = "compact" | "rich";

/** Active coding session id is persisted per instance, like the tour-seen flag. */
function codingSessionStorageKey(instanceName: string | null | undefined): string {
  return `${CODING_SESSION_STORAGE_PREFIX}${instanceName ?? "default"}`;
}

type OverlayType =
  | "tasks"
  | "boards"
  | "board-posts"
  | "channel-messages"
  | "channels"
  | "groups"
  | "media"
  | "coding-sessions"
  | "coding-artifacts";

interface OverlayState {
  type: OverlayType;
  issuedFrom: string;
  params?: Record<string, unknown>;
}

function appendMsg(text: string, kind: string, tag?: string, perception?: StoredPerception) {
  const storedPerception = perception
    ? {
        kind: perception.kind,
        tag: perception.tag,
        timestamp: perception.timestamp,
        data: perception.data,
      }
    : undefined;
  useChatState.getState().appendMessage({
    html: ansiToHtml(text),
    text: text.replace(ANSI_RE, ""),
    kind,
    tag,
    timestamp: storedPerception?.timestamp ?? Date.now(),
    perception: storedPerception,
  });
}

type PerceptionKind =
  | "room"
  | "message"
  | "broadcast"
  | "movement"
  | "error"
  | "auth_error"
  | "system";

interface Perception {
  kind: PerceptionKind;
  timestamp?: number;
  tag?: string;
  data?: {
    onboarding?: import("../../../src/sdk/onboarding").ParticipantOrientation;
    token?: string;
    entityId?: string;
    entityName?: string;
    from?: string;
    fromName?: string;
    name?: string;
    short?: string;
    long?: string;
    items?: Record<string, unknown>;
    entities?: { name?: string; short?: string }[];
    exits?: string[];
    text?: string;
    entity?: string;
    direction?: string;
    exit?: string;
    channel?: string;
    senderName?: string;
    content?: string;
  };
}

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

function handlePerception(raw: unknown) {
  const internal = raw as {
    data?: {
      capabilities?: unknown;
      context_preview?: { request_id?: string };
      memory_service?: { request_id?: string };
    };
  };
  if (
    internal.data?.capabilities ||
    internal.data?.context_preview?.request_id ||
    internal.data?.memory_service?.request_id
  )
    return;
  const p = raw as Perception;
  if (p.data?.onboarding)
    useChatState.setState({
      orientation: p.data
        .onboarding as import("../../../src/sdk/onboarding").ParticipantOrientation,
    });
  if (p.kind === "auth_error") {
    clearToken();
    useChatState.getState().setLoggedIn(false);
    appendMsg(p.data?.text ?? "Authentication failed.", "system", p.tag, p);
    return;
  }
  if (p.data?.token) {
    setToken(p.data.token);
  }

  if (p.data?.entityId) {
    useChatState.getState().setLoggedIn(true, p.data.name);
  }

  const kind = p.kind ?? "message";
  const tag = p.tag;
  if (kind === "room") {
    const d = p.data ?? {};
    let text = "";
    if (d.short) text += `${d.short}\n`;
    if (d.long) text += `${d.long}\n`;
    if (d.items && Object.keys(d.items).length > 0) {
      text += `\nObjects: ${Object.keys(d.items).join(", ")}\n`;
    }
    if (d.entities && d.entities.length > 0) {
      text += `Present: ${d.entities
        .map((e) => e.short || e.name)
        .filter(Boolean)
        .join(", ")}\n`;
    }
    if (d.exits && d.exits.length > 0) {
      text += `Exits: ${d.exits.join(", ")}\n`;
    }
    appendMsg(text, "room", tag, p);
  } else if (kind === "movement") {
    const d = p.data ?? {};
    const name = (d.entityName as string) ?? (d.entity as string) ?? "Someone";
    const action =
      d.direction === "arrive"
        ? `${name} arrives.`
        : `${name} leaves${d.exit ? ` ${d.exit}` : ""}.`;
    appendMsg(action, "movement", tag, p);
  } else {
    const fallback =
      typeof p.data?.text === "string" ? p.data.text : p.data ? JSON.stringify(p.data) : "";
    appendMsg(fallback, kind, tag, p);
  }
}

// Initialize WebSocket once at module level (survives component unmount)
ensureChatWs(handlePerception);

export function WebChat({ isFocused, onToggleFocus }: PanelFocusProps = {}) {
  const favorites = useCommandFavorites();
  const attachment = useWorkspaceState((s) => s.attachment);
  const [attachmentAgent, setAttachmentAgent] = useState("");
  const attachmentEntities = useWorldState((s) => s.entities);
  const messages = useChatState((s) => s.messages);
  const loggedIn = useChatState((s) => s.loggedIn);
  const connected = useChatState((s) => s.connected);
  const entityName = useChatState((s) => s.entityName);
  const commandHistory = useChatState((s) => s.commandHistory);
  const sendChatCommand = useChatState((s) => s.sendCommand);
  const codePrompt = useWorldState((s) => {
    const self = entityName ? s.entities.find((entity) => entity.name === entityName) : undefined;
    const modal = self?.properties?.active_modal;
    if (modal !== "code") return null;
    return codePromptForProfile(self?.properties?.code_profile);
  });
  const codeContextRaw = useWorldState((s) => {
    const self = entityName ? s.entities.find((entity) => entity.name === entityName) : undefined;
    return self?.properties?.active_modal === "code" ? self.properties.code_context : null;
  });
  const codeContext = useMemo(() => codeContextFromProperty(codeContextRaw), [codeContextRaw]);
  const instanceName = useWorldState((s) => s.instanceName);
  const [overlay, setOverlay] = useState<OverlayState | null>(null);
  const closeOverlay = useCallback(() => setOverlay(null), []);

  // Active coding session id, persisted per instance so a reload keeps the
  // active session visible in the chip bar even before the entity property
  // round-trips back over the WS snapshot.
  const [persistedSessionId, setPersistedSessionId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return window.localStorage.getItem(codingSessionStorageKey(instanceName));
    } catch {
      return null;
    }
  });
  // The live entity property wins; fall back to the restored value on reload.
  const activeCodingSessionId = codeContext?.sessionId ?? persistedSessionId;

  // Artifact id whose full content is expanded in the coding-artifacts overlay.
  const [inspectedArtifactId, setInspectedArtifactId] = useState<string | null>(null);

  const [externalDraft, setExternalDraft] = useState<string | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const historyIdxRef = useRef(-1);
  const cmdValueRef = useRef("");
  const applyDraft = useCallback(
    (command: string) => {
      if (!loggedIn || !inputRef.current) return false;
      // Enter must see the prepared text immediately, before the next animation frame.
      inputRef.current.value = command;
      inputRef.current.rows = Math.min(6, command.split("\n").length);
      cmdValueRef.current = command;
      historyIdxRef.current = -1;
      inputRef.current.focus();
      return true;
    },
    [loggedIn],
  );
  useEffect(() => {
    const draft = (event: Event) => {
      const command = (event as CustomEvent<{ command: string }>).detail?.command;
      if (typeof command !== "string") return;
      setOverlay(null);
      setExternalDraft(applyDraft(command) ? null : command);
    };
    window.addEventListener("marina:draft-command", draft);
    return () => window.removeEventListener("marina:draft-command", draft);
  }, [applyDraft]);

  useEffect(() => {
    if (externalDraft === null) return;
    const frame = requestAnimationFrame(() => {
      if (!loggedIn) {
        nameRef.current?.focus();
        return;
      }
      if (applyDraft(externalDraft)) setExternalDraft(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [externalDraft, loggedIn, applyDraft]);

  // Transient "copied" feedback keyed by message index, or "all" for copy-all.
  const [copied, setCopied] = useState<number | "all" | null>(null);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copy = useCallback(async (text: string, key: number | "all") => {
    if (!text || !(await writeClipboard(text))) return;
    setCopied(key);
    if (copyResetRef.current) clearTimeout(copyResetRef.current);
    copyResetRef.current = setTimeout(() => setCopied(null), 1500);
  }, []);
  useEffect(() => () => clearTimeout(copyResetRef.current ?? undefined), []);

  const copyAll = useCallback(() => {
    copy(useChatState.getState().messages.map(messageText).join("\n"), "all");
  }, [copy]);

  // Ensure WebSocket is alive when component mounts (reconnect if closed)
  useEffect(() => {
    ensureChatWs(handlePerception);
  }, []);

  useEffect(() => {
    const openCoding = (event: Event) => {
      const sessionId = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (sessionId) setPersistedSessionId(sessionId);
      setOverlay({ type: "coding-artifacts", issuedFrom: "Work" });
    };
    window.addEventListener("marina:open-coding", openCoding);
    return () => window.removeEventListener("marina:open-coding", openCoding);
  }, []);

  const doLogin = useCallback(() => {
    const name = nameRef.current?.value.trim();
    if (!name) return;
    const ws = getChatWs();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "login", name }));
    }
  }, []);

  const [viewMode, setViewMode] = useState<ChatViewMode>(() => {
    // Rich is the default for web/dashboard consumers; only an explicit
    // stored "compact" preference opts back into the dense log.
    if (typeof window === "undefined") return "rich";
    const stored = window.localStorage.getItem(MODE_STORAGE_KEY);
    return stored === "compact" ? "compact" : "rich";
  });
  const openOverlayForCommand = useCallback(
    (rawCommand: string) => {
      if (viewMode !== "rich") return;
      const trimmed = rawCommand.trim();
      if (!trimmed) return;
      const lower = trimmed.toLowerCase();
      if (lower.startsWith("task list")) {
        const tokens = lower.split(/\s+/);
        const scopeToken = tokens[2];
        const statuses = new Set(["open", "claimed", "completed", "cancelled"]);
        let scope: string | undefined;
        let group: string | undefined;
        if (scopeToken === "mine") {
          scope = "mine";
        } else if (scopeToken && statuses.has(scopeToken)) {
          scope = scopeToken;
        } else if (scopeToken) {
          group = scopeToken;
        }
        setOverlay({
          type: "tasks",
          issuedFrom: trimmed,
          params: { scope: scope ?? "open", group },
        });
      } else if (/^board read \S+$/.test(lower)) {
        setOverlay({
          type: "board-posts",
          issuedFrom: trimmed,
          params: { name: trimmed.split(/\s+/)[2] },
        });
      } else if (/^channel history \S+/.test(lower)) {
        setOverlay({
          type: "channel-messages",
          issuedFrom: trimmed,
          params: { name: trimmed.split(/\s+/)[2] },
        });
      } else if (lower.startsWith("board list")) {
        setOverlay({ type: "boards", issuedFrom: trimmed });
      } else if (lower.startsWith("group list")) {
        setOverlay({ type: "groups", issuedFrom: trimmed });
      } else if (lower.startsWith("channel list") || lower.startsWith("channels list")) {
        setOverlay({ type: "channels", issuedFrom: trimmed });
      } else if (lower.startsWith("media jobs") || lower.startsWith("media status")) {
        const parts = trimmed.split(/\s+/);
        const entity = parts.length >= 3 ? parts.slice(2).join(" ").trim() || undefined : undefined;
        setOverlay({
          type: "media",
          issuedFrom: trimmed,
          params: entity ? { entityName: entity } : undefined,
        });
      } else if (lower === "code sessions" || lower === "code list") {
        setOverlay({ type: "coding-sessions", issuedFrom: trimmed });
      } else if (lower === "code artifacts" || lower.startsWith("code artifacts ")) {
        setOverlay({ type: "coding-artifacts", issuedFrom: trimmed });
      }
    },
    [viewMode],
  );

  const sendCommandWithOverlay = useCallback(
    (cmd: string) => {
      openOverlayForCommand(cmd);
      return sendChatCommand(cmd);
    },
    [openOverlayForCommand, sendChatCommand],
  );

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(MODE_STORAGE_KEY, viewMode);
    }
  }, [viewMode]);

  // Persist the active coding session id whenever the code-context (driven by
  // `session`-typed code events) reports a session. Clearing the modal — e.g.
  // via `code exit` — drops `code_context`, which clears the stored id too.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sessionId = codeContext?.sessionId ?? null;
    const key = codingSessionStorageKey(instanceName);
    try {
      if (sessionId) {
        window.localStorage.setItem(key, sessionId);
      } else if (codeContext === null) {
        // Code modal closed (code exit): forget the active session.
        window.localStorage.removeItem(key);
      }
    } catch {
      // ignore storage failures (private mode, quota)
    }
    setPersistedSessionId(sessionId);
  }, [codeContext, instanceName]);
  useEffect(() => {
    if (viewMode !== "rich" && overlay) {
      setOverlay(null);
    }
  }, [viewMode, overlay]);
  useEffect(() => {
    // Drop any expanded artifact when the artifacts overlay closes.
    if (overlay?.type !== "coding-artifacts") {
      setInspectedArtifactId(null);
    }
  }, [overlay]);

  const doSend = useCallback(() => {
    const raw = cmdValueRef.current.trim();
    const text = !codePrompt && raw.startsWith("/") ? raw.slice(1).trimStart() : raw;
    if (!text || (attachment && codePrompt)) return;
    const cmd = attachment ? attachedCommand(attachment, text, attachmentAgent) : text;
    if (!cmd) return;
    const ok = sendCommandWithOverlay(cmd);
    if (ok) {
      if (attachment) useWorkspaceState.getState().attach(null);
      historyIdxRef.current = -1;
      if (inputRef.current) {
        inputRef.current.value = "";
        inputRef.current.dispatchEvent(new Event("input", { bubbles: true }));
        inputRef.current.rows = 1;
        cmdValueRef.current = "";
      }
    }
  }, [sendCommandWithOverlay, attachment, attachmentAgent, codePrompt]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.nativeEvent.isComposing) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        doSend();
      } else if (e.key === "ArrowUp" && !cmdValueRef.current.includes("\n")) {
        e.preventDefault();
        if (historyIdxRef.current < commandHistory.length - 1) {
          historyIdxRef.current++;
          const val = commandHistory[historyIdxRef.current]!;
          cmdValueRef.current = val;
          if (inputRef.current) {
            inputRef.current.value = val;
            inputRef.current.rows = Math.min(6, val.split("\n").length);
          }
        }
      } else if (e.key === "ArrowDown" && !cmdValueRef.current.includes("\n")) {
        e.preventDefault();
        if (historyIdxRef.current > 0) {
          historyIdxRef.current--;
          const val = commandHistory[historyIdxRef.current]!;
          cmdValueRef.current = val;
          if (inputRef.current) {
            inputRef.current.value = val;
            inputRef.current.rows = Math.min(6, val.split("\n").length);
          }
        } else {
          historyIdxRef.current = -1;
          cmdValueRef.current = "";
          if (inputRef.current) inputRef.current.value = "";
        }
      }
    },
    [commandHistory, doSend],
  );

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
  const tasksQuery = useTasksSnapshot(viewMode === "rich" && overlay?.type === "tasks");
  const boardsQuery = useBoardsSnapshot(viewMode === "rich" && overlay?.type === "boards");
  const channelsQuery = useChannelsSnapshot(viewMode === "rich" && overlay?.type === "channels");
  const groupsQuery = useGroupsSnapshot(viewMode === "rich" && overlay?.type === "groups");
  const mediaEntity =
    overlay?.type === "media" ? (overlay.params?.entityName as string | undefined) : undefined;
  const mediaQuery = useMediaJobs(mediaEntity, viewMode === "rich" && overlay?.type === "media");
  const refetchMediaJobs = mediaQuery.refetch;
  const codingSessionsQuery = useCodingSessionsSnapshot(
    viewMode === "rich" && overlay?.type === "coding-sessions",
  );
  const codingDetailQuery = useCodingSessionDetail(
    activeCodingSessionId,
    viewMode === "rich" && overlay?.type === "coding-artifacts",
  );
  const refetchCodingDetail = codingDetailQuery.refetch;

  useEffect(() => {
    if (overlay?.type !== "coding-artifacts") return;
    const latest = messages.at(-1);
    const code = latest?.perception?.data?.code as CodeMessageData | undefined;
    if (code?.sessionId === activeCodingSessionId) void refetchCodingDetail();
  }, [activeCodingSessionId, messages, overlay, refetchCodingDetail]);

  useEffect(() => {
    if (overlay?.type === "media") {
      refetchMediaJobs();
    }
  }, [overlay, refetchMediaJobs]);

  useEffect(() => {
    if (overlay?.type === "media") {
      const latest = feedEvents[0];
      if (latest?.kind?.startsWith("media_")) {
        refetchMediaJobs();
      }
    }
  }, [feedEvents, overlay, refetchMediaJobs]);

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

  const renderTextContent = (text: string, className = "text-sm leading-relaxed text-text") => (
    <div
      className={`whitespace-pre-wrap ${className}`}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: content is escaped and sanitized before injection
      dangerouslySetInnerHTML={{
        __html: sanitizeChatHtml(linkifyHtml(escapeHtml(text))),
      }}
    />
  );

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

  const renderCodeContextStrip = () => {
    if (!codePrompt || !codeContext) return null;
    type Chip = {
      key: string;
      label: string;
      title: string;
      value: string;
      tone?: "accent" | "warn" | "lock";
      icon?: ReactNode;
    };
    // Write-lock holder. The entity `code_context` property is the always-live
    // source; the loaded session detail (when the artifacts overlay is open)
    // is a fallback. Both are read defensively — `writer` may be absent.
    const writer = codeContext.writer ?? codingDetailQuery.data?.session?.writer ?? undefined;
    const chips: Chip[] = (
      [
        {
          key: "session",
          label: "session",
          title: codeContext.sessionId ? `Session ${codeContext.sessionId}` : "No code session",
          value: codeContext.sessionId ?? "none",
        },
        codeContext.sessionStatus
          ? {
              key: "status",
              label: "status",
              title: `Session status ${codeContext.sessionStatus}`,
              value: codeContext.sessionStatus,
              tone: "accent",
            }
          : null,
        codeContext.workspace
          ? {
              key: "workspace",
              label: "cwd",
              title: `Workspace ${codeContext.workspace}`,
              value: codeContext.workspace,
            }
          : null,
        codeContext.modelTarget
          ? {
              key: "model",
              label: "model",
              title: `Code model target ${codeContext.modelTarget}`,
              value: codeContext.modelTarget,
            }
          : null,
        {
          key: "artifact",
          label: codeContext.latestArtifactKind ?? "artifact",
          title: codeContext.latestArtifactId
            ? `Latest ${codeContext.latestArtifactKind ?? "artifact"} ${codeContext.latestArtifactId}${
                codeContext.latestArtifactStatus ? ` (${codeContext.latestArtifactStatus})` : ""
              }${codeContext.latestArtifactLifecycle ? ` lifecycle ${codeContext.latestArtifactLifecycle}` : ""}`
            : "No artifacts",
          value: codeContext.latestArtifactId
            ? `${codeContext.latestArtifactId}${
                codeContext.latestArtifactStatus ? `:${codeContext.latestArtifactStatus}` : ""
              }${codeContext.latestArtifactLifecycle ? `:${codeContext.latestArtifactLifecycle}` : ""}`
            : "none",
        },
        typeof codeContext.pendingPatches === "number" && codeContext.pendingPatches > 0
          ? {
              key: "patches",
              label: "patches",
              title: `${codeContext.pendingPatches} pending patch${
                codeContext.pendingPatches === 1 ? "" : "es"
              }`,
              value: String(codeContext.pendingPatches),
              tone: "warn",
            }
          : null,
        codeContext.assignedAgent
          ? {
              key: "agent",
              label: "agent",
              title: `Assigned agent ${codeContext.assignedAgent}`,
              value: codeContext.assignedAgent,
            }
          : null,
        writer
          ? {
              key: "writer",
              label: "writer",
              title: `${writer} holds the write lock for this session`,
              value: writer,
              tone: "lock",
              icon: <Lock size={9} className="shrink-0" />,
            }
          : null,
      ] as (Chip | null)[]
    ).filter((chip): chip is Chip => chip !== null);
    return (
      <div className="mb-1 grid min-h-7 grid-cols-[auto_minmax(0,1fr)] items-center gap-1.5 font-mono text-[10px] text-text-dim">
        <span
          className="flex h-6 shrink-0 select-text items-center rounded border border-primary/40 bg-primary/10 px-1.5 font-semibold text-primary"
          title={`${codePrompt} mode prompt`}
        >
          {codePrompt}&gt;
        </span>
        <div className="flex min-w-0 select-text items-center gap-1 overflow-x-auto pb-0.5">
          {chips.map((chip) => (
            <span
              key={chip.key}
              className={`flex h-6 min-w-0 max-w-[10rem] shrink-0 items-center gap-1 rounded border px-1.5 sm:max-w-[14rem] ${
                chip.tone === "warn"
                  ? "border-yellow-500/40 bg-yellow-950/15 text-yellow-200"
                  : chip.tone === "accent"
                    ? "border-emerald-500/35 bg-emerald-950/15 text-emerald-200"
                    : chip.tone === "lock"
                      ? "border-amber-500/45 bg-amber-950/20 text-amber-200"
                      : "border-border/60 bg-bg/70 text-text-dim"
              }`}
              title={chip.title}
            >
              {chip.icon}
              <span className="shrink-0 text-[8px] font-semibold uppercase tracking-wide text-text-dim/80">
                {chip.label}
              </span>
              <span className="min-w-0 truncate text-[10px] text-current">{chip.value}</span>
            </span>
          ))}
        </div>
      </div>
    );
  };

  const {
    renderCodeBlock,
    renderApprovalCard,
    renderCrewDispatchedCard,
    renderSessionTaskChip,
    renderCodeMessage,
  } = createCodeRenderers({ copy, copied, sendCommandWithOverlay, renderTextContent });

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

  const renderTasksOverlay = () => {
    if (overlay?.type !== "tasks") return null;
    if (tasksQuery.isLoading) return <div className="py-4 text-text-dim">Loading tasks…</div>;
    if (tasksQuery.isError) {
      return <div className="py-4 text-danger">Failed to load tasks snapshot.</div>;
    }
    const scope = (overlay.params?.scope as string | undefined) ?? "open";
    const groupId = overlay.params?.group as string | undefined;
    const items = tasksQuery.data?.items ?? [];
    const total = tasksQuery.data?.total ?? items.length;
    const filtered =
      scope === "mine"
        ? items
        : items.filter((item) => item.status?.toLowerCase() === scope.toLowerCase());
    const counts = items.reduce<Record<string, number>>((acc, item) => {
      const key = (item.status ?? "unknown").toLowerCase();
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between text-[10px] uppercase text-text-dim">
          <span>
            Scope:{" "}
            {scope === "mine"
              ? "My claimed tasks (engine output)"
              : scope === "open"
                ? "Open"
                : scope.charAt(0).toUpperCase() + scope.slice(1)}
            {groupId ? ` · Group ${groupId}` : ""}
          </span>
          <span>
            {filtered.length} shown · total {total}
          </span>
        </div>
        {scope === "mine" && (
          <div className="rounded border border-warning/40 bg-warning/10 px-2 py-1 text-[10px] text-warning">
            Overlay filtering for <code>mine</code> mirrors the engine output; snapshot shows all
            tasks for quick context.
          </div>
        )}
        <div className="flex flex-wrap gap-2 text-[10px] text-text-dim">
          {Object.entries(counts).map(([status, count]) => (
            <span
              key={status}
              className="rounded border border-border/70 bg-bg px-2 py-0.5 capitalize text-text"
            >
              {status}: {count}
            </span>
          ))}
        </div>
        <div className="space-y-2">
          {filtered.map((task) => (
            <div key={task.id} className="rounded border border-border bg-bg px-3 py-2 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[12px] font-semibold text-text-bright">
                  {task.title}
                </span>
                <span className="text-[10px] uppercase text-primary">{task.status}</span>
              </div>
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-[10px] text-text-dim">
                <span>ID #{task.id}</span>
                <span>Created by {task.creator_name ?? "—"}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                <button
                  type="button"
                  className="rounded border border-border/70 bg-bg px-2 py-0.5 text-[10px] text-text transition-colors hover:border-primary hover:text-primary"
                  onClick={() => sendCommandWithOverlay(`task info ${task.id}`)}
                >
                  Info
                </button>
                <button
                  type="button"
                  className="rounded border border-border/70 bg-bg px-2 py-0.5 text-[10px] text-text transition-colors hover:border-primary hover:text-primary"
                  onClick={() => draftCommand(`task claim ${task.id}`)}
                >
                  Claim
                </button>
              </div>
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="rounded border border-border bg-bg px-2 py-3 text-[11px] text-text-dim">
              No tasks match this scope.
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderBoardsOverlay = () => {
    if (overlay?.type !== "boards") return null;
    if (boardsQuery.isLoading) return <div className="py-4 text-text-dim">Loading boards…</div>;
    if (boardsQuery.isError) {
      return <div className="py-4 text-danger">Failed to load boards snapshot.</div>;
    }
    const boards = boardsQuery.data ?? [];
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between text-[10px] uppercase text-text-dim">
          <span>Boards</span>
          <span>{boards.length} total</span>
        </div>
        <div className="space-y-2">
          {boards.map((board) => (
            <div key={board.id} className="rounded border border-border bg-bg px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-semibold text-text-bright">{board.name}</span>
                <span className="text-[10px] uppercase text-primary">
                  {board.scope_type ?? "general"}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between text-[10px] text-text-dim">
                <span>{board.postCount} posts</span>
                <button
                  type="button"
                  className="text-primary"
                  onClick={() => draftCommand(`board read ${board.name}`)}
                >
                  Draft read
                </button>
                <span>{new Date(board.created_at).toLocaleDateString()}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                <button
                  type="button"
                  className="text-xs text-primary"
                  onClick={() => draftCommand(`board post ${board.name} `)}
                >
                  Draft post
                </button>
                <button
                  type="button"
                  className="rounded border border-border/70 bg-bg px-2 py-0.5 text-[10px] text-text transition-colors hover:border-primary hover:text-primary"
                  onClick={() => sendCommandWithOverlay(`board read ${board.name}`)}
                >
                  Show board
                </button>
                <button
                  type="button"
                  className="rounded border border-border/70 bg-bg px-2 py-0.5 text-[10px] text-text transition-colors hover:border-primary hover:text-primary"
                  onClick={() => {
                    useWorkspaceState.getState().inspect({ type: "board", name: board.name });
                    closeOverlay();
                  }}
                >
                  Recent posts
                </button>
              </div>
            </div>
          ))}
          {boards.length === 0 && (
            <div className="rounded border border-border bg-bg px-2 py-3 text-[11px] text-text-dim">
              No boards available yet.
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderChannelsOverlay = () => {
    if (overlay?.type !== "channels") return null;
    if (channelsQuery.isLoading) return <div className="py-4 text-text-dim">Loading channels…</div>;
    if (channelsQuery.isError) {
      return <div className="py-4 text-danger">Failed to load channels snapshot.</div>;
    }
    const channels = channelsQuery.data ?? [];
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between text-[10px] uppercase text-text-dim">
          <span>Channels</span>
          <span>{channels.length} total</span>
        </div>
        <div className="space-y-2">
          {channels.map((channel) => (
            <div key={channel.id} className="rounded border border-border bg-bg px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-semibold text-text-bright">{channel.name}</span>
                <span className="text-[10px] uppercase text-primary">{channel.type}</span>
              </div>
              <div className="mt-1 flex items-center justify-between text-[10px] text-text-dim">
                <span>{channel.messageCount} messages</span>
                <span>ID {channel.id.slice(0, 8)}…</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                <button
                  type="button"
                  className="rounded border border-border/70 bg-bg px-2 py-0.5 text-[10px] text-text transition-colors hover:border-primary hover:text-primary"
                  onClick={() => draftCommand(`channel join ${channel.name}`)}
                >
                  Join
                </button>
                <button
                  type="button"
                  className="rounded border border-border/70 bg-bg px-2 py-0.5 text-[10px] text-text transition-colors hover:border-primary hover:text-primary"
                  onClick={() => sendCommandWithOverlay(`channel history ${channel.name}`)}
                >
                  History
                </button>
              </div>
            </div>
          ))}
          {channels.length === 0 && (
            <div className="rounded border border-border bg-bg px-2 py-3 text-[11px] text-text-dim">
              No channels available yet.
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderGroupsOverlay = () => {
    if (overlay?.type !== "groups") return null;
    if (groupsQuery.isLoading) return <div className="py-4 text-text-dim">Loading groups…</div>;
    if (groupsQuery.isError) {
      return <div className="py-4 text-danger">Failed to load groups snapshot.</div>;
    }
    const groups = groupsQuery.data ?? [];
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between text-[10px] uppercase text-text-dim">
          <span>Groups</span>
          <span>{groups.length} total</span>
        </div>
        <div className="space-y-2">
          {groups.map((group) => (
            <div key={group.id} className="rounded border border-border bg-bg px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-semibold text-text-bright">{group.name}</span>
                <span className="text-[10px] uppercase text-primary">
                  {group.memberCount} members
                </span>
              </div>
              <div className="mt-1 text-[10px] text-text-dim">
                Lead: {group.leader_id?.slice(0, 8) ?? "—"}
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                <button
                  type="button"
                  className="rounded border border-border/70 bg-bg px-2 py-0.5 text-[10px] text-text transition-colors hover:border-primary hover:text-primary"
                  onClick={() => sendCommandWithOverlay(`group members ${group.name}`)}
                >
                  Members
                </button>
                <button
                  type="button"
                  className="rounded border border-border/70 bg-bg px-2 py-0.5 text-[10px] text-text transition-colors hover:border-primary hover:text-primary"
                  onClick={() => sendCommandWithOverlay(`group info ${group.name}`)}
                >
                  Group info
                </button>
              </div>
            </div>
          ))}
          {groups.length === 0 && (
            <div className="rounded border border-border bg-bg px-2 py-3 text-[11px] text-text-dim">
              No groups defined yet.
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderMediaOverlay = () => {
    if (overlay?.type !== "media") return null;
    const targetEntity = overlay.params?.entityName as string | undefined;

    const handleRetry = async (job: MediaJob) => {
      try {
        const res = await authFetch(`${API_BASE}/api/media-jobs/${job.id}/retry`, {
          method: "POST",
        });
        if (!res.ok) throw new Error(`Retry failed (${res.status})`);
        await mediaQuery.refetch();
      } catch (error) {
        console.error("[media] retry failed", error);
      }
    };

    const handleDelete = async (job: MediaJob) => {
      if (!job.assetId) return;
      try {
        const res = await authFetch(`${API_BASE}/api/assets/${job.assetId}`, {
          method: "DELETE",
        });
        if (!res.ok) throw new Error(`Delete failed (${res.status})`);
        await mediaQuery.refetch();
      } catch (error) {
        console.error("[media] delete asset failed", error);
      }
    };

    return (
      <div className="space-y-3">
        {targetEntity && (
          <div className="text-[10px] uppercase text-text-dim">
            Jobs for <span className="text-text-bright">{targetEntity}</span>
          </div>
        )}
        {mediaQuery.isLoading && (
          <div className="rounded border border-border bg-bg px-2 py-3 text-[11px] text-text-dim">
            Loading media jobs…
          </div>
        )}
        {mediaQuery.isError && (
          <div className="rounded border border-border bg-bg px-2 py-3 text-[11px] text-danger">
            Failed to load media jobs.
          </div>
        )}
        {!mediaQuery.isLoading && !mediaQuery.isError && (
          <MediaJobsList
            jobs={mediaQuery.data ?? []}
            max={15}
            showEntity={!targetEntity}
            onRetry={handleRetry}
            onDeleteAsset={handleDelete}
            sendCommand={sendCommandWithOverlay}
            emptyMessage="No media jobs recorded yet."
          />
        )}
      </div>
    );
  };

  const renderCodingSessionsOverlay = () => {
    if (overlay?.type !== "coding-sessions") return null;
    if (codingSessionsQuery.isLoading) {
      return <div className="py-4 text-text-dim">Loading coding sessions…</div>;
    }
    if (codingSessionsQuery.isError) {
      return <div className="py-4 text-danger">Failed to load coding sessions snapshot.</div>;
    }
    const sessions = codingSessionsQuery.data?.items ?? [];
    const total = codingSessionsQuery.data?.total ?? sessions.length;
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between text-[10px] uppercase text-text-dim">
          <span>Coding sessions</span>
          <span>{total} total</span>
        </div>
        <div className="space-y-2">
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => {
                sendCommandWithOverlay(`code resume ${session.id}`);
                closeOverlay();
              }}
              className="block w-full rounded border border-border bg-bg px-3 py-2 text-left shadow-sm transition-colors hover:border-primary"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[12px] font-semibold text-text-bright">
                  {session.title || session.id}
                </span>
                <span
                  className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] uppercase ${codeStatusTone(
                    session.status,
                  )}`}
                >
                  {session.status}
                </span>
              </div>
              <div className="mt-1 truncate font-mono text-[10px] text-text-dim">
                {session.workspace_root}
              </div>
              <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-text-dim">
                <span className="font-mono">{session.id}</span>
                <span>updated {formatTimestamp(session.updated_at)}</span>
              </div>
            </button>
          ))}
          {sessions.length === 0 && (
            <div className="rounded border border-border bg-bg px-2 py-3 text-[11px] text-text-dim">
              No coding sessions yet. Run <code>code start</code> to begin one.
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderCodingArtifactsOverlay = () => {
    if (overlay?.type !== "coding-artifacts") return null;
    if (!activeCodingSessionId) {
      return (
        <div className="rounded border border-border bg-bg px-2 py-3 text-[11px] text-text-dim">
          No active coding session. Resume or start one to inspect its artifacts.
        </div>
      );
    }
    if (codingDetailQuery.isLoading) {
      return <div className="py-4 text-text-dim">Loading artifacts…</div>;
    }
    if (codingDetailQuery.isError) {
      return <div className="py-4 text-danger">Failed to load coding session detail.</div>;
    }
    const artifacts = codingDetailQuery.data?.artifacts ?? [];
    const session = codingDetailQuery.data?.session;
    const inspected = artifacts.find((a) => a.id === inspectedArtifactId) ?? null;
    const grouped = artifacts.reduce<Record<string, typeof artifacts>>((acc, artifact) => {
      (acc[artifact.kind] ??= []).push(artifact);
      return acc;
    }, {});
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between text-[10px] uppercase text-text-dim">
          <span>Artifacts · {session?.title || activeCodingSessionId}</span>
          <span>{artifacts.length} total</span>
        </div>
        {inspected && (
          <div className="rounded border border-primary/40 bg-primary/5 p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[11px] font-semibold text-text-bright">
                {inspected.title || inspected.id}
              </span>
              <button
                type="button"
                onClick={() => setInspectedArtifactId(null)}
                className="shrink-0 rounded border border-border/70 bg-bg px-2 py-0.5 text-[10px] text-text transition-colors hover:border-primary hover:text-primary"
              >
                Collapse
              </button>
            </div>
            {activeCodingSessionId && (
              <PinToCanvas
                reference={{ kind: "artifact", id: inspected.id, sessionId: activeCodingSessionId }}
              />
            )}
            {renderCodeBlock(
              inspected.content_text,
              inspected.content_text.startsWith("diff --git") ? "diff" : "text",
            )}
          </div>
        )}
        <div className="space-y-3">
          {Object.entries(grouped).map(([kind, group]) => (
            <div key={kind} className="space-y-1">
              <div className="text-[9px] font-semibold uppercase tracking-wide text-text-dim">
                {kind} · {group.length}
              </div>
              {group.map((artifact) => {
                const meta = parseMetadata(artifact.metadata_json);
                if (kind === "approval" || kind === "spawn_request") {
                  return (
                    <div key={artifact.id}>
                      {renderApprovalCard({
                        id: artifact.id,
                        kind: artifact.kind,
                        title: artifact.title,
                        status: artifact.status,
                        requestedBy:
                          artifact.created_by ??
                          (typeof meta.requestedBy === "string" ? meta.requestedBy : undefined),
                        decidedBy:
                          artifact.applied_by ??
                          (typeof meta.decidedBy === "string" ? meta.decidedBy : undefined),
                        decidedAt:
                          artifact.applied_at ??
                          (typeof meta.decidedAt === "number" ? meta.decidedAt : undefined),
                        description: artifact.content_text?.trim() || undefined,
                      })}
                    </div>
                  );
                }
                if (kind === "crew_dispatched") {
                  return (
                    <div key={artifact.id}>{renderCrewDispatchedCard(meta, artifact.title)}</div>
                  );
                }
                if (kind === "session_task") {
                  return <div key={artifact.id}>{renderSessionTaskChip(meta, artifact.title)}</div>;
                }
                return (
                  <button
                    key={artifact.id}
                    type="button"
                    onClick={() =>
                      setInspectedArtifactId((cur) => (cur === artifact.id ? null : artifact.id))
                    }
                    className={`block w-full rounded border bg-bg px-3 py-2 text-left transition-colors hover:border-primary ${
                      inspectedArtifactId === artifact.id ? "border-primary" : "border-border"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[12px] font-semibold text-text-bright">
                        {artifact.title || artifact.id}
                      </span>
                      <span
                        className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] uppercase ${codeStatusTone(
                          artifact.status,
                        )}`}
                      >
                        {artifact.status}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-text-dim">
                      <span className="font-mono">{artifact.id}</span>
                      <span>{formatTimestamp(artifact.updated_at)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
          {artifacts.length === 0 && (
            <div className="rounded border border-border bg-bg px-2 py-3 text-[11px] text-text-dim">
              No artifacts in this session yet.
            </div>
          )}
        </div>
      </div>
    );
  };

  const overlayTitle: Record<OverlayType, string> = {
    tasks: "Task Snapshot",
    boards: "Boards Snapshot",
    "board-posts": "Board posts",
    "channel-messages": "Channel messages",
    channels: "Channels Snapshot",
    groups: "Groups Snapshot",
    media: "Media Jobs",
    "coding-sessions": "Coding Sessions",
    "coding-artifacts": "Coding Artifacts",
  };

  const renderOverlayContent = () => {
    if (!overlay) return null;
    switch (overlay.type) {
      case "tasks":
        return renderTasksOverlay();
      case "boards":
        return renderBoardsOverlay();
      case "board-posts":
        return <BoardDetailView name={String(overlay.params?.name ?? "")} />;
      case "channel-messages":
        return <ChannelDetailView name={String(overlay.params?.name ?? "")} />;
      case "channels":
        return renderChannelsOverlay();
      case "groups":
        return renderGroupsOverlay();
      case "media":
        return renderMediaOverlay();
      case "coding-sessions":
        return renderCodingSessionsOverlay();
      case "coding-artifacts":
        return renderCodingArtifactsOverlay();
      default:
        return null;
    }
  };

  const statusOverlay =
    overlay && viewMode === "rich" ? (
      <StatusOverlay
        open
        title={overlayTitle[overlay.type]}
        onClose={closeOverlay}
        footer={
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="truncate text-text-dim">
              Command: <code className="text-text">{overlay.issuedFrom}</code>
              <FavoriteCommandButton command={overlay.issuedFrom} />
              <button
                type="button"
                onClick={() => draftCommand(overlay.issuedFrom)}
                className="ml-2 text-primary"
              >
                Copy command to input
              </button>
            </span>
            <button
              type="button"
              onClick={closeOverlay}
              className="rounded border border-border/70 bg-bg px-2 py-0.5 text-[10px] text-text transition-colors hover:border-primary hover:text-primary"
            >
              Close
            </button>
          </div>
        }
      >
        {renderOverlayContent()}
      </StatusOverlay>
    ) : null;

  return (
    <AssetViewerProvider>
      {statusOverlay}
      <GlassPanel
        title="Web Chat"
        icon={<MessageSquareText size={14} />}
        isFocused={isFocused}
        onToggleFocus={onToggleFocus}
        bodyScroll={false}
        headerExtra={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setViewMode((mode) => (mode === "compact" ? "rich" : "compact"));
              }}
              title={viewMode === "compact" ? "Switch to rich view" : "Switch to compact view"}
              className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] text-text-dim transition-colors hover:border-primary hover:text-primary"
            >
              {viewMode === "compact" ? <PanelsTopLeft size={11} /> : <List size={11} />}
              <span>{viewMode === "compact" ? "Rich view" : "Compact view"}</span>
            </button>
            {messages.length > 0 ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  copyAll();
                }}
                title="Copy whole conversation"
                className="flex items-center gap-1 text-text-dim text-[10px] transition-colors hover:text-primary"
              >
                {copied === "all" ? <Check size={11} /> : <Copy size={11} />}
                <span>{copied === "all" ? "Copied" : "Copy all"}</span>
              </button>
            ) : undefined}
          </div>
        }
      >
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Output */}
          <div
            ref={outputRef}
            className={`flex-1 overflow-y-auto px-2 py-1 ${
              viewMode === "compact"
                ? "font-mono text-[12px] leading-relaxed"
                : "font-sans text-[13px]"
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

          {codePrompt && (
            <CodingPalette
              prompt={codePrompt}
              hasSession={Boolean(activeCodingSessionId)}
              onExecute={sendCommandWithOverlay}
            />
          )}
          <ContextualCompass onExecute={sendCommandWithOverlay} />
          <CommandFavorites />

          {attachment && (
            <section
              className="mx-2 mb-2 rounded border border-primary/40 bg-primary/5 p-2 text-xs"
              aria-label="Attached canvas context"
            >
              <div className="flex justify-between gap-2">
                <button
                  type="button"
                  className="truncate text-primary"
                  onClick={() => openCanvas(attachment.canvasId, attachment.nodeId)}
                >
                  {attachment.title || "Canvas node"}
                </button>
                <button
                  type="button"
                  aria-label="Remove canvas context"
                  onClick={() => useWorkspaceState.getState().attach(null)}
                >
                  ×
                </button>
              </div>
              <p className="mt-1 text-text-dim">
                {attachment.mode === "discuss"
                  ? "Your message will be posted as a reply to this node."
                  : "Your message and this node reference will be sent to the selected agent."}
              </p>
              {attachment.mode === "ask" && (
                <select
                  aria-label="Agent to ask"
                  value={attachmentAgent}
                  onChange={(e) => setAttachmentAgent(e.target.value)}
                  className="mt-2 w-full rounded border border-border bg-bg p-1"
                >
                  <option value="">Choose an agent…</option>
                  {attachmentEntities
                    .filter((entity) => entity.kind === "agent")
                    .map((entity) => (
                      <option key={entity.name}>{entity.name}</option>
                    ))}
                </select>
              )}
              {codePrompt && (
                <p role="status" className="mt-2 text-warning">
                  Exit Code Mode to send a canvas message.{" "}
                  <button
                    type="button"
                    className="underline"
                    onClick={() => sendCommandWithOverlay("code exit")}
                  >
                    Exit Code Mode
                  </button>
                </p>
              )}
            </section>
          )}
          {/* Input area */}
          <div className="border-t border-border px-2 py-1.5">
            {!loggedIn ? (
              <div className="flex items-center gap-2">
                <input
                  id="marina-name-input"
                  ref={nameRef}
                  type="text"
                  onKeyDown={(e) => e.key === "Enter" && doLogin()}
                  placeholder="Enter your name..."
                  maxLength={20}
                  className="flex-1 rounded border border-border bg-bg px-2 py-1 text-[12px] text-text outline-none focus:border-primary"
                />
                <button
                  type="button"
                  onClick={doLogin}
                  className="rounded bg-primary px-2 py-1 text-[11px] font-bold text-bg"
                >
                  Connect
                </button>
              </div>
            ) : (
              <>
                {renderCodeContextStrip()}
                <CommandInputAssistance input={inputRef} codeMode={!!codePrompt} />
                <div className="flex items-center gap-1.5">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-success" : "bg-danger"}`}
                  />
                  {codePrompt && (
                    <span className="rounded border border-primary/50 bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-primary">
                      {codePrompt}&gt;
                    </span>
                  )}
                  <textarea
                    id="marina-command-input"
                    ref={inputRef}
                    rows={1}
                    title="Enter to send; Shift+Enter for a new line"
                    onChange={(e) => {
                      cmdValueRef.current = e.target.value;
                      e.target.rows = Math.min(6, e.target.value.split("\n").length);
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder={
                      attachment
                        ? "Write a message about this node…"
                        : codePrompt
                          ? `Type a ${codePrompt} command...`
                          : "Type a command..."
                    }
                    className="min-w-0 flex-1 resize-y rounded border border-border bg-bg px-2 py-1 text-[12px] text-text outline-none focus:border-primary"
                  />
                  <button
                    type="button"
                    aria-label="Pin current draft"
                    title="Pin current draft to favorites"
                    className="text-xs text-text-dim"
                    onClick={() => {
                      const command = cmdValueRef.current.trim();
                      if (command) favorites.toggle(command);
                    }}
                  >
                    Pin
                  </button>
                  <button
                    type="button"
                    onClick={doSend}
                    disabled={
                      !!attachment &&
                      (!!codePrompt || (attachment.mode === "ask" && !attachmentAgent))
                    }
                    aria-label="Send command"
                    className="text-primary transition-colors hover:text-text-bright"
                  >
                    <Send size={14} aria-hidden="true" />
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </GlassPanel>
    </AssetViewerProvider>
  );
}

function codePromptForProfile(profile: unknown): string {
  if (profile === "pi" || profile === "claude" || profile === "codex") return profile;
  return "code";
}

function codeContextFromProperty(value: unknown): CodeContextData | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  return {
    assignedAgent: typeof data.assignedAgent === "string" ? data.assignedAgent : undefined,
    latestArtifactId: typeof data.latestArtifactId === "string" ? data.latestArtifactId : undefined,
    latestArtifactKind:
      typeof data.latestArtifactKind === "string" ? data.latestArtifactKind : undefined,
    latestArtifactLifecycle:
      typeof data.latestArtifactLifecycle === "string" ? data.latestArtifactLifecycle : undefined,
    latestArtifactStatus:
      typeof data.latestArtifactStatus === "string" ? data.latestArtifactStatus : undefined,
    pendingPatches: typeof data.pendingPatches === "number" ? data.pendingPatches : undefined,
    profile: typeof data.profile === "string" ? data.profile : undefined,
    sessionId: typeof data.sessionId === "string" ? data.sessionId : undefined,
    sessionMode: typeof data.sessionMode === "string" ? data.sessionMode : undefined,
    sessionStatus: typeof data.sessionStatus === "string" ? data.sessionStatus : undefined,
    sessionTitle: typeof data.sessionTitle === "string" ? data.sessionTitle : undefined,
    workspace: typeof data.workspace === "string" ? data.workspace : undefined,
    writer: typeof data.writer === "string" ? data.writer : undefined,
  };
}
