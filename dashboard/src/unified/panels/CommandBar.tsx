// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * CommandBar -- Persistent command terminal at the bottom of the viewport.
 *
 * Visual port of #cmd-bar from 06-tiled.html mockup:
 * - Fixed bottom with left:4vw right:4vw
 * - Tabs: All | Room | Tell | Channels || Projects | Tasks | Boards | Pools | Groups
 * - Tabs use Press Start 2P ~7px, with a vertical divider between message tabs and coordination tabs
 * - Message area: scrollable, messages at ~16px VT323
 * - Input row: > prompt in gold, input in VT323 ~20px
 * - Drag handle at top (thin 40px bar)
 * - The bar sends raw commands to the server via WebSocket
 */

import { motion } from "motion/react";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { MemoryOpsTab } from "../../components/MemoryOpsTab";
import { ensureChatWs, getChatWs, useChatState } from "../../hooks/use-chat-state";
import { clearToken, logout, setToken } from "../../lib/api";
import { ansiToHtml, stripAnsi } from "../lib/ansi";
import { ConfigAdminTab, KeysAdminTab, McpAdminTab } from "./command-bar/AdminTabs";
import {
  BoardsTabClickable,
  ChannelsTabClickable,
  CommandsTabClickable,
  GroupsTabClickable,
  IntegrationsTab,
  PoolsTabClickable,
  ProjectsTabClickable,
  TasksTabClickable,
} from "./command-bar/CoordTabs";
import {
  BenchmarksTab,
  ExperimentsTab,
  MarketsTab,
  RecipesTab,
  TemplatesTab,
} from "./command-bar/DataTabs";
import { CoordDetailView } from "./command-bar/DetailViews";
import { type CoordDetail, InlinePrompt } from "./command-bar/shared";
import { MessageRow } from "./MessageRow";

// ── Types ───────────────────────────────────────────────────────────────────

/** Message type for tab filtering. */
export type MessageType =
  | "all"
  | "room"
  | "tell"
  | "events"
  | "channels"
  | "connectors"
  | "commands"
  | "projects"
  | "tasks"
  | "boards"
  | "pools"
  | "groups"
  | "keys"
  | "adapters"
  | "mcp"
  | "config"
  | "memory"
  | "markets"
  | "experiments"
  | "benchmarks"
  | "templates"
  | "recipes"
  | "cmd"
  | "system";

/** Perception tag for message styling. */
export type PerceptionTag =
  | "tell"
  | "shout"
  | "emote"
  | "say"
  | "broadcast"
  | "movement"
  | "system";

/** A single message in the command bar feed. */
export interface CommandMessage {
  /** Unique key for React rendering. */
  id: number;
  /** Entity name (null for system messages). */
  name: string | null;
  /** Message text content (plain text). */
  text: string;
  /** HTML-rendered text (with ANSI color codes converted). When present, renders as HTML. */
  html?: string;
  /** Whether this is a system message. */
  isSys: boolean;
  /** Message type for tab filtering. */
  type: MessageType;
  /** Perception tag for styling (tell, shout, emote, etc.). */
  tag?: PerceptionTag;
  /** Timestamp. */
  time: number;
  /** Extra data for tell messages. */
  tell?: { from: string; to: string };
}

/** Imperative handle for pushing messages from outside. */
export interface CommandBarHandle {
  /** Expand the command bar to full size. */
  expand: () => void;
  /** Collapse the command bar to compact size. */
  collapse: () => void;
  /** Add a message to the command bar feed. */
  addMessage: (
    name: string | null,
    text: string,
    isSys: boolean,
    type: MessageType,
    tell?: { from: string; to: string },
    tag?: PerceptionTag,
  ) => void;
  /** Focus the input. */
  focus: () => void;
  /** Blur the input. */
  blur: () => void;
}

/** Detail view for drill-down from coordination tabs (defined in command-bar/shared). */
export type { CoordDetail };

/** Props for the CommandBar component. */
export interface CommandBarProps {
  /** Whether the command bar is visible. */
  visible: boolean;
  /** Called when an entity name is clicked. */
  onEntityClick?: (name: string) => void;
  /** Called when a room navigation command is issued. */
  onRoomNavigate?: (roomId: string) => void;
  /** Called when a search result is selected. */
  onSearchNavigate?: (category: string, targetId: string) => void;
  /**
   * Optional search function. When provided, search/find/?query commands
   * will call this instead of showing a placeholder message.
   */
  searchFn?: (
    query: string,
  ) => { category: string; label: string; detail: string; targetId: string }[];
  /**
   * Send a raw command string to the Marina server via WebSocket.
   * When provided, all commands are forwarded to the server.
   */
  sendCommand?: (command: string) => void;
}

// ── Tab definitions ─────────────────────────────────────────────────────────

/** Tab metadata. */
interface TabDef {
  key: MessageType;
  label: string;
}

const MESSAGE_TABS: TabDef[] = [{ key: "all", label: "Shell" }];

const COORD_TABS: TabDef[] = [
  { key: "projects", label: "Projects" },
  { key: "tasks", label: "Tasks" },
  { key: "boards", label: "Boards" },
  { key: "pools", label: "Pools" },
  { key: "groups", label: "Groups" },
  { key: "channels", label: "Channels" },
  { key: "commands", label: "Macros" },
  { key: "markets", label: "Markets" },
  { key: "experiments", label: "Experiments" },
  { key: "benchmarks", label: "Benchmarks" },
  { key: "templates", label: "Templates" },
  { key: "recipes", label: "Recipes" },
];

const ADMIN_TABS: TabDef[] = [
  { key: "keys", label: "Keys" },
  { key: "connectors", label: "Integrations" },
  { key: "mcp", label: "MCP" },
  { key: "config", label: "Config" },
  { key: "memory", label: "Memory" },
];

const _ALL_DATA_TAB_KEYS = new Set([...COORD_TABS, ...ADMIN_TABS].map((t) => t.key));

const COORD_TAB_KEYS = new Set([...COORD_TABS, ...ADMIN_TABS].map((t) => t.key));

// ── Message counter ─────────────────────────────────────────────────────────

let messageIdCounter = 0;

// ── Tab Button ──────────────────────────────────────────────────────────────

const CmdTabButton = memo(function CmdTabButton({
  label,
  active,
  onClick,
  color,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  color?: string;
}) {
  return (
    <motion.button
      type="button"
      className={`uc-tab${active ? " active" : ""}`}
      onClick={onClick}
      whileHover={{ y: -1 }}
      whileTap={{ scale: 0.96 }}
      transition={{ duration: 0.12 }}
      style={!active && color ? { color, opacity: 0.6 } : undefined}
    >
      {label}
    </motion.button>
  );
});

// ── Command Bar ─────────────────────────────────────────────────────────────

/**
 * Persistent command terminal at the bottom of the viewport.
 * Use the imperative handle (ref) to push messages from parent components.
 */
export const CommandBar = memo(
  forwardRef<CommandBarHandle, CommandBarProps>(function CommandBar(
    { visible, onEntityClick, onRoomNavigate, onSearchNavigate, searchFn, sendCommand },
    ref,
  ) {
    const [messages, setMessages] = useState<CommandMessage[]>([]);
    const [activeTab, setActiveTab] = useState<MessageType>("all");
    const [cmdExpanded, setCmdExpanded] = useState(false);
    const [coordDetail, setCoordDetail] = useState<CoordDetail | null>(null);
    const [memoryFocusJobId, setMemoryFocusJobId] = useState<string | undefined>();

    // Hand-off from the canvas MEMORY layer inspector (unified/lib/
    // memory-map-admin-link.ts). `preventDefault()` tells the dispatcher this
    // surface claimed the event, so the inspector hides its fallback hint.
    useEffect(() => {
      const openAdmin = (event: Event) => {
        const detail = (event as CustomEvent<{ tab?: string; jobId?: string }>).detail;
        if (detail?.tab !== "memory") return;
        event.preventDefault();
        setMemoryFocusJobId(detail.jobId);
        setActiveTab("memory");
        setCoordDetail(null);
        setCmdExpanded(true);
      };
      window.addEventListener("marina:open-admin", openAdmin);
      return () => window.removeEventListener("marina:open-admin", openAdmin);
    }, []);
    const [inputValue, setInputValue] = useState("");
    const [loginName, setLoginName] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);
    const loginRef = useRef<HTMLInputElement>(null);
    const msgsRef = useRef<HTMLDivElement>(null);

    // Chat WebSocket state
    const loggedIn = useChatState((s) => s.loggedIn);
    const chatConnected = useChatState((s) => s.connected);
    const entityName = useChatState((s) => s.entityName);

    // Initialize WebSocket and handle perceptions
    // biome-ignore lint/correctness/useExhaustiveDependencies: WS handler captures latest setters; deps gate only mount/unmount
    useEffect(() => {
      const validTagSet = new Set([
        "tell",
        "shout",
        "emote",
        "say",
        "broadcast",
        "movement",
        "system",
      ]);

      const handlePerception = (raw: unknown) => {
        const p = raw as Record<string, unknown>;
        const kind = (p.kind as string) ?? "message";
        const pTag = (p.tag as string) ?? undefined;
        // Login/reconnect success arrives as kind:"system" with the session
        // token + entityId under `data` (see websocket-server.ts login handler).
        // Capture it so authenticated REST calls (keys, adapters, config) work —
        // without this the dashboard silently 401s on every admin action.
        const authData = p.data as Record<string, unknown> | undefined;
        if (authData?.token) {
          setToken(authData.token as string);
          useChatState
            .getState()
            .setLoggedIn(true, (authData.name as string) ?? (loginName.trim() || undefined));
        }
        if (kind === "auth_error") {
          // Server rejected login or token-based reconnect. Drop the stale
          // token and flip UI back to "not logged in" so the name row reappears.
          clearToken();
          useChatState.getState().setLoggedIn(false);
          const msg = (p.data as Record<string, unknown> | undefined)?.text as string | undefined;
          if (msg) {
            setMessages((prev) => [
              ...prev.slice(-200),
              {
                id: Date.now() + Math.random(),
                name: null,
                text: msg,
                isSys: true,
                type: "system" as MessageType,
                tag: "system" as PerceptionTag,
                time: Date.now(),
              },
            ]);
          }
          return;
        }
        // Push perception text to command bar messages
        const data = p.data as Record<string, unknown> | undefined;

        // Handle movement perceptions specially
        if (kind === "movement") {
          const name = (data?.entity as string) ?? "Someone";
          const direction = data?.direction as string | undefined;
          const exit = data?.exit as string | undefined;
          const movementText =
            direction === "arrive"
              ? `${name} arrives.`
              : `${name} leaves${exit ? ` ${exit}` : ""}.`;
          setMessages((prev) => [
            ...prev.slice(-200),
            {
              id: Date.now() + Math.random(),
              name: null,
              text: movementText,
              isSys: true,
              type: "room" as MessageType,
              tag: "movement" as PerceptionTag,
              time: Date.now(),
            },
          ]);
          return;
        }

        const rawText = (data?.text as string) ?? JSON.stringify(data ?? p);
        const entity = (data?.entity as string) ?? null;

        // Convert ANSI escape codes to styled HTML
        const hasAnsi = rawText.includes("\x1b[");
        const text = hasAnsi ? stripAnsi(rawText) : rawText;
        const html = hasAnsi ? ansiToHtml(rawText) : undefined;

        // Determine perception tag for styling
        const resolvedTag = (pTag ?? kind) as string;
        const msgTag = validTagSet.has(resolvedTag) ? (resolvedTag as PerceptionTag) : undefined;

        const filterType: MessageType =
          resolvedTag === "tell" ? "tell" : kind === "system" ? "system" : "room";

        setMessages((prev) => [
          ...prev.slice(-200),
          {
            id: Date.now() + Math.random(),
            name: entity,
            text,
            html,
            isSys: kind === "system",
            type: filterType,
            tag: msgTag,
            time: Date.now(),
          },
        ]);
      };
      ensureChatWs(handlePerception);
    }, []);

    // Login handler
    const doLogin = useCallback(() => {
      const name = loginName.trim();
      if (!name) return;
      const ws = getChatWs();
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "login", name }));
      }
    }, [loginName]);

    // Command history
    const historyRef = useRef<string[]>([]);
    const historyIdxRef = useRef(-1);
    const historySavedRef = useRef("");

    const barRef = useRef<HTMLDivElement>(null);

    // Imperative handle for external message pushing
    const addMessage = useCallback(
      (
        name: string | null,
        text: string,
        isSys: boolean,
        type: MessageType,
        tell?: { from: string; to: string },
        tag?: PerceptionTag,
      ) => {
        messageIdCounter += 1;
        const msg: CommandMessage = {
          id: messageIdCounter,
          name,
          text,
          isSys,
          type,
          tag,
          time: Date.now(),
          tell,
        };
        setMessages((prev) => [...prev.slice(-199), msg]);
      },
      [],
    );

    useImperativeHandle(
      ref,
      () => ({
        addMessage,
        expand: () => setCmdExpanded(true),
        collapse: () => setCmdExpanded(false),
        focus: () => inputRef.current?.focus(),
        blur: () => inputRef.current?.blur(),
      }),
      [addMessage],
    );

    // biome-ignore lint/correctness/useExhaustiveDependencies: triggers scroll on new messages
    useEffect(() => {
      const el = msgsRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }, [messages.length]);

    const isCoordTab = COORD_TAB_KEYS.has(activeTab);

    // Command execution
    const executeCommand = useCallback(
      (raw: string) => {
        // Echo the command
        addMessage(null, raw, false, "cmd");

        // Send command to Marina server via game WebSocket
        const ws = getChatWs();
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "command", command: raw }));
        } else if (sendCommand) {
          sendCommand(raw);
        } else {
          addMessage(null, "Not connected — type a name above to login first", true, "system");
        }

        // Client-side features: map navigation, tab routing, local search
        const parts = raw.split(/\s+/);
        const cmd = parts[0]?.toLowerCase() ?? "";
        const args = parts.slice(1).join(" ");

        // Auto-navigate to the relevant tab based on the command
        const CMD_TAB_MAP: Record<string, MessageType> = {
          project: "projects",
          task: "tasks",
          board: "boards",
          pool: "pools",
          group: "groups",
          channel: "channels",
          macro: "commands",
          build: "commands",
          key: "keys",
          adapter: "connectors",
          connector: "connectors",
        };
        const targetTab = CMD_TAB_MAP[cmd] ?? "all"; // default to Shell for any non-mapped command
        setActiveTab(targetTab);
        setCoordDetail(null);
        setCmdExpanded(true);

        // Navigate the map view on goto
        if ((cmd === "goto" || cmd === "go") && args) {
          onRoomNavigate?.(args);
        }

        // Local search (client-side, ?query shortcut or search/find/recall)
        const searchQuery = raw.startsWith("?")
          ? raw.slice(1).trim()
          : cmd === "search" || cmd === "find" || cmd === "recall"
            ? args
            : null;

        if (searchQuery && searchFn) {
          const results = searchFn(searchQuery);
          if (results.length === 0) {
            addMessage(null, `No local results for "${searchQuery}".`, true, "system");
          } else {
            addMessage(null, `Found ${results.length} result(s):`, true, "system");
            for (const r of results.slice(0, 10)) {
              const badge = r.category.toUpperCase().padEnd(7);
              addMessage(null, `  [${badge}] ${r.label} -- ${r.detail}`, true, "system");
            }
            const first = results[0];
            if (first) {
              onSearchNavigate?.(first.category, first.targetId);
            }
          }
        }
        // All commands are sent to the server — responses arrive via WebSocket perceptions
      },
      [addMessage, onRoomNavigate, onSearchNavigate, searchFn, sendCommand],
    );

    // Input key handler
    const onInputKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          const val = inputValue.trim();
          if (val) {
            executeCommand(val);
            historyRef.current.push(val);
            historyIdxRef.current = -1;
            historySavedRef.current = "";
            setInputValue("");
          }
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          const hist = historyRef.current;
          if (hist.length === 0) return;
          if (historyIdxRef.current === -1) historySavedRef.current = inputValue;
          historyIdxRef.current = Math.min(historyIdxRef.current + 1, hist.length - 1);
          setInputValue(hist[hist.length - 1 - historyIdxRef.current] ?? "");
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          if (historyIdxRef.current <= 0) {
            historyIdxRef.current = -1;
            setInputValue(historySavedRef.current);
            return;
          }
          historyIdxRef.current -= 1;
          const hist = historyRef.current;
          setInputValue(hist[hist.length - 1 - historyIdxRef.current] ?? "");
        } else if (e.key === "Escape") {
          inputRef.current?.blur();
          e.stopPropagation();
        }
      },
      [inputValue, executeCommand],
    );

    // No drag/resize — position is fully CSS-managed to avoid corruption
    useEffect(() => {}, []);

    if (!visible) return null;

    return (
      // biome-ignore lint/a11y/useSemanticElements: contains nested interactive elements (input + tab buttons) — cannot use <button>
      <div
        ref={barRef}
        className={`uc-command-bar${cmdExpanded ? " cmd-expanded" : ""}`}
        role="button"
        tabIndex={0}
        onClick={(e) => {
          // Click on the bar itself (not a child button/input) toggles expand
          if (
            e.target === e.currentTarget ||
            (e.target as HTMLElement).classList?.contains("uc-cmd-msgs")
          ) {
            setCmdExpanded((v) => !v);
          } else if (!cmdExpanded) {
            setCmdExpanded(true);
          }
        }}
        onKeyDown={(e) => {
          if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            setCmdExpanded((v) => !v);
          }
        }}
      >
        {/* Drag handle — removed to prevent position corruption */}
        <div className="uc-cmd-drag" />

        {/* Tabs — click empty space to collapse */}
        {/* biome-ignore lint/a11y/useSemanticElements: contains nested interactive tab buttons — cannot use <button> */}
        <div
          className="uc-cmd-tabs"
          role="button"
          tabIndex={0}
          onClick={(e) => {
            if (cmdExpanded && e.target === e.currentTarget) setCmdExpanded(false);
          }}
          onKeyDown={(e) => {
            if (
              cmdExpanded &&
              e.target === e.currentTarget &&
              (e.key === "Enter" || e.key === " ")
            ) {
              e.preventDefault();
              setCmdExpanded(false);
            }
          }}
        >
          {MESSAGE_TABS.map((tab) => (
            <CmdTabButton
              key={tab.key}
              label={tab.label}
              active={activeTab === tab.key}
              onClick={() => setActiveTab(tab.key)}
            />
          ))}
          {/* Divider — coordination data tabs (teal accent) */}
          <span
            style={{
              width: "2px",
              height: "14px",
              background: "var(--color-teal)",
              margin: "auto 4px",
              opacity: 0.4,
              borderRadius: "1px",
            }}
          />
          {COORD_TABS.map((tab) => (
            <CmdTabButton
              key={tab.key}
              label={tab.label}
              active={activeTab === tab.key}
              onClick={() => {
                setActiveTab(tab.key);
                setCoordDetail(null);
              }}
              color={activeTab === tab.key ? undefined : "var(--color-teal)"}
            />
          ))}
          {/* Divider — admin tabs (orange accent) */}
          <span
            style={{
              width: "2px",
              height: "14px",
              background: "#f59e0b",
              margin: "auto 4px",
              opacity: 0.4,
              borderRadius: "1px",
            }}
          />
          {ADMIN_TABS.map((tab) => (
            <CmdTabButton
              key={tab.key}
              label={tab.label}
              active={activeTab === tab.key}
              onClick={() => {
                setActiveTab(tab.key);
                setCoordDetail(null);
              }}
              color={activeTab === tab.key ? undefined : "#f59e0b"}
            />
          ))}
        </div>

        {/* ── Status bar — connection + identity ─────────────────────── */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "3px 12px",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
            fontSize: "clamp(11px, 0.8vw, 15px)",
            fontFamily: "'VT323', monospace",
            flexShrink: 0,
          }}
        >
          {/* Connection dot — decorative; the text beside it carries the state */}
          <span
            aria-hidden="true"
            style={{
              width: "7px",
              height: "7px",
              borderRadius: "50%",
              background: chatConnected ? "#22c55e" : "#ef4444",
              boxShadow: chatConnected ? "0 0 6px #22c55e" : "0 0 6px #ef4444",
              flexShrink: 0,
            }}
          />
          <span style={{ color: chatConnected ? "#22c55e" : "#ef4444" }}>
            {chatConnected ? "CONNECTED" : "OFFLINE"}
          </span>

          {loggedIn && entityName && (
            <>
              <span style={{ color: "#666" }}>|</span>
              <span style={{ color: "var(--color-primary, #FFDD00)" }}>{entityName}</span>
              <button
                type="button"
                onClick={async () => {
                  await logout();
                  useChatState.getState().setLoggedIn(false);
                }}
                title="Revoke this session on the server and clear the local token."
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#888",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: "inherit",
                  padding: "0 4px",
                  textDecoration: "underline",
                }}
              >
                logout
              </button>
            </>
          )}

          {!loggedIn && chatConnected && (
            <>
              <span style={{ color: "#666" }}>|</span>
              <span style={{ color: "#aaa" }}>Not logged in — enter your name below</span>
            </>
          )}

          <span style={{ flex: 1 }} />

          {/* Minimize button when expanded */}
          {cmdExpanded && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setCmdExpanded(false);
              }}
              style={{
                background: "none",
                border: "none",
                color: "#888",
                cursor: "pointer",
                fontFamily: "'VT323', monospace",
                fontSize: "14px",
                padding: "0 6px",
              }}
              title="Minimize"
              aria-label="Minimize command bar"
            >
              <span aria-hidden="true">_</span>
            </button>
          )}
        </div>

        {/* Shell output — all messages, raw */}
        {!isCoordTab && (
          <div ref={msgsRef} className="uc-cmd-msgs">
            {messages.length === 0 && (
              <div
                style={{
                  textAlign: "center",
                  padding: "16px",
                  color: "#999",
                  fontSize: "clamp(15px, 1.05vw, 22px)",
                }}
              >
                {loggedIn
                  ? "Type a command below. Try: look, who, help"
                  : chatConnected
                    ? "Log in below to start interacting with the world."
                    : "Connecting to server..."}
              </div>
            )}
            {messages.map((msg) => (
              <MessageRow key={msg.id} msg={msg} onEntityClick={onEntityClick} />
            ))}
          </div>
        )}

        {/* Coordination tab content — detail drill-down or list */}
        {isCoordTab && coordDetail && (
          <CoordDetailView
            detail={coordDetail}
            onBack={() => setCoordDetail(null)}
            onNavigate={setCoordDetail}
            onEntityClick={onEntityClick}
            sendCommand={sendCommand}
          />
        )}
        {isCoordTab && !coordDetail && activeTab === "projects" && (
          <>
            {sendCommand && (
              <div
                style={{
                  padding: "6px 12px",
                  borderBottom: "1px solid rgba(255,255,255,0.06)",
                  display: "flex",
                  gap: "6px",
                }}
              >
                <InlinePrompt
                  label="+ PROJECT"
                  placeholder="Project name..."
                  color="#22c55e"
                  onSubmit={(t) => sendCommand(`project create ${t}`)}
                />
              </div>
            )}
            <ProjectsTabClickable onSelect={(id) => setCoordDetail({ kind: "project", id })} />
          </>
        )}
        {isCoordTab && !coordDetail && activeTab === "tasks" && (
          <>
            {sendCommand && (
              <div
                style={{
                  padding: "6px 12px",
                  borderBottom: "1px solid rgba(255,255,255,0.06)",
                  display: "flex",
                  gap: "6px",
                }}
              >
                <InlinePrompt
                  label="+ TASK"
                  placeholder="Task title..."
                  color="#22c55e"
                  onSubmit={(t) => sendCommand(`task create ${t}`)}
                />
              </div>
            )}
            <TasksTabClickable onSelect={(id) => setCoordDetail({ kind: "task", id })} />
          </>
        )}
        {isCoordTab && !coordDetail && activeTab === "boards" && (
          <>
            {sendCommand && (
              <div
                style={{
                  padding: "6px 12px",
                  borderBottom: "1px solid rgba(255,255,255,0.06)",
                  display: "flex",
                  gap: "6px",
                }}
              >
                <InlinePrompt
                  label="+ BOARD"
                  placeholder="Board name..."
                  color="#22c55e"
                  onSubmit={(t) => sendCommand(`board create ${t}`)}
                />
              </div>
            )}
            <BoardsTabClickable onSelect={(name) => setCoordDetail({ kind: "board", name })} />
          </>
        )}
        {isCoordTab && !coordDetail && activeTab === "pools" && (
          <>
            {sendCommand && (
              <div
                style={{
                  padding: "6px 12px",
                  borderBottom: "1px solid rgba(255,255,255,0.06)",
                  display: "flex",
                  gap: "6px",
                }}
              >
                <InlinePrompt
                  label="+ POOL"
                  placeholder="Pool name..."
                  color="#22c55e"
                  onSubmit={(t) => sendCommand(`pool create ${t}`)}
                />
              </div>
            )}
            <PoolsTabClickable onSelect={(id) => setCoordDetail({ kind: "pool", id })} />
          </>
        )}
        {isCoordTab && !coordDetail && activeTab === "groups" && (
          <>
            {sendCommand && (
              <div
                style={{
                  padding: "6px 12px",
                  borderBottom: "1px solid rgba(255,255,255,0.06)",
                  display: "flex",
                  gap: "6px",
                }}
              >
                <InlinePrompt
                  label="+ GROUP"
                  placeholder="Group name..."
                  color="#22c55e"
                  onSubmit={(t) => sendCommand(`group create ${t}`)}
                />
              </div>
            )}
            <GroupsTabClickable onSelect={(name) => setCoordDetail({ kind: "group", name })} />
          </>
        )}
        {isCoordTab && !coordDetail && activeTab === "channels" && (
          <>
            {sendCommand && (
              <div
                style={{
                  padding: "6px 12px",
                  borderBottom: "1px solid rgba(255,255,255,0.06)",
                  display: "flex",
                  gap: "6px",
                }}
              >
                <InlinePrompt
                  label="+ CHANNEL"
                  placeholder="Channel name..."
                  color="#22c55e"
                  onSubmit={(t) => sendCommand(`channel create ${t}`)}
                />
              </div>
            )}
            <ChannelsTabClickable onSelect={(name) => setCoordDetail({ kind: "channel", name })} />
          </>
        )}
        {isCoordTab && !coordDetail && activeTab === "connectors" && (
          <IntegrationsTab
            onSelect={(id) => setCoordDetail({ kind: "connector", id })}
            sendCommand={sendCommand}
          />
        )}
        {isCoordTab && !coordDetail && activeTab === "commands" && (
          <>
            {sendCommand && (
              <div
                style={{
                  padding: "6px 12px",
                  borderBottom: "1px solid rgba(255,255,255,0.06)",
                  display: "flex",
                  gap: "6px",
                  flexWrap: "wrap",
                }}
              >
                <InlinePrompt
                  label="+ MACRO"
                  placeholder="name command (e.g. scout goto world/0-0)"
                  color="#22c55e"
                  onSubmit={(t) => {
                    const parts = t.split(/\s+/);
                    const name = parts[0];
                    const cmd = parts.slice(1).join(" ");
                    if (name && cmd) sendCommand(`macro create ${name} ${cmd}`);
                    else sendCommand(`macro create ${t}`);
                  }}
                />
                <InlinePrompt
                  label="+ COMMAND"
                  placeholder="command name..."
                  color="var(--color-teal)"
                  onSubmit={(t) => sendCommand(`build command create ${t}`)}
                />
              </div>
            )}
            <CommandsTabClickable onSelect={(id) => setCoordDetail({ kind: "command", id })} />
          </>
        )}

        {/* New data tabs */}
        {isCoordTab && !coordDetail && activeTab === "markets" && <MarketsTab />}
        {isCoordTab && !coordDetail && activeTab === "experiments" && <ExperimentsTab />}
        {isCoordTab && !coordDetail && activeTab === "benchmarks" && <BenchmarksTab />}
        {isCoordTab && !coordDetail && activeTab === "templates" && <TemplatesTab />}
        {isCoordTab && !coordDetail && activeTab === "recipes" && <RecipesTab />}

        {/* Admin tabs */}
        {isCoordTab && !coordDetail && activeTab === "keys" && <KeysAdminTab />}
        {/* Adapters merged into Integrations tab */}
        {isCoordTab && !coordDetail && activeTab === "mcp" && <McpAdminTab />}
        {isCoordTab && !coordDetail && activeTab === "config" && <ConfigAdminTab />}
        {isCoordTab && !coordDetail && activeTab === "memory" && (
          <div className="uc-cmd-msgs" style={{ overflow: "auto", padding: "6px" }}>
            <MemoryOpsTab
              focusJobId={memoryFocusJobId}
              onOpenTrace={(traceId) =>
                window.dispatchEvent(new CustomEvent("marina:open-traces", { detail: { traceId } }))
              }
            />
          </div>
        )}

        {/* Login row — shown when not logged in */}
        {!loggedIn && (
          <div
            className="uc-cmd-input-row"
            style={{ borderTop: "2px solid var(--color-danger, #ef4444)" }}
          >
            <span className="uc-cmd-prompt" style={{ color: "var(--color-danger, #ef4444)" }}>
              {chatConnected ? "name:" : "offline"}
            </span>
            <input
              ref={loginRef}
              type="text"
              value={loginName}
              onChange={(e) => setLoginName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doLogin()}
              placeholder={
                chatConnected ? "Enter your name to login..." : "Connecting to server..."
              }
              autoComplete="off"
              className="uc-cmd-input"
              style={{ color: "var(--color-text-bright, #f0f0f0)" }}
            />
            {chatConnected && loginName.trim() && (
              <button
                type="button"
                onClick={doLogin}
                style={{
                  background: "color-mix(in srgb, var(--color-primary) 15%, transparent)",
                  border: "1px solid var(--color-primary)",
                  color: "var(--color-primary)",
                  fontFamily: "'Press Start 2P', monospace",
                  fontSize: "clamp(7px, 0.5vw, 9px)",
                  padding: "4px 12px",
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                LOGIN
              </button>
            )}
          </div>
        )}

        {/* Command input row — shown when logged in */}
        {loggedIn && (
          <div className="uc-cmd-input-row">
            <span
              className="uc-cmd-prompt"
              style={{ color: "var(--color-primary, #FFDD00)" }}
              title={entityName ? `Logged in as ${entityName}` : "Logged in"}
            >
              {entityName ? `${entityName}>` : ">"}
            </span>
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder="say, tell, goto, recall, note, look, help..."
              autoComplete="off"
              className="uc-cmd-input"
            />
          </div>
        )}
      </div>
    );
  }),
);
