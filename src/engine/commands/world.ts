// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { encodeRoleBundle, exportRoleBundle, missingTraits } from "../../agent/role-bundle";
import { bold, dim, header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { WorldVariantRow } from "../../persistence/db-world-variants";
import type { CommandDef, Entity } from "../../types";
import {
  adoptionLog,
  approveAdoption,
  parseAdoptionReply,
  rejectAdoption,
  requestAdoption,
  rollbackAdoption,
} from "../../world/adoption";
import { type ChildFetch, runInChild } from "../../world/child-bridge";
import type { WorldCollectiveManager } from "../../world/world-collective-manager";
import { getErrorMessage } from "../errors";
import { canonicalSub, unknownSubcommand } from "../parse-input";
import { evidenceSplit, judgedOn } from "./evolve";

const USAGE = [
  "Usage: world list",
  "       world create <name> [template] [| <hypothesis>]   — a child world (own process, DB, $50/day cap)",
  "       world start <name> | world stop <name>",
  "       world run <name> <command …>                     — run one command inside a running child",
  "       world seed-role <name> <role>                    — copy a role and its traits into the child",
  "       world adopt <child> <role> [into:<existing>]      — request bringing a role that EARNED its win home",
  "       world adopt approve|reject <id> [reason] · world adopt rollback <id> · world adopt list",
].join("\n");
const SUBS = ["list", "create", "start", "stop", "run", "seed-role", "adopt"];
const MAX_REPLY = 6_000;

/**
 * `world` — child and parallel worlds from inside the parent (World
 * Collective): create, start, stop, and the bridge that makes them usable —
 * `run` a command in a child and `seed-role` a role into it. Where trials of
 * candidate roles run, never in the parent. Same gate as `marina-descend`.
 */
export function worldCommand(deps: {
  db: MarinaDB;
  manager: () => WorldCollectiveManager;
  getEntity: (id: string) => Entity | undefined;
  fetcher?: ChildFetch;
  /** Live agent → role bindings (adoption never changes the role its approver runs on). */
  listAgents?: () => { name: string; role: string }[];
}): CommandDef {
  return {
    usage: [
      "world adopt <child> <role> [into:<existing>]",
      "world adopt approve <id> [reason] · world adopt rollback <id> · world adopt list",
      "world adopt reject <id> [reason] · world adopt rollback <id> · world adopt list",
      "world create <name> [template] [| <hypothesis>]",
      "world list",
      "world run <name> <command …>",
      "world seed-role <name> <role>",
      "world start <name>",
      "world stop <name>",
    ],
    name: "world",
    aliases: ["worlds"],
    category: "Lineage",
    minRank: 5,
    gate: "admin.destructive",
    help: `Child and parallel worlds: create, start, stop, run a command inside one, seed a role into it.\n${USAGE}`,
    handler: async (ctx, input) => {
      const actor = deps.getEntity(input.entity);
      if (!actor) return;
      const reply = (text: string) => ctx.send(input.entity, text);
      const sub = canonicalSub(input.tokens[0]?.toLowerCase() ?? "list", SUBS);
      const find = (ref: string | undefined): WorldVariantRow | undefined =>
        ref ? deps.db.listWorldVariants().find((v) => v.name === ref || v.id === ref) : undefined;

      if (sub === "list") {
        const rows = deps.db.listWorldVariants();
        if (rows.length === 0) return reply(`No child worlds yet.\n${dim(USAGE)}`);
        return reply(
          [
            header(`Child worlds (${rows.length})`),
            separator(),
            ...rows.map(
              (v) =>
                `  ${bold(v.name)} ${v.status} ${dim(`${v.world_template} · port ${v.ws_port}${v.last_error ? ` · ${v.last_error.slice(0, 80)}` : ""}`)}`,
            ),
          ].join("\n"),
        );
      }

      if (sub === "adopt") {
        return handleAdopt(deps, actor, input.tokens.slice(1), reply);
      }

      if (sub === "create") {
        const [head = "", hypothesis = ""] = input.args
          .replace(/^\s*\S+\s*/, "")
          .split("|")
          .map((s) => s.trim());
        const [name, template = "empty"] = head.split(/\s+/);
        if (!name) return reply(USAGE);
        try {
          const v = deps.manager().create({
            name,
            worldTemplate: template,
            hypothesis,
            createdBy: String(actor.id),
          });
          return reply(
            `Created child world ${bold(v.name)} (${v.world_template}, port ${v.ws_port}). Start it: world start ${v.name}`,
          );
        } catch (err) {
          return reply(`Not created: ${getErrorMessage(err)}`);
        }
      }

      const v = find(input.tokens[1]);
      if (!v) return reply(input.tokens[1] ? `No child world "${input.tokens[1]}".` : USAGE);

      if (sub === "start" || sub === "stop") {
        try {
          const row =
            sub === "start" ? await deps.manager().start(v.id) : await deps.manager().stop(v.id);
          return reply(
            `Child world ${bold(v.name)}: ${row?.status ?? "unknown"}${row?.last_error ? ` — ${row.last_error}` : ""}`,
          );
        } catch (err) {
          return reply(`Could not ${sub} ${v.name}: ${getErrorMessage(err)}`);
        }
      }

      if (v.status !== "running") {
        return reply(`Child world ${v.name} is ${v.status}; start it first: world start ${v.name}`);
      }

      if (sub === "run") {
        const command = input.tokens.slice(2).join(" ").trim();
        if (!command) return reply(USAGE);
        const r = await runInChild(v.ws_port, actor.name, command, { fetcher: deps.fetcher });
        if (!r.ok) return reply(`${v.name}: ${r.error}`);
        const text = r.text.length > MAX_REPLY ? `${r.text.slice(0, MAX_REPLY)}\n…` : r.text;
        return reply(`${dim(`[${v.name}] ${command}`)}\n${text}`);
      }

      if (sub === "seed-role") {
        const roleName = input.tokens[2];
        const bundle = roleName ? exportRoleBundle(deps.db, roleName) : undefined;
        if (!bundle) return reply(roleName ? `Role "${roleName}" not found here.` : USAGE);
        const r = await runInChild(
          v.ws_port,
          actor.name,
          `role import ${encodeRoleBundle(bundle)}`,
          {
            fetcher: deps.fetcher,
          },
        );
        if (!r.ok) return reply(`${v.name}: ${r.error}`);
        const missing = missingTraits(bundle);
        return reply(
          `${dim(`[${v.name}]`)} ${r.text.trim()}${missing.length ? `\n${dim(`Not found here, so not sent: trait(s) ${missing.join(", ")}`)}` : ""}`,
        );
      }

      reply(unknownSubcommand("world", input.tokens[0] ?? "", USAGE));
    },
  };
}

async function handleAdopt(
  deps: {
    db: MarinaDB;
    fetcher?: ChildFetch;
    listAgents?: () => { name: string; role: string }[];
  },
  actor: Entity,
  tokens: string[],
  reply: (text: string) => void,
): Promise<void> {
  const action = tokens[0]?.toLowerCase();
  const agents = deps.listAgents?.() ?? [];
  const pct = (x: number) => (x * 100).toFixed(1);
  if (!action || action === "list") {
    const log = adoptionLog(deps.db);
    if (log.length === 0) return reply("No adoptions yet.");
    return reply(
      [
        header("Adoptions"),
        separator(),
        ...log.map(
          (r) =>
            `  #${r.id} ${bold(r.status)} ${r.role}${r.into ? ` → ${r.into}` : ""} from ${r.child} ${dim(`requested by ${r.requestedBy}${r.approvedBy ? `, approved by ${r.approvedBy}` : ""} · +${pct(r.offer.evidence.delta)} (95% ${pct(r.offer.evidence.interval[0])}–${pct(r.offer.evidence.interval[1])})`)}`,
        ),
      ].join("\n"),
    );
  }
  if (action === "approve" || action === "reject" || action === "rollback") {
    const id = Number(tokens[1]);
    if (!Number.isInteger(id)) return reply(`Usage: world adopt ${action} <id>`);
    const r =
      action === "approve"
        ? approveAdoption(deps.db, id, actor, agents)
        : action === "reject"
          ? rejectAdoption(deps.db, id, actor, tokens.slice(2).join(" ") || "no reason given")
          : rollbackAdoption(deps.db, id, actor, agents);
    if ("reason" in r) return reply(`Not done: ${r.reason}`);
    const target = r.into ?? r.role;
    return reply(
      r.status === "applied"
        ? `Adoption #${r.id} applied: role "${target}" now holds ${r.role} from ${r.child}. Running agents are unchanged until \`role reload ${target}\`; undo with \`world adopt rollback ${r.id}\`.`
        : `Adoption #${r.id} ${r.status}.`,
    );
  }
  // world adopt <child> <role> [into:<existing>]
  const [childRef, role, ...rest] = tokens;
  const into = rest.find((t) => t.startsWith("into:"))?.slice("into:".length);
  const v = deps.db.listWorldVariants().find((x) => x.name === childRef || x.id === childRef);
  if (!v || !role) return reply(USAGE);
  if (v.status !== "running") return reply(`Child world ${v.name} is ${v.status}; start it first.`);
  const res = await runInChild(v.ws_port, actor.name, `evolve adoption ${role}`, {
    fetcher: deps.fetcher,
  });
  if (!res.ok) return reply(`${v.name}: ${res.error}`);
  const offer = parseAdoptionReply(res.text);
  if ("reason" in offer) return reply(`${v.name}: ${offer.reason}`);
  const rec = requestAdoption(deps.db, {
    child: v.name,
    role,
    ...(into ? { into } : {}),
    requestedBy: actor.name,
    offer,
  });
  if ("reason" in rec) return reply(`Not requested: ${rec.reason}`);
  const e = offer.evidence;
  return reply(
    [
      header(`Adoption #${rec.id} requested: ${role}${into ? ` → ${into}` : ""}`),
      separator(),
      `  from ${v.name}: run ${e.run} (${e.experiment}) accepted — evaluated by ${e.evaluator ?? "?"}, decided by ${e.reviewer ?? "?"}`,
      `  ${e.candidateRole} ${pct(e.candidateScore)}% vs ${e.incumbentRole} ${pct(e.incumbentScore)}% on ${judgedOn(e)}: +${pct(e.delta)} (95% ${pct(e.interval[0])} to ${pct(e.interval[1])})`,
      ...(evidenceSplit(e) ? [`  ${evidenceSplit(e)}`] : []),
      dim(
        `  Someone other than ${actor.name} applies it: world adopt approve ${rec.id} — or world adopt reject ${rec.id} <reason>${into ? `. Replacing "${into}" needs role.edit.` : ""}`,
      ),
    ].join("\n"),
  );
}
