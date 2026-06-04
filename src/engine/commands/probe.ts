// In-world `probe` command — invoke a registered resolver and persist the
// result as a Sample note. This is the primary surface for the resolver
// primitive: any agent (rank 0+) can call it, the watcher uses it on its
// tick, and the MCP / HTTP surfaces in step 5 wrap the same dispatcher.
//
// `probe <kind> <key>:<value> [<key>:<value> ...]`
//
// Example:
//   probe echoing payload:hello tag:smoke
//   probe resolving venue:kalshi ticker:KXFED-26MAR

import { bold, dim, header, separator, status as statusFmt } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import { getResolver, listResolvers } from "../../resolvers/registry";
import { findLatestSample, writeSample } from "../../resolvers/sample-writer";
import type { Resolver, ResolverOutput, Sample } from "../../resolvers/types";
import { type ActiveWatch, getActiveWatch, retireWatchNote } from "../../resolvers/watch-spec";
import type { CommandDef, EngineEvent, Entity, RoomContext } from "../../types";

const HELP = `Probe — invoke a resolver and write a Sample.
Usage:
  probe <kind> <key>:<value> [<key>:<value> ...]
  probe                                 — list registered kinds

Examples:
  probe echoing payload:hello
  probe resolving venue:kalshi ticker:KXFED-26MAR

Sample is written to your notes (tier=fact for resolved/changed,
tier=process for no-change/error). resolved/changed also emit a feed event.`;

export function probeCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  db: MarinaDB;
  logEvent?: (event: EngineEvent) => void;
}): CommandDef {
  return {
    name: "probe",
    aliases: [],
    minRank: 0,
    help: HELP,
    handler: async (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const tokens = input.tokens;
      // No args → list registered resolvers (discovery surface)
      if (tokens.length === 0) {
        ctx.send(input.entity, renderResolverList());
        return;
      }

      const kind = tokens[0]?.toLowerCase();
      if (!kind) {
        ctx.send(input.entity, HELP);
        return;
      }

      const resolver = getResolver(kind);
      if (!resolver) {
        ctx.send(
          input.entity,
          `Unknown resolver kind: ${kind}\n\nRegistered kinds: ${
            listResolvers()
              .map((r) => r.kind)
              .join(", ") || "(none)"
          }`,
        );
        return;
      }

      // Parse remaining tokens as key:value pairs. Tokens with no colon are
      // ignored (caller likely meant subcommand-style — out of scope here).
      // The `watch:<id>` flag is consumed here (not passed to the resolver)
      // so callers can link the resulting sample to a watch spec without
      // resolvers needing to know about watches.
      const raw: Record<string, string> = {};
      let watchSpecId: number | undefined;
      for (const tok of tokens.slice(1)) {
        const colon = tok.indexOf(":");
        if (colon <= 0) continue;
        const key = tok.slice(0, colon);
        const value = tok.slice(colon + 1);
        if (!key) continue;
        if (key === "watch") {
          const n = Number.parseInt(value, 10);
          if (Number.isFinite(n) && n > 0) watchSpecId = n;
          continue;
        }
        raw[key] = value;
      }

      const parsed = resolver.parseArgs(raw);
      if (!parsed.ok) {
        ctx.send(input.entity, `probe ${kind}: ${parsed.error}`);
        return;
      }

      const id = resolver.idFromArgs(parsed.args);
      const previous = findLatestSample(deps.db, kind, id);

      let output: ResolverOutput;
      try {
        output = await resolver.resolve({
          args: parsed.args,
          previousSample: previous?.sample,
          ctx: { db: deps.db },
        });
      } catch (err) {
        // Resolvers should never throw — but if one does, classify it as an
        // error sample and write it. Better to leave a record than swallow.
        output = {
          status: "error",
          reason: `resolver threw: ${(err as Error).message}`,
        };
      }

      const sample: Sample = buildSample({
        resolver,
        id,
        output,
        previous: previous?.sample,
      });

      // Resolve watch spec context if the caller supplied watch:<id>.
      let watch: ActiveWatch | undefined;
      if (watchSpecId !== undefined) {
        watch = getActiveWatch(deps.db, watchSpecId);
        // Note: silent fallthrough if the spec is gone (already retired) —
        // we still write the Sample as a free-floating observation, just
        // without the derived_from link.
      }

      const { noteId } = writeSample({
        db: deps.db,
        sample,
        authorName: entity.name,
        previousSampleNoteId: previous?.noteId,
        watchSpecNoteId: watch?.noteId,
        emitEvent: deps.logEvent,
      });

      // Auto-retirement: if the spec's retirement rule says "until-resolved"
      // and the sample landed in the resolver's closesOn set, retire now.
      // Filter at source — the watcher's prompt doesn't need datetime math
      // or rule parsing; the data layer enforces. Notification is best-effort.
      let retiredMsg: string | undefined;
      if (watch && shouldRetire(resolver, watch, sample)) {
        retireWatchNote(deps.db, watch.noteId, entity.name, sample.status);
        retiredMsg = `watch #${watch.noteId} retired (${sample.status})`;
        if (watch.spec.notify) {
          notifyClosure(ctx, watch, sample, deps.db);
        }
      }

      ctx.send(input.entity, renderSampleResult(sample, noteId, retiredMsg));
    },
  };
}

function buildSample(args: {
  resolver: Resolver<unknown>;
  id: string;
  output: ResolverOutput;
  previous?: Sample;
}): Sample {
  const ts = Date.now();
  const base = { kind: args.resolver.kind, id: args.id, ts };
  switch (args.output.status) {
    case "resolved":
    case "changed":
      return {
        ...base,
        status: args.output.status,
        value: args.output.value,
        source: args.output.source,
        rawHash: args.output.rawHash,
      };
    case "no-change":
      return {
        ...base,
        status: "no-change",
        source: args.output.source,
      };
    case "error":
      return {
        ...base,
        status: "error",
        // Carry the previous sample's source if we have one — useful for
        // debugging "the source we were polling failed."
        source: args.previous?.source ?? "(unknown)",
        reason: args.output.reason,
      };
  }
}

function renderResolverList(): string {
  const all = listResolvers();
  if (all.length === 0) return "No resolvers registered.";
  const lines = [
    header("Registered resolvers"),
    separator(),
    ...all.map((r) => `  ${bold(r.kind.padEnd(14))} ${dim(r.description)}`),
    "",
    dim("Run with: probe <kind> <key>:<value> [...]"),
  ];
  return lines.join("\n");
}

function renderSampleResult(sample: Sample, noteId: number, retiredMsg?: string): string {
  const tag = `[sample:${sample.kind} ${sample.id}]`;
  const head = statusFmt(sample.status, sampleStatusBucket(sample.status));
  const lines = [
    `${head} ${bold(tag)}`,
    sample.status === "resolved" || sample.status === "changed"
      ? `  value:  ${formatValue(sample.value)}`
      : sample.status === "error"
        ? `  reason: ${sample.reason ?? "unknown"}`
        : `  (no change since ${sample.id} was last observed)`,
    `  source: ${dim(sample.source)}`,
    `  note:   #${noteId}`,
  ];
  if (retiredMsg) lines.push(`  ${dim(retiredMsg)}`);
  return lines.join("\n");
}

function shouldRetire(resolver: Resolver<unknown>, watch: ActiveWatch, sample: Sample): boolean {
  const rule = watch.spec.retirement;
  switch (rule.kind) {
    case "forever":
      return false;
    case "resolved":
      // Status must be among the resolver's closesOn set (typically
      // ["resolved"]). Each resolver kind declares which statuses count as
      // closure — sampling resolvers have no closesOn, so they never retire.
      return resolver.closesOn.includes(sample.status);
    case "samples":
    case "duration":
      // These are evaluated at watch-list time by the watcher's own filter,
      // not at sample-write time. Auto-retirement here only handles the
      // "resolved" case, which is the common one.
      return false;
  }
}

function notifyClosure(ctx: RoomContext, watch: ActiveWatch, sample: Sample, db: MarinaDB): void {
  const target = watch.spec.notify;
  if (!target) return;
  const summary = `[watch #${watch.noteId}] ${watch.spec.kind}/${watch.spec.id} → ${sample.status}`;
  // Best-effort entity tell first.
  const entity = ctx.findEntity(target);
  if (entity) {
    ctx.send(entity.id, summary);
    return;
  }
  // Fall back to channel if a channel by that name exists. Channels are
  // optional in the engine, so guard with a try/catch.
  try {
    const channel = db.getChannelByName(target);
    if (channel) {
      db.addChannelMessage(channel.id, "system", "watcher", summary);
    }
  } catch {
    // Channel post is best-effort — don't fail the probe.
  }
}

function sampleStatusBucket(s: Sample["status"]): "active" | "done" | "fail" | "info" | "warn" {
  switch (s) {
    case "resolved":
      return "done";
    case "changed":
      return "info";
    case "no-change":
      return "info";
    case "error":
      return "fail";
  }
}

function formatValue(v: unknown): string {
  if (v === undefined || v === null) return "(none)";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}
