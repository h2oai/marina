// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Memory observability surface — REST scoping, graph projection, poller.
 *
 * Fixture (built once per test through the resident memory bindings, never a
 * paid model): Owner writes a legacy note (bridged to a durable twin), files a
 * reflector job for Helper, Helper claims / reads the twin / answers citing it,
 * Owner adopts the proposal into its own space AND (under the ungated local
 * profile) ratifies it into the institutional `guide` space; Owner also
 * resolves two competing claims with `last_writer_wins`. Stranger is a third
 * signed-in resident with no relationship to any of it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine/engine";
import { HYGIENE_NOTE_PREFIX } from "../src/engine/memory-hygiene";
import { resetTrustProfileForTests, setTrustProfile } from "../src/engine/trust-profile";
import { ensureInstitutionalSpace } from "../src/memory/institutional";
import { awaitPendingBridges, findDurableTwin } from "../src/memory/legacy-bridge";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { handleDashboardApi } from "../src/net/dashboard-api";
import {
  buildMemoryGraph,
  buildMemoryOverview,
  getMemoryJob,
  listMemoryJobs,
  markerOf,
  memoryObservabilityPollTicks,
  memoryObserverScope,
  pollMemoryEvents,
} from "../src/net/memory-observability";
import type {
  MemoryGraph,
  MemoryJobView,
  MemoryOverview,
} from "../src/net/memory-observability-types";
import { MarinaDB } from "../src/persistence/database";
import type { MemoryAssistanceJob } from "../src/sdk/memory-assistance";
import type { MemoryOperationRequest } from "../src/sdk/memory-operations";
import type { MemoryRecord } from "../src/sdk/memory-types";
import { type EngineEvent, type EntityId, roomId } from "../src/types";
import { MockConnection, makeTestRoom } from "./helpers";

const OWNER = "Owner";
const HELPER = "Helper";
const STRANGER = "Stranger";
const DESKTOP_TOKEN = "desktop-capability-token-at-least-32-chars";

let directory: string;
let db: MarinaDB;
let engine: Engine;
let tokens: Record<string, string>;
let entityIds: Record<string, EntityId>;
let connCounter = 0;
const prevOpenApi = process.env.MARINA_OPEN_API;
const prevDesktop = process.env.MARINA_DESKTOP_API_TOKEN;
const prevProfile = process.env.MARINA_PROFILE;
const prevAutonomy = process.env.MARINA_AUTONOMY;

const op = (name: string, request: MemoryOperationRequest) =>
  residentMemoryOperation(db, name, request);

function login(name: string): void {
  const conn = new MockConnection(`obs-${connCounter++}`);
  engine.addConnection(conn);
  const result = engine.login(conn.id, name);
  if ("error" in result) throw new Error(`login failed: ${result.error}`);
  tokens[name] = result.token;
  const entity = engine.entities.all().find((e) => e.name === name);
  if (!entity) throw new Error(`entity ${name} missing`);
  entityIds[name] = entity.id;
}

async function api(
  path: string,
  opts: { method?: string; token?: string; desktop?: boolean; body?: unknown } = {},
) {
  const url = new URL(`http://localhost:3300${path}`);
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.desktop) headers["X-Marina-Desktop-Token"] = DESKTOP_TOKEN;
  const method = opts.method ?? "GET";
  const req = new Request(url.toString(), {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const resp = await handleDashboardApi(req, url, method, engine, db);
  if (!resp) throw new Error(`no response for ${path}`);
  const text = await resp.text();
  return { status: resp.status, body: text ? (JSON.parse(text) as unknown) : undefined };
}

interface Fixture {
  noteId: number;
  twinRecordId: string;
  jobId: string;
  proposalRecordId: string;
  adoptedRecordId: string;
  ratifiedRecordId: string;
  guideSpaceId: string;
  ownerSpaceId: string;
  resolutionWinnerId: string;
  resolutionLoserId: string;
}

/** Owner note → twin → reflector job → Helper answers citing the twin. */
async function fileAnsweredJob(task: string): Promise<{
  noteId: number;
  twinRecordId: string;
  jobId: string;
  proposalRecordId: string;
  ownerSpaceId: string;
}> {
  await engine.processCommand(entityIds[OWNER]!, "note The service listens on port 7419");
  await awaitPendingBridges();
  const note = db.getNotesByEntity(OWNER, 20).find((n) => n.content.includes("7419"));
  if (!note) throw new Error("note not written");
  const twin = findDurableTwin(db, note.id);
  if (!twin) throw new Error("twin not bridged");
  const created = await op(OWNER, {
    operation: "assist_create",
    key: `create-${crypto.randomUUID()}`,
    input: { role: "reflector", worker_name: HELPER, task },
  });
  const jobId = (created.result as { id: string }).id;
  const ownerSpaceId = created.space_id!;
  const claim = (await op(HELPER, { operation: "assist_claim", id: jobId, key: `claim-${jobId}` }))
    .result as { lease_token: string };
  const read = (
    await op(HELPER, {
      operation: "assist_read",
      id: jobId,
      key: `read-${jobId}`,
      input: { lease_token: claim.lease_token, request: { operation: "get", id: twin.recordId } },
    })
  ).result as MemoryRecord;
  await op(HELPER, {
    operation: "assist_finish",
    id: jobId,
    key: `finish-${jobId}`,
    input: {
      lease_token: claim.lease_token,
      completion: {
        status: "answered",
        answer: "Deploy on the documented port 7419.",
        citations: [
          {
            kind: "record",
            space_id: ownerSpaceId,
            id: twin.recordId,
            version: read.version,
            quote: "port 7419",
          },
        ],
      },
    },
  });
  const job = (await op(OWNER, { operation: "assist_get", id: jobId }))
    .result as MemoryAssistanceJob;
  return {
    noteId: note.id,
    twinRecordId: twin.recordId,
    jobId,
    proposalRecordId: job.result_record_id!,
    ownerSpaceId,
  };
}

async function buildFixture(): Promise<Fixture> {
  const answered = await fileAnsweredJob("[accumulation] Consolidate the port notes");
  const adopted = (await op(OWNER, { operation: "adopt", id: answered.jobId, key: "adopt-own" }))
    .result as { id: string };
  const guide = ensureInstitutionalSpace(db, "guide");
  // Ratification needs standing ≥ 15, a sovereign, or the ungated local
  // operator; Owner is a fresh rank-0 account, so flip to `local` for this one
  // call only (checked at call time) and restore `shared` right after.
  setTrustProfile("local");
  let ratified: { id: string; ratified_by: unknown };
  try {
    ratified = (
      await op(OWNER, {
        operation: "adopt",
        id: answered.jobId,
        space_id: guide.id,
        key: "adopt-guide",
        input: { rationale: "canonical deployment port" },
      })
    ).result as { id: string; ratified_by: unknown };
  } finally {
    resetTrustProfileForTests();
  }
  expect(ratified.ratified_by).toBeTruthy();
  // Two competing claims, resolved last-writer-wins.
  const claim = (value: string) => ({
    subject: "office",
    predicate: "location",
    object: { kind: "literal" as const, value },
  });
  const a = (
    await op(OWNER, {
      operation: "remember",
      key: "rem-a",
      input: {
        content: "The office is in Berlin",
        claim: claim("berlin"),
        valid_time: { from: 0, until: null },
      },
    })
  ).result as { id: string };
  const b = (
    await op(OWNER, {
      operation: "remember",
      key: "rem-b",
      input: {
        content: "The office is in Paris",
        claim: claim("paris"),
        valid_time: { from: 100, until: null },
      },
    })
  ).result as { id: string };
  await op(OWNER, {
    operation: "resolve",
    id: b.id,
    key: "lww-1",
    input: { policy: "last_writer_wins", competing: [a.id], rationale: "HR confirmed the move" },
  });
  db.createNote(
    OWNER,
    `${HYGIENE_NOTE_PREFIX} stale=1 competing=0 duplicates=0 overlong=0 unsupported=0`,
    undefined,
    { tier: "process" },
  );
  return {
    ...answered,
    adoptedRecordId: adopted.id,
    ratifiedRecordId: ratified.id,
    guideSpaceId: guide.id,
    resolutionWinnerId: b.id,
    resolutionLoserId: a.id,
  };
}

beforeEach(() => {
  delete process.env.MARINA_OPEN_API;
  process.env.MARINA_DESKTOP_API_TOKEN = DESKTOP_TOKEN;
  delete process.env.MARINA_PROFILE;
  delete process.env.MARINA_AUTONOMY;
  // Default in-process profile is `shared`: residents log in at rank 0, so the
  // scoping matrix below exercises real enforcement. (Under `local` every
  // loopback login is bootstrapped sovereign and would see everything.)
  resetTrustProfileForTests();
  directory = mkdtempSync(join(tmpdir(), "marina-observability-"));
  db = new MarinaDB(join(directory, "world.db"));
  engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
  engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  tokens = {};
  entityIds = {};
  for (const name of [OWNER, HELPER, STRANGER]) login(name);
});

afterEach(() => {
  resetTrustProfileForTests();
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore("MARINA_OPEN_API", prevOpenApi);
  restore("MARINA_DESKTOP_API_TOKEN", prevDesktop);
  restore("MARINA_PROFILE", prevProfile);
  restore("MARINA_AUTONOMY", prevAutonomy);
  db.close();
  rmSync(directory, { recursive: true });
});

describe("authorization matrix", () => {
  it("operator sees every job with task/answer; residents see only their own; strangers see nothing", async () => {
    const f = await buildFixture();

    const operator = await api(`/api/memory/jobs/${f.jobId}`, { desktop: true });
    expect(operator.status).toBe(200);
    const opJob = operator.body as MemoryJobView;
    expect(opJob).toMatchObject({
      id: f.jobId,
      state: "answered",
      role: "reflector",
      workerName: HELPER,
      requesterName: OWNER,
      spaceId: f.ownerSpaceId,
      marker: "accumulation",
      citations: 1,
    });
    expect(opJob.task).toContain("[accumulation]");
    expect(opJob.answer).toBe("Deploy on the documented port 7419.");
    expect(opJob.adopted).toMatchObject({ recordId: f.adoptedRecordId, spaceId: f.ownerSpaceId });

    const ownerView = await api(`/api/memory/jobs/${f.jobId}`, { token: tokens[OWNER] });
    expect(ownerView.status).toBe(200);
    expect((ownerView.body as MemoryJobView).task).toContain("[accumulation]");
    const helperView = await api(`/api/memory/jobs/${f.jobId}`, { token: tokens[HELPER] });
    expect(helperView.status).toBe(200);
    expect((helperView.body as MemoryJobView).answer).toContain("7419");

    // Stranger: the job does not exist for it — neither by id nor in the list.
    const stranger = await api(`/api/memory/jobs/${f.jobId}`, { token: tokens[STRANGER] });
    expect(stranger.status).toBe(404);
    const strangerList = await api("/api/memory/jobs?state=all", { token: tokens[STRANGER] });
    expect(strangerList.status).toBe(200);
    expect((strangerList.body as { jobs: unknown[] }).jobs).toEqual([]);

    // The list never carries content, even for the operator.
    const list = await api("/api/memory/jobs?state=all&role=reflector", { desktop: true });
    const listed = (list.body as { jobs: MemoryJobView[]; nextCursor: string | null }).jobs;
    expect(listed.map((j) => j.id)).toContain(f.jobId);
    for (const job of listed) {
      expect(job.task).toBeUndefined();
      expect(job.answer).toBeUndefined();
    }
    const byEntity = await api(`/api/memory/jobs?state=all&entity=${HELPER}`, { desktop: true });
    expect((byEntity.body as { jobs: MemoryJobView[] }).jobs.map((j) => j.id)).toEqual([f.jobId]);
    const byOther = await api(`/api/memory/jobs?state=all&entity=${STRANGER}`, { desktop: true });
    expect((byOther.body as { jobs: MemoryJobView[] }).jobs).toEqual([]);
  });

  it("requires a session (401) unless MARINA_OPEN_API opens reads", async () => {
    const f = await buildFixture();
    for (const path of [
      "/api/memory/overview",
      "/api/memory/jobs",
      `/api/memory/jobs/${f.jobId}`,
      "/api/memory/graph",
    ]) {
      expect((await api(path)).status).toBe(401);
    }
    process.env.MARINA_OPEN_API = "true";
    const open = await api(`/api/memory/jobs/${f.jobId}`);
    expect(open.status).toBe(200);
    expect((open.body as MemoryJobView).task).toContain("[accumulation]");
  });

  it("overview scopes hygiene, credits and resolutions to the principal; ratifications are public", async () => {
    const f = await buildFixture();
    const operator = (await api("/api/memory/overview", { desktop: true })).body as MemoryOverview;
    expect(operator.trust).toMatchObject({ profile: "shared", ungated: false });
    expect(operator.hygiene).toEqual([
      expect.objectContaining({ entityName: OWNER, line: expect.stringContaining("stale=1") }),
    ]);
    expect(operator.jobs).toMatchObject({
      open: 0,
      answered24h: 1,
      abstained24h: 0,
      cancelled24h: 0,
    });
    expect(operator.dispatch).toMatchObject({
      accumulationJobs24h: 1,
      sharedWriteJobs24h: 0,
      hygieneJobs24h: 0,
    });
    expect(operator.resolutions).toHaveLength(1);
    expect(operator.resolutions[0]).toMatchObject({
      policy: "last_writer_wins",
      spaceId: f.ownerSpaceId,
      actorName: OWNER,
      winnerId: f.resolutionWinnerId,
      loserIds: [f.resolutionLoserId],
      rationale: "HR confirmed the move",
    });
    expect(operator.ratifications).toHaveLength(1);
    expect(operator.ratifications[0]).toMatchObject({
      recordId: f.ratifiedRecordId,
      spaceId: f.guideSpaceId,
      spaceName: "guide",
      ratifiedBy: { name: OWNER, basis: "local-ungated" },
      preview: "Deploy on the documented port 7419.",
    });
    expect(operator.credits.map((c) => [c.kind, c.entityName])).toContainEqual([
      "assistance_adopted",
      HELPER,
    ]);
    expect(operator.spaces.institutional).toEqual([
      expect.objectContaining({ id: f.guideSpaceId, name: "guide", ratified: 1 }),
    ]);
    expect(operator.receipts.cache).toEqual({
      hits: expect.any(Number),
      misses: expect.any(Number),
      stores: expect.any(Number),
    });

    const owner = (await api("/api/memory/overview", { token: tokens[OWNER] }))
      .body as MemoryOverview;
    expect(owner.hygiene).toHaveLength(1);
    expect(owner.resolutions).toHaveLength(1);
    expect(owner.jobs.answered24h).toBe(1);
    // Helper earned the credit — the owner's own ledger is empty for these kinds.
    expect(owner.credits).toEqual([]);

    const helper = (await api("/api/memory/overview", { token: tokens[HELPER] }))
      .body as MemoryOverview;
    expect(helper.credits.map((c) => c.kind)).toEqual(["assistance_adopted"]);
    expect(helper.resolutions).toEqual([]);

    const stranger = (await api("/api/memory/overview", { token: tokens[STRANGER] }))
      .body as MemoryOverview;
    expect(stranger.hygiene).toEqual([]);
    expect(stranger.credits).toEqual([]);
    expect(stranger.resolutions).toEqual([]);
    expect(stranger.jobs).toMatchObject({ open: 0, answered24h: 0 });
    expect(stranger.dispatch.accumulationJobs24h).toBe(0);
    // Institutional memory is public-read: the ratified preview stays visible.
    expect(stranger.ratifications).toHaveLength(1);
    expect(stranger.ratifications[0]!.preview).toBe("Deploy on the documented port 7419.");
    expect(stranger.spaces.institutional).toHaveLength(1);
  });
});

describe("memory graph", () => {
  const edges = (graph: MemoryGraph, relationship: string) =>
    graph.edges.filter((e) => e.relationship === relationship).map((e) => [e.source, e.target]);

  it("projects note → twin → job → proposal → adopted record, a resolution and a ratified guide record", async () => {
    const f = await buildFixture();
    const graph = (await api("/api/memory/graph", { desktop: true })).body as MemoryGraph;
    expect(graph.truncated).toBe(false);
    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const id of [
      `note:${f.noteId}`,
      `record:${f.twinRecordId}`,
      `job:${f.jobId}`,
      `proposal:${f.proposalRecordId}`,
      `record:${f.adoptedRecordId}`,
      `record:${f.ratifiedRecordId}`,
      `space:${f.guideSpaceId}`,
      `helper:${HELPER}`,
      `helper:${OWNER}`,
      `record:${f.resolutionWinnerId}`,
      `record:${f.resolutionLoserId}`,
    ]) {
      expect(ids.has(id)).toBe(true);
    }
    expect(edges(graph, "twin")).toContainEqual([`note:${f.noteId}`, `record:${f.twinRecordId}`]);
    expect(edges(graph, "worker")).toContainEqual([`job:${f.jobId}`, `helper:${HELPER}`]);
    expect(edges(graph, "requester")).toContainEqual([`job:${f.jobId}`, `helper:${OWNER}`]);
    expect(edges(graph, "derived_from")).toContainEqual([
      `proposal:${f.proposalRecordId}`,
      `job:${f.jobId}`,
    ]);
    expect(edges(graph, "cites")).toContainEqual([
      `proposal:${f.proposalRecordId}`,
      `record:${f.twinRecordId}`,
    ]);
    // Two adoptions of one proposal: the owner's copy and the guide ratification.
    expect(edges(graph, "adopted_as")).toContainEqual([
      `proposal:${f.proposalRecordId}`,
      `record:${f.adoptedRecordId}`,
    ]);
    expect(edges(graph, "in_space")).toContainEqual([
      `record:${f.ratifiedRecordId}`,
      `space:${f.guideSpaceId}`,
    ]);
    const resolution = graph.nodes.find((n) => n.kind === "resolution");
    expect(resolution).toMatchObject({
      policy: "last_writer_wins",
      state: "applied",
      entityName: OWNER,
    });
    expect(edges(graph, "resolves")).toContainEqual([
      resolution!.id,
      `record:${f.resolutionWinnerId}`,
    ]);
    expect(edges(graph, "superseded_by")).toContainEqual([
      `record:${f.resolutionLoserId}`,
      `record:${f.resolutionWinnerId}`,
    ]);
    // Content: notes carry their readable preview; private records carry NONE;
    // the institutional record carries its public preview.
    const note = graph.nodes.find((n) => n.id === `note:${f.noteId}`)!;
    expect(note.label).toContain("7419");
    const twin = graph.nodes.find((n) => n.id === `record:${f.twinRecordId}`)!;
    expect(twin.label).not.toContain("7419");
    expect(twin.meta?.preview).toBeUndefined();
    expect(twin.spaceId).toBe(f.ownerSpaceId);
    const ratified = graph.nodes.find((n) => n.id === `record:${f.ratifiedRecordId}`)!;
    expect(ratified.institutional).toBe(true);
    expect(ratified.meta?.preview).toBe("Deploy on the documented port 7419.");
    const space = graph.nodes.find((n) => n.id === `space:${f.guideSpaceId}`)!;
    expect(space).toMatchObject({ kind: "space", label: "guide", institutional: true });
    const job = graph.nodes.find((n) => n.id === `job:${f.jobId}`)!;
    expect(job).toMatchObject({ state: "answered", role: "reflector" });
    expect(job.meta?.marker).toBe("accumulation");
  });

  it("scopes the map per principal and honours the entity filter", async () => {
    const f = await buildFixture();
    const stranger = (await api("/api/memory/graph", { token: tokens[STRANGER] }))
      .body as MemoryGraph;
    const strangerIds = new Set(stranger.nodes.map((n) => n.id));
    expect(strangerIds.has(`note:${f.noteId}`)).toBe(false);
    expect(strangerIds.has(`job:${f.jobId}`)).toBe(false);
    expect(stranger.nodes.some((n) => n.kind === "resolution")).toBe(false);
    expect(strangerIds.has(`record:${f.twinRecordId}`)).toBe(false);
    // Public institutional memory stays on every map.
    expect(strangerIds.has(`space:${f.guideSpaceId}`)).toBe(true);
    expect(strangerIds.has(`record:${f.ratifiedRecordId}`)).toBe(true);

    const owner = (await api("/api/memory/graph", { token: tokens[OWNER] })).body as MemoryGraph;
    const ownerIds = new Set(owner.nodes.map((n) => n.id));
    expect(ownerIds.has(`note:${f.noteId}`)).toBe(true);
    expect(ownerIds.has(`job:${f.jobId}`)).toBe(true);
    expect(owner.nodes.some((n) => n.kind === "resolution")).toBe(true);

    // Helper worked the job: sees it (and the cited twin) but not Owner's private notes.
    const helper = (await api("/api/memory/graph", { token: tokens[HELPER] })).body as MemoryGraph;
    const helperIds = new Set(helper.nodes.map((n) => n.id));
    expect(helperIds.has(`job:${f.jobId}`)).toBe(true);
    expect(helperIds.has(`record:${f.twinRecordId}`)).toBe(true);
    expect(helperIds.has(`note:${f.noteId}`)).toBe(false);
    expect(helper.nodes.some((n) => n.kind === "resolution")).toBe(false);

    const filtered = (await api(`/api/memory/graph?entity=${STRANGER}`, { desktop: true }))
      .body as MemoryGraph;
    expect(filtered.nodes.some((n) => n.kind === "job")).toBe(false);
    expect(filtered.nodes.some((n) => n.kind === "note" && n.entityName === OWNER)).toBe(false);

    const truncated = buildMemoryGraph(engine, memoryObserverScope(engine, entityIds[OWNER]), {
      limit: 1,
    });
    expect(truncated.truncated).toBe(true);
  });
});

describe("event poller", () => {
  it("emits memory_job on create/claim/finish and memory_service_event on adopt/resolve — ids only", async () => {
    const events: EngineEvent[] = [];
    engine.addEventListener((event) => {
      if (event.type === "memory_job" || event.type === "memory_service_event") events.push(event);
    });
    // First call primes the cursor at the head — nothing is replayed.
    expect(pollMemoryEvents(engine)).toBe(0);
    expect(memoryObservabilityPollTicks(1000)).toBe(2);
    expect(memoryObservabilityPollTicks(60_000)).toBe(1);

    await engine.processCommand(entityIds[OWNER]!, "note The service listens on port 7419");
    await awaitPendingBridges();
    const note = db.getNotesByEntity(OWNER, 20).find((n) => n.content.includes("7419"))!;
    const twin = findDurableTwin(db, note.id)!;
    const created = await op(OWNER, {
      operation: "assist_create",
      key: "create-1",
      input: { role: "reflector", worker_name: HELPER, task: "[hygiene] Review stale claims" },
    });
    const jobId = (created.result as { id: string }).id;
    expect(pollMemoryEvents(engine)).toBeGreaterThanOrEqual(1);
    const pending = events.filter((e) => e.type === "memory_job").at(-1);
    expect(pending).toMatchObject({
      type: "memory_job",
      job: {
        id: jobId,
        state: "pending",
        role: "reflector",
        workerName: HELPER,
        requesterName: OWNER,
        marker: "hygiene",
        workOpen: true,
      },
    });
    // The broadcast never carries content.
    expect("task" in (pending as { job: object }).job).toBe(false);
    expect("answer" in (pending as { job: object }).job).toBe(false);
    // Legacy note bridging (`memory.created`) is not broadcast — too noisy.
    expect(
      events.some((e) => e.type === "memory_service_event" && e.kind === "memory.created"),
    ).toBe(false);

    const claim = (await op(HELPER, { operation: "assist_claim", id: jobId, key: "claim-1" }))
      .result as { lease_token: string };
    pollMemoryEvents(engine);
    expect(events.filter((e) => e.type === "memory_job").at(-1)).toMatchObject({
      job: { id: jobId, state: "running" },
    });

    const read = (
      await op(HELPER, {
        operation: "assist_read",
        id: jobId,
        key: "read-1",
        input: { lease_token: claim.lease_token, request: { operation: "get", id: twin.recordId } },
      })
    ).result as MemoryRecord;
    await op(HELPER, {
      operation: "assist_finish",
      id: jobId,
      key: "finish-1",
      input: {
        lease_token: claim.lease_token,
        completion: {
          status: "answered",
          answer: "Keep the documented port.",
          citations: [
            {
              kind: "record",
              space_id: created.space_id,
              id: twin.recordId,
              version: read.version,
              quote: "port 7419",
            },
          ],
        },
      },
    });
    pollMemoryEvents(engine);
    expect(events.filter((e) => e.type === "memory_job").at(-1)).toMatchObject({
      job: { id: jobId, state: "answered", workOpen: false },
    });

    await op(OWNER, { operation: "adopt", id: jobId, key: "adopt-1" });
    pollMemoryEvents(engine);
    const adopted = events.find(
      (e) => e.type === "memory_service_event" && e.kind === "assistance.adopted",
    );
    expect(adopted).toMatchObject({
      kind: "assistance.adopted",
      spaceId: created.space_id,
      spaceName: "resident",
      ownerName: OWNER,
      referenceId: jobId,
      actorName: OWNER,
    });
    expect((adopted as { seq: number }).seq).toBeGreaterThan(0);
    expect(events.filter((e) => e.type === "memory_job").at(-1)).toMatchObject({
      job: { id: jobId, adopted: { spaceId: created.space_id } },
    });

    const a = (
      await op(OWNER, {
        operation: "remember",
        key: "rem-a",
        input: {
          content: "The office is in Berlin",
          claim: {
            subject: "office",
            predicate: "location",
            object: { kind: "literal", value: "b" },
          },
          valid_time: { from: 0, until: null },
        },
      })
    ).result as { id: string };
    const b = (
      await op(OWNER, {
        operation: "remember",
        key: "rem-b",
        input: {
          content: "The office is in Paris",
          claim: {
            subject: "office",
            predicate: "location",
            object: { kind: "literal", value: "p" },
          },
          valid_time: { from: 100, until: null },
        },
      })
    ).result as { id: string };
    await op(OWNER, {
      operation: "resolve",
      id: b.id,
      key: "lww-1",
      input: { policy: "last_writer_wins", competing: [a.id], rationale: "confirmed" },
    });
    pollMemoryEvents(engine);
    const resolved = events.find(
      (e) => e.type === "memory_service_event" && e.kind === "memory.resolved",
    );
    expect(resolved).toMatchObject({ kind: "memory.resolved", actorName: OWNER });
    // Cursor advanced: a second poll is a no-op.
    expect(pollMemoryEvents(engine)).toBe(0);
  });

  it("bounds each poll and resumes from the cursor", async () => {
    // Materialise the resident space first so its lazy `space.created` event
    // lands before the cursor is primed.
    await op(OWNER, { operation: "space" });
    pollMemoryEvents(engine);
    for (let i = 0; i < 3; i++) {
      await op(OWNER, {
        operation: "assist_create",
        key: `c-${i}`,
        input: { role: "librarian", worker_name: HELPER, task: `Find item ${i}` },
      });
    }
    // assist_create writes source.captured + assistance.created per job.
    expect(pollMemoryEvents(engine, { maxRows: 2 })).toBe(1);
    expect(pollMemoryEvents(engine, { maxRows: 2 })).toBe(1);
    expect(pollMemoryEvents(engine, { maxRows: 2 })).toBe(1);
    expect(pollMemoryEvents(engine, { maxRows: 2 })).toBe(0);
  });
});

describe("job cancel", () => {
  it("lets the requester or an operator cancel; strangers get 404, the worker 403, dev-open 403", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(
        (
          (
            await op(OWNER, {
              operation: "assist_create",
              key: `cancel-${i}`,
              input: { role: "librarian", worker_name: HELPER, task: `Find item ${i}` },
            })
          ).result as { id: string }
        ).id,
      );
    }
    const cancel = (id: string, opts: Parameters<typeof api>[1]) =>
      api(`/api/memory/jobs/${id}/cancel`, { ...opts, method: "POST" });

    expect((await cancel(ids[0]!, { token: tokens[STRANGER] })).status).toBe(404);
    expect((await cancel(ids[0]!, { token: tokens[HELPER] })).status).toBe(403);
    expect((await cancel(ids[0]!, {})).status).toBe(401);
    process.env.MARINA_OPEN_API = "true";
    expect((await cancel(ids[0]!, {})).status).toBe(403);
    delete process.env.MARINA_OPEN_API;

    const owner = await cancel(ids[0]!, { token: tokens[OWNER] });
    expect(owner.status).toBe(200);
    expect(owner.body).toMatchObject({ id: ids[0], state: "cancelled", workOpen: false });

    const operator = await cancel(ids[1]!, { desktop: true });
    expect(operator.status).toBe(200);
    expect(operator.body).toMatchObject({ id: ids[1], state: "cancelled" });

    // Cancelling again is idempotent (same final state), and the third stays open.
    expect((await cancel(ids[0]!, { token: tokens[OWNER] })).body).toMatchObject({
      state: "cancelled",
    });
    const open = listMemoryJobs(db, memoryObserverScope(engine, entityIds[OWNER]), {
      state: "open",
    });
    expect(open.jobs.map((j) => j.id)).toEqual([ids[2]!]);
    expect(open.nextCursor).toBeNull();
    const helperView = getMemoryJob(db, memoryObserverScope(engine, entityIds[HELPER]), ids[2]!);
    expect(helperView?.task).toBe("Find item 2");
    expect(markerOf(helperView?.task)).toBeNull();
  });

  it("pages with a stable cursor", async () => {
    for (let i = 0; i < 5; i++) {
      await op(OWNER, {
        operation: "assist_create",
        key: `page-${i}`,
        input: { role: "librarian", worker_name: HELPER, task: `Find item ${i}` },
      });
    }
    const scope = memoryObserverScope(engine, entityIds[OWNER]);
    const first = listMemoryJobs(db, scope, { state: "all", limit: 2 });
    expect(first.jobs).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = listMemoryJobs(db, scope, { state: "all", limit: 2, cursor: first.nextCursor });
    expect(second.jobs).toHaveLength(2);
    const third = listMemoryJobs(db, scope, { state: "all", limit: 2, cursor: second.nextCursor });
    expect(third.jobs).toHaveLength(1);
    expect(third.nextCursor).toBeNull();
    const all = [...first.jobs, ...second.jobs, ...third.jobs].map((j) => j.id);
    expect(new Set(all).size).toBe(5);
    expect((await api("/api/memory/jobs?cursor=%%%", { desktop: true })).status).toBe(400);
  });
});

describe("overview without content leaks", () => {
  it("serialises no task text, credentials or raw input anywhere in the overview", async () => {
    await buildFixture();
    const overview = buildMemoryOverview(engine, memoryObserverScope(engine, entityIds[STRANGER]));
    const serialized = JSON.stringify(overview);
    expect(serialized).not.toContain("[accumulation]");
    expect(serialized).not.toContain("lease_token");
    expect(serialized).not.toContain("credential");
    expect(serialized).not.toContain(tokens[OWNER]!);
  });
});
