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
import type { CommandUsage } from "../../sdk/command-forms";
import { memoryOperationError } from "../../sdk/memory-operations";
import type { CommandDef, Entity, RoomContext } from "../../types";
import { COMMAND_FAMILIES } from "../command-families";
import { refuseCommand } from "../command-response";
import { canonicalSub, unknownSubcommand } from "../parse-input";
import { requiresPersistence } from "./command-messages";
import { CONTEXT_USAGE } from "./context";
import { DEBRIEF_USAGE } from "./debrief";
import { NOTE_USAGE } from "./note";
import { RECALL_USAGE } from "./recall";
import { RECAP_USAGE } from "./recap";
import { REFLECT_USAGE } from "./reflect";

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
  memory kv history <key>               edit trail of one key, newest first, ending with its first set
  memory kv clear                       delete every key`;

/** Which verb? One line each — the retrieval and verification surfaces that look alike. */
export const MEMORY_WHICH_VERB = `Which verb?
  memory recall <q>      your notes, FTS-ranked (fast, no model)
  memory query <JSON>    durable records, exact symbolic filters
  memory recap <topic>   multi-source retrieve-only pull (notes + pools + chronicle), no model
  ask <question>         model-synthesised answer over notes + guide + pools + world search
  dig <topic>            internal notes + web evidence, optional synthesis
  share <pool> <text>    ≡ pool <pool> add <text>
  note verify <id> …     dispute or retract on your own note (verified comes from another's pool <name> ratify) | memory reaffirm <ID> … re-pin a durable record | skill verify <name> check a skill package`;

/**
 * The family members' forms as `memory <member> …`. The command phase runs
 * them as the member (`CommandRouter.forwardFamily`), so every form keeps the
 * member's effect and fields.
 */
const FAMILY_USAGE: readonly CommandUsage[] = [
  ...NOTE_USAGE,
  ...RECALL_USAGE,
  ...REFLECT_USAGE,
  ...RECAP_USAGE,
  ...DEBRIEF_USAGE,
  ...CONTEXT_USAGE,
].map((entry) =>
  typeof entry === "string" ? `memory ${entry}` : { ...entry, syntax: `memory ${entry.syntax}` },
);

/** The family line `help memory` shows under its usage. */
export const MEMORY_FAMILY_HELP =
  "Family: memory note <text> · memory recall <query> [evidence|all] · memory reflect [topic] · memory recap <topic> · memory debrief · memory context <query>\n" +
  `(bare ${(COMMAND_FAMILIES.memory ?? []).join(", ")} are aliases; \`help memory full\` lists every form)`;

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
    category: "Memory",
    usage: [
      { syntax: "memory ack <NAME> <VERSION> <CURSOR> [OBSERVED_AT]", effect: "write" },
      { syntax: "memory across <JSON query>", effect: "read" },
      { syntax: "memory adopt <ID> [space <SPACE_ID>] [JSON]", effect: "write" },
      { syntax: "memory adopt <ID> confirm-abstention", effect: "write" },
      { syntax: "memory api <JSON request>", effect: "execute" },
      { syntax: "memory assist <role> <helper> <task>", effect: "execute" },
      { syntax: "memory assist-cancel <ID>", effect: "write" },
      { syntax: "memory assistance <ID>", effect: "read" },
      { syntax: "memory changes [CURSOR]", effect: "read" },
      { syntax: "memory claim <subject> <predicate> <JSON scalar>", effect: "write" },
      { syntax: "memory federation", effect: "read" },
      {
        syntax: "memory feedback <TASK_ID> <helpful|unhelpful|pass|fail|unknown> <explanation>",
        effect: "write",
      },
      {
        syntax: "memory finish <TASK_ID> <VERSION> <completed|interrupted|failed> <next action>",
        effect: "write",
      },
      { syntax: "memory graph <subject>", effect: "read" },
      { syntax: "memory guide", effect: "read" },
      { syntax: "memory jobs [JSON filters]", effect: "read" },
      { syntax: "memory join <JSON patterns>", effect: "read" },
      { syntax: "memory kv clear", effect: "delete" },
      { syntax: "memory kv delete <key>", effect: "delete" },
      { syntax: "memory kv get <key>", effect: "read" },
      { syntax: "memory kv history <key>", effect: "read" },
      { syntax: "memory kv list", effect: "read" },
      { syntax: "memory kv set <key> <value>", effect: "write" },
      { syntax: "memory plan <task>", effect: "read" },
      { syntax: "memory poll <NAME>", effect: "read" },
      { syntax: "memory query <JSON filters>", effect: "read" },
      { syntax: "memory query <JSON>", effect: "read" },
      { syntax: "memory reaffirm <ID> <version> <JSON pins>", effect: "write" },
      { syntax: "memory recipe <ID> <VERSION> <task>", effect: "read" },
      { syntax: "memory recipe-save <JSON recipe>", effect: "write" },
      { syntax: "memory recipes", effect: "read" },
      { syntax: "memory relate <subject> <predicate> <entity ID>", effect: "write" },
      { syntax: "memory remember <text>", effect: "write" },
      { syntax: "memory resolve <ID> <policy> <JSON>", effect: "write" },
      { syntax: "memory resume <TASK_ID>", effect: "write" },
      { syntax: "memory retrieve <task>", effect: "read" },
      { syntax: "memory review [JSON filters]", effect: "read" },
      {
        syntax:
          "memory rule-materialize <JSON request> explicitly save dependency-pinned conclusions",
        effect: "write",
      },
      { syntax: "memory rule-run <JSON request>", effect: "read" },
      { syntax: "memory rule-save <JSON request>", effect: "write" },
      { syntax: "memory run <TASK_ID> <VERSION>", effect: "execute" },
      { syntax: "memory service", effect: "read" },
      { syntax: "memory show <record ID>", effect: "read" },
      { syntax: "memory source <source ID> [start end]", effect: "read" },
      { syntax: "memory sources <query>", effect: "read" },
      { syntax: "memory start <goal>", effect: "write" },
      { syntax: "memory tasks [CURSOR]", effect: "read" },
      { syntax: "memory transfer <ID>", effect: "read" },
      { syntax: "memory transfer-abort <ID>", effect: "write" },
      { syntax: "memory transfers [JSON filters]", effect: "read" },
      { syntax: "memory unwatch <NAME> <VERSION>", effect: "write" },
      { syntax: "memory usage", effect: "read" },
      { syntax: "memory vocabulary", effect: "read" },
      { syntax: "memory watch <NAME> [RECORD_ID ...]", effect: "write" },
      ...FAMILY_USAGE,
    ],
    name: "memory",
    aliases: [],
    // `memory api` carries a resident's journal and checkpoint payloads (its
    // own memory content) on every turn: never logged in clear, and not
    // logged at all (it would crowd the world's actions out of the event log).
    sensitiveSubcommands: ["api"],
    unloggedSubcommands: ["api"],
    help:
      "The memory command: notes, recall, reflection, durable records and key-value beliefs.\n" +
      `${KV_USAGE}\n${MEMORY_FAMILY_HELP}\n\n` +
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
        refuseCommand(ctx, input.entity, requiresPersistence("memory"));
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

      // Search-shaped verbs name the family member that searches.
      const search = /^(search|find|query|lookup)$/i.test(rawSub ?? "")
        ? "To search your notes: `memory recall <query>`.\n"
        : "";
      ctx.send(
        input.entity,
        unknownSubcommand(
          "memory",
          rawSub,
          `${search}${KV_USAGE}\n` +
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
        refuseCommand(ctx, entityId, `Usage: memory kv set <key> <value> ${canon("set")}`.trim());
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
        refuseCommand(ctx, entityId, `Usage: memory kv get <key> ${canon("get")}`.trim());
        return;
      }
      const entry = db.getCoreMemory(entity.name, key);
      if (!entry) {
        // A read that finds nothing, not a refusal: callers probe keys.
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
        refuseCommand(ctx, entityId, `Usage: memory kv delete <key> ${canon("delete")}`.trim());
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
        refuseCommand(
          ctx,
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
        refuseCommand(ctx, entityId, `Usage: memory kv history <key> ${canon("history")}`.trim());
        return;
      }
      const history = db.getCoreMemoryHistory(entity.name, key);
      const entry = db.getCoreMemory(entity.name, key);
      if (!entry && history.length === 0) {
        ctx.send(entityId, `No memory entry for "${key}".`);
        return;
      }
      const stamp = (at: number) => dim(new Date(at).toISOString().slice(0, 19));
      const edit = (h: (typeof history)[number]) =>
        `  ${stamp(h.changed_at)} "${h.old_value}" ${dim("\u2192")} "${h.new_value}"`;
      // The trail records edits; the first set is the row's creation. Edits of the
      // current row come first (newest first); rows from before a delete follow it.
      const current = entry ? history.filter((h) => h.changed_at >= entry.created_at) : [];
      const earlier = history.slice(current.length);
      const lines = [header(`History: ${key}`), separator(), ...current.map(edit)];
      if (entry) {
        const missing = entry.version - 1 - current.length;
        const first = current.length ? current[current.length - 1]!.old_value : entry.value;
        lines.push(
          missing <= 0
            ? `  ${stamp(entry.created_at)} set "${first}" ${dim("(first set)")}`
            : `  ${stamp(entry.created_at)} ${dim(`first set (${missing} older edit(s) not shown)`)}`,
        );
      }
      lines.push(...earlier.map(edit));
      ctx.send(entityId, lines.join("\n"));
      return;
    }

    default:
      ctx.send(entityId, unknownSubcommand("memory kv", verb, KV_USAGE));
  }
}
