// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import fc from "fast-check";
import { CommandCoordinator } from "../src/engine/command-coordinator";
import { mcpAdmission } from "../src/net/mcp-admission";
import { cmdTool } from "../src/net/mcp-session";
import type { McpSession } from "../src/net/mcp-types";
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
        const world = createTestEngine();
        const sessions = new Map<string, McpSession>();
        const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
        const started: string[][] = [[], []];
        const committed: string[][] = [[], []];
        const active = [new AbortController(), new AbortController()];
        for (let index = 0; index < 2; index++) {
          const { entityId, connection } = world.login(`Resident${index}`);
          sessions.set(String(index), {
            connId: connection.id,
            entityId,
            throttleKey: `fixture-${index}`,
            perceptionBuffer: [],
            commandTail: Promise.resolve(),
            mcp: new McpServer({ name: "property", version: "1" }),
            transport: new WebStandardStreamableHTTPServerTransport({
              sessionIdGenerator: undefined,
            }),
          });
        }
        world.engine.commands.registerOwned("fixture", {
          name: "mark",
          help: "Fixture",
          async handler(_ctx, input) {
            const index = Number(world.engine.entities.get(input.entity)!.name.slice(-1));
            started[index]!.push(input.args);
            entered[index]!.resolve();
            await scheduler.schedule(Promise.resolve(), `${index}:${input.args}`);
            committed[index]!.push(input.args);
          },
        });
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
          await world.dispose();
        }
      },
    ),
    propertyOptions(25),
  );
});
