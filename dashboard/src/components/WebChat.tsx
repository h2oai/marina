import {
  Check,
  CheckCircle2,
  Code2,
  Copy,
  FileText,
  GitBranch,
  GitPullRequest,
  List,
  MessageSquareText,
  Network,
  PanelsTopLeft,
  Send,
  Sparkles,
  Terminal,
  Users,
  XCircle,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMediaJobs } from "../hooks/use-api";
import type { ChatMessage, StoredPerception } from "../hooks/use-chat-state";
import { ensureChatWs, getChatWs, useChatState } from "../hooks/use-chat-state";
import { useCodingSessionDetail, useCodingSessionsSnapshot } from "../hooks/use-coding";
import { useFeedState } from "../hooks/use-feed-state";
import {
  useBoardsSnapshot,
  useChannelsSnapshot,
  useGroupsSnapshot,
  useTasksSnapshot,
} from "../hooks/use-status-cards";
import { useWorldState } from "../hooks/use-world-state";
import { authFetch, clearToken, setToken } from "../lib/api";
import { linkifyHtml } from "../lib/linkify";
import { parseSpeech } from "../lib/perception";
import { sanitizeChatHtml } from "../lib/sanitize";
import type { MediaJob } from "../lib/types";
import { AssetViewerProvider } from "./AssetLightbox";
import { CanvasNodeEmbed } from "./CanvasNodeEmbed";
import { GlassPanel, type PanelFocusProps } from "./GlassPanel";
import { MediaJobsList } from "./MediaJobsList";
import { StatusOverlay } from "./StatusOverlay";

const API_BASE = window.location.origin;

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
const CODING_SESSION_STORAGE_PREFIX = "marina-coding-session:";
type ChatViewMode = "compact" | "rich";

/** Active coding session id is persisted per instance, like the tour-seen flag. */
function codingSessionStorageKey(instanceName: string | null | undefined): string {
  return `${CODING_SESSION_STORAGE_PREFIX}${instanceName ?? "default"}`;
}

type OverlayType =
  | "tasks"
  | "boards"
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

function codeStatusTone(status?: string): string {
  if (!status) return "border-border/70 bg-bg/45 text-text";
  if (["failed", "denied", "rejected"].includes(status)) {
    return "border-red-500/40 bg-red-950/15 text-red-200";
  }
  if (["pending", "warn", "planned"].includes(status)) {
    return "border-yellow-500/40 bg-yellow-950/15 text-yellow-100";
  }
  if (["applied", "complete", "completed", "ok", "passed", "pinned"].includes(status)) {
    return "border-emerald-500/30 bg-emerald-950/10 text-emerald-100";
  }
  return "border-border/70 bg-bg/45 text-text";
}

function diffStats(
  content: string,
): { additions: number; deletions: number; files: number } | null {
  if (!content.startsWith("diff --git")) return null;
  let additions = 0;
  let deletions = 0;
  let files = 0;
  for (const line of content.split("\n")) {
    if (line.startsWith("diff --git ")) files++;
    else if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions, files };
}

/** Parse a metadata blob that may arrive as a JSON string or an already-parsed
 * object (events vs. artifact rows differ). Never throws. */
function parseMetadata(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object") return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** Approve/deny status badge classes. pending=amber, approved=emerald, denied/rejected=red. */
function approvalBadgeTone(status?: string): string {
  const s = (status ?? "").toLowerCase();
  if (s === "approved" || s === "applied")
    return "border-emerald-500/40 bg-emerald-500/15 text-emerald-300";
  if (s === "denied" || s === "rejected" || s === "failed")
    return "border-red-500/40 bg-red-500/15 text-red-300";
  return "border-yellow-500/40 bg-yellow-500/15 text-yellow-200";
}

/** Crew member rows arrive as [{ agentName, role }]; tolerate partial/loose shapes. */
function parseCrewMembers(value: unknown): { agentName: string; role?: string }[] {
  if (!Array.isArray(value)) return [];
  const members: { agentName: string; role?: string }[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    const agentName =
      typeof m.agentName === "string"
        ? m.agentName
        : typeof m.name === "string"
          ? m.name
          : typeof m.agent === "string"
            ? m.agent
            : undefined;
    if (!agentName) continue;
    members.push({ agentName, role: typeof m.role === "string" ? m.role : undefined });
  }
  return members;
}

interface RoomPerceptionData {
  name?: string;
  short?: string;
  long?: string;
  items?: Record<string, unknown>;
  entities?: { name?: string; short?: string }[];
  exits?: string[];
}

interface CodeTreeNode {
  active?: boolean;
  children?: CodeTreeNode[];
  id?: string;
  status?: string;
  title?: string;
}

interface CodeMessageData {
  appliedAt?: number | null;
  appliedBy?: string | null;
  artifactId?: string;
  artifactKind?: string;
  createdBy?: string;
  metadata?: Record<string, unknown> | string | null;
  checks?: {
    detail?: string;
    label?: string;
    status?: "fail" | "info" | "ok" | "warn";
  }[];
  command?: string[];
  commands?: string[];
  content?: string;
  durationMs?: number;
  event?: string;
  events?: {
    actor?: string;
    kind?: string;
    payload?: string;
    timestamp?: number;
  }[];
  exitCode?: number;
  modelTarget?: string;
  parentSessionId?: string;
  paths?: string[];
  query?: string;
  rows?: {
    action?: string;
    canonical?: string;
    detail?: string;
    grade?: string;
    id?: string;
    kind?: string;
    line?: number;
    portability?: string;
    path?: string;
    size?: number;
    status?: string;
    text?: string;
    title?: string;
    type?: string;
  }[];
  sessionId?: string;
  status?: string;
  timedOut?: boolean;
  title?: string;
  tree?: CodeTreeNode[];
  truncated?: boolean;
  type?:
    | "approval"
    | "artifact"
    | "command"
    | "crew"
    | "diff"
    | "file"
    | "history"
    | "list"
    | "model"
    | "note"
    | "patch"
    | "profile"
    | "readiness"
    | "search"
    | "session"
    | "skill"
    | "tree"
    | "verification";
  workspace?: string;
}

interface CodeContextData {
  assignedAgent?: string;
  latestArtifactId?: string;
  latestArtifactKind?: string;
  latestArtifactLifecycle?: string;
  latestArtifactStatus?: string;
  modelTarget?: string;
  pendingPatches?: number;
  profile?: string;
  sessionId?: string;
  sessionMode?: string;
  sessionStatus?: string;
  sessionTitle?: string;
  workspace?: string;
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

export function WebChat({ isFocused, onToggleFocus }: PanelFocusProps = {}) {
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
    const cmd = cmdValueRef.current.trim();
    if (!cmd) return;
    const ok = sendCommandWithOverlay(cmd);
    if (ok) {
      historyIdxRef.current = -1;
      if (inputRef.current) {
        inputRef.current.value = "";
        cmdValueRef.current = "";
      }
    }
  }, [sendCommandWithOverlay]);

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
      tone?: "accent" | "warn";
    };
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
                    : "border-border/60 bg-bg/70 text-text-dim"
              }`}
              title={chip.title}
            >
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

  const renderCodeActions = (commands?: string[]) => {
    const actionable = (commands ?? []).filter((cmd) => cmd && !cmd.includes("<"));
    if (actionable.length === 0) return null;
    return (
      <div className="mt-2 flex flex-wrap gap-1.5">
        {actionable.map((cmd) => (
          <button
            key={cmd}
            type="button"
            onClick={() => sendCommandWithOverlay(cmd)}
            className="rounded border border-primary/40 bg-primary/10 px-2 py-0.5 font-mono text-[10px] text-primary transition-colors hover:border-primary hover:bg-primary/20"
          >
            {cmd}
          </button>
        ))}
      </div>
    );
  };

  const renderCodeBlock = (content: string, variant: "diff" | "output" | "text") => {
    const lines = content.trimEnd().split("\n");
    const stats = diffStats(content);
    return (
      <div className="mt-2 overflow-hidden rounded border border-border/70 bg-black/30">
        <div className="flex items-center justify-between gap-2 border-border/60 border-b px-2 py-1 font-mono text-[10px] text-text-dim">
          <span>{variant === "diff" ? "patch" : variant === "output" ? "output" : "text"}</span>
          <span>
            {stats
              ? `${stats.files} file${stats.files === 1 ? "" : "s"} +${stats.additions} -${stats.deletions}`
              : `${lines.length} line${lines.length === 1 ? "" : "s"}`}
          </span>
        </div>
        <pre className="max-h-[420px] overflow-auto p-2 font-mono text-[11px] leading-relaxed text-text">
          {lines.map((line, idx) => {
            const color =
              variant === "diff" && line.startsWith("+") && !line.startsWith("+++")
                ? "text-emerald-300"
                : variant === "diff" && line.startsWith("-") && !line.startsWith("---")
                  ? "text-red-300"
                  : variant === "diff" && line.startsWith("@@")
                    ? "text-cyan-300"
                    : variant === "diff" &&
                        (line.startsWith("diff --git") ||
                          line.startsWith("---") ||
                          line.startsWith("+++"))
                      ? "text-primary"
                      : variant === "output" && line === "--- stderr ---"
                        ? "text-yellow-200"
                        : "text-text";
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: rendered terminal blocks preserve line order; content has no stable ids
                key={idx}
                className={`grid grid-cols-[3ch_minmax(0,1fr)] gap-2 whitespace-pre-wrap break-words ${color}`}
              >
                <span className="select-none text-right text-text-dim/50">{idx + 1}</span>
                <span>{line || " "}</span>
              </div>
            );
          })}
        </pre>
      </div>
    );
  };

  const renderCodeTree = (nodes: CodeTreeNode[] | undefined, depth = 0): ReactNode => {
    if (!nodes || nodes.length === 0) return null;
    return (
      <div className={depth === 0 ? "mt-2 space-y-1" : "mt-1 space-y-1"}>
        {nodes.map((node) => (
          <div key={node.id ?? `${depth}-${node.title}`} className="font-mono text-[11px]">
            <div
              className={`flex items-center gap-1.5 rounded px-2 py-1 ${
                node.active ? "border border-primary/50 bg-primary/10 text-primary" : "text-text"
              }`}
              style={{ marginLeft: depth * 14 }}
            >
              <GitBranch size={12} />
              <span className="font-semibold">{node.id}</span>
              <span className="rounded bg-bg-hover px-1 py-0.5 text-[9px] text-text-dim">
                {node.status}
              </span>
              <span className="truncate">{node.title}</span>
            </div>
            {renderCodeTree(node.children, depth + 1)}
          </div>
        ))}
      </div>
    );
  };

  const renderCodeChecks = (checks: CodeMessageData["checks"]) => {
    if (!checks || checks.length === 0) return null;
    return (
      <div className="mt-2 grid gap-1 sm:grid-cols-2">
        {checks.map((check) => {
          const tone =
            check.status === "fail"
              ? "border-red-500/40 bg-red-950/15 text-red-200"
              : check.status === "warn"
                ? "border-yellow-500/40 bg-yellow-950/15 text-yellow-100"
                : check.status === "ok"
                  ? "border-emerald-500/30 bg-emerald-950/10 text-emerald-100"
                  : "border-border/70 bg-bg/60 text-text";
          return (
            <div
              key={`${check.label}-${check.detail}`}
              className={`rounded border px-2 py-1 text-[11px] ${tone}`}
            >
              <div className="font-semibold">{check.label}</div>
              {check.detail && (
                <div className="mt-0.5 break-words text-text-dim">{check.detail}</div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const renderCodeRows = (rows: CodeMessageData["rows"]) => {
    if (!rows || rows.length === 0) return null;
    return (
      <div className="mt-2 overflow-hidden rounded border border-border/70">
        {rows.map((row, idx) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: command result rows are display-only and preserve server order
            key={`${row.id ?? row.path ?? row.title ?? row.text}-${idx}`}
            className={`grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-b px-2 py-1.5 last:border-b-0 ${codeStatusTone(
              row.status,
            )}`}
          >
            <div className="min-w-0">
              <div className="truncate font-mono text-[11px] text-text">
                {row.action
                  ? `${row.action}: ${row.title ?? row.text ?? ""}`
                  : row.path
                    ? `${row.path}${row.line ? `:${row.line}` : ""}`
                    : row.title || row.id}
              </div>
              {(row.text || row.detail) && (
                <div className="mt-0.5 break-words text-[11px] text-text-dim">
                  {row.text || row.detail}
                </div>
              )}
              {(row.canonical || row.portability) && (
                <div className="mt-0.5 break-words font-mono text-[10px] text-text-dim">
                  {[row.canonical, row.portability].filter(Boolean).join(" | ")}
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1 text-[9px] uppercase tracking-wide text-text-dim">
              {row.kind && <span>{row.kind}</span>}
              {row.grade && <span>{row.grade}</span>}
              {row.status && <span className="rounded bg-bg-hover px-1 py-0.5">{row.status}</span>}
              {typeof row.size === "number" && <span>{row.size}b</span>}
            </div>
          </div>
        ))}
      </div>
    );
  };

  const renderCodeEvents = (events: CodeMessageData["events"]) => {
    if (!events || events.length === 0) return null;
    return (
      <div className="mt-2 space-y-1 rounded border border-border/70 bg-bg/40 p-2">
        {events.map((event, idx) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: event rows preserve chronological server order
            key={`${event.kind}-${event.timestamp}-${idx}`}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-2 font-mono text-[10px] text-text-dim"
          >
            <span>{event.timestamp ? formatTimestamp(event.timestamp) : ""}</span>
            <span className="truncate text-text">{event.kind}</span>
            <span className="truncate">{event.actor}</span>
          </div>
        ))}
      </div>
    );
  };

  // ── Phase 3/4 cards ──────────────────────────────────────────────
  // Interactive approve/deny card. Used for `approval` + `spawn_request`
  // artifacts in both the transcript and the artifacts overlay. Decision
  // buttons send through the existing command path; once decided the card
  // shows a read-only, multiuser-aware decision line.
  const renderApprovalCard = (props: {
    id: string;
    kind: string;
    title?: string;
    status?: string;
    requestedBy?: string;
    decidedBy?: string | null;
    decidedAt?: number | null;
    description?: string;
  }) => {
    const status = (props.status ?? "pending").toLowerCase();
    const pending = status === "pending";
    const Icon = props.kind === "spawn_request" ? Users : GitPullRequest;
    return (
      <div className="mt-2 rounded-md border border-border/70 bg-bg/50 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold text-text-bright">
            <Icon size={13} className="shrink-0 text-primary" />
            <span className="truncate">{props.title || `Approval ${props.id}`}</span>
          </div>
          <span
            className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-wide ${approvalBadgeTone(status)}`}
          >
            {status}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[10px] text-text-dim">
          <span>{props.id}</span>
          <span className="rounded bg-bg-hover px-1 py-0.5">{props.kind}</span>
          {props.requestedBy && <span>by {props.requestedBy}</span>}
        </div>
        {props.description && (
          <div className="mt-1.5 whitespace-pre-wrap break-words text-[11px] text-text">
            {props.description}
          </div>
        )}
        {pending ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => sendCommandWithOverlay(`code approve ${props.id}`)}
              className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-0.5 text-[10px] font-semibold text-emerald-300 transition-colors hover:border-emerald-400 hover:bg-emerald-500/20"
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => sendCommandWithOverlay(`code deny ${props.id}`)}
              className="rounded border border-red-500/40 bg-red-500/10 px-2.5 py-0.5 text-[10px] font-semibold text-red-300 transition-colors hover:border-red-400 hover:bg-red-500/20"
            >
              Deny
            </button>
          </div>
        ) : (
          <div className="mt-2 text-[10px] text-text-dim">
            {status === "denied" || status === "rejected" ? "denied" : "approved"}
            {props.decidedBy ? ` by ${props.decidedBy}` : ""}
            {props.decidedAt ? ` · ${formatTimestamp(props.decidedAt)}` : ""}
          </div>
        )}
      </div>
    );
  };

  // "Crew dispatched" card — a real crew was created + the goal posted.
  const renderCrewDispatchedCard = (meta: Record<string, unknown>, fallbackTitle?: string) => {
    const crewName =
      typeof meta.crewName === "string"
        ? meta.crewName
        : typeof meta.crewId === "string"
          ? meta.crewId
          : fallbackTitle || "Crew";
    const goal = typeof meta.goal === "string" ? meta.goal : undefined;
    const formation = typeof meta.formation === "string" ? meta.formation : undefined;
    const channelId = typeof meta.channelId === "string" ? meta.channelId : undefined;
    const members = parseCrewMembers(meta.members);
    return (
      <div className="mt-2 rounded-md border border-border/70 bg-bg/50 p-3">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-text-bright">
          <Network size={13} className="shrink-0 text-primary" />
          <span className="truncate">Crew dispatched · {crewName}</span>
          {formation && (
            <span className="rounded bg-bg-hover px-1 py-0.5 font-mono text-[9px] text-text-dim">
              {formation}
            </span>
          )}
        </div>
        {goal && <div className="mt-1.5 break-words text-[11px] text-text">{goal}</div>}
        {members.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {members.map((member) => (
              <span
                key={member.agentName}
                className="flex items-center gap-1 rounded border border-border/60 bg-bg px-2 py-0.5 text-[10px] text-text-dim"
              >
                <Code2 size={10} className="text-primary" />
                <span className="text-text">{member.agentName}</span>
                {member.role && <span className="text-text-dim">· {member.role}</span>}
              </span>
            ))}
          </div>
        )}
        {channelId && (
          <div className="mt-2 font-mono text-[10px] text-text-dim">channel {channelId}</div>
        )}
      </div>
    );
  };

  // "Linked task #<id>" chip for session_task artifacts.
  const renderSessionTaskChip = (meta: Record<string, unknown>, fallbackTitle?: string) => {
    const taskId =
      typeof meta.taskId === "number" || typeof meta.taskId === "string"
        ? String(meta.taskId)
        : undefined;
    const title = typeof meta.title === "string" ? meta.title : fallbackTitle;
    return (
      <div className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-md border border-primary/35 bg-primary/5 px-2.5 py-1 text-[11px] text-text">
        <List size={12} className="shrink-0 text-primary" />
        <span className="truncate">
          Linked task{taskId ? ` #${taskId}` : ""}
          {title ? `: ${title}` : ""}
        </span>
        {taskId && (
          <button
            type="button"
            onClick={() => sendCommandWithOverlay(`task info ${taskId}`)}
            className="shrink-0 rounded border border-border/70 bg-bg px-1.5 py-0.5 text-[9px] text-text-dim transition-colors hover:border-primary hover:text-primary"
          >
            Info
          </button>
        )}
      </div>
    );
  };

  const renderCodeMessage = (
    m: ChatMessage,
    i: number,
    _perception: StoredPerception,
    code: CodeMessageData,
  ) => {
    const type = code.type ?? "artifact";
    const status = code.status ?? (code.exitCode === 0 ? "complete" : undefined);
    const failed =
      status === "failed" ||
      code.event?.includes("failed") ||
      (typeof code.exitCode === "number" && code.exitCode !== 0);
    const Icon =
      type === "command"
        ? Terminal
        : type === "verification"
          ? failed
            ? XCircle
            : CheckCircle2
          : type === "readiness"
            ? CheckCircle2
            : type === "patch"
              ? GitPullRequest
              : type === "tree"
                ? GitBranch
                : type === "session"
                  ? Code2
                  : type === "model"
                    ? Network
                    : type === "skill"
                      ? Sparkles
                      : type === "profile"
                        ? List
                        : FileText;
    const title =
      type === "command"
        ? `$ ${(code.command ?? []).join(" ")}`
        : (code.title ?? code.event?.replace(/_/g, " ") ?? "Code");
    const content = typeof code.content === "string" ? code.content : "";
    const blockVariant =
      type === "patch" || content.startsWith("diff --git")
        ? "diff"
        : type === "command"
          ? "output"
          : "text";

    // Phase 3/4: route by artifact kind (the reliable discriminator the backend
    // sets on every code message), falling back to the type union. These kinds
    // get a dedicated interactive/structured card instead of the default chips.
    const artifactKind = code.artifactKind ?? (type === "approval" || type === "crew" ? type : "");
    const cardMeta = parseMetadata(code.metadata);
    const isApprovalCard =
      (artifactKind === "approval" || artifactKind === "spawn_request") && Boolean(code.artifactId);
    const isCrewDispatchedCard = artifactKind === "crew_dispatched";
    const isSessionTaskCard = artifactKind === "session_task";

    return (
      <div
        key={i}
        className={`group relative my-1 rounded-md border px-3 py-2 shadow-sm ${
          failed ? "border-red-500/50 bg-red-950/15" : "border-primary/35 bg-primary/5"
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 text-[10px] uppercase tracking-wide text-text-dim">
              <span className="flex items-center gap-1 text-primary">
                <Icon size={12} />
                {type}
              </span>
              {status && (
                <span
                  className={`rounded px-1.5 py-0.5 text-[9px] ${
                    failed
                      ? "bg-red-500/15 text-red-300"
                      : status === "pending" || status === "planned"
                        ? "bg-yellow-500/15 text-yellow-200"
                        : "bg-emerald-500/15 text-emerald-300"
                  }`}
                >
                  {status}
                </span>
              )}
              {code.artifactId && (
                <span className="font-mono text-text-dim">{code.artifactId}</span>
              )}
              {code.sessionId && <span className="font-mono text-text-dim">{code.sessionId}</span>}
              {code.modelTarget && (
                <span className="rounded bg-bg-hover px-1.5 py-0.5 font-mono text-[9px] text-text-dim">
                  {code.modelTarget}
                </span>
              )}
            </div>
            <div className="mt-1 truncate text-sm font-semibold text-text-bright">{title}</div>
          </div>
          <span className="shrink-0 text-[9px] uppercase tracking-wide text-text-dim/70">
            {formatTimestamp(m.timestamp)}
          </span>
        </div>

        {code.parentSessionId && (
          <div className="mt-1 font-mono text-[10px] text-text-dim">
            parent {code.parentSessionId}
          </div>
        )}
        {code.workspace && (
          <div className="mt-1 truncate font-mono text-[10px] text-text-dim">{code.workspace}</div>
        )}
        {code.paths && code.paths.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {code.paths.map((path) => (
              <span
                key={path}
                className="rounded border border-border/60 bg-bg px-1.5 py-0.5 font-mono text-[10px] text-text-dim"
              >
                {path}
              </span>
            ))}
          </div>
        )}
        {isApprovalCard ? (
          renderApprovalCard({
            id: code.artifactId ?? "",
            kind: artifactKind,
            title: code.title,
            status,
            requestedBy:
              code.createdBy ??
              (typeof cardMeta.requestedBy === "string" ? cardMeta.requestedBy : undefined),
            decidedBy:
              code.appliedBy ??
              (typeof cardMeta.decidedBy === "string" ? cardMeta.decidedBy : undefined),
            decidedAt:
              code.appliedAt ??
              (typeof cardMeta.decidedAt === "number" ? cardMeta.decidedAt : undefined),
            description: content.trim() || (m.text ?? "").trim() || undefined,
          })
        ) : isCrewDispatchedCard ? (
          renderCrewDispatchedCard(cardMeta, code.title)
        ) : isSessionTaskCard ? (
          renderSessionTaskChip(cardMeta, code.title)
        ) : (
          <>
            {type === "tree" ? renderCodeTree(code.tree) : null}
            {renderCodeChecks(code.checks)}
            {renderCodeRows(code.rows)}
            {renderCodeEvents(code.events)}
            {content.trim()
              ? renderCodeBlock(content, blockVariant)
              : type !== "tree" && type !== "profile"
                ? renderTextContent(m.text ?? "", "mt-2 text-sm text-text")
                : null}
            {(typeof code.exitCode === "number" || typeof code.durationMs === "number") && (
              <div className="mt-2 flex flex-wrap gap-2 font-mono text-[10px] text-text-dim">
                {typeof code.exitCode === "number" && <span>exit {code.exitCode}</span>}
                {typeof code.durationMs === "number" && <span>{code.durationMs}ms</span>}
                {code.timedOut && <span className="text-red-300">timed out</span>}
                {code.truncated && <span>truncated</span>}
              </div>
            )}
            {renderCodeActions(code.commands)}
          </>
        )}
        <button
          type="button"
          onClick={() => copy(messageText(m), i)}
          title="Copy message"
          aria-label="Copy message"
          className="absolute right-2 top-2 rounded p-0.5 text-text-dim opacity-0 transition-opacity hover:text-primary focus:opacity-100 group-hover:opacity-100"
        >
          {copied === i ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
    );
  };

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
                  onClick={() => sendCommandWithOverlay(`task claim ${task.id}`)}
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
                <span>{new Date(board.created_at).toLocaleDateString()}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                <button
                  type="button"
                  className="rounded border border-border/70 bg-bg px-2 py-0.5 text-[10px] text-text transition-colors hover:border-primary hover:text-primary"
                  onClick={() => sendCommandWithOverlay(`board show ${board.name}`)}
                >
                  Show board
                </button>
                <button
                  type="button"
                  className="rounded border border-border/70 bg-bg px-2 py-0.5 text-[10px] text-text transition-colors hover:border-primary hover:text-primary"
                  onClick={() => sendCommandWithOverlay(`board posts ${board.name}`)}
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
                  onClick={() => sendCommandWithOverlay(`channel join ${channel.name}`)}
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
              <>
                {renderCodeContextStrip()}
                <div className="flex items-center gap-1.5">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-success" : "bg-danger"}`}
                  />
                  {codePrompt && (
                    <span className="rounded border border-primary/50 bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-primary">
                      {codePrompt}&gt;
                    </span>
                  )}
                  <input
                    ref={inputRef}
                    type="text"
                    onChange={(e) => {
                      cmdValueRef.current = e.target.value;
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder={
                      codePrompt ? `Type a ${codePrompt} command...` : "Type a command..."
                    }
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
  };
}

interface CodingVerb {
  verb: string;
  hint: string;
  /** When true, the verb needs an argument: prompt for it before sending. */
  arg?: string;
}

// Canonical Code Mode verbs (MVP). The per-profile alias map lives server-side
// in the entity's `code_profile_aliases` property and is not exposed to the
// dashboard client, so we surface the canonical verbs that every profile maps
// onto — the profile prompt itself (claude>/codex>/pi>/code>) signals vocab.
const CODING_PALETTE_VERBS: CodingVerb[] = [
  { verb: "start", hint: "Start a coding session", arg: "title" },
  { verb: "files", hint: "List workspace files" },
  { verb: "read", hint: "Read a file", arg: "path" },
  { verb: "search", hint: "Search the workspace", arg: "query" },
  { verb: "diff", hint: "Review pending changes" },
  { verb: "run", hint: "Run a command", arg: "command" },
  { verb: "verify", hint: "Run verification checks" },
  { verb: "patch", hint: "Propose a patch", arg: "instruction" },
  { verb: "approve", hint: "Approve a pending artifact", arg: "id" },
  { verb: "deny", hint: "Deny a pending artifact", arg: "id" },
  { verb: "status", hint: "Show session status" },
  { verb: "exit", hint: "Leave Code Mode" },
];

function CodingPalette({
  prompt,
  hasSession,
  onExecute,
}: {
  prompt: string;
  hasSession: boolean;
  onExecute: (command: string) => boolean;
}) {
  const run = (command: string) => {
    if (!onExecute(command)) {
      window.alert("Unable to send command — chat is not connected.");
    }
  };
  // In Code Mode the "code" prefix is omitted; commands are sent bare.
  return (
    <div className="border-t border-border px-2 py-1.5 text-[11px] text-text">
      <div className="flex items-center justify-between text-[10px] uppercase text-text-dim">
        <span>{prompt}&gt; palette</span>
        <span>{hasSession ? "session active" : "no session"}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {CODING_PALETTE_VERBS.map((entry) => (
          <button
            key={entry.verb}
            type="button"
            title={entry.hint}
            onClick={() => {
              if (entry.arg) {
                const value = window.prompt(`${entry.verb} — ${entry.hint}`, "");
                const trimmed = value?.trim();
                if (trimmed) run(`${entry.verb} ${trimmed}`);
              } else {
                run(entry.verb);
              }
            }}
            className="rounded border border-primary/30 bg-primary/5 px-2 py-0.5 font-mono text-[10px] text-primary transition-colors hover:border-primary hover:bg-primary/15"
          >
            {entry.verb}
            {entry.arg ? <span className="text-text-dim">…</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

interface CompassSuggestion {
  key: string;
  label: string;
  hint?: string;
  mode: "command" | "prompt";
  command: string;
}

function ContextualCompass({ onExecute }: { onExecute: (command: string) => boolean }) {
  const loggedIn = useChatState((s) => s.loggedIn);
  const messages = useChatState((s) => s.messages);
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

    if (recentFeed.some((event) => event.kind?.startsWith("media_"))) {
      add({
        key: "media",
        label: "Media jobs",
        hint: "Review recent media generations",
        mode: "command",
        command: "media jobs",
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
    if (!onExecute(command)) {
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
