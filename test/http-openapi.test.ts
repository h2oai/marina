// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// marina.http.v1 is the contract SDKs in other languages are written against, so
// it is checked against a real server: the SDK's own clients drive memory,
// routing, investigations and panels over HTTP, and every request they send and
// every reply they get must match the published OpenAPI document. An operation
// the flows never reach must be named in NOT_EXERCISED with the reason.

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Schema from "typebox/schema";
import { OPENAPI_FILE, openApiDocument, renderOpenApi } from "../scripts/generate-openapi";
import { grant } from "../src/engine/safety-gates";
import * as investigationModule from "../src/investigations/service";
import { InvestigationService } from "../src/investigations/service";
import { MemoryService } from "../src/memory/service";
import { DashboardBroadcaster } from "../src/net/dashboard-ws";
import { handleMemoryServiceApi } from "../src/net/memory/memory-service-api";
import { WebSocketServer } from "../src/net/websocket-server";
import { MarinaDB } from "../src/persistence/database";
import {
  HTTP_API_SCHEMA_PATH,
  HTTP_OPERATIONS,
  type HttpOperation,
} from "../src/protocol/http-api";
import { MarinaClient } from "../src/sdk/client";
import { MarinaInvestigationClient } from "../src/sdk/investigation-client";
import { MarinaMemoryAssistance } from "../src/sdk/memory-assistance-client";
import { MarinaMemoryClient } from "../src/sdk/memory-client";
import { MarinaPanelClient } from "../src/sdk/panel-client";
import { MarinaRoutingClient } from "../src/sdk/routing-client";
import { createTestEngine } from "./engine-fixture";
import { binaryInvestigation } from "./fixtures/investigations";
import { scopeProcessState } from "./process-state";

const document = openApiDocument() as {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: Record<string, Record<string, unknown>>;
};
interface OpenApiOperation {
  operationId: string;
  requestBody?: { content: { "application/json": { schema: unknown } } };
  responses: Record<string, { content?: { "application/json": { schema: unknown } } }>;
}

/** Operations the flows below do not reach, each with why. */
const NOT_EXERCISED: Record<string, string> = {
  federatedRetrieve: "needs a mounted peer server",
  federatedSearch: "needs a mounted peer server",
  federatedRead: "needs a mounted peer server",
  reindex: "needs an embedding provider (its refusal is checked)",
  job: "index jobs exist only with an embedding provider",
};

const matchers = HTTP_OPERATIONS.map((op) => ({
  op,
  pattern: new RegExp(`^${op.path.replace(/\{\w+\}/g, "[^/]+")}$`),
}));

function operationFor(method: string, path: string): HttpOperation | undefined {
  return matchers.find((m) => m.op.method === method && m.pattern.test(path))?.op;
}

function validate(schema: unknown, value: unknown, label: string) {
  const root = { components: document.components, ...(schema as object) };
  if (Schema.Check(root as never, value)) return;
  const [, found] = Schema.Errors(root as never, value);
  const errors = found.slice(0, 4).map((e) => `${e.instancePath || "/"} ${e.message}`);
  throw new Error(
    `${label} does not match the OpenAPI document:\n${errors.join("\n")}\n${JSON.stringify(value).slice(0, 600)}`,
  );
}

const exercised = new Set<string>();
const problems: string[] = [];

/** A fetch that checks each request and reply against the document. */
function checkedFetch(base: typeof fetch = fetch): typeof fetch {
  return Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const op = operationFor(request.method, url.pathname);
      if (!op) {
        problems.push(`${request.method} ${url.pathname} is not in the OpenAPI document`);
        return base(request);
      }
      const spec = document.paths[op.path]![op.method.toLowerCase()]!;
      try {
        const bodyText = request.method === "GET" ? "" : await request.clone().text();
        if (spec.requestBody)
          validate(
            spec.requestBody.content["application/json"].schema,
            JSON.parse(bodyText || "null"),
            `${op.id} request`,
          );
        const response = await base(request);
        const status = String(response.status);
        const declared = spec.responses[status] ?? spec.responses.default!;
        if (response.ok && !spec.responses[status])
          problems.push(`${op.id} answered ${status}, which it does not declare`);
        const schema = declared.content?.["application/json"]?.schema;
        if (schema) validate(schema, await response.clone().json(), `${op.id} ${status} reply`);
        if (response.ok) exercised.add(op.id);
        return response;
      } catch (error) {
        problems.push((error as Error).message);
        throw error;
      }
    },
    { preconnect() {} },
  ) as typeof fetch;
}

describe("the published OpenAPI document", () => {
  it("is generated from the source of truth", () => {
    expect(readFileSync(OPENAPI_FILE, "utf8")).toBe(renderOpenApi());
  });

  it("refers only to components it has, and names every operation once", () => {
    const text = JSON.stringify(document);
    for (const [, kind, name] of text.matchAll(/"#\/components\/(\w+)\/(\w+)"/g))
      expect(document.components[kind!]?.[name!], `${kind}/${name}`).toBeDefined();
    const ids = HTTP_OPERATIONS.map((op) => op.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("a live server matches marina.http.v1", () => {
  let state: Disposable;
  let fixture: ReturnType<typeof createTestEngine>;
  let server: WebSocketServer;
  let base: string;
  let resident: MarinaClient;
  let investigations: InvestigationService;
  let restoreInvestigations: () => void;
  let scratch: string;
  const people: MarinaClient[] = [];

  beforeAll(async () => {
    state = scopeProcessState({
      trustProfile: "shared",
      rateLimitBypass: true,
      env: { WS_HOST: "127.0.0.1", MARINA_OPEN_API: undefined, MARINA_SUPERVISED_RESIDENTS: "on" },
    });
    scratch = mkdtempSync(join(tmpdir(), "marina-openapi-"));
    fixture = createTestEngine();
    investigations = new InvestigationService(fixture.db, async ({ observation }) => {
      const outputId = observation.capture("fixture", { private: "release details" });
      return {
        result: { ...structuredClone(binaryInvestigation), outputId },
        forecast: {
          question: "Will we ship?",
          kind: "probability",
          probability: 0.65,
          answerJson: "{}",
        },
      };
    });
    const spy = spyOn(investigationModule, "investigationService").mockReturnValue(investigations);
    restoreInvestigations = () => spy.mockRestore();
    server = new WebSocketServer(fixture.engine, 0);
    server.setDb(fixture.db);
    const broadcaster = new DashboardBroadcaster();
    server.setBroadcaster(broadcaster);
    server.start();
    base = `http://127.0.0.1:${server.getPort()}`;
    resident = new MarinaClient(`ws://127.0.0.1:${server.getPort()}`, {
      autoReconnect: false,
      pingInterval: 0,
    });
    await resident.connect("SpecOwner");
  });

  afterAll(async () => {
    resident.disconnect();
    for (const client of people) client.disconnect();
    for (const world of worlds) {
      await world.service.close();
      world.db.close();
    }
    restoreInvestigations();
    investigations.close();
    server.stop();
    await fixture.dispose();
    state[Symbol.dispose]();
    rmSync(scratch, { recursive: true, force: true });
  });

  const worlds: { db: MarinaDB; service: MemoryService }[] = [];
  /** A memory client on a separate world database, still checked against the document. */
  async function anotherWorld(name: string) {
    const db = new MarinaDB(join(scratch, `${name}.db`));
    const service = new MemoryService(db);
    worlds.push({ db, service });
    const credential = db.issueMemoryCredential(
      db.ensurePrincipal({ type: "service", displayName: name }).principal_id,
    );
    const local = checkedFetch(((r: Request) => handleMemoryServiceApi(r, service)) as never);
    return new MarinaMemoryClient(base, credential.token, 35_000, (r) => local(r));
  }

  function memoryClient(name: string) {
    const principal = fixture.db.ensurePrincipal({ type: "service", displayName: name });
    const credential = fixture.db.issueMemoryCredential(principal.principal_id);
    const fetcher = checkedFetch();
    return {
      client: new MarinaMemoryClient(base, credential.token, 35_000, (r) => fetcher(r)),
      principalId: principal.principal_id,
    };
  }

  it("memory", async () => {
    const { client: owner } = memoryClient("SpecMemoryOwner");
    const { client: worker, principalId: workerId } = memoryClient("SpecMemoryHelper");
    await owner.capabilities();
    await owner.me();
    await owner.usage();
    const space = (await owner.createSpace("spec")).id;
    await owner.spaces();
    await owner.space(space);

    const first = await owner.remember(space, {
      content: "The deploy runs from main",
      subject: "deploy",
      valid_time: { from: 0, until: null },
      claim: { subject: "deploy", predicate: "branch", object: { kind: "literal", value: "main" } },
    });
    await owner.get(space, first.id);
    await owner.get(space, first.id, first.version);
    const revised = await owner.revise(space, first.id, first.version!, {
      content: "The deploy runs from main, after CI",
      subject: "deploy",
      claim: { subject: "deploy", predicate: "branch", object: { kind: "literal", value: "main" } },
    });
    await owner.search(space, { query: "deploy" });
    await owner.context(space, { query: "deploy", budget_tokens: 200 });
    await owner.query(space, { subject: "deploy" });
    await owner.graph(space, { subject: "deploy" });
    const variable = (name: string, type: "entity" | "string" = "entity") => ({
      variable: name,
      type,
    });
    await owner.join(space, {
      patterns: [{ subject: variable("x"), predicate: "branch", object: variable("b", "string") }],
    });
    const rule = await owner.saveRule(space, {
      schema: "marina.memory.rule.v1",
      name: "branch-is-tracked",
      query: {
        patterns: [
          { subject: variable("x"), predicate: "branch", object: variable("b", "string") },
        ],
      },
      conclusion: {
        subject: variable("x"),
        predicate: "tracked",
        object: { kind: "literal", value: true },
      },
    });
    await owner.runRule(space, rule.id, rule.version!);
    await owner.materializeRule(space, rule.id, rule.version!);
    await owner.knowledgeGraph(space, "read_graph");
    await owner.review(space, {});
    const rival = await owner.remember(space, {
      content: "The deploy runs from release",
      subject: "deploy",
      valid_time: { from: 100, until: null },
      claim: {
        subject: "deploy",
        predicate: "branch",
        object: { kind: "literal", value: "release" },
      },
    });
    await owner.resolve(space, revised.id, {
      policy: "last_writer_wins",
      competing: [rival.id],
      rationale: "main is the branch",
    });
    const vocabulary = await owner.vocabulary(space);
    await owner.saveVocabulary(space, vocabulary.version, {
      closed: false,
      predicates: { branch: { object: "string", cardinality: "one" } },
    });
    const source = await owner.capture(space, { text: "deploy log: main at 12:00" }, "s1");
    await owner.captureBatch(space, [{ content: { text: "second log" }, key: "batch-1" }]);
    await owner.sources(space);
    await owner.sourceHeaders(space);
    await owner.sourceRange(space, source.id, { start: 0, end: 6 });
    await owner.sourceSearch(space, { query: "deploy" });
    await owner.saveCheckpoint(space, "progress", 0, { step: 1 });
    const saved = await owner.checkpoint(space, "progress");
    await owner.captureCheckpoint(space, "progress", {
      expected_version: saved.version,
      items: [{ content: { text: "step two" }, key: "cp-1" }],
      order: [0],
      manifest: { key: "cp-manifest", content: { step: 2 } },
      field: "last",
      entry: { step: 2 },
      data: {},
      checkpoint_key: "cp-write",
    });
    const plan = await owner.plan(space, { task: "Which branch deploys?" });
    await owner.executePlan(space, plan);
    await owner.retrieve(space, { task: "Which branch deploys?" });
    await owner.retrieveCached(space, {
      retrieval: { task: "Which branch deploys?", valid_at: Date.now() },
    });
    await owner.federationMounts(space);
    await owner.cachePut(space, {
      inputs: { q: 1 },
      model: "m",
      policy: "p",
      value: { answer: "main" },
      sources: [
        { id: source.id, content_hash: (await owner.sourceRange(space, source.id)).content_hash },
      ],
      expires_at: Date.now() + 60_000,
    });
    await owner.cacheGet(space, { inputs: { q: 1 }, model: "m", policy: "p" });
    await owner.cacheDelete(space, { inputs: { q: 1 }, model: "m", policy: "p" });
    await owner.acknowledge(space, ["nothing"]);
    await owner.request(`/spaces/${space}/json_store`, "POST", {
      operations: [
        { namespace: ["spec"], key: "handoff", value: { step: 1 } },
        { namespace: ["spec"], key: "handoff" },
        { namespacePrefix: ["spec"] },
      ],
    });
    await owner.workflows(space).help?.();
    // Bundles and transfers keep portable identities: each moves to a world of its own.
    const bundled = await anotherWorld("bundle");
    await bundled.importBundle(
      (await bundled.createSpace("copy")).id,
      await owner.exportBundle(space),
    );
    const transferred = await anotherWorld("transfer");
    const target = (await transferred.createSpace("transfer")).id;
    let page = await owner.exportTransferPage(space);
    let status = await transferred.beginTransfer(target, page.header);
    await transferred.transfers(target);
    await transferred.transferStatus(target, status.id);
    for (;;) {
      status = await transferred.appendTransfer(target, status.id, page);
      if (page.done) break;
      page = await owner.exportTransferPage(space, page.next_cursor!);
    }
    await transferred.commitTransfer(target, status.id, status.sha256);
    const abandoned = (await bundled.createSpace("abandoned")).id;
    const begun = await bundled.beginTransfer(
      abandoned,
      (await owner.exportTransferPage(space)).header,
    );
    await bundled.abortTransfer(abandoned, begun.id);
    await owner.export(space);
    await owner.grant(space, workerId, "reader");
    // No embedding provider in tests: the refusal is still a documented MemoryError.
    await expect(owner.reindex(space, (await owner.space(space)).generation)).rejects.toMatchObject(
      {
        code: "embedding_unavailable",
      },
    );
    await owner.reaffirm(space, revised.id, revised.version! + 1, {});

    const requester = MarinaMemoryAssistance.http(owner);
    const helper = MarinaMemoryAssistance.http(worker);
    const job = await requester.create(space, {
      worker_id: workerId,
      role: "librarian",
      task: "Which branch deploys?",
    });
    await requester.jobs({ open: true });
    await requester.get(job.id);
    const lease = await helper.claim(job.id);
    await helper.heartbeat(job.id, lease.lease_token);
    await helper.read(job.id, lease.lease_token, {
      operation: "search",
      input: { query: "deploy" },
    });
    const { principalId: subId } = memoryClient("SpecMemorySub");
    await owner.grant(space, subId, "reader");
    await helper.delegate(job.id, lease.lease_token, {
      worker_id: subId,
      role: "librarian",
      task: "Check the log",
    });
    await helper.finish(job.id, lease.lease_token, {
      status: "abstained",
      reason: "not enough evidence",
    });
    await owner.adopt(undefined, job.id, { confirm_abstention: true });
    const second = await requester.create(space, {
      worker_id: workerId,
      role: "librarian",
      task: "Anything else?",
    });
    await requester.cancel(second.id);
    await owner.adopt(space, job.id, { confirm_abstention: true });
    await owner.forget(space, { record_ids: [rival.id] });
  });

  async function person(name: string) {
    const client = new MarinaClient(`ws://127.0.0.1:${server.getPort()}`, {
      autoReconnect: false,
      pingInterval: 0,
      principal: "person",
    });
    await client.connect(name);
    people.push(client);
    return { client, token: client.getSession()!.token };
  }

  it("routing", async () => {
    const { client: router, token } = await person("SpecRouter");
    await router.command("channel create specroom");
    // Runtime controls are gated like running code, resident enrolment like spawning.
    grant(fixture.db, router.getSession()!.entityId, "code.exec");
    grant(fixture.db, router.getSession()!.entityId, "agent.spawn");
    const routing = new MarinaRoutingClient({ url: base, token, fetch: checkedFetch() });
    const a = await routing.join({ clientKey: "spec-a", label: "A", kind: "service" });
    const b = await routing.join({ clientKey: "spec-b", label: "B", kind: "service" });
    await routing.discover();
    await routing.overview("", true);
    await routing.session(a.id);
    await routing.heartbeat(a.id);
    await routing.publish(a.id, [{ id: "e1", kind: "output", payload: { text: "hello" } }]);
    await routing.events(a.id);
    const sent = await routing.send(a.id, {
      clientMessageId: "m1",
      targetId: b.id,
      kind: "note",
      payload: "hi",
    });
    await routing.inbox(b.id);
    await routing.deliveries(a.id);
    await routing.receipt(a.id, sent.id);
    await routing.acknowledge(b.id, sent.id);
    const channels = await routing.channels(a.id);
    const channel = channels.channels.find((c) => c.name === "specroom")!.id;
    await routing.sendChannel(a.id, channel, { clientMessageId: "c1", text: "hello channel" });
    await routing.channelMessages(a.id, channel);
    await routing.sync({ inboxes: [b.id] });
    await routing.runtime(a.id);
    await routing.control(a.id, b.id, "ctl-1", { action: "interrupt" });
    const run = await routing.join({ clientKey: "run:spec", label: "worker", kind: "codex" });
    const enrolled = await routing.enrolResident({ sessionId: run.id, name: "SpecFern" });
    await routing.renewResident(enrolled.name, run.id);
    await routing.reportResidentAttention(enrolled.name, {
      sessionId: run.id,
      outcomes: [{ ref: "tell:1", worked: true }],
    });
    await routing.revokeResident(enrolled.name, run.id);
    const issued = await routing.issueSupervision();
    const supervision = new MarinaRoutingClient({
      url: base,
      token: issued.token,
      fetch: checkedFetch(),
    });
    const renewed = await supervision.renewSupervision();
    await new MarinaRoutingClient({
      url: base,
      token: renewed.token,
      fetch: checkedFetch(),
    }).revokeSupervision();
    await routing.leave(b.id);
  });

  it("investigations", async () => {
    const { token } = await person("SpecAsker");
    const client = new MarinaInvestigationClient({ url: base, token, fetch: checkedFetch() });
    const request = { kind: "prediction", question: "Will we ship?" } as const;
    const { attempt } = await client.start(request, "spec-start");
    await investigations.wait(attempt.id);
    await client.start(request, "spec-start");
    await client.list();
    const snapshot = await client.get(attempt.caseId);
    await client.get(attempt.caseId, attempt.id);
    await client.attempt(attempt.id);
    await client.events(attempt.id);
    await client.content(snapshot.attempt.result!.outputId!);
    await person("SpecReader");
    await client.grant(attempt.caseId, "SpecReader", "read");
    await client.review(attempt.id, "Looks right");
    await client.select(attempt.id);
    await client.resolve(attempt.id, { outcome: "yes" });
    const second = (
      await client.start({ kind: "prediction", question: "Will it rain?" }, "spec-two")
    ).attempt;
    await client.cancel(second.id);
    await client.erase(second.caseId);
  });

  it("panels", async () => {
    const { token } = await person("SpecPanels");
    const panels = new MarinaPanelClient({ url: base, token, fetch: checkedFetch() });
    const canvas = await panels.request<{ id: string }>("/api/canvases", "POST", {
      name: "Spec desk",
    });
    await panels.canvases();
    await panels.resources();
    const document = {
      title: "Spec panel",
      components: [
        { id: "root", component: "Column", children: ["note", "go"] },
        { id: "note", component: "Text", text: "Ready" },
        {
          id: "go",
          component: "Button",
          label: "Say hi",
          operation: { kind: "command", command: "look", syntax: "look [target]", values: {} },
        },
      ],
    };
    const node = await panels.publish(canvas.id, document as never);
    await panels.list(canvas.id);
    const read = await panels.get(canvas.id, node.id);
    const revised = await panels.revise(canvas.id, node.id, read.data.panelRevision!, {
      ...document,
      title: "Spec panel, revised",
    } as never);
    await panels.interact(canvas.id, node.id, {
      revision: revised.data.panelRevision!,
      componentId: "go",
      requestId: "press-1",
      capabilityRevision: fixture.engine.commands.revision,
    });
  });

  it("covers every operation", () => {
    expect(problems).toEqual([]);
    const missing = HTTP_OPERATIONS.map((op) => op.id).filter(
      (id) => !exercised.has(id) && !NOT_EXERCISED[id],
    );
    expect(missing).toEqual([]);
    for (const id of Object.keys(NOT_EXERCISED)) expect(exercised.has(id), id).toBe(false);
  });

  it("serves the document and names it in the connect manifest", async () => {
    const served = await fetch(`${base}${HTTP_API_SCHEMA_PATH}`);
    expect(served.status).toBe(200);
    expect(await served.json()).toEqual(JSON.parse(renderOpenApi()));
    const manifest = (await (await fetch(`${base}/api/connect`)).json()) as {
      protocols: { http: { openapi: string } };
    };
    expect(manifest.protocols.http.openapi).toBe(HTTP_API_SCHEMA_PATH);
  });
});
