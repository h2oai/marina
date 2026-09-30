// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { CALC_BLOCKED_FUNCTIONS, calcCommand, evalExpression } from "../src/engine/commands/calc";
import type { Entity, EntityId, RoomContext } from "../src/types";
import { stripAnsi } from "./helpers";

async function runCalc(args: string): Promise<string> {
  const sent: string[] = [];
  const entity = { id: "e_1", name: "tester" } as unknown as Entity;
  const cmd = calcCommand({ getEntity: () => entity });
  const ctx = { send: (_id: string, msg: string) => sent.push(msg) } as unknown as RoomContext;
  await cmd.handler(ctx, {
    entity: "e_1" as EntityId,
    verb: "calc",
    args,
    tokens: args.split(/\s+/),
    raw: `calc ${args}`,
  } as never);
  return stripAnsi(sent.join("\n"));
}

describe("calc", () => {
  test("regression: calc 17*23 evaluates", async () => {
    const out = await runCalc("17*23");
    expect(out).toContain("391");
    expect(out).not.toContain("error");
  });

  test("arithmetic, variables and multi-statement input share one scope", () => {
    expect(evalExpression("42 * 1729")).toMatchObject({ outputs: ["72618"], error: undefined });
    expect(evalExpression("gcd(360, 420)").outputs).toEqual(["60"]);
    const multi = evalExpression("x = 5; y = x^2 + 3*x; y");
    expect(multi.error).toBeUndefined();
    expect(multi.outputs.at(-1)).toBe("40");
    expect(evalExpression("a = 2\nb = a * 21\nb").outputs.at(-1)).toBe("42");
    expect(evalExpression("mean([1,2,3,4,5])").outputs).toEqual(["3"]);
  });

  test("simplify and derivative still work (they parse internally)", () => {
    expect(evalExpression("derivative('sin(x)', 'x')").outputs).toEqual(["cos(x)"]);
    expect(evalExpression("simplify('x*2 + 3*x')").outputs).toEqual(["5 * x"]);
  });

  test.each([
    ["evaluate('1+1')", "evaluate"],
    ["parse('1')", "parse"],
    ["compile('1')", "compile"],
    ["parser()", "parser"],
    ["import({pi: 3}, {override: true})", "import"],
    ["createUnit('zz')", "createUnit"],
    ["config({number: 'number'})", "config"],
  ])("refuses %s named inside an expression", (expr, name) => {
    const result = evalExpression(expr);
    expect(result.error).toBe(`${name} disabled`);
  });

  test("every blocked name is refused, including inside a user function", () => {
    for (const name of CALC_BLOCKED_FUNCTIONS) {
      expect(evalExpression(`${name}('1')`).error).toBe(`${name} disabled`);
    }
    const fn = evalExpression("f(x) = evaluate('2'); f(1)");
    expect(fn.error).toBe("evaluate disabled");
  });

  test("node methods cannot mutate the shared instance", () => {
    const viaNode = evalExpression(`simplify("evaluate('createUnit(\\"zz\\")')").evaluate()`);
    expect(viaNode.error).toBe("createUnit disabled");
    // The instance is unchanged for the next caller.
    expect(evalExpression("1/4").outputs).toEqual(["0.25"]);
  });
});
