// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import fc from "fast-check";
import { CommandCoordinator } from "../src/engine/command-coordinator";
import { mcpAdmission } from "../src/net/mcp/mcp-admission";
import { cmdTool } from "../src/net/mcp/mcp-session";
import type { McpSession } from "../src/net/mcp/mcp-types";
import { entityId } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { propertyOptions } from "./property-options";

test("generated async schedules retain per-resident FIFO through handler failures", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.scheduler(),
      fc.array(
        fc.record({
          resident: fc.integer({ min: 0, max: 3 }),
          fails: fc.boolean(),
        }),
        { minLength: 1, maxLength: 40 },
      ),
      async (scheduler, actions) => {
        const active = new Set<string>();
        const started = new Map<string, number[]>();
        const completed = new Map<string, number[]>();
        const errors: unknown[] = [];
        const coordinator = new CommandCoordinator(
          async (resident, raw) => {
            expect(active.has(resident)).toBe(false);
            active.add(resident);
            const index = Number(raw);
            started.set(resident, [...(started.get(resident) ?? []), index]);
            try {
              await scheduler.schedule(Promise.resolve(), `${resident}:${index}`);
              if (actions[index]!.fails) throw new Error(`fixture ${index}`);
            } finally {
              completed.set(resident, [...(completed.get(resident) ?? []), index]);
              active.delete(resident);
            }
          },
          (error) => {
            errors.push(error);
          },
        );
        actions.forEach((action, index) => {
          expect(coordinator.enqueue(entityId(String(action.resident)), String(index))).toBe(true);
        });
        await scheduler.waitFor(coordinator.drain());
        for (let resident = 0; resident < 4; resident++) {
          const expected = actions.flatMap((action, index) =>
            action.resident === resident ? [index] : [],
          );
          expect(started.get(String(resident)) ?? []).toEqual(expected);
          expect(completed.get(String(resident)) ?? []).toEqual(expected);
        }
        expect(errors).toHaveLength(actions.filter((action) => action.fails).length);
        expect(active.size).toBe(0);
        expect(coordinator.snapshot().pending).toBe(0);
      },
    ),
    propertyOptions(),
  );
});

test("generated MCP cancellations skip queued work but preserve started writes and session order", async () => {
  // One world for every generated run: what the property varies is the MCP
  // sessions, their queues and cancellations, and each run gets fresh ones
  // (new residents, sessions and controllers). Building a world per run cost a
  // fresh database each time (baseline plus every later migration: ~0.15 s idle,
  // ~1 s on a loaded machine) and put 25+ of them inside one test's budget.
  const world = createTestEngine();
  /** The running run's state, found by the resident a command arrives for. */
  let current:
    | {
        scheduler: fc.Scheduler;
        residents: Map<string, number>;
        entered: PromiseWithResolvers<void>[];
        started: string[][];
        committed: string[][];
      }
    | undefined;
  world.engine.commands.registerOwned("fixture", {
    name: "mark",
    help: "Fixture",
    async handler(_ctx, input) {
      const run = current!;
      const index = run.residents.get(input.entity)!;
      run.started[index]!.push(input.args);
      run.entered[index]!.resolve();
      await run.scheduler.schedule(Promise.resolve(), `${index}:${input.args}`);
      run.committed[index]!.push(input.args);
    },
  });
  let runs = 0;
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.array(
          fc.record({
            resident: fc.integer({ min: 0, max: 1 }),
            cancel: fc.boolean(),
          }),
          { maxLength: 10 },
        ),
        async (scheduler, actions) => {
          const run = ++runs;
          const sessions = new Map<string, McpSession>();
          const connections: string[] = [];
          const residents = new Map<string, number>();
          const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
          const started: string[][] = [[], []];
          const committed: string[][] = [[], []];
          const active = [new AbortController(), new AbortController()];
          for (let index = 0; index < 2; index++) {
            const { entityId, connection } = world.login(`Run${run}R${index}`);
            connections.push(connection.id);
            residents.set(entityId, index);
            sessions.set(String(index), {
              connId: connection.id,
              entityId,
              throttleKey: `fixture-${run}-${index}`,
              perceptionBuffer: [],
              commandTail: Promise.resolve(),
              mcp: new McpServer({ name: "property", version: "1" }),
              transport: new WebStandardStreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
              }),
            });
          }
          current = { scheduler, residents, entered, started, committed };
          try {
            const heads = active.map((controller, index) =>
              cmdTool(
                world.engine,
                sessions,
                { sessionId: String(index), signal: controller.signal },
                "/mark head",
              ),
            );
            await Promise.all(entered.map((item) => item.promise));
            active.forEach((controller) => {
              controller.abort();
            });
            const pending = actions.map((action, index) => {
              const controller = new AbortController();
              const result = cmdTool(
                world.engine,
                sessions,
                { sessionId: String(action.resident), signal: controller.signal },
                `/mark ${index}`,
              );
              if (action.cancel) controller.abort();
              return result;
            });
            const results = await scheduler.waitFor(Promise.all([...heads, ...pending]));
            for (let resident = 0; resident < 2; resident++) {
              const expected = [
                "head",
                ...actions.flatMap((action, index) =>
                  action.resident === resident && !action.cancel ? [String(index)] : [],
                ),
              ];
              expect(started[resident]).toEqual(expected);
              expect(committed[resident]).toEqual(expected);
            }
            actions.forEach((action, index) => {
              expect(!!results[index + 2]!.isError).toBe(action.cancel);
            });
            expect(mcpAdmission(world.engine).snapshot().pending).toBe(0);
          } finally {
            await scheduler.waitAll();
            await Promise.all(
              [...sessions.values()].map(async (session) => {
                await session.commandTail;
                await session.mcp.close();
              }),
            );
            // Nothing from this run may still be queued when the next one starts.
            await world.engine.drainCommands();
            for (const id of connections) world.engine.removeConnection(id, "explicit");
            current = undefined;
          }
        },
      ),
      propertyOptions(25),
    );
  } finally {
    await world.dispose();
  }
});
