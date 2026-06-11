import { Check, Copy, List, MessageSquareText, PanelsTopLeft, Send } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, StoredPerception } from "../hooks/use-chat-state";
import { ensureChatWs, getChatWs, useChatState } from "../hooks/use-chat-state";
import { useFeedState } from "../hooks/use-feed-state";
import { useWorldState } from "../hooks/use-world-state";
import { clearToken, setToken } from "../lib/api";
import { linkifyHtml } from "../lib/linkify";
import { parseSpeech } from "../lib/perception";
import { sanitizeChatHtml } from "../lib/sanitize";
import { CanvasNodeEmbed } from "./CanvasNodeEmbed";
import { GlassPanel } from "./GlassPanel";

const ANSI_COLORS: Record<string, string> = {
  "30": "#4d4d4d",
  "31": "#f44",
  "32": "#4e4",
  "33": "#fd0",
  "34": "#69f",
  "35": "#f6f",
  "36": "#0ff",
  "37": "#d4d4d4",
  "90": "#888",
  "91": "#f66",
  "92": "#8f8",
  "93": "#ff5",
  "94": "#8af",
  "95": "#f8f",
  "96": "#5ff",
  "97": "#fff",
};

const MODE_STORAGE_KEY = "marina-chat-mode";
type ChatViewMode = "compact" | "rich";

function escHtml(ch: string): string {
  if (ch === "&") return "&amp;";
  if (ch === "<") return "&lt;";
  if (ch === ">") return "&gt;";
  if (ch === '"') return "&quot;";
  return ch;
}

function escapeHtml(text: string): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    result += escHtml(text[i]!);
  }
  return result;
}

function ansiToHtml(text: string): string {
  let result = "";
  let i = 0;
  let openSpans = 0;
  while (i < text.length) {
    if (text[i] === "\x1b" && text[i + 1] === "[") {
      const end = text.indexOf("m", i + 2);
      if (end === -1) {
        result += escHtml(text[i]!);
        i++;
        continue;
      }
      const codes = text.substring(i + 2, end).split(";");
      i = end + 1;
      const styles: string[] = [];
      for (const code of codes) {
        if (code === "0" || code === "") {
          while (openSpans > 0) {
            result += "</span>";
            openSpans--;
          }
        } else if (code === "1") {
          styles.push("font-weight:bold");
        } else if (code === "3") {
          styles.push("font-style:italic");
        } else if (code === "4") {
          styles.push("text-decoration:underline");
        } else if (ANSI_COLORS[code]) {
          styles.push(`color:${ANSI_COLORS[code]}`);
        }
      }
      if (styles.length > 0) {
        result += `<span style="${styles.join(";")}">`;
        openSpans++;
      }
    } else {
      result += escHtml(text[i]!);
      i++;
    }
  }
  while (openSpans > 0) {
    result += "</span>";
    openSpans--;
  }
  return result;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI SGR codes so copied text is clean
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function formatTimestamp(ts?: number): string {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

interface RoomPerceptionData {
  name?: string;
  short?: string;
  long?: string;
  items?: Record<string, unknown>;
  entities?: { name?: string; short?: string }[];
  exits?: string[];
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

/** Plain-text for clipboard: prefer the stored text, else derive it from html. */
function messageText(m: { text?: string; html: string }): string {
  if (m.text != null) return m.text;
  const el = document.createElement("div");
  el.innerHTML = m.html;
  return el.textContent ?? "";
}

/** Best-effort clipboard write — clipboard API first, textarea+execCommand on
 * insecure contexts (http://…) where navigator.clipboard is unavailable. */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
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
  const p = raw as Perception;
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

export function WebChat() {
  const messages = useChatState((s) => s.messages);
  const loggedIn = useChatState((s) => s.loggedIn);
  const connected = useChatState((s) => s.connected);
  const commandHistory = useChatState((s) => s.commandHistory);
  const sendChatCommand = useChatState((s) => s.sendCommand);

  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const historyIdxRef = useRef(-1);
  const cmdValueRef = useRef("");

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

  const doLogin = useCallback(() => {
    const name = nameRef.current?.value.trim();
    if (!name) return;
    const ws = getChatWs();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "login", name }));
    }
  }, []);

  const doSend = useCallback(() => {
    const cmd = cmdValueRef.current.trim();
    if (!cmd) return;
    const ok = sendChatCommand(cmd);
    if (ok) {
      historyIdxRef.current = -1;
      if (inputRef.current) {
        inputRef.current.value = "";
        cmdValueRef.current = "";
      }
    }
  }, [sendChatCommand]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        doSend();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (historyIdxRef.current < commandHistory.length - 1) {
          historyIdxRef.current++;
          const val = commandHistory[historyIdxRef.current]!;
          cmdValueRef.current = val;
          if (inputRef.current) inputRef.current.value = val;
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (historyIdxRef.current > 0) {
          historyIdxRef.current--;
          const val = commandHistory[historyIdxRef.current]!;
          cmdValueRef.current = val;
          if (inputRef.current) inputRef.current.value = val;
        } else {
          historyIdxRef.current = -1;
          cmdValueRef.current = "";
          if (inputRef.current) inputRef.current.value = "";
        }
      }
    },
    [commandHistory, doSend],
  );

  const [viewMode, setViewMode] = useState<ChatViewMode>(() => {
    // Rich is the default for web/dashboard consumers; only an explicit
    // stored "compact" preference opts back into the dense log.
    if (typeof window === "undefined") return "rich";
    const stored = window.localStorage.getItem(MODE_STORAGE_KEY);
    return stored === "compact" ? "compact" : "rich";
  });

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(MODE_STORAGE_KEY, viewMode);
    }
  }, [viewMode]);

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

  const renderRichMessage = (m: ChatMessage, i: number) => {
    const perception = m.perception;
    if (!perception) return renderCompactMessage(m, i);
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
    <GlassPanel
      title="Web Chat"
      icon={<MessageSquareText size={14} />}
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

        <ContextualCompass />

        {/* Input area */}
        <div className="border-t border-border px-2 py-1.5">
          {!loggedIn ? (
            <div className="flex items-center gap-2">
              <input
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
            <div className="flex items-center gap-1.5">
              <span
                className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-success" : "bg-danger"}`}
              />
              <input
                ref={inputRef}
                type="text"
                onChange={(e) => {
                  cmdValueRef.current = e.target.value;
                }}
                onKeyDown={handleKeyDown}
                placeholder="Type a command..."
                className="flex-1 rounded border border-border bg-bg px-2 py-1 text-[12px] text-text outline-none focus:border-primary"
              />
              <button
                type="button"
                onClick={doSend}
                className="text-primary transition-colors hover:text-text-bright"
              >
                <Send size={14} />
              </button>
            </div>
          )}
        </div>
      </div>
    </GlassPanel>
  );
}

interface CompassSuggestion {
  key: string;
  label: string;
  hint?: string;
  mode: "command" | "prompt";
  command: string;
}

function ContextualCompass() {
  const loggedIn = useChatState((s) => s.loggedIn);
  const messages = useChatState((s) => s.messages);
  const sendCommand = useChatState((s) => s.sendCommand);
  const feedEvents = useFeedState((s) => s.events);
  const thinkingAgents = useWorldState((s) => s.thinkingAgents);

  const suggestions = useMemo(() => {
    if (!loggedIn) return [] as CompassSuggestion[];
    const recentFeed = feedEvents.slice(0, 30);
    const map = new Map<string, CompassSuggestion>();

    const add = (suggestion: CompassSuggestion) => {
      if (!map.has(suggestion.key)) {
        map.set(suggestion.key, suggestion);
      }
    };

    add({
      key: "brief",
      label: "Brief",
      hint: "Compass snapshot of entities and tasks",
      mode: "command",
      command: "brief",
    });

    add({
      key: "readiness",
      label: "Readiness",
      hint: "Capability health check",
      mode: "command",
      command: "readiness",
    });

    const agentNames = Object.keys(thinkingAgents);
    if (agentNames.length > 0) {
      add({
        key: `status-${agentNames[0]}`,
        label: `Status: ${agentNames[0]}`,
        hint: "Inspect the active agent's loop",
        mode: "command",
        command: `agent status ${agentNames[0]}`,
      });
    }

    if (recentFeed.some((event) => /task/i.test(event.summary))) {
      add({
        key: "tasks",
        label: "Tasks",
        hint: "Review coordination pipeline",
        mode: "command",
        command: "task list",
      });
    }

    if (recentFeed.some((event) => /intent/i.test(event.summary))) {
      add({
        key: "intents",
        label: "Canvas intents",
        hint: "View open work requests",
        mode: "command",
        command: "canvas intent list",
      });
    }

    if (recentFeed.some((event) => /chronicle/i.test(event.summary))) {
      add({
        key: "chronicle",
        label: "Chronicle",
        hint: "Check pending narration",
        mode: "command",
        command: "chronicle pending",
      });
    }

    const lastOtherMessage = [...messages]
      .reverse()
      .map((m) => ({ meta: parseSpeech(m.text, m.tag, m.perception), raw: m }))
      .find((m) => m.meta && m.meta.perspective === "other");
    if (lastOtherMessage?.meta?.speaker) {
      add({
        key: "reply",
        label: `Reply to ${lastOtherMessage.meta.speaker}`,
        hint:
          lastOtherMessage.meta.body?.slice(0, 80) ?? `Respond to ${lastOtherMessage.meta.speaker}`,
        mode: "prompt",
        command: "say ",
      });
    }

    return Array.from(map.values());
  }, [feedEvents, loggedIn, messages, thinkingAgents]);

  if (!loggedIn || suggestions.length === 0) return null;

  const runCommand = (command: string) => {
    if (!sendCommand(command)) {
      window.alert("Unable to send command — chat is not connected.");
    }
  };

  return (
    <div className="border-t border-border px-2 py-1.5 text-[11px] text-text">
      <div className="flex items-center justify-between text-[10px] uppercase text-text-dim">
        <span>Contextual compass</span>
        <span>{suggestions.length} suggestions</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion.key}
            type="button"
            onClick={() => {
              if (suggestion.mode === "command") {
                runCommand(suggestion.command);
              } else {
                const reply = window.prompt(suggestion.hint ?? suggestion.label, "");
                const trimmed = reply?.trim();
                if (trimmed) {
                  runCommand(`${suggestion.command}${trimmed}`);
                }
              }
            }}
            className="rounded border border-border bg-bg px-2 py-0.5 text-[10px] text-text hover:border-primary hover:text-primary transition-colors"
            title={suggestion.hint}
          >
            {suggestion.label}
          </button>
        ))}
      </div>
    </div>
  );
}
