/**
 * AdminPanel -- Floating draggable panel for admin operations.
 *
 * Visual port of #fp-admin from 06-tiled.html mockup:
 * - Four tabs: Keys | Adapters | MCP | Config (using .chtab style)
 * - Rolled by default
 * - Uses .ei-style item rows
 */

import { memo, useCallback, useState } from "react";
import { useAdapters, useEnvConfig, useKeys, useMcpInfo, useRoles } from "../../hooks/use-api";
import { deleteApi, patchApi, postApi, putApi } from "../../lib/api";
import type { AdapterStatus, EnvVar, KeyStatus, McpToolInfo, RoleEntry } from "../../lib/types";
import { FloatingPanel } from "./FloatingPanel";

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
] as const;

/** Shared inline style for form inputs matching the VT323 aesthetic. */
const inputStyle: React.CSSProperties = {
  background: "rgba(17,17,24,0.6)",
  border: "1px solid var(--color-border)",
  color: "#ddd",
  fontFamily: "'VT323', monospace",
  fontSize: "clamp(14px, 0.95vw, 18px)",
  padding: "3px 8px",
  outline: "none",
  width: "100%",
};

/** Props for the AdminPanel component. */
export interface AdminPanelProps {
  /** Whether the panel is visible. */
  visible: boolean;
  /** Called when the close button is clicked. */
  onClose: () => void;
}

/** Admin tab identifiers. */
type AdminTab = "keys" | "adapters" | "mcp" | "config" | "roles" | "security";

// ── Tab Button ──────────────────────────────────────────────────────────────

const TabButton = memo(function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={`uc-tab${active ? " active" : ""}`} onClick={onClick}>
      {label}
    </button>
  );
});

// ── Keys Tab ────────────────────────────────────────────────────────────────

const KeysTab = memo(function KeysTab() {
  const { data: keys, isLoading, refetch } = useKeys();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<string>(SUPPORTED_PROVIDERS[0]);
  const [value, setValue] = useState("");

  const handleSave = useCallback(async () => {
    if (!name.trim() || !value.trim()) return;
    await postApi("/api/keys", { name: name.trim(), provider, value: value.trim() });
    setName("");
    setProvider(SUPPORTED_PROVIDERS[0]);
    setValue("");
    setShowForm(false);
    refetch();
  }, [name, provider, value, refetch]);

  const handleCancel = useCallback(() => {
    setName("");
    setProvider(SUPPORTED_PROVIDERS[0]);
    setValue("");
    setShowForm(false);
  }, []);

  const handleDelete = useCallback(
    async (keyName: string) => {
      await deleteApi(`/api/keys/${encodeURIComponent(keyName)}`);
      refetch();
    },
    [refetch],
  );

  if (isLoading) {
    return (
      <div style={{ padding: "12px 14px", color: "#555", fontFamily: "'VT323', monospace" }}>
        Loading...
      </div>
    );
  }

  return (
    <div>
      {/* Add Key toggle form */}
      <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--color-border)" }}>
        {!showForm ? (
          <button
            type="button"
            onClick={() => setShowForm(true)}
            style={{
              background: "none",
              border: "1px solid var(--color-border)",
              color: "var(--color-success)",
              fontFamily: "'VT323', monospace",
              fontSize: "clamp(14px, 0.95vw, 18px)",
              cursor: "pointer",
              padding: "3px 10px",
            }}
          >
            + ADD KEY
          </button>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <input
              type="text"
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={inputStyle}
            />
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              style={inputStyle}
            >
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
              style={inputStyle}
            />
            <div style={{ display: "flex", gap: "6px" }}>
              <button
                type="button"
                onClick={handleSave}
                style={{
                  background: "none",
                  border: "1px solid var(--color-success)",
                  color: "var(--color-success)",
                  fontFamily: "'VT323', monospace",
                  fontSize: "clamp(14px, 0.95vw, 18px)",
                  cursor: "pointer",
                  padding: "3px 10px",
                  flex: 1,
                }}
              >
                Save
              </button>
              <button
                type="button"
                onClick={handleCancel}
                style={{
                  background: "none",
                  border: "1px solid var(--color-border)",
                  color: "#888",
                  fontFamily: "'VT323', monospace",
                  fontSize: "clamp(14px, 0.95vw, 18px)",
                  cursor: "pointer",
                  padding: "3px 10px",
                  flex: 1,
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {(keys ?? []).length === 0 && (
        <div
          style={{
            textAlign: "center",
            padding: "16px",
            color: "#555",
            fontSize: "clamp(15px, 1.05vw, 22px)",
            fontFamily: "'VT323', monospace",
          }}
        >
          No API keys configured
        </div>
      )}
      {(keys ?? []).map((key: KeyStatus) => (
        <div key={key.name} className="uc-entity-item" style={{ cursor: "default" }}>
          <div style={{ flex: 1, overflow: "hidden" }}>
            <div className="uc-entity-name" style={{ color: "var(--color-secondary)" }}>
              {key.provider}
            </div>
            <div className="uc-entity-meta">{key.masked}</div>
          </div>
          <button
            type="button"
            onClick={() => handleDelete(key.name)}
            title={`Delete ${key.name}`}
            style={{
              background: "none",
              border: "none",
              color: "var(--color-danger, #c33)",
              fontFamily: "'VT323', monospace",
              fontSize: "clamp(16px, 1.1vw, 22px)",
              cursor: "pointer",
              padding: "0 4px",
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            x
          </button>
          <div
            style={{
              width: "clamp(8px, 0.68vw, 12px)",
              height: "clamp(8px, 0.68vw, 12px)",
              borderRadius: "50%",
              background: "var(--color-success)",
              flexShrink: 0,
            }}
          />
        </div>
      ))}
    </div>
  );
});

// ── Adapters Tab ────────────────────────────────────────────────────────────

const AdaptersTab = memo(function AdaptersTab() {
  const { data: adapters, isLoading, refetch } = useAdapters();

  const handleToggle = useCallback(
    async (platform: string, running: boolean) => {
      await patchApi(`/api/adapters/${encodeURIComponent(platform)}`, {
        status: running ? "inactive" : "active",
      });
      refetch();
    },
    [refetch],
  );

  const handleDelete = useCallback(
    async (platform: string) => {
      await deleteApi(`/api/adapters/${encodeURIComponent(platform)}`);
      refetch();
    },
    [refetch],
  );

  if (isLoading) {
    return (
      <div style={{ padding: "12px 14px", color: "#555", fontFamily: "'VT323', monospace" }}>
        Loading...
      </div>
    );
  }

  return (
    <div>
      {(adapters ?? []).length === 0 && (
        <div
          style={{
            textAlign: "center",
            padding: "16px",
            color: "#555",
            fontSize: "clamp(15px, 1.05vw, 22px)",
            fontFamily: "'VT323', monospace",
          }}
        >
          No adapters configured
        </div>
      )}
      {(adapters ?? []).map((adapter: AdapterStatus) => (
        <div key={adapter.platform} className="uc-entity-item" style={{ cursor: "default" }}>
          <div style={{ flex: 1, overflow: "hidden" }}>
            <div className="uc-entity-name">{adapter.platform}</div>
          </div>
          <button
            type="button"
            onClick={() => handleToggle(adapter.platform, adapter.running)}
            style={{
              background: "none",
              border: `1px solid ${adapter.running ? "var(--color-warning, #c90)" : "var(--color-success)"}`,
              color: adapter.running ? "var(--color-warning, #c90)" : "var(--color-success)",
              fontFamily: "'VT323', monospace",
              fontSize: "clamp(12px, 0.83vw, 16px)",
              cursor: "pointer",
              padding: "1px 8px",
              flexShrink: 0,
            }}
          >
            {adapter.running ? "Stop" : "Start"}
          </button>
          {adapter.source === "db" && (
            <button
              type="button"
              onClick={() => handleDelete(adapter.platform)}
              title={`Delete ${adapter.platform}`}
              style={{
                background: "none",
                border: "none",
                color: "var(--color-danger, #c33)",
                fontFamily: "'VT323', monospace",
                fontSize: "clamp(16px, 1.1vw, 22px)",
                cursor: "pointer",
                padding: "0 4px",
                lineHeight: 1,
                flexShrink: 0,
              }}
            >
              x
            </button>
          )}
          <span
            className="uc-entity-state"
            style={{
              color: adapter.running ? "var(--color-success)" : "#444",
              border: "1px solid var(--color-border)",
            }}
          >
            {adapter.running ? "Running" : adapter.status}
          </span>
          <span className="uc-entity-meta" style={{ fontSize: "clamp(11px, 0.75vw, 14px)" }}>
            {adapter.source}
          </span>
        </div>
      ))}
    </div>
  );
});

// ── MCP Tab ─────────────────────────────────────────────────────────────────

const McpTab = memo(function McpTab() {
  const { data: mcpInfo, isLoading } = useMcpInfo();

  if (isLoading) {
    return (
      <div style={{ padding: "12px 14px", color: "#555", fontFamily: "'VT323', monospace" }}>
        Loading...
      </div>
    );
  }

  if (!mcpInfo) {
    return (
      <div
        style={{
          textAlign: "center",
          padding: "16px",
          color: "#555",
          fontSize: "clamp(15px, 1.05vw, 22px)",
          fontFamily: "'VT323', monospace",
        }}
      >
        MCP not available
      </div>
    );
  }

  // Flatten all tools from all categories
  const allTools: McpToolInfo[] = [];
  for (const tools of Object.values(mcpInfo.tools)) {
    allTools.push(...tools);
  }

  return (
    <div style={{ padding: "12px" }}>
      <div style={{ fontSize: "clamp(12px, 0.83vw, 16px)", marginBottom: "8px", color: "#555" }}>
        {mcpInfo.url} &middot; port {mcpInfo.port} &middot; {allTools.length} tools
      </div>
      <div style={{ display: "flex", flexWrap: "wrap" as const, gap: "4px" }}>
        {allTools.map((tool) => (
          <span
            key={tool.name}
            style={{
              fontSize: "clamp(11px, 0.75vw, 14px)",
              padding: "2px 6px",
              border: "1px solid var(--color-border)",
              color: "var(--color-accent)",
              borderRadius: "2px",
              fontFamily: "'VT323', monospace",
            }}
            title={tool.description}
          >
            {tool.name}
          </span>
        ))}
      </div>
    </div>
  );
});

// ── Config Tab ──────────────────────────────────────────────────────────────

const ConfigTab = memo(function ConfigTab() {
  const { data: envVars, isLoading, refetch } = useEnvConfig();
  const [edits, setEdits] = useState<Record<string, string>>({});

  const hasChanges = Object.keys(edits).length > 0;

  const handleChange = useCallback((key: string, val: string, original: string) => {
    setEdits((prev) => {
      const next = { ...prev };
      if (val === original) {
        delete next[key];
      } else {
        next[key] = val;
      }
      return next;
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (!hasChanges) return;
    await putApi("/api/env", { vars: edits });
    setEdits({});
    refetch();
  }, [edits, hasChanges, refetch]);

  if (isLoading) {
    return (
      <div style={{ padding: "12px 14px", color: "#555", fontFamily: "'VT323', monospace" }}>
        Loading...
      </div>
    );
  }

  // Group by category
  const byCategory = new Map<string, EnvVar[]>();
  for (const v of envVars ?? []) {
    const cat = v.category || "General";
    const list = byCategory.get(cat) ?? [];
    list.push(v);
    byCategory.set(cat, list);
  }

  return (
    <div>
      {hasChanges && (
        <div
          style={{
            padding: "6px 12px",
            borderBottom: "1px solid var(--color-border)",
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          <button
            type="button"
            onClick={handleSave}
            style={{
              background: "none",
              border: "1px solid var(--color-success)",
              color: "var(--color-success)",
              fontFamily: "'VT323', monospace",
              fontSize: "clamp(14px, 0.95vw, 18px)",
              cursor: "pointer",
              padding: "3px 14px",
            }}
          >
            Save
          </button>
        </div>
      )}
      {Array.from(byCategory.entries()).map(([category, vars]) => (
        <div key={category}>
          <div
            style={{
              fontFamily: "'Press Start 2P', monospace",
              fontSize: "clamp(7px, 0.56vw, 9px)",
              textTransform: "uppercase",
              letterSpacing: "1px",
              color: "color-mix(in srgb, var(--color-primary) 45%, transparent)",
              padding: "clamp(6px, 0.52vw, 8px) 12px",
              borderBottom: "1px solid rgba(17,17,24,0.4)",
            }}
          >
            {category}
          </div>
          {vars.map((v) => {
            const currentVal = edits[v.key] ?? (v.isSet ? v.value : "");
            return (
              <div
                key={v.key}
                className="uc-context-row"
                style={{ padding: "clamp(6px, 0.3vw, 8px) 12px" }}
              >
                <span className="uc-context-key" style={{ fontSize: "clamp(14px, 0.98vw, 20px)" }}>
                  {v.key}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: "6px", flex: 1 }}>
                  <input
                    type={v.isSecret ? "password" : "text"}
                    value={currentVal}
                    onChange={(e) => handleChange(v.key, e.target.value, v.isSet ? v.value : "")}
                    style={{
                      ...inputStyle,
                      fontSize: "clamp(14px, 0.98vw, 20px)",
                      flex: 1,
                    }}
                  />
                  <div
                    style={{
                      width: "6px",
                      height: "6px",
                      borderRadius: "50%",
                      background: v.isSet ? "var(--color-success)" : "#444",
                      flexShrink: 0,
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
});

// ── Roles Tab ──────────────────────────────────────────────────────────────

const RolesTab = memo(function RolesTab() {
  const { data: roles, isLoading } = useRoles();

  if (isLoading) {
    return (
      <div style={{ padding: "12px 14px", color: "#555", fontFamily: "'VT323', monospace" }}>
        Loading...
      </div>
    );
  }

  return (
    <div>
      {(roles ?? []).length === 0 && (
        <div
          style={{
            textAlign: "center",
            padding: "16px",
            color: "#555",
            fontSize: "clamp(15px, 1.05vw, 22px)",
            fontFamily: "'VT323', monospace",
          }}
        >
          No roles defined
        </div>
      )}
      {(roles ?? []).map((role: RoleEntry) => (
        <div key={role.name} className="uc-entity-item" style={{ cursor: "default" }}>
          <div style={{ flex: 1, overflow: "hidden" }}>
            <div className="uc-entity-name" style={{ color: "var(--color-primary)" }}>
              {role.name}
            </div>
            <div className="uc-entity-meta">{role.traits || "no traits"}</div>
            {role.description && (
              <div className="uc-entity-meta" style={{ color: "#444", marginTop: "2px" }}>
                {role.description.length > 80
                  ? `${role.description.slice(0, 80)}...`
                  : role.description}
              </div>
            )}
          </div>
          <span
            className="uc-entity-state"
            style={{
              color: "#666",
              border: "1px solid var(--color-border)",
              fontSize: "clamp(11px, 0.75vw, 14px)",
            }}
          >
            {role.origin}
          </span>
        </div>
      ))}
    </div>
  );
});

// ── Security Tab ──────────────────────────────────────────────────────────

const SecurityTab = memo(function SecurityTab() {
  const { data: envVars, isLoading } = useEnvConfig();

  if (isLoading) {
    return (
      <div style={{ padding: "12px 14px", color: "#555", fontFamily: "'VT323', monospace" }}>
        Loading...
      </div>
    );
  }

  // Filter for security-related env vars
  const securityVars = (envVars ?? []).filter(
    (v) =>
      v.category === "Security" ||
      v.key.includes("API_KEY") ||
      v.key.includes("SECRET") ||
      v.key.includes("AUTH") ||
      v.key.includes("PASSWORD") ||
      v.key === "MARINA_OPEN_API",
  );

  return (
    <div>
      {securityVars.length === 0 && (
        <div
          style={{
            textAlign: "center",
            padding: "16px",
            color: "#555",
            fontSize: "clamp(15px, 1.05vw, 22px)",
            fontFamily: "'VT323', monospace",
          }}
        >
          No security configuration found
        </div>
      )}
      {securityVars.map((v) => (
        <div
          key={v.key}
          className="uc-context-row"
          style={{ padding: "clamp(6px, 0.3vw, 8px) 12px" }}
        >
          <span className="uc-context-key" style={{ fontSize: "clamp(14px, 0.98vw, 20px)" }}>
            {v.key}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span
              className="uc-context-value"
              style={{
                fontFamily: "'VT323', monospace",
                fontSize: "clamp(14px, 0.98vw, 20px)",
              }}
            >
              {v.isSecret ? "****" : v.isSet ? v.value : "-"}
            </span>
            <div
              style={{
                width: "6px",
                height: "6px",
                borderRadius: "50%",
                background: v.isSet ? "var(--color-success)" : "var(--color-danger)",
                flexShrink: 0,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
});

// ── Main Panel ──────────────────────────────────────────────────────────────

/**
 * Floating admin panel with Keys, Adapters, MCP, Config, Roles, and Security tabs.
 */
export const AdminPanel = memo(function AdminPanel({ visible, onClose }: AdminPanelProps) {
  const [tab, setTab] = useState<AdminTab>("keys");

  return (
    <FloatingPanel
      title="Admin"
      visible={visible}
      onClose={onClose}
      initialPosition={{ left: "12px", top: "clamp(340px, 46vh, 490px)" }}
      initialSize={{ width: "clamp(280px, 18vw, 380px)", height: "clamp(260px, 32vh, 380px)" }}
      defaultRolled
    >
      {/* Tabs */}
      <div
        className="uc-fp-tabs"
        style={{
          display: "flex",
          flexWrap: "wrap" as const,
          borderBottom: "1px solid var(--color-border)",
          flexShrink: 0,
        }}
      >
        <TabButton label="Keys" active={tab === "keys"} onClick={() => setTab("keys")} />
        <TabButton
          label="Adapters"
          active={tab === "adapters"}
          onClick={() => setTab("adapters")}
        />
        <TabButton label="MCP" active={tab === "mcp"} onClick={() => setTab("mcp")} />
        <TabButton label="Config" active={tab === "config"} onClick={() => setTab("config")} />
        <TabButton label="Roles" active={tab === "roles"} onClick={() => setTab("roles")} />
        <TabButton
          label="Security"
          active={tab === "security"}
          onClick={() => setTab("security")}
        />
      </div>

      {/* Tab content */}
      {tab === "keys" && <KeysTab />}
      {tab === "adapters" && <AdaptersTab />}
      {tab === "mcp" && <McpTab />}
      {tab === "config" && <ConfigTab />}
      {tab === "roles" && <RolesTab />}
      {tab === "security" && <SecurityTab />}
    </FloatingPanel>
  );
});
