// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { memoryAccess } from "../../memory/access";
import {
  assistanceAdoptionUrl,
  findAdoptionNotes,
  findDurableTwin,
  findLegacyNotesForRecord,
  recordDurableTwin,
} from "../../memory/legacy-bridge";
import { residentMemoryOperation } from "../../memory/resident-service";
import { bold, category, dim, id as fmtId, header, separator, status } from "../../net/ansi";
import type { MarinaDB, NoteRow } from "../../persistence/database";
import type { MemoryAssistanceJob, MemoryAssistancePage } from "../../sdk/memory-assistance";
import { memoryOperationError } from "../../sdk/memory-operations";
import type { MemoryReceipt, MemoryRecord } from "../../sdk/memory-types";
import type { CommandDef, EngineEvent, Entity, RoomContext } from "../../types";
import { requiresPersistence } from "./command-messages";

/** Role name of the resident helper `reflect` delegates to. */
export const REFLECTOR_ROLE = "memory-reflector";
const REFLECT_JOB_MAX_OPERATIONS = 32;
const REFLECT_JOB_TIMEOUT_MS = 10 * 60 * 1000;
const ASSISTANCE_TASK_LIMIT = 8192;
const REFLECTOR_HINT =
  "No memory-reflector helper is available, so this is the deterministic template. " +
  "Spawn one — `agent spawn Reflector model marina/default role memory-reflector budget 40` — " +
  "and `reflect <topic>` will file a cited reflection job instead.";

/** Extract common themes from a set of notes via word frequency analysis */
function extractThemes(notes: NoteRow[]): string[] {
  const wordCounts = new Map<string, number>();
  const stopWords = new Set([
    "the",
    "a",
    "an",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "shall",
    "can",
    "need",
    "dare",
    "ought",
    "used",
    "to",
    "of",
    "in",
    "for",
    "on",
    "with",
    "at",
    "by",
    "from",
    "as",
    "into",
    "through",
    "during",
    "before",
    "after",
    "above",
    "below",
    "between",
    "out",
    "off",
    "over",
    "under",
    "again",
    "further",
    "then",
    "once",
    "here",
    "there",
    "when",
    "where",
    "why",
    "how",
    "all",
    "both",
    "each",
    "few",
    "more",
    "most",
    "other",
    "some",
    "such",
    "no",
    "nor",
    "not",
    "only",
    "own",
    "same",
    "so",
    "than",
    "too",
    "very",
    "just",
    "because",
    "but",
    "and",
    "or",
    "if",
    "while",
    "that",
    "this",
    "it",
    "i",
    "you",
    "he",
    "she",
    "we",
    "they",
    "me",
    "him",
    "her",
    "us",
    "them",
    "my",
    "your",
    "his",
    "its",
    "our",
    "their",
    "what",
    "which",
    "who",
  ]);

  for (const note of notes) {
    const words = note.content
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/);
    const seen = new Set<string>();
    for (const word of words) {
      if (word.length < 3 || stopWords.has(word)) continue;
      if (!seen.has(word)) {
        seen.add(word);
        wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
      }
    }
  }

  // Themes are words appearing in 2+ notes
  return [...wordCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);
}

/** Detect contradictions by checking for existing contradicts links */
function findContradictions(db: MarinaDB, notes: NoteRow[]): string[] {
  const contradictions: string[] = [];
  for (const note of notes) {
    const links = db.getNoteLinks(note.id);
    for (const link of links) {
      if (link.relationship === "contradicts") {
        const otherId = link.source_id === note.id ? link.target_id : link.source_id;
        const otherNote = notes.find((n) => n.id === otherId);
        if (otherNote) {
          contradictions.push(`#${note.id} contradicts #${otherNote.id}`);
        }
      }
    }
  }
  return contradictions;
}

function formatMemoryFailure(error: unknown): string {
  const result = memoryOperationError(error);
  return result.ok ? "Memory service failed" : `${result.error.message} (${result.error.code})`;
}

/** Minimal live-agent shape; `AgentStatus` satisfies it structurally. */
export interface ReflectAgentView {
  name: string;
  role: string;
  state: string;
}

export function reflectCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  db?: MarinaDB;
  logEvent?: (event: EngineEvent) => void;
  /**
   * Optional live roster (the agent runtime's `list()`). When absent, helper
   * discovery falls back to persisted agent configs bound to `memory-reflector`,
   * and `reflect via <helper>` always works for an explicitly named resident.
   */
  listAgents?: () => ReflectAgentView[];
}): CommandDef {
  return {
    name: "reflect",
    aliases: [],
    help: "Reflect on your notes. Usage: reflect [topic] (files a cited job with a memory-reflector when one is available, else the deterministic template) | reflect via <helper> [topic] | reflect --template [topic] | reflect adopt <job> | reflect jobs | reflect failure <description>",
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;
      if (!deps.db) {
        ctx.send(input.entity, requiresPersistence("reflect"));
        return;
      }
      const db = deps.db;
      const access = memoryAccess(db, entity);
      const eligibleSource = (note: NoteRow) =>
        access.read(note) &&
        note.verification_status !== "superseded" &&
        note.tier !== "process" &&
        note.tier !== "reflection";
      const args = input.args?.trim() ?? "";
      const tokens = args.split(/\s+/).filter(Boolean);
      const sub = tokens[0]?.toLowerCase();

      const createReflectionNote = (content: string, importance: number): number => {
        const reflectionId = db.createNote(entity.name, content, input.room, {
          importance,
          noteType: "episode",
          tier: "reflection",
        });
        deps.logEvent?.({
          type: "note_created",
          entity: input.entity,
          noteId: reflectionId,
          authorName: entity.name,
          content,
          importance,
          noteType: "episode",
          roomId: input.room,
          timestamp: Date.now(),
        });
        return reflectionId;
      };
      const linkPartOf = (sourceId: number, reflectionId: number): boolean => {
        try {
          db.createNoteLink(sourceId, reflectionId, "part_of");
          deps.logEvent?.({
            type: "note_link_created",
            entity: input.entity,
            sourceId,
            targetId: reflectionId,
            relationship: "part_of",
            timestamp: Date.now(),
          });
          return true;
        } catch {
          return false; // duplicate link
        }
      };
      const gatherSources = (topic: string | undefined): NoteRow[] =>
        topic
          ? db
              .recallNotes(entity.name, topic, {
                weightImportance: 0.4,
                weightRecency: 0.3,
                weightRelevance: 0.3,
              })
              .filter(eligibleSource)
              .slice(0, 10)
          : db
              .getNotesByEntity(entity.name, 50)
              .filter(eligibleSource)
              .filter((n) => n.importance >= 6)
              .slice(0, 10);

      // ── reflect failure <description> ────────────────────────────────────
      if (sub === "failure") {
        const description = tokens.slice(1).join(" ");
        if (!description) {
          ctx.send(input.entity, "Usage: reflect failure <what happened>");
          return;
        }

        // Search for related context
        const related = db
          .recallNotes(entity.name, description, {
            weightImportance: 0.3,
            weightRecency: 0.5,
            weightRelevance: 0.2,
          })
          .filter(eligibleSource)
          .slice(0, 5);

        // Build failure analysis
        const contextParts = related.map((n) => `[${fmtId(n.id)}] ${n.content.slice(0, 60)}`);
        const contextStr =
          contextParts.length > 0 ? ` Related context: ${contextParts.join("; ")}` : "";
        const content = `[Failure Analysis] ${description}.${contextStr}`;

        const reflectionId = createReflectionNote(content, 8);
        for (const note of related) linkPartOf(note.id, reflectionId);

        const lines = [
          header("Failure Reflection Created"),
          separator(),
          `Note ${fmtId(reflectionId)} ${dim("(episode, importance=8)")}`,
          `Failure: ${description}`,
          related.length > 0
            ? `Related notes: ${related.map((n) => fmtId(n.id)).join(", ")}`
            : dim("No related notes found."),
        ];
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      // ── deterministic template synthesis (legacy behaviour) ──────────────
      const runTemplate = (topic: string | undefined, hint: boolean) => {
        const tail = hint ? `\n${dim(REFLECTOR_HINT)}` : "";
        const sourceNotes = gatherSources(topic);

        if (sourceNotes.length < 2) {
          // Not enough to synthesize — show diagnostic instead
          const allNotes = db.getNotesByEntity(entity.name, 100).filter(eligibleSource);
          const nonEpisode = allNotes.filter((n) => n.note_type !== "episode");
          if (nonEpisode.length < 2) {
            ctx.send(input.entity, `Not enough notes to reflect on. Take more notes first.${tail}`);
            return;
          }
          // Find what topics have accumulated
          const topics = extractThemes(nonEpisode.slice(0, 30));
          const fading = allNotes.filter((n) => n.importance <= 2);
          const lines = [
            header("Reflection Diagnostic"),
            separator(),
            `  Notes: ${bold(String(allNotes.length))} ${dim(`(${nonEpisode.length} unconsolidated)`)}`,
          ];
          if (fading.length > 0) {
            lines.push(`  Fading: ${dim(String(fading.length))}`);
          }
          if (topics.length > 0) {
            lines.push(`  Topics: ${topics.map((t) => category(t)).join(", ")}`);
            lines.push("", dim("Try: reflect <topic>"));
          } else {
            lines.push("", "Need at least 2 high-importance notes to synthesize.");
          }
          ctx.send(input.entity, lines.join("\n") + tail);
          return;
        }

        // Synthesize: extract themes, find contradictions, build insight
        const themes = extractThemes(sourceNotes);
        const contradictions = findContradictions(db, sourceNotes);

        // Build structured synthesis content
        const parts: string[] = [];
        const prefix = topic ? `Synthesis on "${topic}"` : "Synthesis";
        parts.push(prefix);

        if (themes.length > 0) {
          parts.push(`Themes: ${themes.join(", ")}`);
        }

        // Condensed insight: group notes by type
        const byType = new Map<string, NoteRow[]>();
        for (const n of sourceNotes) {
          const t = n.note_type;
          if (!byType.has(t)) byType.set(t, []);
          byType.get(t)!.push(n);
        }
        const typeSummaries: string[] = [];
        for (const [type, notes] of byType) {
          typeSummaries.push(`${notes.length} ${type}(s)`);
        }
        parts.push(`Sources: ${typeSummaries.join(", ")} (${sourceNotes.length} total)`);

        // Key points from highest-importance notes
        const sorted = [...sourceNotes].sort((a, b) => b.importance - a.importance);
        const keyPoints = sorted.slice(0, 3).map((n) => n.content.slice(0, 80));
        parts.push(`Key points: ${keyPoints.join("; ")}`);

        if (contradictions.length > 0) {
          parts.push(`Contradictions: ${contradictions.join("; ")}`);
        }

        const content = parts.join(". ");
        const maxImportance = Math.max(...sourceNotes.map((n) => n.importance));
        const reflectionImportance = Math.min(maxImportance + 1, 10);

        const reflectionId = createReflectionNote(content, reflectionImportance);
        for (const source of sourceNotes) linkPartOf(source.id, reflectionId);

        const sourceIds = sourceNotes.map((n) => fmtId(n.id)).join(", ");
        const lines = [
          header("Reflection Created"),
          separator(),
          `Note ${fmtId(reflectionId)} ${dim(`(episode, importance=${reflectionImportance})`)}`,
          `Sources: ${sourceIds}`,
          themes.length > 0 ? `Themes: ${themes.map((t) => category(t)).join(", ")}` : "",
          contradictions.length > 0
            ? `${status("contradiction", "fail")} Found: ${bold(String(contradictions.length))}`
            : "",
          `Insight: ${dim(content.slice(0, 150))}${content.length > 150 ? dim("...") : ""}`,
        ].filter(Boolean);
        ctx.send(input.entity, lines.join("\n") + tail);
      };

      if (sub === "template" || sub === "--template") {
        runTemplate(tokens.slice(1).join(" ") || undefined, false);
        return;
      }

      // ── helper discovery ─────────────────────────────────────────────────
      const usable = (name: string) => name !== entity.name && !!db.getUserByName(name);
      const discoverHelper = (): string | undefined => {
        const live = (deps.listAgents?.() ?? []).filter(
          (agent) =>
            agent.role === REFLECTOR_ROLE &&
            !["stopped", "stopping", "error"].includes(agent.state) &&
            usable(agent.name),
        );
        if (live[0]) return live[0].name;
        // Persisted configs: a bound reflector that may be paused between
        // cycles. The job waits durably for it; discovery never invents one.
        return db
          .getAllAgentConfigs()
          .filter((config) => config.role === REFLECTOR_ROLE && usable(config.name))
          .map((config) => config.name)[0];
      };

      // ── reflect [via <helper>] [topic] → assist_create role reflector ──────
      const requestReflection = async (helperName: string, topic: string | undefined) => {
        const worker = db.getUserByName(helperName);
        if (!worker) {
          ctx.send(
            input.entity,
            `${helperName} has no durable world account yet — the helper must join Marina under its own identity before it can reflect for you.`,
          );
          return;
        }
        if (worker.name === entity.name) {
          ctx.send(
            input.entity,
            "Reflection needs another participant; you cannot witness yourself.",
          );
          return;
        }
        // Recent legacy notes travel as *text context* only — the helper reads
        // durable records/sources through assist_read and cites what it read.
        const notes = gatherSources(topic);
        const context = notes.map((n) => {
          const twin = findDurableTwin(db, n.id);
          const ref = twin ? ` (durable record ${twin.recordId})` : "";
          return `- legacy note #${n.id}${ref}: ${n.content.slice(0, 160)}`;
        });
        const task = [
          `Reflect on ${topic ?? "recent work"}: propose one reusable lesson with citations.`,
          context.length > 0
            ? "Requester's recent notes, for orientation only (not authority — cite only records or sources you read through assist_read):"
            : "",
          ...context,
        ]
          .filter(Boolean)
          .join("\n")
          .slice(0, ASSISTANCE_TASK_LIMIT);
        try {
          const reply = await residentMemoryOperation(db, entity.name, {
            operation: "assist_create",
            input: {
              worker_id: worker.id,
              role: "reflector",
              task,
              max_operations: REFLECT_JOB_MAX_OPERATIONS,
              timeout_ms: REFLECT_JOB_TIMEOUT_MS,
            },
          });
          // assist_create returns only the receipt; the durable job carries the rest.
          const job = reply.result as Pick<MemoryAssistanceJob, "id">;
          const lines = [
            header("Reflection Requested"),
            separator(),
            `Job ${bold(job.id)} → ${helperName} ${dim("(reflector)")}`,
            `Topic: ${topic ?? "recent work"}`,
            `Context: ${notes.length} recent note(s) passed as text${notes.some((n) => findDurableTwin(db, n.id)) ? ", durable twins referenced" : ""}`,
            dim(
              `Budget ${REFLECT_JOB_MAX_OPERATIONS} reads · ${Math.round(REFLECT_JOB_TIMEOUT_MS / 60000)} min deadline`,
            ),
            "",
            `Check: ${bold("reflect jobs")} · adopt when answered: ${bold(`reflect adopt ${job.id}`)}`,
          ];
          ctx.send(input.entity, lines.join("\n"));
        } catch (error) {
          const result = memoryOperationError(error);
          if (!result.ok && result.error.code === "world_identity_required") {
            ctx.send(
              input.entity,
              dim(
                "Reflecting via a helper needs your durable world account; using the template instead.",
              ),
            );
            runTemplate(topic, false);
            return;
          }
          ctx.send(
            input.entity,
            `Could not file the reflection request: ${formatMemoryFailure(error)}`,
          );
        }
      };

      // ── reflect jobs ─────────────────────────────────────────────────────
      const listJobs = async () => {
        const me = db.getUserByName(entity.name);
        try {
          const reply = await residentMemoryOperation(db, entity.name, {
            operation: "assist_jobs",
            input: { limit: 100 },
          });
          const page = reply.result as MemoryAssistancePage;
          const jobs = page.jobs.filter(
            (job) => job.role === "reflector" && (!me || job.requester_id === me.id),
          );
          if (jobs.length === 0) {
            ctx.send(input.entity, "No reflector jobs on file. Try: reflect <topic>");
            return;
          }
          const lines = [header("Reflector Jobs"), separator()];
          for (const job of jobs) {
            const worker = db.getUser(job.worker_id)?.name ?? job.worker_id;
            const state =
              job.state === "answered"
                ? status(job.state, "done")
                : job.work_open
                  ? status(job.state, "info")
                  : status(`${job.state} · closed`, "warn");
            const action =
              job.state === "answered"
                ? findAdoptionNotes(db, entity.name, job.id).length > 0
                  ? dim("adopted")
                  : dim(`reflect adopt ${job.id}`)
                : "";
            lines.push(
              `  ${bold(job.id)} ${state} → ${worker} ${dim(new Date(job.created_at).toISOString())} ${action}`.trimEnd(),
            );
          }
          ctx.send(input.entity, lines.join("\n"));
        } catch (error) {
          ctx.send(input.entity, `Could not list reflector jobs: ${formatMemoryFailure(error)}`);
        }
      };

      // ── reflect adopt <job> ──────────────────────────────────────────────
      const adopt = async (jobId: string | undefined) => {
        if (!jobId) {
          ctx.send(input.entity, "Usage: reflect adopt <job-id>");
          return;
        }
        // Idempotent: the adoption marker on the legacy note is the ledger.
        const previous = findAdoptionNotes(db, entity.name, jobId)[0];
        if (previous) {
          const twin = findDurableTwin(db, previous.id);
          ctx.send(
            input.entity,
            `Job ${jobId} was already adopted as note ${fmtId(previous.id)}${twin ? ` · durable record ${twin.recordId}` : ""}.`,
          );
          return;
        }
        let job: MemoryAssistanceJob;
        try {
          job = (
            await residentMemoryOperation(db, entity.name, { operation: "assist_get", id: jobId })
          ).result as MemoryAssistanceJob;
        } catch (error) {
          ctx.send(input.entity, `Could not read job ${jobId}: ${formatMemoryFailure(error)}`);
          return;
        }
        if (job.state !== "answered" || !job.result || job.result.status !== "answered") {
          const detail =
            job.state === "abstained" && job.result?.status === "abstained"
              ? ` — ${job.result.reason}`
              : job.work_open
                ? " (work still open)"
                : "";
          ctx.send(input.entity, `Job ${jobId} is ${job.state}${detail}; nothing to adopt yet.`);
          return;
        }
        const answer =
          typeof job.result.answer === "string"
            ? job.result.answer
            : JSON.stringify(job.result.answer);
        if (!answer.trim()) {
          ctx.send(input.entity, `Job ${jobId} answered with empty content; nothing to adopt.`);
          return;
        }

        // Citations become provenance only where they are readable in the
        // caller's own space: record citations pin dependencies, source
        // citations attach as source_ids. Unreadable ones are dropped, not guessed.
        const sourceIds: string[] = [];
        const dependsOn: string[] = [];
        const dependencyVersions: Record<string, number> = {};
        for (const citation of job.result.citations) {
          if (citation.space_id !== job.space_id) continue;
          try {
            if (citation.kind === "record") {
              if (dependsOn.includes(citation.id)) continue;
              const record = (
                await residentMemoryOperation(db, entity.name, {
                  operation: "get",
                  id: citation.id,
                  space_id: job.space_id,
                })
              ).result as MemoryRecord;
              dependsOn.push(citation.id);
              dependencyVersions[citation.id] = record.version;
            } else {
              if (sourceIds.includes(citation.id)) continue;
              await residentMemoryOperation(db, entity.name, {
                operation: "source_range",
                id: citation.id,
                space_id: job.space_id,
                input: { start: citation.start, end: citation.end },
              });
              sourceIds.push(citation.id);
            }
          } catch {
            // Not readable by the caller — omit from provenance.
          }
        }

        let receipt: MemoryReceipt;
        let spaceId: string | undefined;
        try {
          const remembered = await residentMemoryOperation(db, entity.name, {
            operation: "remember",
            space_id: job.space_id,
            input: {
              content: answer,
              type: "episode",
              tier: "reflection",
              importance: 8,
              metadata: {
                adopted_from_job: jobId,
                helper_id: job.worker_id,
                proposal_record_id: job.result_record_id,
              },
              ...(sourceIds.length > 0 ? { source_ids: sourceIds } : {}),
              ...(dependsOn.length > 0
                ? { depends_on: dependsOn, dependency_versions: dependencyVersions }
                : {}),
            },
            key: `reflect-adopt-${jobId}`,
          });
          receipt = remembered.result as MemoryReceipt;
          spaceId = remembered.space_id ?? job.space_id;
        } catch (error) {
          ctx.send(
            input.entity,
            `Could not write the adopted reflection to durable memory: ${formatMemoryFailure(error)}`,
          );
          return;
        }

        // Legacy side: a reflection-tier episode, part_of-linked to the legacy
        // twins of cited records, twinned to the durable record just written,
        // and stamped with the adoption marker for idempotency.
        const reflectionId = createReflectionNote(answer, 8);
        const linked: number[] = [];
        for (const recordId of dependsOn) {
          for (const note of findLegacyNotesForRecord(db, entity.name, recordId, {
            currentOnly: true,
          })) {
            if (note.id !== reflectionId && linkPartOf(note.id, reflectionId)) linked.push(note.id);
          }
        }
        recordDurableTwin(
          db,
          reflectionId,
          { recordId: receipt.id, version: receipt.version ?? 1, spaceId },
          entity.name,
        );
        const helperName = db.getUser(job.worker_id)?.name ?? job.worker_id;
        db.addNoteSource(reflectionId, {
          url: assistanceAdoptionUrl(jobId),
          sourceType: "artifact",
          title: "adopted reflector proposal",
          sourceEntity: helperName,
          capturedBy: entity.name,
          // Provenance of a proposal, not evidence for the lesson: keep it
          // below every trust/corroboration threshold like the twin row.
          credibility: 0,
          metadata: {
            kind: "assistance-adoption",
            job_id: jobId,
            worker_id: job.worker_id,
            proposal_record_id: job.result_record_id,
            citations: job.result.citations.length,
          },
        });

        const lines = [
          header("Reflection Adopted"),
          separator(),
          `Note ${fmtId(reflectionId)} ${dim("(episode, reflection tier, importance=8)")} · durable record ${bold(receipt.id)}`,
          `Proposal by ${helperName} · job ${jobId} · ${job.result.citations.length} citation(s)`,
          linked.length > 0
            ? `Linked legacy notes (part_of): ${linked.map((id) => fmtId(id)).join(", ")}`
            : dim("No cited record has a legacy twin to link."),
          `Lesson: ${dim(answer.slice(0, 150))}${answer.length > 150 ? dim("...") : ""}`,
        ];
        ctx.send(input.entity, lines.join("\n"));
      };

      switch (sub) {
        case "adopt":
          return adopt(tokens[1]);
        case "jobs":
          return listJobs();
        case "via": {
          const helper = tokens[1];
          if (!helper) {
            ctx.send(input.entity, "Usage: reflect via <helper> [topic]");
            return;
          }
          return requestReflection(helper, tokens.slice(2).join(" ") || undefined);
        }
        default: {
          const topic = args || undefined;
          const helper = discoverHelper();
          if (helper) return requestReflection(helper, topic);
          runTemplate(topic, true);
        }
      }
    },
  };
}
