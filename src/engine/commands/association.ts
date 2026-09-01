// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { bold, dim, header, separator, status } from "../../net/ansi";
import {
  ASSOCIATION_DIRECTIONS,
  ASSOCIATION_EVENT_KINDS,
  type AssociationDirection,
  type AssociationEventKind,
  type MarinaDB,
} from "../../persistence/database";
import type { CommandDef, Entity, RoomContext } from "../../types";

const HELP = `Association — open, attributable relationships across Marina primitives and worlds.

Usage:
  association create <name> | <purpose>
  association join <association> | <kind>:<ref> | <role or interpretation>
  association leave <association> | <kind>:<ref> | <reason>
  association relate <association> | <kind>:<ref> | <directed|reciprocal> | <semantics> | <kind>:<ref> [| JSON terms or text]
  association revise <association> | <relation-id> | <kind>:<ref> | <directed|reciprocal> | <semantics> | <kind>:<ref> [| JSON terms or text]
  association link <association> | <canonical-kind>:<ref> | <relationship>
  association event <association> <kind> | <detail>
  association show <association>
  association list

Kinds are open vocabularies. Examples include human, intellect, instance, organization, tool,
provider, marina, mesh, channel, group, crew, project, score, and market.`;

export function associationCommand(deps: {
  db: MarinaDB;
  getEntity: (id: string) => Entity | undefined;
}): CommandDef {
  return {
    name: "association",
    aliases: ["associations", "associate"],
    category: "Coordination",
    minRank: 0,
    help: HELP,
    handler: (ctx, input) => {
      const actor = deps.getEntity(input.entity);
      if (!actor) return;
      const sub = input.tokens[0]?.toLowerCase();
      const raw = input.args.slice(sub?.length ?? 0).trim();
      if (sub === "create") return create(ctx, input.entity, deps.db, actor, raw);
      if (sub === "join") return participation(ctx, input.entity, deps.db, actor, raw, "joined");
      if (sub === "leave") return participation(ctx, input.entity, deps.db, actor, raw, "left");
      if (sub === "relate") return relate(ctx, input.entity, deps.db, actor, raw);
      if (sub === "revise") return relate(ctx, input.entity, deps.db, actor, raw, true);
      if (sub === "link") return link(ctx, input.entity, deps.db, actor, raw);
      if (sub === "event") return event(ctx, input.entity, deps.db, actor, raw);
      if (sub === "show") return show(ctx, input.entity, deps.db, input.tokens[1]);
      if (sub === "list" || !sub) return list(ctx, input.entity, deps.db);
      ctx.send(input.entity, HELP);
    },
  };
}

function create(
  ctx: RoomContext,
  caller: Parameters<RoomContext["send"]>[0],
  db: MarinaDB,
  actor: Entity,
  raw: string,
): void {
  const [name = "", purpose = "", ...extra] = fields(raw);
  if (!name || name.length > 120 || purpose.length > 4000 || extra.length) {
    ctx.send(caller, "Usage: association create <name> | <purpose>");
    return;
  }
  const association = db.createAssociation({
    name,
    purpose,
    createdBy: String(actor.id),
  });
  ctx.send(
    caller,
    `${header("Association created")}\n${separator()}\n  ${bold(association.id)} ${association.name}\n  ${association.purpose || dim("No declared purpose")}`,
  );
}

function participation(
  ctx: RoomContext,
  caller: Parameters<RoomContext["send"]>[0],
  db: MarinaDB,
  actor: Entity,
  raw: string,
  kind: "joined" | "left",
): void {
  const [selector = "", subjectText = "", detail = "", ...extra] = fields(raw);
  const association = resolve(db, selector);
  const subject = parseTypedRef(subjectText);
  if (!association || !subject || extra.length || detail.length > 1000) {
    ctx.send(
      caller,
      `Usage: association ${kind === "joined" ? "join" : "leave"} <association> | <kind>:<ref> | <${kind === "joined" ? "role or interpretation" : "reason"}>`,
    );
    return;
  }
  const event = db.appendAssociationEvent({
    associationId: association.id,
    kind,
    actorId: String(actor.id),
    subjectKind: subject.kind,
    subjectRef: subject.ref,
    data: kind === "joined" ? { role: detail } : { reason: detail },
  });
  ctx.send(
    caller,
    `Recorded ${subject.kind}:${subject.ref} as ${kind} in ${association.id} (${event.id}). History remains append-only.`,
  );
}

function relate(
  ctx: RoomContext,
  caller: Parameters<RoomContext["send"]>[0],
  db: MarinaDB,
  actor: Entity,
  raw: string,
  revising = false,
): void {
  const parts = fields(raw);
  const [selector, priorId, sourceText, directionText, semantics, targetText, termsText, ...extra] =
    revising ? parts : [parts[0], undefined, ...parts.slice(1)];
  const association = resolve(db, selector ?? "");
  const source = parseTypedRef(sourceText ?? "");
  const target = parseTypedRef(targetText ?? "");
  const direction = isDirection(directionText) ? directionText : undefined;
  const prior = priorId
    ? db.listAssociationRelations(association?.id ?? "").find((row) => row.id === priorId)
    : undefined;
  if (
    !association ||
    !source ||
    !target ||
    !direction ||
    !semantics ||
    semantics.length > 500 ||
    extra.length ||
    (revising && !prior)
  ) {
    ctx.send(
      caller,
      revising
        ? "Usage: association revise <association> | <relation-id> | <kind>:<ref> | <directed|reciprocal> | <semantics> | <kind>:<ref> [| JSON terms or text]"
        : "Usage: association relate <association> | <kind>:<ref> | <directed|reciprocal> | <semantics> | <kind>:<ref> [| JSON terms or text]",
    );
    return;
  }
  const relation = db.declareAssociationRelation({
    associationId: association.id,
    sourceKind: source.kind,
    sourceRef: source.ref,
    targetKind: target.kind,
    targetRef: target.ref,
    semantics,
    direction,
    terms: parseTerms(termsText),
    supersedesId: prior?.id,
    actorId: String(actor.id),
  });
  ctx.send(
    caller,
    `${revising ? "Revised" : "Declared"} ${direction} relation ${relation.id}: ${sourceText} — ${semantics} → ${targetText}.`,
  );
}

function link(
  ctx: RoomContext,
  caller: Parameters<RoomContext["send"]>[0],
  db: MarinaDB,
  actor: Entity,
  raw: string,
): void {
  const [selector = "", refText = "", relationship = "", ...extra] = fields(raw);
  const association = resolve(db, selector);
  const ref = parseTypedRef(refText);
  if (!association || !ref || !relationship || relationship.length > 200 || extra.length) {
    ctx.send(
      caller,
      "Usage: association link <association> | <canonical-kind>:<ref> | <relationship>",
    );
    return;
  }
  const row = db.linkAssociation({
    associationId: association.id,
    kind: ref.kind,
    ref: ref.ref,
    relationship,
    actorId: String(actor.id),
  });
  ctx.send(caller, `Linked ${refText} to ${association.id} as ${relationship} (${row.id}).`);
}

function event(
  ctx: RoomContext,
  caller: Parameters<RoomContext["send"]>[0],
  db: MarinaDB,
  actor: Entity,
  raw: string,
): void {
  const [head = "", detail = "", ...extra] = fields(raw);
  const [selector, rawKind, ...headExtra] = head.split(/\s+/);
  const association = resolve(db, selector ?? "");
  if (
    !association ||
    !isEventKind(rawKind) ||
    rawKind === "created" ||
    rawKind === "joined" ||
    rawKind === "left" ||
    !detail ||
    detail.length > 4000 ||
    headExtra.length ||
    extra.length
  ) {
    ctx.send(
      caller,
      `Usage: association event <association> <kind> | <detail>\nKinds: ${ASSOCIATION_EVENT_KINDS.filter((kind) => !["created", "joined", "left"].includes(kind)).join(", ")}`,
    );
    return;
  }
  const row = db.appendAssociationEvent({
    associationId: association.id,
    kind: rawKind,
    actorId: String(actor.id),
    data: { detail },
  });
  ctx.send(caller, `Recorded ${rawKind} event ${row.id} for ${association.id}.`);
}

function show(
  ctx: RoomContext,
  caller: Parameters<RoomContext["send"]>[0],
  db: MarinaDB,
  selector?: string,
): void {
  const association = resolve(db, selector ?? "");
  if (!association) {
    ctx.send(caller, `Association "${selector ?? ""}" was not found or is ambiguous.`);
    return;
  }
  const events = db.listAssociationEvents(association.id);
  const relations = db.listAssociationRelations(association.id);
  const links = db.listAssociationLinks(association.id);
  const projection = db.projectAssociation(association.id);
  const signed = [...events, ...relations, ...links].filter((row) => row.signature_json);
  const valid = [
    ...events.map((row) => db.verifyAssociationEvent(row)),
    ...relations.map((row) => db.verifyAssociationRelation(row)),
    ...links.map((row) => db.verifyAssociationLink(row)),
  ].filter((result) => result.valid).length;
  const lines = [
    header(`Association: ${association.name}`),
    separator(),
    `${bold("ID:")} ${association.id}`,
    `${bold("Purpose:")} ${association.purpose || dim("undeclared")}`,
    `${bold("Observed state:")} ${status(projection.active ? "active" : "dissolved", projection.active ? "active" : "warn")}`,
    `${bold("Signatures:")} ${valid}/${signed.length} signed records verify`,
    "",
    bold("Participants:"),
  ];
  if (!projection.participants.length) lines.push(`  ${dim("No participation claims")}`);
  for (const participant of projection.participants) {
    lines.push(
      `  ${participant.kind}:${participant.ref} · ${participant.active ? "active" : "left"}${participant.role ? ` · ${participant.role}` : ""}`,
    );
  }
  lines.push("", bold("Current relations:"));
  if (!projection.relations.length) lines.push(`  ${dim("No relation declarations")}`);
  for (const relation of projection.relations) {
    const arrow = relation.direction === "reciprocal" ? "↔" : "→";
    lines.push(
      `  ${relation.id} · ${relation.source_kind}:${relation.source_ref} ${arrow} ${relation.target_kind}:${relation.target_ref} · ${relation.semantics}`,
    );
  }
  lines.push("", bold("Canonical links:"));
  if (!links.length) lines.push(`  ${dim("No links")}`);
  for (const row of links) lines.push(`  ${row.kind}:${row.ref} · ${row.relationship}`);
  lines.push(
    "",
    `${bold("History:")} ${events.length} events, ${relations.length} relation claims`,
  );
  ctx.send(caller, lines.join("\n"));
}

function list(ctx: RoomContext, caller: Parameters<RoomContext["send"]>[0], db: MarinaDB): void {
  const rows = db.listAssociations();
  ctx.send(
    caller,
    rows.length
      ? [
          header("Associations"),
          separator(),
          ...rows.map((row) => {
            const projection = db.projectAssociation(row.id);
            const active = projection.participants.filter(
              (participant) => participant.active,
            ).length;
            return `  ${bold(row.id)} ${row.name} · ${active} active participants`;
          }),
        ].join("\n")
      : "No generalized associations have been declared. Existing coordination remains available.",
  );
}

function fields(raw: string): string[] {
  return raw.split("|").map((part) => part.trim());
}

function parseTypedRef(value: string): { kind: string; ref: string } | undefined {
  const colon = value.indexOf(":");
  if (colon < 1) return undefined;
  const kind = value.slice(0, colon).trim();
  const ref = value.slice(colon + 1).trim();
  if (!kind || !ref || kind.length > 80 || ref.length > 500) return undefined;
  return { kind, ref };
}

function parseTerms(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {}
  return { text: value };
}

function resolve(db: MarinaDB, selector: string) {
  if (!selector) return undefined;
  const exact = db.getAssociation(selector);
  if (exact) return exact;
  const normalized = selector.toLowerCase();
  const matches = db
    .listAssociations(500)
    .filter((row) => row.id.startsWith(selector) || row.name.toLowerCase() === normalized);
  return matches.length === 1 ? matches[0] : undefined;
}

function isDirection(value: string | undefined): value is AssociationDirection {
  return ASSOCIATION_DIRECTIONS.includes(value as AssociationDirection);
}

function isEventKind(value: string | undefined): value is AssociationEventKind {
  return ASSOCIATION_EVENT_KINDS.includes(value as AssociationEventKind);
}
