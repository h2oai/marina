// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Read/write classification of ONE tool call, shared by the obligations ledger
 * and the argument check (passthru and agent loops alike).
 *
 * Most tools are classified by `toolEffect` (`tool-effect.ts`: declared hints,
 * name, description, schema). A generic
 * dispatcher is different: one tool whose arguments name the tool or action to
 * run and carry that tool's arguments (`{tool: "get_account", arguments: {…}}`,
 * `{action: "refund", params: "{…}"}`, `{agent_tool_name: …, arguments: …}`).
 * Classified by its own name, every dispatched lookup would count as a write.
 * Here such a call is classified by the INNER tool with the same rule, and
 * the argument check reads the inner arguments.
 *
 * The shape is detected from the arguments (and the tool's declared schema
 * when one is given), never from a product-specific tool name:
 *
 * - exactly two argument keys: a name key (`tool`, `tool_name`, `*_tool_name`,
 *   `action`, `name`, `function`, `method`, `operation`, `command`, …) whose
 *   value is an identifier, and an arguments key (`arguments`, `args`,
 *   `params`, `parameters`, `input`, `kwargs`, `payload`) whose value is an
 *   object or a JSON string holding one;
 * - when the tool declares its parameters, both keys are declared, and a name
 *   key with an `enum` must hold one of its values.
 *
 * Anything else (malformed inner arguments, an unknown name under an enum, a
 * third key) is not a dispatcher call: the call is classified as before, by
 * the outer tool. Only a write can become a read: an outer tool already
 * read-only (declared or by name) stays read-only.
 */

import { declaredProperties, declOf, type ToolEffectRole, toolEffect } from "./tool-effect";

/** Keys whose value names the dispatched tool or action. */
const NAME_KEY =
  /^(?:tool|tool_?name|tool_?id|action|action_name|name|function|function_name|method|operation|op|command)$|(?:^|_)tool_?name$/i;
/** Keys whose value carries the dispatched tool's arguments. */
const ARGS_KEY = /^(?:arguments|args|params|parameters|input|inputs|kwargs|payload)$/i;
/** A tool or action identifier (no spaces, ≤ 128 chars). */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.:/-]{0,127}$/;

/** The tool a dispatcher call runs, and its arguments. */
export interface DispatchedCall {
  /** The inner tool or action. */
  name: string;
  /** The inner arguments, parsed. */
  args: Record<string, unknown>;
  /** The argument keys the inner name and arguments sat under. */
  nameKey: string;
  argsKey: string;
}

function parseObject(v: unknown): Record<string, unknown> | undefined {
  let o = v;
  if (typeof o === "string") {
    const t = o.trim();
    if (!t.startsWith("{")) return undefined;
    try {
      o = JSON.parse(t) as unknown;
    } catch {
      return undefined;
    }
  }
  return o && typeof o === "object" && !Array.isArray(o)
    ? (o as Record<string, unknown>)
    : undefined;
}

/**
 * The inner tool and arguments when `name(args)` is a generic dispatcher call,
 * else undefined. `tools` (the declared tool list, any common shape) tightens
 * the check when present.
 */
export function dispatchedCall(
  name: string,
  args: unknown,
  tools?: readonly unknown[],
): DispatchedCall | undefined {
  const a = parseObject(args);
  if (!a) return undefined;
  const keys = Object.keys(a);
  if (keys.length !== 2) return undefined;
  const nameKey = keys.find((k) => NAME_KEY.test(k) && typeof a[k] === "string");
  const argsKey = keys.find((k) => k !== nameKey && ARGS_KEY.test(k));
  if (!nameKey || !argsKey) return undefined;
  const inner = (a[nameKey] as string).trim();
  if (!IDENTIFIER.test(inner) || inner === name) return undefined;
  const innerArgs = parseObject(a[argsKey]);
  if (!innerArgs) return undefined;
  const props = declaredProperties(declOf(name, tools));
  if (props) {
    if (!(nameKey in props) || !(argsKey in props)) return undefined;
    const allowed = (props[nameKey] as { enum?: unknown } | undefined)?.enum;
    if (Array.isArray(allowed) && !allowed.includes(inner)) return undefined;
  }
  return { name: inner, args: innerArgs, nameKey, argsKey };
}

/**
 * True when a call cannot change state. The outer tool decides first
 * (`toolEffect` in `role`, default `guard`): a read-only outer tool is
 * read-only. Otherwise a dispatcher call is read-only when its INNER tool is,
 * by the same rule (the inner tool is usually undeclared, so its name decides).
 */
export function readOnlyCall(
  name: string,
  args: unknown,
  opts: { tools?: readonly unknown[]; role?: ToolEffectRole } = {},
): boolean {
  const { tools, role = "guard" } = opts;
  if (toolEffect(name, tools, role).readOnly) return true;
  const inner = dispatchedCall(name, args, tools);
  return inner ? toolEffect(inner.name, tools, role).readOnly : false;
}
