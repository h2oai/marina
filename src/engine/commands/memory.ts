// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { memoryResult } from "../../memory/command-result";
import {
  formatMemoryOperation,
  MEMORY_SERVICE_HELP,
  parseMemoryServiceCommand,
} from "../../memory/human-interface";
import { residentMemoryOperation } from "../../memory/resident-service";
import { bold, dim, header, label, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import { memoryOperationError } from "../../sdk/memory-operations";
import type { CommandDef, Entity, RoomContext } from "../../types";
import { canonicalSub, unknownSubcommand } from "../parse-input";
import { requiresPersistence } from "./command-messages";

/** Durable-service verbs handled by `parseMemoryServiceCommand` (src/memory/human-interface.ts). */
const DURABLE_SUBS = [
  "guide",
  "start",
  "tasks",
  "recipes",
  "resume",
  "run",
  "finish",
  "feedback",
  "recipe-save",
  "recipe",
  "watch",
  "poll",
  "changes",
  "ack",
  "unwatch",
  "assist",
  "jobs",
  "assistance",
  "assist-cancel",
  "adopt",
  "transfers",
  "transfer",
  "transfer-abort",
  "federation",
  "across",
  "review",
  "reaffirm",
  "resolve",
  "usage",
  "service",
  "api",
  "remember",
  "query",
  "join",
  "rule-save",
  "rule-run",
  "rule-materialize",
  "sources",
  "source",
  "plan",
  "retrieve",
  "vocabulary",
  "graph",
  "show",
  "claim",
  "relate",
];

/** Core key-value verbs. Canonical home is `memory kv <verb>`; bare forms stay accepted. */
const KV_SUBS = ["list", "get", "set", "delete", "history", "clear"];

const KV_USAGE =
  "Usage: memory kv list | memory kv set <key> <value> | memory kv get <key> | memory kv delete <key> | memory kv history <key> | memory kv clear\n" +
  "(bare `memory set/get/delete/list/history` still work; `ls` = list, `rm`/`remove` = delete)";

export const MEMORY_KV_HELP = `Key-value beliefs (core memory — mutable, per-entity, NOT the durable record store):
  memory kv list                        your keys (bare \`memory list\` = same)
  memory kv set <key> <value>           e.g. memory kv set pace fast  (agent tick rate)
  memory kv get <key>
  memory kv delete <key>
  memory kv history <key>               edit trail of one key
  memory kv clear                       delete every key`;

/** Which verb? One line each — the retrieval and verification surfaces that look alike. */
export const MEMORY_WHICH_VERB = `Which verb?
  recall <q>             your legacy notes, FTS-ranked (fast, no model)
  memory query <JSON>    durable records, exact symbolic filters
  recap <topic>          multi-source retrieve-only pull (notes + pools + chronicle), no model
  ask <question>         model-synthesised answer over notes + guide + pools + world search
  dig <topic>            internal notes + web evidence, optional synthesis
  share <pool> <text>    ≡ pool <pool> add <text>
  note verify <id> …     mark a legacy note verified | memory reaffirm <ID> … re-pin a durable record | skill verify <name> check a skill package`;

/** Strip the first `n` whitespace-separated tokens from `args`, preserving the rest verbatim. */
function afterTokens(args: string, n: number): string {
  let s = args.trimStart();
  for (let i = 0; i < n; i++) {
    const m = /^\S+\s*/.exec(s);
    if (!m) return "";
    s = s.slice(m[0].length);
  }
  return s;
}

export function memoryCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  db?: MarinaDB;
}): CommandDef {
  return {
    name: "memory",
    aliases: [],
    help:
      "Durable memory service + key-value beliefs.\n" +
      `${KV_USAGE}\n\n` +
      `${MEMORY_KV_HELP}\n\n` +
      `${MEMORY_WHICH_VERB}\n\n` +
      MEMORY_SERVICE_HELP +
      "\n\nSame-named legacy note verbs (see also): `memory claim` asserts a typed durable claim ↔ `note claim <text>` records a free-text legacy claim (mirrored to a durable twin); " +
      "`memory resolve <ID> <policy>` settles competing durable records ↔ `note resolve <case> left|right|both|neither` adjudicates a legacy contradiction case; " +
      "`memory source <ID> [start end]` reads a durable original source ↔ `note source <id> <url>` attaches a reference to a legacy note (mirrored onto the twin's sources); " +
      "`memory graph <subject>` follows durable relationships ↔ `note graph` summarises your legacy notes and links." +
      "\n\nExamples:\n  memory kv set goal Explore the grid and document findings\n  memory kv set pace slow\n  memory kv get goal\n  memory kv history goal\n  memory show <record ID>   (also view/info)",
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;
      if (!deps.db) {
        ctx.send(input.entity, requiresPersistence("memory"));
        return;
      }
      const db = deps.db;
      const tokens = input.tokens;
      const rawSub = tokens[0];
      // `ls` → list (KV), `view`/`info` → show (durable), `rm`/`remove` → delete (KV).
      const sub = canonicalSub(rawSub, ["kv", ...KV_SUBS, ...DURABLE_SUBS]);

      // ── Key-value beliefs: canonical `memory kv <verb>`, bare verbs still accepted ──
      const kv =
        sub === "kv"
          ? { verb: canonicalSub(tokens[1], KV_SUBS) ?? "list", offset: 2 }
          : sub === undefined || KV_SUBS.includes(sub)
            ? { verb: sub ?? "list", offset: 1 }
            : undefined;
      if (kv) {
        runKv(ctx, db, entity, input.entity, kv.verb, tokens, afterTokens(input.args, kv.offset));
        return;
      }

      // ── Durable service ──
      const serviceArgs =
        sub && rawSub && sub !== rawSub ? input.args.replace(/^\S+/, sub) : input.args;
      try {
        const request = parseMemoryServiceCommand(serviceArgs ?? tokens.join(" "));
        if (request !== undefined)
          return residentMemoryOperation(db, entity.name, request)
            .catch(memoryOperationError)
            .then((result) =>
              ctx.send(input.entity, formatMemoryOperation(result), undefined, {
                memory_service: { ...result, request_id: request?.request_id },
              }),
            );
      } catch (error) {
        const result = memoryOperationError(error);
        ctx.send(input.entity, formatMemoryOperation(result), undefined, {
          memory_service: result,
        });
        return;
      }

      ctx.send(
        input.entity,
        unknownSubcommand(
          "memory",
          rawSub,
          `${KV_USAGE}\n` +
            "Durable records: `help memory full` lists the service verbs (memory claim/resolve/source/graph act on durable records; the same-named `note claim/resolve/source/graph` act on legacy notes and mirror to their twins).",
        ),
      );
    },
  };
}

/**
 * Core key-value store. `tokens` are the full command tokens; `kvArgs` is the
 * raw args string with the verb prefix (`kv set` or `set`) stripped so a
 * value keeps its internal whitespace and JSON quoting.
 */
function runKv(
  ctx: RoomContext,
  db: MarinaDB,
  entity: Entity,
  entityId: Entity["id"],
  verb: string,
  tokens: readonly string[],
  kvArgs: string,
): void {
  const keyOf = () => kvArgs.split(/\s+/)[0] || undefined;
  const bare = tokens[0]?.toLowerCase() !== "kv";
  // Point bare-verb users at the canonical namespace once per reply.
  const canon = (v: string) => (bare ? dim(`(canonical: memory kv ${v})`) : "");

  switch (verb) {
    case "list": {
      const entries = db.listCoreMemory(entity.name);
      const hint = dim(
        "This lists your key-value beliefs; durable records: memory query {}  ·  legacy notes: recall <q>",
      );
      if (entries.length === 0) {
        ctx.send(
          entityId,
          `Core memory is empty. Try memory kv set <key> <value>, memory retrieve <question> or memory guide for task workflows.\n${hint}`,
        );
        return;
      }
      const lines = [
        header("Core Memory (key-value)"),
        separator(),
        ...entries.map((e) => {
          const truncated = e.value.length > 50 ? `${e.value.slice(0, 50)}...` : e.value;
          return label(`${bold(e.key)} ${dim(`v${e.version}`)}`, truncated);
        }),
        hint,
      ];
      ctx.send(entityId, lines.join("\n"));
      return;
    }

    case "set": {
      const key = keyOf();
      const value = key ? afterTokens(kvArgs, 1) : "";
      if (!key || !value) {
        ctx.send(entityId, `Usage: memory kv set <key> <value> ${canon("set")}`.trim());
        return;
      }
      db.setCoreMemory(entity.name, key, value);
      ctx.send(
        entityId,
        `Memory "${key}" set.`,
        undefined,
        memoryResult("core-set", { success: true }),
      );
      return;
    }

    case "get": {
      const key = keyOf();
      if (!key) {
        ctx.send(entityId, `Usage: memory kv get <key> ${canon("get")}`.trim());
        return;
      }
      const entry = db.getCoreMemory(entity.name, key);
      if (!entry) {
        ctx.send(
          entityId,
          `No memory entry for "${key}".`,
          undefined,
          memoryResult("core-get", { success: false, error: "Key not found" }),
        );
        return;
      }
      ctx.send(
        entityId,
        `${bold(key)} ${dim(`(v${entry.version})`)}: ${entry.value}`,
        undefined,
        memoryResult("core-get", { success: true, entry }),
      );
      return;
    }

    case "delete": {
      const key = keyOf();
      if (!key) {
        ctx.send(entityId, `Usage: memory kv delete <key> ${canon("delete")}`.trim());
        return;
      }
      const deleted = db.deleteCoreMemory(entity.name, key);
      if (deleted) {
        ctx.send(
          entityId,
          `Memory "${key}" deleted.`,
          undefined,
          memoryResult("core-delete", { success: true }),
        );
      } else {
        ctx.send(
          entityId,
          `No memory entry for "${key}".`,
          undefined,
          memoryResult("core-delete", { success: false, error: "Key not found" }),
        );
      }
      return;
    }

    case "clear": {
      const entries = db.listCoreMemory(entity.name);
      let removed = 0;
      for (const e of entries) if (db.deleteCoreMemory(entity.name, e.key)) removed++;
      ctx.send(
        entityId,
        removed === 0
          ? "Core memory is already empty."
          : `Cleared ${removed} key-value entr${removed === 1 ? "y" : "ies"}.`,
        undefined,
        memoryResult("core-delete", { success: true }),
      );
      return;
    }

    case "history": {
      const key = keyOf();
      if (!key) {
        ctx.send(entityId, `Usage: memory kv history <key> ${canon("history")}`.trim());
        return;
      }
      const history = db.getCoreMemoryHistory(entity.name, key);
      if (history.length === 0) {
        ctx.send(entityId, `No edit history for "${key}".`);
        return;
      }
      const lines = [
        header(`History: ${key}`),
        separator(),
        ...history.map((h) => {
          const date = dim(new Date(h.changed_at).toISOString().slice(0, 19));
          return `  ${date} "${h.old_value}" ${dim("\u2192")} "${h.new_value}"`;
        }),
      ];
      ctx.send(entityId, lines.join("\n"));
      return;
    }

    default:
      ctx.send(entityId, unknownSubcommand("memory kv", verb, KV_USAGE));
  }
}
