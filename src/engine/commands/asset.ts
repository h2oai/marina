// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `asset` — the asset library in world: list, show, search, tag, caption,
 * alt text and delete stored files (uploads, generated media, request images,
 * tool output). Reads are rank 0 and go through the shared asset read check
 * (src/engine/canvas-access.ts): a private asset is "not found" to anyone who
 * cannot read it. Writes (tag, caption, alt, delete) are the owner's, its
 * creator's for an agent, or an operator's (`ownershipRefusal`, which raises
 * a challenge instead of a wall). `canvas asset list|info|delete` delegate
 * here (`runAssetCommand`).
 */

import { residentMemoryOperation } from "../../memory/resident-service";
import { dim, header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import {
  ASSET_ORIGINS,
  ASSET_TYPES,
  type AssetOrigin,
  type AssetQuery,
  type AssetRow,
  type AssetSort,
  type AssetType,
  assetCursor,
  assetTypeOf,
  isAssetOrigin,
} from "../../persistence/db-assets";
import type { StorageProvider } from "../../storage/provider";
import type { CommandDef, EngineEvent, Entity, EntityId, RoomContext } from "../../types";
import {
  type CanvasAccessHost,
  type CanvasReader,
  type CanvasReadGrants,
  canvasReaderFor,
  mayReadAsset,
  mayReadCanvas,
} from "../canvas-access";
import {
  type AssetLibraryHost,
  checkAssetEdit,
  editAsset,
  MAX_CAPTION_CHARS,
  parseProvenance,
  parseTagEdits,
  removeAsset,
} from "../media/asset-library";
import { ASSET_MEMORY_KIND, mediaMemoryMode, readMemoryStamp } from "../media/asset-memory";
import { storedAssetText } from "../media/asset-text";
import { ownershipRefusal } from "../ownership";
import { canonicalSub, parseModifiers, splitOnTerminator, unknownSubcommand } from "../parse-input";
import { requiresPersistence } from "./command-messages";
import { parseDuration } from "./format-duration";

export interface AssetCommandDeps {
  getEntity: (id: string) => Entity | undefined;
  db?: MarinaDB;
  storage?: StorageProvider;
  logEvent?: (event: EngineEvent) => void;
  trackBackground?: <T>(work: Promise<T>) => Promise<T>;
  /** Expiring read grants on private nodes (the engine's `canvasGrants`). */
  canvasGrants?: CanvasReadGrants;
}

const SUBS = ["list", "show", "search", "tag", "caption", "alt", "delete"];
const SORTS: readonly AssetSort[] = ["new", "old", "size", "name"];
const LIST_DEFAULT = 20;
const LIST_MAX = 100;
/** Rows read before the per-viewer check, per command. */
const SCAN_MAX = 2000;

const USAGE =
  "Usage: asset list [type:image|video|audio|pdf|document|other] [owner:me|<name>|all] [origin:upload|generated|request|derived|tool] [tag:<t>] [canvas:<c>] [since:7d] [limit:N] [sort:new|old|size|name]" +
  " | asset show <id> | asset search <text> | asset tag <id> +a -b | asset caption <id> -- <text> | asset alt <id> -- <text> | asset delete <id>";

const HELP = `Asset library — files stored in this world (uploads, generated images and video, request images, tool output).
${USAGE}

  asset list owner:me type:image            your images, newest first
  asset list tag:moodboard sort:name        everything tagged moodboard you can see
  asset show <id>                           facts, provenance, tags, derivatives, parents/children, canvases
  asset search red fox                      filename, caption, alt text, prompt and tags,
                                            plus text inside your own files (memory)
  asset tag <id> +moodboard -draft          add/remove tags (owner or operator)
  asset caption <id> -- A fox at dusk       set the caption (empty after -- clears it)
  asset caption <id> accept                 take the model's suggested caption (vision memory)
  asset alt <id> -- Red fox in snow         set the alt text read by screen readers
  asset delete <id>                         delete it and its thumbnails (owner or operator)

Private assets (on private canvases, or staged from model-API requests) are listed and shown only to people who can read them. Upload with \`canvas asset upload\` or the dashboard.

Your files' text (captions, tags, PDF text, transcripts, OCR) is indexed into your own memory (MARINA_MEDIA_MEMORY), so \`recall <words> all\` finds it as \`asset:<id>\` — open the file with \`marina_see asset:<id>\`.`;

interface Access {
  host: CanvasAccessHost;
  reader: CanvasReader;
}

function kb(size: number): string {
  return size >= 1024 * 1024
    ? `${(size / 1024 / 1024).toFixed(1)}MB`
    : `${Math.max(1, Math.round(size / 1024))}KB`;
}

function line(a: AssetRow, tags: readonly string[]): string {
  const date = new Date(a.created_at).toISOString().slice(0, 10);
  const dims = a.width && a.height ? ` ${a.width}×${a.height}` : "";
  const tagText = tags.length ? ` ${tags.map((t) => `#${t}`).join(" ")}` : "";
  return `  ${a.id.slice(0, 8)}.. ${date} ${a.filename} (${kb(a.size)}, ${a.mime_type}${dims}) by ${a.entity_name} [${a.origin}]${tagText}`;
}

/** The asset by exact id, or the one readable asset an id prefix names. Never an unreadable one. */
function resolveReadable(
  db: MarinaDB,
  access: Access,
  ref: string,
  via: string,
): AssetRow | undefined {
  const exact = db.getAsset(ref);
  if (exact) return mayReadAsset(access.host, exact, access.reader, via) ? exact : undefined;
  return db
    .listAssets({ limit: 200 })
    .find(
      (a) =>
        a.id.startsWith(ref) && mayReadAsset(access.host, a, access.reader, via, { log: false }),
    );
}

/** Rows the reader may see, in order, at most `limit`, scanning at most {@link SCAN_MAX}. */
function readablePage(db: MarinaDB, access: Access, q: AssetQuery, limit: number): AssetRow[] {
  const out: AssetRow[] = [];
  const sort = q.sort ?? "new";
  let cursor: string | undefined;
  let scanned = 0;
  while (scanned < SCAN_MAX && out.length < limit) {
    const rows = db.queryAssets({ ...q, cursor, limit: 200 });
    for (const row of rows) {
      scanned++;
      cursor = assetCursor(row, sort);
      if (mayReadAsset(access.host, row, access.reader, "asset list", { log: false })) {
        out.push(row);
        if (out.length === limit) break;
      }
    }
    if (rows.length < 200) break;
  }
  return out;
}

function list(db: MarinaDB, access: Access, entity: Entity, tokens: string[]): string {
  const { values, rest, errors } = parseModifiers(tokens, {
    type: { type: "string" },
    owner: { type: "string" },
    origin: { type: "string" },
    tag: { type: "string" },
    canvas: { type: "string" },
    since: { type: "string" },
    limit: { type: "int" },
    sort: { type: "string" },
  });
  if (errors.length) return `asset list: ${errors.join("; ")}`;
  const q: AssetQuery = {};
  // `canvas asset list mine` (legacy) = owner:me.
  const owner = (values.owner as string | undefined) ?? (rest[0] === "mine" ? "me" : undefined);
  if (owner && owner.toLowerCase() !== "all") q.owner = owner === "me" ? entity.name : owner;
  const type = (values.type as string | undefined)?.toLowerCase();
  if (type) {
    if (!(ASSET_TYPES as readonly string[]).includes(type))
      return `asset list: type must be one of ${ASSET_TYPES.join(", ")}.`;
    q.type = type as AssetType;
  }
  const origin = (values.origin as string | undefined)?.toLowerCase();
  if (origin) {
    if (!isAssetOrigin(origin))
      return `asset list: origin must be one of ${ASSET_ORIGINS.join(", ")}.`;
    q.origin = origin as AssetOrigin;
  }
  const tag = values.tag as string | undefined;
  if (tag) q.tags = tag.split(",").map((t) => t.trim().toLowerCase().replace(/^#/, ""));
  if (values.canvas) q.canvas = values.canvas as string;
  if (values.since) {
    const ms = parseDuration(values.since as string);
    if (ms === undefined) return "asset list: since takes a window such as 30m, 12h, 7d or 2w.";
    q.since = Date.now() - ms;
  }
  const sort = (values.sort as string | undefined)?.toLowerCase();
  if (sort) {
    if (!(SORTS as readonly string[]).includes(sort))
      return `asset list: sort must be one of ${SORTS.join(", ")}.`;
    q.sort = sort as AssetSort;
  }
  const limit = Math.min(
    Math.max((values.limit as number | undefined) ?? LIST_DEFAULT, 1),
    LIST_MAX,
  );
  const rows = readablePage(db, access, q, limit);
  if (rows.length === 0) return "No assets found.";
  const tags = db.getAssetTagsFor(rows.map((r) => r.id));
  return [
    header(`Assets (${rows.length})`),
    separator(),
    ...rows.map((a) => line(a, tags.get(a.id) ?? [])),
    rows.length === limit
      ? dim(`  … more with limit:${Math.min(limit * 2, LIST_MAX)} or a filter`)
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function search(
  db: MarinaDB,
  access: Access,
  entity: Entity,
  tokens: string[],
): Promise<string> {
  const { values, rest, errors } = parseModifiers(tokens, { limit: { type: "int" } });
  if (errors.length) return `asset search: ${errors.join("; ")}`;
  const text = rest.join(" ").trim();
  if (!text) return "Usage: asset search <text> [limit:N]";
  const limit = Math.min(
    Math.max((values.limit as number | undefined) ?? LIST_DEFAULT, 1),
    LIST_MAX,
  );
  const rows = readablePage(db, access, { text }, limit);
  const inText = await memoryHits(db, access, entity, text, new Set(rows.map((r) => r.id)));
  if (rows.length === 0 && inText.length === 0) return `No assets match "${text}".`;
  const tags = db.getAssetTagsFor(rows.map((r) => r.id));
  return [
    header(`Assets matching "${text}" (${rows.length})`),
    separator(),
    ...rows.map((a) => line(a, tags.get(a.id) ?? [])),
    ...(inText.length
      ? ["", dim("Text inside your files (memory; untrusted content):"), ...inText]
      : []),
  ].join("\n");
}

const MEMORY_HITS = 5;

/**
 * Assets whose indexed text (PDF text, OCR, transcripts — MARINA_MEDIA_MEMORY)
 * matches, from the caller's own memory, beyond the filename/caption/tag hits.
 * Each is re-checked against the asset read rule. Best effort: no account or a
 * memory error simply adds nothing.
 */
async function memoryHits(
  db: MarinaDB,
  access: Access,
  entity: Entity,
  text: string,
  shown: ReadonlySet<string>,
): Promise<string[]> {
  let results: { content?: string; metadata?: Record<string, unknown> }[];
  try {
    const reply = await residentMemoryOperation(db, entity.name, {
      operation: "search",
      input: { query: text, limit: 20 },
    });
    results =
      (reply.result as { results?: { content?: string; metadata?: Record<string, unknown> }[] })
        .results ?? [];
  } catch {
    return [];
  }
  const out: string[] = [];
  const seen = new Set(shown);
  for (const r of results) {
    const id = r.metadata?.kind === ASSET_MEMORY_KIND ? r.metadata.asset_id : undefined;
    if (typeof id !== "string" || seen.has(id)) continue;
    seen.add(id);
    const asset = db.getAsset(id);
    if (!asset || !mayReadAsset(access.host, asset, access.reader, "asset search", { log: false }))
      continue;
    const body = (r.content ?? "").split("\n").slice(1).join(" ").replace(/\s+/g, " ").trim();
    out.push(
      `  ${asset.id.slice(0, 8)}.. ${asset.filename} [${String(r.metadata?.part ?? "text")}] ${body.slice(0, 100)}${body.length > 100 ? "…" : ""}`,
    );
    if (out.length >= MEMORY_HITS) break;
  }
  return out;
}

/** Stored machine-made text (OCR, PDF text, transcript): kinds and sizes, never the text. */
function textSummary(asset: AssetRow): string | undefined {
  const kinds: [string, "ocr" | "pdf_text" | "transcript"][] = [
    ["OCR", "ocr"],
    ["PDF text", "pdf_text"],
    ["transcript", "transcript"],
  ];
  const have = kinds
    .map(([label, kind]) => {
      const t = storedAssetText(asset, kind);
      return t ? `${label} ${t.text.length} chars${t.model ? ` (${t.model})` : ""}` : "";
    })
    .filter(Boolean);
  return have.length ? have.join(", ") : undefined;
}

/** The media-memory index state (`MARINA_MEDIA_MEMORY`). */
function memorySummary(asset: AssetRow): string | undefined {
  if (asset.derived_from) return undefined;
  const s = readMemoryStamp(asset);
  if (!s) return mediaMemoryMode() === "off" ? "not indexed (MARINA_MEDIA_MEMORY=off)" : "pending";
  const stale = s.updated_at < asset.updated_at ? ", re-index pending" : "";
  const vision = s.vision ? `, vision ${s.vision}` : "";
  return `${s.state}, ${s.records} record${s.records === 1 ? "" : "s"}${vision}${stale}${
    s.note ? ` — ${s.note}` : ""
  } (recall finds them as asset:${asset.id.slice(0, 8)}..)`;
}

function show(db: MarinaDB, access: Access, ref: string | undefined): string {
  if (!ref) return "Usage: asset show <id>";
  const asset = resolveReadable(db, access, ref, "asset show");
  if (!asset) return `Asset "${ref}" not found.`;
  const p = parseProvenance(asset);
  const tags = db.getAssetTags(asset.id);
  const links = db.getAssetLinks(asset.id);
  const readable = (a: AssetRow) =>
    mayReadAsset(access.host, a, access.reader, "asset show", { log: false });
  const derivatives = links.children.filter((l) => l.asset.derived_from === asset.id);
  const children = links.children.filter(
    (l) => l.asset.derived_from !== asset.id && readable(l.asset),
  );
  const parents = links.parents.filter((l) => readable(l.asset));
  const usedIn = db.listAssetCanvasUsage(asset.id).filter((c) => mayReadCanvas(c, access.reader));
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  const suggestion = asset.caption ? undefined : storedAssetText(asset, "caption_suggestion");
  const rows: [string, string | undefined][] = [
    ["ID", asset.id],
    ["File", asset.filename],
    ["Type", `${asset.mime_type} (${assetTypeOf(asset.mime_type)})`],
    ["Size", kb(asset.size)],
    ["Owner", asset.entity_name],
    ["Origin", asset.origin],
    ["Created", fmt(asset.created_at)],
    ["Updated", asset.updated_at > asset.created_at ? fmt(asset.updated_at) : undefined],
    ["Key", asset.storage_key],
    ["Size px", asset.width && asset.height ? `${asset.width}×${asset.height}` : undefined],
    ["Duration", asset.duration_ms ? `${(asset.duration_ms / 1000).toFixed(1)}s` : undefined],
    ["Pages", asset.pages ? String(asset.pages) : undefined],
    ["SHA-256", asset.sha256 ? asset.sha256.slice(0, 16) : undefined],
    ["Tags", tags.length ? tags.join(", ") : undefined],
    ["Caption", asset.caption ?? undefined],
    ["Alt", asset.alt ?? undefined],
    [
      "Suggested",
      suggestion
        ? `${suggestion.text} (${suggestion.model ?? "model"}; \`asset caption ${asset.id.slice(0, 8)} accept\`)`
        : undefined,
    ],
    ["Text", textSummary(asset)],
    ["Memory", memorySummary(asset)],
    ["Prompt", p.prompt],
    ["Model", p.model ? `${p.model}${p.provider ? ` (${p.provider})` : ""}` : undefined],
    ["Cost", typeof p.costUsd === "number" ? `$${p.costUsd.toFixed(4)}` : undefined],
    ["Job", p.jobId],
    ["Source", p.source],
    ["Parent", asset.derived_from ? `${asset.derived_from} (derivative)` : undefined],
    [
      "Derived",
      derivatives.length
        ? derivatives.map((d) => `${d.kind} ${d.asset.id.slice(0, 8)}..`).join(", ")
        : asset.derivative_state
          ? `none (${asset.derivative_state}${asset.derivative_note ? `: ${asset.derivative_note}` : ""})`
          : asset.derived_from
            ? undefined
            : "pending",
    ],
    [
      "Made from",
      parents.length
        ? parents.map((l) => `${l.kind} ${l.asset.id.slice(0, 8)}..`).join(", ")
        : undefined,
    ],
    [
      "Made into",
      children.length
        ? children.map((l) => `${l.kind} ${l.asset.id.slice(0, 8)}..`).join(", ")
        : undefined,
    ],
    ["Used in", usedIn.length ? usedIn.map((c) => `${c.name} (${c.nodes})`).join(", ") : undefined],
  ];
  return [
    header("Asset Info"),
    separator(),
    ...rows
      .filter((r): r is [string, string] => r[1] !== undefined && r[1] !== "")
      .map(([k, v]) => `  ${`${k}:`.padEnd(10)}${v}`),
  ].join("\n");
}

/** The asset `ref` names when the caller may change it; else the reply text. */
function writable(
  db: MarinaDB,
  access: Access,
  entity: Entity,
  ref: string | undefined,
  verb: string,
): AssetRow | string {
  if (!ref) return `Usage: asset ${verb} <id> …`;
  const asset = resolveReadable(db, access, ref, `asset ${verb}`);
  if (!asset) return `Asset "${ref}" not found.`;
  if (asset.derived_from)
    return `Asset ${asset.id.slice(0, 8)}.. is a derivative of ${asset.derived_from}; change the original.`;
  const refusal = ownershipRefusal(
    entity,
    {
      owners: [asset.entity_name],
      creatorOf: (name) => db.getAgentConfig(name)?.spawned_by || undefined,
    },
    `Only the asset's owner (${asset.entity_name}) or an admin can change it.`,
  );
  return refusal ?? asset;
}

/**
 * Run one `asset` subcommand for `eid` and send the reply. `tokens` start at
 * the subcommand; `args` is the raw text after the verb (for `-- <text>`).
 */
export async function runAssetCommand(
  deps: AssetCommandDeps,
  ctx: Pick<RoomContext, "send">,
  eid: EntityId,
  tokens: string[],
  args: string,
): Promise<void> {
  const entity = deps.getEntity(eid);
  if (!entity) return;
  const db = deps.db;
  if (!db) {
    ctx.send(eid, requiresPersistence("assets"));
    return;
  }
  const host: CanvasAccessHost = {
    db,
    entities: { get: (id: never) => deps.getEntity(id) },
    ...(deps.canvasGrants ? { canvasGrants: deps.canvasGrants } : {}),
  };
  const access: Access = { host, reader: canvasReaderFor(host, eid, { inWorld: true }) };
  const library: AssetLibraryHost = {
    db,
    ...(deps.storage ? { storage: deps.storage } : {}),
    ...(deps.logEvent ? { logEvent: deps.logEvent } : {}),
    ...(deps.trackBackground ? { trackBackground: deps.trackBackground } : {}),
  };
  // A bare modifier (`asset owner:me`) or nothing at all is a list.
  const first = tokens[0];
  const isModifier = !!first && /^(?:--)?[a-z]+[:=]/i.test(first);
  const sub = !first || isModifier ? "list" : canonicalSub(first, SUBS);
  const rest = !first || isModifier ? tokens : tokens.slice(1);

  switch (sub) {
    case "list":
      ctx.send(eid, list(db, access, entity, rest));
      return;
    case "search":
      ctx.send(eid, await search(db, access, entity, rest));
      return;
    case "show":
      ctx.send(eid, show(db, access, rest[0]));
      return;
    case "tag": {
      const asset = writable(db, access, entity, rest[0], "tag");
      if (typeof asset === "string") {
        ctx.send(eid, asset);
        return;
      }
      const { add, remove } = parseTagEdits(rest.slice(1));
      if (add.length === 0 && remove.length === 0) {
        const tags = db.getAssetTags(asset.id);
        ctx.send(
          eid,
          `Tags on ${asset.id.slice(0, 8)}..: ${tags.length ? tags.join(", ") : "(none)"}`,
        );
        return;
      }
      const problem = checkAssetEdit(
        { addTags: add, removeTags: remove },
        db.getAssetTags(asset.id),
      );
      if (problem) {
        ctx.send(eid, problem);
        return;
      }
      const { tags } = editAsset(library, asset, { addTags: add, removeTags: remove }, eid);
      ctx.send(
        eid,
        `Tags on ${asset.id.slice(0, 8)}..: ${tags.length ? tags.join(", ") : "(none)"}`,
      );
      return;
    }
    case "caption":
    case "alt": {
      const asset = writable(db, access, entity, rest[0], sub);
      if (typeof asset === "string") {
        ctx.send(eid, asset);
        return;
      }
      const [, tail] = splitOnTerminator(args);
      // `asset caption <id> accept` takes the model's suggestion (MARINA_MEDIA_MEMORY=vision).
      if (sub === "caption" && tail === undefined && rest.length === 2 && rest[1] === "accept") {
        const suggestion = storedAssetText(asset, "caption_suggestion");
        if (!suggestion) {
          ctx.send(eid, `No caption suggestion on ${asset.id.slice(0, 8)}.. to accept.`);
          return;
        }
        const caption = suggestion.text.trim().slice(0, MAX_CAPTION_CHARS);
        editAsset(library, asset, { caption }, eid);
        ctx.send(eid, `Caption set on ${asset.id.slice(0, 8)}.. from the suggestion: ${caption}`);
        return;
      }
      const text = tail ?? rest.slice(1).join(" ");
      if (tail === undefined && !text) {
        ctx.send(eid, `Usage: asset ${sub} <id> -- <text>   (nothing after -- clears it)`);
        return;
      }
      const edit = sub === "caption" ? { caption: text || null } : { alt: text || null };
      const problem = checkAssetEdit(edit, []);
      if (problem) {
        ctx.send(eid, problem);
        return;
      }
      editAsset(library, asset, edit, eid);
      const label = sub === "caption" ? "Caption" : "Alt text";
      ctx.send(
        eid,
        text
          ? `${label} set on ${asset.id.slice(0, 8)}..`
          : `${label} cleared on ${asset.id.slice(0, 8)}..`,
      );
      return;
    }
    case "delete": {
      const id = rest[0];
      if (!id) {
        ctx.send(eid, "Usage: asset delete <id>");
        return;
      }
      // Deletion takes the exact id: a prefix could name a different asset
      // than the one listed. Offer the full ids a prefix matches instead.
      const exact = db.getAsset(id);
      const asset =
        exact && mayReadAsset(host, exact, access.reader, "asset delete") ? exact : undefined;
      if (!asset) {
        const matches =
          !exact && id.length >= 4
            ? db
                .listAssets({ limit: 100 })
                .filter(
                  (a) =>
                    a.id.startsWith(id) &&
                    mayReadAsset(host, a, access.reader, "asset delete", { log: false }),
                )
                .slice(0, 5)
            : [];
        ctx.send(
          eid,
          matches.length > 0
            ? `Asset delete needs the full id. Matching: ${matches.map((a) => `${a.id} (${a.filename})`).join(", ")}`
            : `Asset "${id}" not found.`,
        );
        return;
      }
      const refusal = ownershipRefusal(
        entity,
        {
          owners: [asset.entity_name],
          creatorOf: (name) => db.getAgentConfig(name)?.spawned_by || undefined,
        },
        `Only the asset's owner (${asset.entity_name}) or an admin can delete it.`,
      );
      if (refusal) {
        ctx.send(eid, refusal);
        return;
      }
      const derived = db.listDerivatives([asset.id]).length;
      await removeAsset(library, asset, eid);
      ctx.send(
        eid,
        `Asset ${asset.id.slice(0, 8)}.. deleted${derived ? ` (with ${derived} derivative${derived === 1 ? "" : "s"})` : ""}.`,
      );
      return;
    }
    default:
      ctx.send(eid, unknownSubcommand("asset", first, USAGE));
  }
}

export function assetCommand(deps: AssetCommandDeps): CommandDef {
  return {
    name: "asset",
    aliases: ["assets"],
    category: "Canvas & Media",
    help: HELP,
    usage: [
      {
        syntax:
          "asset list [type:image|video|audio|pdf|document|other] [owner:<owner>] [origin:upload|generated|request|derived|tool] [tag:<tag>] [canvas:<canvas>] [since:<window>] [limit:N] [sort:new|old|size|name]",
        effect: "read",
      },
      { syntax: "asset show <id>", effect: "read" },
      { syntax: "asset search <text> [limit:N]", effect: "read" },
      { syntax: "asset tag <id> <changes...>", effect: "write" },
      { syntax: "asset caption <id> -- <text>", effect: "write" },
      { syntax: "asset caption <id> accept", effect: "write" },
      { syntax: "asset alt <id> -- <text>", effect: "write" },
      { syntax: "asset delete <id>", effect: "delete" },
    ],
    // Rank 0: reading the library is basic. Writes check ownership in the
    // handler (owner, an agent's creator, or an operator via a challenge).
    minRank: 0,
    handler: (ctx: RoomContext, input) =>
      runAssetCommand(deps, ctx, input.entity, input.tokens, input.args),
  };
}
