import type { MarinaClient } from "../sdk/client";
import type { Perception } from "../types";

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
    .join("\n");
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PlatformMemoryResult {
  success: boolean;
  text: string;
  noteId?: number;
  results?: PlatformNoteResult[];
}

export interface PlatformNoteResult {
  id: string;
  content: string;
  importance: number;
  noteType: string;
  score?: number;
  age?: string;
}

// ─── Platform Memory Backend ────────────────────────────────────────────────

export class PlatformMemoryBackend {
  private client: MarinaClient;

  constructor(client: MarinaClient) {
    this.client = client;
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
      success: !text.includes("Error"),
      text,
      noteId: idMatch?.[1] ? Number.parseInt(idMatch[1], 10) : undefined,
    };
  }

  async search(
    query: string,
    opts?: { noteType?: string; mode?: "recent" | "important" },
  ): Promise<PlatformMemoryResult> {
    let cmd = `recall ${query}`;
    if (opts?.noteType) cmd += ` type ${opts.noteType}`;
    if (opts?.mode === "recent") cmd += " recent";
    if (opts?.mode === "important") cmd += " important";

    const perceptions = await this.client.command(cmd);
    const text = extractText(perceptions);
    const results = this.parseRecallResults(text);
    return { success: true, text, results };
  }

  async update(noteId: string, newContent: string): Promise<PlatformMemoryResult> {
    const perceptions = await this.client.command(`note correct ${noteId} ${newContent}`);
    const text = extractText(perceptions);
    return { success: !text.includes("not found"), text };
  }

  async remove(noteId: string): Promise<PlatformMemoryResult> {
    const perceptions = await this.client.command(`note delete ${noteId}`);
    const text = extractText(perceptions);
    return { success: text.includes("deleted"), text };
  }

  async reflect(topic?: string): Promise<PlatformMemoryResult> {
    const cmd = topic ? `reflect ${topic}` : "reflect";
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
    return { success: !text.includes("Error"), text };
  }

  async importShared(poolName: string, query: string): Promise<PlatformMemoryResult> {
    const perceptions = await this.client.command(`pool ${poolName} recall ${query}`);
    const text = extractText(perceptions);
    const results = this.parseRecallResults(text);
    return { success: true, text, results };
  }

  async saveCheckpoint(data: Record<string, unknown>): Promise<PlatformMemoryResult> {
    const json = JSON.stringify(data);
    const perceptions = await this.client.command(`memory set checkpoint ${json}`);
    const text = extractText(perceptions);
    return { success: true, text };
  }

  async getCheckpoint(): Promise<Record<string, unknown> | null> {
    const perceptions = await this.client.command("memory get checkpoint");
    const text = extractText(perceptions);
    if (text.includes("not found") || text.includes("No entry")) return null;
    try {
      const valueMatch = text.match(/\(v\d+\):\s*(.+)/s);
      if (valueMatch?.[1]) return JSON.parse(valueMatch[1].trim());
      return JSON.parse(text.trim());
    } catch {
      return null;
    }
  }

  async orient(): Promise<PlatformMemoryResult> {
    const perceptions = await this.client.command("orient");
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
    const results = this.parseSkillResults(text);
    return { success: true, text, results };
  }

  private parseRecallResults(text: string): PlatformNoteResult[] {
    const results: PlatformNoteResult[] = [];
    for (const line of text.split("\n")) {
      const match = line.match(/\s*#(\d+)\s+\[score=([\d.]+)\s+imp=(\d+)\s+([^\]]+)\]:\s*(.+)/);
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
