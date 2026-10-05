// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyBundle } from "../../../src/learned/bundle";
import {
  issueEntitlement,
  OfflineTokenVerifier,
  revokedNonces,
} from "../../../src/learned/entitlement";
import { LEARNED_SCHEMA } from "../../../src/learned/format";
import { UPSTREAM_ACCOUNT } from "../../../src/learned/import";
import { MarinaDB } from "../../../src/persistence/database";
import { AuditLog, verifyAuditLog } from "../src/audit";
import type { MarketRuntime } from "../src/config";
import { importWithEntitlement } from "../src/importer";
import { CORE_SLICE, publishWorld, WORLD_PROFILE } from "../src/world";
import {
  cleanupTemp,
  publisherKey,
  publishSpec,
  tempDir,
  UPSTREAM_ON,
  writeWorldPayload,
} from "./fixtures";

const dbs: MarinaDB[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  cleanupTemp();
});
function freshDb(): MarinaDB {
  const db = new MarinaDB(join(tempDir("market-db-"), "m.db"));
  dbs.push(db);
  return db;
}

function published(opts: { roomCode?: boolean } = {}) {
  const payload = tempDir();
  writeWorldPayload(payload, opts);
  const out = tempDir("market-bundle-");
  const pub = publisherKey();
  const result = publishWorld(payload, out, publishSpec(), pub.key);
  return { payload, out, pub, ...result };
}

describe("marina.world.v1 is a content profile of marina.learned.v1", () => {
  it("publishes one format: a learned bundle with world items, proprietary by default", () => {
    const { out, pub, manifest } = published();
    expect(manifest.schema).toBe(LEARNED_SCHEMA);
    expect(manifest.content_profile).toBe(WORLD_PROFILE);
    expect(manifest.artifact_id.startsWith("marina-world:")).toBe(true);
    expect(manifest.license).toBe("LicenseRef-acme-proprietary");
    expect(manifest.redistribution).toBe("licensee-only");
    expect(manifest.slices.find((s) => s.id === CORE_SLICE)?.access).toBe("open");
    expect(manifest.counts.world).toBe(1);
    const v = verifyBundle(out, [pub.pinned]);
    expect(v.ok).toBe(true);
    expect(verifyBundle(out, []).ok).toBe(false);
    expect(verifyBundle(out, [publisherKey("acme").pinned]).ok).toBe(false);
  });

  it("refuses a tampered item file", () => {
    const { out, pub } = published();
    const file = join(out, "conventions.jsonl");
    writeFileSync(file, readFileSync(file, "utf8").replace("citation", "rumour"));
    const v = verifyBundle(out, [pub.pinned]);
    expect(v.ok).toBe(false);
  });

  it("flags room code for review and never marks it auto-installed", () => {
    const { out } = published({ roomCode: true });
    const spec = JSON.parse(readFileSync(join(out, "spec.json"), "utf8"));
    expect(spec.security).toEqual({
      code_files: ["world/rooms/bench.ts"],
      code_auto_installed: false,
      code_requires_gate: "world.code",
      executable_seed: false,
    });
  });

  it("refuses seeds, unknown files, secrets, symlinks and a paid core", () => {
    const pub = publisherKey();
    const attempt = (mutate: (dir: string) => void, spec = publishSpec()) => {
      const dir = tempDir();
      writeWorldPayload(dir);
      mutate(dir);
      return () => publishWorld(dir, tempDir(), spec, pub.key);
    };
    expect(
      attempt((d) => {
        const w = JSON.parse(readFileSync(join(d, "world/world.json"), "utf8"));
        writeFileSync(join(d, "world/world.json"), JSON.stringify({ ...w, seed: "db => {}" }));
      }),
    ).toThrow('unsupported key "seed"');
    expect(attempt((d) => writeFileSync(join(d, "install.sh"), "curl x | sh\n"))).toThrow(
      "not allowed",
    );
    expect(
      attempt((d) =>
        writeFileSync(
          join(d, "conventions.jsonl"),
          `${JSON.stringify({ id: "x", text: `leaked: ${"sk-"}${"x".repeat(24)}` })}\n`,
        ),
      ),
    ).toThrow("provider api key");
    expect(attempt((d) => symlinkSync("/etc/hostname", join(d, "lessons.jsonl")))).toThrow(
      "symlinks",
    );
    expect(
      attempt(
        () => {},
        publishSpec({ tiers: [{ id: CORE_SLICE, access: "token", include: ["world/"] }] }),
      ),
    ).toThrow("open `tier:core`");
  });
});

describe("paid import through the core importer", () => {
  function setup(roomCode = true) {
    const world = published({ roomCode });
    const audit = new AuditLog(join(tempDir(), "audit.jsonl"));
    const pinned = [world.pub.pinned];
    const rt: Pick<MarketRuntime, "pinned" | "verifiersFor" | "revocations" | "audit"> = {
      pinned,
      revocations: [],
      verifiersFor: (m) => [
        new OfflineTokenVerifier(
          pinned,
          revokedNonces([], pinned, m.publisher.key_id, m.artifact_id),
        ),
      ],
      audit,
    };
    const token = (over: Record<string, unknown> = {}, key = world.pub.key) => ({
      kind: "token",
      token: issueEntitlement(
        {
          artifact_id: world.manifest.artifact_id,
          version_range: "^1.0.0",
          tiers: ["tier:standard"],
          licensee: { label: "lab-buyer" },
          not_after: new Date(Date.now() + 86_400_000).toISOString(),
          ...over,
        },
        key,
      ),
    });
    return { world, audit, rt, token };
  }

  it("imports the free core with no proof and no network; paid items are withheld", async () => {
    const { world, rt } = setup();
    const db = freshDb();
    const r = await importWithEntitlement(db, world.out, rt, { env: UPSTREAM_ON });
    expect(r.ok && r.network_used).toBe(false);
    if (!r.ok || !r.outcome.ok) throw new Error("import failed");
    expect(r.grant).toBeNull();
    expect(r.outcome.report.added).toBe(1);
    expect(r.outcome.report.withheld.length).toBeGreaterThan(0);
    expect(db.listOwnedSpaceRecords(UPSTREAM_ACCOUNT, "upstream:conventions")).toHaveLength(0);
  });

  it("applies the paid slice under a valid token, at trust imported, with room code inert", async () => {
    const { world, rt, token } = setup();
    const db = freshDb();
    const r = await importWithEntitlement(db, world.out, rt, {
      env: UPSTREAM_ON,
      slices: ["tier:standard"],
      proof: token(),
    });
    if (!r.ok || !r.outcome.ok) throw new Error(r.ok ? String(r.outcome.ok) : r.error);
    expect(r.grant).toMatchObject({ verifier: "token", licensee: "lab-buyer" });
    const conventions = db.listOwnedSpaceRecords(UPSTREAM_ACCOUNT, "upstream:conventions");
    expect(JSON.parse(conventions[0]?.metadata ?? "{}").trust).toBe("imported");
    const code = db.listOwnedSpaceRecords(UPSTREAM_ACCOUNT, "upstream:room-sources");
    expect(JSON.parse(code[0]?.metadata ?? "{}")).toMatchObject({
      requires_gate: "world.code",
      executable: false,
    });
    expect(db.getRole("upstream.lab-scout")).toBeTruthy();
  });

  it("refuses expired, mis-scoped, foreign-signed or forged tokens and writes nothing", async () => {
    const { world, rt, token } = setup();
    const ask = async (proof: unknown) => {
      const db = freshDb();
      const r = await importWithEntitlement(db, world.out, rt, {
        env: UPSTREAM_ON,
        slices: ["tier:standard"],
        proof,
      });
      expect(db.listLearnedItems()).toHaveLength(0);
      return r.ok ? "applied" : r.error;
    };
    expect(await ask(token({ not_after: new Date(Date.now() - 1000).toISOString() }))).toContain(
      "expired",
    );
    expect(await ask(token({ tiers: ["tier:full"] }))).toContain("not granted");
    expect(await ask(token({ version_range: "^2.0.0" }))).toContain("outside");
    expect(await ask(token({}, publisherKey("mallory").key))).toContain("not pinned");
    const forged = token();
    forged.token.tiers = ["tier:standard", "tier:full"];
    expect(await ask(forged)).toContain("signature");
  });

  it("keeps a hash-chained audit log whose tampering is detected", async () => {
    const { world, rt, audit, token } = setup();
    await importWithEntitlement(freshDb(), world.out, rt, {
      env: UPSTREAM_ON,
      slices: ["tier:standard"],
      proof: token(),
    });
    expect(verifyAuditLog(audit.path)).toMatchObject({ ok: true });
    const body = readFileSync(audit.path, "utf8");
    expect(body).not.toContain("signature");
    writeFileSync(audit.path, body.replace('"lab-buyer"', '"someone-else"'));
    expect(verifyAuditLog(audit.path)).toMatchObject({ ok: false });
  });
});
