// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Admin panel tab, split out of AdminPanel.tsx without behaviour change. */

import { Radio } from "lucide-react";
import { useEffect, useState } from "react";
import { describeApiError, fetchApi, putApi } from "../lib/api";
import { ModelSelect } from "./ModelSelect";
import { PanelSkeleton } from "./OperatorFeedback";

interface EndpointCfg {
  mode: "passthru" | "agents" | "open" | "panel";
  fallback: boolean;
  strategy: "round-robin" | "least-busy" | "adaptive";
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
export function EndpointTab() {
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

  if (!cfg) return <PanelSkeleton />;

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
            <option value="adaptive">adaptive (evidence-aware)</option>
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
