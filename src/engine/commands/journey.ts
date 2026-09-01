// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { bold, dim, header, separator, status } from "../../net/ansi";
import {
  JOURNEY_EVENT_KINDS,
  JOURNEY_LINK_KINDS,
  type JourneyEventKind,
  type JourneyLinkKind,
  type JourneyRow,
  type MarinaDB,
} from "../../persistence/database";
import type { CommandDef, Entity, RoomContext } from "../../types";
import { projectJourneyProgress, projectJourneyResults } from "../journey-projection";
import { type JourneyWorkEvidence, projectJourneyState } from "../journey-state";

const HELP = `Journey — correlate one original desire with existing Marina work and evidence.

Usage:
  journey create <desire>
  journey list [all]
  journey show <id|latest>
  journey progress <id|latest>
  journey changes <id|latest>
  journey result <id|latest>
  journey steer <id|latest> <context or correction>
  journey link <id|latest> <kind> <ref> [relationship]
  journey record <id|latest> <event> | <summary> [| <ref-kind>:<ref>]

Link kinds: ${JOURNEY_LINK_KINDS.join(", ")}
Events: ${JOURNEY_EVENT_KINDS.join(", ")}

Journey state is projected from append-only evidence and live linked work; it is never set directly.`;

export function journeyCommand(deps: {
  db: MarinaDB;
  getEntity: (id: string) => Entity | undefined;
}): CommandDef {
  return {
    name: "journey",
    aliases: ["journeys"],
    category: "Cognition",
    minRank: 0,
    help: HELP,
    handler: (ctx, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const sub = input.tokens[0]?.toLowerCase();
      switch (sub) {
        case "create":
          return create(ctx, input.entity, entity, deps.db, afterSubcommand(input.args, "create"));
        case "list":
          return list(ctx, input.entity, deps.db, entity, input.tokens[1]?.toLowerCase() === "all");
        case "show":
          return show(ctx, input.entity, deps.db, entity, input.tokens[1]);
        case "progress":
          return progress(ctx, input.entity, deps.db, entity, input.tokens[1]);
        case "changes":
          return changes(ctx, input.entity, deps.db, entity, input.tokens[1]);
        case "result":
          return result(ctx, input.entity, deps.db, entity, input.tokens[1]);
        case "steer":
          return steer(ctx, input.entity, deps.db, entity, afterSubcommand(input.args, "steer"));
        case "link":
          return link(ctx, input.entity, deps.db, entity, input.tokens.slice(1));
        case "record":
          return record(ctx, input.entity, deps.db, entity, afterSubcommand(input.args, "record"));
        case undefined:
          return list(ctx, input.entity, deps.db, entity, false);
        default:
          ctx.send(input.entity, `Unknown journey subcommand: ${sub}\n\n${HELP}`);
      }
    },
  };
}

function changes(
  ctx: RoomContext,
  caller: Parameters<RoomContext["send"]>[0],
  db: MarinaDB,
  entity: Entity,
  selector: string | undefined,
): void {
  const journey = resolveJourney(db, entity.id, selector);
  if (!journey) {
    ctx.send(caller, missingJourney(selector));
    return;
  }
  const events = db.listJourneyEvents(journey.id, 1000);
  const witness = db.getJourneyWitness(journey.id, entity.id);
  const unseen = events.filter((event) => event.id > (witness?.witnessed_event_id ?? 0));
  const meaningful = projectJourneyProgress(unseen);
  const state = project(db, journey);
  const results = projectJourneyResults(db, journey);
  const lines = [header(`Since you last looked: ${journey.id}`), separator()];
  if (meaningful.length === 0) {
    lines.push("Nothing meaningfully changed.");
  } else {
    for (const item of meaningful.slice(-20)) {
      lines.push(`  ${item.summary} ${dim(`— ${item.contributor} · ${item.evidence}`)}`);
    }
    if (meaningful.length > 20) {
      lines.push(dim(`  … ${meaningful.length - 20} earlier changes`));
    }
  }
  lines.push("", `${bold("Current state:")} ${state.state}`);
  lines.push(
    results.current
      ? `${bold(results.current.partial ? "Current partial result:" : "Current result:")} ${results.current.summary}`
      : `${bold("Current result:")} none recorded yet`,
  );
  const latestEventId = events.at(-1)?.id ?? 0;
  try {
    db.witnessJourney(journey.id, entity.id, latestEventId);
  } catch {
    // Witness cursors are pure presentation state ("since you last looked") —
    // a failed write must never break a read command.
  }
  ctx.send(caller, lines.join("\n"));
}

function progress(
  ctx: RoomContext,
  caller: Parameters<RoomContext["send"]>[0],
  db: MarinaDB,
  entity: Entity,
  selector: string | undefined,
): void {
  const journey = resolveJourney(db, entity.id, selector);
  if (!journey) {
    ctx.send(caller, missingJourney(selector));
    return;
  }
  const projection = projectJourneyProgress(db.listJourneyEvents(journey.id));
  const lines = [header(`Meaningful progress: ${journey.id}`), separator()];
  if (projection.length === 0) {
    lines.push("No meaningful change has been recorded yet.");
  } else {
    for (const item of projection.slice(-20)) {
      lines.push(
        `  ${status(item.kind.replaceAll("_", " "), progressTone(item.kind))} ${item.summary}`,
        `    ${dim(`${item.contributor} · ${item.evidence}`)}`,
      );
    }
  }
  lines.push("", dim(`Inspect all correlations: journey show ${journey.id}`));
  ctx.send(caller, lines.join("\n"));
}

function result(
  ctx: RoomContext,
  caller: Parameters<RoomContext["send"]>[0],
  db: MarinaDB,
  entity: Entity,
  selector: string | undefined,
): void {
  const journey = resolveJourney(db, entity.id, selector);
  if (!journey) {
    ctx.send(caller, missingJourney(selector));
    return;
  }
  const projection = projectJourneyResults(db, journey);
  const lines = [header(`Current result: ${journey.id}`), separator()];
  if (!projection.current) {
    lines.push("No result has been recorded or submitted yet.");
    lines.push(dim("This is not a failure claim; the journey may still be grounding or active."));
    ctx.send(caller, lines.join("\n"));
    return;
  }
  const current = projection.current;
  lines.push(
    `${bold(current.partial ? "Partial result:" : "Result:")} ${current.summary}`,
    `${bold("Evidence:")} ${current.evidence.join(", ")}`,
    `${bold("Contributor:")} ${current.contributor}`,
  );
  if (current.canonical) {
    lines.push(
      `${bold("Canonical record:")} ${current.canonical.kind}:${current.canonical.ref} — ${current.canonical.title}`,
      `${bold("Record status:")} ${current.canonical.status ?? "recorded"}`,
    );
  }
  if (projection.uncertainty.length > 0) {
    lines.push("", bold("Uncertainty and dissent:"));
    for (const item of projection.uncertainty) lines.push(`  ${item}`);
  }
  if (projection.alternatives.length > 0) {
    lines.push("", bold("Other recorded results:"));
    for (const item of projection.alternatives.slice(0, 5)) {
      lines.push(
        `  ${item.partial ? "[partial] " : ""}${item.summary} ${dim(item.evidence.join(", "))}`,
      );
    }
  }
  if (projection.contributors.length > 0) {
    lines.push("", `${bold("Contributors:")} ${projection.contributors.join(", ")}`);
  }
  if (projection.continuation) {
    lines.push(`${bold("Continuation:")} ${projection.continuation}`);
  }
  ctx.send(caller, lines.join("\n"));
}

function steer(
  ctx: RoomContext,
  caller: Parameters<RoomContext["send"]>[0],
  db: MarinaDB,
  entity: Entity,
  raw: string,
): void {
  const firstSpace = raw.indexOf(" ");
  const selector = firstSpace === -1 ? raw : raw.slice(0, firstSpace);
  const summary = firstSpace === -1 ? "" : raw.slice(firstSpace + 1).trim();
  const journey = resolveJourney(db, entity.id, selector);
  if (!journey) {
    ctx.send(caller, missingJourney(selector || undefined));
    return;
  }
  if (!summary || summary.length > 4000) {
    ctx.send(caller, "Usage: journey steer <id|latest> <context or correction>");
    return;
  }
  const event = db.appendJourneyEvent({
    journeyId: journey.id,
    kind: "interpretation",
    summary,
    actorId: entity.id,
    actorName: entity.name,
  });
  ctx.send(
    caller,
    `Steering recorded as journey event #${event.id}; the original desire remains unchanged.`,
  );
}

function create(
  ctx: RoomContext,
  caller: Parameters<RoomContext["send"]>[0],
  entity: Entity,
  db: MarinaDB,
  rawExpression: string,
): void {
  const expression = rawExpression.trim();
  if (!expression) {
    ctx.send(caller, "Usage: journey create <desire>");
    return;
  }
  if (expression.length > 4000) {
    ctx.send(caller, "A journey desire must be 4,000 characters or fewer.");
    return;
  }
  const journey = db.createJourney({
    requesterId: entity.id,
    requesterName: entity.name,
    expression,
  });
  ctx.send(
    caller,
    [
      header("Journey expressed"),
      separator(),
      `  ${bold(journey.id)}`,
      `  ${journey.expression}`,
      "",
      dim(`Inspect: journey show ${journey.id}`),
      dim(`Correlate existing work: journey link ${journey.id} <kind> <ref>`),
    ].join("\n"),
  );
}

function list(
  ctx: RoomContext,
  caller: Parameters<RoomContext["send"]>[0],
  db: MarinaDB,
  entity: Entity,
  all: boolean,
): void {
  const journeys = db.listJourneys({ requesterId: all ? undefined : entity.id, limit: 50 });
  if (journeys.length === 0) {
    ctx.send(
      caller,
      `${dim(all ? "No journeys exist." : "You have no journeys yet.")}\njourney create <desire>`,
    );
    return;
  }
  const lines = [header(all ? "Journeys" : `Journeys: ${entity.name}`), separator()];
  let sharedProjects: ReturnType<MarinaDB["listProjects"]> | undefined;
  const getProjects = () => (sharedProjects ??= db.listProjects());
  for (const journey of journeys) {
    const projection = project(db, journey, getProjects);
    lines.push(
      `  ${bold(journey.id)} ${status(projection.state.replaceAll("_", " "), stateTone(projection.state))}`,
      `    ${truncate(journey.expression, 88)}`,
    );
  }
  ctx.send(caller, lines.join("\n"));
}

function show(
  ctx: RoomContext,
  caller: Parameters<RoomContext["send"]>[0],
  db: MarinaDB,
  entity: Entity,
  selector: string | undefined,
): void {
  const journey = resolveJourney(db, entity.id, selector);
  if (!journey) {
    ctx.send(caller, missingJourney(selector));
    return;
  }
  const events = db.listJourneyEvents(journey.id);
  const links = db.listJourneyLinks(journey.id);
  const projection = project(db, journey);
  const lines = [
    header(`Journey: ${journey.id}`),
    separator(),
    `  ${bold("Requester:")} ${journey.requester_name}`,
    `  ${bold("State:")} ${status(projection.state.replaceAll("_", " "), stateTone(projection.state))}`,
    `  ${bold("Desire:")} ${journey.expression}`,
    `  ${bold("Why:")} ${projection.reason}`,
    `  ${bold("Evidence:")} ${projection.evidence.join(", ")}`,
  ];
  if (links.length > 0) {
    lines.push("", bold("Correlations:"));
    for (const item of links) {
      lines.push(`  ${item.kind}:${item.ref} ${dim(item.relationship)} — ${item.actor_name}`);
    }
  }
  if (events.length > 0) {
    lines.push("", bold("Evidence history:"));
    for (const event of events.slice(-20)) {
      const ref = event.ref_kind && event.ref ? ` ${dim(`[${event.ref_kind}:${event.ref}]`)}` : "";
      lines.push(
        `  #${event.id} ${event.kind} — ${event.summary}${ref} ${dim(`— ${event.actor_name}`)}`,
      );
    }
    if (events.length > 20) lines.push(dim(`  … ${events.length - 20} earlier events`));
  }
  ctx.send(caller, lines.join("\n"));
}

function link(
  ctx: RoomContext,
  caller: Parameters<RoomContext["send"]>[0],
  db: MarinaDB,
  entity: Entity,
  args: string[],
): void {
  const [selector, rawKind, ref, relationship] = args;
  const journey = resolveJourney(db, entity.id, selector);
  if (!journey) {
    ctx.send(caller, missingJourney(selector));
    return;
  }
  if (!isLinkKind(rawKind) || !ref || args.length > 4) {
    ctx.send(
      caller,
      `Usage: journey link <id|latest> <kind> <ref> [relationship]\nKinds: ${JOURNEY_LINK_KINDS.join(", ")}`,
    );
    return;
  }
  if ((relationship?.length ?? 0) > 80 || ref.length > 500) {
    ctx.send(
      caller,
      "Journey references must be at most 500 characters and relationships at most 80.",
    );
    return;
  }
  const row = db.addJourneyLink({
    journeyId: journey.id,
    kind: rawKind,
    ref,
    relationship,
    actorId: entity.id,
    actorName: entity.name,
  });
  ctx.send(caller, `Correlated ${row.kind}:${row.ref} with ${journey.id} (${row.relationship}).`);
}

function record(
  ctx: RoomContext,
  caller: Parameters<RoomContext["send"]>[0],
  db: MarinaDB,
  entity: Entity,
  raw: string,
): void {
  const parts = raw.split("|").map((part) => part.trim());
  const recordHead = (parts[0] ?? "").split(/\s+/).filter(Boolean);
  const [selector, rawKind] = recordHead;
  const summary = parts[1];
  const journey = resolveJourney(db, entity.id, selector);
  if (!journey) {
    ctx.send(caller, missingJourney(selector));
    return;
  }
  if (!isEventKind(rawKind) || !summary || recordHead.length !== 2 || parts.length > 3) {
    ctx.send(
      caller,
      `Usage: journey record <id|latest> <event> | <summary> [| <ref-kind>:<ref>]\nEvents: ${JOURNEY_EVENT_KINDS.join(", ")}`,
    );
    return;
  }
  if (summary.length > 4000) {
    ctx.send(caller, "A journey evidence summary must be 4,000 characters or fewer.");
    return;
  }
  const parsedRef = parts[2] ? parseRef(parts[2]) : undefined;
  if (parts[2] && !parsedRef) {
    ctx.send(
      caller,
      `Invalid evidence reference. Use <kind>:<ref>; kinds: ${JOURNEY_LINK_KINDS.join(", ")}`,
    );
    return;
  }
  const event = db.appendJourneyEvent({
    journeyId: journey.id,
    kind: rawKind,
    summary,
    actorId: entity.id,
    actorName: entity.name,
    refKind: parsedRef?.kind,
    ref: parsedRef?.ref,
  });
  if (parsedRef) {
    db.addJourneyLink({
      journeyId: journey.id,
      kind: parsedRef.kind,
      ref: parsedRef.ref,
      relationship: "evidence_for",
      actorId: entity.id,
      actorName: entity.name,
    });
  }
  const projection = project(db, journey);
  ctx.send(caller, `Recorded journey event #${event.id}. Current state: ${projection.state}.`);
}

function project(
  db: MarinaDB,
  journey: JourneyRow,
  getProjects?: () => ReturnType<MarinaDB["listProjects"]>,
) {
  const links = db.listJourneyLinks(journey.id);
  const work: JourneyWorkEvidence[] = [];
  // Projects load lazily and AT MOST ONCE per projection — previously
  // listProjects() (a full-table read) ran inside the per-link loop, and
  // `journey list` re-ran it per journey. Callers projecting many journeys
  // pass a shared getProjects to load the table once for the whole batch.
  let localProjects: ReturnType<MarinaDB["listProjects"]> | undefined;
  const projects = getProjects ?? (() => (localProjects ??= db.listProjects()));
  for (const link of links) {
    if (link.kind === "task" && /^\d+$/.test(link.ref)) {
      const task = db.getTask(Number(link.ref));
      if (task) {
        work.push({ kind: "task", ref: link.ref, status: task.status, updatedAt: task.updated_at });
      }
    } else if (link.kind === "project") {
      const project = projects().find(
        (candidate) => candidate.id === link.ref || candidate.name === link.ref,
      );
      if (project) {
        work.push({
          kind: "project",
          ref: link.ref,
          status: project.status,
          updatedAt: project.created_at,
        });
      }
    }
  }
  return projectJourneyState({
    createdAt: journey.created_at,
    events: db.listJourneyEvents(journey.id),
    work,
  });
}

function resolveJourney(
  db: MarinaDB,
  requesterId: string,
  selector: string | undefined,
): JourneyRow | undefined {
  if (!selector || selector.toLowerCase() === "latest") {
    return db.getLatestJourneyForRequester(requesterId);
  }
  const exact = db.getJourney(selector);
  if (exact) return exact;
  const matches = db
    .listJourneys({ limit: 100 })
    .filter((journey) => journey.id.startsWith(selector));
  return matches.length === 1 ? matches[0] : undefined;
}

function parseRef(raw: string): { kind: JourneyLinkKind; ref: string } | undefined {
  const colon = raw.indexOf(":");
  if (colon <= 0 || colon === raw.length - 1) return undefined;
  const kind = raw.slice(0, colon);
  const ref = raw.slice(colon + 1).trim();
  return isLinkKind(kind) && ref.length <= 500 ? { kind, ref } : undefined;
}

function isLinkKind(value: string | undefined): value is JourneyLinkKind {
  return JOURNEY_LINK_KINDS.includes(value as JourneyLinkKind);
}

function isEventKind(value: string | undefined): value is JourneyEventKind {
  return JOURNEY_EVENT_KINDS.includes(value as JourneyEventKind);
}

function missingJourney(selector: string | undefined): string {
  return selector
    ? `Journey "${selector}" was not found or its prefix is ambiguous.`
    : "No journey selected. Create one with: journey create <desire>";
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function afterSubcommand(args: string, subcommand: string): string {
  return args.slice(subcommand.length).trim();
}

function stateTone(state: ReturnType<typeof projectJourneyState>["state"]) {
  switch (state) {
    case "active":
    case "continuing":
      return "active" as const;
    case "waiting":
    case "challenging":
      return "warn" as const;
    case "useful_result":
      return "done" as const;
    default:
      return "info" as const;
  }
}

function progressTone(kind: JourneyEventKind) {
  switch (kind) {
    case "result":
      return "done" as const;
    case "challenge":
    case "waiting":
      return "warn" as const;
    case "action_started":
    case "resumed":
    case "continuation":
      return "active" as const;
    default:
      return "info" as const;
  }
}
