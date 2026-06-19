import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { handleDashboardApi } from "../src/net/dashboard-api";
import {
  type CodingArtifactRow,
  type CodingEventRow,
  type CodingSessionRow,
  MarinaDB,
} from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, makeTestRoom } from "./helpers";

const TEST_DB = "test_coding_api.db";

/**
 * The coding snapshot API backs the WebChat StatusOverlay session/artifact
 * views — read-only, auth-gated GETs that mirror /api/coordination/* shape.
 * These tests pin the three routes: session list ({ items, total }), session
 * detail ({ session, events, artifacts }), and the kind-filterable artifacts
 * list, plus the 404 on an unknown session id.
 */
describe("coding snapshot API", () => {
  let db: MarinaDB;
  let engine: Engine;
  let prevOpenApi: string | undefined;

  beforeEach(() => {
    prevOpenApi = process.env.MARINA_OPEN_API;
    process.env.MARINA_OPEN_API = "true"; // open the auth gate for GET routes
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
    if (prevOpenApi === undefined) delete process.env.MARINA_OPEN_API;
    else process.env.MARINA_OPEN_API = prevOpenApi;
  });

  const get = async (path: string, expectStatus = 200) => {
    const url = new URL(`http://localhost:3300${path}`);
    const req = new Request(url.toString(), { method: "GET" });
    const resp = await handleDashboardApi(req, url, "GET", engine, db);
    expect(resp?.status).toBe(expectStatus);
    return resp!.json();
  };

  const seedSession = (id: string, createdBy: string) => {
    db.createCodingSession({
      id,
      title: `Session ${id}`,
      workspaceRoot: "/tmp/ws",
      createdBy,
    });
  };

  it("lists seeded sessions with { items, total }", async () => {
    seedSession("s_1", "Alice");
    seedSession("s_2", "Bob");

    const all = (await get("/api/coding/sessions")) as {
      items: CodingSessionRow[];
      total: number;
    };
    expect(all.total).toBe(2);
    expect(all.items.length).toBe(2);
    expect(all.items.map((s) => s.id).sort()).toEqual(["s_1", "s_2"]);

    // createdBy filter narrows to one author.
    const mine = (await get("/api/coding/sessions?createdBy=Alice")) as {
      items: CodingSessionRow[];
      total: number;
    };
    expect(mine.total).toBe(1);
    expect(mine.items[0]!.created_by).toBe("Alice");
  });

  it("returns session + events + artifacts on detail", async () => {
    seedSession("s_1", "Alice");
    db.createCodingEvent({
      sessionId: "s_1",
      actor: "Alice",
      kind: "command",
      payload: { input: "code start" },
    });
    db.createCodingArtifact({
      sessionId: "s_1",
      kind: "patch",
      title: "fix bug",
      contentText: "--- a\n+++ b\n",
      createdBy: "Alice",
    });

    const detail = (await get("/api/coding/session/s_1")) as {
      session: CodingSessionRow;
      events: CodingEventRow[];
      artifacts: CodingArtifactRow[];
    };
    expect(detail.session.id).toBe("s_1");
    expect(detail.events.length).toBe(1);
    expect(detail.events[0]!.kind).toBe("command");
    expect(detail.artifacts.length).toBe(1);
    expect(detail.artifacts[0]!.kind).toBe("patch");
  });

  it("filters the artifacts list by kind", async () => {
    seedSession("s_1", "Alice");
    db.createCodingArtifact({
      sessionId: "s_1",
      kind: "patch",
      title: "a patch",
      contentText: "diff",
      createdBy: "Alice",
    });
    db.createCodingArtifact({
      sessionId: "s_1",
      kind: "log",
      title: "a log",
      contentText: "stdout",
      createdBy: "Alice",
    });

    const all = (await get("/api/coding/session/s_1/artifacts")) as CodingArtifactRow[];
    expect(all.length).toBe(2);

    const patches = (await get(
      "/api/coding/session/s_1/artifacts?kind=patch",
    )) as CodingArtifactRow[];
    expect(patches.length).toBe(1);
    expect(patches[0]!.kind).toBe("patch");
  });

  it("404s on an unknown session id", async () => {
    const body = (await get("/api/coding/session/nope", 404)) as { error: string };
    expect(body.error).toContain("not found");
  });
});
