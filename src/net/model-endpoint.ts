// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Model-endpoint configuration — how Marina behaves when consumed as an LLM at
 * `/v1/chat/completions` (and the Ollama / Responses surfaces). Operator-tunable
 * at runtime via the Admin "Model Endpoint" tab; persisted in `app_settings`.
 *
 * Four modes cover the ways Marina can be a model:
 *  - passthru: a thin OpenAI-compatible gateway to a chosen upstream model. No
 *              agents involved.
 *  - agents:   route to ONE agent on the `model` channel (round-robin / least-busy)
 *              and return its answer — the historical default. Optional fallback
 *              to passthru when no agent is online.
 *  - open:     broadcast to the channel; the FIRST agent to answer wins (no pinned
 *              target). Optional passthru fallback.
 *  - panel:    fan out to up to N channel agents, then concat or synthesize their
 *              answers into one. Optional passthru fallback.
 */

import type { MarinaDB } from "../persistence/database";

export type EndpointMode = "passthru" | "agents" | "open" | "panel";
export type LoadStrategy = "round-robin" | "least-busy";
export type PanelSynthesis = "concat" | "synthesize";

export interface EndpointConfig {
  mode: EndpointMode;
  /** Fall back to passthru when no agent answers (agents/open/panel modes). */
  fallback: boolean;
  /** Agent-selection strategy for `agents` mode. */
  strategy: LoadStrategy;
  /** Upstream model for passthru (and the fallback). Empty → use the Default Model. */
  passthruModel: string;
  /** Max agents to collect from in `panel` mode. */
  panelSize: number;
  /** How `panel` combines collected answers. */
  panelSynthesis: PanelSynthesis;
}

const MODES: ReadonlySet<string> = new Set(["passthru", "agents", "open", "panel"]);
const STRATEGIES: ReadonlySet<string> = new Set(["round-robin", "least-busy"]);
const SYNTH: ReadonlySet<string> = new Set(["concat", "synthesize"]);

export const DEFAULT_ENDPOINT_CONFIG: EndpointConfig = {
  // Default preserves the historical behavior exactly: coordinate to one agent,
  // fall back to upstream when none are online.
  mode: "agents",
  fallback: true,
  strategy: "round-robin",
  passthruModel: "",
  panelSize: 3,
  panelSynthesis: "concat",
};

// app_settings keys.
const K = {
  mode: "endpoint_mode",
  fallback: "endpoint_fallback",
  strategy: "endpoint_strategy",
  passthruModel: "endpoint_passthru_model",
  panelSize: "endpoint_panel_size",
  panelSynthesis: "endpoint_panel_synthesis",
} as const;

/** Read the effective endpoint config, falling back to defaults for unset/invalid. */
export function getEndpointConfig(db: MarinaDB | undefined): EndpointConfig {
  if (!db) return { ...DEFAULT_ENDPOINT_CONFIG };
  const mode = db.getSetting(K.mode);
  const strategy = db.getSetting(K.strategy);
  const synth = db.getSetting(K.panelSynthesis);
  const size = Number.parseInt(db.getSetting(K.panelSize) ?? "", 10);
  return {
    mode: mode && MODES.has(mode) ? (mode as EndpointMode) : DEFAULT_ENDPOINT_CONFIG.mode,
    fallback: (db.getSetting(K.fallback) ?? "1") !== "0",
    strategy:
      strategy && STRATEGIES.has(strategy)
        ? (strategy as LoadStrategy)
        : DEFAULT_ENDPOINT_CONFIG.strategy,
    passthruModel: db.getSetting(K.passthruModel) ?? "",
    panelSize:
      Number.isFinite(size) && size >= 1 ? Math.min(size, 8) : DEFAULT_ENDPOINT_CONFIG.panelSize,
    panelSynthesis:
      synth && SYNTH.has(synth)
        ? (synth as PanelSynthesis)
        : DEFAULT_ENDPOINT_CONFIG.panelSynthesis,
  };
}

/** Validate + persist a partial config update. Returns the new effective config
 *  or an error string. */
export function setEndpointConfig(
  db: MarinaDB,
  patch: Partial<EndpointConfig>,
): { config: EndpointConfig } | { error: string } {
  if (patch.mode !== undefined && !MODES.has(patch.mode)) {
    return { error: `mode must be one of: ${[...MODES].join(", ")}` };
  }
  if (patch.strategy !== undefined && !STRATEGIES.has(patch.strategy)) {
    return { error: `strategy must be one of: ${[...STRATEGIES].join(", ")}` };
  }
  if (patch.panelSynthesis !== undefined && !SYNTH.has(patch.panelSynthesis)) {
    return { error: `panelSynthesis must be one of: ${[...SYNTH].join(", ")}` };
  }
  if (
    patch.passthruModel !== undefined &&
    patch.passthruModel !== "" &&
    !/^[\w.-]+\/[\w./:-]+$/.test(patch.passthruModel)
  ) {
    return { error: 'passthruModel must be "provider/model-id" (or empty for the Default Model)' };
  }
  if (patch.panelSize !== undefined && (!Number.isFinite(patch.panelSize) || patch.panelSize < 1)) {
    return { error: "panelSize must be a positive integer" };
  }

  if (patch.mode !== undefined) db.setSetting(K.mode, patch.mode);
  if (patch.fallback !== undefined) db.setSetting(K.fallback, patch.fallback ? "1" : "0");
  if (patch.strategy !== undefined) db.setSetting(K.strategy, patch.strategy);
  if (patch.passthruModel !== undefined) db.setSetting(K.passthruModel, patch.passthruModel);
  if (patch.panelSize !== undefined)
    db.setSetting(K.panelSize, String(Math.min(Math.floor(patch.panelSize), 8)));
  if (patch.panelSynthesis !== undefined) db.setSetting(K.panelSynthesis, patch.panelSynthesis);

  return { config: getEndpointConfig(db) };
}
