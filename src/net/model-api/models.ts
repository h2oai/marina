// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// `/v1/models` listing: which `model*` channels are routable right now plus the
// compat-profile aliases, rendered in the OpenAI list shape.

import type { Engine } from "../../engine/engine";
import { COMPAT_ALIASES, channelNameToModel } from "./shared";

export interface ModelInfo {
  id: string;
  channelId: string;
  onlineMembers: number;
}

export function listModels(engine: Engine): ModelInfo[] {
  const cm = engine.channelManager;
  if (!cm) return [];

  const onlineIds = new Set(engine.getOnlineAgents().map((e) => e.id));
  const channels = cm.getAllChannels();
  const models: ModelInfo[] = [];

  for (const ch of channels) {
    if (!ch.name.startsWith("model")) continue;
    if (ch.name !== "model" && !ch.name.startsWith("model-")) continue;
    // Exclude conversation channels from model listing
    if (ch.name.startsWith("model-conv-")) continue;
    const members = cm.getMembers(ch.id);
    const online = members.filter((m) => onlineIds.has(m as never)).length;
    // Hide marina:<name> subroutes with no online agents — they would 503 on request.
    // "model" (the default) stays visible because it falls back to direct upstream proxy.
    if (ch.name !== "model" && online === 0) continue;
    models.push({
      id: channelNameToModel(ch.name),
      channelId: ch.id,
      onlineMembers: online,
    });
  }

  // Compat-profile drop-in: expose the default "model" channel under each registered
  // alias (e.g. "assistant") so external clients pointed at /v1/models see a familiar
  // id. Same channel, same agents — just an alias.
  const defaultModel = models.find((m) => m.id === "marina");
  if (defaultModel) {
    for (const alias of COMPAT_ALIASES.keys()) {
      models.push({
        id: alias,
        channelId: defaultModel.channelId,
        onlineMembers: defaultModel.onlineMembers,
      });
    }
  }

  return models;
}

export function openaiModelList(models: ModelInfo[]): unknown {
  return {
    object: "list",
    data: models.map((m) => ({
      id: m.id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "marina",
    })),
  };
}
