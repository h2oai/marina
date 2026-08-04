import { Bell, Key, Plug, Radio, Settings, Shield, Tags, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import {
  useAdapters,
  useAgents,
  useEnvConfig,
  useKeys,
  useMcpInfo,
  useRoles,
  useTraits,
} from "../hooks/use-api";
import { deleteApi, describeApiError, fetchApi, patchApi, postApi, putApi } from "../lib/api";
import { GlassPanel, type PanelFocusProps } from "./GlassPanel";
import { ModelSelect } from "./ModelSelect";

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

const SUPPORTED_ADAPTERS = ["telegram", "discord"];

type Tab = "keys" | "endpoint" | "adapters" | "roles" | "mcp" | "config" | "security" | "ops";

export function AdminPanel({
  backContent,
  isFocused,
  onToggleFocus,
}: { backContent?: React.ReactNode } & PanelFocusProps) {
  const [tab, setTab] = useState<Tab>("keys");

  return (
    <GlassPanel
      title="Admin"
      icon={<Shield size={14} />}
      backContent={backContent}
      isFocused={isFocused}
      onToggleFocus={onToggleFocus}
    >
      <div className="flex border-b border-border text-[10px]">
        {(
          ["keys", "endpoint", "adapters", "roles", "mcp", "config", "security", "ops"] as Tab[]
        ).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`flex-1 px-2 py-1 capitalize transition-colors ${
              tab === t ? "text-primary border-b border-primary" : "text-text-dim hover:text-text"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto p-2">
        {tab === "keys" && <KeysTab />}
        {tab === "endpoint" && <EndpointTab />}
        {tab === "adapters" && <AdaptersTab />}
        {tab === "roles" && <RolesTab />}
        {tab === "mcp" && <McpTab />}
        {tab === "config" && <ConfigTab />}
        {tab === "security" && <SecurityTab />}
        {tab === "ops" && <OperationsTab />}
      </div>
    </GlassPanel>
  );
}

interface OperationalAlert {
  id: number;
  severity: "critical" | "warning" | "info";
  category: string;
  title: string;
  detail: string;
  remedy: string;
  status: "open" | "acknowledged" | "resolved";
  occurrences: number;
}
interface ProductivitySummary {
  outcomes: number;
  successes: number;
  successRate: number;
  medianDurationMs: number;
  averageToolCalls: number;
  averageHandoffs: number;
  outcomesLast7d: number;
}

function OperationsTab() {
  const [alerts, setAlerts] = useState<OperationalAlert[]>([]);
  const [productivity, setProductivity] = useState<ProductivitySummary | null>(null);
  const [conflicts, setConflicts] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const refresh = () =>
    Promise.all([
      fetchApi<OperationalAlert[]>("/api/operations/alerts"),
      fetchApi<{ summary: ProductivitySummary }>("/api/productivity"),
      fetchApi<unknown[]>("/api/memory/contradictions"),
    ])
      .then(([nextAlerts, nextProductivity, nextConflicts]) => {
        setAlerts(nextAlerts);
        setProductivity(nextProductivity.summary);
        setConflicts(nextConflicts.length);
      })
      .catch((e) => setError(describeApiError(e)));
  useEffect(refresh, []);
  const act = async (id: number, action: "ack" | "resolve") => {
    try {
      await postApi(`/api/operations/alerts/${id}/${action}`);
      await refresh();
    } catch (e) {
      setError(describeApiError(e));
    }
  };
  const active = alerts.filter((a) => a.status !== "resolved");
  return (
    <div className="space-y-2 text-[10px]">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1 text-primary uppercase tracking-wider">
          <Bell size={10} /> Operations Inbox
        </span>
        <button type="button" className="text-primary hover:underline" onClick={refresh}>
          Refresh
        </button>
      </div>
      {error && <div className="text-red-400">{error}</div>}
      {productivity && (
        <div className="grid grid-cols-3 gap-1 rounded border border-border bg-bg-surface/50 p-2">
          <div>
            <div className="text-text-dim">Success</div>
            <strong>{Math.round(productivity.successRate * 100)}%</strong>
          </div>
          <div>
            <div className="text-text-dim">Outcomes / 7d</div>
            <strong>{productivity.outcomesLast7d}</strong>
          </div>
          <div>
            <div className="text-text-dim">Open conflicts</div>
            <strong>{conflicts}</strong>
          </div>
          <div>
            <div className="text-text-dim">Median time</div>
            <strong>
              {productivity.medianDurationMs
                ? `${Math.round(productivity.medianDurationMs / 60000)}m`
                : "n/a"}
            </strong>
          </div>
          <div>
            <div className="text-text-dim">Tools / outcome</div>
            <strong>{productivity.averageToolCalls.toFixed(1)}</strong>
          </div>
          <div>
            <div className="text-text-dim">Handoffs / outcome</div>
            <strong>{productivity.averageHandoffs.toFixed(1)}</strong>
          </div>
        </div>
      )}
      {active.length === 0 && (
        <div className="rounded border border-emerald-400/30 bg-emerald-400/10 p-2 text-emerald-400">
          No actionable alerts.
        </div>
      )}
      {active.map((alert) => (
        <div
          key={alert.id}
          className={`rounded border p-2 ${alert.severity === "critical" ? "border-red-400/40" : "border-warning/40"}`}
        >
          <div className="flex justify-between gap-2">
            <strong>{alert.title}</strong>
            <span className="uppercase text-text-dim">{alert.severity}</span>
          </div>
          <div className="mt-1 text-text-dim">{alert.detail}</div>
          <div className="mt-1 font-mono text-primary">{alert.remedy}</div>
          <div className="mt-2 flex gap-2">
            {alert.status === "open" && (
              <button
                type="button"
                onClick={() => act(alert.id, "ack")}
                className="text-primary hover:underline"
              >
                Acknowledge
              </button>
            )}
            <button
              type="button"
              onClick={() => act(alert.id, "resolve")}
              className="text-primary hover:underline"
            >
              Resolve
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Default Model Selector ──────────────────────────────────────────────────

/**
 * Runtime-changeable default model — what marina/default routes to and what new
 * agents spawn with. Lists only keyed providers (incl. OpenRouter), plus a custom
 * entry, and persists via PUT /api/default-model. Takes effect immediately for
 * marina/default routing and for newly spawned agents.
 */
function DefaultModelSelector() {
  const [sel, setSel] = useState<string>("");
  const [custom, setCustom] = useState("");
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchApi<{ model: string; configured: string | null }>("/api/default-model")
      .then((d) => setSel(d.configured ?? d.model))
      .catch(() => {});
  }, []);

  const save = async (model: string) => {
    if (!model.trim()) return;
    setSaving(true);
    setErr(null);
    try {
      const d = await putApi<{ model: string; configured: string }>("/api/default-model", {
        model: model.trim(),
      });
      setSel(d.configured);
      setCustom("");
      setFlash(true);
      setTimeout(() => setFlash(false), 2000);
    } catch (e) {
      setErr(describeApiError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-1 rounded border border-border bg-bg-surface/50 p-1.5">
      {/* Same picker the agent-launch panel uses, for a consistent look & feel.
          Selecting a listed model saves immediately; a custom entry commits on Set. */}
      <ModelSelect
        label="Default model"
        model={sel}
        onModelChange={(v) => {
          setSel(v);
          if (v !== "__custom") save(v);
        }}
        customModel={custom}
        onCustomModelChange={setCustom}
      />
      <div className="text-text-dim text-[9px]">
        Used by marina/default and newly spawned agents.
      </div>
      {sel === "__custom" && (
        <button
          type="button"
          onClick={() => save(custom)}
          disabled={saving || !custom.trim()}
          className="w-full bg-primary/20 hover:bg-primary/30 text-primary text-[10px] rounded px-2 py-0.5 disabled:opacity-50"
        >
          Set default
        </button>
      )}
      {flash && <div className="text-success text-[9px]">✓ Default updated</div>}
      {err && <div className="text-danger text-[9px]">{err}</div>}
    </div>
  );
}

// ─── Model Endpoint Tab ──────────────────────────────────────────────────────

interface EndpointCfg {
  mode: "passthru" | "agents" | "open" | "panel";
  fallback: boolean;
  strategy: "round-robin" | "least-busy";
  passthruModel: string;
  panelSize: number;
  panelSynthesis: "concat" | "synthesize";
}

const ENDPOINT_MODES: { id: EndpointCfg["mode"]; label: string; desc: string }[] = [
  {
    id: "passthru",
    label: "Passthru",
    desc: "Proxy directly to an upstream model. A thin OpenAI gateway — no agents.",
  },
  {
    id: "agents",
    label: "Agents (coordinator)",
    desc: "Route to one agent on the model channel and return its answer.",
  },
  {
    id: "open",
    label: "Open channel",
    desc: "Broadcast to the channel; the first agent to answer wins.",
  },
  {
    id: "panel",
    label: "Panel (aggregate)",
    desc: "Fan out to several agents, then merge their answers into one.",
  },
];

/**
 * Configures how Marina answers as an LLM at /v1/chat/completions. One source of
 * truth (app_settings), applied per request. See src/net/model-endpoint.ts.
 */
function EndpointTab() {
  const [cfg, setCfg] = useState<EndpointCfg | null>(null);
  const [custom, setCustom] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    fetchApi<EndpointCfg>("/api/model-endpoint")
      .then((c) => {
        setCfg(c);
        setCustom(c.passthruModel);
      })
      .catch((e) => setErr(describeApiError(e)));
  }, []);

  const patch = async (p: Partial<EndpointCfg>) => {
    setErr(null);
    try {
      const next = await putApi<EndpointCfg>("/api/model-endpoint", p);
      setCfg(next);
      setFlash(true);
      setTimeout(() => setFlash(false), 1500);
    } catch (e) {
      setErr(describeApiError(e));
    }
  };

  if (!cfg) return <div className="text-text-dim text-[10px]">Loading…</div>;

  const showPassthruModel = cfg.mode === "passthru" || cfg.fallback;
  const modelSel = cfg.passthruModel === "" ? "__default" : cfg.passthruModel;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1 text-primary text-[10px] uppercase tracking-wider">
        <Radio size={10} /> Model Endpoint
      </div>
      <div className="text-text-dim text-[9px]">
        How Marina answers when consumed as an LLM (/v1/chat/completions).
      </div>

      <div className="space-y-1">
        {ENDPOINT_MODES.map((m) => (
          <label key={m.id} className="flex cursor-pointer items-start gap-2 text-[10px]">
            <input
              type="radio"
              name="endpoint-mode"
              checked={cfg.mode === m.id}
              onChange={() => patch({ mode: m.id })}
              className="mt-0.5 shrink-0 accent-primary"
            />
            <span>
              <span className="text-text-bright">{m.label}</span>
              <span className="block text-text-dim text-[9px]">{m.desc}</span>
            </span>
          </label>
        ))}
      </div>

      {cfg.mode === "agents" && (
        <label className="block space-y-1">
          <span className="text-text-dim text-[9px] uppercase tracking-wider">Selection</span>
          <select
            value={cfg.strategy}
            onChange={(e) => patch({ strategy: e.target.value as EndpointCfg["strategy"] })}
            className="w-full bg-bg-surface border border-border rounded px-1.5 py-0.5 text-[10px] text-text-bright outline-none"
          >
            <option value="round-robin">round-robin</option>
            <option value="least-busy">least-busy</option>
          </select>
        </label>
      )}

      {cfg.mode === "panel" && (
        <div className="flex gap-2">
          <label className="flex-1 space-y-1">
            <span className="text-text-dim text-[9px] uppercase tracking-wider">Panel size</span>
            <input
              type="number"
              min={1}
              max={8}
              value={cfg.panelSize}
              onChange={(e) => patch({ panelSize: Math.max(1, Number(e.target.value) || 1) })}
              className="w-full bg-bg-surface border border-border rounded px-1.5 py-0.5 text-[10px] text-text-bright outline-none"
            />
          </label>
          <label className="flex-1 space-y-1">
            <span className="text-text-dim text-[9px] uppercase tracking-wider">Merge</span>
            <select
              value={cfg.panelSynthesis}
              onChange={(e) =>
                patch({ panelSynthesis: e.target.value as EndpointCfg["panelSynthesis"] })
              }
              className="w-full bg-bg-surface border border-border rounded px-1.5 py-0.5 text-[10px] text-text-bright outline-none"
            >
              <option value="concat">concat</option>
              <option value="synthesize">synthesize</option>
            </select>
          </label>
        </div>
      )}

      {cfg.mode !== "passthru" && (
        <label className="flex items-center justify-between gap-2 text-[10px] text-text">
          <span>Fall back to passthru when no agent answers</span>
          <input
            type="checkbox"
            checked={cfg.fallback}
            onChange={(e) => patch({ fallback: e.target.checked })}
            className="h-3.5 w-3.5 shrink-0 accent-primary"
          />
        </label>
      )}

      {showPassthruModel && (
        <div className="space-y-1 border-t border-border pt-1.5">
          <ModelSelect
            label={cfg.mode === "passthru" ? "Passthru model" : "Fallback model"}
            model={modelSel}
            placeholderOption={{ value: "__default", label: "Default Model" }}
            onModelChange={(v) => {
              if (v === "__default") patch({ passthruModel: "" });
              else if (v !== "__custom") patch({ passthruModel: v });
            }}
            customModel={custom}
            onCustomModelChange={setCustom}
          />
          <div className="flex items-center justify-between">
            <span className="text-text-dim text-[9px]">
              {cfg.passthruModel === "" ? "Using the Default Model." : cfg.passthruModel}
            </span>
            {cfg.passthruModel !== "" && (
              <button
                type="button"
                onClick={() => patch({ passthruModel: "" })}
                className="text-[9px] text-text-dim hover:text-primary"
              >
                use Default Model
              </button>
            )}
          </div>
          {modelSel === "__custom" && (
            <button
              type="button"
              onClick={() => patch({ passthruModel: custom.trim() })}
              disabled={!custom.trim()}
              className="w-full bg-primary/20 hover:bg-primary/30 text-primary text-[10px] rounded px-2 py-0.5 disabled:opacity-50"
            >
              Set model
            </button>
          )}
        </div>
      )}

      {flash && <div className="text-success text-[9px]">✓ Saved</div>}
      {err && <div className="text-danger text-[9px]">{err}</div>}
    </div>
  );
}

// ─── Keys Tab ───────────────────────────────────────────────────────────────

function KeysTab() {
  const { data: keys, isError, error, refetch } = useKeys();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("");
  const [value, setValue] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  const handleAdd = async () => {
    // Be explicit about why a save won't proceed — the old silent return on a
    // missing field looked like "nothing happens".
    if (!name.trim()) return setFormError("Enter a key name.");
    if (!provider) return setFormError("Select a provider.");
    if (!value.trim()) return setFormError("Enter the API key value.");
    setSaving(true);
    setFormError(null);
    try {
      await postApi("/api/keys", { name: name.trim(), provider, value: value.trim() });
      setName("");
      setProvider("");
      setValue("");
      setAdding(false);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2500);
      await refetch();
    } catch (e) {
      setFormError(describeApiError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <DefaultModelSelector />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 text-primary text-[10px] uppercase tracking-wider">
          <Key size={10} /> API Keys
        </div>
        <button
          type="button"
          onClick={() => setAdding(!adding)}
          className="text-[9px] text-text-dim hover:text-primary transition-colors"
        >
          {adding ? "Cancel" : "+ Add"}
        </button>
      </div>

      {adding && (
        <div className="space-y-1 bg-bg-surface/50 rounded p-1.5 border border-border">
          <input
            placeholder="Key name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-bg-surface border border-border rounded px-1.5 py-0.5 text-[10px] text-text-bright outline-none"
          />
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="w-full bg-bg-surface border border-border rounded px-1.5 py-0.5 text-[10px] text-text-bright outline-none"
          >
            <option value="">Select provider...</option>
            {SUPPORTED_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <input
            type="password"
            placeholder="API key value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-full bg-bg-surface border border-border rounded px-1.5 py-0.5 text-[10px] text-text outline-none"
          />
          <button
            type="button"
            onClick={handleAdd}
            disabled={saving}
            className="w-full bg-primary/20 hover:bg-primary/30 text-primary text-[10px] rounded px-2 py-0.5 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save Key"}
          </button>
          {formError && <div className="text-danger text-[10px]">{formError}</div>}
        </div>
      )}

      {!adding && formError && <div className="text-danger text-[10px]">{formError}</div>}
      {savedFlash && <div className="text-success text-[10px]">✓ Key saved</div>}

      {isError ? (
        <div className="text-danger text-[10px]">{describeApiError(error)}</div>
      ) : !keys || keys.length === 0 ? (
        <div className="text-text-dim text-[10px]">
          No database keys. Set env vars (ANTHROPIC_API_KEY, GEMINI_API_KEY, etc.) or add keys
          above.
        </div>
      ) : (
        keys.map((k) => (
          <div key={k.name} className="flex items-center gap-2 text-[10px]">
            <span className="text-text-bright">{k.name}</span>
            <span className="text-text-dim">{k.provider}</span>
            <span className="text-text-dim font-mono text-[9px]">{k.masked}</span>
          </div>
        ))
      )}
    </div>
  );
}

// ─── Adapters Tab ───────────────────────────────────────────────────────────

function AdaptersTab() {
  const { data: adapters, refetch } = useAdapters();
  const [adding, setAdding] = useState(false);
  const [platform, setPlatform] = useState("");

  const handleAdd = async () => {
    if (!platform) return;
    await postApi("/api/adapters", { platform });
    setPlatform("");
    setAdding(false);
    refetch();
  };

  const handleToggle = async (plat: string, currentStatus: string) => {
    const newStatus = currentStatus === "active" ? "disabled" : "active";
    await patchApi(`/api/adapters/${encodeURIComponent(plat)}`, { status: newStatus });
    refetch();
  };

  const handleDelete = async (plat: string) => {
    await deleteApi(`/api/adapters/${encodeURIComponent(plat)}`);
    refetch();
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 text-primary text-[10px] uppercase tracking-wider">
          <Plug size={10} /> Platform Adapters
        </div>
        <button
          type="button"
          onClick={() => setAdding(!adding)}
          className="text-[9px] text-text-dim hover:text-primary transition-colors"
        >
          {adding ? "Cancel" : "+ Add"}
        </button>
      </div>

      {adding && (
        <div className="space-y-1 bg-bg-surface/50 rounded p-1.5 border border-border">
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            className="w-full bg-bg-surface border border-border rounded px-1.5 py-0.5 text-[10px] text-text-bright outline-none"
          >
            <option value="">Select platform...</option>
            {SUPPORTED_ADAPTERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleAdd}
            className="w-full bg-primary/20 hover:bg-primary/30 text-primary text-[10px] rounded px-2 py-0.5"
          >
            Enable Adapter
          </button>
        </div>
      )}

      {!adapters || adapters.length === 0 ? (
        <div className="text-text-dim text-[10px]">
          No adapters configured. Add one above or set TELEGRAM_TOKEN / DISCORD_TOKEN env vars.
        </div>
      ) : (
        adapters.map((a) => (
          <div
            key={a.platform}
            className="flex items-center gap-2 text-[10px] bg-bg-surface/30 rounded px-1.5 py-1"
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${a.running ? "bg-green-400" : "bg-text-dim"}`}
            />
            <span className="text-text-bright font-medium">{a.platform}</span>
            <span className={a.running ? "text-green-400" : "text-text-dim"}>
              {a.running ? "running" : "stopped"}
            </span>
            <span className="text-text-dim text-[9px]">
              {a.source === "env" ? `(${a.envVar})` : `by ${a.set_by}`}
            </span>
            <span className="flex-1" />
            {a.source === "db" && (
              <>
                <button
                  type="button"
                  onClick={() => handleToggle(a.platform, a.running ? "active" : "disabled")}
                  className="text-[9px] text-text-dim hover:text-primary transition-colors"
                >
                  {a.running ? "Stop" : "Start"}
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(a.platform)}
                  className="text-[9px] text-text-dim hover:text-red-400 transition-colors"
                >
                  Remove
                </button>
              </>
            )}
            {a.source === "env" && (
              <button
                type="button"
                onClick={() => handleToggle(a.platform, a.running ? "active" : "disabled")}
                className="text-[9px] text-text-dim hover:text-primary transition-colors"
              >
                {a.running ? "Stop" : "Start"}
              </button>
            )}
          </div>
        ))
      )}
    </div>
  );
}

// ─── Roles Tab ──────────────────────────────────────────────────────────────

function RolesTab() {
  const { data: roles } = useRoles();
  const { data: traits } = useTraits();

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1 text-primary text-[10px] uppercase tracking-wider">
        <Tags size={10} /> Roles
      </div>
      {roles?.map((r) => {
        const traitNames: string[] = JSON.parse(r.traits || "[]");
        return (
          <div key={r.name} className="text-[10px]">
            <span className="text-text-bright font-medium">{r.name}</span>
            {traitNames.length > 0 && (
              <span className="text-text-dim ml-1">[{traitNames.join(", ")}]</span>
            )}
            {r.description && <div className="text-text-dim ml-2">{r.description}</div>}
          </div>
        );
      })}

      <div className="flex items-center gap-1 text-primary text-[10px] uppercase tracking-wider mt-3">
        Traits
      </div>
      {traits?.map((t) => (
        <div key={t.name} className="text-[10px]">
          <span className="text-text-bright">{t.name}</span>
          <span className="text-text-dim ml-1">({t.category})</span>
        </div>
      ))}
    </div>
  );
}

// ─── MCP Tab ────────────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  bootstrap: "Bootstrap",
  cognition: "Cognition",
  world: "World",
  coordination: "Coordination",
  canvas: "Canvas",
  building: "Building",
  escape: "Escape Hatch",
  session: "Session",
};

function McpTab() {
  const { data: mcp } = useMcpInfo();

  if (!mcp) {
    return <div className="text-text-dim text-[10px]">Loading MCP info...</div>;
  }

  const totalTools = Object.values(mcp.tools).reduce((n, arr) => n + arr.length, 0);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1 text-primary text-[10px] uppercase tracking-wider">
        <Wrench size={10} /> MCP Server
      </div>
      <div className="space-y-1 text-[10px]">
        <div className="flex gap-2">
          <span className="text-text-dim">Endpoint:</span>
          <span className="text-text-bright font-mono text-[9px]">{mcp.url}</span>
        </div>
        <div className="flex gap-2">
          <span className="text-text-dim">Port:</span>
          <span className="text-text">{mcp.port}</span>
        </div>
        <div className="flex gap-2">
          <span className="text-text-dim">Tools:</span>
          <span className="text-text">{totalTools} registered</span>
        </div>
      </div>

      <div className="text-primary text-[10px] uppercase tracking-wider mt-2">Tool Categories</div>
      {Object.entries(mcp.tools).map(([category, tools]) => (
        <div key={category} className="space-y-0.5">
          <div className="text-accent text-[10px] font-medium">
            {CATEGORY_LABELS[category] ?? category}{" "}
            <span className="text-text-dim font-normal">({tools.length})</span>
          </div>
          {tools.map((t) => (
            <div key={t.name} className="flex gap-2 text-[10px] ml-2">
              <span className="text-text-bright">{t.name}</span>
              <span className="text-text-dim">{t.description}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ─── Config Tab ────────────────────────────────────────────────────────────

interface SaveResult {
  reloaded: string[];
  restartRequired: string[];
}

function ConfigTab() {
  const { data: envVars, refetch } = useEnvConfig();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<SaveResult | null>(null);

  const handleChange = (key: string, value: string) => {
    setEdits((prev) => ({ ...prev, [key]: value }));
    setSaveResult(null);
  };

  const handleSave = async () => {
    if (Object.keys(edits).length === 0) return;
    setSaving(true);
    try {
      const result = await putApi<{ ok: boolean } & SaveResult>("/api/env", { vars: edits });
      setEdits({});
      setSaveResult({ reloaded: result.reloaded, restartRequired: result.restartRequired });
      refetch();
    } finally {
      setSaving(false);
    }
  };

  if (!envVars) {
    return <div className="text-text-dim text-[10px]">Loading configuration...</div>;
  }

  // Group by category
  const grouped = new Map<string, typeof envVars>();
  for (const v of envVars) {
    if (!grouped.has(v.category)) grouped.set(v.category, []);
    grouped.get(v.category)!.push(v);
  }

  const hasEdits = Object.keys(edits).length > 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 text-primary text-[10px] uppercase tracking-wider">
          <Settings size={10} /> Environment Config
        </div>
        <button
          type="button"
          onClick={handleSave}
          disabled={!hasEdits || saving}
          className={`text-[9px] rounded px-2 py-0.5 transition-colors ${
            hasEdits
              ? "bg-primary/20 hover:bg-primary/30 text-primary"
              : "text-text-dim cursor-default"
          }`}
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>

      {saveResult && (
        <div className="space-y-1">
          {saveResult.reloaded.length > 0 && (
            <div className="text-[9px] text-green-400 bg-green-400/10 rounded px-1.5 py-1">
              Applied live: {saveResult.reloaded.join(", ")}
            </div>
          )}
          {saveResult.restartRequired.length > 0 && (
            <div className="text-[9px] text-yellow-400 bg-yellow-400/10 rounded px-1.5 py-1">
              Restart required: {saveResult.restartRequired.join(", ")}
            </div>
          )}
        </div>
      )}

      {[...grouped.entries()].map(([category, vars]) => (
        <div key={category}>
          <div className="text-accent text-[10px] font-medium mt-1 mb-0.5">{category}</div>
          {vars.map((v) => {
            const displayValue = edits[v.key] ?? v.value;
            // Vars set via the live environment (shell/docker) can't be
            // overridden from here — show them read-only with their source.
            const readOnly = v.editable === false;
            return (
              <div key={v.key} className="mb-1">
                <div className="flex items-center gap-1">
                  <span className="text-text-bright text-[10px] font-mono">{v.key}</span>
                  {v.isSet && <span className="text-green-400 text-[8px]">set</span>}
                  {readOnly && (
                    <span
                      className="text-text-dim text-[8px] uppercase tracking-wider"
                      title="Set in the process environment (shell/docker). Edit it there — values written here are shadowed by the live env."
                    >
                      env · read-only
                    </span>
                  )}
                </div>
                {v.description && (
                  <div className="text-text-dim text-[9px] mb-0.5">{v.description}</div>
                )}
                <input
                  type={v.isSecret ? "password" : "text"}
                  value={displayValue}
                  placeholder="(not set)"
                  disabled={readOnly}
                  onChange={(e) => handleChange(v.key, e.target.value)}
                  title={
                    readOnly
                      ? "Set in the process environment — edit it there, not here."
                      : undefined
                  }
                  className={`w-full rounded border border-border bg-bg-surface px-1.5 py-0.5 font-mono text-[10px] text-text outline-none focus:border-primary/50 ${
                    readOnly ? "cursor-not-allowed opacity-50" : ""
                  }`}
                />
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ─── Security Tab ───────────────────────────────────────────────────────────

interface SecurityStatus {
  authRequired: boolean;
  openApi: boolean;
  keyEncryption: boolean;
  dbKeyCount: number;
  unreadableKeys?: number;
}

function SecurityTab() {
  const { data: agents } = useAgents();
  const [status, setStatus] = useState<SecurityStatus | null>(null);

  useEffect(() => {
    fetchApi<SecurityStatus>("/api/security-status")
      .then(setStatus)
      .catch(() => {});
  }, []);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1 text-primary text-[10px] uppercase tracking-wider">
        <Shield size={10} /> Security Status
      </div>
      <div className="space-y-1 text-[10px]">
        <div className="flex gap-2">
          <span className="text-text-dim">Dashboard auth:</span>
          {status?.authRequired ? (
            <span className="text-emerald-400">Enabled (better-auth)</span>
          ) : (
            <span className="text-warning">Off — sign-in not required</span>
          )}
        </div>
        {status?.openApi && (
          <div className="flex gap-2">
            <span className="text-text-dim">Open API:</span>
            <span className="text-red-400">
              MARINA_OPEN_API=true — API auth disabled (dev only)
            </span>
          </div>
        )}
        <div className="flex gap-2">
          <span className="text-text-dim">Key encryption:</span>
          {status?.keyEncryption ? (
            <span className="text-emerald-400">On (AES-256-GCM at rest)</span>
          ) : (
            <span className="text-warning">Off — DB keys stored in plaintext</span>
          )}
        </div>
        <div className="flex gap-2">
          <span className="text-text-dim">API keys:</span>
          <span className="text-text">{status?.dbKeyCount ?? 0} in database</span>
        </div>
        <div className="flex gap-2">
          <span className="text-text-dim">Active agents:</span>
          <span className="text-text">{agents?.length ?? 0} running</span>
        </div>
      </div>
      {status?.unreadableKeys ? (
        <div className="mt-2 rounded border border-red-400/40 bg-red-400/10 p-1.5 text-[10px] text-red-400">
          ⚠ {status.unreadableKeys} stored key(s) are encrypted but can't be decrypted —
          MARINA_KEY_SECRET is missing or changed. They read as missing until you restore the
          original secret or re-enter the keys.
        </div>
      ) : null}
      <div className="text-text-dim text-[9px] mt-2 space-y-1">
        {!status?.authRequired && (
          <div>
            Enable sign-in with <span className="text-primary">MARINA_AUTH=better-auth</span> — see{" "}
            <span className="text-primary">docs/authentication.md</span>.
          </div>
        )}
        {!status?.keyEncryption && status?.dbKeyCount ? (
          <div>
            Keys in the DB are unencrypted. Prefer provider{" "}
            <span className="text-primary">env vars</span> (never persisted) or encrypt the data
            volume.
          </div>
        ) : null}
      </div>
    </div>
  );
}
