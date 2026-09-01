// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { MarinaDB, MutationDisposition } from "../../persistence/database";
import type { CommandDef, Entity } from "../../types";

const DISPOSITIONS = ["proposed", "adopted", "rejected", "branched", "observed"] as const;
const HELP = `Recursive, signature-capable mutation lineage across cognition and civilization.
Usage:
  mutation record <domain> <target-ref> | <disposition> | <summary> | <patch JSON> [| parent mutation ids csv] [| evidence refs csv] [| descendant-ref]
  mutation genome <parent-genome-hash> | <summary> | <patch JSON> [| evidence refs csv]
  mutation show <id>
  mutation lineage <domain> <target-ref>
  mutation list [domain]
Domains are open: cognition, association, institution, charter, federation, reproduction, genome, protocol, or future forms.`;
export function mutationCommand(deps: {
  db: MarinaDB;
  getEntity: (id: string) => Entity | undefined;
}): CommandDef {
  return {
    name: "mutation",
    aliases: ["mutations"],
    category: "Growth",
    minRank: 0,
    help: HELP,
    handler: (ctx, input) => {
      const actor = deps.getEntity(input.entity);
      if (!actor) return;
      const sub = input.tokens[0]?.toLowerCase();
      const raw = input.args.slice(sub?.length ?? 0).trim();
      if (sub === "record") {
        const [
          head = "",
          dispositionText = "",
          summary = "",
          patchText = "",
          parentsText = "",
          evidenceText = "",
          descendantRef = "",
          ...extra
        ] = fields(raw);
        const space = head.indexOf(" ");
        const domain = space < 0 ? "" : head.slice(0, space);
        const targetRef = space < 0 ? "" : head.slice(space + 1).trim();
        const patch = parseObject(patchText);
        if (
          !domain ||
          !targetRef ||
          !isDisposition(dispositionText) ||
          !summary ||
          !patch ||
          extra.length
        ) {
          ctx.send(input.entity, HELP);
          return;
        }
        const row = deps.db.appendCivilizationMutation({
          domain,
          targetRef,
          summary,
          patch,
          parentIds: csv(parentsText),
          evidenceRefs: csv(evidenceText),
          descendantRef: descendantRef || undefined,
          disposition: dispositionText,
          createdBy: String(actor.id),
        });
        ctx.send(
          input.entity,
          `Mutation ${row.id} recorded as ${row.disposition}; target history was not rewritten.`,
        );
        return;
      }
      if (sub === "genome") {
        const [parentHash = "", summary = "", patchText = "", evidenceText = "", ...extra] =
          fields(raw);
        const parent = deps.db.getMarinaGenome(parentHash);
        const patch = parseObject(patchText);
        if (!parent || !summary || !patch || extra.length) {
          ctx.send(input.entity, HELP);
          return;
        }
        const manifest = {
          ...(JSON.parse(parent.manifest_json) as Record<string, unknown>),
          ...patch,
        };
        delete manifest.schema;
        const child = deps.db.createMarinaGenome({ manifest, createdBy: String(actor.id) });
        const row = deps.db.appendCivilizationMutation({
          domain: "reproduction",
          targetRef: `genome:${parent.hash}`,
          summary,
          patch,
          evidenceRefs: csv(evidenceText),
          descendantRef: `genome:${child.hash}`,
          disposition: "branched",
          createdBy: String(actor.id),
        });
        ctx.send(
          input.entity,
          `Derived genome ${child.hash} through mutation ${row.id}. It can produce a sovereign Marina descendant.`,
        );
        return;
      }
      if (sub === "show") {
        const row = deps.db.getCivilizationMutation(input.tokens[1] ?? "");
        if (!row) {
          ctx.send(input.entity, "Mutation not found.");
          return;
        }
        ctx.send(
          input.entity,
          `${row.id} · ${row.domain}:${row.target_ref}\n${row.disposition}: ${row.summary}\nPatch: ${row.patch_json}\nParents: ${row.parent_ids_json}\nEvidence: ${row.evidence_refs_json}\nDescendant: ${row.descendant_ref ?? "none"}\nSignature: ${
            row.signature_json
              ? deps.db.verifyCivilizationMutation(row).valid
                ? "verified"
                : "INVALID"
              : "unsigned"
          }`,
        );
        return;
      }
      if (sub === "lineage") {
        const domain = input.tokens[1];
        const target = input.tokens.slice(2).join(" ");
        if (!domain || !target) {
          ctx.send(input.entity, HELP);
          return;
        }
        const rows = deps.db.listCivilizationMutations(domain, target);
        ctx.send(
          input.entity,
          rows.length
            ? rows.map((r) => `${r.id} · ${r.disposition} · ${r.summary}`).join("\n")
            : "No mutations for that target.",
        );
        return;
      }
      if (sub === "list" || !sub) {
        const rows = deps.db.listCivilizationMutations(input.tokens[1]);
        ctx.send(
          input.entity,
          rows.length
            ? rows.map((r) => `${r.id} · ${r.domain}:${r.target_ref} · ${r.disposition}`).join("\n")
            : "No civilization mutations recorded.",
        );
        return;
      }
      ctx.send(input.entity, HELP);
    },
  };
}
function fields(raw: string) {
  return raw.split("|").map((x) => x.trim());
}
function csv(text: string) {
  return text
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}
function parseObject(text: string): Record<string, unknown> | undefined {
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {}
  return undefined;
}
function isDisposition(v: string): v is MutationDisposition {
  return DISPOSITIONS.includes(v as MutationDisposition);
}
