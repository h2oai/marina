import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { handleCanvasApi } from "../src/net/canvas-api";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb } from "./helpers";

const TEST_DB = "test_canvas_api_auth.db";

function req(path: string, method: string, token?: string): [URL, string, Request] {
  const url = new URL(`http://localhost:3300${path}`);
  const r = new Request(url.toString(), {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return [url, method, r];
}

describe("canvas API auth contract", () => {
  let db: MarinaDB;
  let engine: Engine;

  beforeEach(() => {
    // MARINA_OPEN_API must be off — the whole point is fresh, unauthenticated
    // viewing without the dev bypass.
    process.env.MARINA_OPEN_API = undefined;
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("allows GET reads without a session token (fresh open must not 401)", async () => {
    const [url, method, r] = req("/api/canvases", "GET");
    const resp = await handleCanvasApi(url, method, r, db, undefined, undefined, engine);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });

  it("still requires a token for mutations (POST create)", async () => {
    const [url, method, r] = req("/api/canvases", "POST");
    const resp = await handleCanvasApi(url, method, r, db, undefined, undefined, engine);
    expect(resp.status).toBe(401);
  });
});
