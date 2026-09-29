// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Admin panel tab, split out of AdminPanel.tsx without behaviour change. */

import { Settings } from "lucide-react";
import { useState } from "react";
import { useEnvConfig } from "../hooks/use-api";
import { putApi } from "../lib/api";
import { PanelSkeleton } from "./OperatorFeedback";

interface SaveResult {
  reloaded: string[];
  restartRequired: string[];
}

export function ConfigTab() {
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
    return <PanelSkeleton />;
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
