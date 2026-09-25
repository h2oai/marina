// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { arenaConfigFromEnv, loadArenaKey } from "../src/arena/config";
import { ArenaData } from "../src/arena/data";
import {
  backtestSeries,
  forecastRanking,
  forecastScalar,
  horizonSteps,
  PERSISTENCE_SD,
} from "../src/arena/forecast";
import {
  arenaTimestamp,
  canonicalJson,
  generateArenaKey,
  loadPrivateKey,
  publicKeyBase64,
  type SignedMeta,
  signingBytes,
  signRequest,
} from "../src/arena/protocol";
import { crpsNormal, skill } from "../src/arena/score";
import { arenaStatus } from "../src/arena/service";
import { dueRounds, submitRound, validateForecastBody } from "../src/arena/submit";
import type { ArenaPoint, ArenaRound } from "../src/arena/types";
import { MarinaDB } from "../src/persistence/database";
import { cleanupDb } from "./helpers";

/**
 * Produced by the arena's own `ssa/signed_forecasts.py` (Social-Atoms/social-sim-arena
 * at 85608b98) with the Ed25519 seed 00 01 … 1f. Ed25519 is deterministic, so
 * Marina's port must reproduce the signing input and the signature byte for byte.
 */
const GOLDEN = {
  seedHex: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  public: "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=",
  body: '{"round_id":"civiqs-2026-w40-approval","entrant":"marina-test","topline":{"mean":-12.5,"sd":1.1}}',
  meta: {
    entrant: "marina-test",
    "key-id": "k1",
    "request-id": "00000000-0000-4000-8000-000000000001",
    timestamp: "2026-09-25T12:00:00.000000Z",
  } satisfies SignedMeta,
  audience: "ssa-production-v1",
  signingBytes:
    '{"audience":"ssa-production-v1","body_sha256":"bf12ed33b9ebe71cabc9b068fbce20c96268c4e803d56afb983ec96a87644621","entrant":"marina-test","key_id":"k1","method":"POST","path":"/api/v1/forecasts","protocol":"ssa-signed-forecast-v1","request_id":"00000000-0000-4000-8000-000000000001","signed_at":"2026-09-25T12:00:00.000000Z"}',
  signature:
    "sbZgU3/MPQtFnTL1WyhVSINElR5e98ixJEixgMNYd958YaLTcFrZsW1XqBaP8l/U1pZEOC77yF5mDta0N9SbCw==",
};

describe("signed-forecast protocol", () => {
  const key = loadPrivateKey(Buffer.from(GOLDEN.seedHex, "hex"));

  it("reproduces the arena's signing input and signature exactly", () => {
    const bytes = signingBytes(GOLDEN.meta, Buffer.from(GOLDEN.body), GOLDEN.audience);
    expect(bytes.toString()).toBe(GOLDEN.signingBytes);
    expect(signRequest(GOLDEN.meta, Buffer.from(GOLDEN.body), GOLDEN.audience, key)).toBe(
      GOLDEN.signature,
    );
    expect(publicKeyBase64(key)).toBe(GOLDEN.public);
  });

  it("canonical JSON sorts keys, drops whitespace and escapes non-ASCII like Python", () => {
    expect(canonicalJson({ b: 1, a: ["x", { d: null, c: true }] })).toBe(
      '{"a":["x",{"c":true,"d":null}],"b":1}',
    );
    expect(canonicalJson({ name: "Zoë" })).toBe('{"name":"Zo\\u00eb"}');
  });

  it("generates keys that load back from PEM, and stamps microsecond UTC", () => {
    const { privatePem, publicBase64 } = generateArenaKey();
    expect(publicKeyBase64(loadPrivateKey(privatePem))).toBe(publicBase64);
    expect(Buffer.from(publicBase64, "base64")).toHaveLength(32);
    expect(arenaTimestamp(new Date("2026-09-25T12:00:00.123Z"))).toBe(
      "2026-09-25T12:00:00.123000Z",
    );
  });
});

describe("configuration", () => {
  it("is off without an entrant and refuses bad ids or non-https intake", () => {
    expect(arenaConfigFromEnv({})).toBeUndefined();
    expect(() => arenaConfigFromEnv({ MARINA_ARENA_ENTRANT: "Bad Id" })).toThrow();
    expect(() =>
      arenaConfigFromEnv({ MARINA_ARENA_ENTRANT: "h2oai-marina", MARINA_ARENA_URL: "http://x" }),
    ).toThrow("https");
    expect(arenaConfigFromEnv({ MARINA_ARENA_ENTRANT: "h2oai-marina" })).toMatchObject({
      keyId: "k1",
      autopilot: false,
      windowHours: 24,
      audience: "ssa-production-v1",
    });
  });

  it("refuses a signing key other users can read", () => {
    const dir = mkdtempSync(join(tmpdir(), "arena-key-"));
    try {
      const path = join(dir, "k.pem");
      writeFileSync(path, generateArenaKey().privatePem);
      chmodSync(path, 0o644);
      expect(() => loadArenaKey(path)).toThrow("chmod 600");
      chmodSync(path, 0o600);
      expect(loadArenaKey(path).asymmetricKeyType).toBe("ed25519");
      const status = arenaStatus({
        MARINA_ARENA_ENTRANT: "h2oai-marina",
        MARINA_ARENA_KEY_FILE: path,
      });
      expect(status.publicKey).toHaveLength(44);
      expect(arenaStatus({ MARINA_ARENA_ENTRANT: "h2oai-marina" }).keyError).toContain(
        "MARINA_ARENA_KEY_FILE",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const weekly = (values: number[], start = "2026-01-02"): ArenaPoint[] =>
  values.map((value, i) => ({
    date: new Date(Date.parse(start) + i * 7 * 86_400_000).toISOString().slice(0, 10),
    value,
  }));

describe("baseline forecaster", () => {
  it("keeps persistence's mean and calibrates the spread only where it clearly wins", () => {
    // A series that moves ~10 a week: sd 1.5 is hopeless, calibration wins.
    const wild = weekly(Array.from({ length: 40 }, (_, i) => (i % 2 ? 10 : -10) + i * 0.1));
    const release = new Date(Date.parse(wild.at(-1)!.date) + 7 * 86_400_000).toISOString();
    const f = forecastScalar(wild, release);
    expect(f.mean).toBe(wild.at(-1)!.value);
    expect(f.rule).toBe("calibrated");
    expect(f.sd).toBeGreaterThan(10);
    // A series that moves about 1.5 a week already: no clear win, so exact persistence.
    const calm = weekly(Array.from({ length: 40 }, (_, i) => 40 + (i % 2 ? 0.75 : -0.75)));
    const g = forecastScalar(calm, release);
    expect(g.rule).toBe("persistence");
    expect(g.sd).toBe(PERSISTENCE_SD);
  });

  it("counts the horizon in releases between the last point and the answer", () => {
    const h = weekly([1, 2, 3, 4]);
    const last = Date.parse(h.at(-1)!.date);
    expect(horizonSteps(h, new Date(last + 7 * 86_400_000).toISOString())).toBe(1);
    expect(horizonSteps(h, new Date(last + 14 * 86_400_000).toISOString())).toBe(2);
  });

  it("backtests on the held-out half against the arena's persistence", () => {
    const wild = weekly(Array.from({ length: 60 }, (_, i) => (i % 2 ? 8 : -8)));
    const r = backtestSeries(wild);
    expect(r?.rule).toBe("calibrated");
    expect(r!.skill).toBeGreaterThan(0.3);
    expect(backtestSeries(weekly([1, 2, 3]))).toBeUndefined();
  });

  it("ranks Wikipedia by recency-weighted views, skipping Main_Page and non-articles", () => {
    const day = (date: string, views: Record<string, number>) => ({
      date,
      items: Object.keys(views),
      views,
    });
    const ranking = forecastRanking(
      {
        round_id: "wiki-top10-x",
        answer_obs: [
          day("2026-09-20", { Main_Page: 9e6, "Special:Search": 5e6, A: 100, B: 300, C: 50 }),
          day("2026-09-21", { A: 250, B: 100, D: 50 }),
        ],
      },
      3,
    );
    // Recency-weighted (half-life 3 d): B 300×0.79+100 > A 100×0.79+250; D (newest day) > C.
    expect(ranking).toEqual(["B", "A", "D"]);
  });

  it("scores like the arena", () => {
    expect(crpsNormal(0, 1, 0)).toBeCloseTo(0.2337, 3);
    expect(skill(1, 2)).toBe(0.5);
  });
});

describe("answer contract", () => {
  const scalar = { round_id: "r1", target_type: "continuous_normal" } as ArenaRound;
  const profile = {
    round_id: "r2",
    target_type: "profile_energy",
    cells: ["a_x", "b_x"],
  } as ArenaRound;
  const ranking = {
    round_id: "r3",
    target_type: "ranking_list",
    ranking: { length: 2 },
  } as ArenaRound;
  it("refuses what the arena would refuse", () => {
    expect(
      validateForecastBody(scalar, { round_id: "r1", entrant: "e", topline: { mean: 1, sd: 0 } }),
    ).toBeDefined();
    expect(
      validateForecastBody(scalar, { round_id: "r1", entrant: "e", topline: { mean: 1, sd: 1 } }),
    ).toBeUndefined();
    expect(
      validateForecastBody(profile, {
        round_id: "r2",
        entrant: "e",
        profile: { a_x: { mean: 1, sd: 1 } },
      }),
    ).toContain("exactly the round's cells");
    expect(
      validateForecastBody(ranking, { round_id: "r3", entrant: "e", ranking: ["x", "x"] }),
    ).toContain("unique");
    expect(
      validateForecastBody(ranking, { round_id: "r3", entrant: "e", ranking: ["x"] }),
    ).toContain("exactly 2");
  });
});

describe("filing a round", () => {
  const DB = `test_arena_${process.pid}.db`;
  let db: MarinaDB;
  const seed = Buffer.from(GOLDEN.seedHex, "hex");
  const key = loadPrivateKey(seed);
  const now = Date.parse("2026-09-29T20:00:00Z");
  const round: ArenaRound = {
    round_id: "civiqs-2026-w40-approval",
    tracker: "civiqs",
    series: "civiqs_net_approval",
    question: "Net approval?",
    target_type: "continuous_normal",
    lock_at: "2026-09-30T14:00:00Z",
    release_at: "2026-10-02T14:00:00Z",
  };
  const later: ArenaRound = {
    ...round,
    round_id: "civiqs-2026-w41-approval",
    lock_at: "2026-10-07T14:00:00Z",
  };
  const files: Record<string, unknown> = {
    "questions/season0.json": { rounds: [round, later] },
    "locks/civiqs-2026-w40-approval.json": {
      round_id: round.round_id,
      answer_history: weekly(
        Array.from({ length: 40 }, (_, i) => -27 + (i % 3)),
        "2026-01-02",
      ),
    },
  };
  const data = new ArenaData(
    "https://example.test/arena",
    async (url) => {
      const path = url.replace("https://example.test/arena/", "");
      return path in files ? Response.json(files[path]) : new Response("nope", { status: 404 });
    },
    () => now,
  );
  const config = arenaConfigFromEnv({ MARINA_ARENA_ENTRANT: "marina-test" })!;
  let posts: Array<{ url: string; headers: Record<string, string>; body: string }>;
  let reply: () => Response | Promise<Response>;
  const deps = () => ({
    config,
    data,
    store: db,
    key,
    now: () => now,
    post: async (url: string, init: RequestInit) => {
      posts.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
      return reply();
    },
  });

  beforeEach(() => {
    db = new MarinaDB(DB);
    posts = [];
    reply = () => Response.json({ status: "accepted" }, { status: 201 });
  });
  afterEach(() => {
    db.close();
    cleanupDb(DB);
  });

  it("signs a valid forecast the arena can verify, records it, and never files twice", async () => {
    const out = await submitRound(deps(), round.round_id);
    expect(out.kind).toBe("accepted");
    expect(posts).toHaveLength(1);
    const sent = posts[0]!;
    expect(sent.url).toBe("https://social-simulation-arena.com/api/v1/forecasts");
    const body = JSON.parse(sent.body);
    expect(body).toMatchObject({ round_id: round.round_id, entrant: "marina-test" });
    expect(body.topline.sd).toBeGreaterThan(0);
    // Verify exactly as the arena does: signature over signing_bytes(headers, raw body).
    const meta: SignedMeta = {
      entrant: sent.headers["X-SSA-entrant"]!,
      "key-id": sent.headers["X-SSA-key-id"]!,
      "request-id": sent.headers["X-SSA-request-id"]!,
      timestamp: sent.headers["X-SSA-timestamp"]!,
    };
    const ok = verify(
      null,
      signingBytes(meta, Buffer.from(sent.body), "ssa-production-v1"),
      createPublicKey(key),
      Buffer.from(sent.headers["X-SSA-signature"]!, "base64"),
    );
    expect(ok).toBe(true);
    expect(db.latestArenaSubmission("marina-test", round.round_id)?.status).toBe("accepted");

    const again = await submitRound(deps(), round.round_id);
    expect(again).toMatchObject({ kind: "accepted", already: true });
    expect(posts).toHaveLength(1);
  });

  it("re-sends the SAME signed request after a transport failure, and records a 4xx as final", async () => {
    reply = () => {
      throw new Error("socket hang up");
    };
    expect((await submitRound(deps(), round.round_id)).kind).toBe("error");
    reply = () => Response.json({ status: "accepted" }, { status: 201 });
    expect((await submitRound(deps(), round.round_id)).kind).toBe("accepted");
    expect(posts[1]!.headers["X-SSA-request-id"]).toBe(posts[0]!.headers["X-SSA-request-id"]);
    expect(posts[1]!.body).toBe(posts[0]!.body);

    reply = () => Response.json({ error: "invalid_signature" }, { status: 401 });
    const later2 = await submitRound(deps(), later.round_id);
    expect(later2.kind).toBe("skipped"); // no lock file for it → nothing to forecast from
  });

  it("files only rounds inside the window, not ones about to lock, and dry-runs write nothing", async () => {
    expect((await dueRounds(deps())).map((r) => r.round_id)).toEqual([round.round_id]);
    const dry = await submitRound(deps(), round.round_id, { dryRun: true });
    expect(dry.kind).toBe("dry-run");
    expect(posts).toHaveLength(0);
    expect(db.listArenaSubmissions()).toHaveLength(0);
    const closing = { ...deps(), now: () => Date.parse(round.lock_at) - 60_000 };
    expect((await submitRound(closing, round.round_id)).kind).toBe("skipped");
  });

  it("records a rejection and does not re-send it", async () => {
    reply = () => Response.json({ error: "round_closed" }, { status: 422 });
    const out = await submitRound(deps(), round.round_id);
    expect(out).toMatchObject({ kind: "rejected" });
    expect(db.latestArenaSubmission("marina-test", round.round_id)).toMatchObject({
      status: "rejected",
      http_status: 422,
    });
  });
});
