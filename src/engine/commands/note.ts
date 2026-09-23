// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { memoryAccess } from "../../memory/access";
import {
  bridgeLegacyConsolidationQuietly,
  bridgeLegacyLinkQuietly,
  bridgeLegacyNoteQuietly,
  bridgeLegacyResolutionQuietly,
  bridgeLegacyRevisionQuietly,
  bridgeLegacySourceQuietly,
  bridgeLegacyUnlinkQuietly,
  bridgeLegacyVerificationQuietly,
  findDurableTwin,
  retireDurableTwinQuietly,
} from "../../memory/legacy-bridge";
import {
  bold,
  category,
  dim,
  id as fmtId,
  header,
  importance,
  separator,
  status,
} from "../../net/ansi";
import type { MarinaDB, NoteRow } from "../../persistence/database";
import type { CommandDef, EngineEvent, Entity, RoomContext } from "../../types";
import { extractModifiers, int as parseIntSafe } from "../parse-input";
import { requiresPersistence } from "./command-messages";

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "all",
  "can",
  "had",
  "her",
  "was",
  "one",
  "our",
  "out",
  "has",
  "have",
  "been",
  "were",
  "they",
  "this",
  "that",
  "with",
  "from",
  "will",
  "would",
  "there",
  "their",
  "what",
  "about",
  "which",
  "when",
  "make",
  "like",
  "been",
  "could",
  "into",
  "than",
  "other",
  "some",
  "very",
  "just",
  "also",
  "more",
  "should",
  "each",
  "being",
  "does",
  "note",
  "notes",
  "used",
  "using",
]);

/** Extract topic keywords from a set of notes (words appearing in 2+ notes) */
function extractTopics(notes: NoteRow[]): string[] {
  const counts = new Map<string, number>();
  for (const n of notes) {
    const words = n.content
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/);
    const seen = new Set<string>();
    for (const w of words) {
      if (w.length < 4 || STOP_WORDS.has(w) || seen.has(w)) continue;
      seen.add(w);
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w]) => w);
}

const VALID_NOTE_TYPES = new Set([
  "observation",
  "fact",
  "decision",
  "inference",
  "skill",
  "episode",
  "principle",
]);

const VALID_RELATIONSHIPS = new Set([
  "supports",
  "contradicts",
  "caused_by",
  "related_to",
  "part_of",
  "supersedes",
  "derived_from",
]);

function parseNoteText(input: string): {
  content: string;
  importance?: number;
  noteType?: string;
} {
  let importance: number | undefined;
  let noteType: string | undefined;

  // Extract trailing "type <word>" and "importance N" modifiers
  const { text: afterModifiers, modifiers } = extractModifiers(input, ["type", "importance"]);
  let text = afterModifiers;

  if (modifiers.type && VALID_NOTE_TYPES.has(modifiers.type)) {
    noteType = modifiers.type;
  }
  const impVal = parseIntSafe(modifiers.importance, { min: 1, max: 10 });
  if (impVal !== null) {
    importance = impVal;
  }

  // Legacy: !N (importance 1-10) — backward compatible
  if (importance === undefined) {
    const impMatch = text.match(/\s+!(\d{1,2})(?:\s|$)/);
    if (impMatch) {
      const val = Number.parseInt(impMatch[1]!, 10);
      if (val >= 1 && val <= 10) {
        importance = val;
        text = text.replace(impMatch[0], " ").trim();
      }
    }
  }

  // Legacy: #type — backward compatible
  if (noteType === undefined) {
    const typeMatch = text.match(/\s+#(\w+)(?:\s|$)/);
    if (typeMatch && VALID_NOTE_TYPES.has(typeMatch[1]!)) {
      noteType = typeMatch[1];
      text = text.replace(typeMatch[0], " ").trim();
    }
  }

  return { content: text, importance, noteType };
}

export function noteCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  db?: MarinaDB;
  logEvent?: (event: EngineEvent) => void;
}): CommandDef {
  return {
    name: "note",
    aliases: [],
    help: "Evidence-aware memory. Usage: note <text> | note claim <text> [confidence 0..1] [source URL] | note explain|verify|source|contradictions|consolidate ...",
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;
      if (!deps.db) {
        ctx.send(input.entity, requiresPersistence("notes"));
        return;
      }
      const db = deps.db;
      const access = memoryAccess(db, entity);
      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase();

      if (!sub) {
        ctx.send(
          input.entity,
          "Usage: note <text> [importance N] [type T] | note list | note room | note search <query> | note delete <id> | note link <id1> <id2> <rel> | note unlink <id1> <id2> <rel> | note correct <id> <text> | note trace <id> | note graph | note evolve <id> | note types\n" +
            "(see also: `memory graph <subject>` follows asserted relationships between durable records; `note graph` summarises your legacy notes and links. Every note verb mirrors to your durable twin automatically.)",
        );
        return;
      }

      switch (sub) {
        case "claim": {
          const { text, modifiers } = extractModifiers(tokens.slice(1).join(" "), [
            "confidence",
            "source",
            "observed",
          ]);
          if (!text) {
            ctx.send(
              input.entity,
              "Usage: note claim <text> [confidence 0..1] [source URL] [observed YYYY-MM-DD]\n" +
                "(see also: `memory claim <subject> <predicate> <JSON scalar>` asserts a typed durable claim; `note claim` records a free-text legacy claim and mirrors it to a durable twin.)",
            );
            return;
          }
          const confidence =
            modifiers.confidence === undefined ? 0.5 : Number(modifiers.confidence);
          if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
            ctx.send(input.entity, "Confidence must be between 0 and 1.");
            return;
          }
          const id = db.createNote(entity.name, text, input.room, {
            noteType: "fact",
            confidence,
            verificationStatus: "unverified",
          });
          if (modifiers.source) {
            const observedAt = modifiers.observed ? Date.parse(modifiers.observed) : undefined;
            db.addNoteSource(id, {
              url: modifiers.source,
              capturedBy: entity.name,
              observedAt:
                observedAt !== undefined && Number.isFinite(observedAt) ? observedAt : undefined,
            });
          }
          ctx.send(
            input.entity,
            `Claim #${id} saved (confidence=${confidence.toFixed(2)}, ${modifiers.source ? "sourced, unverified" : "unverified"}).`,
          );
          // Same twin scheme as a plain `note`: fire-and-forget so the reply
          // lands in-tick; sequencing callers use awaitPendingBridges(). With a
          // source the bridge twins the note first, then mirrors the url.
          if (modifiers.source) {
            const observedAt = modifiers.observed ? Date.parse(modifiers.observed) : undefined;
            void bridgeLegacySourceQuietly(db, entity.name, id, {
              url: modifiers.source,
              observedAt: Number.isFinite(observedAt) ? observedAt : undefined,
            });
          } else {
            void bridgeLegacyNoteQuietly(db, entity.name, id);
          }
          return;
        }

        case "source": {
          const id = Number.parseInt(tokens[1] ?? "", 10);
          const reference = tokens[2];
          const note = db.getNote(id);
          if (!access.write(note) || !reference) {
            ctx.send(
              input.entity,
              "Usage: note source <your-note-id> <url|note:id> [type T] [credibility 0..1] [observed YYYY-MM-DD]\n" +
                "(see also: `memory source <source ID> [start end]` reads a durable original source by byte range; `note source` attaches a reference to a legacy note and mirrors it onto the durable twin's sources.)",
            );
            return;
          }
          const { modifiers } = extractModifiers(tokens.slice(3).join(" "), [
            "type",
            "credibility",
            "observed",
          ]);
          const sourceNoteId = reference.startsWith("note:")
            ? Number(reference.slice(5))
            : undefined;
          if (
            sourceNoteId !== undefined &&
            (!Number.isInteger(sourceNoteId) || !access.read(db.getNote(sourceNoteId)))
          ) {
            ctx.send(input.entity, `Source note ${reference} was not found.`);
            return;
          }
          const credibility =
            modifiers.credibility === undefined ? 0.5 : Number(modifiers.credibility);
          if (!Number.isFinite(credibility) || credibility < 0 || credibility > 1) {
            ctx.send(input.entity, "Credibility must be between 0 and 1.");
            return;
          }
          const observedAt = modifiers.observed ? Date.parse(modifiers.observed) : undefined;
          const sourceType =
            sourceNoteId !== undefined
              ? "note"
              : (modifiers.type as
                  | "url"
                  | "message"
                  | "observation"
                  | "artifact"
                  | "dataset"
                  | undefined);
          db.addNoteSource(id, {
            url: reference,
            sourceType,
            sourceNoteId,
            sourceEntity:
              sourceNoteId !== undefined ? db.getNote(sourceNoteId)?.entity_name : undefined,
            capturedBy: entity.name,
            credibility,
            observedAt: Number.isFinite(observedAt) ? observedAt : undefined,
          });
          ctx.send(input.entity, `Source attached to note #${id}.`);
          // Mirror the reference onto the durable twin's sources (capture +
          // revise). Fire-and-forget; sequencing callers use awaitPendingBridges().
          void bridgeLegacySourceQuietly(db, entity.name, id, {
            url: reference,
            sourceType,
            sourceNoteId,
            credibility,
            observedAt: Number.isFinite(observedAt) ? observedAt : undefined,
          });
          return;
        }

        case "derive": {
          const id = Number(tokens[1]);
          const sourceId = Number(tokens[2]);
          const note = db.getNote(id);
          const source = db.getNote(sourceId);
          if (!access.write(note) || !access.read(source)) {
            ctx.send(input.entity, "Usage: note derive <your-note-id> <source-note-id>");
            return;
          }
          db.addNoteSource(id, {
            url: `note:${sourceId}`,
            sourceType: "note",
            sourceNoteId: sourceId,
            sourceEntity: source.entity_name,
            capturedBy: entity.name,
            excerpt: source.content.slice(0, 240),
            credibility: source.confidence ?? 0.5,
          });
          try {
            db.createNoteLink(id, sourceId, "derived_from");
          } catch {}
          ctx.send(input.entity, `Note #${id} now records derivation from #${sourceId}.`);
          // Durable side: the source note's twin becomes a (self-derived)
          // source of this note's twin, and a `derived_from` relation is asserted.
          void bridgeLegacySourceQuietly(db, entity.name, id, {
            url: `note:${sourceId}`,
            sourceType: "note",
            sourceNoteId: sourceId,
            credibility: source.confidence ?? 0.5,
            excerpt: source.content.slice(0, 240),
          });
          void bridgeLegacyLinkQuietly(db, entity.name, id, sourceId, "derived_from");
          return;
        }

        case "verify": {
          const id = Number.parseInt(tokens[1] ?? "", 10);
          const verification = tokens[2]?.toLowerCase() ?? "";
          const note = db.getNote(id);
          const confidence =
            tokens[3] === undefined ? (note?.confidence ?? 0.5) : Number(tokens[3]);
          if (
            !access.write(note) ||
            note.verification_status === "superseded" ||
            !Number.isFinite(confidence) ||
            !["unverified", "verified", "disputed"].includes(verification)
          ) {
            ctx.send(
              input.entity,
              "Usage: note verify <your-note-id> unverified|verified|disputed [confidence 0..1]",
            );
            return;
          }
          const rationale = tokens.slice(4).join(" ") || undefined;
          const verdict = verification as "unverified" | "verified" | "disputed";
          const verificationId = db.recordNoteVerification(
            id,
            entity.name,
            verdict,
            confidence,
            rationale,
          );
          ctx.send(
            input.entity,
            `Note #${id} marked ${verification} (confidence=${Math.max(0, Math.min(1, confidence)).toFixed(2)}).`,
          );
          // Durable twin follows the verdict: `disputed` closes its validity
          // (dropped from the [evidence] tier), `verified` reaffirms / reopens.
          // Fire-and-forget; sequencing callers use awaitPendingBridges().
          void bridgeLegacyVerificationQuietly(db, entity.name, id, verdict, {
            key: `legacy-note-${id}-verify-${verificationId}`,
            confidence: Math.max(0, Math.min(1, confidence)),
            rationale,
          });
          return;
        }

        case "explain": {
          const id = Number.parseInt(tokens[1] ?? "", 10);
          const note = db.getNote(id);
          if (!access.write(note)) {
            ctx.send(input.entity, `Note #${tokens[1] ?? "?"} not found or not yours.`);
            return;
          }
          const sources = db
            .getNoteSources(id)
            .filter(
              (source) => !source.source_note_id || access.read(db.getNote(source.source_note_id)),
            );
          const links = access.links(id);
          const verifications = db.getNoteVerifications(id);
          const lines = [
            header(`Memory #${id}`),
            separator(),
            note.content,
            `Type: ${note.note_type} · confidence: ${(note.confidence ?? 0.5).toFixed(2)} · ${note.verification_status ?? "unverified"}`,
            `Created: ${new Date(note.created_at).toISOString()} · sources: ${sources.length} · links: ${links.length}`,
          ];
          for (const source of sources)
            lines.push(
              `  source [${source.source_type}] ${source.url} · credibility ${source.credibility.toFixed(2)}${source.source_entity ? ` · via ${source.source_entity}` : ""}${source.observed_at ? ` · observed ${new Date(source.observed_at).toISOString().slice(0, 10)}` : ""}`,
            );
          for (const verification of verifications)
            lines.push(
              `  verification ${verification.status} c${verification.confidence.toFixed(2)} by ${verification.verifier}${verification.rationale ? ` — ${verification.rationale}` : ""}`,
            );
          for (const link of links)
            lines.push(
              `  ${link.relationship}: #${link.source_id === id ? link.target_id : link.source_id}`,
            );
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "contradictions": {
          const candidates = db
            .findMemoryContradictions(entity.name)
            .filter((candidate) => access.read(candidate.left) && access.read(candidate.right));
          if (candidates.length === 0) {
            ctx.send(input.entity, "No unresolved contradiction candidates found.");
            return;
          }
          ctx.send(
            input.entity,
            [
              header("Contradiction candidates"),
              separator(),
              ...candidates.map(
                (c) =>
                  `  #${c.left.id} ↔ #${c.right.id}: ${c.reason}\n    ${c.left.content.slice(0, 48)} / ${c.right.content.slice(0, 48)}`,
              ),
            ].join("\n"),
          );
          return;
        }

        case "conflicts": {
          const filter = tokens[1] === "resolved" ? "resolved" : "open";
          db.refreshContradictionCases();
          const cases = db
            .listContradictionCases(filter, 50)
            .filter(
              (conflict) =>
                access.read(db.getNote(conflict.left_note_id)) &&
                access.read(db.getNote(conflict.right_note_id)),
            );
          if (cases.length === 0) {
            ctx.send(input.entity, `No ${filter} shared contradiction cases.`);
            return;
          }
          const lines = [header(`Shared Contradictions · ${filter}`), separator()];
          for (const conflict of cases) {
            const left = db.getNote(conflict.left_note_id);
            const right = db.getNote(conflict.right_note_id);
            if (!left || !right) continue;
            lines.push(
              `  #${conflict.id} [${conflict.scope_type}${conflict.scope_id ? `:${conflict.scope_id}` : ""}]`,
              `    left  note #${left.id} · ${left.entity_name}: ${left.content.slice(0, 70)}`,
              `    right note #${right.id} · ${right.entity_name}: ${right.content.slice(0, 70)}`,
              dim(`    resolve: note resolve ${conflict.id} left|right|both|neither <rationale>`),
            );
          }
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "resolve": {
          const caseId = Number(tokens[1]);
          const resolution = tokens[2] as "left" | "right" | "both" | "neither" | undefined;
          const rationale = tokens.slice(3).join(" ");
          if (
            !Number.isInteger(caseId) ||
            !resolution ||
            !["left", "right", "both", "neither"].includes(resolution) ||
            !rationale
          ) {
            ctx.send(
              input.entity,
              "Usage: note resolve <case-id> left|right|both|neither <evidence-backed rationale>\n" +
                "(see also: `memory resolve <ID> <policy> <JSON>` settles competing DURABLE assertions by policy; `note resolve` adjudicates a legacy contradiction case and mirrors the verdicts onto the notes' durable twins.)",
            );
            return;
          }
          const conflict = db.getContradictionCase(caseId);
          // Resolution changes both notes' verification state, so it requires
          // write authority over both claims. Shared adjudication needs its own policy.
          const ok =
            !!conflict &&
            access.write(db.getNote(conflict.left_note_id)) &&
            access.write(db.getNote(conflict.right_note_id)) &&
            db.resolveContradictionCase(caseId, resolution, entity.name, rationale);
          ctx.send(
            input.entity,
            ok
              ? `Contradiction case #${caseId} resolved as ${resolution}; verification history was updated.`
              : `Open contradiction case #${caseId} not found.`,
          );
          if (ok && conflict) {
            // Mirror the legacy verdicts onto the twins: winners reaffirmed,
            // losers closed as disputed (`neither` disputes both, like the
            // legacy side). Fire-and-forget; sequenced by awaitPendingBridges().
            const { left_note_id: left, right_note_id: right } = conflict;
            const winners =
              resolution === "left"
                ? [left]
                : resolution === "right"
                  ? [right]
                  : resolution === "both"
                    ? [left, right]
                    : [];
            const losers =
              resolution === "left"
                ? [right]
                : resolution === "right"
                  ? [left]
                  : resolution === "neither"
                    ? [left, right]
                    : [];
            void bridgeLegacyResolutionQuietly(db, entity.name, caseId, {
              winners,
              losers,
              rationale,
            });
          }
          return;
        }

        case "consolidate": {
          const keeper = Number.parseInt(tokens[1] ?? "", 10);
          const duplicates = tokens.slice(2).map(Number).filter(Number.isInteger);
          if (!Number.isInteger(keeper) || duplicates.length === 0) {
            ctx.send(
              input.entity,
              "Usage: note consolidate <keeper-id> <duplicate-id> [duplicate-id ...]",
            );
            return;
          }
          if (![keeper, ...duplicates].every((id) => access.write(db.getNote(id)))) {
            ctx.send(input.entity, "One or more notes not found or not yours.");
            return;
          }
          // Snapshot which duplicates are still current: only the ones this
          // call flips to `superseded` get their durable twin retired.
          const wasCurrent = duplicates.filter(
            (dupId) => db.getNote(dupId)?.verification_status !== "superseded",
          );
          const changed = db.consolidateNotes(entity.name, keeper, duplicates);
          ctx.send(
            input.entity,
            `${changed} memory record(s) safely superseded by #${keeper}; provenance was retained.`,
          );
          const superseded = wasCurrent.filter(
            (dupId) => db.getNote(dupId)?.verification_status === "superseded",
          );
          // Losers' twins become tombstones pointing at the keeper (same
          // retirement as `note delete`); the keeper's twin is untouched.
          // Fire-and-forget; sequencing callers use awaitPendingBridges().
          if (superseded.length > 0)
            void bridgeLegacyConsolidationQuietly(db, entity.name, keeper, superseded);
          return;
        }

        case "list": {
          const notes = db.getNotesByEntity(entity.name).filter(access.read);
          if (notes.length === 0) {
            ctx.send(input.entity, "You have no notes.");
            return;
          }
          const lines = [
            header("Your Notes"),
            separator(),
            ...notes.map((n) => {
              const room = n.room_id ? dim(` [${n.room_id}]`) : "";
              const date = dim(new Date(n.created_at).toISOString().slice(0, 10));
              const imp = n.importance !== 5 ? ` ${importance(n.importance)}` : "";
              const type = n.note_type !== "observation" ? ` ${status(n.note_type, "info")}` : "";
              const verification = n.verification_status ?? "unverified";
              const quality =
                verification !== "unverified"
                  ? ` ${status(verification, verification === "verified" ? "done" : "warn")}`
                  : "";
              return `  ${fmtId(n.id)} ${date}${room}${imp}${type}${quality} c${(n.confidence ?? 0.5).toFixed(2)} ${n.content.slice(0, 60)}`;
            }),
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "room": {
          const notes = db.getNotesByRoom(input.room).filter(access.read);
          if (notes.length === 0) {
            ctx.send(input.entity, "No notes for this room.");
            return;
          }
          const lines = [
            header(`Notes for ${input.room}`),
            separator(),
            ...notes.map((n) => {
              const date = dim(new Date(n.created_at).toISOString().slice(0, 10));
              return `  ${fmtId(n.id)} ${date} ${dim(`(${n.entity_name})`)} ${n.content.slice(0, 60)}`;
            }),
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "search": {
          const query = tokens.slice(1).join(" ");
          if (!query) {
            ctx.send(input.entity, "Usage: note search <query>");
            return;
          }
          const notes = db.searchNotes(entity.name, query).filter(access.read);
          if (notes.length === 0) {
            ctx.send(input.entity, "No matching notes found.");
            return;
          }
          const lines = [
            header(`Search: "${query}"`),
            separator(),
            ...notes.map((n) => {
              const room = n.room_id ? dim(` [${n.room_id}]`) : "";
              return `  ${fmtId(n.id)}${room} ${n.content.slice(0, 60)}`;
            }),
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "delete": {
          const id = Number.parseInt(tokens[1] ?? "", 10);
          if (Number.isNaN(id)) {
            ctx.send(input.entity, "Usage: note delete <id>");
            return;
          }
          const target = db.getNote(id);
          // Resolve the twin BEFORE the row goes: note_sources cascades on delete.
          const twin = access.write(target) ? findDurableTwin(db, id) : undefined;
          const deleted = access.write(target) && db.deleteNote(id, entity.name);
          if (deleted) {
            deps.logEvent?.({
              type: "note_deleted",
              entity: input.entity,
              noteId: id,
              timestamp: Date.now(),
            });
            ctx.send(input.entity, `Note #${id} deleted.`);
            // Retire the durable twin (tombstone revise, never a cascading
            // forget). Fire-and-forget like every other bridge.
            if (twin) void retireDurableTwinQuietly(db, entity.name, id, twin);
          } else {
            ctx.send(input.entity, `Note #${id} not found or not yours.`);
          }
          return;
        }

        case "link": {
          const id1 = Number.parseInt(tokens[1] ?? "", 10);
          const id2 = Number.parseInt(tokens[2] ?? "", 10);
          const rel = tokens[3]?.toLowerCase();
          if (Number.isNaN(id1) || Number.isNaN(id2) || !rel) {
            ctx.send(input.entity, "Usage: note link <id1> <id2> <relationship>");
            return;
          }
          if (!VALID_RELATIONSHIPS.has(rel)) {
            ctx.send(
              input.entity,
              `Invalid relationship. Valid: ${[...VALID_RELATIONSHIPS].join(", ")}`,
            );
            return;
          }
          const note1 = db.getNote(id1);
          const note2 = db.getNote(id2);
          if (!access.write(note1) || !access.read(note2)) {
            ctx.send(input.entity, "One or both notes not found.");
            return;
          }
          try {
            db.createNoteLink(id1, id2, rel);
            deps.logEvent?.({
              type: "note_link_created",
              entity: input.entity,
              sourceId: id1,
              targetId: id2,
              relationship: rel,
              timestamp: Date.now(),
            });
            ctx.send(input.entity, `Linked note #${id1} -> #${id2} (${rel}).`);
            // Durable `relate` between the two twins (skipped when either note
            // has none). Fire-and-forget; sequenced by awaitPendingBridges().
            void bridgeLegacyLinkQuietly(db, entity.name, id1, id2, rel);
          } catch {
            ctx.send(input.entity, "Link already exists.");
          }
          return;
        }

        case "unlink": {
          const id1 = Number.parseInt(tokens[1] ?? "", 10);
          const id2 = Number.parseInt(tokens[2] ?? "", 10);
          const rel = tokens[3]?.toLowerCase();
          if (Number.isNaN(id1) || Number.isNaN(id2) || !rel) {
            ctx.send(input.entity, "Usage: note unlink <id1> <id2> <relationship>");
            return;
          }
          const removed =
            access.write(db.getNote(id1)) &&
            access.read(db.getNote(id2)) &&
            db.removeNoteLink(id1, id2, rel);
          if (!removed) {
            ctx.send(input.entity, `No link #${id1} -> #${id2} (${rel}) found.`);
            return;
          }
          deps.logEvent?.({
            type: "note_link_deleted",
            entity: input.entity,
            sourceId: id1,
            targetId: id2,
            relationship: rel,
            timestamp: Date.now(),
          });
          ctx.send(input.entity, `Unlinked note #${id1} -> #${id2} (${rel}).`);
          // Close the durable relation's validity (the service has no
          // destructive un-relate short of `forget`). Fire-and-forget.
          void bridgeLegacyUnlinkQuietly(db, entity.name, id1, id2, rel);
          return;
        }

        case "correct": {
          const id = Number.parseInt(tokens[1] ?? "", 10);
          if (Number.isNaN(id)) {
            ctx.send(input.entity, "Usage: note correct <id> <new text>");
            return;
          }
          const oldNote = db.getNote(id);
          if (!access.write(oldNote)) {
            ctx.send(input.entity, `Note #${id} not found.`);
            return;
          }
          const newText = tokens.slice(2).join(" ");
          if (!newText) {
            ctx.send(input.entity, "Usage: note correct <id> <new text>");
            return;
          }
          const parsed = parseNoteText(newText);
          const newImportance = parsed.importance ?? oldNote.importance;
          const newType = parsed.noteType ?? oldNote.note_type;
          const newId = db.reviseNote(entity.name, id, parsed.content, {
            importance: newImportance,
            noteType: newType,
          });
          if (newId === undefined) {
            ctx.send(
              input.entity,
              `Note #${id} is no longer current. Recall the current version before correcting it.`,
            );
            return;
          }
          deps.logEvent?.({
            type: "note_created",
            entity: input.entity,
            noteId: newId,
            authorName: entity.name,
            content: parsed.content,
            importance: newImportance,
            noteType: newType,
            roomId: input.room,
            timestamp: Date.now(),
          });
          deps.logEvent?.({
            type: "note_link_created",
            entity: input.entity,
            sourceId: newId,
            targetId: id,
            relationship: "supersedes",
            timestamp: Date.now(),
          });
          ctx.send(input.entity, `Note #${newId} created, superseding #${id}.`);
          // Durable twin follows the supersession (revise, CAS on current version).
          // Fire-and-forget: the reply (and quest progress) must land in this
          // tick; sequencing callers use awaitPendingBridges().
          void bridgeLegacyRevisionQuietly(db, entity.name, id, newId);
          return;
        }

        case "trace": {
          const id = Number.parseInt(tokens[1] ?? "", 10);
          if (Number.isNaN(id)) {
            ctx.send(input.entity, "Usage: note trace <id>");
            return;
          }
          const graph = access.trace(id, 2);
          if (graph.length === 0) {
            ctx.send(input.entity, `Note #${id} not found.`);
            return;
          }
          const lines = [header("Note Graph"), separator()];
          for (const entry of graph) {
            const indent = "  ".repeat(entry.depth);
            const type =
              entry.note.note_type !== "observation"
                ? ` ${status(entry.note.note_type, "info")}`
                : "";
            lines.push(
              `${indent}${fmtId(entry.note.id)}${type} ${entry.note.content.slice(0, 50)}`,
            );
            for (const link of entry.links) {
              const dir =
                link.source_id === entry.note.id
                  ? `${dim("->")} ${fmtId(link.target_id)}`
                  : `${dim("<-")} ${fmtId(link.source_id)}`;
              lines.push(`${indent}  ${bold(link.relationship)} ${dir}`);
            }
          }
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "types": {
          const types = [...VALID_NOTE_TYPES].sort();
          const rels = [...VALID_RELATIONSHIPS].sort();
          const lines = [
            header("Note Types & Relationships"),
            separator(),
            `${category("Types:")} ${types.join(", ")}`,
            `${category("Relationships:")} ${rels.join(", ")}`,
            "",
            dim("Usage: note <text> importance <N> type <type>"),
            dim("       note link <id1> <id2> <relationship>"),
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "evolve": {
          const id = Number.parseInt(tokens[1] ?? "", 10);
          if (Number.isNaN(id)) {
            ctx.send(input.entity, "Usage: note evolve <id>");
            return;
          }
          const oldNote = db.getNote(id);
          if (!access.write(oldNote)) {
            ctx.send(input.entity, `Note #${id} not found.`);
            return;
          }
          // Gather linked notes for context
          const graph = access.trace(id, 1);
          const contextParts = [oldNote.content];
          for (const entry of graph) {
            if (entry.note.id !== id) {
              contextParts.push(entry.note.content);
            }
          }
          // Create evolved note incorporating context
          const linkedCount = graph.length - 1;
          const evolvedContent =
            linkedCount > 0
              ? `[Evolved from #${id} with ${linkedCount} linked notes] ${contextParts.join(" | ")}`
              : `[Evolved from #${id}] ${oldNote.content}`;
          const newImportance = Math.min(oldNote.importance + 1, 10);
          const newId = db.reviseNote(entity.name, id, evolvedContent, {
            importance: newImportance,
            noteType: oldNote.note_type,
          });
          if (newId === undefined) {
            ctx.send(
              input.entity,
              `Note #${id} is no longer current. Recall the current version before evolving it.`,
            );
            return;
          }
          deps.logEvent?.({
            type: "note_created",
            entity: input.entity,
            noteId: newId,
            authorName: entity.name,
            content: evolvedContent,
            importance: newImportance,
            noteType: oldNote.note_type,
            roomId: input.room,
            timestamp: Date.now(),
          });
          deps.logEvent?.({
            type: "note_link_created",
            entity: input.entity,
            sourceId: newId,
            targetId: id,
            relationship: "supersedes",
            timestamp: Date.now(),
          });
          // Copy existing links to the evolved note
          const oldLinks = access.links(id);
          for (const link of oldLinks) {
            const otherId = link.source_id === id ? link.target_id : link.source_id;
            if (link.relationship !== "supersedes") {
              try {
                db.createNoteLink(newId, otherId, link.relationship);
                deps.logEvent?.({
                  type: "note_link_created",
                  entity: input.entity,
                  sourceId: newId,
                  targetId: otherId,
                  relationship: link.relationship,
                  timestamp: Date.now(),
                });
              } catch {
                // Ignore duplicate links
              }
            }
          }
          ctx.send(
            input.entity,
            `Note #${newId} evolved from #${id} (importance=${newImportance}, ${linkedCount} linked notes incorporated).`,
          );
          // Fire-and-forget: the reply (and quest progress) must land in this
          // tick; sequencing callers use awaitPendingBridges().
          void bridgeLegacyRevisionQuietly(db, entity.name, id, newId);
          return;
        }

        case "graph": {
          const notes = db.getNotesByEntity(entity.name).filter(access.read);
          if (notes.length === 0) {
            ctx.send(input.entity, "No notes to graph.");
            return;
          }
          // Count notes by type
          const typeCounts: Record<string, number> = {};
          for (const n of notes) {
            typeCounts[n.note_type] = (typeCounts[n.note_type] ?? 0) + 1;
          }
          // Count edges by relationship; track linked note IDs
          const edgeCounts: Record<string, number> = {};
          const linkedIds = new Set<number>();
          for (const n of notes) {
            const links = access.links(n.id);
            for (const link of links) {
              linkedIds.add(link.source_id);
              linkedIds.add(link.target_id);
              if (link.source_id === n.id) {
                edgeCounts[link.relationship] = (edgeCounts[link.relationship] ?? 0) + 1;
              }
            }
          }

          const lines = [
            header("Knowledge Graph"),
            separator(),
            `${category("Notes:")} ${bold(String(notes.length))}`,
            ...Object.entries(typeCounts).map(
              ([type, count]) => `  ${status(type, "info")} ${count}`,
            ),
          ];
          const totalEdges = Object.values(edgeCounts).reduce((a, b) => a + b, 0);
          if (totalEdges > 0) {
            lines.push(`${category("Edges:")} ${bold(String(totalEdges))}`);
            for (const [rel, count] of Object.entries(edgeCounts)) {
              lines.push(`  ${bold(rel)}: ${count}`);
            }
          }

          // Cognitive landscape
          const orphans = notes.filter((n) => !linkedIds.has(n.id));
          const fading = notes.filter((n) => n.importance <= 2);
          const contradictions = edgeCounts.contradicts ?? 0;

          // Notes since last reflection (notes ordered by id DESC, first episode = most recent)
          const lastEpisode = notes.find((n) => n.note_type === "episode");
          const sinceReflection = lastEpisode
            ? notes.filter((n) => n.id > lastEpisode.id && n.note_type !== "episode").length
            : notes.filter((n) => n.note_type !== "episode").length;

          lines.push("", category("Landscape:"));
          lines.push(`  Unlinked: ${orphans.length}`);
          if (fading.length > 0) {
            lines.push(`  ${status("Fading", "warn")}: ${fading.length}`);
          }
          if (contradictions > 0) {
            lines.push(`  ${status("Contradictions", "fail")}: ${contradictions}`);
          }
          lines.push(`  Since last reflection: ${sinceReflection}`);

          // Frontier topics: themes from orphan + fading notes
          const frontierSet = new Set([...orphans, ...fading]);
          if (frontierSet.size >= 2) {
            const topics = extractTopics([...frontierSet]);
            if (topics.length > 0) {
              lines.push(`  Frontiers: ${topics.join(", ")}`);
            }
          }

          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        default: {
          // Save a note: "note <text> [importance N] [type T]"
          const content = input.args;
          if (!content) {
            ctx.send(input.entity, "Usage: note <text>");
            return;
          }
          const parsed = parseNoteText(content);
          const id = db.createNote(entity.name, parsed.content, input.room, {
            importance: parsed.importance,
            noteType: parsed.noteType,
          });
          deps.logEvent?.({
            type: "note_created",
            entity: input.entity,
            noteId: id,
            authorName: entity.name,
            content: parsed.content,
            importance: parsed.importance ?? 5,
            noteType: parsed.noteType ?? "observation",
            roomId: input.room,
            timestamp: Date.now(),
          });
          const extras: string[] = [];
          if (parsed.importance) extras.push(`importance=${parsed.importance}`);
          if (parsed.noteType) extras.push(`type=${parsed.noteType}`);

          // Auto-link: find similar existing notes and create related_to links
          const autoLinked: number[] = [];
          try {
            const similar = db.findSimilarNotes(entity.name, parsed.content, id);
            for (const s of similar.filter(access.read).slice(0, 3)) {
              try {
                db.createNoteLink(id, s.id, "related_to");
                deps.logEvent?.({
                  type: "note_link_created",
                  entity: input.entity,
                  sourceId: id,
                  targetId: s.id,
                  relationship: "related_to",
                  timestamp: Date.now(),
                });
                autoLinked.push(s.id);
              } catch {
                // Ignore duplicate links
              }
            }
          } catch {
            // Auto-linking is best-effort
          }

          const suffix = extras.length > 0 ? ` (${extras.join(", ")})` : "";
          const linkInfo =
            autoLinked.length > 0
              ? ` Auto-linked to notes ${autoLinked.map((i) => `#${i}`).join(", ")} (related_to).`
              : "";
          ctx.send(input.entity, `Note #${id} saved${suffix}.${linkInfo}`);
          // Legacy reply is already on the wire; the durable twin (capture +
          // remember + note_sources row) lands asynchronously and never fails
          // the legacy write. Returned so `await processCommand` sequences it.
          // Fire-and-forget: the reply (and quest progress) must land in this
          // tick; sequencing callers use awaitPendingBridges().
          void bridgeLegacyNoteQuietly(db, entity.name, id);
          return;
        }
      }
    },
  };
}
