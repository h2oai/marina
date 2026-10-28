// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { type Node, node, spelling } from "./source";

type Value = string | number | boolean | null | undefined;
type Result = { known: true; value: Value } | { known: false };
const unknown: Result = { known: false };
const known = (value: Value): Result => ({ known: true, value });

/** Evaluate only a small, pure expression language with all environment keys absent.
 * Never eval code, call application functions, or substitute a catalog example. */
export function absentEnvironmentValue(
  n: Node | undefined,
  shadowed = new Set<string>(),
  seen = new Set<Node>(),
): Result {
  if (!n || seen.has(n)) return unknown;
  const next = new Set([...seen, n]);
  const evaluate = (value: unknown) => absentEnvironmentValue(node(value), shadowed, next);
  if (["StringLiteral", "NumericLiteral", "BooleanLiteral"].includes(n.type))
    return known(n.value as Value);
  if (n.type === "NullLiteral") return known(null);
  if (n.type === "Identifier") {
    if (shadowed.has(String(n.name))) return unknown;
    if (n.name === "undefined") return known(undefined);
    if (n.name === "NaN") return known(Number.NaN);
    return unknown;
  }
  if (["TSAsExpression", "TSNonNullExpression", "ParenthesizedExpression"].includes(n.type))
    return evaluate(n.expression);
  if (/MemberExpression/.test(n.type)) {
    const object = node(n.object);
    const member = spelling(node(object?.property));
    const receiver = spelling(node(object?.object));
    if (member === "env" && ["process", "Bun"].includes(receiver ?? "") && !shadowed.has(receiver!))
      return known(undefined);
    if (n.optional) {
      const base = evaluate(n.object);
      if (base.known && base.value == null) return known(undefined);
    }
    return unknown;
  }
  if (n.type === "LogicalExpression") {
    const left = evaluate(n.left);
    if (!left.known) return unknown;
    if (n.operator === "??") return left.value == null ? evaluate(n.right) : left;
    if (n.operator === "||") return left.value ? left : evaluate(n.right);
    if (n.operator === "&&") return left.value ? evaluate(n.right) : left;
  }
  if (n.type === "ConditionalExpression") {
    const test = evaluate(n.test);
    return test.known ? evaluate(test.value ? n.consequent : n.alternate) : unknown;
  }
  if (n.type === "UnaryExpression") {
    const value = evaluate(n.argument);
    if (!value.known) return unknown;
    if (n.operator === "!") return known(!value.value);
    if (n.operator === "+") return known(Number(value.value));
    if (n.operator === "-") return known(-Number(value.value));
  }
  if (n.type === "BinaryExpression") {
    const a = evaluate(n.left);
    const b = evaluate(n.right);
    if (!a.known || !b.known) return unknown;
    if (
      [">", ">=", "<", "<="].includes(String(n.operator)) &&
      typeof a.value === "string" &&
      typeof b.value === "string"
    )
      return unknown;
    switch (n.operator) {
      case "===":
        return known(a.value === b.value);
      case "!==":
        return known(a.value !== b.value);
      case "*":
        return known(Number(a.value) * Number(b.value));
      case "/":
        return known(Number(a.value) / Number(b.value));
      case "-":
        return known(Number(a.value) - Number(b.value));
      case "+":
        return known(
          typeof a.value === "string" || typeof b.value === "string"
            ? `${a.value}${b.value}`
            : Number(a.value) + Number(b.value),
        );
      case ">":
        return known(Number(a.value) > Number(b.value));
      case ">=":
        return known(Number(a.value) >= Number(b.value));
      case "<":
        return known(Number(a.value) < Number(b.value));
      case "<=":
        return known(Number(a.value) <= Number(b.value));
    }
  }
  if (/CallExpression/.test(n.type)) {
    const callee = node(n.callee);
    if (callee && /MemberExpression/.test(callee.type) && callee.optional) {
      const receiver = evaluate(callee.object);
      if (receiver.known && receiver.value == null) return known(undefined);
    }
    const args = ((n.arguments as unknown[]) ?? []).map(evaluate);
    if (args.some((a) => !a.known)) return unknown;
    const values = args.map((a) => (a.known ? a.value : undefined));
    const name = spelling(callee);
    const object = spelling(node(callee?.object));
    const method = spelling(node(callee?.property));
    if ((name && shadowed.has(name)) || (object && shadowed.has(object))) return unknown;
    if (name === "Number") return known(values.length ? Number(values[0]) : 0);
    if (name === "String") return known(values.length ? String(values[0]) : "");
    if (name === "parseInt" || (object === "Number" && method === "parseInt"))
      return known(
        Number.parseInt(String(values[0]), values[1] === undefined ? undefined : Number(values[1])),
      );
    if (name === "parseFloat" || (object === "Number" && method === "parseFloat"))
      return known(Number.parseFloat(String(values[0])));
    if (object === "Number" && method === "isFinite") return known(Number.isFinite(values[0]));
    if (object === "Number" && method === "isInteger") return known(Number.isInteger(values[0]));
    if (object === "Math" && method === "max") return known(Math.max(...values.map(Number)));
    if (object === "Math" && method === "min") return known(Math.min(...values.map(Number)));
    if (callee && /MemberExpression/.test(callee.type)) {
      const receiver = evaluate(callee.object);
      if (receiver.known && typeof receiver.value === "string") {
        if (method === "trim") return known(receiver.value.trim());
        if (method === "toLowerCase") return known(receiver.value.toLowerCase());
      }
    }
  }
  return unknown;
}

export function displayDefault(result: Result) {
  if (!result.known) return { status: "context-dependent" as const };
  const value = result.value;
  return {
    status: "local-expression-evaluated" as const,
    value:
      value === undefined
        ? "<unset>"
        : typeof value === "number" && !Number.isFinite(value)
          ? String(value)
          : value,
  };
}
