// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render, renderHistory } from "../src/engine/commands/forecast";
import { imageCommand } from "../src/engine/commands/image";
import { getRecipe } from "../src/engine/commands/usecase";
import { videoCommand } from "../src/engine/commands/video";
import type { ForecastAnswer } from "../src/forecast/question";
import { LocalStorageProvider } from "../src/storage/local-provider";
import { roomId } from "../src/types";
import craftWorld, { craftRooms } from "../worlds/craft";
import { evolveRooms } from "../worlds/evolve";
import { createTestEngine } from "./engine-fixture";
import { grantAllGates, stripAnsi } from "./helpers";
import { scopeProcessState } from "./process-state";

let fixture: ReturnType<typeof createTestEngine> | undefined;
afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
});

function world() {
  fixture = createTestEngine();
  const { engine, db } = fixture;
  const user = fixture.login("Reviewer");
  grantAllGates(db, user.entityId);
  engine.entities.get(user.entityId)!.properties.rank = 9;
  return {
    ...fixture,
    ...user,
    command: async (input: string) => {
      user.connection.clear();
      await engine.dispatchCommand(user.entityId, input);
      return stripAnsi(user.connection.allTextJoined());
    },
  };
}

describe("capability regressions on an isolated world", () => {
  it("image and video generation resolve the connected actor by id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "marina-media-actor-"));
    fixture = createTestEngine({ assetStorage: new LocalStorageProvider(dir) });
    const { engine } = fixture;
    const actor = fixture.login("Painter");
    const seen: unknown[] = [];
    const original = engine.mediaManager;
    (engine as unknown as { mediaManager: unknown }).mediaManager = {
      startJob: async (input: unknown) => {
        seen.push(input);
        throw new Error("fixture provider guard");
      },
    };
    try {
      const ctx = engine.buildContext(roomId("test/start"))!;
      for (const command of [imageCommand(engine), videoCommand(engine)])
        await command.handler(ctx as never, {
          entity: actor.entityId,
          room: roomId("test/start"),
          verb: command.name,
          args: "generate blue square",
          tokens: ["generate", "blue", "square"],
          raw: `${command.name} generate blue square`,
        });
      expect(seen).toHaveLength(2);
      for (const request of seen)
        expect(request).toMatchObject({ entityName: "Painter", entityId: actor.entityId });
      expect(actor.connection.allTextJoined()).not.toMatch(/Entity not found|reconnect and retry/);
    } finally {
      (engine as unknown as { mediaManager: unknown }).mediaManager = original;
      await fixture.dispose();
      fixture = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("admin kick and ban close the transport and immediately remove the entity", async () => {
    const w = world();
    for (const action of ["kick", "ban"]) {
      const victim = w.login(`Victim${action}`);
      const close = spyOn(victim.connection, "close");
      expect(await w.command(`admin ${action} Victim${action}`)).toContain(
        action === "kick" ? "Kicked" : "Banned",
      );
      expect(close).toHaveBeenCalledTimes(1);
      expect(w.engine.entities.get(victim.entityId)).toBeUndefined();
      close.mockRestore();
    }
  });

  it("shell save resolves board names and ids while enforcing group privacy", async () => {
    const directory = mkdtempSync(join(tmpdir(), "marina-shell-capability-"));
    using _state = scopeProcessState({ env: { MARINA_DATA_DIR: directory } });
    try {
      const w = world();
      const board = w.engine.boardManager!.createBoard({ name: "OutputBoard" });
      await w.engine.shellRuntime.exec(w.entityId, "echo", ["retained-shell-evidence"]);
      expect(await w.command("shell save board OutputBoard Named result")).toContain(
        "Output posted",
      );
      expect(await w.command(`shell save board ${board.id} Id result`)).toContain("Output posted");
      expect(w.db.listBoardPosts(board.id).map((post) => post.body.trim())).toEqual([
        "retained-shell-evidence",
        "retained-shell-evidence",
      ]);
      const privateBoard = w.engine.boardManager!.createBoard({
        name: "PrivateOutput",
        scopeType: "group",
        scopeId: "another-group",
      });
      expect(await w.command("shell save board PrivateOutput Forbidden")).toContain("not found");
      expect(w.db.listBoardPosts(privateBoard.id)).toHaveLength(0);
      await fixture!.dispose();
      fixture = undefined;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("bare project read forms return saved state without changing the project", async () => {
    const w = world();
    await w.command("project create reviewable | Capability regression");
    await w.command("project reviewable budget tokens 10000 cost 3 duration 1h");
    await w.command("project reviewable orchestrate pipeline");
    await w.command("project reviewable memory shared");
    const before = w.db.getProjectByName("reviewable");
    expect(await w.command("project reviewable budget")).toContain("10000");
    expect(await w.command("project reviewable usage")).toContain("Tokens: 0");
    expect(await w.command("project reviewable orchestrate")).toContain("pipeline");
    expect(await w.command("project reviewable memory")).toContain("shared");
    for (const action of ["decompose", "outcome", "propose"])
      expect(await w.command(`project reviewable ${action}`)).not.toContain("Usage:");
    expect(w.db.getProjectByName("reviewable")).toEqual(before);
  });

  it("bare benchmark kit dry-run produces a plan without starting a run", async () => {
    using _state = scopeProcessState({ trustProfile: "local" });
    const w = world();
    const output = await w.command(
      "benchmark kit ifbench arms:bare replicates:1 limit:1 budget:2 dry-run",
    );
    expect(output).not.toContain("Unknown");
    expect(output).toContain("Setup: ifbench");
    expect(output).toContain("Steps:");
  });

  it.each([
    ["retrieval", "answer", "bench_ret_active", "bench_ret_idx", "bench_ret_correct", "blue"],
    ["adaptation", "respond", "bench_ad_rules_read", "bench_ad_idx", "bench_ad_correct", "even"],
    ["memory", "answer", "bench_mem_phase", "bench_mem_qidx", "bench_mem_correct", "cycle 7"],
  ])(
    "%s benchmark rejects empty and partial answers before awarding credit",
    async (name, command, active, index, score, answer) => {
      const w = world();
      const id = roomId(`bench/${name}`);
      w.engine.registerRoom(id, evolveRooms()[id]!);
      w.engine.entities.move(w.entityId, id);
      const p = w.engine.entities.get(w.entityId)!.properties as Record<string, unknown>;
      p.active_quest = `bench_${name}`;
      p[active] = name === "memory" ? "test" : true;
      p[index] = 0;
      p[score] = 0;
      p.bench_ad_variant = 0;
      expect(await w.command(command)).toContain("empty answer");
      expect(p[index]).toBe(0);
      expect(p[score]).toBe(0);
      await w.command(`${command} ${answer.slice(0, 1)}`);
      expect(p[index]).toBe(1);
      expect(p[score]).toBe(0);
      p[index] = 0;
      expect(await w.command(`${command} ${answer}`)).toContain("Correct!");
      expect(p[score]).toBe(1);
    },
  );

  it("navigation and memory examinations show the item and count only real items", async () => {
    const w = world();
    for (const [name, item, counter] of [
      ["navigation", "clue-sheet", "bench_nav_examinations"],
      ["memory", "stone-1", "bench_mem_studied"],
    ]) {
      const id = roomId(`bench/${name}`);
      w.engine.registerRoom(id, evolveRooms()[id]!);
      w.engine.entities.move(w.entityId, id);
      const p = w.engine.entities.get(w.entityId)!.properties as Record<string, unknown>;
      p.active_quest = `bench_${name}`;
      p.bench_mem_phase = "study";
      p[counter!] = 0;
      const text = await w.command(`examine ${item}`);
      expect(text.length).toBeGreaterThan(20);
      expect(p[counter!]).toBe(1);
      expect(await w.command("examine absent-item")).toContain("You see no");
      expect(p[counter!]).toBe(1);
    }
  });

  it("shipping transfers the complete spec to the review room even before its first tick", async () => {
    const w = world();
    craftWorld.seed?.(w.db);
    for (const [id, room] of Object.entries(craftRooms())) w.engine.registerRoom(roomId(id), room);
    w.engine.entities.move(w.entityId, roomId("craft/workshop"));
    await w.command("spec create Tested transfer");
    const workshop = w.engine.buildContext(roomId("craft/workshop"))!;
    const specs = workshop.store.get<Array<Record<string, unknown>>>("specs")!;
    specs[0]!.criteria = ["Preserve the acceptance criteria across the room boundary"];
    workshop.store.set("specs", specs);
    await w.command("implement spec-1");
    expect(await w.command("ship spec-1")).toContain("Shipped");
    w.engine.entities.move(w.entityId, roomId("craft/review"));
    expect(await w.command("review spec-1")).toContain("Preserve the acceptance criteria");
    const review = w.engine.buildContext(roomId("craft/review"))!;
    expect(review.store.get<Array<{ status: string }>>("specs")?.[0]?.status).toBe("review");
    await w.command("review spec-1");
    expect(review.store.get<unknown[]>("specs")).toHaveLength(1);
    review.channels!.send("craft", "forger", "Forger", '[craft-spec:v1] {"id":"spec-2"}');
    expect(await w.command("review spec-2")).toContain("not found");
  });

  it("natural-language coding verification routes to a real workspace recipe", async () => {
    const w = world();
    const text = await w.command("usecase I want to verify a coding change");
    expect(text).toContain("Use case launched: code");
    const recipe = getRecipe("code")!("change");
    expect(recipe.tasks.map((task) => task.description).join(" ")).toContain("code verify");
  });

  it("numeric forecasts with missing uncertainty never display undefined intervals", () => {
    const w = world();
    const id = w.db.saveForecastAnswer({
      entityName: "Reviewer",
      question: "A number",
      kind: "number",
      mean: 42,
      answerJson: "{}",
    });
    const history = renderHistory([w.db.getForecastAnswer(id)!]);
    expect(history).toContain("uncertainty not provided");
    expect(history).not.toContain("null");
    const answer = render({
      question: "A number",
      kind: "number",
      mean: 42,
      analysts: [],
      sources: [],
      costUsd: 0,
      latencyMs: 0,
    } as unknown as ForecastAnswer);
    expect(answer).toContain("uncertainty not provided");
    expect(answer).not.toContain("undefined");
  });
});
