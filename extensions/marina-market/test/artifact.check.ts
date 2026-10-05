// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AuditLog, verifyAuditLog } from "../src/audit";
import { issueEntitlement, OfflineTokenVerifier } from "../src/entitlements";
import { LEARNED_SCHEMA, openBundle } from "../src/envelope";
import { applyPlan, planImport } from "../src/importer";
import { publishWorld, WORLD_PROFILE } from "../src/world";
import { cleanupTemp, publisherKey, publishSpec, tempDir, writeWorldPayload } from "./fixtures";

afterEach(cleanupTemp);

function published(opts: { roomCode?: boolean } = {}) {
  const dir = tempDir();
  writeWorldPayload(dir, opts);
  const key = publisherKey();
  const result = publishWorld(dir, publishSpec(), key.pem);
  return { dir, key, ...result };
}

describe("marina.world.v1 inside the marina.learned.v1 envelope", () => {
  it("is one format: a learned envelope with a world content profile and proprietary default licence", () => {
    const { manifest, key } = published();
    expect(manifest.schema).toBe(LEARNED_SCHEMA);
    expect(manifest.content_profile).toBe(WORLD_PROFILE);
    expect(manifest.artifact_id.startsWith("marina-world:sha256:")).toBe(true);
    expect(manifest.license).toBe("LicenseRef-acme-proprietary");
    expect(manifest.redistribution).toBe("licensee-only");
    expect(manifest.publisher.public_key).toBe(key.pinned.public_key);
    expect(manifest.slices.find((s) => s.id === "core")?.access).toBe("open");
    expect(manifest.access.model).toBe("token");
  });

  it("verifies only against a pinned key", () => {
    const { dir, key } = published();
    expect(openBundle(dir, [key.pinned]).manifest.version).toBe("1.2.0");
    expect(() => openBundle(dir, [])).toThrow("not pinned");
    // A different pinned key under the same name does not help.
    expect(() => openBundle(dir, [publisherKey("acme").pinned])).toThrow("not pinned");
  });

  it("refuses a tampered payload file or manifest", () => {
    const { dir, key } = published();
    writeFileSync(join(dir, "lessons.jsonl"), '{"item_key":"l1","text":"altered"}\n');
    expect(() => openBundle(dir, [key.pinned])).toThrow("digest mismatch");

    const second = published();
    const manifest = JSON.parse(readFileSync(join(second.dir, "manifest.json"), "utf8"));
    manifest.license = "CC0-1.0";
    writeFileSync(join(second.dir, "manifest.json"), JSON.stringify(manifest));
    expect(() => openBundle(second.dir, [second.key.pinned])).toThrow("signature refused");
  });

  it("flags room code for review and never marks it auto-installed", () => {
    const { dir, key } = published({ roomCode: true });
    const spec = JSON.parse(readFileSync(join(dir, "spec.json"), "utf8"));
    expect(spec.security).toEqual({
      code_files: ["world/rooms/bench.ts"],
      code_auto_installed: false,
      code_requires_gate: "world.code",
      executable_seed: false,
    });
    expect(openBundle(dir, [key.pinned]).manifest.files["world/rooms/bench.ts"]).toBeDefined();
  });

  it("refuses executable seeds, unknown files, secrets, symlinks and a paid core", () => {
    const key = publisherKey();
    const seeded = tempDir();
    writeWorldPayload(seeded);
    const world = JSON.parse(readFileSync(join(seeded, "world/world.json"), "utf8"));
    writeFileSync(join(seeded, "world/world.json"), JSON.stringify({ ...world, seed: "db => {}" }));
    expect(() => publishWorld(seeded, publishSpec(), key.pem)).toThrow('unsupported key "seed"');

    const stray = tempDir();
    writeWorldPayload(stray);
    writeFileSync(join(stray, "install.sh"), "curl x | sh\n");
    expect(() => publishWorld(stray, publishSpec(), key.pem)).toThrow("not allowed");

    const leaky = tempDir();
    writeWorldPayload(leaky);
    writeFileSync(
      join(leaky, "conventions.jsonl"),
      `${JSON.stringify({ text: `leaked: ${"sk-"}${"x".repeat(24)}` })}\n`,
    );
    expect(() => publishWorld(leaky, publishSpec(), key.pem)).toThrow("provider api key");

    const linked = tempDir();
    writeWorldPayload(linked);
    symlinkSync("/etc/hostname", join(linked, "defaults.json"));
    expect(() => publishWorld(linked, publishSpec(), key.pem)).toThrow("symlinks");

    const paidCore = tempDir();
    writeWorldPayload(paidCore);
    expect(() =>
      publishWorld(
        paidCore,
        publishSpec({ tiers: [{ id: "core", access: "token", include: ["world/"] }] }),
        key.pem,
      ),
    ).toThrow("open `core` tier");
  });
});

describe("import planning: the entitlement gate", () => {
  function setup() {
    const world = published({ roomCode: true });
    const audit = new AuditLog(join(tempDir(), "audit.jsonl"));
    const deps = {
      pinned: [world.key.pinned],
      verifiers: [new OfflineTokenVerifier([world.key.pinned], new Set(["revoked-nonce"]))],
      audit,
    };
    const token = (overrides: Record<string, unknown> = {}, pem = world.key.pem) => ({
      kind: "token",
      token: issueEntitlement(
        {
          artifact_id: world.manifest.artifact_id,
          version_range: "^1.0.0",
          tiers: ["standard"],
          licensee: { label: "lab-buyer" },
          not_after: new Date(Date.now() + 86_400_000).toISOString(),
          ...overrides,
        },
        pem,
      ),
    });
    return { world, audit, deps, token };
  }

  it("imports the free core with no proof and no network, at trust imported", async () => {
    const { world, deps } = setup();
    const plan = await planImport(world.dir, {}, deps);
    expect(plan.slices).toEqual(["core"]);
    expect(plan.entitlement).toBeNull();
    expect(plan.network_used).toBe(false);
    expect(plan.trust).toBe("imported");
    expect(plan.files).toContain("world/world.json");
    expect(plan.files).not.toContain("lessons.jsonl");
    expect(plan.code_files_for_review).toEqual(["world/rooms/bench.ts"]);
  });

  it("refuses a paid tier without a proof, and audits it", async () => {
    const { world, deps, audit } = setup();
    await expect(planImport(world.dir, { slices: ["core", "standard"] }, deps)).rejects.toThrow(
      "need an entitlement",
    );
    expect(readFileSync(audit.path, "utf8")).toContain('"outcome":"refused"');
  });

  it("grants a paid tier with a valid publisher-signed token", async () => {
    const { world, deps, token } = setup();
    const plan = await planImport(
      world.dir,
      { slices: ["core", "standard"], proof: token() },
      deps,
    );
    expect(plan.files).toContain("lessons.jsonl");
    expect(plan.entitlement).toMatchObject({ verifier: "token", licensee: "lab-buyer" });
    expect(plan.trust).toBe("imported");
  });

  it("refuses expired, mis-scoped, revoked or foreign-signed tokens", async () => {
    const { world, deps, token } = setup();
    const ask = (proof: unknown) => planImport(world.dir, { slices: ["standard"], proof }, deps);
    await expect(
      ask(token({ not_after: new Date(Date.now() - 1000).toISOString() })),
    ).rejects.toThrow("expired");
    await expect(ask(token({ tiers: ["full"] }))).rejects.toThrow("tiers not granted");
    await expect(ask(token({ version_range: "^2.0.0" }))).rejects.toThrow("outside");
    await expect(ask(token({ artifact_id: `${world.manifest.artifact_id}x` }))).rejects.toThrow(
      "different artifact",
    );
    await expect(ask(token({ nonce: "revoked-nonce" }))).rejects.toThrow("revoked");
    await expect(ask(token({}, publisherKey("mallory").pem))).rejects.toThrow("not pinned");
    const forged = token();
    forged.token.tiers = ["standard", "full"];
    await expect(ask(forged)).rejects.toThrow("signature");
  });

  it("apply hands off to the core importer and never writes on its own", async () => {
    const { world, deps, audit } = setup();
    const plan = await planImport(world.dir, {}, deps);
    const missing = await applyPlan(world.dir, plan, audit);
    expect(missing.applied).toBe(false);
    expect(missing.detail).toContain("part C");
    const calls: unknown[] = [];
    const done = await applyPlan(world.dir, plan, audit, {
      async importBundle(dir, options) {
        calls.push({ dir, options });
        return { applied: 2 };
      },
    });
    expect(done.applied).toBe(true);
    expect(calls).toEqual([
      { dir: world.dir, options: { slices: ["core"], trust: "imported", files: plan.files } },
    ]);
  });

  it("keeps a hash-chained audit log whose tampering is detected", async () => {
    const { world, deps, audit, token } = setup();
    await planImport(world.dir, {}, deps);
    await planImport(world.dir, { slices: ["standard"], proof: token() }, deps);
    expect(verifyAuditLog(audit.path)).toEqual({ ok: true, entries: 3 });
    const body = readFileSync(audit.path, "utf8");
    expect(body).not.toContain("signature");
    writeFileSync(audit.path, body.replace('"lab-buyer"', '"someone-else"'));
    expect(verifyAuditLog(audit.path)).toMatchObject({ ok: false });
  });
});
