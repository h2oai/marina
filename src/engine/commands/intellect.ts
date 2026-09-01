// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { bold, dim, header, separator, status } from "../../net/ansi";
import {
  INTELLECT_EVENT_KINDS,
  type IntellectEventKind,
  type MarinaDB,
} from "../../persistence/database";
import type { CommandDef, Entity, RoomContext } from "../../types";

const HELP = `Intellect — portable cognitive identity and append-only lifecycle claims.

Usage:
  intellect create <name> | <purpose> [| contributor-ids]
  intellect instance <intellect> | <principal-id> | <model-ref> | <harness-ref> | <environment-ref>
  intellect descend <parent> <name> | <purpose>
  intellect event <intellect> <kind> | <detail>
  intellect show <id>
  intellect list

Lifecycle kinds: ${INTELLECT_EVENT_KINDS.join(", ")}`;

export function intellectCommand(deps: {
  db: MarinaDB;
  getEntity: (id: string) => Entity | undefined;
}): CommandDef {
  return {
    name: "intellect",
    aliases: ["intellects"],
    category: "Growth",
    minRank: 0,
    help: HELP,
    handler: (ctx, input) => {
      const actor = deps.getEntity(input.entity);
      if (!actor) return;
      const sub = input.tokens[0]?.toLowerCase();
      const raw = input.args.slice(sub?.length ?? 0).trim();
      if (sub === "create") return create(ctx, input.entity, deps.db, actor, raw);
      if (sub === "instance") return instance(ctx, input.entity, deps.db, actor, raw);
      if (sub === "descend") return descend(ctx, input.entity, deps.db, actor, raw);
      if (sub === "event") return lifecycle(ctx, input.entity, deps.db, actor, raw);
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
  const [name = "", purpose = "", contributorText = ""] = raw.split("|").map((part) => part.trim());
  if (!name || name.length > 100 || purpose.length > 4000) {
    ctx.send(caller, "Usage: intellect create <name> | <purpose> [| contributor-ids]");
    return;
  }
  const contributors = contributorText
    ? contributorText
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [String(actor.id)];
  const intellect = db.createIntellect({
    displayName: name,
    purpose,
    originMarina: process.env.MARINA_NAME ?? "local",
    createdBy: String(actor.id),
    contributors,
  });
  ctx.send(
    caller,
    `${header("Intellect created")}\n${separator()}\n  ${bold(intellect.id)} ${intellect.display_name}\n  ${intellect.purpose || dim("No declared purpose")}`,
  );
}

function instance(
  ctx: RoomContext,
  caller: Parameters<RoomContext["send"]>[0],
  db: MarinaDB,
  actor: Entity,
  raw: string,
): void {
  const [selector = "", principal = "", model = "", harness = "", environment = ""] = raw
    .split("|")
    .map((part) => part.trim());
  const intellect = resolve(db, selector);
  if (!intellect) {
    ctx.send(caller, `Intellect "${selector}" was not found or is ambiguous.`);
    return;
  }
  if (principal && !db.listPrincipals().some((item) => item.principal_id === principal)) {
    ctx.send(
      caller,
      `Local principal "${principal}" does not exist. Use an empty field for a detached instance.`,
    );
    return;
  }
  const row = db.createIntellectInstance({
    intellectId: intellect.id,
    localPrincipalId: principal || undefined,
    modelRef: model || undefined,
    harnessRef: harness || undefined,
    environmentRef: environment || undefined,
    createdBy: String(actor.id),
  });
  ctx.send(
    caller,
    `Declared instance ${row.id} for ${intellect.id}. Model and harness remain distinct claims.`,
  );
}

function descend(
  ctx: RoomContext,
  caller: Parameters<RoomContext["send"]>[0],
  db: MarinaDB,
  actor: Entity,
  raw: string,
): void {
  const [head = "", purpose = ""] = raw.split("|").map((part) => part.trim());
  const space = head.indexOf(" ");
  const parent = resolve(db, space < 0 ? head : head.slice(0, space));
  const name = space < 0 ? "" : head.slice(space + 1).trim();
  if (!parent || !name) {
    ctx.send(caller, "Usage: intellect descend <parent> <name> | <purpose>");
    return;
  }
  const child = db.createIntellect({
    displayName: name,
    purpose,
    originMarina: process.env.MARINA_NAME ?? "local",
    createdBy: String(actor.id),
    contributors: [String(actor.id), parent.id],
  });
  db.appendIntellectEvent({
    intellectId: child.id,
    kind: "descended",
    actorId: String(actor.id),
    relatedIntellectId: parent.id,
    data: { relationship: "descendant_of" },
  });
  db.appendIntellectEvent({
    intellectId: parent.id,
    kind: "descended",
    actorId: String(actor.id),
    relatedIntellectId: child.id,
    data: { relationship: "created_descendant" },
  });
  ctx.send(
    caller,
    `Created independent descendant ${child.id} from ${parent.id}. No ownership is implied.`,
  );
}

function lifecycle(
  ctx: RoomContext,
  caller: Parameters<RoomContext["send"]>[0],
  db: MarinaDB,
  actor: Entity,
  raw: string,
): void {
  const [head = "", detail = ""] = raw.split("|").map((part) => part.trim());
  const [selector, rawKind, ...extra] = head.split(/\s+/);
  const intellect = resolve(db, selector ?? "");
  if (!intellect || !isKind(rawKind) || extra.length || !detail) {
    ctx.send(
      caller,
      `Usage: intellect event <intellect> <kind> | <detail>\nKinds: ${INTELLECT_EVENT_KINDS.join(", ")}`,
    );
    return;
  }
  const event = db.appendIntellectEvent({
    intellectId: intellect.id,
    kind: rawKind,
    actorId: String(actor.id),
    data: { detail },
  });
  ctx.send(caller, `Recorded ${event.kind} claim #${event.id} for ${intellect.id}.`);
}

function show(
  ctx: RoomContext,
  caller: Parameters<RoomContext["send"]>[0],
  db: MarinaDB,
  selector?: string,
): void {
  const intellect = resolve(db, selector ?? "");
  if (!intellect) {
    ctx.send(caller, `Intellect "${selector ?? ""}" was not found or is ambiguous.`);
    return;
  }
  // Newest 200 events for display; the lifecycle state comes from a dedicated
  // keyed query so a long event tail can never hide the last lifecycle change.
  const events = db.listIntellectEvents(intellect.id, 200);
  const instances = db.listIntellectInstances(intellect.id);
  const signedEvents = events.filter((event) => event.signature_json);
  // Cap Ed25519 verification on this rank-0 command; newest window only.
  const checkedEvents = signedEvents.slice(-100);
  const validSignatures = checkedEvents.filter(
    (event) => db.verifyIntellectEvent(event).valid,
  ).length;
  const lifecycleKind = db.getLatestIntellectLifecycleKind(intellect.id);
  const lines = [
    header(`Intellect: ${intellect.display_name}`),
    separator(),
    `${bold("ID:")} ${intellect.id}`,
    `${bold("Origin:")} ${intellect.origin_marina}`,
    `${bold("Purpose:")} ${intellect.purpose || dim("undeclared")}`,
    `${bold("Observed state:")} ${status(lifecycleKind ?? "created", lifecycleKind === "terminated" ? "warn" : "info")}`,
    `${bold("Instances:")} ${instances.length}`,
    `${bold("Signatures:")} ${validSignatures}/${checkedEvents.length} signed events verify${signedEvents.length > checkedEvents.length ? ` (newest 100 of ${signedEvents.length} checked)` : ""}`,
  ];
  for (const row of instances)
    lines.push(
      `  ${row.id} · model=${row.model_ref ?? "unknown"} · harness=${row.harness_ref ?? "unknown"} · principal=${row.local_principal_id ?? "detached"}`,
    );
  lines.push("", bold(events.length === 200 ? "Lifecycle (newest 200):" : "Lifecycle:"));
  for (const event of events)
    lines.push(
      `  #${event.id} ${event.kind} — ${event.actor_id}${event.related_intellect_id ? ` · ${event.related_intellect_id}` : ""}${event.signature_json ? " · signed" : ""}`,
    );
  ctx.send(caller, lines.join("\n"));
}

function list(ctx: RoomContext, caller: Parameters<RoomContext["send"]>[0], db: MarinaDB): void {
  const rows = db.listIntellects();
  ctx.send(
    caller,
    rows.length
      ? [
          header("Intellects"),
          separator(),
          ...rows.map((row) => `  ${bold(row.id)} ${row.display_name}`),
        ].join("\n")
      : "No portable intellect identities have been declared. Existing agents remain valid.",
  );
}

function resolve(db: MarinaDB, selector: string) {
  if (!selector) return undefined;
  const exact = db.getIntellect(selector);
  if (exact) return exact;
  const matches = db.findIntellectsByIdPrefix(selector);
  return matches.length === 1 ? matches[0] : undefined;
}

function isKind(value: string | undefined): value is IntellectEventKind {
  return INTELLECT_EVENT_KINDS.includes(value as IntellectEventKind);
}
