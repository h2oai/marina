// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * CommandBar admin tab bodies: API keys, MCP tool catalogue, env config.
 * Extracted mechanically from CommandBar.tsx — no behavior change.
 */

import { memo, useCallback, useState } from "react";
import { useEnvConfig, useKeys, useMcpInfo } from "../../../hooks/use-api";
import type { EnvVar, KeyStatus } from "../../../lib/types";
import { ActionBtn, CoordEmpty, CoordLoading } from "./shared";

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

export const KeysAdminTab = memo(function KeysAdminTab() {
  const { data, isLoading, refetch } = useKeys();
  const [adding, setAdding] = useState(false);
  const [keyName, setKeyName] = useState("");
  const [keyProvider, setKeyProvider] = useState("");
  const [keyValue, setKeyValue] = useState("");

  const handleAdd = useCallback(async () => {
    if (!keyName || !keyProvider || !keyValue) return;
    const { postApi } = await import("../../../lib/api");
    await postApi("/api/keys", { name: keyName, provider: keyProvider, value: keyValue });
    setKeyName("");
    setKeyProvider("");
    setKeyValue("");
    setAdding(false);
    refetch();
  }, [keyName, keyProvider, keyValue, refetch]);

  const handleDelete = useCallback(
    async (name: string) => {
      const { deleteApi } = await import("../../../lib/api");
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
          <div className={`uc-coord-dot ${k.masked ? "active" : "pending"}`} aria-hidden="true" />
          <span className="visually-hidden">{k.masked ? "configured" : "pending"}</span>
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
            aria-label={`Delete key ${k.name}`}
          >
            <span aria-hidden="true">x</span>
          </button>
        </div>
      ))}
    </div>
  );
});

export const McpAdminTab = memo(function McpAdminTab() {
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
          aria-hidden="true"
          style={{
            width: "7px",
            height: "7px",
            borderRadius: "50%",
            background: "#22c55e",
            boxShadow: "0 0 4px #22c55e",
          }}
        />
        <span className="visually-hidden">MCP server online</span>
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

export const ConfigAdminTab = memo(function ConfigAdminTab() {
  const { data, isLoading, refetch } = useEnvConfig();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    if (Object.keys(edits).length === 0) return;
    setSaving(true);
    try {
      const { putApi } = await import("../../../lib/api");
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
            <div className={`uc-coord-dot ${v.value ? "active" : "done"}`} aria-hidden="true" />
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
