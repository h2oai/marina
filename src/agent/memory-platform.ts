// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { getErrorMessage } from "../engine/errors";
import { Logger } from "../engine/logger";
import { type MemoryNoteResult, readMemoryResult } from "../memory/command-result";
import { isUnifiedContextResult, type UnifiedContextResult } from "../memory/unified-context";
import { stripAnsi } from "../net/ansi";
import type { MarinaClient } from "../sdk/client";
import type { MemoryOperationResult } from "../sdk/memory-operations";
import type { MemorySourceRange } from "../sdk/memory-types";
import type { Perception } from "../types";
import { DurableResidentMemory } from "./durable-memory";

/** Module logger. */
const logger = new Logger();

// ─── Utilities ──────────────────────────────────────────────────────────────

function importanceLevelToNum(level: string): number {
  switch (level) {
    case "low":
      return 3;
    case "high":
      return 8;
    default:
      return 5;
  }
}

function categoryToNoteType(category: string): string {
  switch (category) {
    case "instruction":
    case "preference":
    case "goal":
      return "decision";
    case "insight":
    case "strategy":
      return "inference";
    case "discovery":
    case "observation":
      return "observation";
    case "research_note":
    case "reference":
      return "fact";
    default:
      return "observation";
  }
}

function extractText(perceptions: Perception[]): string {
  return perceptions
    .map((p) => {
      if (p.data?.text) return p.data.text as string;
      if (p.data?.message) return p.data.message as string;
      return "";
    })
    .filter(Boolean)
    .map(stripAnsi)
    .join("\n");
}

/** Last durable-service envelope (`data.memory_service`) in a command's perceptions. */
function serviceEnvelope(perceptions: Perception[]): MemoryOperationResult | undefined {
  return perceptions.map((p) => p.data?.memory_service).findLast(Boolean) as
    | MemoryOperationResult
    | undefined;
}

function coreValue(perceptions: Perception[]): string | undefined {
  const result = readMemoryResult(perceptions, "core-get");
  if (result) return result.success ? result.entry?.value : undefined;
  return extractText(perceptions)
    .match(/\(v\d+\):\s*([\s\S]*)/)?.[1]
    ?.trim();
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PlatformMemoryResult {
  success: boolean;
  text: string;
  noteId?: number;
  results?: PlatformNoteResult[];
}

export type PlatformNoteResult = MemoryNoteResult;

// ─── Platform Memory Backend ────────────────────────────────────────────────

export class PlatformMemoryBackend {
  private client: MarinaClient;
  private durable: DurableResidentMemory;

  constructor(client: MarinaClient) {
    this.client = client;
    this.durable = new DurableResidentMemory(client);
  }

  async write(
    category: string,
    content: string,
    importance: "low" | "medium" | "high" = "medium",
    tags: string[] = [],
  ): Promise<PlatformMemoryResult> {
    const imp = importanceLevelToNum(importance);
    const noteType = categoryToNoteType(category);
    const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
    const cmd = `note ${content}${tagStr} importance ${imp} type ${noteType}`;
    const perceptions = await this.client.command(cmd);
    const text = extractText(perceptions);
    const idMatch = text.match(/Note #(\d+)/);
    return {
      success: !!idMatch,
      text,
      noteId: idMatch?.[1] ? Number.parseInt(idMatch[1], 10) : undefined,
    };
  }

  async search(
    query: string,
    opts?: { noteType?: string; mode?: "recent" | "important"; trusted?: boolean },
  ): Promise<PlatformMemoryResult> {
    let cmd = `recall ${query}`;
    if (opts?.mode === "recent") cmd += " recent";
    if (opts?.mode === "important") cmd += " important";
    if (opts?.trusted) cmd += " trusted";
    if (opts?.noteType) cmd += ` type ${opts.noteType}`;

    const perceptions = await this.client.command(cmd);
    const text = extractText(perceptions);
    const result = readMemoryResult(perceptions, "recall");
    return {
      success: result?.success ?? true,
      text,
      results: result ? (result.notes ?? []) : this.parseRecallResults(text),
    };
  }

  /**
   * Two labeled recall tiers for the same query, fetched in parallel:
   * `trusted` is the strict `recall <q> trusted` result (verified or
   * high-confidence sourced notes only — empty when none qualify) and
   * `ordinary` is the plain `recall <q>` result, which includes the agent's
   * own unverified notes. Callers that want to *show* both tiers use this;
   * `search({ trusted: true })` itself stays strict and never falls back, so
   * the `trusted` flag means what it says. A failed tier degrades to an empty
   * list rather than failing the whole call.
   */
  async searchTiered(
    query: string,
    opts?: { noteType?: string; mode?: "recent" | "important" },
  ): Promise<{ trusted: PlatformNoteResult[]; ordinary: PlatformNoteResult[] }> {
    const empty: PlatformNoteResult[] = [];
    const [trusted, ordinary] = await Promise.all([
      this.search(query, { ...opts, trusted: true })
        .then((r) => r.results ?? empty)
        .catch(() => empty),
      this.search(query, opts)
        .then((r) => r.results ?? empty)
        .catch(() => empty),
    ]);
    return { trusted, ordinary };
  }

  /**
   * The unified retrieval surface (`recall <q> all`): skills, `[trusted]`,
   * `[evidence]` (durable records + captured sources), `[proposal]` (finished
   * assistance answers) and `[unverified]` own notes, budgeted server-side.
   * Transport-agnostic — the adapter never touches the DB; it reads the
   * additive `context` field of the `marina.memory.command.v1` payload.
   * `context` is null when the server predates the unified payload, so the
   * caller can fall back to `searchTiered` + `searchSkills`.
   */
  async unifiedContext(
    query: string,
    budgetBytes?: number,
  ): Promise<{ success: boolean; text: string; context: UnifiedContextResult | null }> {
    let cmd = `recall ${query} all`;
    if (budgetBytes && Number.isFinite(budgetBytes)) cmd += ` budget ${Math.floor(budgetBytes)}`;
    const perceptions = await this.client.command(cmd);
    const text = extractText(perceptions);
    const result = readMemoryResult(perceptions, "recall");
    const context = (result as { context?: unknown } | undefined)?.context;
    return {
      success: result?.success ?? false,
      text,
      context: isUnifiedContextResult(context) ? context : null,
    };
  }

  /**
   * Read the first `maxBytes` of a durable source (an archived/journaled
   * message part) via `source_range`. Used by boot recovery to surface the
   * most recent preserved text instead of only a manifest id. Null on any
   * failure — recovery hints stay useful without it.
   */
  async readSourceExcerpt(sourceId: string, maxBytes: number): Promise<string | null> {
    try {
      const request = {
        operation: "source_range",
        id: sourceId,
        input: { start: 0, end: Math.max(1, Math.floor(maxBytes)) },
      };
      const perceptions = await this.client.command(`memory api ${JSON.stringify(request)}`);
      const envelope = serviceEnvelope(perceptions);
      if (!envelope?.ok) return null;
      const range = envelope.result as Partial<MemorySourceRange> | undefined;
      return typeof range?.text === "string" && range.text.trim() ? range.text : null;
    } catch {
      return null;
    }
  }

  async update(noteId: string, newContent: string): Promise<PlatformMemoryResult> {
    const perceptions = await this.client.command(`note correct ${noteId} ${newContent}`);
    const text = extractText(perceptions);
    return { success: /Note #\d+ created, superseding #\d+/.test(text), text };
  }

  async remove(noteId: string): Promise<PlatformMemoryResult> {
    const perceptions = await this.client.command(`note delete ${noteId}`);
    const text = extractText(perceptions);
    return { success: text.includes("deleted"), text };
  }

  /**
   * `reflect [topic]`. `helper` decides how the world may involve a
   * memory-reflector: `auto` (default) lets the `reflect` command discover one
   * or — LOCAL ungated — spawn one; `existing` (`--no-spawn`) files a job only
   * with a helper that is already running, else the template; `never`
   * (`--template`) is the deterministic template, no job, no helper. The
   * adapter's session-end reflection never passes `auto`: a shutdown must not
   * buy a model-backed helper that keeps looping after the agent is gone.
   */
  async reflect(
    topic?: string,
    opts?: { helper?: "auto" | "existing" | "never" },
  ): Promise<PlatformMemoryResult> {
    const mode = opts?.helper ?? "auto";
    const flag = mode === "never" ? "--template" : mode === "existing" ? "--no-spawn" : "";
    const cmd = ["reflect", flag, topic ?? ""].filter(Boolean).join(" ");
    const perceptions = await this.client.command(cmd);
    const text = extractText(perceptions);
    const idMatch = text.match(/Note #(\d+)/);
    return {
      success: text.includes("Reflection Created"),
      text,
      noteId: idMatch?.[1] ? Number.parseInt(idMatch[1], 10) : undefined,
    };
  }

  async reflectFailure(description: string): Promise<PlatformMemoryResult> {
    const perceptions = await this.client.command(`reflect failure ${description}`);
    const text = extractText(perceptions);
    const idMatch = text.match(/Note #(\d+)/);
    return {
      success: text.includes("Failure Reflection Created"),
      text,
      noteId: idMatch?.[1] ? Number.parseInt(idMatch[1], 10) : undefined,
    };
  }

  async share(content: string, poolName: string, importance = 5): Promise<PlatformMemoryResult> {
    const perceptions = await this.client.command(
      `pool ${poolName} add ${content} importance ${importance}`,
    );
    const text = extractText(perceptions);
    return { success: /Added note #\d+/.test(text), text };
  }

  async importShared(poolName: string, query: string): Promise<PlatformMemoryResult> {
    const perceptions = await this.client.command(`pool ${poolName} recall ${query}`);
    const text = extractText(perceptions);
    const result = readMemoryResult(perceptions, "pool-recall");
    return {
      success: result?.success ?? !text.includes("not found"),
      text,
      results: result ? (result.notes ?? []) : this.parseRecallResults(text),
    };
  }

  /**
   * Fetch the agent's active-quest progress via `quest status`. `active` is
   * false when there is no active objective, so the continuation prompt can
   * surface progress in-context (and skip it otherwise) instead of the agent
   * re-running `quest status` to re-discover what it already knows.
   */
  async questStatus(): Promise<{ text: string; active: boolean }> {
    const perceptions = await this.client.command("quest status");
    const text = extractText(perceptions);
    const active = text.trim().length > 0 && !/no active objective/i.test(text);
    return { text, active };
  }

  async archiveContext(
    messages: unknown[],
    summary: string,
    compactionPool?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.durable.archive(messages, summary, signal);
    signal?.throwIfAborted();
    if (compactionPool) {
      try {
        const shared = await this.share(
          `[compaction] ${summary.slice(0, 2000)}`,
          compactionPool,
          3,
        );
        if (!shared.success) logger.warn("memory", "Optional compaction summary sharing failed");
      } catch (error) {
        logger.warn("memory", "Optional compaction summary sharing failed", {
          error: getErrorMessage(error),
        });
      }
    }
  }

  async journalMessage(message: unknown, signal?: AbortSignal): Promise<void> {
    await this.durable.journal(message, signal);
  }

  async saveCheckpoint(data: Record<string, unknown>): Promise<PlatformMemoryResult> {
    await this.durable.save(data);
    return { success: true, text: "Durable resident checkpoint saved" };
  }

  async getCheckpoint(): Promise<Record<string, unknown> | null> {
    return (await this.durable.checkpoint())?.data ?? null;
  }

  /**
   * Persist the agent's live focus to core memory so its current task survives
   * a focus timeout AND a restart. Written on change (not at shutdown), so even
   * a crash preserves it. `null` clears the key so a completed/abandoned focus
   * isn't resurrected on the next boot.
   */
  async saveFocus(
    focus: { description: string; startedAt: number } | null,
  ): Promise<PlatformMemoryResult> {
    const cmd = focus ? `memory set focus ${JSON.stringify(focus)}` : "memory delete focus";
    const perceptions = await this.client.command(cmd);
    const text = extractText(perceptions);
    return {
      success:
        readMemoryResult(perceptions, focus ? "core-set" : "core-delete")?.success ??
        /Memory "focus" (set|deleted)\./.test(text),
      text,
    };
  }

  async getFocus(): Promise<{ description: string; startedAt: number } | null> {
    const perceptions = await this.client.command("memory get focus");
    const value = coreValue(perceptions);
    if (value === undefined) return null;
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed.description === "string") {
        return { description: parsed.description, startedAt: Number(parsed.startedAt) || 0 };
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Agent-set pace from core memory (`pace` preferred; `tick_rate` is the
   *  legacy alias). Returns null when unset or unparseable. */
  async getPace(): Promise<"fast" | "normal" | "slow" | null> {
    for (const key of ["pace", "tick_rate"]) {
      const perceptions = await this.client.command(`memory get ${key}`);
      const raw = coreValue(perceptions)?.trim().toLowerCase();
      if (!raw) continue;
      if (raw.includes("fast")) return "fast";
      if (raw.includes("slow")) return "slow";
      if (raw.includes("normal")) return "normal";
    }
    return null;
  }

  async orient(): Promise<PlatformMemoryResult> {
    const perceptions = await this.client.command("orient");
    const text = extractText(perceptions);
    return { success: true, text };
  }

  async workInbox(): Promise<PlatformMemoryResult> {
    const perceptions = await this.client.command("work");
    const text = extractText(perceptions);
    return { success: true, text };
  }

  async getNoveltySuggestions(): Promise<string[]> {
    const perceptions = await this.client.command("novelty suggest");
    const text = extractText(perceptions);
    const suggestions: string[] = [];
    for (const line of text.split("\n")) {
      const match = line.match(/^\s*\d+\.\s*(.+)/);
      if (match?.[1]) suggestions.push(match[1].trim());
    }
    return suggestions;
  }

  async storeSkill(
    name: string,
    description: string,
    actions: string,
  ): Promise<PlatformMemoryResult> {
    const perceptions = await this.client.command(
      `skill store ${name} | ${description} | ${actions}`,
    );
    const text = extractText(perceptions);
    const idMatch = text.match(/Skill #(\d+)/);
    return {
      success: text.includes("stored"),
      text,
      noteId: idMatch?.[1] ? Number.parseInt(idMatch[1], 10) : undefined,
    };
  }

  async searchSkills(query: string): Promise<PlatformMemoryResult> {
    const perceptions = await this.client.command(`skill search ${query}`);
    const text = extractText(perceptions);
    const result = readMemoryResult(perceptions, "skill-search");
    return {
      success: result?.success ?? true,
      text,
      results: result ? (result.notes ?? []) : this.parseSkillResults(text),
    };
  }

  private parseRecallResults(text: string): PlatformNoteResult[] {
    const results: PlatformNoteResult[] = [];
    for (const line of text.split("\n")) {
      const match =
        line.match(
          /\s*#(\d+)\s+\[score=([\d.]+)\s+imp=(\d+)\s+([^\]]+)\](?:\s+\([^)]*\))?:\s*(.+)/,
        ) ?? line.match(/^\s*#(\d+)\s+([\d.]+)\s+!(\d+)\s+(today|\d+d ago)\s+(.+)$/);
      if (match) {
        results.push({
          id: match[1] ?? "",
          score: Number.parseFloat(match[2] ?? "0"),
          importance: Number.parseInt(match[3] ?? "0", 10),
          age: match[4] ?? "",
          content: match[5]?.trim() ?? "",
          noteType: "",
        });
      }
    }
    return results;
  }

  private parseSkillResults(text: string): PlatformNoteResult[] {
    const results: PlatformNoteResult[] = [];
    for (const line of text.split("\n")) {
      const match = line.match(/\s*#(\d+)\s+\[imp=(\d+)\s+score=([\d.]+)\]:\s*(.+)/);
      if (match) {
        results.push({
          id: match[1] ?? "",
          importance: Number.parseInt(match[2] ?? "0", 10),
          score: Number.parseFloat(match[3] ?? "0"),
          content: match[4]?.trim() ?? "",
          noteType: "skill",
        });
      }
    }
    return results;
  }
}
