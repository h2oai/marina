// In-world `watch` command — declarative point-in-time observation requests.
//
// `watch create resolving venue:kalshi ticker:KXFED-26MAR cadence:1h notify:bettor`
//
// Watch specs live as notes in the shared `watches` pool. The watching agent
// recalls them on its tick, calls `watch due` to filter by cadence, then
// runs the suggested `probe` command for each. Samples link back to the
// spec via derived_from; on closure-relevant statuses, the spec is retired.

import { bold, dim, header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import { isDue, parseCadence, renderCadence } from "../../resolvers/cadence";
import { getResolver, listResolvers } from "../../resolvers/registry";
import { findLatestSample } from "../../resolvers/sample-writer";
import {
  type ActiveWatch,
  createWatchNote,
  getActiveWatch,
  listActiveWatches,
  parseRetirement,
  renderRetirement,
  retireWatchNote,
  type WatchSpec,
} from "../../resolvers/watch-spec";
import type { CommandDef, Entity, RoomContext } from "../../types";

const HELP = `Watch — declarative point-in-time observation requests.

Usage:
  watch create <kind> <key>:<value>... [cadence:<x>] [retirement:<x>] [notify:<x>]
  watch list                            — active watches (most recent first)
  watch show <id>                       — spec + recent samples for one watch
  watch due [limit:<N>]                 — watches whose cadence has elapsed
  watch retire <id> [reason:<text>]     — close a watch and skip future probes

Cadence  : 30s, 5m, 1h, 7d, once          (default: once)
Retirement: resolved, forever, 5, 7d       (default: resolved)
Notify   : <entity-or-channel-name>        (optional)

Examples:
  watch create resolving venue:kalshi ticker:KXFED-26MAR cadence:1h notify:bettor
  watch due limit:10
  watch retire 42 reason:duplicate

Watching agents loop with: watch due, then probe <each suggested command>.`;

export function watchCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  db: MarinaDB;
}): CommandDef {
  return {
    name: "watch",
    aliases: [],
    minRank: 0,
    help: HELP,
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase();
      switch (sub) {
        case undefined:
          ctx.send(input.entity, HELP);
          return;
        case "create":
          return handleCreate(ctx, input.entity, deps.db, entity.name, tokens.slice(1));
        case "list":
          return handleList(ctx, input.entity, deps.db);
        case "show":
          return handleShow(ctx, input.entity, deps.db, tokens[1]);
        case "due":
          return handleDue(ctx, input.entity, deps.db, tokens.slice(1));
        case "retire":
          return handleRetire(ctx, input.entity, deps.db, entity.name, tokens.slice(1));
        default:
          ctx.send(input.entity, `Unknown subcommand: ${sub}\n\n${HELP}`);
      }
    },
  };
}

// ─── create ─────────────────────────────────────────────────────────────────

function handleCreate(
  ctx: RoomContext,
  caller: import("../../types").EntityId,
  db: MarinaDB,
  authorName: string,
  args: string[],
): void {
  const kindToken = args[0]?.toLowerCase();
  if (!kindToken) {
    ctx.send(caller, "watch create: kind is required (e.g. `watch create resolving ...`)");
    return;
  }
  const resolver = getResolver(kindToken);
  if (!resolver) {
    const known = listResolvers()
      .map((r) => r.kind)
      .join(", ");
    ctx.send(
      caller,
      `Unknown resolver kind: ${kindToken}\n\nRegistered kinds: ${known || "(none)"}`,
    );
    return;
  }

  // Split key:value tokens into meta fields (cadence/retirement/notify)
  // and resolver args (everything else). Resolver's parseArgs sees only its
  // own fields — the meta keys never leak to it.
  const META_KEYS = new Set(["cadence", "retirement", "notify"]);
  const resolverArgs: Record<string, string> = {};
  let cadenceRaw = "once";
  let retirementRaw: string | undefined;
  let notify: string | undefined;
  for (const tok of args.slice(1)) {
    const colon = tok.indexOf(":");
    if (colon <= 0) continue;
    const key = tok.slice(0, colon);
    const value = tok.slice(colon + 1);
    if (key === "cadence") cadenceRaw = value;
    else if (key === "retirement") retirementRaw = value;
    else if (key === "notify") notify = value;
    else if (!META_KEYS.has(key)) resolverArgs[key] = value;
  }

  const cadenceParse = parseCadence(cadenceRaw);
  if (!cadenceParse.ok) {
    ctx.send(caller, `watch create: ${cadenceParse.error}`);
    return;
  }
  const retirementParse = parseRetirement(retirementRaw);
  if (!retirementParse.ok) {
    ctx.send(caller, `watch create: ${retirementParse.error}`);
    return;
  }

  const argsParse = resolver.parseArgs(resolverArgs);
  if (!argsParse.ok) {
    ctx.send(caller, `watch create: ${argsParse.error}`);
    return;
  }
  const id = resolver.idFromArgs(argsParse.args);

  const spec: WatchSpec = {
    kind: kindToken,
    id,
    args: resolverArgs,
    cadence: cadenceParse.cadence,
    retirement: retirementParse.rule,
    notify,
    createdBy: authorName,
    createdAt: Date.now(),
  };

  const noteId = createWatchNote(db, spec, authorName);

  const summary = [
    `${header(`watch #${noteId} created`)}`,
    separator(),
    `  kind:       ${bold(spec.kind)}`,
    `  id:         ${spec.id}`,
    `  cadence:    ${renderCadence(spec.cadence)}`,
    `  retirement: ${renderRetirement(spec.retirement)}`,
    spec.notify ? `  notify:     ${spec.notify}` : `  notify:     ${dim("(none)")}`,
    "",
    dim("Watching agents will probe this on its cadence."),
  ];
  ctx.send(caller, summary.join("\n"));
}

// ─── list ───────────────────────────────────────────────────────────────────

function handleList(ctx: RoomContext, caller: import("../../types").EntityId, db: MarinaDB): void {
  const watches = listActiveWatches(db);
  if (watches.length === 0) {
    ctx.send(caller, "No active watches.");
    return;
  }
  const sorted = [...watches].sort((a, b) => b.spec.createdAt - a.spec.createdAt);
  const lines = [
    header(`Active watches (${watches.length})`),
    separator(),
    ...sorted.map((w) => formatWatchLine(w, db)),
  ];
  ctx.send(caller, lines.join("\n"));
}

function formatWatchLine(w: ActiveWatch, db: MarinaDB): string {
  const last = findLatestSample(db, w.spec.kind, w.spec.id);
  const cadenceStr = renderCadence(w.spec.cadence);
  const dueStr = isDue(w.spec.cadence, last?.sample.ts) ? bold("DUE") : dim("ok");
  const lastStr = last
    ? `last:${formatRelative(Date.now() - last.sample.ts)}`
    : dim("never sampled");
  return `  #${String(w.noteId).padStart(3)} ${dueStr} ${bold(w.spec.kind)}/${w.spec.id}  ${dim(cadenceStr)}  ${lastStr}`;
}

function formatRelative(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// ─── show ───────────────────────────────────────────────────────────────────

function handleShow(
  ctx: RoomContext,
  caller: import("../../types").EntityId,
  db: MarinaDB,
  idToken: string | undefined,
): void {
  const noteId = Number.parseInt(idToken ?? "", 10);
  if (!Number.isFinite(noteId) || noteId <= 0) {
    ctx.send(caller, "watch show: numeric id required (use `watch list` to find one).");
    return;
  }
  const watch = getActiveWatch(db, noteId);
  if (!watch) {
    ctx.send(caller, `No active watch #${noteId}.`);
    return;
  }
  const last = findLatestSample(db, watch.spec.kind, watch.spec.id);
  const lines = [
    header(`watch #${watch.noteId}`),
    separator(),
    `  kind:       ${bold(watch.spec.kind)}`,
    `  id:         ${watch.spec.id}`,
    `  args:       ${JSON.stringify(watch.spec.args)}`,
    `  cadence:    ${renderCadence(watch.spec.cadence)}`,
    `  retirement: ${renderRetirement(watch.spec.retirement)}`,
    watch.spec.notify ? `  notify:     ${watch.spec.notify}` : `  notify:     ${dim("(none)")}`,
    `  created_by: ${watch.spec.createdBy}`,
    `  created_at: ${new Date(watch.spec.createdAt).toISOString()}`,
    "",
    last
      ? `  last sample: ${last.sample.status} (${formatRelative(Date.now() - last.sample.ts)}, note #${last.noteId})`
      : dim("  no samples yet"),
  ];
  ctx.send(caller, lines.join("\n"));
}

// ─── due ────────────────────────────────────────────────────────────────────

function handleDue(
  ctx: RoomContext,
  caller: import("../../types").EntityId,
  db: MarinaDB,
  args: string[],
): void {
  let limit = 10;
  for (const tok of args) {
    const m = tok.match(/^limit:(\d+)$/);
    if (m) limit = Math.max(1, Math.min(50, Number.parseInt(m[1]!, 10)));
  }

  const watches = listActiveWatches(db);
  const dueList: { watch: ActiveWatch; lastTs?: number }[] = [];
  for (const w of watches) {
    const last = findLatestSample(db, w.spec.kind, w.spec.id);
    if (isDue(w.spec.cadence, last?.sample.ts)) {
      dueList.push({ watch: w, lastTs: last?.sample.ts });
    }
  }
  if (dueList.length === 0) {
    ctx.send(caller, "No watches due.");
    return;
  }

  // Oldest-due first — fairness for long-cadence watches.
  dueList.sort((a, b) => (a.lastTs ?? 0) - (b.lastTs ?? 0));

  const trimmed = dueList.slice(0, limit);
  const lines = [
    header(`Watches due (${dueList.length}${dueList.length > limit ? `, showing ${limit}` : ""})`),
    separator(),
    ...trimmed.map(({ watch }) => formatDueLine(watch)),
    "",
    dim("Run each suggested `probe` command verbatim."),
  ];
  ctx.send(caller, lines.join("\n"));
}

function formatDueLine(w: ActiveWatch): string {
  const probeArgs = Object.entries(w.spec.args)
    .map(([k, v]) => `${k}:${v}`)
    .join(" ");
  const cmd = `probe ${w.spec.kind} ${probeArgs} watch:${w.noteId}`;
  return `  ${bold(`#${w.noteId}`)}  ${cmd}`;
}

// ─── retire ─────────────────────────────────────────────────────────────────

function handleRetire(
  ctx: RoomContext,
  caller: import("../../types").EntityId,
  db: MarinaDB,
  authorName: string,
  args: string[],
): void {
  const noteId = Number.parseInt(args[0] ?? "", 10);
  if (!Number.isFinite(noteId) || noteId <= 0) {
    ctx.send(caller, "watch retire: numeric id required.");
    return;
  }
  const watch = getActiveWatch(db, noteId);
  if (!watch) {
    ctx.send(caller, `No active watch #${noteId} (already retired or never existed).`);
    return;
  }
  let reason: string | undefined;
  for (const tok of args.slice(1)) {
    if (tok.startsWith("reason:")) reason = tok.slice("reason:".length);
  }
  retireWatchNote(db, noteId, authorName, reason);
  ctx.send(
    caller,
    `Retired watch #${noteId} (${watch.spec.kind}/${watch.spec.id})${reason ? ` — ${reason}` : ""}.`,
  );
}
