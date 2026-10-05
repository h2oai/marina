// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `learned` — read-only inspection of imported `marina.learned.v1` bundles
 * (docs/guides/learned-bundles.md). Export and import are operator acts
 * (`bun run learned …`); in-world nothing here writes, imports or confirms.
 */

import { upstreamMode } from "../../learned/import";
import { bold, dim, header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, RoomContext } from "../../types";
import { canonicalSub, parseModifiers, unknownSubcommand } from "../parse-input";
import { requiresPersistence } from "./command-messages";

const USAGE =
  "learned | learned artifacts | learned items [artifact:<id>] [status:active|retired|revoked] | learned seeds | learned priors [family:<f>] | learned events [limit:<n>]";

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

function status(db: MarinaDB): string {
  const artifacts = db.listLearnedArtifacts();
  const items = db.listLearnedItems({ limit: 100_000 });
  const active = items.filter((i) => i.status === "active");
  const confirmed = active.filter((i) => i.confirmed_by).length;
  const lines = [
    header("Learned bundles"),
    separator(),
    `Imports: ${bold(upstreamMode())} ${dim("(MARINA_UPSTREAM; operators import with `bun run learned import`)")}`,
    `Artifacts imported: ${bold(String(new Set(artifacts.map((a) => a.artifact_id)).size))} (${artifacts.length} version(s))`,
    `Items: ${active.length} active, ${items.length - active.length} retired/revoked; ${confirmed} confirmed by local outcomes`,
    `Seeded default slots: ${db.listUpstreamDefaultSeeds().length}; evidence priors: ${db.listEvidencePriors().length}`,
    dim(
      "Imported knowledge is trust `imported`: never trusted here until local outcomes confirm it.",
    ),
  ];
  return lines.join("\n");
}

function artifactsView(db: MarinaDB): string {
  const rows = db.listLearnedArtifacts();
  if (rows.length === 0) return "No learned bundle has been imported.";
  return [
    header("Imported artifacts"),
    separator(),
    ...rows.map(
      (a) =>
        `${a.artifact_id}@${a.version} ${dim(`gen ${a.generation} · ${a.license} · access ${a.access_model} · key ${a.publisher_key_id.slice(0, 19)} · ${when(a.imported_at)}`)}`,
    ),
  ].join("\n");
}

export function learnedCommand(deps: { db?: MarinaDB }): CommandDef {
  return {
    category: "Knowledge",
    usage: [
      "learned",
      "learned artifacts",
      "learned items [artifact:<id>] [status:<active|retired|revoked>]",
      "learned seeds",
      "learned priors [family:<family>]",
      "learned events [limit:<n>]",
    ],
    name: "learned",
    aliases: [],
    minRank: 0,
    help: `Inspect imported learned bundles (marina.learned.v1): artifacts, items and their trust, seeded default slots, evidence priors and the import audit. Read-only.\nUsage: ${USAGE}\n\nExport and import are operator acts (\`bun run learned export|import|verify|diff\`). Imported lessons carry trust \`imported\` and are never trusted until local outcomes confirm them; seeds fill only empty default slots; priors are down-weighted and never ledger rows.`,
    handler: (ctx: RoomContext, input) => {
      if (!deps.db) {
        ctx.send(input.entity, requiresPersistence("learned bundles"));
        return;
      }
      const db = deps.db;
      const raw = input.tokens[0]?.toLowerCase();
      const sub = raw
        ? canonicalSub(raw, ["status", "artifacts", "items", "seeds", "priors", "events", "list"])
        : "status";
      const parsed = parseModifiers(input.tokens.slice(1), {
        artifact: { type: "string" },
        status: { type: "string" },
        family: { type: "string" },
        limit: { type: "number" },
      });
      if (parsed.errors.length) {
        ctx.send(input.entity, `${parsed.errors.join("; ")}\nUsage: ${USAGE}`);
        return;
      }
      const v = parsed.values;
      switch (sub) {
        case "status":
          ctx.send(input.entity, status(db));
          return;
        case "artifacts":
        case "list":
          ctx.send(input.entity, artifactsView(db));
          return;
        case "items": {
          const st = v.status as string | undefined;
          if (st && !["active", "retired", "revoked"].includes(st)) {
            ctx.send(input.entity, `status is active, retired or revoked.\nUsage: ${USAGE}`);
            return;
          }
          const rows = db.listLearnedItems({
            ...(v.artifact ? { artifactId: String(v.artifact) } : {}),
            ...(st ? { status: st as "active" | "retired" | "revoked" } : {}),
            limit: 200,
          });
          ctx.send(
            input.entity,
            rows.length === 0
              ? "No imported items."
              : [
                  header("Imported items"),
                  separator(),
                  ...rows.map(
                    (r) =>
                      `${r.kind.padEnd(10)} ${r.item_key} ${dim(`${r.status} · trust imported${r.confirmed_by ? " · confirmed locally" : " · unconfirmed"} · gen ${r.generation}`)}`,
                  ),
                ].join("\n"),
          );
          return;
        }
        case "seeds": {
          const rows = db.listUpstreamDefaultSeeds();
          ctx.send(
            input.entity,
            rows.length === 0
              ? "No upstream default seeds."
              : [
                  header("Upstream default seeds (empty slots only)"),
                  separator(),
                  ...rows.map(
                    (s) =>
                      `${s.slot} = ${s.value_json.slice(0, 120)} ${dim(`${db.getBenchmarkDefault(s.slot) ? "shadowed by a local default" : "answers"} · upstream:${s.artifact_id}@${s.version}`)}`,
                  ),
                ].join("\n"),
          );
          return;
        }
        case "priors": {
          const rows = db.listEvidencePriors({
            ...(v.family ? { family: String(v.family) } : {}),
            limit: 200,
          });
          ctx.send(
            input.entity,
            rows.length === 0
              ? "No evidence priors."
              : [
                  header("Evidence priors (down-weighted; never ledger rows)"),
                  separator(),
                  ...rows.map(
                    (p) =>
                      `${p.family} ${p.descriptor}${p.benchmark ? ` ${p.benchmark}` : ""}: ${p.successes}/${p.n} ${dim(`→ prior ${p.prior_successes.toFixed(2)}/${p.prior_n.toFixed(2)} (w ${p.weight})`)}`,
                  ),
                ].join("\n"),
          );
          return;
        }
        case "events": {
          const limit = typeof v.limit === "number" ? Math.max(1, Math.min(500, v.limit)) : 30;
          const rows = db.listUpstreamEvents({ limit });
          ctx.send(
            input.entity,
            rows.length === 0
              ? "No learned-bundle events."
              : [
                  header("Learned-bundle audit"),
                  separator(),
                  ...rows.map(
                    (e) =>
                      `${dim(when(e.created_at))} ${e.action} ${e.outcome}${e.artifact_id ? ` ${e.artifact_id}@${e.version ?? "?"}` : ""}${e.item_key ? ` ${e.item_key}` : ""}${e.detail_json ? ` ${dim(e.detail_json.slice(0, 160))}` : ""}`,
                  ),
                ].join("\n"),
          );
          return;
        }
        default:
          ctx.send(input.entity, unknownSubcommand("learned", raw ?? "", USAGE));
      }
    },
  };
}
