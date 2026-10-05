// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `web swarm [engines:<a,b>] [docs:N] <question>` — the read swarm
 * (`src/retrieval/read-swarm.ts`) for any agent or crew: the question is split
 * into clues, each clue is searched through the same engines as `web search`
 * (a local corpus with `engines:corpus:<name>`), and reader models read the
 * best pages IN FULL, returning a candidate table whose quotes are verified
 * verbatim against the pages. Off unless the operator names a reader model
 * (`MARINA_READ_SWARM_READER`); every reader call is priced against the daily
 * spend cap. One swarm per entity at a time.
 */

import { modelComplete } from "../../arena/model-backend";
import { dim, header, separator } from "../../net/ansi";
import { ReadSwarm, renderCandidateTable } from "../../retrieval/read-swarm";
import type { EntityId, RoomContext } from "../../types";
import type { ConnectorRuntime } from "../connector-runtime";
import { getErrorMessage } from "../errors";
import { extractReadableText } from "../html-text";
import { type ModifierSpec, parseModifiers } from "../parse-input";
import { getCorpusDocument, parseCorpusUrl } from "../search-providers/corpus";
import { search as providerSearch } from "../search-providers/index";

const SWARM_SPEC: ModifierSpec = {
  engines: { type: "string", aliases: ["engine"] },
  docs: { type: "int", aliases: ["max"] },
};

export const WEB_SWARM_USAGE = "web swarm [engines:<a,b>] [docs:N] <question>";

/** Characters of a fetched page kept for reading (pages are read in chunks). */
const PAGE_CHARS = 200_000;
const running = new Set<string>();

export async function handleSwarm(
  ctx: RoomContext,
  eid: EntityId,
  tokens: string[],
  runtime: ConnectorRuntime,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const readerSpec = env.MARINA_READ_SWARM_READER?.trim();
  if (!readerSpec) {
    ctx.send(
      eid,
      "The read swarm is off: an operator turns it on by naming a reader model (MARINA_READ_SWARM_READER).",
    );
    return;
  }
  const mods = parseModifiers(tokens, SWARM_SPEC, { leading: true });
  const question = mods.rest.join(" ").trim();
  if (mods.errors.length > 0 || !question) {
    ctx.send(
      eid,
      `${mods.errors.length ? `${mods.errors.join("; ")}. ` : ""}Usage: ${WEB_SWARM_USAGE}`,
    );
    return;
  }
  if (running.has(eid)) {
    ctx.send(eid, "A read swarm of yours is already running; wait for its table.");
    return;
  }
  const engines =
    typeof mods.values.engines === "string"
      ? mods.values.engines
          .split(",")
          .map((e) => e.trim())
          .filter(Boolean)
      : undefined;
  const maxDocs =
    typeof mods.values.docs === "number" ? Math.min(Math.max(mods.values.docs, 1), 60) : 16;
  let reader: ReturnType<typeof modelComplete>;
  try {
    reader = modelComplete(readerSpec, env);
  } catch (e) {
    ctx.send(eid, `Read swarm unavailable: ${getErrorMessage(e)}`);
    return;
  }
  running.add(eid);
  try {
    const model = { name: readerSpec, complete: reader.complete };
    const pages = new Map<string, string>();
    const swarm = new ReadSwarm(question, {
      search: async (q, depth) =>
        (
          await providerSearch(
            q,
            { ...(engines ? { engines } : {}), maxResults: Math.min(depth, 10) },
            runtime,
            eid,
          )
        ).map((r) => ({ id: r.url, title: r.title, text: r.snippet ?? "" })),
      read: async (url, offset, maxChars) => {
        const local = parseCorpusUrl(url);
        if (local) {
          const doc = getCorpusDocument(local.name, local.docid, { offset, maxChars });
          return doc
            ? {
                id: url,
                ...(doc.title ? { title: doc.title } : {}),
                text: doc.text,
                totalChars: doc.totalChars,
              }
            : undefined;
        }
        let text = pages.get(url);
        if (text === undefined) {
          const res = await runtime.httpGet(url, eid);
          text =
            "error" in res || res.status !== 200
              ? ""
              : extractReadableText(res.body).text.slice(0, PAGE_CHARS);
          pages.set(url, text);
        }
        return text
          ? { id: url, text: text.slice(offset, offset + maxChars), totalChars: text.length }
          : undefined;
      },
      reader: model,
      decomposer: model,
      reranker: model,
      depth: 10,
      openDocs: maxDocs,
      maxDocs,
    });
    const opening = await swarm.open();
    const st = swarm.stats();
    ctx.send(
      eid,
      [
        header(`Read swarm: ${question.slice(0, 80)}`),
        separator(),
        dim(
          `${st.docsRead} pages read in full by ${readerSpec} · ${st.quotesVerified}/${st.quotes} quotes verified verbatim · ${opening.clues.length} clues · $${reader.usage.costUsd.toFixed(4)}`,
        ),
        "",
        renderCandidateTable(swarm.clues, swarm.readings()),
      ].join("\n"),
    );
  } catch (e) {
    ctx.send(eid, `Read swarm failed: ${getErrorMessage(e)}`);
  } finally {
    running.delete(eid);
  }
}
