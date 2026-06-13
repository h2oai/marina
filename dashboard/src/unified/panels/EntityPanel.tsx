/**
 * EntityPanel -- Fixed sidebar panel for entity management.
 *
 * Positioned at bottom-left, alongside the command bar. Shows:
 * - Online: entity roster with clickable names
 * - Launch: agent spawn form
 * - Roles: role browser with detail drill-down
 */

import type { ReactElement } from "react";
import { memo, useCallback, useMemo, useState } from "react";
import { useAgents, useKeys, useRoles } from "../../hooks/use-api";
import { useWorldState } from "../../hooks/use-world-state";
import { postApi } from "../../lib/api";
import type { AgentStatusFull, RoleEntry } from "../../lib/types";

/** Props for the EntityPanel component. */
export interface EntityPanelProps {
  visible: boolean;
  onClose: () => void;
  onEntityClick?: (name: string) => void;
  sendCommand?: (command: string) => void;
  onExpandChange?: (expanded: boolean) => void;
}

type EntityTab = "online" | "agents" | "launch" | "roles";

const MODEL_GROUPS = [
  {
    provider: "Anthropic",
    models: [
      { value: "anthropic/claude-opus-4-6", label: "Claude Opus 4.6" },
      { value: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { value: "anthropic/claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    ],
  },
  {
    provider: "OpenAI",
    models: [
      { value: "openai/gpt-4o", label: "GPT-4o" },
      { value: "openai/gpt-4o-mini", label: "GPT-4o Mini" },
    ],
  },
  { provider: "Google", models: [{ value: "google/gemini-2.0-flash", label: "Gemini 2.0 Flash" }] },
  {
    provider: "OpenRouter",
    models: [
      { value: "openrouter/google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { value: "openrouter/anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
      { value: "openrouter/anthropic/claude-opus-4.6", label: "Claude Opus 4.6" },
    ],
  },
  { provider: "Groq", models: [{ value: "groq/llama-3.3-70b-versatile", label: "Llama 3.3 70B" }] },
  {
    provider: "Mistral",
    models: [{ value: "mistral/mistral-large-latest", label: "Mistral Large" }],
  },
  { provider: "xAI", models: [{ value: "xai/grok-3-mini", label: "Grok 3 Mini" }] },
  { provider: "Cerebras", models: [{ value: "cerebras/llama3.1-8b", label: "Llama 3.1 8B" }] },
  { provider: "DeepSeek", models: [{ value: "deepseek/deepseek-chat", label: "DeepSeek Chat" }] },
];

const DEFAULT_MODEL = MODEL_GROUPS[0]!.models[0]!.value;

const STATE_COLORS: Record<string, string> = {
  thinking: "#FFDD00",
  working: "#22c55e",
  speaking: "#06b6d4",
  idle: "#666",
  error: "#ef4444",
  online: "#f0f0f0",
  running: "#22c55e",
  stopped: "#666",
};

const KIND_DOTS: Record<string, string> = {
  agent: "#FFDD00",
  human: "#f0f0f0",
  npc: "#22c55e",
  object: "#555",
};

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="uc-tab"
      style={{
        flex: 1,
        background: "none",
        border: "none",
        borderBottom: active ? "2px solid var(--color-primary)" : "2px solid transparent",
        color: active ? "var(--color-primary)" : "#888",
        cursor: "pointer",
        fontFamily: "'Press Start 2P', monospace",
        fontSize: "clamp(6px, 0.48vw, 8px)",
        padding: "6px 4px",
        textAlign: "center",
      }}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

// ── Online Tab ──────────────────────────────────────────────────────────────

const OnlineTab = memo(function OnlineTab({
  onEntityClick,
}: {
  onEntityClick?: (name: string) => void;
}) {
  const entities = useWorldState((s) => s.entities);
  const sorted = useMemo(
    () =>
      [...entities].sort((a, b) => {
        const kindOrder: Record<string, number> = { human: 0, agent: 1, npc: 2, object: 3 };
        return (kindOrder[a.kind] ?? 4) - (kindOrder[b.kind] ?? 4);
      }),
    [entities],
  );

  if (sorted.length === 0) {
    return (
      <div
        style={{
          padding: "12px",
          color: "#888",
          textAlign: "center",
          fontSize: "clamp(14px, 0.95vw, 18px)",
        }}
      >
        No entities online
      </div>
    );
  }

  return (
    <div style={{ overflow: "auto", flex: 1 }}>
      {sorted.map((entity) => {
        const state = entity.agentStatus?.state ?? "online";
        return (
          <button
            key={entity.name}
            type="button"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              width: "100%",
              padding: "5px 10px",
              background: "none",
              border: "none",
              borderBottom: "1px solid rgba(255,255,255,0.04)",
              cursor: "pointer",
              fontFamily: "'VT323', monospace",
              fontSize: "clamp(15px, 1vw, 20px)",
              textAlign: "left",
              color: "#ddd",
            }}
            onClick={() => onEntityClick?.(entity.name)}
          >
            {/* Kind dot */}
            <span
              style={{
                width: "8px",
                height: "8px",
                borderRadius: "50%",
                background: KIND_DOTS[entity.kind] ?? "#555",
                flexShrink: 0,
              }}
            />
            {/* Name */}
            <span
              style={{
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {entity.name}
            </span>
            {/* State */}
            <span
              style={{
                fontSize: "clamp(10px, 0.7vw, 14px)",
                color: STATE_COLORS[state] ?? "#666",
                flexShrink: 0,
              }}
            >
              {state}
            </span>
            {/* Room */}
            <span
              style={{
                fontSize: "clamp(10px, 0.7vw, 14px)",
                color: "#666",
                flexShrink: 0,
                maxWidth: "80px",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {entity.room.split("/").pop()}
            </span>
          </button>
        );
      })}
    </div>
  );
});

// ── Agents Tab ─────────────────────────────────────────────────────────────

const AgentsTab = memo(function AgentsTab({
  onEntityClick,
}: {
  onEntityClick?: (name: string) => void;
}) {
  const { data: agents } = useAgents();
  const running = useMemo(() => (agents ?? []).filter((a) => a.state !== "stopped"), [agents]);

  if (running.length === 0) {
    return (
      <div
        style={{
          padding: "12px",
          color: "#888",
          textAlign: "center",
          fontSize: "clamp(14px, 0.95vw, 18px)",
        }}
      >
        No agents running
      </div>
    );
  }

  return (
    <div style={{ overflow: "auto", flex: 1 }}>
      {running.map((agent) => (
        <AgentRow key={agent.name} agent={agent} onEntityClick={onEntityClick} />
      ))}
    </div>
  );
});

function renderSupportSummary(supports: {
  text: boolean;
  image?: boolean;
  video?: boolean;
}): ReactElement | null {
  const modes: string[] = [];
  if (supports.image) modes.push("image");
  if (supports.video) modes.push("video");
  if (modes.length === 0) return null;
  return <span style={{ color: "var(--color-accent)" }}>{modes.join(" · ")}</span>;
}

const AgentRow = memo(function AgentRow({
  agent,
  onEntityClick,
}: {
  agent: AgentStatusFull;
  onEntityClick?: (name: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [attention, setAttention] = useState("");
  const [sending, setSending] = useState(false);

  const modelShort = agent.model.split("/").pop() ?? agent.model;
  const isRoomAgent = agent.model.startsWith("marina/");
  const upMin = Math.round(agent.uptime / 60000);
  const stateColor = STATE_COLORS[agent.state] ?? "#666";

  const handleStop = useCallback(async () => {
    await postApi(`/api/agents/${encodeURIComponent(agent.name)}/stop`);
  }, [agent.name]);

  const handleAttention = useCallback(async () => {
    if (!attention.trim()) return;
    setSending(true);
    try {
      await postApi(`/api/agents/${encodeURIComponent(agent.name)}/attention`, {
        message: attention.trim(),
      });
      setAttention("");
    } finally {
      setSending(false);
    }
  }, [agent.name, attention]);

  return (
    <div
      style={{
        borderBottom: "1px solid rgba(255,255,255,0.04)",
        padding: "4px 10px",
      }}
    >
      {/* Header row */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          width: "100%",
          background: "none",
          border: "none",
          cursor: "pointer",
          fontFamily: "'VT323', monospace",
          fontSize: "clamp(15px, 1vw, 20px)",
          textAlign: "left",
          color: "#ddd",
          padding: 0,
        }}
      >
        <span
          style={{
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            background: stateColor,
            flexShrink: 0,
            boxShadow: agent.state === "error" ? `0 0 4px ${stateColor}` : undefined,
          }}
        />
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: nested inside a parent button; outer button handles keyboard */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: nested inside a parent <button> — cannot be a button itself; outer button handles keyboard */}
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: "4px",
          }}
          onClick={(e) => {
            e.stopPropagation();
            onEntityClick?.(agent.name);
          }}
        >
          {agent.name}
          {isRoomAgent && (
            <span
              style={{
                fontSize: "clamp(8px, 0.55vw, 10px)",
                color: "#06b6d4",
                border: "1px solid #06b6d4",
                padding: "0 3px",
                borderRadius: "2px",
                flexShrink: 0,
              }}
            >
              room
            </span>
          )}
        </span>
        <span style={{ fontSize: "clamp(10px, 0.7vw, 14px)", color: stateColor, flexShrink: 0 }}>
          {agent.state}
        </span>
        <span style={{ fontSize: "clamp(10px, 0.7vw, 14px)", color: "#666", flexShrink: 0 }}>
          {upMin}m
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleStop();
          }}
          style={{
            background: "none",
            border: "none",
            color: "#666",
            cursor: "pointer",
            fontFamily: "'VT323', monospace",
            fontSize: "clamp(12px, 0.8vw, 16px)",
          }}
          title="Stop agent"
        >
          &#x25A0;
        </button>
      </button>

      {/* Error reason — always shown when in error state */}
      {agent.state === "error" && agent.errorReason && (
        <div
          style={{
            color: "#ef4444",
            fontSize: "clamp(10px, 0.7vw, 14px)",
            padding: "2px 0 0 14px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {agent.errorReason}
        </div>
      )}

      {/* Expanded detail */}
      {expanded && (
        <div
          style={{
            padding: "4px 0 2px 14px",
            display: "flex",
            flexDirection: "column",
            gap: "3px",
          }}
        >
          <div
            style={{
              display: "flex",
              gap: "8px",
              fontSize: "clamp(10px, 0.7vw, 14px)",
              color: "#888",
            }}
          >
            <span>{modelShort}</span>
            {agent.role && <span style={{ color: "var(--color-accent)" }}>{agent.role}</span>}
            <span>{agent.toolCalls} calls</span>
            {agent.errors > 0 && <span style={{ color: "#ef4444" }}>{agent.errors} err</span>}
            {renderSupportSummary(agent.supports)}
          </div>
          {agent.goal && (
            <div
              style={{
                fontSize: "clamp(10px, 0.7vw, 14px)",
                color: "#888",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              <span style={{ color: "var(--color-primary)" }}>Goal:</span> {agent.goal}
            </div>
          )}
          {agent.focus && (
            <div
              style={{
                fontSize: "clamp(10px, 0.7vw, 14px)",
                color: "#888",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              <span style={{ color: "var(--color-primary)" }}>Focus:</span> {agent.focus}
            </div>
          )}
          {/* Attention input */}
          <div style={{ display: "flex", gap: "4px", marginTop: "2px" }}>
            <input
              type="text"
              placeholder="Send attention..."
              value={attention}
              onChange={(e) => setAttention(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAttention()}
              style={{
                flex: 1,
                background: "rgba(17,17,24,0.6)",
                border: "1px solid var(--color-border)",
                color: "#ddd",
                fontFamily: "'VT323', monospace",
                fontSize: "clamp(12px, 0.8vw, 16px)",
                padding: "2px 6px",
                outline: "none",
              }}
            />
            <button
              type="button"
              onClick={handleAttention}
              disabled={sending || !attention.trim()}
              style={{
                background: "none",
                border: "1px solid var(--color-border)",
                color: attention.trim() ? "var(--color-primary)" : "#555",
                cursor: attention.trim() ? "pointer" : "default",
                fontFamily: "'VT323', monospace",
                fontSize: "clamp(12px, 0.8vw, 16px)",
                padding: "2px 6px",
              }}
            >
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
});

// ── Launch Tab ──────────────────────────────────────────────────────────────

const LaunchTab = memo(function LaunchTab(_props: { sendCommand?: (cmd: string) => void }) {
  const { data: roles } = useRoles();
  const { data: keys } = useKeys();
  const [name, setName] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [customModel, setCustomModel] = useState("");
  const [role, setRole] = useState("");
  const [keyName, setKeyName] = useState("");
  const [goal, setGoal] = useState("");
  const [spawning, setSpawning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveModel = model === "__custom" ? customModel : model;

  const handleLaunch = useCallback(async () => {
    if (!name.trim() || !effectiveModel.trim()) return;
    setSpawning(true);
    setError(null);
    try {
      await postApi("/api/agents/spawn", {
        name: name.trim(),
        model: effectiveModel || undefined,
        role: role || undefined,
        goal: goal || undefined,
        keyName: keyName || undefined,
      });
      setName("");
      setGoal("");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Spawn failed");
    } finally {
      setSpawning(false);
    }
  }, [name, effectiveModel, role, goal, keyName]);

  const inputStyle = {
    background: "rgba(17,17,24,0.6)",
    border: "1px solid var(--color-border)",
    color: "#ddd",
    fontFamily: "'VT323', monospace",
    fontSize: "clamp(14px, 0.95vw, 18px)",
    padding: "4px 8px",
    outline: "none",
    width: "100%",
  } as const;

  const labelStyle = {
    fontFamily: "'Press Start 2P', monospace",
    fontSize: "clamp(6px, 0.45vw, 7px)",
    color: "#888",
    marginBottom: "2px",
    letterSpacing: "0.5px",
  } as const;

  return (
    <div
      style={{
        overflow: "auto",
        flex: 1,
        padding: "8px 10px",
        display: "flex",
        flexDirection: "column",
        gap: "6px",
      }}
    >
      <div>
        <div style={labelStyle}>NAME</div>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="agent name"
          style={inputStyle}
        />
      </div>
      <div>
        <div style={labelStyle}>MODEL</div>
        <select value={model} onChange={(e) => setModel(e.target.value)} style={inputStyle}>
          {MODEL_GROUPS.map((g) => (
            <optgroup key={g.provider} label={g.provider}>
              {g.models.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </optgroup>
          ))}
          <option value="__custom">Custom...</option>
        </select>
        {model === "__custom" && (
          <input
            type="text"
            placeholder="provider/model-name"
            value={customModel}
            onChange={(e) => setCustomModel(e.target.value)}
            style={{ ...inputStyle, marginTop: "3px" }}
          />
        )}
      </div>
      <div>
        <div style={labelStyle}>API KEY</div>
        <select value={keyName} onChange={(e) => setKeyName(e.target.value)} style={inputStyle}>
          <option value="">Default (env)</option>
          {(keys ?? []).map((k) => (
            <option key={k.name} value={k.name}>
              {k.name} ({k.provider}) {k.masked}
            </option>
          ))}
        </select>
      </div>
      <div>
        <div style={labelStyle}>ROLE</div>
        <select value={role} onChange={(e) => setRole(e.target.value)} style={inputStyle}>
          <option value="">None</option>
          {(roles ?? []).map((r: RoleEntry) => (
            <option key={r.name} value={r.name}>
              {r.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <div style={labelStyle}>GOAL</div>
        <input
          type="text"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleLaunch()}
          placeholder="optional goal"
          style={inputStyle}
        />
      </div>
      {error && (
        <div style={{ color: "#ef4444", fontSize: "clamp(10px, 0.7vw, 14px)", padding: "2px 0" }}>
          {error}
        </div>
      )}
      <button
        type="button"
        style={{
          fontFamily: "'Press Start 2P', monospace",
          fontSize: "clamp(6px, 0.48vw, 8px)",
          padding: "6px 10px",
          background: name.trim() && effectiveModel.trim() ? "rgba(255,221,0,0.1)" : "none",
          border: `1px solid ${name.trim() && effectiveModel.trim() ? "var(--color-primary)" : "var(--color-border)"}`,
          color: name.trim() && effectiveModel.trim() ? "var(--color-primary)" : "#555",
          cursor: name.trim() && effectiveModel.trim() ? "pointer" : "default",
          marginTop: "4px",
        }}
        disabled={spawning || !name.trim() || !effectiveModel.trim()}
        onClick={handleLaunch}
      >
        {spawning ? "SPAWNING..." : "LAUNCH AGENT"}
      </button>
    </div>
  );
});

// ── Roles Tab ───────────────────────────────────────────────────────────────

const RolesTab = memo(function RolesTab() {
  const { data: roles } = useRoles();
  const [selectedRole, setSelectedRole] = useState<string | null>(null);

  const role = useMemo(
    () => (roles ?? []).find((r: RoleEntry) => r.name === selectedRole),
    [roles, selectedRole],
  );

  if (selectedRole && role) {
    return (
      <div style={{ overflow: "auto", flex: 1 }}>
        <button
          type="button"
          style={{
            fontSize: "clamp(13px, 0.83vw, 16px)",
            color: "#bbb",
            cursor: "pointer",
            padding: "6px 10px",
            borderBottom: "1px solid var(--color-border)",
            width: "100%",
            textAlign: "left",
            background: "none",
            border: "none",
            fontFamily: "'VT323', monospace",
          }}
          onClick={() => setSelectedRole(null)}
        >
          &larr; Back
        </button>
        <div style={{ padding: "8px 10px" }}>
          <div
            style={{
              color: "var(--color-primary)",
              fontFamily: "Orbitron",
              fontSize: "clamp(14px, 0.95vw, 18px)",
              fontWeight: 700,
              marginBottom: "6px",
            }}
          >
            {role.name}
          </div>
          {role.guidelines && (
            <div
              style={{
                color: "#bbb",
                fontSize: "clamp(13px, 0.9vw, 17px)",
                fontFamily: "'VT323', monospace",
                marginBottom: "6px",
                lineHeight: 1.4,
              }}
            >
              {role.guidelines}
            </div>
          )}
          {role.focus && (
            <div style={{ color: "#888", fontSize: "clamp(12px, 0.8vw, 15px)" }}>
              Focus: {role.focus}
            </div>
          )}
          {role.tone && (
            <div style={{ color: "#888", fontSize: "clamp(12px, 0.8vw, 15px)" }}>
              Tone: {role.tone}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ overflow: "auto", flex: 1 }}>
      {(roles ?? []).map((r: RoleEntry) => (
        <button
          key={r.name}
          type="button"
          style={{
            display: "block",
            width: "100%",
            textAlign: "left",
            padding: "5px 10px",
            background: "none",
            border: "none",
            borderBottom: "1px solid rgba(255,255,255,0.04)",
            cursor: "pointer",
            fontFamily: "'VT323', monospace",
            fontSize: "clamp(15px, 1vw, 20px)",
            color: "#ddd",
          }}
          onClick={() => setSelectedRole(r.name)}
        >
          {r.name}
        </button>
      ))}
    </div>
  );
});

// ── Main Panel ──────────────────────────────────────────────────────────────

export const EntityPanel = memo(function EntityPanel({
  visible,
  onClose,
  onEntityClick,
  sendCommand,
  onExpandChange,
}: EntityPanelProps) {
  const [tab, setTab] = useState<EntityTab>("online");
  const [expanded, setExpanded] = useState(false);
  const entities = useWorldState((s) => s.entities);

  const agentCount = useMemo(() => entities.filter((e) => e.kind === "agent").length, [entities]);
  const humanCount = useMemo(() => entities.filter((e) => e.kind === "human").length, [entities]);
  const npcCount = useMemo(() => entities.filter((e) => e.kind === "npc").length, [entities]);

  if (!visible) return null;

  return (
    // biome-ignore lint/a11y/useSemanticElements: contains nested interactive controls (tab/stop buttons) — cannot use <button>
    <div
      className={`uc-entity-sidebar${expanded ? " expanded" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => {
        if (expanded) return;
        setExpanded(true);
        onExpandChange?.(true);
      }}
      onKeyDown={(e) => {
        if (expanded || e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setExpanded(true);
          onExpandChange?.(true);
        }
      }}
    >
      {/* Header — click to toggle expand/collapse */}
      {/* biome-ignore lint/a11y/useSemanticElements: contains nested interactive controls — cannot use <button> */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: expanded ? "4px 10px" : "4px 8px",
          borderBottom: "1px solid var(--color-border)",
          flexShrink: 0,
          cursor: "pointer",
        }}
        role="button"
        tabIndex={0}
        onClick={(e) => {
          if (!expanded) return;
          e.stopPropagation();
          setExpanded(false);
          onExpandChange?.(false);
        }}
        onKeyDown={(e) => {
          if (!expanded || e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            setExpanded(false);
            onExpandChange?.(false);
          }
        }}
      >
        <span
          style={{
            fontFamily: "'Press Start 2P', monospace",
            fontSize: "clamp(6px, 0.48vw, 8px)",
            color: "var(--color-primary)",
            letterSpacing: "1px",
          }}
        >
          ENTITIES
        </span>
        <span
          style={{
            marginLeft: "6px",
            color: "#999",
            fontFamily: "'VT323', monospace",
            fontSize: "clamp(14px, 0.95vw, 18px)",
          }}
        >
          {entities.length}
        </span>
        <span style={{ flex: 1 }} />
        {expanded && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(false);
              onExpandChange?.(false);
            }}
            style={{
              background: "none",
              border: "none",
              color: "#888",
              cursor: "pointer",
              fontFamily: "'VT323', monospace",
              fontSize: "14px",
              padding: "0 4px",
            }}
          >
            _
          </button>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          style={{
            background: "none",
            border: "none",
            color: "#666",
            cursor: "pointer",
            fontFamily: "'VT323', monospace",
            fontSize: "14px",
            padding: "0 4px",
          }}
        >
          x
        </button>
      </div>

      {/* Compact summary — shown when collapsed */}
      {!expanded && (
        <div
          style={{
            flex: 1,
            padding: "6px 8px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            gap: "4px",
          }}
        >
          {/* Kind breakdown as colored count blocks */}
          <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
            {agentCount > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                <span
                  style={{
                    width: "8px",
                    height: "8px",
                    borderRadius: "2px",
                    background: "#FFDD00",
                  }}
                />
                <span
                  style={{
                    color: "#FFDD00",
                    fontFamily: "Orbitron",
                    fontSize: "16px",
                    fontWeight: 700,
                  }}
                >
                  {agentCount}
                </span>
                <span style={{ color: "#888", fontSize: "11px" }}>agent</span>
              </div>
            )}
            {humanCount > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                <span
                  style={{
                    width: "8px",
                    height: "8px",
                    borderRadius: "2px",
                    background: "#f0f0f0",
                  }}
                />
                <span
                  style={{
                    color: "#f0f0f0",
                    fontFamily: "Orbitron",
                    fontSize: "16px",
                    fontWeight: 700,
                  }}
                >
                  {humanCount}
                </span>
                <span style={{ color: "#888", fontSize: "11px" }}>human</span>
              </div>
            )}
            {npcCount > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                <span
                  style={{
                    width: "8px",
                    height: "8px",
                    borderRadius: "2px",
                    background: "#22c55e",
                  }}
                />
                <span
                  style={{
                    color: "#22c55e",
                    fontFamily: "Orbitron",
                    fontSize: "16px",
                    fontWeight: 700,
                  }}
                >
                  {npcCount}
                </span>
                <span style={{ color: "#888", fontSize: "11px" }}>npc</span>
              </div>
            )}
            {entities.length === 0 && (
              <span style={{ color: "#666", fontSize: "13px" }}>none online</span>
            )}
          </div>
        </div>
      )}

      {/* Tabs — only when expanded */}
      <div
        className="uc-es-tabs"
        style={{ display: "flex", borderBottom: "1px solid var(--color-border)", flexShrink: 0 }}
      >
        <TabButton label="Online" active={tab === "online"} onClick={() => setTab("online")} />
        <TabButton label="Agents" active={tab === "agents"} onClick={() => setTab("agents")} />
        <TabButton label="Launch" active={tab === "launch"} onClick={() => setTab("launch")} />
        <TabButton label="Roles" active={tab === "roles"} onClick={() => setTab("roles")} />
      </div>

      {/* Tab content — only when expanded */}
      <div
        className="uc-es-body"
        style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        {tab === "online" && <OnlineTab onEntityClick={onEntityClick} />}
        {tab === "agents" && <AgentsTab onEntityClick={onEntityClick} />}
        {tab === "launch" && <LaunchTab sendCommand={sendCommand} />}
        {tab === "roles" && <RolesTab />}
      </div>
    </div>
  );
});
