// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The asset record v2 (migration 168, src/engine/media/asset-library.ts):
 * migration + backfill, upload dedupe, cheap facts, derivatives with and
 * without `sharp` (and the video/PDF tools when installed), derivative read
 * inheritance, the `asset` command, the library REST view (filters, pages,
 * facets, PATCH auth), content-free events and retention.
 */

import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { canvasReaderFor, mayReadAsset } from "../src/engine/canvas-access";
import { runAssetCommand } from "../src/engine/commands/asset";
import {
  backfillAssets,
  derivativeMode,
  derivativesIdle,
  drainAssetDerivatives,
  generateDerivatives,
  ingestAsset,
  normalizeTag,
  parseTagEdits,
  recordAssetWrite,
  scheduleDerivatives,
} from "../src/engine/media/asset-library";
import { setImageBackendForTests } from "../src/engine/media/image-ops";
import { hasTool, stageRequestImages } from "../src/engine/media/vision";
import { pruneRequestImageBlobs, RETENTION_POLICIES } from "../src/engine/retention";
import { grant as grantGate } from "../src/engine/safety-gates";
import { handleAssetApi, handleAssetServing } from "../src/net/api/asset-api";
import { resetHttpRateLimitersForTests } from "../src/net/http-utils";
import { memoryObserver } from "../src/net/memory/memory-visibility";
import { MarinaDB } from "../src/persistence/database";
import { assetCursor } from "../src/persistence/db-assets";
import { LocalStorageProvider } from "../src/storage/local-provider";
import type { EngineEvent, EntityId } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { MockConnection, stripAnsi } from "./helpers";
import { migrateEmptyTo } from "./schema-replay";

const REMOTE = "203.0.113.9";

// Derivatives inline and awaited (the preload defaults tests to `off`), so no
// sharp/ffmpeg work is ever in flight when a test — or this file — ends.
const priorDerivatives = process.env.MARINA_ASSET_DERIVATIVES;
beforeAll(() => {
  process.env.MARINA_ASSET_DERIVATIVES = "sync";
});
afterAll(async () => {
  await drainAssetDerivatives();
  if (priorDerivatives === undefined) delete process.env.MARINA_ASSET_DERIVATIVES;
  else process.env.MARINA_ASSET_DERIVATIVES = priorDerivatives;
  // Run sharp's native buffer finalizers while this file's realm is alive.
  Bun.gc(true);
});

async function png(width: number, height: number, color = "#c03020"): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: color } })
      .png()
      .toBuffer(),
  );
}

describe("migration 168", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "asset-mig-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("upgrades a 167 database: origin and provenance from metadata, FTS seeded, facts left for the backfill", () => {
    const path = join(dir, "w.db");
    const raw = new Database(path);
    migrateEmptyTo(raw, 167);
    const insert = raw.prepare(
      `INSERT INTO assets (id, entity_name, filename, mime_type, size, storage_key, metadata, created_at)
       VALUES (?, 'Ann', ?, 'image/png', 3, ?, ?, 1000)`,
    );
    insert.run(
      "g1",
      "fox.png",
      "g1.png",
      JSON.stringify({ origin: "generated", prompt: "a red fox", model: "m/x" }),
    );
    insert.run("r1", "req.png", "r1.png", JSON.stringify({ origin: "request", owner: "e_1" }));
    insert.run("u1", "plain.png", "u1.png", "{}");
    insert.run("b1", "broken.png", "b1.png", "not json");
    raw.close();

    const db = new MarinaDB(path);
    try {
      const g = db.getAsset("g1")!;
      expect(g.origin).toBe("generated");
      expect(JSON.parse(g.provenance)).toEqual({ prompt: "a red fox", model: "m/x" });
      expect(g.updated_at).toBe(1000);
      expect(g.sha256).toBeNull();
      expect(db.getAsset("r1")!.origin).toBe("request");
      expect(db.getAsset("u1")!.origin).toBe("upload");
      expect(db.getAsset("b1")!.origin).toBe("upload");
      // The prompt is searchable from the upgrade on.
      expect(db.queryAssets({ text: "fox" }).map((a) => a.id)).toEqual(["g1"]);
      expect(
        db
          .listAssetsNeedingFacts(10)
          .map((a) => a.id)
          .sort(),
      ).toEqual(["b1", "g1", "r1", "u1"]);
    } finally {
      db.close();
    }
  });
});

describe("asset store", () => {
  let db: MarinaDB;
  beforeEach(() => {
    db = new MarinaDB(":memory:");
  });
  afterEach(() => db.close());

  const make = (id: string, extra: Partial<Parameters<MarinaDB["createAsset"]>[0]> = {}) =>
    db.createAsset({
      id,
      entityName: "Ann",
      filename: `${id}.png`,
      mimeType: "image/png",
      size: 10,
      storageKey: `${id}.png`,
      ...extra,
    });

  it("FTS covers filename, caption, alt, prompt and tags, and follows edits", () => {
    make("a1", { provenance: { prompt: "lighthouse at dusk" } });
    make("a2");
    db.updateAssetText("a2", { caption: "harbour view", alt: "boats in fog" });
    db.setAssetTags("a2", ["moodboard"], []);
    expect(db.queryAssets({ text: "lighthouse" }).map((a) => a.id)).toEqual(["a1"]);
    expect(db.queryAssets({ text: "harbour" }).map((a) => a.id)).toEqual(["a2"]);
    expect(db.queryAssets({ text: "fog" }).map((a) => a.id)).toEqual(["a2"]);
    expect(db.queryAssets({ text: "moodboard" }).map((a) => a.id)).toEqual(["a2"]);
    expect(db.queryAssets({ text: "a1" }).map((a) => a.id)).toEqual(["a1"]);
    db.setAssetTags("a2", [], ["moodboard"]);
    expect(db.queryAssets({ text: "moodboard" })).toEqual([]);
    db.updateAssetText("a2", { caption: null });
    expect(db.queryAssets({ text: "harbour" })).toEqual([]);
    db.deleteAsset("a1");
    expect(db.queryAssets({ text: "lighthouse" })).toEqual([]);
  });

  it("filters by type, owner, origin, tag and since; keyset pages never repeat or skip", () => {
    for (let i = 0; i < 7; i++) make(`p${i}`, { size: 100 + i });
    make("v1", { mimeType: "video/mp4", entityName: "Bob", origin: "generated" });
    db.setAssetTags("p3", ["x"], []);
    db.setAssetTags("v1", ["x"], []);
    expect(db.queryAssets({ type: "video" }).map((a) => a.id)).toEqual(["v1"]);
    expect(db.queryAssets({ owner: "bob" }).map((a) => a.id)).toEqual(["v1"]);
    expect(db.queryAssets({ origin: "generated" }).map((a) => a.id)).toEqual(["v1"]);
    expect(db.queryAssets({ tags: ["x"], type: "image" }).map((a) => a.id)).toEqual(["p3"]);
    expect(db.queryAssets({ since: Date.now() + 60_000 })).toEqual([]);
    for (const sort of ["new", "old", "size", "name"] as const) {
      const all = db.queryAssets({ sort, limit: 100 }).map((a) => a.id);
      const seen: string[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = db.queryAssets({ sort, limit: 3, cursor });
        if (page.length === 0) break;
        seen.push(...page.map((a) => a.id));
        cursor = assetCursor(page.at(-1)!, sort);
      }
      expect(seen).toEqual(all);
    }
  });

  it("derivatives cascade with their parent and are hidden from plain listings", () => {
    make("par");
    db.createAsset({
      id: "th",
      entityName: "Ann",
      filename: "par.thumbnail-256.webp",
      mimeType: "image/webp",
      size: 5,
      storageKey: "th.webp",
      derivedFrom: "par",
    });
    db.linkAssets("th", "par", "thumbnail-256");
    expect(db.getAsset("th")!.origin).toBe("derived");
    expect(db.listAssets().map((a) => a.id)).toEqual(["par"]);
    expect(db.listDerivatives(["par"]).map((d) => [d.id, d.kind])).toEqual([
      ["th", "thumbnail-256"],
    ]);
    expect(db.getAssetLinks("par").children.map((l) => l.kind)).toEqual(["thumbnail-256"]);
    db.deleteAsset("par");
    expect(db.getAsset("th")).toBeUndefined();
  });

  it("normalizes tags and parses +a -b edits", () => {
    expect(normalizeTag("  #Mood Board! ")).toBe("mood-board");
    expect(normalizeTag("###")).toBeUndefined();
    expect(parseTagEdits(["+a", "-b", "c,+d", "-a"])).toEqual({
      add: ["c", "d"],
      remove: ["b", "a"],
    });
  });
});

describe("asset library — ingest, derivatives, access, command, REST", () => {
  let dir: string;
  let storage: LocalStorageProvider;
  let fixture: ReturnType<typeof createTestEngine>;
  let events: EngineEvent[];
  type Who = { id: EntityId; token: string; conn: MockConnection; name: string };
  let owner: Who;
  let admin: Who;
  let stranger: Who;

  function enter(name: string, rank: number): Who {
    const conn = new MockConnection(`c-${name}`);
    conn.peerIp = REMOTE;
    fixture.engine.addConnection(conn);
    const login = fixture.engine.login(conn.id, name);
    if (!("token" in login)) throw new Error(`login failed: ${login.error}`);
    fixture.engine.entities.get(login.entityId)!.properties.rank = rank;
    return { id: login.entityId, token: login.token, conn, name };
  }

  async function run(who: Who, raw: string): Promise<string> {
    const before = who.conn.messages.length;
    await fixture.engine.processCommand(who.id, raw);
    return stripAnsi(who.conn.allText().slice(before).join("\n"));
  }

  function api(method: string, path: string, token?: string, body?: unknown) {
    const url = new URL(`http://localhost:3300${path}`);
    const req = new Request(url.toString(), {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return handleAssetApi(url, method, req, fixture.db, storage, fixture.engine, REMOTE);
  }

  const ingest = (who: Who, data: Uint8Array, filename: string, extra = {}) =>
    ingestAsset(fixture.engine, {
      owner: who.name,
      filename,
      mime: filename.endsWith(".png") ? "image/png" : "application/octet-stream",
      data,
      origin: "upload",
      actor: who.id,
      ...extra,
    });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "asset-lib-"));
    storage = new LocalStorageProvider(dir);
    await storage.init();
    fixture = createTestEngine({ assetStorage: storage });
    resetHttpRateLimitersForTests();
    events = [];
    fixture.engine.addEventListener((e) => {
      if (e.type.startsWith("asset_")) events.push(e);
    });
    owner = enter("Owner", 1);
    admin = enter("Admin", 9);
    stranger = enter("Stranger", 4);
  });

  afterEach(async () => {
    setImageBackendForTests();
    await derivativesIdle();
    await fixture.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it("records sha256 + dimensions on write, dedupes the owner's identical upload, and makes thumbnails off the request path", async () => {
    const bytes = await png(1600, 900);
    const first = await ingest(owner, bytes, "wide.png", { dedupe: true });
    expect(first.deduplicated).toBe(false);
    expect(first.asset.width).toBe(1600);
    expect(first.asset.height).toBe(900);
    expect(first.asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    const again = await ingest(owner, bytes, "copy.png", { dedupe: true });
    expect(again).toEqual({
      asset: expect.objectContaining({ id: first.asset.id }),
      deduplicated: true,
    });
    // Another owner's identical bytes are their own asset.
    const other = await ingest(stranger, bytes, "wide.png", { dedupe: true });
    expect(other.deduplicated).toBe(false);

    await derivativesIdle();
    const row = fixture.db.getAsset(first.asset.id)!;
    expect(row.derivative_state).toBe("done");
    expect(row.placeholder).toMatch(/^data:image\/webp;base64,/);
    const derived = fixture.db.listDerivatives([row.id]);
    expect(derived.map((d) => d.kind).sort()).toEqual(["thumbnail-1024", "thumbnail-256"]);
    const small = derived.find((d) => d.kind === "thumbnail-256")!;
    expect([small.width, small.height]).toEqual([256, 144]);
    expect(small.mime_type).toBe("image/webp");
    expect(small.entity_name).toBe("Owner");
    // Re-running makes nothing new.
    await generateDerivatives(fixture.engine, row.id);
    expect(fixture.db.listDerivatives([row.id])).toHaveLength(2);
  });

  it("without sharp: no derivative, the reason is recorded, no error", async () => {
    setImageBackendForTests(async () => undefined);
    const { asset } = await ingest(owner, await png(400, 300), "a.png");
    await derivativesIdle();
    const row = fixture.db.getAsset(asset.id)!;
    expect(row.width).toBe(400); // header probe needs no sharp
    expect(row.derivative_state).toBe("unavailable");
    expect(row.derivative_note).toContain("sharp");
    expect(row.placeholder).toBeNull();
    expect(fixture.db.listDerivatives([asset.id])).toEqual([]);
  });

  it("MARINA_ASSET_DERIVATIVES: off makes none, on queues, shutdown drains before the DB closes", async () => {
    expect(derivativeMode({})).toBe("on");
    expect(derivativeMode({ MARINA_ASSET_DERIVATIVES: "OFF" })).toBe("off");
    expect(derivativeMode({ MARINA_ASSET_DERIVATIVES: "sync" })).toBe("sync");
    try {
      process.env.MARINA_ASSET_DERIVATIVES = "off";
      const off = (await ingest(owner, await png(300, 200), "off.png")).asset;
      expect(fixture.db.getAsset(off.id)!.width).toBe(300); // facts still recorded
      expect(fixture.db.getAsset(off.id)!.derivative_state).toBeNull();
      expect(await backfillAssets(fixture.engine)).toBe(1);
      expect(fixture.db.listDerivatives([off.id])).toEqual([]);

      process.env.MARINA_ASSET_DERIVATIVES = "on";
      const on = (await ingest(owner, await png(310, 200), "on.png")).asset;
      // Queued, not awaited by the write: shutdown is what waits for it.
      await fixture.engine.shutdown();
      expect(fixture.db.getAsset(on.id)!.derivative_state).toBe("done");
      // A job queued while draining is skipped, never started on a closing DB.
      const pending = scheduleDerivatives(fixture.engine, off.id);
      const drained = drainAssetDerivatives();
      await pending;
      await drained;
    } finally {
      process.env.MARINA_ASSET_DERIVATIVES = "sync";
    }
  });

  it("documents and other files get facts but no derivatives", async () => {
    const { asset } = await ingest(owner, new TextEncoder().encode("hello"), "notes.bin");
    await derivativesIdle();
    expect(fixture.db.getAsset(asset.id)!.derivative_state).toBe("none");
  });

  it.skipIf(!hasTool("ffmpeg") || !hasTool("ffprobe"))(
    "video: duration, size and a poster frame via ffmpeg",
    async () => {
      const out = join(dir, "clip.mp4");
      const made = Bun.spawnSync([
        "ffmpeg",
        "-nostdin",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=320x240:d=1",
        "-c:v",
        "mpeg4",
        "-y",
        out,
      ]);
      if (made.exitCode !== 0) return; // encoder not built in; nothing to test here
      const data = new Uint8Array(await Bun.file(out).arrayBuffer());
      const { asset } = await ingestAsset(fixture.engine, {
        owner: "Owner",
        filename: "clip.mp4",
        mime: "video/mp4",
        data,
        origin: "upload",
      });
      await derivativesIdle();
      const row = fixture.db.getAsset(asset.id)!;
      expect(row.duration_ms).toBeGreaterThan(500);
      expect([row.width, row.height]).toEqual([320, 240]);
      const kinds = fixture.db
        .listDerivatives([row.id])
        .map((d) => d.kind)
        .sort();
      expect(kinds).toContain("poster");
      expect(kinds).toContain("thumbnail-256");
    },
  );

  it.skipIf(!hasTool("pdftoppm"))("pdf: page count and a first-page preview", async () => {
    const pdf = minimalPdf();
    const { asset } = await ingestAsset(fixture.engine, {
      owner: "Owner",
      filename: "doc.pdf",
      mime: "application/pdf",
      data: pdf,
      origin: "upload",
    });
    await derivativesIdle();
    const row = fixture.db.getAsset(asset.id)!;
    if (hasTool("pdfinfo")) expect(row.pages).toBe(1);
    expect(fixture.db.listDerivatives([row.id]).map((d) => d.kind)).toContain("preview");
  });

  it("a derivative is exactly as readable as its parent: a stranger never reads a request image's thumbnail", async () => {
    const { asset } = await ingest(owner, await png(600, 400), "req.png", {
      metadata: { origin: "request", owner: owner.id },
      origin: "request",
    });
    await derivativesIdle();
    const thumb = fixture.db.listDerivatives([asset.id]).find((d) => d.kind === "thumbnail-256")!;
    const host = fixture.engine;
    expect(mayReadAsset(host, thumb, canvasReaderFor(host, owner.id), "t")).toBe(true);
    expect(mayReadAsset(host, thumb, canvasReaderFor(host, stranger.id), "t")).toBe(false);
    expect(mayReadAsset(host, thumb, undefined, "t")).toBe(false);
    expect((await api("GET", `/api/assets/${thumb.id}`, stranger.token)).status).toBe(404);
    expect((await api("GET", `/api/assets/${thumb.id}`, owner.token)).status).toBe(200);
    // Bytes: gated like the request image itself.
    const bytes = (token?: string) => {
      const url = new URL(`http://localhost:3300/assets/${thumb.storage_key}`);
      const req = new Request(url.toString(), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      return handleAssetServing(url, storage, fixture.db, {
        engine: fixture.engine,
        req,
        peerIp: REMOTE,
      });
    };
    expect((await bytes(stranger.token)).status).toBe(404);
    expect((await bytes()).status).toBe(404);
    expect((await bytes(owner.token)).status).toBe(200);
    // The library view hides both, and the owner's thumb URL is signed.
    const strangerView = (await (
      await api("GET", "/api/assets?view=library", stranger.token)
    ).json()) as { items: { id: string }[] };
    expect(strangerView.items.map((i) => i.id)).not.toContain(asset.id);
    const ownerView = (await (
      await api("GET", "/api/assets?view=library", owner.token)
    ).json()) as {
      items: { id: string; thumb: { url: string; expiresAt: number | null } }[];
    };
    const mine = ownerView.items.find((i) => i.id === asset.id)!;
    expect(mine.thumb.url).toContain("sig=");
    expect(mine.thumb.expiresAt).toBeGreaterThan(Date.now() / 1000);
  });

  it("a private-canvas asset's thumbnail is hidden from a stranger too", async () => {
    const { asset } = await ingest(owner, await png(300, 300), "p.png");
    await derivativesIdle();
    fixture.db.createCanvas({
      id: "priv",
      name: "mine",
      scope: "entity",
      scopeId: owner.id,
      creatorName: "Owner",
    });
    fixture.db.createNode({
      id: "n1",
      canvasId: "priv",
      type: "image",
      assetId: asset.id,
      creatorName: "Owner",
    });
    const thumb = fixture.db.listDerivatives([asset.id])[0]!;
    expect((await api("GET", `/api/assets/${thumb.id}`, stranger.token)).status).toBe(404);
    expect((await api("GET", `/api/assets/${thumb.id}`, admin.token)).status).toBe(200);
  });

  it("asset command: list filters, show, FTS search, tags, caption/alt, delete with cascade", async () => {
    const a = (await ingest(owner, await png(300, 200), "sunset.png")).asset;
    const b = (await ingest(stranger, new TextEncoder().encode("x"), "data.bin")).asset;
    await derivativesIdle();

    expect(await run(owner, "asset list owner:me")).toContain("sunset.png");
    expect(await run(owner, "asset list owner:me")).not.toContain("data.bin");
    expect(await run(owner, "asset owner:all type:image")).toContain("sunset.png");
    expect(await run(owner, "asset list type:image")).not.toContain("data.bin");
    expect(await run(owner, "asset list type:bogus")).toContain("type must be one of");
    expect(await run(owner, "assets ls sort:name limit:1")).toContain("data.bin");

    expect(await run(owner, `asset tag ${a.id} +Moodboard +warm`)).toContain("moodboard, warm");
    expect(await run(owner, `asset tag ${a.id} -warm`)).toContain("moodboard");
    expect(await run(owner, "asset list tag:moodboard")).toContain("#moodboard");
    expect(await run(owner, `asset caption ${a.id} -- Evening over the bay`)).toContain(
      "Caption set",
    );
    expect(await run(owner, `asset alt ${a.id} -- Orange sky`)).toContain("Alt text set");
    expect(await run(stranger, "asset search bay")).toContain("sunset.png");
    expect(await run(stranger, "asset search moodboard")).toContain("sunset.png");
    expect(await run(stranger, "asset search nothing-like-this")).toContain("No assets match");

    const shown = await run(owner, `asset info ${a.id.slice(0, 8)}`);
    expect(shown).toContain("Evening over the bay");
    expect(shown).toContain("Orange sky");
    expect(shown).toContain("300×200");
    expect(shown).toContain("thumbnail-256");
    expect(shown).toContain("moodboard");

    // Writes: the owner or an operator; a stranger gets the challenge refusal.
    expect(await run(stranger, `asset tag ${a.id} +mine`)).toContain(
      "Only the asset's owner (Owner)",
    );
    expect(await run(stranger, `asset caption ${a.id} -- hijack`)).toContain(
      "Only the asset's owner",
    );
    expect(fixture.db.getAsset(a.id)!.caption).toBe("Evening over the bay");
    expect(await run(admin, `asset tag ${b.id} +reviewed`)).toContain("reviewed");

    const derived = fixture.db.listDerivatives([a.id]);
    expect(derived.length).toBeGreaterThan(0);
    expect(await run(stranger, `asset delete ${a.id}`)).toContain("Only the asset's owner (Owner)");
    expect(await run(owner, `asset delete ${a.id}`)).toContain("deleted (with");
    expect(fixture.db.getAsset(a.id)).toBeUndefined();
    for (const d of derived) {
      expect(fixture.db.getAsset(d.id)).toBeUndefined();
      expect(await storage.get(d.storage_key)).toBeNull();
    }
    expect(await storage.get(a.storage_key)).toBeNull();
    // `canvas asset info|list` delegate to the same code.
    expect(await run(stranger, `canvas asset info ${b.id}`)).toContain("data.bin");
    expect(await run(owner, "asset bogus")).toContain('Unknown asset subcommand "bogus"');
  });

  it("runAssetCommand works without storage or derivatives (sizes to what it has)", async () => {
    const sent: string[] = [];
    await runAssetCommand(
      { getEntity: (id) => fixture.engine.entities.get(id as EntityId), db: fixture.db },
      { send: (_id, text) => sent.push(String(text)) },
      owner.id,
      ["list"],
      "list",
    );
    expect(sent.join("")).toContain("No assets found");
  });

  it("REST library view: filters, keyset pages, facets over the visible set, detail with lineage", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await ingest(owner, await png(64 + i, 64), `img${i}.png`)).asset.id);
    }
    const doc = (await ingest(stranger, new TextEncoder().encode("doc"), "s.bin")).asset;
    fixture.db.setAssetTags(ids[0]!, ["alpha"], []);
    // A private request image of the stranger's: never counted for the owner.
    await ingest(stranger, await png(32, 32), "hidden.png", {
      origin: "request",
      metadata: { origin: "request", owner: stranger.id },
    });
    await derivativesIdle();

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await api(
        "GET",
        `/api/assets?view=library&owner=me&limit=2${cursor ? `&cursor=${cursor}` : ""}`,
        owner.token,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: { id: string; owner: string }[];
        nextCursor: string | null;
      };
      for (const item of body.items) expect(item.owner).toBe("Owner");
      seen.push(...body.items.map((i) => i.id));
      cursor = body.nextCursor;
    } while (cursor);
    expect(seen.sort()).toEqual([...ids].sort());

    const filtered = (await (
      await api("GET", "/api/assets?view=library&tag=alpha&type=image&facets=1", owner.token)
    ).json()) as {
      items: {
        id: string;
        tags: string[];
        width: number;
        thumb: { url: string } | null;
        placeholder: string | null;
        origin: string;
      }[];
      facets: {
        type: Record<string, number>;
        origin: Record<string, number>;
        owner: Record<string, number>;
        tag: Record<string, number>;
        total: number;
        truncated: boolean;
      };
    };
    expect(filtered.items.map((i) => i.id)).toEqual([ids[0]!]);
    expect(filtered.items[0]!.tags).toEqual(["alpha"]);
    expect(filtered.items[0]!.thumb?.url).toMatch(/^\/assets\//);
    expect(filtered.items[0]!.placeholder).toMatch(/^data:image\/webp/);
    expect(filtered.facets).toEqual({
      type: { image: 5, other: 1 },
      origin: { upload: 6 },
      owner: { Owner: 5, Stranger: 1 },
      tag: { alpha: 1 },
      total: 6,
      truncated: false,
    });
    expect((await api("GET", "/api/assets?view=library&type=nope", owner.token)).status).toBe(400);
    expect((await api("GET", "/api/assets?view=library&since=7d", owner.token)).status).toBe(200);
    const anon = (await (await api("GET", "/api/assets?view=library&owner=me")).json()) as {
      items: unknown[];
    };
    expect(anon.items).toEqual([]);
    // The legacy list stays a plain array.
    expect(Array.isArray(await (await api("GET", "/api/assets", owner.token)).json())).toBe(true);

    const detail = (await (await api("GET", `/api/assets/${ids[0]}`, owner.token)).json()) as {
      children: { kind: string }[];
      usedIn: unknown[];
      metadata: object;
      entity_name: string;
      thumbs: Record<string, unknown>;
    };
    expect(detail.entity_name).toBe("Owner");
    expect(detail.children.map((c) => c.kind)).toContain("thumbnail-256");
    expect(Object.keys(detail.thumbs)).toContain("thumbnail-256");
    expect(detail.usedIn).toEqual([]);
    expect(doc.origin).toBe("upload");
  });

  it("PATCH /api/assets/:id: owner or operator; a stranger 403 on a public asset, 404 on a private one", async () => {
    const pub = (await ingest(owner, await png(40, 40), "pub.png")).asset;
    const req = (
      await ingest(owner, await png(41, 40), "req.png", {
        origin: "request",
        metadata: { origin: "request", owner: owner.id },
      })
    ).asset;
    expect((await api("PATCH", `/api/assets/${pub.id}`, undefined, { caption: "x" })).status).toBe(
      401,
    );
    expect(
      (await api("PATCH", `/api/assets/${pub.id}`, stranger.token, { caption: "x" })).status,
    ).toBe(403);
    expect(
      (await api("PATCH", `/api/assets/${req.id}`, stranger.token, { caption: "x" })).status,
    ).toBe(404);
    expect((await api("PATCH", `/api/assets/${pub.id}`, owner.token, { caption: 5 })).status).toBe(
      400,
    );
    expect((await api("PATCH", `/api/assets/${pub.id}`, owner.token, {})).status).toBe(400);
    const ok = await api("PATCH", `/api/assets/${pub.id}`, owner.token, {
      caption: "  Field notes ",
      alt: "Green square",
      tags: ["Field", "draft"],
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { caption: string; alt: string; tags: string[] };
    expect(body).toMatchObject({
      caption: "Field notes",
      alt: "Green square",
      tags: ["draft", "field"],
    });
    // An operator holding admin.destructive (the gate decides over HTTP, not rank).
    grantGate(fixture.db, admin.id, "admin.destructive");
    const replaced = (await (
      await api("PATCH", `/api/assets/${pub.id}`, admin.token, { tags: ["final"], caption: null })
    ).json()) as { caption: string | null; tags: string[] };
    expect(replaced).toMatchObject({ caption: null, tags: ["final"] });
    expect(
      (
        await api("PATCH", `/api/assets/${pub.id}`, owner.token, {
          tags: Array.from({ length: 40 }, (_, i) => `t${i}`),
        })
      ).status,
    ).toBe(400);
  });

  it("events carry ids, owner and MIME only, and reach the owner and operators, not strangers", async () => {
    const { asset } = await ingest(owner, await png(50, 50), "e.png", {
      provenance: { prompt: "secret prompt" },
    });
    await derivativesIdle();
    await run(owner, `asset caption ${asset.id} -- private caption`);
    await run(owner, `asset delete ${asset.id}`);
    const types = events.map((e) => e.type);
    expect(types).toContain("asset_created");
    expect(types).toContain("asset_updated");
    expect(types).toContain("asset_deleted");
    for (const e of events) {
      expect(Object.keys(e).sort()).toEqual(
        ["assetId", "entity", "mime", "owner", "timestamp", "type"].filter(
          (k) => k !== "entity" || "entity" in e,
        ),
      );
      expect(JSON.stringify(e)).not.toContain("secret prompt");
      expect(JSON.stringify(e)).not.toContain("private caption");
    }
    const created = events.find((e) => e.type === "asset_created")!;
    expect(memoryObserver(fixture.engine, owner.id).event(created)).toBe(true);
    expect(memoryObserver(fixture.engine, admin.id).event(created)).toBe(true);
    expect(memoryObserver(fixture.engine, stranger.id).event(created)).toBe(false);
    expect(memoryObserver(fixture.engine).event(created)).toBe(false);
  });

  it("recordAssetWrite: a writer that stores its own row still gets facts, an event and derivatives", async () => {
    const bytes = await png(120, 80);
    await storage.put("own1.png", bytes, "image/png");
    fixture.db.createAsset({
      id: "own1",
      entityName: "Owner",
      filename: "own.png",
      mimeType: "image/png",
      size: bytes.byteLength,
      storageKey: "own1.png",
    });
    recordAssetWrite(fixture.engine, "own1", bytes, owner.id);
    expect(fixture.db.getAsset("own1")!.width).toBe(120);
    expect(events.map((e) => e.type)).toContain("asset_created");
    await derivativesIdle();
    expect(fixture.db.getAsset("own1")!.derivative_state).toBe("done");
  });

  it("staged model-API request images get the v2 record: origin request, facts, a private thumbnail", async () => {
    const bytes = await png(400, 300);
    const url = `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
    const lines = await stageRequestImages(
      fixture.engine,
      [{ type: "image_url", image_url: { url } }],
      { ownerId: owner.id, name: owner.name },
    );
    expect(lines).toHaveLength(1);
    const staged = fixture.db.listAssets({ limit: 5 }).find((a) => a.origin === "request")!;
    expect(staged.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect([staged.width, staged.height]).toEqual([400, 300]);
    expect(events.some((e) => e.type === "asset_created" && e.assetId === staged.id)).toBe(true);
    const thumb = fixture.db.listDerivatives([staged.id])[0]!;
    expect(
      mayReadAsset(fixture.engine, thumb, canvasReaderFor(fixture.engine, stranger.id), "t"),
    ).toBe(false);
  });

  it("the backfill fills facts and derivatives for rows written without them", async () => {
    const bytes = await png(500, 250);
    await storage.put("old1.png", bytes, "image/png");
    fixture.db.createAsset({
      id: "old1",
      entityName: "Owner",
      filename: "legacy.png",
      mimeType: "image/png",
      size: bytes.byteLength,
      storageKey: "old1.png",
    });
    fixture.db.createAsset({
      id: "gone",
      entityName: "Owner",
      filename: "gone.png",
      mimeType: "image/png",
      size: 1,
      storageKey: "gone.png",
    });
    expect(await backfillAssets(fixture.engine)).toBe(2);
    const row = fixture.db.getAsset("old1")!;
    expect([row.width, row.height]).toEqual([500, 250]);
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.derivative_state).toBe("done");
    expect(fixture.db.getAsset("gone")!.derivative_state).toBe("failed");
    expect(await backfillAssets(fixture.engine)).toBe(0);
  });

  it("retention: only request images age out, and their derivatives' bytes go with them", async () => {
    const policy = RETENTION_POLICIES.find((p) => p.table === "assets")!;
    expect(policy.kind).toBe("telemetry");
    expect(policy.where).toContain("origin = 'request'");
    expect(policy.note).toContain("never aged out");
    const { asset } = await ingest(owner, await png(300, 300), "r.png", {
      origin: "request",
      metadata: { origin: "request", owner: owner.id },
    });
    const keep = (await ingest(owner, await png(301, 300), "keep.png")).asset;
    await derivativesIdle();
    const derived = fixture.db.listDerivatives([asset.id]);
    expect(derived.length).toBeGreaterThan(0);
    const removed = await pruneRequestImageBlobs(fixture.db, storage, {
      now: Date.now() + 30 * 86_400_000,
      overridesEnv: "",
    });
    expect(removed).toBe(1);
    for (const d of derived) {
      expect(fixture.db.getAsset(d.id)).toBeUndefined();
      expect(await storage.get(d.storage_key)).toBeNull();
    }
    expect(fixture.db.getAsset(keep.id)).toBeDefined();
  });
});

/** A one-page PDF (no fonts) that poppler can render. */
function minimalPdf(): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << >> >>",
    "<< /Length 35 >>\nstream\n1 0 0 rg 20 20 160 160 re f\nendstream",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
