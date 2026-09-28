#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Candidates for HUMAN labeling (the Gate Case Labeling page): cases whose
 * label no proof settles, so people must. Two pools:
 *
 *   marina   concrete examples from every built-in command's own help and
 *            usage text, kept only when the gate would score them
 *            (`classifyToolRisk` = mutate / consequential), each paired with
 *            one trust context (seeded), so labelers judge the call in context.
 *   public   real tool calls from public corpora whose truth is unresolved
 *            (DefenseClaw grade C / E: contextual, dual-use, trajectory-only),
 *            capped per tool, attributed to their source dataset and licence.
 *
 * Only the choice of WHICH cases exist comes from here; every label comes from
 * the labelers. Writes a JSON list the page's store is seeded from.
 *
 *   bun run scripts/decision-cases/labeling-candidates.ts [--public-in <dir>] [--out <file>]
 */

import { readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { classifyToolRisk } from "../../src/agent/tool-policy";
import {
  ALLOWED_LICENSES,
  type DefenseClawCase,
  truthGrade,
} from "../../src/decisions/public-cases";
import { loadDecisionCases } from "../../src/decisions/qualify";
import { Engine } from "../../src/engine/engine";
import { roomId } from "../../src/types";

const { values } = parseArgs({
  options: {
    "public-in": { type: "string" },
    out: { type: "string" },
    "public-per-tool": { type: "string" },
    "public-max": { type: "string" },
    seed: { type: "string" },
  },
});
const publicIn = values["public-in"] ?? join(homedir(), ".cache/marina/decision-cases/out");
const outPath =
  values.out ?? join(homedir(), ".cache/marina/decision-cases/labeling-candidates.json");
const publicPerTool = Number(values["public-per-tool"] ?? 3);
const publicMax = Number(values["public-max"] ?? 300);
let seed = Number(values.seed ?? 20260927) >>> 0;
const rand = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const shuffle = <T>(xs: T[]) => {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
  }
  return xs;
};

export interface LabelCandidate {
  id: string;
  pool: "marina" | "public";
  tool: string;
  arguments: Record<string, unknown>;
  /** The agent's purpose and what fed this cycle (absent for public calls). */
  context?: { goal: string; role: string; sources: string[] };
  /** Attribution for public calls. */
  source?: { dataset: string; revision?: string; license: string };
}

// ─── Marina commands ─────────────────────────────────────────────────────────

const CONTEXTS: LabelCandidate["context"][] = [
  { role: "explorer", goal: "Map the world and help where useful", sources: ["world_event"] },
  { role: "builder", goal: "Keep the lab tidy and working", sources: ["memory"] },
  { role: "researcher", goal: "Research what the team asked about", sources: ["external_tool"] },
  { role: "coordinator", goal: "Coordinate the team's open tasks", sources: ["untrusted_relay"] },
];

function examples(def: { name: string; help?: string; usage?: string[] }): string[] {
  const lines: string[] = [];
  const help = def.help ?? "";
  const ex = help.split(/Examples?:/i)[1];
  if (ex) {
    for (const raw of ex.split("\n")) {
      const line = raw.replace(/\s+—.*$|\s{2,}.*$/, "").trim();
      if (line.startsWith(def.name)) lines.push(line);
    }
  }
  for (const u of def.usage ?? []) {
    // Only concrete usage lines (no placeholders or alternatives).
    if (!/[<[|]/.test(u) && u.startsWith(def.name)) lines.push(u.trim());
  }
  return lines;
}

const engine = new Engine({ startRoom: roomId("labeling/start"), tickInterval: 60_000 });
const marina: LabelCandidate[] = [];
const seen = new Set<string>();
/** At most this many examples per top-level command, so one verbose help text cannot dominate. */
const PER_COMMAND = 6;
const perCommand = new Map<string, number>();
for (const def of engine.commands.allBuiltins()) {
  for (const command of examples(def)) {
    const risk = classifyToolRisk("marina_command", { command });
    if (risk !== "mutate" && risk !== "consequential") continue;
    if (seen.has(command)) continue;
    const top = command.split(" ")[0]!;
    if ((perCommand.get(top) ?? 0) >= PER_COMMAND) continue;
    perCommand.set(top, (perCommand.get(top) ?? 0) + 1);
    seen.add(command);
    marina.push({
      id: `marina:${marina.length.toString().padStart(4, "0")}`,
      pool: "marina",
      tool: "marina_command",
      arguments: { command },
      context: CONTEXTS[Math.floor(rand() * CONTEXTS.length)]!,
    });
  }
}

// The tracked cases' calls, relabeled by people: independent labels for them,
// and a measure of how far the author's labels agree with a panel.
for (const c of loadDecisionCases().gate) {
  if (!c.command || !c.intent) continue;
  marina.push({
    id: `tracked:${c.id}`,
    pool: "marina",
    tool: "marina_command",
    arguments: { command: c.command },
    context: {
      goal: c.intent.goal ?? "",
      role: c.intent.role ?? "",
      sources: [...c.intent.sources],
    },
  });
}

// ─── Public unresolved calls ─────────────────────────────────────────────────

const byTool = new Map<string, LabelCandidate[]>();
for (const file of readdirSync(publicIn).filter((f) => f.endsWith(".jsonl"))) {
  const text = await Bun.file(join(publicIn, file)).text();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as DefenseClawCase;
    const license = row.source?.license;
    if (!license || !ALLOWED_LICENSES.has(license)) continue;
    const grade = truthGrade(row);
    if ((grade !== "C" && grade !== "E") || row.surface !== "action") continue;
    const p = row.payload ?? {};
    const tool = typeof p.tool_name === "string" ? p.tool_name : undefined;
    if (!tool) continue;
    const args: Record<string, unknown> = {};
    if (p.args && typeof p.args === "object" && !Array.isArray(p.args)) {
      for (const [k, v] of Object.entries(p.args as Record<string, unknown>)) {
        if (!k.startsWith("_")) args[k] = v;
      }
    }
    // A call with no arguments carries nothing to judge.
    if (Object.keys(args).length === 0) continue;
    const dataset = row.source?.dataset ?? file;
    const key = `${dataset}|${tool}`;
    const list = byTool.get(key) ?? [];
    list.push({
      id: `public:${dataset}:${row.id}`,
      pool: "public",
      tool,
      arguments: args,
      source: {
        dataset,
        ...(row.source?.revision ? { revision: row.source.revision } : {}),
        license,
      },
    });
    byTool.set(key, list);
  }
}
const publicCases: LabelCandidate[] = [];
for (const list of byTool.values()) publicCases.push(...shuffle(list).slice(0, publicPerTool));
const pub = shuffle(publicCases).slice(0, publicMax);

const all = shuffle([...marina, ...pub]);
writeFileSync(outPath, `${JSON.stringify(all)}\n`);
const tools = (xs: LabelCandidate[]) =>
  new Set(xs.map((c) => (c.pool === "marina" ? String(c.arguments.command).split(" ")[0] : c.tool)))
    .size;
console.log(
  JSON.stringify({
    marina: marina.length,
    marinaCommands: tools(marina),
    public: pub.length,
    publicTools: tools(pub),
    out: outPath,
  }),
);
process.exit(0);
