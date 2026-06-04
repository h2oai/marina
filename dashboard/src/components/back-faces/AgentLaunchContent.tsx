import { Bot, Play, Send, Square } from "lucide-react";
import { useMemo, useState } from "react";
import { useAgents, useKeys, useModels, useRoles } from "../../hooks/use-api";
import { postApi } from "../../lib/api";
import {
  DEFAULT_FALLBACK_MODEL,
  mergeGroups,
  providerLabel,
  totalModelCount,
} from "../../lib/model-catalog";
import type { AgentStatusFull } from "../../lib/types";
import { cn } from "../../lib/utils";

/** Agent launch + running agents — used as back-face content inside EntityRoster. */
export function AgentLaunchContent() {
  const { data: agents } = useAgents();
  const running = agents?.filter((a) => a.state !== "stopped" && a.state !== "error") ?? [];

  return (
    <div className="flex flex-col gap-2 overflow-auto p-2">
      <SpawnForm />
      {running.length > 0 && (
        <div className="space-y-1">
          <div className="text-primary text-[10px] uppercase tracking-wider">
            Running ({running.length})
          </div>
          {running.map((a) => (
            <RunningAgent key={a.name} agent={a} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Spawn Form ────────────────────────────────────────────────────────────

function SpawnForm() {
  const [name, setName] = useState("");
  const [model, setModel] = useState(DEFAULT_FALLBACK_MODEL);
  const [customModel, setCustomModel] = useState("");
  const [role, setRole] = useState("");
  const [keyName, setKeyName] = useState("");
  const [goal, setGoal] = useState("");
  const [spawning, setSpawning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: roles } = useRoles();
  const { data: keys } = useKeys();
  const { data: modelsData, isLoading: modelsLoading } = useModels();

  const groups = useMemo(() => mergeGroups(modelsData?.groups), [modelsData]);
  const modelCount = totalModelCount(groups);
  const isLive = !!modelsData && modelsData.groups.some((g) => g.keySource !== null);

  const effectiveModel = model === "__custom" ? customModel : model;

  const handleSpawn = async () => {
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
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1 text-primary text-[10px] uppercase tracking-wider">
        <Bot size={10} /> Launch Agent
      </div>

      {/* Name */}
      <input
        type="text"
        placeholder="Agent name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full bg-bg-surface border border-border rounded px-1.5 py-0.5 text-[11px] text-text-bright outline-none focus:border-primary"
      />

      {/* Model */}
      <label className="block space-y-1">
        <span className="flex items-center justify-between text-text-dim text-[9px] uppercase tracking-wider">
          <span>Model</span>
          <span className="text-text-dim normal-case tracking-normal">
            {modelsLoading
              ? "discovering…"
              : isLive
                ? `${modelCount} live`
                : `${modelCount} (fallback — add an API key)`}
          </span>
        </span>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="w-full bg-bg-surface border border-border rounded px-1.5 py-0.5 text-[11px] text-text-bright outline-none focus:border-primary"
        >
          {groups.map((g) =>
            g.models.length === 0 ? null : (
              <optgroup key={g.provider} label={providerLabel(g.provider)}>
                {g.models.map((m) => (
                  <option key={m.value} value={m.value} title={m.description}>
                    {m.label}
                  </option>
                ))}
              </optgroup>
            ),
          )}
          <option value="__custom">Custom...</option>
        </select>
      </label>
      {model === "__custom" && (
        <input
          type="text"
          placeholder="provider/model-name"
          value={customModel}
          onChange={(e) => setCustomModel(e.target.value)}
          className="w-full bg-bg-surface border border-border rounded px-1.5 py-0.5 text-[11px] text-text-bright outline-none focus:border-primary"
        />
      )}

      {/* Role */}
      <label className="block space-y-1">
        <span className="text-text-dim text-[9px] uppercase tracking-wider">Role</span>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="w-full bg-bg-surface border border-border rounded px-1.5 py-0.5 text-[11px] text-text-bright outline-none focus:border-primary"
        >
          <option value="">None</option>
          {roles?.map((r) => (
            <option key={r.name} value={r.name}>
              {r.name}
              {r.description ? ` — ${r.description}` : ""}
            </option>
          ))}
        </select>
      </label>

      {/* API Key */}
      <label className="block space-y-1">
        <span className="text-text-dim text-[9px] uppercase tracking-wider">API Key</span>
        <select
          value={keyName}
          onChange={(e) => setKeyName(e.target.value)}
          className="w-full bg-bg-surface border border-border rounded px-1.5 py-0.5 text-[11px] text-text-bright outline-none focus:border-primary"
        >
          <option value="">Default (env)</option>
          {keys?.map((k) => (
            <option key={k.name} value={k.name}>
              {k.name} ({k.provider}) {k.masked}
            </option>
          ))}
        </select>
        {(!keys || keys.length === 0) && (
          <div className="text-text-dim text-[9px]">
            Using env vars. Add keys in the <span className="text-primary">Admin</span> panel &gt;{" "}
            <span className="text-primary">Keys</span> tab.
          </div>
        )}
      </label>

      {/* Goal */}
      <input
        type="text"
        placeholder="Goal (optional)"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleSpawn()}
        className="w-full bg-bg-surface border border-border rounded px-1.5 py-0.5 text-[11px] text-text-bright outline-none focus:border-primary"
      />

      {error && <div className="text-red-400 text-[10px]">{error}</div>}

      <button
        type="button"
        onClick={handleSpawn}
        disabled={spawning || !name.trim() || !effectiveModel.trim()}
        className="w-full flex items-center justify-center gap-1 bg-primary/20 hover:bg-primary/30 text-primary text-[11px] font-medium rounded px-2 py-1 transition-colors disabled:opacity-50"
      >
        <Play size={10} />
        {spawning ? "Spawning..." : "Launch Agent"}
      </button>
    </div>
  );
}

// ─── Running Agent Row ─────────────────────────────────────────────────────

function RunningAgent({ agent }: { agent: AgentStatusFull }) {
  const [attention, setAttention] = useState("");
  const [sending, setSending] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const modelShort = agent.model.split("/")[1] ?? agent.model;
  const upMin = Math.round(agent.uptime / 60000);

  const stateColor: Record<string, string> = {
    starting: "text-warning",
    connected: "text-secondary",
    autonomous: "text-green-400",
    idle: "text-text-dim",
    stopping: "text-warning",
    error: "text-red-400",
  };

  const handleAttention = async () => {
    if (!attention.trim()) return;
    setSending(true);
    try {
      await postApi(`/api/agents/${encodeURIComponent(agent.name)}/attention`, {
        message: attention.trim(),
      });
      setAttention("");
    } catch {
      // silent
    } finally {
      setSending(false);
    }
  };

  const handleStop = async () => {
    await postApi(`/api/agents/${encodeURIComponent(agent.name)}/stop`);
  };

  return (
    <div className="bg-bg-surface/50 border border-border rounded p-1.5 space-y-1">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 text-[10px] text-left"
      >
        <span className={cn("font-medium", stateColor[agent.state] ?? "text-text")}>
          {agent.name}
        </span>
        <span className="text-text-dim">{modelShort}</span>
        {agent.role && <span className="text-accent">{agent.role}</span>}
        <span className="flex-1" />
        <span className={cn("text-[9px]", stateColor[agent.state] ?? "text-text-dim")}>
          {agent.state}
        </span>
        <span className="text-text-dim text-[9px]">{upMin}m</span>
        <button
          type="button"
          onClick={(ev) => {
            ev.stopPropagation();
            handleStop();
          }}
          className="text-text-dim hover:text-red-400 transition-colors"
          title="Stop"
        >
          <Square size={9} />
        </button>
      </button>

      {expanded && (
        <div className="animate-fade-in space-y-1 text-[10px]">
          <div className="flex gap-3 text-text-dim">
            <span>{agent.toolCalls} calls</span>
            {agent.errors > 0 && <span className="text-red-400">{agent.errors} errors</span>}
            {agent.goal && (
              <span className="truncate">
                <span className="text-primary">Goal:</span> {agent.goal}
              </span>
            )}
          </div>
          {agent.focus && (
            <div className="text-text-dim truncate">
              <span className="text-primary">Focus:</span> {agent.focus}
            </div>
          )}
          <div className="flex gap-1">
            <input
              type="text"
              placeholder="Send attention..."
              value={attention}
              onChange={(e) => setAttention(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAttention()}
              className="flex-1 bg-bg-surface border border-border rounded px-1.5 py-0.5 text-[10px] text-text-bright outline-none focus:border-primary"
            />
            <button
              type="button"
              onClick={handleAttention}
              disabled={sending || !attention.trim()}
              className="text-primary hover:text-accent transition-colors disabled:opacity-50"
            >
              <Send size={10} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
