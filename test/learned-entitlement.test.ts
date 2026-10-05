// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Slice-aware, entitlement-gated import of `marina.learned.v1` bundles, and the
 * `marina.world.v1` content profile (world + room_source items).
 *
 * The security property under test: a paid (`token`) item is NEVER written
 * without a grant covering one of its slices, and an `own` grant never unlocks
 * one. Open items stay check-free.
 */

import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleBundle, type UnhashedItem } from "../src/learned/assemble";
import { signRevocations, verifyBundle } from "../src/learned/bundle";
import {
  type EntitlementGrant,
  importContext,
  issueEntitlement,
  OfflineTokenVerifier,
  ownBundleGrant,
  revokedNonces,
  verifyEntitlement,
} from "../src/learned/entitlement";
import { itemKey, REVOCATIONS_SCHEMA, WORLD_PROFILE } from "../src/learned/format";
import { importLearnedBundle, UPSTREAM_ACCOUNT } from "../src/learned/import";
import { generateLearnedKeyPair, type PinnedKey } from "../src/learned/sign";
import { keyIdOfPublicKey } from "../src/net/federation-crypto";
import { MarinaDB } from "../src/persistence/database";

setDefaultTimeout(30_000);

const dirs: string[] = [];
const dbs: MarinaDB[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
function freshDb(): MarinaDB {
  const db = new MarinaDB(join(tmp("learned-ent-db-"), "m.db"));
  dbs.push(db);
  return db;
}
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const KEY = generateLearnedKeyPair();
const OTHER = generateLearnedKeyPair();
const KEY_ID = keyIdOfPublicKey(KEY.publicKey);
const pinned: PinnedKey[] = [
  { label: "acme", publicKey: KEY.publicKey, keyId: KEY_ID },
  { label: "other", publicKey: OTHER.publicKey, keyId: keyIdOfPublicKey(OTHER.publicKey) },
];
const ON = { MARINA_UPSTREAM: "on" } as NodeJS.ProcessEnv;

const conv = (id: string, text: string, tier: "core" | "standard"): UnhashedItem => ({
  kind: "convention",
  item_key: itemKey("convention", KEY_ID, id),
  domain: "conventions",
  tier,
  provenance: [{ producer: "curator", origin: "publisher" }],
  pool: "guide",
  text,
  ratified: { basis: "curated", by: "ratifier" },
});

const FREE = conv("free", "state the plan before the first tool call", "core");
const PAID = conv("paid", "pair a skeptic with every forecaster", "standard");

const WORLD: UnhashedItem = {
  kind: "world",
  item_key: itemKey("world", KEY_ID, "lab"),
  domain: "worlds",
  tier: "core",
  provenance: [{ producer: "curator", origin: "publisher" }],
  world: {
    name: "Research Lab",
    description: "A small lab world.",
    start_room: "lab/lobby",
    rooms: [
      { id: "lab/lobby", short: "Lobby", exits: { north: "lab/bench" } },
      { id: "lab/bench", short: "Bench", exits: { south: "lab/lobby" } },
    ],
  },
};
const ROOM_CODE: UnhashedItem = {
  kind: "room_source",
  item_key: itemKey("room_source", KEY_ID, "lab/bench"),
  domain: "worlds",
  tier: "standard",
  provenance: [{ producer: "curator", origin: "publisher" }],
  room_id: "lab/bench",
  language: "typescript",
  requires_gate: "world.code",
  // Would set a global if it were ever evaluated. It must not be.
  source:
    "(globalThis as any).__learnedRoomSourceRan = true;\nexport default { short: 'Bench' };\n",
};

/** core = open (free), standard = token (paid). */
function paidBundle(
  items: UnhashedItem[] = [FREE, PAID],
  world = false,
): {
  dir: string;
  artifactId: string;
} {
  const dir = tmp("learned-ent-bundle-");
  const core = items.filter((i) => i.tier === "core").map((i) => i.item_key);
  const standard = items.map((i) => i.item_key);
  const manifest = assembleBundle({
    outDir: dir,
    signingKey: KEY.privateKey,
    name: "lab-pack",
    version: "1.2.0",
    generation: 1,
    publisher: { name: "acme" },
    ...(world ? { contentProfile: WORLD_PROFILE } : {}),
    access: { model: "token", entitlement_issuers: [] },
    items,
    slices: [
      { id: "tier:core", item_keys: core, access: "open" },
      { id: "tier:standard", item_keys: standard, access: "token" },
    ],
    minMarinaVersion: "0.7.0",
  });
  return { dir, artifactId: manifest.artifact_id };
}

async function grantFor(
  artifactId: string,
  over: Record<string, unknown> = {},
  key = KEY.privateKey,
  revoked: Set<string> = new Set(),
): Promise<EntitlementGrant | string> {
  const token = issueEntitlement(
    {
      artifact_id: artifactId,
      version_range: "^1.0.0",
      tiers: ["tier:standard"],
      licensee: { label: "lab-buyer" },
      not_after: new Date(Date.now() + 3_600_000).toISOString(),
      ...over,
    },
    key,
  );
  const verified = verifyBundle(paidBundleDirFor.get(artifactId)!, pinned);
  if (!verified.ok) throw new Error(verified.error);
  const decision = await verifyEntitlement(
    { kind: "token", token },
    importContext(verified.bundle.manifest, ["tier:standard"]),
    [new OfflineTokenVerifier(pinned, revoked)],
  );
  return decision.ok ? decision.grant : decision.reason;
}
const paidBundleDirFor = new Map<string, string>();
function bundle(items?: UnhashedItem[], world = false) {
  const b = paidBundle(items, world);
  paidBundleDirFor.set(b.artifactId, b.dir);
  return b;
}

const contents = (db: MarinaDB, prefix: string) =>
  db.listOwnedSpaceRecords(UPSTREAM_ACCOUNT, prefix).map((r) => r.content);

describe("entitlement-gated import (security)", () => {
  it("never writes a paid item without a grant, and leaves open items check-free", async () => {
    const { dir, artifactId } = bundle();
    const db = freshDb();
    const out = await importLearnedBundle(db, dir, { pinned, env: ON });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.report.added).toBe(1);
    expect(out.report.withheld).toEqual([
      { item_key: PAID.item_key, reason: "entitlement required" },
    ]);
    expect(contents(db, "upstream:conventions")).toEqual([
      "state the plan before the first tool call",
    ]);
    expect(db.getLearnedItem(artifactId, PAID.item_key)).toBeUndefined();
  });

  it("an `own` grant never unlocks a paid slice", async () => {
    const { dir, artifactId } = bundle();
    const db = freshDb();
    const own = await importLearnedBundle(db, dir, {
      pinned,
      env: ON,
      entitlement: ownBundleGrant("operator"),
    });
    expect(own.ok && own.report.withheld.length).toBe(1);
    expect(db.getLearnedItem(artifactId, PAID.item_key)).toBeUndefined();
    const asked = await importLearnedBundle(freshDb(), dir, {
      pinned,
      env: ON,
      slices: ["tier:standard"],
      entitlement: ownBundleGrant("operator"),
    });
    expect(asked).toMatchObject({ ok: false });
  });

  it("refuses a requested paid slice without a grant, and an unknown slice", async () => {
    const { dir } = bundle();
    const db = freshDb();
    const out = await importLearnedBundle(db, dir, { pinned, env: ON, slices: ["tier:standard"] });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("entitlement covering it is required");
    expect(db.listLearnedItems()).toHaveLength(0);
    expect(db.listUpstreamEvents().at(-1)).toMatchObject({ action: "import", outcome: "refused" });
    const unknown = await importLearnedBundle(freshDb(), dir, { pinned, env: ON, slices: ["x"] });
    expect(unknown.ok).toBe(false);
  });

  it("writes the paid slice under a verified token grant, at trust imported", async () => {
    const { dir, artifactId } = bundle();
    const grant = await grantFor(artifactId);
    expect(typeof grant).toBe("object");
    const db = freshDb();
    const out = await importLearnedBundle(db, dir, {
      pinned,
      env: ON,
      slices: ["tier:standard"],
      entitlement: grant as EntitlementGrant,
    });
    expect(out.ok && out.report.added).toBe(2);
    const paid = db
      .listOwnedSpaceRecords(UPSTREAM_ACCOUNT, "upstream:conventions")
      .find((r) => r.content === "pair a skeptic with every forecaster");
    expect(JSON.parse(paid?.metadata ?? "{}").trust).toBe("imported");
    expect(db.listUpstreamEvents().some((e) => e.action === "entitlement")).toBe(true);
  });

  it("limiting an import to the free core never retires paid items imported earlier", async () => {
    const { dir, artifactId } = bundle();
    const db = freshDb();
    const grant = (await grantFor(artifactId)) as EntitlementGrant;
    await importLearnedBundle(db, dir, { pinned, env: ON, entitlement: grant });
    expect(db.getLearnedItem(artifactId, PAID.item_key)?.status).toBe("active");
    const coreOnly = await importLearnedBundle(db, dir, { pinned, env: ON, slices: ["tier:core"] });
    expect(coreOnly.ok && coreOnly.report.retired).toBe(0);
    expect(db.getLearnedItem(artifactId, PAID.item_key)?.status).toBe("active");
  });

  it("the offline verifier refuses forged, expired, mis-scoped, foreign and revoked tokens", async () => {
    const { artifactId } = bundle();
    expect(await grantFor(artifactId, { not_after: new Date(Date.now() - 1).toISOString() })).toBe(
      "token expired",
    );
    expect(await grantFor(artifactId, { tiers: ["tier:full"] })).toContain("not granted");
    expect(await grantFor(artifactId, { version_range: "^2.0.0" })).toContain("outside");
    expect(await grantFor(artifactId, { artifact_id: `${artifactId}x` })).toContain(
      "different artifact",
    );
    // Pinned, but not this artifact's publisher or a listed issuer.
    expect(await grantFor(artifactId, {}, OTHER.privateKey)).toContain("issuer");
    expect(
      await grantFor(artifactId, { nonce: "n-1" }, KEY.privateKey, new Set(["n-1"])),
    ).toContain("revoked");
    // An unpinned signer is refused outright.
    const stranger = generateLearnedKeyPair();
    expect(await grantFor(artifactId, {}, stranger.privateKey)).toContain("not pinned");
  });

  it("a publisher-revoked token nonce refuses the import even with a grant", async () => {
    const { dir, artifactId } = bundle();
    const grant = (await grantFor(artifactId, { nonce: "nonce-7" })) as EntitlementGrant;
    const revocations = signRevocations(
      {
        schema: REVOCATIONS_SCHEMA,
        publisher_key_id: KEY_ID,
        issued_at: new Date().toISOString(),
        entries: [
          {
            artifact_id: artifactId,
            entitlement_nonce: "nonce-7",
            reason: "refund",
            severity: "retire",
          },
        ],
      },
      KEY.privateKey,
    );
    expect(revokedNonces([revocations], pinned, KEY_ID, artifactId)).toEqual(new Set(["nonce-7"]));
    const db = freshDb();
    const out = await importLearnedBundle(db, dir, {
      pinned,
      env: ON,
      revocations: [revocations],
      entitlement: grant,
    });
    expect(out).toMatchObject({ ok: false });
    expect(db.listLearnedItems()).toHaveLength(0);
  });

  it("refuses when every selected item needs an entitlement", async () => {
    const { dir } = bundle([PAID]);
    const out = await importLearnedBundle(freshDb(), dir, { pinned, env: ON });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("needs an entitlement");
  });
});

describe("marina.world.v1 content profile", () => {
  it("imports a world document and room source as inert, imported records", async () => {
    const { dir, artifactId } = bundle([WORLD, ROOM_CODE], true);
    const verified = verifyBundle(dir, pinned);
    expect(verified.ok && verified.bundle.manifest.content_profile).toBe(WORLD_PROFILE);
    expect(artifactId.startsWith("marina-world:")).toBe(true);
    const db = freshDb();
    const free = await importLearnedBundle(db, dir, { pinned, env: ON });
    expect(free.ok && free.report.withheld.map((w) => w.item_key)).toEqual([ROOM_CODE.item_key]);
    const grant = (await grantFor(artifactId)) as EntitlementGrant;
    const paid = await importLearnedBundle(db, dir, { pinned, env: ON, entitlement: grant });
    expect(paid.ok).toBe(true);
    const worlds = db.listOwnedSpaceRecords(UPSTREAM_ACCOUNT, "upstream:worlds");
    expect(JSON.parse(worlds[0]?.content ?? "{}").name).toBe("Research Lab");
    const code = db.listOwnedSpaceRecords(UPSTREAM_ACCOUNT, "upstream:room-sources");
    expect(JSON.parse(code[0]?.metadata ?? "{}")).toMatchObject({
      trust: "imported",
      requires_gate: "world.code",
      executable: false,
    });
    expect((globalThis as Record<string, unknown>).__learnedRoomSourceRan).toBeUndefined();
  });

  it("refuses to assemble a world that carries behaviour", () => {
    const seeded = {
      ...WORLD,
      world: { ...(WORLD as { world: object }).world, seed: "db => db.exec('drop')" },
    } as unknown as UnhashedItem;
    expect(() => bundle([seeded], true)).toThrow('unsupported key "seed"');
    const badGate = { ...ROOM_CODE, requires_gate: "none" } as unknown as UnhashedItem;
    expect(() => bundle([WORLD, badGate], true)).toThrow("requires_gate");
  });
});
