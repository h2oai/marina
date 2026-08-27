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
import {
  useAdapters,
  useBenchmarks,
  useBoardDetail,
  useBoards,
  useChannelDetail,
  useChannels,
  useConnectors,
  useDynamicCommands,
  useEnvConfig,
  useEvolutionSessions,
  useExperiments,
  useGroupDetail,
  useGroups,
  useKeys,
  useMarkets,
  useMcpInfo,
  useMemoryPools,
  useProjects,
  useRecipes,
  useRoomTemplates,
  useTaskDetail,
  useTasks,
} from "../../hooks/use-api";
import { ensureChatWs, getChatWs, useChatState } from "../../hooks/use-chat-state";
import { useWorldState } from "../../hooks/use-world-state";
import { clearToken, logout, setToken } from "../../lib/api";
import type {
  AdapterStatus,
  BenchmarkEntry,
  BoardEntry,
  ChannelEntry,
  ConnectorEntry,
  DashboardEvent,
  DynamicCommandEntry,
  EnvVar,
  EvolutionSessionEntry,
  ExperimentEntry,
  GroupEntry,
  KeyStatus,
  MarketEntry,
  MemoryPool,
  ProjectEntry,
  RecipeEntry,
  RoomTemplateEntry,
  TaskEntry,
} from "../../lib/types";
import { ansiToHtml, stripAnsi } from "../lib/ansi";
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

/** Detail view for drill-down from coordination tabs. */
export type CoordDetail =
  | { kind: "task"; id: number }
  | { kind: "board"; name: string }
  | { kind: "group"; name: string }
  | { kind: "channel"; name: string }
  | { kind: "project"; id: string }
  | { kind: "connector"; id: string }
  | { kind: "command"; id: string }
  | { kind: "pool"; id: string };

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

// ── Events Tab (merged from FeedPanel) ─────────────────────────────────────

function formatEventTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("en", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const EVENT_TYPE_COLORS: Record<string, string> = {
  say: "#06b6d4",
  tell: "#d946ef",
  shout: "#facc15",
  emote: "#22d3ee",
  broadcast: "#3b82f6",
  command: "#84cc16",
  move: "#f59e0b",
  goto: "#f59e0b",
  connect: "#22c55e",
  disconnect: "#6b7280",
  error: "#ef4444",
  command_error: "#ef4444",
  agent_error: "#ef4444",
  tick: "#333",
};

// ── Admin Tab Components ──────────────────────────────────────────────────

const SUPPORTED_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "groq",
  "openrouter",
  "cerebras",
  "xai",
  "mistral",
  "deepseek",
];

const KeysAdminTab = memo(function KeysAdminTab() {
  const { data, isLoading, refetch } = useKeys();
  const [adding, setAdding] = useState(false);
  const [keyName, setKeyName] = useState("");
  const [keyProvider, setKeyProvider] = useState("");
  const [keyValue, setKeyValue] = useState("");

  const handleAdd = useCallback(async () => {
    if (!keyName || !keyProvider || !keyValue) return;
    const { postApi } = await import("../../lib/api");
    await postApi("/api/keys", { name: keyName, provider: keyProvider, value: keyValue });
    setKeyName("");
    setKeyProvider("");
    setKeyValue("");
    setAdding(false);
    refetch();
  }, [keyName, keyProvider, keyValue, refetch]);

  const handleDelete = useCallback(
    async (name: string) => {
      const { deleteApi } = await import("../../lib/api");
      await deleteApi(`/api/keys/${encodeURIComponent(name)}`);
      refetch();
    },
    [refetch],
  );

  if (isLoading) return <CoordLoading />;

  const inputStyle = {
    width: "100%",
    background: "rgba(17,17,24,0.6)",
    border: "1px solid var(--color-border)",
    color: "#ddd",
    fontFamily: "'VT323', monospace",
    fontSize: "clamp(14px, 0.95vw, 18px)",
    padding: "3px 8px",
    outline: "none",
  } as const;

  return (
    <div className="uc-cmd-msgs">
      {/* Add key form */}
      <div
        style={{
          padding: "6px 12px",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          display: "flex",
          gap: "6px",
          alignItems: "center",
        }}
      >
        {adding ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "4px" }}>
            <input
              type="text"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              placeholder="Key name"
              style={inputStyle}
            />
            <select
              value={keyProvider}
              onChange={(e) => setKeyProvider(e.target.value)}
              style={inputStyle}
            >
              <option value="">Provider...</option>
              {SUPPORTED_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <input
              type="password"
              value={keyValue}
              onChange={(e) => setKeyValue(e.target.value)}
              placeholder="API key value"
              style={inputStyle}
            />
            <div style={{ display: "flex", gap: "4px" }}>
              <ActionBtn label="SAVE" color="#22c55e" onClick={handleAdd} />
              <ActionBtn label="CANCEL" onClick={() => setAdding(false)} />
            </div>
          </div>
        ) : (
          <ActionBtn label="+ KEY" color="#22c55e" onClick={() => setAdding(true)} />
        )}
      </div>
      {(!data || data.length === 0) && <CoordEmpty label="API keys" />}
      {(data ?? []).map((k: KeyStatus) => (
        <div key={k.name} className="uc-coord-item" style={{ cursor: "default" }}>
          <div className={`uc-coord-dot ${k.masked ? "active" : "pending"}`} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">{k.provider}</div>
            <div className="uc-coord-meta">
              {k.name} &middot; {k.masked}
            </div>
          </div>
          <button
            type="button"
            onClick={() => handleDelete(k.name)}
            style={{
              background: "none",
              border: "none",
              color: "#ef4444",
              cursor: "pointer",
              fontFamily: "'VT323'",
              fontSize: "14px",
              padding: "2px 6px",
              opacity: 0.6,
            }}
            title="Delete key"
          >
            x
          </button>
        </div>
      ))}
    </div>
  );
});

const _AdaptersAdminTab = memo(function AdaptersAdminTab() {
  const { data, isLoading, refetch } = useAdapters();

  const handleToggle = useCallback(
    async (a: AdapterStatus) => {
      const { patchApi } = await import("../../lib/api");
      await patchApi(`/api/adapters/${encodeURIComponent(a.platform)}`, {
        status: a.running ? "inactive" : "active",
      });
      refetch();
    },
    [refetch],
  );

  const handleDelete = useCallback(
    async (platform: string) => {
      const { deleteApi } = await import("../../lib/api");
      await deleteApi(`/api/adapters/${encodeURIComponent(platform)}`);
      refetch();
    },
    [refetch],
  );

  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="adapters" />;
  return (
    <div className="uc-cmd-msgs">
      {data.map((a: AdapterStatus) => (
        <div key={a.platform} className="uc-coord-item" style={{ cursor: "default" }}>
          <div className={`uc-coord-dot ${a.running ? "active" : "done"}`} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">{a.platform}</div>
            <div className="uc-coord-meta">
              {a.running ? "Running" : a.status} | {a.source}
            </div>
          </div>
          <ActionBtn
            label={a.running ? "STOP" : "START"}
            color={a.running ? "#f59e0b" : "#22c55e"}
            onClick={() => handleToggle(a)}
          />
          {a.source === "db" && (
            <ActionBtn label="X" color="#ef4444" onClick={() => handleDelete(a.platform)} />
          )}
        </div>
      ))}
    </div>
  );
});

const McpAdminTab = memo(function McpAdminTab() {
  const { data, isLoading } = useMcpInfo();
  const [expandedCat, setExpandedCat] = useState<string | null>(null);
  if (isLoading) return <CoordLoading />;
  if (!data) return <CoordEmpty label="MCP" />;
  const allTools = Object.values(data.tools).flat();
  const categories = Object.entries(data.tools);

  return (
    <div className="uc-cmd-msgs" style={{ padding: "8px 12px" }}>
      {/* Connection info */}
      <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "8px" }}>
        <span
          style={{
            width: "7px",
            height: "7px",
            borderRadius: "50%",
            background: "#22c55e",
            boxShadow: "0 0 4px #22c55e",
          }}
        />
        <span className="uc-coord-title" style={{ fontSize: "clamp(13px, 0.9vw, 17px)" }}>
          {data.url}:{data.port}
        </span>
        <span className="uc-coord-meta">{allTools.length} tools</span>
      </div>

      {/* Tools by category — clickable to expand descriptions */}
      {categories.map(([cat, tools]) => (
        <div key={cat} style={{ marginBottom: "6px" }}>
          <button
            type="button"
            onClick={() => setExpandedCat(expandedCat === cat ? null : cat)}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              background: "none",
              border: "none",
              cursor: "pointer",
              fontFamily: "'Press Start 2P', monospace",
              fontSize: "clamp(5px, 0.4vw, 7px)",
              color: expandedCat === cat ? "var(--color-teal)" : "#888",
              letterSpacing: "0.5px",
              padding: "3px 0",
            }}
          >
            {cat.toUpperCase()} ({tools.length})
          </button>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "3px" }}>
            {tools.map((t) => (
              <span
                key={t.name}
                style={{
                  fontSize: "clamp(12px, 0.8vw, 15px)",
                  padding: "1px 5px",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-teal)",
                  fontFamily: "'VT323', monospace",
                }}
                title={t.description}
              >
                {t.name}
              </span>
            ))}
          </div>
          {expandedCat === cat && (
            <div
              style={{
                marginTop: "4px",
                paddingLeft: "8px",
                borderLeft: "2px solid var(--color-border)",
              }}
            >
              {tools.map((t) => (
                <div key={t.name} style={{ marginBottom: "3px" }}>
                  <span
                    style={{ color: "var(--color-teal)", fontSize: "clamp(12px, 0.85vw, 16px)" }}
                  >
                    {t.name}
                  </span>
                  <span className="uc-coord-meta" style={{ marginLeft: "6px" }}>
                    {t.description}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
});

const ConfigAdminTab = memo(function ConfigAdminTab() {
  const { data, isLoading, refetch } = useEnvConfig();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    if (Object.keys(edits).length === 0) return;
    setSaving(true);
    try {
      const { putApi } = await import("../../lib/api");
      await putApi("/api/env", { vars: edits });
      refetch();
      setEdits({});
    } finally {
      setSaving(false);
    }
  }, [edits, refetch]);

  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="config" />;

  const inputStyle = {
    width: "100%",
    background: "rgba(17,17,24,0.6)",
    border: "1px solid var(--color-border)",
    color: "#ddd",
    fontFamily: "'VT323', monospace",
    fontSize: "clamp(14px, 0.95vw, 18px)",
    padding: "3px 8px",
    outline: "none",
  } as const;

  return (
    <div className="uc-cmd-msgs">
      {Object.keys(edits).length > 0 && (
        <div
          style={{
            padding: "6px 12px",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
            display: "flex",
            gap: "6px",
            alignItems: "center",
          }}
        >
          <ActionBtn label={saving ? "SAVING..." : "SAVE"} color="#22c55e" onClick={handleSave} />
        </div>
      )}
      {data.map((v: EnvVar) => (
        <div
          key={v.key}
          className="uc-coord-item"
          style={{ cursor: "default", flexDirection: "column", alignItems: "stretch", gap: "4px" }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div className={`uc-coord-dot ${v.value ? "active" : "done"}`} />
            <div className="uc-coord-title" style={{ fontSize: "clamp(13px, 0.9vw, 17px)" }}>
              {v.key}
            </div>
          </div>
          <input
            type={v.isSecret ? "password" : "text"}
            value={edits[v.key] ?? v.value ?? ""}
            onChange={(e) => setEdits((prev) => ({ ...prev, [v.key]: e.target.value }))}
            style={inputStyle}
          />
        </div>
      ))}
    </div>
  );
});

// ── New Data Tabs (Markets, Experiments, Benchmarks, Templates) ──────────────

const MarketsTab = memo(function MarketsTab() {
  const { data, isLoading } = useMarkets();
  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="markets" />;
  return (
    <div className="uc-cmd-msgs">
      {data.map((m: MarketEntry) => (
        <div key={m.id} className="uc-coord-item" style={{ cursor: "default" }}>
          <div
            className={`uc-coord-dot ${m.status === "open" ? "active" : m.status === "resolved" ? "done" : "pending"}`}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">{m.question}</div>
            <div className="uc-coord-meta">
              {m.category ?? "general"} &middot; {m.status}
              {m.outcome ? ` &middot; outcome: ${m.outcome}` : ""}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
});

const ExperimentsTab = memo(function ExperimentsTab() {
  const { data, isLoading } = useExperiments();
  const { data: evolutionSessions } = useEvolutionSessions();
  const [expandedSession, setExpandedSession] = useState<number | null>(null);
  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="experiments" />;
  return (
    <div className="uc-cmd-msgs">
      {evolutionSessions?.map((session: EvolutionSessionEntry) => {
        const accepted = session.runs.filter((run) => run.status === "accepted").length;
        const lastRun = session.runs.at(-1);
        return (
          <button
            type="button"
            key={`evolution-${session.id}`}
            className="uc-coord-item"
            style={{
              cursor: "pointer",
              alignItems: "flex-start",
              width: "100%",
              border: 0,
              background: "transparent",
              color: "inherit",
              font: "inherit",
              textAlign: "left",
            }}
            onClick={() =>
              setExpandedSession((current) => (current === session.id ? null : session.id))
            }
          >
            <div
              className={`uc-coord-dot ${session.status === "active" ? "active" : session.status === "completed" ? "done" : "pending"}`}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="uc-coord-title">
                {session.experiment_name ?? `Experiment ${session.experiment_id}`} · evolution
              </div>
              <div className="uc-coord-meta">
                {session.status} &middot; {session.runs.length} runs &middot; {accepted} accepted
                {session.budget.runsRemaining !== undefined
                  ? ` · ${session.budget.runsRemaining} remaining`
                  : ""}
                {session.budget.exhausted ? " · budget exhausted" : ""}
              </div>
              <div className="uc-coord-meta" style={{ color: "#777" }}>
                {session.objective}
              </div>
              {lastRun && (
                <div className="uc-coord-meta" style={{ color: "#555" }}>
                  Latest: {lastRun.status} · {lastRun.hypothesis}
                  {lastRun.parent_run_id ? ` · parent #${lastRun.parent_run_id}` : ""}
                </div>
              )}
              <div className="uc-coord-meta" style={{ color: "#555" }}>
                auto-continue off · auto-promote off
                {session.protocol.independentReview ? " · independent review" : ""}
              </div>
              <div className="uc-coord-meta" style={{ color: "#777" }}>
                {session.activity.activeParticipants}/{session.activity.participants.length} active
                · {session.activity.meaningfulActions} actions · {session.activity.communications}{" "}
                comms · {session.activity.marinaToolCalls}/{session.activity.toolCalls} Marina tools
                {session.activity.averageToolLatencyMs !== null
                  ? ` · ${Math.round(session.activity.averageToolLatencyMs)}ms avg tool latency`
                  : ""}
              </div>
              {session.protocol.guardrails.length > 0 && (
                <div className="uc-coord-meta" style={{ color: "#c99a45" }}>
                  Guardrails:{" "}
                  {session.protocol.guardrails
                    .map((guardrail) => `${guardrail.metric} ${guardrail.direction}`)
                    .join(" · ")}
                </div>
              )}
              {expandedSession === session.id && (
                <div
                  style={{
                    marginTop: 6,
                    paddingLeft: 8,
                    borderLeft: "1px solid rgba(201,154,69,.45)",
                    display: "grid",
                    gap: 6,
                  }}
                >
                  {session.runs.length === 0 && (
                    <div className="uc-coord-meta">No proposals recorded.</div>
                  )}
                  {session.runs.map((run) => (
                    <div key={run.id} style={{ position: "relative" }}>
                      <div className="uc-coord-title" style={{ fontSize: 10 }}>
                        #{run.id} · run {run.sequence} · {run.status}
                        {run.parent_run_id ? ` ← #${run.parent_run_id}` : " · root"}
                      </div>
                      <div className="uc-coord-meta">{run.hypothesis}</div>
                      <div className="uc-coord-meta" style={{ color: "#777" }}>
                        candidate {run.candidate_ref} · proposed by {run.proposed_by}
                      </div>
                      {run.evidence && (
                        <div className="uc-coord-meta" style={{ color: "#8fb6a0" }}>
                          Evidence: {run.evidence}
                        </div>
                      )}
                      {(run.evaluator_name || run.reviewer_name) && (
                        <div className="uc-coord-meta" style={{ color: "#777" }}>
                          evaluator {run.evaluator_name ?? "pending"} · reviewer{" "}
                          {run.reviewer_name ?? "pending"}
                          {run.decision ? ` · ${run.decision}` : ""}
                        </div>
                      )}
                    </div>
                  ))}
                  <div className="uc-coord-meta" style={{ color: "#555" }}>
                    Token and cost totals remain unavailable until provider-neutral per-session
                    attribution is durable; they are never inferred from activity.
                  </div>
                </div>
              )}
            </div>
          </button>
        );
      })}
      {data.map((e: ExperimentEntry) => (
        <div key={e.id} className="uc-coord-item" style={{ cursor: "default" }}>
          <div
            className={`uc-coord-dot ${e.status === "running" ? "active" : e.status === "completed" ? "done" : "pending"}`}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">{e.name}</div>
            <div className="uc-coord-meta">
              {e.status} &middot; by {e.creator_name}
              {e.required_agents > 0 ? ` &middot; ${e.required_agents} agents` : ""}
            </div>
            {e.description && (
              <div className="uc-coord-meta" style={{ color: "#555" }}>
                {e.description.length > 100 ? `${e.description.slice(0, 100)}...` : e.description}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
});

const BenchmarksTab = memo(function BenchmarksTab() {
  const { data, isLoading } = useBenchmarks();
  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="benchmarks" />;

  // Sort by total score descending
  const sorted = [...data].sort((a: BenchmarkEntry, b: BenchmarkEntry) => {
    const sumA = Object.values(a.scores).reduce((s, v) => s + v, 0);
    const sumB = Object.values(b.scores).reduce((s, v) => s + v, 0);
    return sumB - sumA;
  });

  return (
    <div className="uc-cmd-msgs">
      {sorted.map((entry: BenchmarkEntry) => {
        const total = Object.values(entry.scores).reduce((s, v) => s + v, 0);
        return (
          <div key={entry.entity} className="uc-coord-item" style={{ cursor: "default" }}>
            <div className="uc-coord-dot active" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="uc-coord-title">{entry.entity}</div>
              <div className="uc-coord-meta">
                total: {total.toFixed(1)} &middot;{" "}
                {Object.entries(entry.scores)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(" &middot; ")}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
});

const TemplatesTab = memo(function TemplatesTab() {
  const { data, isLoading } = useRoomTemplates();
  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="room templates" />;
  return (
    <div className="uc-cmd-msgs">
      {data.map((t: RoomTemplateEntry) => (
        <div key={t.name} className="uc-coord-item" style={{ cursor: "default" }}>
          <div className="uc-coord-dot active" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">{t.name}</div>
            {t.description && (
              <div className="uc-coord-meta">
                {t.description.length > 80 ? `${t.description.slice(0, 80)}...` : t.description}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
});

const RecipesTab = memo(function RecipesTab() {
  const { data, isLoading } = useRecipes();
  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="recipes" />;
  return (
    <div className="uc-cmd-msgs">
      {data.map((r: RecipeEntry) => (
        <div key={r.name} className="uc-coord-item" style={{ cursor: "default" }}>
          <div className="uc-coord-dot active" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">{r.name}</div>
            <div className="uc-coord-meta">{r.description}</div>
            <div className="uc-coord-meta" style={{ color: "#666" }}>
              {r.orchestration} &middot; {r.taskCount} tasks &middot; {r.agentCount} agent
              {r.agentCount !== 1 ? "s" : ""}
              {r.agentRole ? ` &middot; ${r.agentRole}` : ""}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
});

const _EventsTab = memo(function EventsTab({
  onEntityClick,
}: {
  onEntityClick?: (name: string) => void;
}) {
  const eventFeed = useWorldState((s) => s.eventFeed);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new events
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [eventFeed.length]);

  if (eventFeed.length === 0) {
    return (
      <div
        style={{
          padding: "16px",
          textAlign: "center",
          color: "#888",
          fontSize: "clamp(15px, 1.05vw, 22px)",
        }}
      >
        No events yet — waiting for world activity...
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="uc-cmd-msgs">
      {eventFeed.slice(-100).map((event: DashboardEvent, i: number) => {
        if (event.type === "tick") return null;
        const typeColor = EVENT_TYPE_COLORS[event.type] ?? "#888";
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only event stream has no stable per-event id; timestamps can collide
            key={`${event.timestamp}-${i}`}
            style={{
              display: "flex",
              gap: "8px",
              padding: "3px 12px",
              fontSize: "clamp(14px, 0.95vw, 20px)",
              fontFamily: "'VT323', monospace",
              borderBottom: "1px solid rgba(255,255,255,0.03)",
              alignItems: "baseline",
            }}
          >
            <span style={{ color: "#666", flexShrink: 0, fontSize: "clamp(12px, 0.8vw, 16px)" }}>
              {formatEventTime(event.timestamp)}
            </span>
            {(event.entity || (event.type === "agent_error" && event.name)) && (
              <button
                type="button"
                onClick={() => {
                  const name = event.entity ?? event.name;
                  if (name) onEntityClick?.(name);
                }}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--color-primary)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: "inherit",
                  padding: 0,
                  fontWeight: "bold",
                  flexShrink: 0,
                }}
              >
                {event.entity ?? event.name}
              </button>
            )}
            <span style={{ color: typeColor, flexShrink: 0 }}>[{event.type}]</span>
            <span
              style={{
                color: "#bbb",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {event.type === "agent_error"
                ? (event.error ?? "unknown error")
                : (event.input ?? event.room ?? "")}
            </span>
          </div>
        );
      })}
    </div>
  );
});

// ── Coordination Tab Components ─────────────────────────────────────────────

/** Shared loading / empty state for coord tabs. */
const CoordLoading = memo(function CoordLoading() {
  return (
    <div
      style={{
        padding: "12px 14px",
        color: "#999",
        fontFamily: "'VT323', monospace",
        fontSize: "clamp(15px, 1.05vw, 22px)",
      }}
    >
      Loading...
    </div>
  );
});

const CoordEmpty = memo(function CoordEmpty({ label }: { label: string }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#888",
        fontFamily: "'VT323', monospace",
        fontSize: "clamp(15px, 1.05vw, 22px)",
      }}
    >
      No {label} found
    </div>
  );
});

/** Status dot color for projects/tasks. */
function statusDotClass(status: string): string {
  if (status === "active" || status === "open") return "active";
  if (status === "claimed" || status === "submitted" || status === "paused") return "pending";
  return "done";
}

/** Task status icon: open, claimed, submitted, done. */
function taskStatusIcon(status: string): string {
  switch (status) {
    case "open":
      return "\u25CB"; // ○
    case "claimed":
      return "\u25D0"; // ◐
    case "submitted":
      return "\u25D1"; // ◑
    case "completed":
      return "\u25CF"; // ●
    default:
      return "\u25CB";
  }
}

const _ProjectsTab = memo(function ProjectsTab() {
  const { data, isLoading } = useProjects();

  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="projects" />;

  return (
    <div className="uc-cmd-msgs">
      {data.map((p: ProjectEntry) => (
        <div key={p.id} className="uc-coord-item">
          <div className={`uc-coord-dot ${statusDotClass(p.status)}`} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">{p.name}</div>
            <div className="uc-coord-meta">
              {p.status} | {p.orchestration}
              {p.bundleProgress
                ? ` | ${p.bundleProgress.done}/${p.bundleProgress.total} tasks`
                : ""}
            </div>
            {p.description && (
              <div className="uc-coord-meta" style={{ color: "#555" }}>
                {p.description.length > 100 ? `${p.description.slice(0, 100)}...` : p.description}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
});

const _TasksTab = memo(function TasksTab() {
  const { data, isLoading } = useTasks();

  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="tasks" />;

  return (
    <div className="uc-cmd-msgs">
      {data.map((t: TaskEntry) => (
        <div key={t.id} className="uc-coord-item">
          <span
            style={{
              fontSize: "clamp(16px, 1.12vw, 22px)",
              color:
                t.status === "open"
                  ? "var(--color-success)"
                  : t.status === "claimed"
                    ? "var(--color-secondary)"
                    : t.status === "submitted"
                      ? "var(--color-teal, #2dd4bf)"
                      : "#444",
              flexShrink: 0,
              width: "18px",
              textAlign: "center",
            }}
            title={t.status}
          >
            {taskStatusIcon(t.status)}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">
              <span style={{ color: "#555" }}>#{t.id}</span> {t.title}
            </div>
            <div className="uc-coord-meta">
              {t.status} | by {t.creator_name}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
});

const _BoardsTab = memo(function BoardsTab() {
  const { data, isLoading } = useBoards();

  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="boards" />;

  return (
    <div className="uc-cmd-msgs">
      {data.map((b: BoardEntry) => (
        <div key={b.id} className="uc-coord-item">
          <div className="uc-coord-dot active" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">{b.name}</div>
            <div className="uc-coord-meta">
              {b.scope_type} | {b.postCount} post{b.postCount !== 1 ? "s" : ""}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
});

const _PoolsTab = memo(function PoolsTab() {
  const { data, isLoading } = useMemoryPools();

  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="pools" />;

  return (
    <div className="uc-cmd-msgs">
      {data.map((p: MemoryPool) => (
        <div key={p.id} className="uc-coord-item">
          <div className="uc-coord-dot active" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">{p.name}</div>
            <div className="uc-coord-meta">
              by {p.created_by}
              {p.group_id ? ` | group: ${p.group_id}` : ""}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
});

const PoolsTabClickable = memo(function PoolsTabClickable({
  onSelect,
}: {
  onSelect: (id: string) => void;
}) {
  const { data, isLoading } = useMemoryPools();
  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="pools" />;
  return (
    <div className="uc-cmd-msgs">
      {data.map((p: MemoryPool) => (
        <button
          type="button"
          key={p.id}
          className="uc-coord-item"
          style={{
            width: "100%",
            textAlign: "left",
            background: "none",
            border: "none",
            cursor: "pointer",
          }}
          onClick={() => onSelect(p.id)}
        >
          <div className="uc-coord-dot active" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">{p.name}</div>
            <div className="uc-coord-meta">
              by {p.created_by}
              {p.group_id ? ` | group: ${p.group_id}` : ""}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
});

const _GroupsTab = memo(function GroupsTab() {
  const { data, isLoading } = useGroups();

  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="groups" />;

  return (
    <div className="uc-cmd-msgs">
      {data.map((g: GroupEntry) => (
        <div key={g.id} className="uc-coord-item">
          <div className="uc-coord-dot active" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">{g.name}</div>
            <div className="uc-coord-meta">
              {g.memberCount} member{g.memberCount !== 1 ? "s" : ""}
              {g.description ? ` | ${g.description}` : ""}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
});

const _ChannelsTab = memo(function ChannelsTab() {
  const { data, isLoading } = useChannels();

  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="channels" />;

  return (
    <div className="uc-cmd-msgs">
      {data.map((c: ChannelEntry) => (
        <div key={c.id} className="uc-coord-item">
          <div className="uc-coord-dot active" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">#{c.name}</div>
            <div className="uc-coord-meta">
              {c.type} | {c.messageCount} message{c.messageCount !== "1" ? "s" : ""}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
});

// ── Clickable variants for drill-down ──────────────────────────────────────

const ProjectsTabClickable = memo(function ProjectsTabClickable({
  onSelect,
}: {
  onSelect: (id: string) => void;
}) {
  const { data, isLoading } = useProjects();
  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="projects" />;
  return (
    <div className="uc-cmd-msgs">
      {data.map((p: ProjectEntry) => (
        <button
          type="button"
          key={p.id}
          className="uc-coord-item"
          style={{ width: "100%", textAlign: "left", background: "none", border: "none" }}
          onClick={() => onSelect(p.id)}
        >
          <div className={`uc-coord-dot ${statusDotClass(p.status)}`} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">{p.name}</div>
            <div className="uc-coord-meta">
              {p.status} | {p.orchestration}
              {p.bundleProgress
                ? ` | ${p.bundleProgress.done}/${p.bundleProgress.total} tasks`
                : ""}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
});

const TasksTabClickable = memo(function TasksTabClickable({
  onSelect,
}: {
  onSelect: (id: number) => void;
}) {
  const { data, isLoading } = useTasks();
  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="tasks" />;
  return (
    <div className="uc-cmd-msgs">
      {data.map((t: TaskEntry) => (
        <button
          type="button"
          key={t.id}
          className="uc-coord-item"
          style={{ width: "100%", textAlign: "left", background: "none", border: "none" }}
          onClick={() => onSelect(t.id)}
        >
          <span
            style={{
              fontSize: "clamp(16px, 1.12vw, 22px)",
              color:
                t.status === "open"
                  ? "var(--color-success)"
                  : t.status === "claimed"
                    ? "var(--color-secondary)"
                    : "#444",
              flexShrink: 0,
              width: "18px",
              textAlign: "center",
            }}
            title={t.status}
          >
            {taskStatusIcon(t.status)}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">
              <span style={{ color: "#555" }}>#{t.id}</span> {t.title}
            </div>
            <div className="uc-coord-meta">
              {t.status} | by {t.creator_name}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
});

const BoardsTabClickable = memo(function BoardsTabClickable({
  onSelect,
}: {
  onSelect: (name: string) => void;
}) {
  const { data, isLoading } = useBoards();
  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="boards" />;
  return (
    <div className="uc-cmd-msgs">
      {data.map((b: BoardEntry) => (
        <button
          type="button"
          key={b.id}
          className="uc-coord-item"
          style={{ width: "100%", textAlign: "left", background: "none", border: "none" }}
          onClick={() => onSelect(b.name)}
        >
          <div className="uc-coord-dot active" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">{b.name}</div>
            <div className="uc-coord-meta">
              {b.scope_type} | {b.postCount} post{b.postCount !== 1 ? "s" : ""}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
});

const GroupsTabClickable = memo(function GroupsTabClickable({
  onSelect,
}: {
  onSelect: (name: string) => void;
}) {
  const { data, isLoading } = useGroups();
  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="groups" />;
  return (
    <div className="uc-cmd-msgs">
      {data.map((g: GroupEntry) => (
        <button
          type="button"
          key={g.id}
          className="uc-coord-item"
          style={{ width: "100%", textAlign: "left", background: "none", border: "none" }}
          onClick={() => onSelect(g.name)}
        >
          <div className="uc-coord-dot active" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">{g.name}</div>
            <div className="uc-coord-meta">
              {g.memberCount} member{g.memberCount !== 1 ? "s" : ""}
              {g.description ? ` | ${g.description}` : ""}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
});

const ChannelsTabClickable = memo(function ChannelsTabClickable({
  onSelect,
}: {
  onSelect: (name: string) => void;
}) {
  const { data, isLoading } = useChannels();
  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="channels" />;
  return (
    <div className="uc-cmd-msgs">
      {data.map((c: ChannelEntry) => (
        <button
          type="button"
          key={c.id}
          className="uc-coord-item"
          style={{ width: "100%", textAlign: "left", background: "none", border: "none" }}
          onClick={() => onSelect(c.name)}
        >
          <div className="uc-coord-dot active" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">#{c.name}</div>
            <div className="uc-coord-meta">
              {c.type} | {c.messageCount} message{c.messageCount !== "1" ? "s" : ""}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
});

const _ConnectorsTab = memo(function ConnectorsTab() {
  const { data, isLoading } = useConnectors();

  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="connectors" />;

  return (
    <div className="uc-cmd-msgs">
      {data.map((c: ConnectorEntry) => (
        <div key={c.id} className="uc-coord-item">
          <div
            className={`uc-coord-dot ${c.status === "connected" || c.status === "active" ? "active" : c.status === "error" ? "done" : "pending"}`}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">{c.name}</div>
            <div className="uc-coord-meta">
              {c.transport} | {c.status}
              {c.url ? ` | ${c.url}` : ""}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
});

const _CommandsTab = memo(function CommandsTab() {
  const { data, isLoading } = useDynamicCommands();

  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="commands" />;

  return (
    <div className="uc-cmd-msgs">
      {data.map((c: DynamicCommandEntry) => (
        <div key={c.id} className="uc-coord-item">
          <div className={`uc-coord-dot ${c.valid ? "active" : "done"}`} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">{c.name}</div>
            <div className="uc-coord-meta">
              v{c.version} | {c.valid ? "valid" : "invalid"} | by {c.created_by}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
});

/** Merged integrations tab — connectors + adapters + setup. */
const IntegrationsTab = memo(function IntegrationsTab({
  onSelect,
  sendCommand: _sendCommand,
}: {
  onSelect: (id: string) => void;
  sendCommand?: (cmd: string) => void;
}) {
  const { data: connectors, isLoading: connLoading } = useConnectors();
  const { data: adapters, isLoading: adpLoading, refetch: refetchAdapters } = useAdapters();
  const [adding, setAdding] = useState(false);
  const [platform, setPlatform] = useState("");
  const [token, setToken] = useState("");

  const handleAdd = useCallback(async () => {
    if (!platform || !token) return;
    try {
      const { postApi } = await import("../../lib/api");
      await postApi("/api/adapters", { platform, config: JSON.stringify({ token }) });
      setPlatform("");
      setToken("");
      setAdding(false);
      refetchAdapters();
    } catch {
      /* */
    }
  }, [platform, token, refetchAdapters]);

  const handleToggle = useCallback(
    async (p: string, currentlyRunning: boolean) => {
      try {
        const { putApi } = await import("../../lib/api");
        await putApi(`/api/adapters/${encodeURIComponent(p)}`, {
          status: currentlyRunning ? "disabled" : "active",
        });
        refetchAdapters();
      } catch {
        /* */
      }
    },
    [refetchAdapters],
  );

  const handleDelete = useCallback(
    async (p: string) => {
      try {
        const { deleteApi } = await import("../../lib/api");
        await deleteApi(`/api/adapters/${encodeURIComponent(p)}`);
        refetchAdapters();
      } catch {
        /* */
      }
    },
    [refetchAdapters],
  );

  if (connLoading && adpLoading) return <CoordLoading />;

  const inputStyle = {
    width: "100%",
    background: "rgba(17,17,24,0.6)",
    border: "1px solid var(--color-border)",
    color: "#ddd",
    fontFamily: "'VT323', monospace",
    fontSize: "clamp(14px, 0.95vw, 18px)",
    padding: "3px 8px",
    outline: "none",
  } as const;

  return (
    <div className="uc-cmd-msgs">
      {/* Add integration */}
      <div style={{ padding: "6px 12px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        {adding ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              style={inputStyle}
            >
              <option value="">Platform...</option>
              <option value="telegram">Telegram</option>
              <option value="discord">Discord</option>
            </select>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={
                platform === "telegram"
                  ? "Bot token from @BotFather"
                  : platform === "discord"
                    ? "Discord bot token"
                    : "Bot token..."
              }
              style={inputStyle}
            />
            <div style={{ display: "flex", gap: "4px" }}>
              <ActionBtn label="CONNECT" color="#22c55e" onClick={handleAdd} />
              <ActionBtn label="CANCEL" onClick={() => setAdding(false)} />
            </div>
          </div>
        ) : (
          <ActionBtn label="+ INTEGRATION" color="#22c55e" onClick={() => setAdding(true)} />
        )}
      </div>

      {/* Adapters (runtime integrations) */}
      {(adapters ?? []).map((a: AdapterStatus) => (
        <div key={a.platform} className="uc-coord-item" style={{ cursor: "default" }}>
          <div className={`uc-coord-dot ${a.running ? "active" : "done"}`} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">{a.platform}</div>
            <div className="uc-coord-meta">
              {a.running ? "Running" : a.status} | {a.source}
            </div>
          </div>
          <button
            type="button"
            onClick={() => handleToggle(a.platform, a.running)}
            style={{
              background: "none",
              border: "none",
              color: a.running ? "#f59e0b" : "#22c55e",
              cursor: "pointer",
              fontFamily: "'VT323'",
              fontSize: "12px",
              padding: "2px 6px",
            }}
            title={a.running ? "Disable" : "Enable"}
          >
            {a.running ? "STOP" : "START"}
          </button>
          {a.source === "db" && (
            <button
              type="button"
              onClick={() => handleDelete(a.platform)}
              style={{
                background: "none",
                border: "none",
                color: "#ef4444",
                cursor: "pointer",
                fontFamily: "'VT323'",
                fontSize: "12px",
                padding: "2px 6px",
                opacity: 0.6,
              }}
              title="Remove"
            >
              x
            </button>
          )}
        </div>
      ))}

      {/* Connectors (configured connections) */}
      {(connectors ?? []).map((c: ConnectorEntry) => (
        <button
          type="button"
          key={c.id}
          className="uc-coord-item"
          style={{
            width: "100%",
            textAlign: "left",
            background: "none",
            border: "none",
            cursor: "pointer",
          }}
          onClick={() => onSelect(c.id)}
        >
          <div
            className={`uc-coord-dot ${c.status === "connected" || c.status === "active" ? "active" : c.status === "error" ? "done" : "pending"}`}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">{c.name}</div>
            <div className="uc-coord-meta">
              {c.transport} | {c.status}
              {c.url ? ` | ${c.url}` : ""}
            </div>
          </div>
        </button>
      ))}

      {(adapters ?? []).length === 0 && (connectors ?? []).length === 0 && (
        <div
          style={{
            padding: "16px",
            textAlign: "center",
            color: "#888",
            fontSize: "clamp(14px, 0.95vw, 18px)",
          }}
        >
          No integrations configured. Add Telegram or Discord above.
        </div>
      )}
    </div>
  );
});

const CommandsTabClickable = memo(function CommandsTabClickable({
  onSelect,
}: {
  onSelect: (id: string) => void;
}) {
  const { data, isLoading } = useDynamicCommands();
  if (isLoading) return <CoordLoading />;
  if (!data?.length) return <CoordEmpty label="commands" />;
  return (
    <div className="uc-cmd-msgs">
      {data.map((c: DynamicCommandEntry) => (
        <button
          type="button"
          key={c.id}
          className="uc-coord-item"
          style={{
            width: "100%",
            textAlign: "left",
            background: "none",
            border: "none",
            cursor: "pointer",
          }}
          onClick={() => onSelect(c.id)}
        >
          <div className={`uc-coord-dot ${c.valid ? "active" : "done"}`} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="uc-coord-title">{c.name}</div>
            <div className="uc-coord-meta">
              v{c.version} | {c.valid ? "valid" : "invalid"} | by {c.created_by}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
});

// ── Coordination Detail Panel ─────────────────────────────────────────────

/** Inline text prompt — click button, type text, press Enter to execute command. */
const InlinePrompt = memo(function InlinePrompt({
  label,
  placeholder,
  color,
  onSubmit,
}: {
  label: string;
  placeholder: string;
  color?: string;
  onSubmit: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) {
    return <ActionBtn label={label} color={color} onClick={() => setOpen(true)} />;
  }

  return (
    <div style={{ display: "flex", gap: "4px", alignItems: "center", flex: 1, minWidth: 0 }}>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && value.trim()) {
            onSubmit(value.trim());
            setValue("");
            setOpen(false);
          }
          if (e.key === "Escape") {
            setValue("");
            setOpen(false);
          }
        }}
        placeholder={placeholder}
        style={{
          flex: 1,
          minWidth: 0,
          background: "rgba(17,17,24,0.6)",
          border: `1px solid ${color ?? "var(--color-border)"}`,
          color: "#ddd",
          fontFamily: "'VT323', monospace",
          fontSize: "clamp(14px, 0.95vw, 18px)",
          padding: "3px 8px",
          outline: "none",
        }}
      />
      <ActionBtn
        label="GO"
        color={color}
        onClick={() => {
          if (value.trim()) {
            onSubmit(value.trim());
            setValue("");
            setOpen(false);
          }
        }}
      />
      <ActionBtn
        label="X"
        onClick={() => {
          setValue("");
          setOpen(false);
        }}
      />
    </div>
  );
});

/** Inline action button for detail views. */
const ActionBtn = memo(function ActionBtn({
  label,
  onClick,
  color,
}: {
  label: string;
  onClick: () => void;
  color?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "3px 10px",
        background: "none",
        border: `1px solid ${color ?? "var(--color-border)"}`,
        color: color ?? "#888",
        fontFamily: "'Press Start 2P', monospace",
        fontSize: "clamp(6px, 0.45vw, 8px)",
        cursor: "pointer",
        flexShrink: 0,
      }}
    >
      {label}
    </button>
  );
});

/** Clickable entity/item link within detail views. */
const DetailLink = memo(function DetailLink({
  label,
  onClick,
  color,
}: {
  label: string;
  onClick: () => void;
  color?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: "none",
        border: "none",
        color: color ?? "var(--color-teal, #06b6d4)",
        cursor: "pointer",
        fontFamily: "'VT323', monospace",
        fontSize: "inherit",
        padding: 0,
        textDecoration: "underline",
        textDecorationColor: "rgba(6,182,212,0.3)",
      }}
    >
      {label}
    </button>
  );
});

/** Props shared by all detail inline components. */
interface DetailProps {
  onNavigate: (detail: CoordDetail) => void;
  onEntityClick?: (name: string) => void;
  sendCommand?: (cmd: string) => void;
}

/** Panel that shows detail view for a coordination item. */
const CoordDetailView = memo(function CoordDetailView({
  detail,
  onBack,
  onNavigate,
  onEntityClick,
  sendCommand,
}: {
  detail: CoordDetail;
  onBack: () => void;
  onNavigate: (detail: CoordDetail) => void;
  onEntityClick?: (name: string) => void;
  sendCommand?: (cmd: string) => void;
}) {
  const dp: DetailProps = { onNavigate, onEntityClick, sendCommand };
  return (
    <div className="uc-cmd-msgs" style={{ display: "flex", flexDirection: "column" }}>
      <button
        type="button"
        onClick={onBack}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          padding: "6px 12px",
          background: "none",
          border: "none",
          borderBottom: "1px solid var(--color-border)",
          color: "#bbb",
          cursor: "pointer",
          fontFamily: "'VT323', monospace",
          fontSize: "clamp(14px, 0.98vw, 20px)",
          flexShrink: 0,
        }}
      >
        &larr; Back
      </button>
      <div style={{ flex: 1, overflow: "auto", padding: "8px 12px" }}>
        {detail.kind === "task" && <TaskDetailInline id={detail.id} {...dp} />}
        {detail.kind === "board" && <BoardDetailInline name={detail.name} {...dp} />}
        {detail.kind === "group" && <GroupDetailInline name={detail.name} {...dp} />}
        {detail.kind === "channel" && <ChannelDetailInline name={detail.name} {...dp} />}
        {detail.kind === "project" && <ProjectDetailInline id={detail.id} {...dp} />}
        {detail.kind === "pool" && <PoolDetailInline id={detail.id} {...dp} />}
        {detail.kind === "connector" && <ConnectorDetailInline id={detail.id} {...dp} />}
        {detail.kind === "command" && <CommandDetailInline id={detail.id} {...dp} />}
      </div>
    </div>
  );
});

const TaskDetailInline = memo(function TaskDetailInline({
  id,
  onNavigate,
  onEntityClick,
  sendCommand,
}: { id: number } & DetailProps) {
  const { data, isLoading } = useTaskDetail(id);
  if (isLoading) return <CoordLoading />;
  if (!data) return <CoordEmpty label="task" />;
  return (
    <div>
      <div className="uc-coord-title" style={{ marginBottom: "4px" }}>
        #{data.id} {data.title}
      </div>
      <div className="uc-coord-meta">Status: {data.status}</div>
      <div className="uc-coord-meta">
        Creator:{" "}
        <DetailLink label={data.creator_name} onClick={() => onEntityClick?.(data.creator_name)} />
      </div>
      {data.assignee_name && (
        <div className="uc-coord-meta">
          Assignee:{" "}
          <DetailLink
            label={data.assignee_name}
            onClick={() => onEntityClick?.(data.assignee_name!)}
          />
        </div>
      )}
      {data.description && (
        <div className="uc-coord-meta" style={{ color: "#bbb", marginTop: "4px" }}>
          {data.description}
        </div>
      )}
      {/* Action buttons */}
      <div style={{ display: "flex", gap: "6px", marginTop: "8px", flexWrap: "wrap" }}>
        {data.status === "open" && sendCommand && (
          <ActionBtn
            label="CLAIM"
            color="#22c55e"
            onClick={() => sendCommand(`task claim ${data.id}`)}
          />
        )}
        {data.status === "claimed" && sendCommand && (
          <ActionBtn
            label="SUBMIT"
            color="#06b6d4"
            onClick={() => sendCommand(`task submit ${data.id}`)}
          />
        )}
        {data.status === "submitted" && sendCommand && (
          <ActionBtn
            label="COMPLETE"
            color="var(--color-primary)"
            onClick={() => sendCommand(`task complete ${data.id}`)}
          />
        )}
      </div>
      {data.children && data.children.length > 0 && (
        <div style={{ marginTop: "8px" }}>
          <div className="uc-coord-meta" style={{ color: "var(--color-primary)" }}>
            Subtasks:
          </div>
          {data.children.map((c) => (
            <button
              type="button"
              key={c.id}
              className="uc-coord-item"
              style={{
                width: "100%",
                textAlign: "left",
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: "3px 0",
              }}
              onClick={() => onNavigate({ kind: "task", id: c.id })}
            >
              <div
                className={`uc-coord-dot ${c.status === "completed" ? "active" : c.status === "open" ? "pending" : "claimed"}`}
              />
              <span className="uc-coord-meta" style={{ color: "var(--color-teal)" }}>
                #{c.id} {c.title} [{c.status}]
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

const BoardDetailInline = memo(function BoardDetailInline({
  name,
  onEntityClick,
  sendCommand,
}: { name: string } & DetailProps) {
  const { data, isLoading } = useBoardDetail(name);
  if (isLoading) return <CoordLoading />;
  if (!data) return <CoordEmpty label="board" />;
  return (
    <div>
      <div className="uc-coord-title" style={{ marginBottom: "4px" }}>
        {data.name}
      </div>
      <div className="uc-coord-meta">
        {data.scope_type} | {data.postCount} posts
      </div>
      {sendCommand && (
        <div style={{ marginTop: "6px", marginBottom: "6px", display: "flex", gap: "6px" }}>
          <InlinePrompt
            label="POST"
            placeholder="Title | Body text..."
            color="var(--color-teal)"
            onSubmit={(text) => sendCommand(`board post ${name} ${text}`)}
          />
        </div>
      )}
      {data.posts?.map((p) => (
        <div
          key={p.id}
          style={{
            borderLeft: "2px solid var(--color-border)",
            paddingLeft: "8px",
            marginTop: "6px",
          }}
        >
          <div className="uc-coord-title" style={{ fontSize: "clamp(14px, 0.98vw, 20px)" }}>
            #{p.id} {p.title}
          </div>
          <div className="uc-coord-meta">{p.body.slice(0, 200)}</div>
          <div className="uc-coord-meta">
            by <DetailLink label={p.author_name} onClick={() => onEntityClick?.(p.author_name)} />
          </div>
          {sendCommand && (
            <div style={{ display: "flex", gap: "4px", marginTop: "4px", flexWrap: "wrap" }}>
              <InlinePrompt
                label="REPLY"
                placeholder="Reply text..."
                color="var(--color-teal)"
                onSubmit={(t) => sendCommand(`board reply ${p.id} ${t}`)}
              />
              <ActionBtn
                label="+1"
                color="#22c55e"
                onClick={() => sendCommand(`board vote ${p.id} up`)}
              />
              <ActionBtn
                label="-1"
                color="#ef4444"
                onClick={() => sendCommand(`board vote ${p.id} down`)}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
});

const GroupDetailInline = memo(function GroupDetailInline({
  name,
  onEntityClick,
  sendCommand,
}: { name: string } & DetailProps) {
  const { data, isLoading } = useGroupDetail(name);
  if (isLoading) return <CoordLoading />;
  if (!data) return <CoordEmpty label="group" />;
  return (
    <div>
      <div className="uc-coord-title" style={{ marginBottom: "4px" }}>
        {data.name}
      </div>
      <div className="uc-coord-meta">{data.memberCount} members</div>
      {data.description && <div className="uc-coord-meta">{data.description}</div>}
      <div className="uc-coord-meta">
        Leader:{" "}
        <DetailLink label={data.leader_id} onClick={() => onEntityClick?.(data.leader_id)} />
      </div>
      {sendCommand && (
        <div style={{ marginTop: "6px", marginBottom: "6px", display: "flex", gap: "6px" }}>
          <ActionBtn
            label="JOIN"
            color="#22c55e"
            onClick={() => sendCommand(`group join ${name}`)}
          />
          <ActionBtn
            label="LEAVE"
            color="#ef4444"
            onClick={() => sendCommand(`group leave ${name}`)}
          />
        </div>
      )}
      {data.members.length > 0 && (
        <div style={{ marginTop: "6px" }}>
          <div
            className="uc-coord-meta"
            style={{ color: "var(--color-primary)", marginBottom: "4px" }}
          >
            Members:
          </div>
          {data.members.map((m) => (
            <button
              type="button"
              key={m.entity_id}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: "2px 0",
              }}
              onClick={() => onEntityClick?.(m.entity_id)}
            >
              <span className="uc-coord-meta" style={{ color: "var(--color-teal)" }}>
                {m.entity_id}
              </span>
              <span className="uc-coord-meta"> (rank {m.rank})</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

const ChannelDetailInline = memo(function ChannelDetailInline({
  name,
  onEntityClick,
  sendCommand,
}: { name: string } & DetailProps) {
  const { data, isLoading } = useChannelDetail(name);
  if (isLoading) return <CoordLoading />;
  if (!data) return <CoordEmpty label="channel" />;
  return (
    <div>
      <div className="uc-coord-title" style={{ marginBottom: "4px" }}>
        #{data.name}
      </div>
      <div className="uc-coord-meta">{data.type}</div>
      {sendCommand && (
        <div style={{ marginTop: "6px", marginBottom: "6px", display: "flex", gap: "6px" }}>
          <ActionBtn
            label="SUBSCRIBE"
            color="#22c55e"
            onClick={() => sendCommand(`channel sub ${name}`)}
          />
          <InlinePrompt
            label="SEND"
            placeholder="Type message..."
            color="var(--color-teal)"
            onSubmit={(text) => sendCommand(`channel send ${name} ${text}`)}
          />
        </div>
      )}
      {data.messages?.map((m) => (
        <div
          key={`${m.sender_name}-${m.created_at}`}
          style={{
            marginTop: "4px",
            borderLeft: "2px solid var(--color-border)",
            paddingLeft: "8px",
          }}
        >
          <div className="uc-coord-meta">
            <DetailLink
              label={m.sender_name}
              color="var(--color-secondary)"
              onClick={() => onEntityClick?.(m.sender_name)}
            />
          </div>
          <div className="uc-coord-meta">{m.content}</div>
        </div>
      ))}
    </div>
  );
});

// NOTE: keep in sync with src/world/templates/orchestration.ts
// ORCHESTRATION_PATTERNS. Dashboard bundle is separate so we can't import.
const ORCHESTRATION_PATTERNS = [
  "deliberation",
  "chorus",
  "foundry",
  "swarm",
  "pipeline",
  "debate",
  "mapreduce",
  "blackboard",
  "symbiosis",
  "research",
  "custom",
];

const ProjectDetailInline = memo(function ProjectDetailInline({
  id,
  onNavigate: _onNavigate,
  onEntityClick,
}: { id: string } & DetailProps) {
  const { data, isLoading, refetch } = useProjects();
  const [changingOrch, setChangingOrch] = useState(false);

  const handleOrchChange = useCallback(
    async (newOrch: string, projectId: string) => {
      setChangingOrch(true);
      try {
        const { postApi } = await import("../../lib/api");
        await postApi(`/api/coordination/projects/${encodeURIComponent(projectId)}/orchestration`, {
          orchestration: newOrch,
        });
        refetch();
      } finally {
        setChangingOrch(false);
      }
    },
    [refetch],
  );

  if (isLoading) return <CoordLoading />;
  const project = data?.find((p) => p.id === id);
  if (!project) return <CoordEmpty label="project" />;
  return (
    <div>
      <div className="uc-coord-title" style={{ marginBottom: "4px" }}>
        {project.name}
      </div>
      <div className="uc-coord-meta">
        {project.status} | {project.orchestration}
      </div>
      {project.description && <div className="uc-coord-meta">{project.description}</div>}
      <div className="uc-coord-meta">Memory: {project.memory_arch}</div>
      <div className="uc-coord-meta">
        Created by:{" "}
        <DetailLink
          label={project.created_by}
          onClick={() => onEntityClick?.(project.created_by)}
        />
      </div>
      {project.bundleProgress && (
        <div className="uc-coord-meta">
          Progress: {project.bundleProgress.done}/{project.bundleProgress.total} tasks
        </div>
      )}
      <div style={{ marginTop: "8px" }}>
        <div
          style={{
            fontSize: "clamp(8px, 0.55vw, 10px)",
            color: "#888",
            fontFamily: "'Press Start 2P', monospace",
            marginBottom: "4px",
          }}
        >
          ORCHESTRATION
        </div>
        <select
          value={project.orchestration}
          disabled={changingOrch}
          onChange={(e) => handleOrchChange(e.target.value, project.id)}
          style={{
            width: "100%",
            background: "rgba(17,17,24,0.6)",
            border: "1px solid var(--color-border)",
            color: "#ddd",
            fontFamily: "'VT323', monospace",
            fontSize: "clamp(14px, 0.95vw, 18px)",
            padding: "3px 8px",
            outline: "none",
          }}
        >
          {ORCHESTRATION_PATTERNS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
});

const PoolDetailInline = memo(function PoolDetailInline({
  id,
  onEntityClick,
  sendCommand,
}: { id: string } & DetailProps) {
  const { data, isLoading } = useMemoryPools();
  if (isLoading) return <CoordLoading />;
  const pool = data?.find((p) => p.id === id);
  if (!pool) return <CoordEmpty label="pool" />;
  return (
    <div>
      <div className="uc-coord-title" style={{ marginBottom: "4px" }}>
        {pool.name}
      </div>
      <div className="uc-coord-meta">
        Created by:{" "}
        <DetailLink label={pool.created_by} onClick={() => onEntityClick?.(pool.created_by)} />
      </div>
      {pool.group_id && <div className="uc-coord-meta">Group: {pool.group_id}</div>}
      {sendCommand && (
        <div style={{ display: "flex", gap: "6px", marginTop: "8px" }}>
          <ActionBtn
            label="RECALL"
            color="var(--color-teal)"
            onClick={() => sendCommand(`pool recall ${pool.name}`)}
          />
        </div>
      )}
    </div>
  );
});

const ConnectorDetailInline = memo(function ConnectorDetailInline({ id }: { id: string }) {
  const { data, isLoading } = useConnectors();
  if (isLoading) return <CoordLoading />;
  const connector = data?.find((c) => c.id === id);
  if (!connector) return <CoordEmpty label="connector" />;
  return (
    <div>
      <div className="uc-coord-title" style={{ marginBottom: "4px" }}>
        {connector.name}
      </div>
      <div className="uc-coord-meta">Transport: {connector.transport}</div>
      <div className="uc-coord-meta">
        Status:{" "}
        <span
          style={{
            color:
              connector.status === "connected" || connector.status === "active"
                ? "#22c55e"
                : connector.status === "error"
                  ? "#ef4444"
                  : "#888",
          }}
        >
          {connector.status}
        </span>
      </div>
      {connector.url && <div className="uc-coord-meta">URL: {connector.url}</div>}
      {connector.auth_type && <div className="uc-coord-meta">Auth: {connector.auth_type}</div>}
      <div className="uc-coord-meta">Created by: {connector.created_by}</div>
    </div>
  );
});

const CommandDetailInline = memo(function CommandDetailInline({
  id,
  onEntityClick,
  sendCommand,
}: { id: string } & DetailProps) {
  const { data, isLoading } = useDynamicCommands();
  if (isLoading) return <CoordLoading />;
  const command = data?.find((c) => c.id === id);
  if (!command) return <CoordEmpty label="command" />;
  return (
    <div>
      <div className="uc-coord-title" style={{ marginBottom: "4px" }}>
        {command.name}
      </div>
      <div className="uc-coord-meta">Version: {command.version}</div>
      <div className="uc-coord-meta">
        Valid:{" "}
        <span style={{ color: command.valid ? "#22c55e" : "#ef4444" }}>
          {command.valid ? "Yes" : "No"}
        </span>
      </div>
      <div className="uc-coord-meta">
        Created by:{" "}
        <DetailLink
          label={command.created_by}
          onClick={() => onEntityClick?.(command.created_by)}
        />
      </div>
      {command.created_at > 0 && (
        <div className="uc-coord-meta">
          Created: {new Date(command.created_at).toLocaleDateString()}
        </div>
      )}
      {sendCommand && (
        <div style={{ display: "flex", gap: "6px", marginTop: "8px", flexWrap: "wrap" }}>
          <ActionBtn
            label="RUN"
            color="var(--color-teal)"
            onClick={() => sendCommand(command.name)}
          />
          <ActionBtn
            label="VIEW CODE"
            color="#888"
            onClick={() => sendCommand(`build command code ${command.name}`)}
          />
          <ActionBtn
            label="VALIDATE"
            color="#22c55e"
            onClick={() => sendCommand(`build command validate ${command.name}`)}
          />
          <ActionBtn
            label="RELOAD"
            color="var(--color-primary)"
            onClick={() => sendCommand(`build command reload ${command.name}`)}
          />
          <ActionBtn
            label="DELETE"
            color="#ef4444"
            onClick={() => sendCommand(`build command destroy ${command.name}`)}
          />
        </div>
      )}
    </div>
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
          {/* Connection dot */}
          <span
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
            >
              _
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
