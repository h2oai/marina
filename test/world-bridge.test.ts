// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeRoleBundle,
  encodeRoleBundle,
  exportRoleBundle,
  importRoleBundle,
} from "../src/agent/role-bundle";
import { worldCommand } from "../src/engine/commands/world";
import { MarinaDB } from "../src/persistence/database";
import type { Entity, EntityId, RoomContext } from "../src/types";
import { WorldCollectiveManager } from "../src/world/world-collective-manager";
import { stripAnsi } from "./helpers";

let dir: string;
let parent: MarinaDB;
let child: MarinaDB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "world-bridge-"));
  parent = new MarinaDB(join(dir, "parent.db"));
  child = new MarinaDB(join(dir, "child.db"));
  parent.saveTrait({
    name: "curious",
    category: "cognitive",
    prompt: "Ask why. Note strengths and avoids in your own words.",
    capabilities: { strengths: ["questions"], domains: ["research"] },
    createdBy: "seed",
  });
  parent.saveTrait({ name: "terse", category: "style", prompt: "Be brief.", createdBy: "seed" });
  parent.saveRole({
    name: "scout-v2",
    traits: ["curious", "terse"],
    guidelines: ["Cite sources", "Say what you did not check"],
    focus: ["exploration"],
    tone: "plain",
    createdBy: "Scout",
  });
});
afterEach(() => {
  parent.close();
  child.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("role bundles — a role and its traits, losslessly", () => {
  it("round-trips through the encoded text into another world", () => {
    const bundle = exportRoleBundle(parent, "scout-v2")!;
    const decoded = decodeRoleBundle(encodeRoleBundle(bundle));
    expect("error" in decoded).toBe(false);
    const result = importRoleBundle(child, decoded as never, "Operator");
    expect(result).toMatchObject({ ok: true, traitsCreated: ["curious", "terse"] });
    const trait = child.getTrait("curious")!;
    expect(trait.prompt).toContain("Note strengths and avoids"); // text a command line would mangle
    expect(JSON.parse(trait.capabilities)).toEqual({
      strengths: ["questions"],
      domains: ["research"],
    });
    expect(JSON.parse(child.getRole("scout-v2")!.guidelines)).toEqual([
      "Cite sources",
      "Say what you did not check",
    ]);
  });

  it("only creates: an existing role, or a same-named trait that differs, is refused", () => {
    const bundle = exportRoleBundle(parent, "scout-v2")!;
    child.saveTrait({ name: "terse", category: "style", prompt: "Be brief.", createdBy: "x" });
    expect(importRoleBundle(child, bundle, "Op")).toMatchObject({
      ok: true,
      traitsShared: ["terse"],
    });
    expect(importRoleBundle(child, bundle, "Op")).toMatchObject({ ok: false });
    const other = new MarinaDB(join(dir, "other.db"));
    try {
      other.saveTrait({
        name: "curious",
        category: "cognitive",
        prompt: "Different.",
        createdBy: "x",
      });
      const r = importRoleBundle(other, bundle, "Op");
      expect(r.ok).toBe(false);
      expect(other.getRole("scout-v2")).toBeUndefined();
    } finally {
      other.close();
    }
    expect("error" in decodeRoleBundle("not-a-bundle")).toBe(true);
  });
});

describe("world — run commands and seed roles in a child world", () => {
  const op = { id: "e_op", name: "Operator", properties: { rank: 9 } } as unknown as Entity;
  let out: string[];
  const ctx = { send: (_e: string, t: string) => out.push(stripAnsi(t)) } as unknown as RoomContext;
  const input = (line: string) => {
    const tokens = line.split(/\s+/).slice(1);
    return { entity: "e_op" as EntityId, tokens, args: tokens.join(" "), raw: line } as never;
  };
  const sent: Array<{ url: string; body: { name: string; command: string } }> = [];
  const fetcher = async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { name: string; command: string };
    sent.push({ url, body });
    if (body.command.startsWith("role import ")) {
      const b = decodeRoleBundle(body.command.slice("role import ".length));
      const r = importRoleBundle(child, b as never, body.name);
      return Response.json({
        text: r.ok ? `Imported role "${r.role}".` : `Not imported: ${r.reason}.`,
      });
    }
    return Response.json({ text: `ran: ${body.command}` });
  };

  it("runs a command inside a running child as the caller, and seeds a role into it", async () => {
    out = [];
    // A stub source root inside the temp dir: create() checks for src/main.ts
    // and writes the child's data under it, never into the repository.
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "main.ts"), "");
    const manager = new WorldCollectiveManager(parent, dir);
    const cmd = worldCommand({ db: parent, manager: () => manager, getEntity: () => op, fetcher });
    await cmd.handler(ctx, input("world create trial1 empty | does scout-v2 beat scout?"));
    expect(out.join("\n")).toContain("Created child world trial1");
    const v = parent.listWorldVariants()[0]!;

    out = [];
    await cmd.handler(ctx, input("world run trial1 readiness"));
    expect(out.join("\n")).toContain("is draft; start it first");

    parent.updateWorldVariant(v.id, { status: "running", pid: null, lastError: null });
    out = [];
    await cmd.handler(ctx, input("world run trial1 benchmark list"));
    expect(out.join("\n")).toContain("ran: benchmark list");
    expect(sent.at(-1)).toMatchObject({
      url: `http://127.0.0.1:${v.ws_port}/api/command`,
      body: { name: "Operator", command: "benchmark list" },
    });

    out = [];
    await cmd.handler(ctx, input("world seed-role trial1 scout-v2"));
    expect(out.join("\n")).toContain('Imported role "scout-v2"');
    expect(child.getRole("scout-v2")).toBeDefined();
  });
});
