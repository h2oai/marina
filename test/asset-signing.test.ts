// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Short-lived signed asset URLs (src/net/api/asset-signing.ts): `<img>` and
 * friends cannot send a bearer, so a remote viewer reads a private asset's
 * bytes through a URL signed for them. The signature is identity, never
 * access: the private-asset read check still runs as the signed principal, and
 * an expired, tampered or foreign signature reads like no signature at all.
 */

import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAssetApi, handleAssetServing } from "../src/net/api/asset-api";
import {
  ASSET_URL_TTL_SECONDS,
  assetIdFromKey,
  assetKeyFromPath,
  MAX_SIGN_BATCH,
  maySignFor,
  resetAssetSigningSecretForTests,
  signAssetId,
  signedAssetUrl,
  verifyAssetSignature,
} from "../src/net/api/asset-signing";
import { DESKTOP_OPERATOR_ENTITY_ID, OPEN_API_ENTITY_ID } from "../src/net/auth-middleware";
import { LOOPBACK_PRINCIPAL } from "../src/net/canvas/canvas-principal";
import { resetHttpRateLimitersForTests } from "../src/net/http-utils";
import { LocalStorageProvider } from "../src/storage/local-provider";
import type { EntityId } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { MockConnection } from "./helpers";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2]);
const REMOTE = "203.0.113.9";
const NOW = 1_800_000_000;

describe("asset URL signatures (pure)", () => {
  afterEach(() => resetAssetSigningSecretForTests());

  it("verifies its own signature and names the principal", () => {
    const { p, exp, sig } = signAssetId("a1", "e_owner", NOW);
    expect(exp).toBe(NOW + ASSET_URL_TTL_SECONDS);
    const params = new URLSearchParams({ p, exp: String(exp), sig });
    expect(verifyAssetSignature("a1", params, NOW)).toEqual({ principal: "e_owner", exp });
    expect(verifyAssetSignature("a1", params, exp)).toEqual({ principal: "e_owner", exp });
  });

  it("refuses an expired, re-addressed, re-attributed or re-dated signature", () => {
    const { p, exp, sig } = signAssetId("a1", "e_owner", NOW);
    const ok = { p, exp: String(exp), sig };
    const check = (id: string, over: Record<string, string>, now = NOW) =>
      verifyAssetSignature(id, new URLSearchParams({ ...ok, ...over }), now);
    expect(check("a1", {}, exp + 1)).toBeUndefined(); // expired
    expect(check("a2", {})).toBeUndefined(); // another asset
    expect(check("a1", { p: "e_other" })).toBeUndefined(); // another principal
    expect(check("a1", { exp: String(exp + 60) })).toBeUndefined(); // extended
    const flipped = `${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`;
    expect(check("a1", { sig: flipped })).toBeUndefined(); // tampered
    expect(check("a1", { exp: "1e12" })).toBeUndefined();
    expect(check("a1", { sig: "" })).toBeUndefined();
    // A signature dated beyond the lifetime is refused even if it verified.
    const far = signAssetId("a1", "e_owner", NOW + 3_600);
    expect(
      verifyAssetSignature(
        "a1",
        new URLSearchParams({ p: far.p, exp: String(far.exp), sig: far.sig }),
        NOW,
      ),
    ).toBeUndefined();
  });

  it("dies with the process secret", () => {
    const { p, exp, sig } = signAssetId("a1", "e_owner", NOW);
    resetAssetSigningSecretForTests();
    expect(
      verifyAssetSignature("a1", new URLSearchParams({ p, exp: String(exp), sig }), NOW),
    ).toBeUndefined();
  });

  it("never names a sentinel principal", () => {
    expect(maySignFor("e_owner")).toBe(true);
    for (const s of [LOOPBACK_PRINCIPAL, OPEN_API_ENTITY_ID, DESKTOP_OPERATOR_ENTITY_ID, ""]) {
      expect(maySignFor(s)).toBe(false);
      const { exp, sig } = signAssetId("a1", s, NOW);
      expect(
        verifyAssetSignature("a1", new URLSearchParams({ p: s, exp: String(exp), sig }), NOW),
      ).toBeUndefined();
    }
  });

  it("parses asset paths and appends parameters", () => {
    expect(assetKeyFromPath("/assets/abc.png")).toBe("abc.png");
    expect(assetKeyFromPath("/assets/abc.png?x=1")).toBe("abc.png");
    expect(assetKeyFromPath("https://evil.example/assets/abc.png")).toBeUndefined();
    expect(assetKeyFromPath("/assets/a/b.png")).toBeUndefined();
    expect(assetKeyFromPath("/api/assets/abc")).toBeUndefined();
    expect(assetIdFromKey("abc.png")).toBe("abc");
    const signed = signedAssetUrl("/assets/abc.png", "abc", "e_owner", NOW);
    const url = new URL(signed.url, "http://x");
    expect(url.pathname).toBe("/assets/abc.png");
    expect(url.searchParams.get("p")).toBe("e_owner");
    expect(signed.expiresAt).toBe(NOW + ASSET_URL_TTL_SECONDS);
  });
});

describe("signed asset URLs over HTTP", () => {
  let dir: string;
  let fixture: ReturnType<typeof createTestEngine>;
  let owner: { id: EntityId; token: string };
  let stranger: { id: EntityId; token: string };

  function enter(name: string, rank: number) {
    const conn = new MockConnection(`c-${name}`);
    conn.peerIp = REMOTE;
    fixture.engine.addConnection(conn);
    const login = fixture.engine.login(conn.id, name);
    if (!("token" in login)) throw new Error(`login failed: ${login.error}`);
    fixture.engine.entities.get(login.entityId)!.properties.rank = rank;
    return { id: login.entityId, token: login.token };
  }

  async function addAsset(id: string, metadata: Record<string, unknown>) {
    await fixture.engine.storage!.put(`${id}.png`, PNG, "image/png");
    fixture.db.createAsset({
      id,
      entityName: "Owner",
      filename: `${id}.png`,
      mimeType: "image/png",
      size: PNG.byteLength,
      storageKey: `${id}.png`,
      metadata,
    });
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "asset-signing-"));
    const storage = new LocalStorageProvider(dir);
    await storage.init();
    fixture = createTestEngine({ assetStorage: storage });
    resetHttpRateLimitersForTests();
    resetAssetSigningSecretForTests();
    owner = enter("Owner", 1);
    stranger = enter("Stranger", 4);
    await addAsset("req1", { origin: "request", owner: owner.id });
    await addAsset("req2", { origin: "request", owner: owner.id });
    await addAsset("pub1", {});
  });

  afterEach(async () => {
    setSystemTime();
    resetAssetSigningSecretForTests();
    await fixture.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  async function sign(token: string | undefined, body: unknown): Promise<Response> {
    const url = new URL("http://localhost:3300/api/assets/sign");
    const req = new Request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return handleAssetApi(
      url,
      "POST",
      req,
      fixture.db,
      fixture.engine.storage!,
      fixture.engine,
      REMOTE,
    );
  }

  /** A header-less remote read, as an `<img>` makes it. */
  async function bytes(path: string): Promise<Response> {
    const url = new URL(`http://localhost:3300${path}`);
    return handleAssetServing(url, fixture.engine.storage!, fixture.db, {
      engine: fixture.engine,
      req: new Request(url),
      peerIp: REMOTE,
    });
  }

  type Signed = { urls: Record<string, { url: string; expiresAt: number | null }> };

  it("a remote viewer cannot read a private asset without a header (the bug)", async () => {
    expect((await bytes("/assets/req1.png")).status).toBe(404);
    expect((await bytes("/assets/pub1.png")).status).toBe(200);
  });

  it("the owner's signed URL reads the private asset, privately cached", async () => {
    const res = await sign(owner.token, { urls: ["/assets/req1.png", "/assets/pub1.png"] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Signed;
    const entry = body.urls["/assets/req1.png"]!;
    expect(entry.url).toContain("sig=");
    expect(entry.expiresAt).toBeGreaterThan(Date.now() / 1000);
    const served = await bytes(entry.url);
    expect(served.status).toBe(200);
    expect(served.headers.get("Cache-Control")).toMatch(/^private, max-age=\d+$/);
    // Public assets come back unsigned and keep their immutable caching.
    expect(body.urls["/assets/pub1.png"]).toEqual({ url: "/assets/pub1.png", expiresAt: null });
    expect((await bytes("/assets/pub1.png")).headers.get("Cache-Control")).toContain("public");
  });

  it("a stranger gets nothing to sign, and a signature for them reads nothing", async () => {
    const body = (await (
      await sign(stranger.token, { urls: ["/assets/req1.png"] })
    ).json()) as Signed;
    expect(body.urls).toEqual({});
    // A genuine signature naming the stranger is identity, not access.
    const theirs = signedAssetUrl("/assets/req1.png", "req1", stranger.id);
    expect((await bytes(theirs.url)).status).toBe(404);
  });

  it("a signature is bound to its asset, its principal and its lifetime", async () => {
    const body = (await (await sign(owner.token, { urls: ["/assets/req1.png"] })).json()) as Signed;
    const signed = new URL(body.urls["/assets/req1.png"]!.url, "http://x");
    // Same owner, another asset: refused.
    expect((await bytes(`/assets/req2.png${signed.search}`)).status).toBe(404);
    // Stranger re-attributes the owner's signature to themselves: refused.
    const reattributed = new URLSearchParams(signed.search);
    reattributed.set("p", stranger.id);
    expect((await bytes(`/assets/req1.png?${reattributed}`)).status).toBe(404);
    // After expiry it reads like an anonymous request.
    setSystemTime(new Date(Date.now() + (ASSET_URL_TTL_SECONDS + 5) * 1000));
    expect((await bytes(`/assets/req1.png${signed.search}`)).status).toBe(404);
  });

  it("refuses an unauthenticated or malformed signing request", async () => {
    expect((await sign(undefined, { urls: ["/assets/req1.png"] })).status).toBe(401);
    expect((await sign(owner.token, { urls: "nope" })).status).toBe(400);
    expect((await sign(owner.token, { urls: [1] })).status).toBe(400);
    const many = Array.from({ length: MAX_SIGN_BATCH + 1 }, (_, i) => `/assets/x${i}.png`);
    expect((await sign(owner.token, { urls: many })).status).toBe(400);
    const odd = (await (
      await sign(owner.token, { urls: ["https://elsewhere/x.png", "/assets/missing.png"] })
    ).json()) as Signed;
    expect(odd.urls).toEqual({});
  });
});
