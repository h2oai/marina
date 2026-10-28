// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import {
  type CoverageInventory,
  coverageMatrix,
  fullyQualified,
} from "../scripts/capabilities/coverage";
import { inspectSources } from "../scripts/capabilities/source";

describe("mechanical capability inventory", () => {
  test("extracts code defaults without evaluating code or reading the host environment", () => {
    const result = inspectSources([
      {
        file: "src/example.ts",
        text: `
      // MARINA_COMMENT is not a setting.
      const enabled = process.env.MARINA_ENABLED !== "off";
      const count = Number(process.env.MARINA_COUNT ?? "12") || 7;
      const window = Number.parseInt(process.env["MARINA_WINDOW"] ?? "30", 10);
      const path = process.env.MARINA_PATH ?? applicationDefault();
      const computed = process.env[prefix + "_MODEL"];
    `,
      },
    ]);
    expect(result.environment.map((e) => e.name)).toEqual([
      "MARINA_COUNT",
      "MARINA_ENABLED",
      "MARINA_PATH",
      "MARINA_WINDOW",
    ]);
    const defaults = Object.fromEntries(
      result.environment.map((e) => [e.name, e.sites[0]!.absentEnvironment]),
    );
    expect(defaults.MARINA_COUNT).toEqual({ status: "local-expression-evaluated", value: 12 });
    expect(defaults.MARINA_ENABLED).toEqual({ status: "local-expression-evaluated", value: true });
    expect(defaults.MARINA_WINDOW).toEqual({ status: "local-expression-evaluated", value: 30 });
    expect(defaults.MARINA_PATH).toEqual({ status: "context-dependent" });
    expect(result.dynamicEnvironment).toHaveLength(1);
  });

  test("does not resolve mutable bindings, shadowed parameters or arbitrary env objects", () => {
    for (const text of [
      "let fallback=1; fallback=2; const x=process.env.MARINA_EXAMPLE ?? fallback;",
      "const fallback=1; function pick(fallback) { return process.env.MARINA_EXAMPLE ?? fallback; }",
      "const env={MARINA_EXAMPLE:23}; const x=env.MARINA_EXAMPLE ?? 10;",
      "function pick(process) { return process.env.MARINA_EXAMPLE ?? 10; }",
      'const Number=() => 77; const x=Number(process.env.MARINA_EXAMPLE ?? "4");',
    ]) {
      const reads = inspectSources([{ file: "src/example.ts", text }]).environment[0]!.sites.filter(
        (s) => s.role === "read",
      );
      expect(reads).toHaveLength(1);
      expect(reads[0]!.absentEnvironment).toEqual({ status: "context-dependent" });
    }
    const hex = inspectSources([
      { file: "src/example.ts", text: 'const x=parseInt(process.env.MARINA_EXAMPLE ?? "0x10");' },
    ]);
    expect(hex.environment[0]!.sites[0]!.absentEnvironment).toEqual({
      status: "local-expression-evaluated",
      value: 16,
    });
  });

  test("keeps room bindings and SQL readers visible and resolves aliased producer imports", () => {
    const result = inspectSources([
      {
        file: "src/outcomes/record.ts",
        text: "export function recordResolved(db, value) { return db.recordOutcomeRow(value); }",
      },
      {
        file: "src/producer.ts",
        text: `
        import { recordResolved as record } from "./outcomes/record";
        export function produce(db) { record(db, { kind: "task" }); }
        export const room = { commands: { check(ctx) { ctx.send("Usage: check <id>"); } } };
        export const bound = { commands: tool.commands };
        function query(db) { return db.query("SELECT * FROM outcomes"); }
      `,
      },
      {
        file: "src/unrelated.ts",
        text: "function record(db) { return db.get(); } function run(db) { record(db); }",
      },
    ]);
    expect(result.roomCommands.map((c) => c.name)).toEqual(["check"]);
    expect(result.roomCommandBindings).toHaveLength(1);
    expect(result.outcomes.sql).toHaveLength(1);
    expect(result.outcomes.reachableCandidates.map((c) => c.id)).toContain(
      "src/producer.ts#produce",
    );
    expect(result.outcomes.reachableCandidates.some((c) => c.file === "src/unrelated.ts")).toBe(
      false,
    );
  });

  test("includes every inventory section and never promotes help or no-op probes", () => {
    const site = { file: "src/example.ts", line: 1, expression: "fixture" };
    const inventory: CoverageInventory = {
      provenance: { commit: "fixture", sources: [] },
      commands: [
        {
          name: "example",
          aliases: ["ex"],
          help: "Example",
          category: "Other",
          minRank: 0,
          forms: [
            {
              syntax: "example",
              effect: "read",
              label: "Example",
              fields: [],
              groups: [],
              parts: [],
            },
          ],
        },
      ],
      ticks: { periodic: [{ name: "maintenance" }], everyTick: [site] },
      environment: [{ name: "MARINA_EXAMPLE" }],
      dynamicEnvironment: [site],
      features: [{ name: "Example" }],
      roomCommands: [{ ...site, name: "roomcmd" }],
      roomCommandBindings: [site],
      worldRooms: [
        { world: "example", room: "start", commands: [{ name: "roomcmd" }], onTick: "() => {}" },
      ],
      outcomes: {
        sites: [{ ...site, call: "recordResolved" }],
        imports: [site],
        sql: [site],
        routing: [{}],
        reachableCandidates: [{ id: "example#produce" }],
      },
    };
    const evidence = [
      { id: "help", status: "observed" as const, detail: "Help exists", commands: ["example"] },
    ];
    const coverage = coverageMatrix(inventory, evidence);
    expect(coverage).toHaveLength(16);
    expect(coverage.some((row) => row.status === "works")).toBe(false);
    expect(fullyQualified(coverage, evidence)).toBe(false);
    expect(
      fullyQualified(
        [{ id: "one", status: "works", reason: "ok" }],
        [{ id: "restart", status: "failed", detail: "failed" }],
      ),
    ).toBe(false);
    expect(fullyQualified([], [])).toBe(false);
    const mixed = coverageMatrix(inventory, [
      {
        id: "one-valid-case",
        status: "works",
        detail: "The default value worked",
        commands: ["example"],
      },
      {
        id: "broken-variant",
        status: "failed",
        detail: "An advertised variant failed",
        commands: ["example"],
      },
      {
        id: "alias-case",
        status: "works",
        detail: "Actual alias executed",
        capabilities: ["alias:example:ex"],
      },
    ]);
    expect(mixed.find((row) => row.id === "command:example:example")?.status).toBe("failed");
    expect(mixed.find((row) => row.id === "alias:example:ex")?.status).toBe("works");
    expect(mixed.find((row) => row.id === "environment:MARINA_EXAMPLE")?.status).toBe("untested");
  });
});
