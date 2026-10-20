// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The as-of fence (`src/engine/evidence-fence.ts`): while a cutoff is set, no
 * tool path returns evidence from after it — bounded commands honour it, every
 * other outbound or knowledge-reading command is refused, unknown and room
 * commands fail closed, the fence is relayed to whoever a fenced resident
 * reaches, and a `model_request` routed with a cutoff fences its responder.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { contextCommand, previewParticipantContext } from "../src/engine/commands/context";
import { dataCommand } from "../src/engine/commands/data";
import { runTriage } from "../src/engine/commands/triage";
import { webCommand } from "../src/engine/commands/web";
import {
  commandFenceFor,
  currentEvidenceCutoff,
  currentEvidenceCutoffMs,
  EVIDENCE_FENCE_POLICY,
  entityEvidenceFence,
  FENCED_MEMORY_API_OPERATIONS,
  fenceDecision,
  fenceEntity,
  parseEvidenceCutoff,
  resetEvidenceFenceForTests,
  withEvidenceCutoff,
} from "../src/engine/evidence-fence";
import { runCommandScope, scopeEvidenceFence } from "../src/engine/gate-context";
import { initProvidersSync, registerProvider } from "../src/engine/search-providers/index";
import type { ForecastLookup } from "../src/forecast/lookup-types";
import { buildUnifiedContext } from "../src/memory/unified-context";
import { routeToChannel } from "../src/net/model-api/routing";
import type { EntityId, RoomContext } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { stripAnsi } from "./helpers";

const CUTOFF = "2026-06-01T00:00:00.000Z";
const CUTOFF_MS = Date.parse(CUTOFF);
const BEFORE = CUTOFF_MS - 10 * 86_400_000;
const AFTER = CUTOFF_MS + 10 * 86_400_000;

afterEach(() => resetEvidenceFenceForTests());

/** A RoomContext that only records what a handler sends. */
function capture(): { ctx: RoomContext; out: string[] } {
  const out: string[] = [];
  const ctx = {
    send: (_id: unknown, text: string) => {
      out.push(stripAnsi(String(text)));
    },
  } as unknown as RoomContext;
  return { ctx, out };
}

const input = (args: string) => ({
  verb: "",
  args,
  tokens: args.split(/\s+/).filter(Boolean),
  entity: "e_1" as EntityId,
  room: "test/start" as never,
  raw: args,
});

describe("cutoff values and frames", () => {
  it("parses ISO, dates and epoch ms; junk is no fence", () => {
    expect(parseEvidenceCutoff("2026-06-01")).toBe(CUTOFF_MS);
    expect(parseEvidenceCutoff(CUTOFF)).toBe(CUTOFF_MS);
    expect(parseEvidenceCutoff(CUTOFF_MS)).toBe(CUTOFF_MS);
    expect(parseEvidenceCutoff("soon")).toBeUndefined();
    expect(parseEvidenceCutoff(undefined)).toBeUndefined();
  });

  it("nothing is fenced by default", () => {
    expect(currentEvidenceCutoff()).toBeUndefined();
    expect(commandFenceFor("e_1")).toBeUndefined();
  });

  it("in-process frames nest and only ever tighten", async () => {
    await withEvidenceCutoff(CUTOFF, async () => {
      expect(currentEvidenceCutoff()).toBe(CUTOFF);
      await withEvidenceCutoff(AFTER, async () => {
        expect(currentEvidenceCutoffMs()).toBe(CUTOFF_MS);
      });
      await withEvidenceCutoff(BEFORE, async () => {
        expect(currentEvidenceCutoffMs()).toBe(BEFORE);
      });
    });
    expect(currentEvidenceCutoff()).toBeUndefined();
  });

  it("a nested command scope inherits the fence and never loosens it", async () => {
    await runCommandScope(
      "e_1",
      async () => {
        expect(scopeEvidenceFence()?.cutoff).toBe(CUTOFF_MS);
        await runCommandScope("e_1", async () => {
          expect(scopeEvidenceFence()?.cutoff).toBe(CUTOFF_MS);
        });
        await runCommandScope(
          "e_2",
          async () => {
            expect(scopeEvidenceFence()?.cutoff).toBe(CUTOFF_MS);
          },
          { cutoff: AFTER },
        );
      },
      { cutoff: CUTOFF_MS },
    );
  });

  it("entity fences combine to the tightest, expire, and release", () => {
    const now = Date.now();
    const release = fenceEntity("e_1", "a", AFTER, now + 60_000);
    fenceEntity("e_1", "b", CUTOFF_MS, now + 1_000);
    expect(entityEvidenceFence("e_1", now)?.cutoff).toBe(CUTOFF_MS);
    // "b" lapsed: only "a" is left.
    expect(entityEvidenceFence("e_1", now + 2_000)?.cutoff).toBe(AFTER);
    release();
    expect(entityEvidenceFence("e_1", now + 2_000)).toBeUndefined();
  });
});

describe("the command surface under a fence", () => {
  it("names every built-in command (a new command must choose)", async () => {
    const f = createTestEngine();
    try {
      const names = f.engine.commands.allBuiltins().map((d) => d.name);
      const missing = names.filter((n) => !Object.hasOwn(EVIDENCE_FENCE_POLICY, n));
      expect(missing).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  it("fails closed: unknown commands, room commands and nested forecasts are refused", () => {
    expect(fenceDecision("brand-new-tool", [])).toBe("refuse");
    expect(fenceDecision(undefined, [])).toBe("refuse");
    expect(fenceDecision("look", [], false)).toBe("refuse");
    expect(fenceDecision("forecast", ["Will", "it?"])).toBe("refuse");
    expect(fenceDecision("forecast", ["list"])).toBe("refuse");
  });

  it("every outbound command without as-of support is refused", () => {
    for (const name of [
      "probe",
      "market",
      "position",
      "arena",
      "connect",
      "run",
      "shell",
      "code",
      "research",
      "inquiry",
      "image",
      "feed",
      "chronicle",
      "board",
      "search",
      "pool",
      "outcome",
      "learned",
      "benchmark",
      "readiness",
    ])
      expect(`${name}:${fenceDecision(name, ["x"])}`).toBe(`${name}:refuse`);
  });

  it("bounded commands are `fenced`, talking and arithmetic are allowed", () => {
    expect(fenceDecision("web", ["search", "q"])).toBe("fenced");
    expect(fenceDecision("web", ["fetch", "u"])).toBe("fenced");
    expect(fenceDecision("web", ["multisearch", "a"])).toBe("fenced");
    expect(fenceDecision("web", ["swarm", "q"])).toBe("refuse");
    expect(fenceDecision("data", ["series", "UNRATE"])).toBe("fenced");
    expect(fenceDecision("data", ["sources"])).toBe("allow");
    expect(fenceDecision("recall", ["q"])).toBe("fenced");
    expect(fenceDecision("lessons", ["q"])).toBe("fenced");
    expect(fenceDecision("lessons", ["retire", "1"])).toBe("refuse");
    expect(fenceDecision("triage", ["q"])).toBe("fenced");
    for (const name of ["say", "tell", "calc", "quant", "help", "batch"])
      expect(fenceDecision(name, ["x"])).toBe("allow");
  });

  it("memory and notes: writes run, reads of accumulated knowledge are refused", () => {
    const api = (op: string) => ["api", JSON.stringify({ operation: op })];
    for (const op of FENCED_MEMORY_API_OPERATIONS)
      expect(fenceDecision("memory", api(op))).toBe("allow");
    for (const op of ["search", "get", "query", "context", "retrieve", "source_search", "graph"])
      expect(fenceDecision("memory", api(op))).toBe("refuse");
    expect(fenceDecision("memory", ["api", "{not json"])).toBe("refuse");
    expect(fenceDecision("memory", ["set", "rest", "done"])).toBe("allow");
    expect(fenceDecision("memory", ["kv", "get", "k"])).toBe("refuse");
    expect(fenceDecision("memory", ["kv", "set", "k", "v"])).toBe("allow");
    expect(fenceDecision("note", ["the", "answer", "is", "0.4"])).toBe("allow");
    expect(fenceDecision("note", ["search", "x"])).toBe("refuse");
    expect(fenceDecision("note", ["list"])).toBe("refuse");
    expect(fenceDecision("channel", ["send", "model-x", "{}"])).toBe("allow");
    expect(fenceDecision("channel", ["history", "model-x"])).toBe("refuse");
    expect(fenceDecision("task", ["submit", "1", "done"])).toBe("allow");
    expect(fenceDecision("task", ["list"])).toBe("refuse");
    expect(fenceDecision("conduct", ["resolve", "role:x"])).toBe("allow");
    expect(fenceDecision("conduct", ["track", "s", "x"])).toBe("refuse");
    expect(fenceDecision("decision", ["check", "draft"])).toBe("allow");
    expect(fenceDecision("decision", ["settings"])).toBe("refuse");
  });
});

describe("bounded tools", () => {
  it("web search: forced onto date-strict providers at the cutoff", async () => {
    initProvidersSync();
    const seen: Array<string | undefined> = [];
    registerProvider({
      name: "fence-loose",
      engines: ["fence-engine"],
      search: async () => {
        seen.push("loose");
        return [{ title: "live", url: "https://live/", snippet: "", source: "loose" }];
      },
    });
    registerProvider({
      name: "fence-strict",
      engines: ["fence-engine"],
      dateBound: "strict",
      boundOnly: true,
      search: async (_q, o) => {
        seen.push(o.before);
        return [
          {
            title: "old",
            url: "https://old/",
            snippet: "",
            source: "s",
            published: "2026-05-20T00:00:00Z",
          },
          {
            title: "late",
            url: "https://late/",
            snippet: "",
            source: "s",
            published: "2026-06-10T00:00:00Z",
          },
          { title: "undated", url: "https://undated/", snippet: "", source: "s" },
        ];
      },
    });
    const runtime = { httpGet: async () => ({ error: "no network in tests" }) } as never;
    const web = webCommand({
      getEntity: () => ({ name: "r" }) as never,
      connectorRuntime: runtime,
    });
    const { ctx, out } = capture();
    // A later bound asked for is tightened to the cutoff.
    await withEvidenceCutoff(CUTOFF, () =>
      web.handler(ctx, input("search engines:fence-engine before:2026-09-01 polls")),
    );
    expect(seen).toEqual([CUTOFF]);
    expect(out.join("\n")).toContain("old");
    expect(out.join("\n")).not.toContain("late");
    expect(out.join("\n")).not.toContain("live");
    expect(out.join("\n")).not.toContain("undated");
  });

  it("web fetch: a live fetch becomes the archived page at the cutoff; corpora and swarm are refused", async () => {
    const urls: string[] = [];
    const runtime = {
      httpGet: async (url: string) => {
        urls.push(url);
        return { status: 404, body: "" };
      },
    } as never;
    const web = webCommand({
      getEntity: () => ({ name: "r" }) as never,
      connectorRuntime: runtime,
    });
    const { ctx, out } = capture();
    await withEvidenceCutoff(CUTOFF, async () => {
      await web.handler(ctx, input("fetch https://example.org/result"));
      await web.handler(ctx, input("fetch corpus://bcp/doc1"));
      await web.handler(ctx, input("swarm who won?"));
    });
    expect(urls.length).toBeGreaterThan(0);
    // Never the live page: only the archive, bounded at the cutoff.
    expect(urls.every((u) => u.includes("archive.org"))).toBe(true);
    expect(urls.some((u) => u.includes("20260601"))).toBe(true);
    expect(out[0]).toContain("No archived capture");
    expect(out[1]).toContain("Refused under the evidence cutoff");
    expect(out[2]).toContain("Refused under the evidence cutoff");
  });

  it("data: lookups run as of the cutoff, never later", async () => {
    const asked: string[] = [];
    const lookup: ForecastLookup = {
      name: "fred",
      lookup: async (_q, cutoff) => {
        asked.push(cutoff.toISOString());
        return { name: "fred", lines: [], sources: [] };
      },
    };
    const data = dataCommand({ options: { lookups: [lookup] } });
    const { ctx } = capture();
    await withEvidenceCutoff(CUTOFF, () =>
      data.handler(ctx, input("series UNRATE asof:2026-09-01")),
    );
    expect(asked).toEqual([CUTOFF]);
  });

  it("triage: NOW is the cutoff, never the wall clock", () => {
    const lines = withEvidenceCutoff(CUTOFF, () =>
      runTriage("What was the US unemployment rate in May 2026?", new Date("2026-10-20T00:00:00Z")),
    );
    expect(lines.join("\n")).toContain("now 2026-06-01");
  });
});

describe("memory under the fence", () => {
  it("recall, context and the out-of-band context preview serve only notes known by the cutoff", async () => {
    const f = createTestEngine();
    try {
      const { connection, entityId } = f.login("Resi");
      const early = f.db.createNote("Resi", "election turnout early estimate zebra", "test/start");
      const late = f.db.createNote("Resi", "election turnout final result zebra", "test/start");
      const raw = (f.db as unknown as { db: { run: (s: string, p: unknown[]) => void } }).db;
      raw.run("UPDATE notes SET created_at = ? WHERE id = ?", [BEFORE, early]);
      raw.run("UPDATE notes SET created_at = ? WHERE id = ?", [AFTER, late]);

      // Unfenced: both.
      await f.engine.processCommand(entityId, "recall election turnout zebra");
      expect(connection.lastText()).toContain("final result");

      // Fenced (as a routed request would): the later note is gone, on every surface.
      fenceEntity(entityId, "t", CUTOFF_MS, Date.now() + 60_000);
      await f.engine.processCommand(entityId, "recall election turnout zebra");
      const plain = stripAnsi(connection.lastText());
      expect(plain).toContain("early estimate");
      expect(plain).not.toContain("final result");
      await f.engine.processCommand(entityId, "recall election turnout zebra all");
      const unified = stripAnsi(connection.lastText());
      expect(unified).toContain("early estimate");
      expect(unified).not.toContain("final result");

      const preview = await previewParticipantContext(
        { db: f.db, getEntity: (id) => f.engine.entities.get(id) },
        entityId,
        { query: "election turnout zebra" },
      );
      const served = preview.context.tiers.flatMap((t) => t.items.map((i) => i.content));
      expect(served.some((c) => c.includes("early estimate"))).toBe(true);
      expect(served.some((c) => c.includes("final result"))).toBe(false);
      expect(preview.context.degraded.some((d) => d.code === "fenced")).toBe(true);
      expect(contextCommand({ db: f.db, getEntity: () => undefined }).name).toBe("context");
    } finally {
      await f.dispose();
    }
  });

  it("buildUnifiedContext without asOf is unchanged", async () => {
    const f = createTestEngine();
    try {
      f.login("Resi");
      f.db.createNote("Resi", "quokka migration pattern", "test/start");
      const a = await buildUnifiedContext(f.db, "Resi", "quokka migration");
      const b = await buildUnifiedContext(f.db, "Resi", "quokka migration", {});
      expect(JSON.stringify(a.tiers)).toBe(JSON.stringify(b.tiers));
      expect(a.degraded.some((d) => d.code === "fenced")).toBe(false);
    } finally {
      await f.dispose();
    }
  });
});

describe("the fence over the engine", () => {
  let f: ReturnType<typeof createTestEngine>;
  beforeEach(() => {
    f = createTestEngine();
  });
  afterEach(async () => {
    await f.dispose();
  });

  it("a fenced entity's refused commands say why; allowed ones run; unfenced is unchanged", async () => {
    const { connection, entityId } = f.login("Resi");
    await f.engine.processCommand(entityId, "calc 2+2");
    expect(connection.lastText()).toContain("4");
    fenceEntity(entityId, "t", CUTOFF_MS, Date.now() + 60_000);
    await f.engine.processCommand(entityId, "forecast Will it rain tomorrow?");
    expect(connection.lastText()).toContain("Refused under the evidence cutoff");
    expect(connection.lastText()).toContain("cannot start another forecast");
    await f.engine.processCommand(entityId, "probe resolving x");
    expect(connection.lastText()).toContain("Refused under the evidence cutoff");
    await f.engine.processCommand(entityId, "feed list");
    expect(connection.lastText()).toContain("Refused under the evidence cutoff");
    await f.engine.processCommand(entityId, "calc 3*3");
    expect(connection.lastText()).toContain("9");
    // A batch's parts are each checked: the fence is inherited by nested commands.
    await f.engine.processCommand(entityId, "batch calc 1+1 ; chronicle list");
    expect(connection.allText().join("\n")).toContain("`chronicle`");
  });

  it("a room command is refused under the fence (fail closed)", async () => {
    await f.dispose();
    f = createTestEngine({
      room: {
        commands: {
          sneak: (ctx: RoomContext, inp: { entity: EntityId }) => ctx.send(inp.entity, "leaked"),
        },
      } as never,
    });
    const { connection, entityId } = f.login("Resi");
    fenceEntity(entityId, "t", CUTOFF_MS, Date.now() + 60_000);
    await f.engine.processCommand(entityId, "sneak");
    expect(connection.lastText()).toContain("Refused under the evidence cutoff");
    expect(connection.allText().join("\n")).not.toContain("leaked");
  });

  it("relays the fence to an agent a fenced resident reaches, not to a person", async () => {
    const a = f.login("Resi");
    const b = f.login("Helper");
    const p = f.login("Person");
    b.connection.internal = true; // an in-process resident
    fenceEntity(a.entityId, "t", CUTOFF_MS, Date.now() + 60_000);
    await f.engine.processCommand(a.entityId, "tell Helper look up the result for me");
    await f.engine.processCommand(a.entityId, "tell Person fyi");
    expect(entityEvidenceFence(b.entityId)?.cutoff).toBe(CUTOFF_MS);
    expect(entityEvidenceFence(p.entityId)).toBeUndefined();
    // The relayed helper's own outbound commands are refused too.
    await f.engine.processCommand(b.entityId, "probe resolving x");
    expect(b.connection.lastText()).toContain("Refused under the evidence cutoff");
  });

  it("a routed model_request with a cutoff fences its responder for the whole turn", async () => {
    const lead = f.login("Lead");
    f.engine.entities.get(lead.entityId)!.kind = "agent";
    const cm = f.engine.channelManager!;
    const channel = cm.createChannel({ type: "model", name: "model-crewf" });
    cm.addMember(channel.id, lead.entityId);
    const turn: string[] = [];
    let envelope: Record<string, unknown> | undefined;
    cm.onMessage((channelId, senderId, _n, content) => {
      if (channelId !== channel.id || senderId !== "__model_api__") return;
      const req = JSON.parse(content) as { type?: string; id?: string };
      if (req.type !== "model_request") return;
      envelope = req as Record<string, unknown>;
      void (async () => {
        // The resident's tool calls during its turn.
        await f.engine.processCommand(lead.entityId, "forecast Will X happen?");
        turn.push(stripAnsi(lead.connection.lastText()));
        await f.engine.processCommand(lead.entityId, "market list");
        turn.push(stripAnsi(lead.connection.lastText()));
        cm.send(
          channelId,
          lead.entityId,
          "Lead",
          JSON.stringify({ type: "model_response", id: req.id, content: "0.4" }),
        );
      })();
    });
    const result = await routeToChannel(f.engine, "marina:crewf", "Will X happen?", {
      evidenceCutoff: CUTOFF,
    });
    expect(result.content).toBe("0.4");
    expect(result.respondent?.name).toBe("Lead");
    expect(envelope?.asof).toBe(CUTOFF);
    expect(turn.every((t) => t.includes("Refused under the evidence cutoff"))).toBe(true);
    // Released when the request settled.
    expect(entityEvidenceFence(lead.entityId)).toBeUndefined();
  });

  it("without a cutoff the routed request is unchanged (no asof, no fence)", async () => {
    const lead = f.login("Lead");
    f.engine.entities.get(lead.entityId)!.kind = "agent";
    const cm = f.engine.channelManager!;
    const channel = cm.createChannel({ type: "model", name: "model-crewg" });
    cm.addMember(channel.id, lead.entityId);
    let envelope: Record<string, unknown> | undefined;
    let fencedDuring: unknown = "unset";
    cm.onMessage((channelId, senderId, _n, content) => {
      if (channelId !== channel.id || senderId !== "__model_api__") return;
      const req = JSON.parse(content) as { type?: string; id?: string };
      if (req.type !== "model_request") return;
      envelope = req as Record<string, unknown>;
      fencedDuring = entityEvidenceFence(lead.entityId);
      cm.send(
        channelId,
        lead.entityId,
        "Lead",
        JSON.stringify({ type: "model_response", id: req.id, content: "ok" }),
      );
    });
    await routeToChannel(f.engine, "marina:crewg", "hi");
    expect(envelope && "asof" in envelope).toBe(false);
    expect(fencedDuring).toBeUndefined();
  });
});
