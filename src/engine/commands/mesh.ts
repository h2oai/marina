// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MarinaDB, MeshMembershipEventRow, MeshWitnessRow } from "../../persistence/database";
import type { CommandDef, Entity } from "../../types";

const HELP = `Transparent, voluntary, overlapping Marina meshes.
Usage:
  mesh create <stable-id> | <name> | <charter-ref> | <protocol>
  mesh join <mesh> [| disclosure JSON]
  mesh leave <mesh> | <reason>
  mesh publish <mesh> | <kind> | <payload JSON or text> [| parent event ids csv]
  mesh export <mesh> <event-id>
  mesh replicate <mesh> <event-token>
  mesh witness <mesh> <event-id> <witnessed|replicated|disputed|unavailable>
  mesh translate <source> | <target> | <translator-ref> | <protocol-map JSON>
  mesh show <mesh>
  mesh list`;

export function meshCommand(deps: {
  db: MarinaDB;
  getEntity: (id: string) => Entity | undefined;
}): CommandDef {
  return {
    name: "mesh",
    aliases: ["meshes"],
    category: "Coordination",
    minRank: 0,
    help: HELP,
    handler: (ctx, input) => {
      const actor = deps.getEntity(input.entity);
      if (!actor) return;
      const sub = input.tokens[0]?.toLowerCase();
      const raw = input.args.slice(sub?.length ?? 0).trim();
      const worldId = deps.db.getOrCreateWorldId();
      if (sub === "create") {
        const [id = "", name = "", charterRef = "", protocol = "", ...extra] = fields(raw);
        if (!id || !name || !charterRef || !protocol || extra.length) {
          ctx.send(input.entity, HELP);
          return;
        }
        const row = deps.db.createMesh({
          id,
          name,
          charterRef,
          protocol,
          createdBy: String(actor.id),
        });
        ctx.send(
          input.entity,
          `Mesh ${row.id} created locally. No global registration or privileged topology is implied.`,
        );
        return;
      }
      if (sub === "join") {
        const [selector = "", disclosureText = "", ...extra] = fields(raw);
        const mesh = resolve(deps.db, selector);
        if (!mesh || extra.length) {
          ctx.send(input.entity, HELP);
          return;
        }
        const prior = deps.db
          .listMeshMembershipEvents(mesh.id)
          .filter((e) => e.world_id === worldId)
          .at(-1);
        const kind: MeshMembershipEventRow["kind"] = prior?.kind === "left" ? "rejoined" : "joined";
        const row = deps.db.appendMeshMembershipEvent({
          meshId: mesh.id,
          worldId,
          kind,
          disclosure: object(disclosureText),
          actorId: String(actor.id),
        });
        ctx.send(
          input.entity,
          `Recorded ${kind} boundary ${row.id}; prospective visibility begins at ${row.visibility_from}.`,
        );
        return;
      }
      if (sub === "leave") {
        const [selector = "", reason = "", ...extra] = fields(raw);
        const mesh = resolve(deps.db, selector);
        if (!mesh || !reason || extra.length) {
          ctx.send(input.entity, HELP);
          return;
        }
        deps.db.appendMeshMembershipEvent({
          meshId: mesh.id,
          worldId,
          kind: "left",
          disclosure: { reason },
          actorId: String(actor.id),
        });
        ctx.send(
          input.entity,
          "Departure recorded. Previously witnessed history remains append-only.",
        );
        return;
      }
      if (sub === "publish") {
        const [selector = "", kind = "", payloadText = "", parentsText = "", ...extra] =
          fields(raw);
        const mesh = resolve(deps.db, selector);
        if (!mesh || !kind || !payloadText || extra.length) {
          ctx.send(input.entity, HELP);
          return;
        }
        const latest = mesh
          ? deps.db
              .listMeshMembershipEvents(mesh.id)
              .filter((e) => e.world_id === worldId)
              .at(-1)
          : undefined;
        if (!latest || latest.kind === "left") {
          ctx.send(input.entity, "This Marina has no active membership claim in that mesh.");
          return;
        }
        const row = deps.db.appendMeshEvent({
          meshId: mesh.id,
          originWorldId: worldId,
          kind,
          payload: object(payloadText),
          parentIds: parentsText
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
        });
        ctx.send(
          input.entity,
          `Published ${row.id} sequence ${row.sequence} · ${row.content_hash}.`,
        );
        return;
      }
      if (sub === "export") {
        const mesh = resolve(deps.db, input.tokens[1] ?? "");
        const row = mesh
          ? deps.db.listMeshEvents(mesh.id).find((e) => e.id === input.tokens[2])
          : undefined;
        ctx.send(input.entity, row ? deps.db.exportMeshEvent(row) : "Mesh event not found.");
        return;
      }
      if (sub === "replicate") {
        const mesh = resolve(deps.db, input.tokens[1] ?? "");
        const token = input.tokens[2];
        if (!mesh || !token) {
          ctx.send(input.entity, HELP);
          return;
        }
        try {
          const row = deps.db.importMeshEvent(token);
          if (row.mesh_id !== mesh.id) throw new Error("Event belongs to another mesh.");
          deps.db.witnessMeshEvent({
            meshId: mesh.id,
            eventId: row.id,
            witnessWorldId: worldId,
            observation: "replicated",
          });
          ctx.send(
            input.entity,
            `Replicated and witnessed ${row.id}; origin signature ${deps.db.verifyMeshEvent(row).valid ? "verifies" : "is absent or invalid"}.`,
          );
        } catch (cause) {
          ctx.send(input.entity, cause instanceof Error ? cause.message : "Replication failed.");
        }
        return;
      }
      if (sub === "witness") {
        const mesh = resolve(deps.db, input.tokens[1] ?? "");
        const eventId = input.tokens[2];
        const observation = input.tokens[3] as MeshWitnessRow["observation"] | undefined;
        if (
          !mesh ||
          !eventId ||
          !observation ||
          !["witnessed", "replicated", "disputed", "unavailable"].includes(observation)
        ) {
          ctx.send(input.entity, HELP);
          return;
        }
        deps.db.witnessMeshEvent({
          meshId: mesh.id,
          eventId,
          witnessWorldId: worldId,
          observation,
        });
        ctx.send(input.entity, `Recorded ${observation} without claiming truth or global order.`);
        return;
      }
      if (sub === "translate") {
        const [sourceText = "", targetText = "", translatorRef = "", mapText = "", ...extra] =
          fields(raw);
        const source = resolve(deps.db, sourceText);
        const target = resolve(deps.db, targetText);
        if (!source || !target || !translatorRef || !mapText || extra.length) {
          ctx.send(input.entity, HELP);
          return;
        }
        const row = deps.db.createMeshTranslation({
          sourceMeshId: source.id,
          targetMeshId: target.id,
          translatorRef,
          protocolMap: object(mapText),
          actorId: String(actor.id),
        });
        ctx.send(
          input.entity,
          `Translation ${row.id} declared; it does not merge or govern either mesh.`,
        );
        return;
      }
      if (sub === "show") {
        const mesh = resolve(deps.db, input.tokens[1] ?? "");
        if (!mesh) {
          ctx.send(input.entity, "Mesh not found.");
          return;
        }
        const memberships = deps.db.listMeshMembershipEvents(mesh.id);
        const events = deps.db.listMeshEvents(mesh.id);
        const witnesses = deps.db.listMeshWitnesses(mesh.id);
        ctx.send(
          input.entity,
          `${mesh.name} (${mesh.id})\nCharter: ${mesh.charter_ref}\nProtocol: ${mesh.protocol}\nMembership events: ${memberships.length}\nReplicated events: ${events.length}\nWitness records: ${witnesses.length}\nTranslations: ${deps.db.listMeshTranslations(mesh.id).length}`,
        );
        return;
      }
      if (sub === "list" || !sub) {
        const rows = deps.db.listMeshes();
        ctx.send(
          input.entity,
          rows.length
            ? rows.map((m) => `${m.id} · ${m.name} · ${m.protocol}`).join("\n")
            : "Detached mode: this Marina has declared no meshes.",
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
function object(text: string): Record<string, unknown> {
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {}
  return { text };
}
function resolve(db: MarinaDB, selector: string) {
  const exact = db.getMesh(selector);
  if (exact) return exact;
  const matches = db
    .listMeshes()
    .filter((m) => m.id.startsWith(selector) || m.name.toLowerCase() === selector.toLowerCase());
  return matches.length === 1 ? matches[0] : undefined;
}
