// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Crew driver with a task contract: the lead owns the ONE tracked attempt, and
// a member of the crew recorded on that attempt may submit it for the crew —
// same checks, the lead's claim, attributed to the member, the lead told.
// Nobody outside the roster can.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentHandle } from "../src/agent/agent-types";
import { LocalWorkspace } from "../src/coding/local-workspace";
import {
  beginCodingRun,
  bindCodingRunCrew,
  codingRunMetadata,
  submitCodingRun,
} from "../src/coding/task-run";
import type { ChannelManager } from "../src/coordination/channel-manager";
import type { CreateCrewOpts, CrewManager } from "../src/coordination/crew-manager";
import { codeCommand } from "../src/engine/commands/code";
import { crewSupport } from "../src/engine/commands/code/crew";
import { MarinaDB } from "../src/persistence/database";
import {
  type CommandInput,
  type Crew,
  type CrewId,
  type Entity,
  type EntityId,
  type RoomContext,
  roomId,
} from "../src/types";
import { stripAnsi } from "./helpers";

function entity(id: string, name: string): Entity {
  return {
    id: id as EntityId,
    name,
    kind: "agent",
    room: roomId("test/start"),
    createdAt: Date.now(),
    short: name,
    long: name,
    inventory: [],
    properties: {},
  };
}

function inputFor(who: Entity, raw: string): CommandInput {
  const args = raw.slice(raw.indexOf(" ") + 1).trim();
  return {
    raw,
    verb: "code",
    args,
    tokens: args.split(/\s+/),
    entity: who.id,
    room: roomId("test/start"),
  };
}

function crewManagerStub() {
  const crews = new Map<string, Crew>();
  const manager = {
    create(opts: CreateCrewOpts): Crew {
      const crew: Crew = {
        id: `crew-${crews.size + 1}` as CrewId,
        name: opts.name,
        goal: opts.goal,
        formation: opts.formation ?? "freeform",
        lifetime: opts.lifetime ?? "ephemeral",
        ownerId: opts.owner,
        members: opts.members.map((m) => ({
          agentName: m.agentName,
          role: m.role ?? "specialist",
          joinedAt: Date.now(),
        })),
        state: "assembling",
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      };
      crews.set(crew.id, crew);
      return crew;
    },
    dispatch(id: CrewId) {
      const crew = crews.get(id);
      if (crew && !crew.channelId) crew.channelId = `crew:${id}`;
    },
    get: (id: CrewId) => crews.get(id),
    forAgent: () => [],
  } as unknown as CrewManager;
  return { manager, crews };
}

const channelManager = {
  isMember: () => false,
  addMember: () => {},
} as unknown as ChannelManager;

describe("crew member submits the tracked attempt for the crew", () => {
  let dir: string;
  let db: MarinaDB;
  let owner: Entity;
  let lead: Entity;
  let member: Entity;
  let outsider: Entity;
  let crews: ReturnType<typeof crewManagerStub>;
  let notices: Array<{ id: string; text: string; meta?: Record<string, unknown> }>;
  let sent: Map<string, string[]>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "marina-crew-submit-"));
    db = new MarinaDB(join(dir, "world.db"));
    owner = entity("u_owner", "Owner");
    lead = entity("a_lead", "lead");
    member = entity("a_bob", "bob");
    outsider = entity("a_eve", "eve");
    for (const e of [owner, lead, member, outsider]) db.saveEntity(e);
    db.createCodingSession({ id: "s", title: "Coding", workspaceRoot: dir, createdBy: owner.name });
    // Members and the outsider have the session selected; only the roster decides.
    for (const e of [lead, member, outsider]) e.properties.coding_session_id = "s";
    crews = crewManagerStub();
    notices = [];
    sent = new Map();
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function begin(budgetMs?: number) {
    return beginCodingRun(db, {
      session: db.getCodingSession("s")!,
      owner,
      worker: lead,
      prompt: "Fix the bug",
      profile: "marina",
      ownerMode: "unattended",
      ...(budgetMs ? { budgetMs } : {}),
    });
  }

  function withCrew(run: ReturnType<typeof begin>) {
    const crew = crews.manager.create({
      name: "code-s-1",
      goal: "support",
      owner: owner.id,
      members: [{ agentName: member.name }],
    });
    expect(
      bindCodingRunCrew(
        db,
        run.id,
        { id: crew.id, name: crew.name, members: [{ name: member.name, id: member.id }] },
        owner.name,
      ),
    ).toBe(true);
    return crew;
  }

  function summary(text = "fixed it") {
    return db.createCodingArtifact({
      sessionId: "s",
      kind: "summary",
      status: "complete",
      title: "summary",
      contentText: text,
      createdBy: member.name,
    });
  }

  function command() {
    const all = [owner, lead, member, outsider];
    return codeCommand({
      db,
      getEntity: (id) => all.find((e) => e.id === id),
      findEntityExact: (name) => all.find((e) => e.name.toLowerCase() === name.toLowerCase()),
      workspace: new LocalWorkspace(),
      crewManager: crews.manager,
      channelManager,
      notify: (id, text, meta) => notices.push({ id, text, meta }),
    });
  }

  async function run(who: Entity, raw: string) {
    const out: string[] = [];
    sent.set(who.id, out);
    const ctx = {
      send: (_id: EntityId, message: string) => out.push(stripAnsi(message)),
    } as unknown as RoomContext;
    await command().handler(ctx, inputFor(who, raw));
    return out.join("\n");
  }

  it("submitCodingRun: a recorded member submits for the crew once; no one else can", async () => {
    const attempt = begin();
    const crew = withCrew(attempt);
    // Without the explicit crew intent a member's summary is progress, never a submit.
    expect(await submitCodingRun(db, "s", member, summary())).toBeUndefined();
    // Outside the roster: refused even with the crew id.
    expect(await submitCodingRun(db, "s", outsider, summary(), true, crew.id)).toBeUndefined();
    // A different crew id: refused.
    expect(await submitCodingRun(db, "s", member, summary(), true, "crew-x")).toBeUndefined();
    const submitted = (await submitCodingRun(db, "s", member, summary(), true, crew.id))!;
    expect(submitted.status).toBe("submitted");
    const meta = codingRunMetadata(submitted);
    expect(meta.submittedBy).toEqual({ name: "bob", key: member.id, crewId: crew.id });
    // The task was submitted on the lead's claim, with the member named in the evidence.
    const claim = db.getTaskClaim(meta.taskId, lead.id)!;
    expect(claim.status).toBe("submitted");
    expect(claim.submission_text).toContain("Submitted by: bob, member of crew code-s-1");
    // The attempt closes once: the lead's later summary does not submit again.
    expect(await submitCodingRun(db, "s", lead, summary())).toBeUndefined();
    expect(db.listCodingRuns({ sessionId: "s", limit: 5 })).toHaveLength(1);
  });

  it("a member's submission keeps the budget-forced label", async () => {
    const attempt = begin(600_000);
    const crew = withCrew(attempt);
    const now = Date.now();
    db.updateCodingArtifact(attempt.id, {
      metadata: {
        ...codingRunMetadata(db.getCodingArtifact(attempt.id)!),
        startedAt: now - 590_000,
        deadlineAt: now + 10_000,
      },
    });
    const forced = (await submitCodingRun(db, "s", member, summary(), true, crew.id))!;
    expect(forced.status).toBe("submitted");
    expect(codingRunMetadata(forced).budgetForced?.reason).toBe("deadline");
  });

  it("code summary submit:crew: member submits, lead and owner told; outsider refused", async () => {
    const attempt = begin();
    withCrew(attempt);

    const refused = await run(outsider, "code summary submit:crew -- I did it");
    expect(refused).toContain("Only a member of crew code-s-1 may submit");
    expect(db.getCodingArtifact(attempt.id)!.status).toBe("active");
    expect(db.listCodingArtifacts("s", 20, "summary")).toHaveLength(0);

    // A member's plain summary stays progress on the active attempt.
    await run(member, "code summary reviewed the diff, two nits");
    expect(db.getCodingArtifact(attempt.id)!.status).toBe("active");

    await run(member, "code summary submit:crew -- fixed and checked");
    const done = db.getCodingArtifact(attempt.id)!;
    expect(done.status).toBe("submitted");
    expect(codingRunMetadata(done).submittedBy?.name).toBe("bob");
    const leadNotice = notices.find((n) => n.id === lead.id);
    expect(leadNotice?.text).toContain("bob submitted task #");
    expect(leadNotice?.meta).toMatchObject({ code: { event: "crew_member_submitted" } });
    expect(notices.some((n) => n.id === owner.id)).toBe(true);
    const submittedEvent = db
      .listCodingEvents("s")
      .find((event) => event.kind === "task_run_submitted")!;
    expect(submittedEvent.actor).toBe("bob");

    // Closed once: a second crew submit finds no active attempt.
    const again = await run(member, "code summary submit:crew -- once more");
    expect(again).toContain("No active task attempt");
  });

  it("a member removed from the live crew, or a dissolved crew, cannot submit", async () => {
    const attempt = begin();
    const crew = withCrew(attempt);
    crews.crews.get(crew.id)!.members = [];
    expect(await run(member, "code summary submit:crew -- done")).toContain(
      "Only a member of crew",
    );
    crews.crews.get(crew.id)!.members = [
      { agentName: member.name, role: "specialist", joinedAt: Date.now() },
    ];
    crews.crews.get(crew.id)!.state = "dissolved";
    expect(await run(member, "code summary submit:crew -- done")).toContain(
      "Only a member of crew",
    );
    expect(db.getCodingArtifact(attempt.id)!.status).toBe("active");
  });

  it("an attempt with no crew refuses a crew submit; a bad modifier shows usage", async () => {
    begin();
    expect(await run(member, "code summary submit:crew -- done")).toContain("has no crew");
    expect(await run(member, "code summary submit:all -- done")).toContain(
      "code summary submit:crew -- <summary>",
    );
  });

  it("crewSupport records the roster on the attempt and the lead keeps the write lock", async () => {
    const attempt = begin();
    db.updateCodingSession("s", { writer: lead.name });
    const handle = {
      name: member.name,
      getStatus: () => ({ entityId: member.id, state: "idle", role: "coder" }),
    } as unknown as AgentHandle;
    const out: string[] = [];
    const ctx = { send: (_id: EntityId, m: string) => out.push(m) } as unknown as RoomContext;
    await crewSupport(
      ctx,
      owner.id,
      owner,
      {
        db,
        getEntity: (id: string) => [owner, lead, member].find((e) => e.id === id),
        crewManager: crews.manager,
        channelManager,
        listAgents: () => [{ name: member.name }],
        findAgentByName: (name: string) => (name === member.name ? member : undefined),
        agentRuntime: { get: (name: string) => (name === member.name ? handle : undefined) },
      } as never,
      db.getCodingSession("s")!,
      "Fix the bug",
      lead.name,
    );
    const meta = codingRunMetadata(db.getCodingArtifact(attempt.id)!);
    expect(meta.crew?.members).toEqual([{ name: "bob", key: member.id }]);
    expect(db.getCodingSession("s")!.writer).toBe(lead.name);
    expect(db.listCodingEvents("s").some((e) => e.kind === "task_run_crew_bound")).toBe(true);
  });
});
