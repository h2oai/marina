// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { category, dim, header, id, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, RoomContext } from "../../types";
import type { ConnectorRuntime } from "../connector-runtime";
import { search as providerSearch, type SearchResult } from "../search-providers/index";
import { requiresPersistence } from "./command-messages";
import { gatherRetrievalContext } from "./retrieval-core";

/**
 * Dig — investigate a topic with external evidence.
 *
 * Sibling of `recap` and `ask`. Where recap is internal-only and ask
 * synthesizes via the LLM, dig blends both: pull personal + guide notes
 * for grounding, run a web search for fresh evidence, optionally hand the
 * combined context to the model for synthesis. The result is shaped so an
 * agent can immediately turn it into a note or a pool deposit.
 *
 * If the connector runtime is unavailable, dig degrades gracefully to
 * "internal-only" mode — equivalent to recap with the answer step.
 */
export function digCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  db?: MarinaDB;
  connectorRuntime?: ConnectorRuntime;
  answerQuestion?: (query: string, context: string) => Promise<string | undefined>;
}): CommandDef {
  return {
    name: "dig",
    aliases: [],
    help: "Investigate a topic — internal notes + web evidence + synthesis. Usage: dig <topic>",
    handler: async (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const query = input.args.trim();
      if (!query) {
        ctx.send(input.entity, "Usage: dig <topic>");
        return;
      }

      if (!deps.db) {
        ctx.send(input.entity, requiresPersistence("dig"));
        return;
      }

      const lines: string[] = [header(`Dig: ${query}`), separator()];
      const contextLines: string[] = [];

      // Dig grounds on personal + guide notes only — the web evidence below is
      // its distinctive source; pools/chronicle/world-search stay recap's job.
      const retrieved = gatherRetrievalContext(
        deps.db,
        { id: input.entity, name: entity.name },
        query,
        { personal: 4, guide: 3, pools: 0, chronicle: 0, world: 0 },
      );

      if (retrieved.personal.length > 0) {
        lines.push(category("Your Notes"));
        for (const note of retrieved.personal) {
          lines.push(`  ${id(note.id)} ${note.content}`);
          contextLines.push(`[personal:${note.id}] ${note.content}`);
        }
      }

      if (retrieved.guide.length > 0) {
        lines.push(category("Guide"));
        for (const note of retrieved.guide) {
          lines.push(`  ${id(note.id)} ${note.content}`);
          contextLines.push(`[guide:${note.id}] ${note.content}`);
        }
      }

      let webResults: SearchResult[] = [];
      if (deps.connectorRuntime) {
        try {
          webResults = await providerSearch(
            query,
            { maxResults: 5 },
            deps.connectorRuntime,
            input.entity,
          );
        } catch {
          // Search failures are non-fatal — the internal sources still
          // contribute. Surface the absence in the output below.
        }
        if (webResults.length > 0) {
          lines.push(category("Web Evidence"));
          for (const r of webResults) {
            lines.push(`  ${r.title}\n    ${dim(r.url)}`);
            const snippet = r.snippet?.trim();
            if (snippet) lines.push(`    ${snippet}`);
            contextLines.push(`[web:${r.url}] ${r.title} — ${snippet ?? ""}`);
          }
        }
      } else {
        lines.push(dim("Web search unavailable (no connector runtime). Internal sources only."));
      }

      if (deps.answerQuestion && contextLines.length > 0) {
        try {
          const answer = await deps.answerQuestion(query, contextLines.slice(0, 20).join("\n"));
          if (answer?.trim()) {
            lines.push("");
            lines.push(category("Synthesis"), answer.trim());
          }
        } catch {
          // Synthesis is best-effort — the raw sources above are the
          // authoritative output.
        }
      }

      if (contextLines.length === 0) {
        lines.push("Nothing on file and no web access. Capture what you do know with `note`.");
      } else {
        lines.push("");
        lines.push(
          dim("Write what you learned: `note <observation>` or `share <pool> <finding>`."),
        );
      }

      ctx.send(input.entity, lines.join("\n"));
    },
  };
}
