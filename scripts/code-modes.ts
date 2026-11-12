// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Use-case modes for the terminal workspace (`marina --tui`). A mode decides
 * what the screen shows for one kind of work; it never starts, stops or
 * selects a worker, and the coding session keeps running in every mode.
 *
 * - `coding`: the coding conversation alone. The World is reduced to the
 *   messages addressed to you, shown on one line above the composer.
 * - `operate`: a live board (attention, agents, spend, status) beside the
 *   World conversation, where approvals and world commands go.
 * - `coordinate`: who is working on what — participant sessions (Streams)
 *   and the task board — beside the World, where you steer them.
 * - `memory`: curating what the world knows — dream proposals waiting for
 *   you and memory health — beside the World, where `memory …` runs.
 * - `investigate`: after the fact — execution traces (failures first) and
 *   the activity feed — beside the World, where `trace …` drills in.
 * - `forecast`: your predictions and research — running first, then
 *   answers and resolutions — beside the World, where `inquiry …` asks.
 * - `admin`: how the world is set up — sign-in, key storage, default model,
 *   provider keys by name — and the server's recent errors and warnings,
 *   beside the World, where `key …`, `admin …` and `readiness` run.
 */

import { isAddressedTo } from "../src/agent/social";
import type { Perception } from "../src/sdk/client";
import type { ConversationView } from "./code-views";
import type { Part } from "./term-status";

export const WORKSPACE_MODES = [
  "coding",
  "operate",
  "coordinate",
  "memory",
  "investigate",
  "forecast",
  "admin",
] as const;
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

export interface ModeDef {
  name: WorkspaceMode;
  label: string;
  describe: string;
  /** Where the composer points when the mode is entered. */
  composer: ConversationView;
  /** Live board cards (`term-panels` names), top to bottom; none = no board pane. */
  board: readonly string[];
  /** The first line the mode prints: what to type here. */
  hint: string;
  /** On-demand snapshot parts its board reads; polled only while the mode is shown. */
  parts?: readonly Part[];
}

export const MODES: Record<WorkspaceMode, ModeDef> = {
  coding: {
    name: "coding",
    label: "Coding",
    describe: "the coding conversation; World shows only messages addressed to you",
    composer: "coding",
    board: [],
    hint: "Type a task in plain words, or /help.",
  },
  operate: {
    name: "operate",
    label: "Operate",
    describe: "attention, agents, spend and world status beside the World",
    composer: "world",
    // What needs a person first; readiness detail stays one `/live readiness` away.
    board: ["alerts", "agents", "spend", "status"],
    hint: "World commands go here: challenge approve <token>, agent stop <name>, readiness. Shift+PageUp/PageDown scroll the board; F3 returns to Coding.",
  },
  coordinate: {
    name: "coordinate",
    label: "Coordinate",
    describe: "participant sessions and the task board beside the World",
    composer: "world",
    // Who needs you first (asking, failing), then the board's reviews and claims.
    board: ["streams", "tasks"],
    parts: ["streams", "tasks"],
    hint: "World commands go here: tell <name> <message>, task show <id>, task approve <id> <claimant>. /agents and /use reach native sessions. F3 cycles modes.",
  },
  memory: {
    name: "memory",
    label: "Memory",
    describe: "dream proposals waiting for you and memory health beside the World",
    composer: "world",
    board: ["dreams", "memory"],
    parts: ["dreams", "memory"],
    hint: "World commands go here: memory recall <query>, memory dream proposals, memory dream adopt <id>, note conflicts. F3 cycles modes.",
  },
  investigate: {
    name: "investigate",
    label: "Investigate",
    describe: "execution traces, failures first, and the activity feed beside the World",
    composer: "world",
    board: ["traces", "feed"],
    parts: ["traces", "feed"],
    hint: "World commands go here: trace show <id>, trace find status=failed, trace eval <id>, feed list since:2h. F3 cycles modes.",
  },
  forecast: {
    name: "forecast",
    label: "Forecast",
    describe: "your predictions and research, running first, beside the World",
    composer: "world",
    board: ["forecasts", "spend"],
    parts: ["forecasts"],
    hint: "World commands go here: inquiry predict -- <question>, inquiry show <case-id>, inquiry why <case-id>, forecast <question>. Every prediction costs model calls; Spend is below. F3 cycles modes.",
  },
  admin: {
    name: "admin",
    label: "Admin",
    describe: "the world's setup and recent server errors and warnings beside the World",
    composer: "world",
    // Setup first (what is misconfigured), then what the server is complaining about.
    board: ["setup", "logs"],
    parts: ["setup", "logs"],
    hint: "World commands go here: key list, key test <name>, admin models, readiness, admin stats. Values of keys are never shown. F3 cycles modes.",
  },
};

export function parseMode(name: string | undefined): WorkspaceMode | undefined {
  const value = name?.trim().toLowerCase();
  return (WORKSPACE_MODES as readonly string[]).includes(value ?? "")
    ? (value as WorkspaceMode)
    : undefined;
}

/** The modes a workspace offers: a world-only one (`marina connect --tui`) has no coding. */
export function modesFor(worldOnly = false): readonly WorkspaceMode[] {
  return worldOnly ? WORKSPACE_MODES.filter((mode) => mode !== "coding") : WORKSPACE_MODES;
}

/** The first mode of a world-only workspace when none (or coding) is asked for. */
export const WORLD_DEFAULT_MODE: WorkspaceMode = "operate";

export function nextMode(mode: WorkspaceMode, worldOnly = false): WorkspaceMode {
  const modes = modesFor(worldOnly);
  return modes[(modes.indexOf(mode) + 1) % modes.length]!;
}

export function modeUsage(worldOnly = false): string {
  return `Modes: ${modesFor(worldOnly)
    .map((mode) => `${mode} (${MODES[mode].describe})`)
    .join("; ")}. /mode <name> or F3.`;
}

/**
 * A World message meant for this person: a tell to them, or a room/channel
 * message that names them the way agents are addressed (`isAddressedTo`).
 * Their own send receipts never count.
 */
export function addressedMessage(
  p: Perception,
  self: string,
): { from: string; message: string } | undefined {
  const data = p.data ?? {};
  if (data.delivery) return undefined;
  const message = typeof data.message === "string" ? data.message : undefined;
  if (!message) return undefined;
  const from =
    typeof data.senderName === "string"
      ? data.senderName
      : typeof data.sender === "string"
        ? data.sender
        : "";
  if (from && self && from.toLowerCase() === self.toLowerCase()) return undefined;
  if (p.tag === "tell" && typeof data.senderName === "string") return { from, message };
  if (
    ["say", "shout", "channel", "broadcast"].includes(p.tag ?? "") &&
    isAddressedTo(message, self)
  )
    return { from, message };
  return undefined;
}
