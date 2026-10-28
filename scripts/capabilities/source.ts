// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { dirname, posix } from "node:path";
import { parse } from "@babel/parser";
import { absentEnvironmentValue, displayDefault } from "./defaults";

/** Small structural AST view; no dependency on the parser's transitive packages. */
export interface Node {
  type: string;
  start: number;
  end: number;
  loc?: { start: { line: number; column: number } };
  [key: string]: unknown;
}

export function node(value: unknown): Node | undefined {
  return value && typeof value === "object" && "type" in value ? (value as Node) : undefined;
}

export function walk(root: Node, visit: (n: Node, parents: Node[]) => void, parents: Node[] = []) {
  visit(root, parents);
  for (const [key, value] of Object.entries(root)) {
    if (
      [
        "loc",
        "comments",
        "tokens",
        "leadingComments",
        "trailingComments",
        "innerComments",
      ].includes(key)
    )
      continue;
    for (const child of Array.isArray(value) ? value : [value]) {
      const n = node(child);
      if (n) walk(n, visit, [...parents, root]);
    }
  }
}

export const spelling = (n: Node | undefined): string | undefined =>
  typeof n?.name === "string" ? n.name : typeof n?.value === "string" ? n.value : undefined;

function bindingNames(n: Node | undefined): string[] {
  if (!n) return [];
  if (n.type === "Identifier") return [String(n.name)];
  if (n.type === "AssignmentPattern") return bindingNames(node(n.left));
  if (n.type === "RestElement") return bindingNames(node(n.argument));
  if (n.type === "ArrayPattern")
    return ((n.elements as unknown[]) ?? []).flatMap((e) => bindingNames(node(e)));
  if (n.type === "ObjectPattern")
    return ((n.properties as unknown[]) ?? []).flatMap((p) => {
      const property = node(p);
      return bindingNames(node(property?.value ?? property?.argument));
    });
  return [];
}

export interface Site {
  file: string;
  line: number;
  expression: string;
}

export interface SourceFile {
  file: string;
  text: string;
}

export function inspectSources(files: SourceFile[]) {
  const environment = new Map<
    string,
    Array<
      Site & {
        role: string;
        defaultContext: string;
        absentEnvironment: ReturnType<typeof displayDefault>;
        fallbackExpressions: string[];
      }
    >
  >();
  const dynamicEnvironment: Array<Site & { defaultContext: string }> = [];
  const roomCommands: Array<Site & { name: string; usage: string[] }> = [];
  const roomCommandBindings: Site[] = [];
  const outcomeSites: Array<Site & { call: string; enclosing: string; role: string }> = [];
  const functions = new Map<string, { file: string; name: string; calls: Set<string> }>();
  const outcomeImports: Site[] = [];
  const outcomeSql: Site[] = [];
  const kinds: string[] = [];
  const everyTick: Site[] = [];
  const readMethods = new Set([
    "getOutcome",
    "getOutcomeBySubject",
    "listOutcomes",
    "pendingOutcomes",
    "outcomeDeliveries",
    "outcomeDeliveryCounts",
  ]);
  const writeMethods = new Set(["recordOutcomeRow", "setOutcomeDelivery"]);
  for (const { file, text } of files) {
    if (!/\.[cm]?[jt]sx?$/.test(file)) {
      // Preserve non-JS code and deployment expressions verbatim; do not mistake
      // shell/Python syntax for JavaScript or infer values from documentation.
      for (const [index, line] of text.split("\n").entries()) {
        if (/^\s*(#|\/\/)/.test(line)) continue;
        for (const name of new Set(line.match(/\bMARINA_[A-Z0-9_]+\b/g) ?? [])) {
          const sites = environment.get(name) ?? [];
          sites.push({
            file,
            line: index + 1,
            expression: line,
            role: "non-js-source",
            defaultContext: line,
            absentEnvironment: { status: "context-dependent" },
            fallbackExpressions: [line],
          });
          environment.set(name, sites);
        }
      }
      continue;
    }
    const ast = parse(text, {
      sourceType: "unambiguous",
      plugins: ["typescript", ...(file.endsWith("tsx") ? ["jsx" as const] : [])],
    }) as unknown as Node;
    const slice = (n: Node) => text.slice(n.start, n.end);
    const site = (n: Node): Site => ({ file, line: n.loc?.start.line ?? 1, expression: slice(n) });
    const imports = new Map<string, string>();
    const shadowed = new Set<string>();
    walk(ast, (n) => {
      if (n.type === "ImportDeclaration") {
        const from = String(node(n.source)?.value ?? "");
        if (/outcomes\/|db-outcomes|learning\/outcomes/.test(from)) outcomeImports.push(site(n));
        if (!from.startsWith(".")) return;
        const base = posix.normalize(posix.join(dirname(file), from)).replace(/\.js$/, "");
        const target =
          files.find((f) => f.file === `${base}.ts` || f.file === `${base}/index.ts`)?.file ?? base;
        for (const value of (n.specifiers as unknown[]) ?? []) {
          const spec = node(value)!;
          const local = spelling(node(spec.local));
          const imported = spelling(node(spec.imported));
          if (local && imported) imports.set(local, `${target}#${imported}`);
        }
      }
      if (n.type === "VariableDeclarator" || n.type === "FunctionDeclaration") {
        for (const name of bindingNames(node(n.id))) shadowed.add(name);
      }
      if (
        ["ImportSpecifier", "ImportDefaultSpecifier", "ImportNamespaceSpecifier"].includes(n.type)
      ) {
        const name = spelling(node(n.local));
        if (name) shadowed.add(name);
      }
      for (const parameter of (n.params as unknown[]) ?? []) {
        for (const name of bindingNames(node(parameter))) shadowed.add(name);
      }
      if (n.type === "AssignmentExpression" || n.type === "UpdateExpression") {
        const name = spelling(node(n.left ?? n.argument));
        if (name) shadowed.add(name);
      }
      if (
        ["StringLiteral", "TemplateLiteral"].includes(n.type) &&
        /\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:outcomes|outcome_deliveries)\b/i.test(slice(n))
      )
        outcomeSql.push(site(n));
    });
    const functionName = (n: Node, parents: Node[]) =>
      spelling(node(n.id)) ??
      spelling(node(n.key)) ??
      spelling(node(parents.at(-1)?.id)) ??
      `<callback:${n.loc?.start.line}>`;
    const isFunction = (n: Node) => /Function|Method/.test(n.type) && !!node(n.body);
    walk(ast, (n, parents) => {
      const parent = parents.at(-1);
      const enclosing = parents.findLast(isFunction);
      const owner = enclosing
        ? functionName(enclosing, parents.slice(0, parents.indexOf(enclosing)))
        : "<module>";
      const names = new Set<string>();
      // All literal/identifier references are retained, including helper-name tables.
      // Documentation comments never enter this walk. Unresolved computed reads remain visible.
      if (["StringLiteral", "Identifier"].includes(n.type)) {
        const value = spelling(n);
        if (value && /^MARINA_[A-Z0-9_]+$/.test(value)) names.add(value);
      }
      for (const name of names) {
        const context =
          [...parents]
            .reverse()
            .find((p) => /Statement$|VariableDeclarator|ObjectProperty/.test(p.type)) ??
          parent ??
          n;
        const propertyRead =
          parent && /MemberExpression/.test(parent.type) && parent.property === n;
        const helperRead =
          parent?.type === "CallExpression" && (parent.arguments as unknown[])?.includes(n);
        const role = propertyRead
          ? parents.at(-2)?.type === "AssignmentExpression" && parents.at(-2)?.left === parent
            ? "write"
            : "read"
          : helperRead
            ? "helper-argument"
            : "name-reference";
        const rows = environment.get(name) ?? [];
        const expression =
          context.type === "VariableDeclarator"
            ? node(context.init)
            : context.type === "ReturnStatement"
              ? node(context.argument)
              : context;
        const fallbackExpressions = parents
          .filter(
            (p) =>
              p.type === "ConditionalExpression" ||
              (p.type === "LogicalExpression" && ["??", "||"].includes(String(p.operator))),
          )
          .map(slice);
        rows.push({
          ...site(context),
          role,
          defaultContext: enclosing ? slice(enclosing) : slice(context),
          absentEnvironment: displayDefault(absentEnvironmentValue(expression, shadowed)),
          fallbackExpressions,
        });
        environment.set(name, rows);
      }
      if (
        /MemberExpression/.test(n.type) &&
        n.computed &&
        /^(process\.env|Bun\.env|env)$/.test(slice(node(n.object)!)) &&
        node(n.property)?.type !== "StringLiteral"
      )
        dynamicEnvironment.push({
          ...site(n),
          defaultContext: enclosing ? slice(enclosing) : slice(n),
        });
      if (
        (n.type === "ObjectProperty" || n.type === "ObjectMethod") &&
        spelling(node(n.key)) === "commands"
      ) {
        const value = node(n.value);
        if (value?.type === "ObjectExpression") {
          for (const raw of (value.properties as unknown[]) ?? []) {
            const entry = node(raw)!;
            const name = spelling(node(entry.key));
            if (!name) {
              roomCommandBindings.push(site(entry));
              continue;
            }
            const usage: string[] = [];
            walk(entry, (child) => {
              if (child.type === "StringLiteral" && /usage:/i.test(String(child.value)))
                usage.push(String(child.value));
            });
            roomCommands.push({ ...site(entry), name, usage });
          }
        } else if (value && !["ArrayExpression", "StringLiteral"].includes(value.type))
          roomCommandBindings.push(site(n));
      }
      if (
        file === "src/engine/engine.ts" &&
        n.type === "ClassMethod" &&
        spelling(node(n.key)) === "tickInner"
      ) {
        const body = node(n.body);
        for (const statement of (body?.body as unknown[]) ?? [])
          everyTick.push(site(node(statement)!));
      }
      if (
        file === "src/persistence/db-outcomes.ts" &&
        n.type === "TSTypeAliasDeclaration" &&
        spelling(node(n.id)) === "OutcomeKind"
      ) {
        walk(n, (child) => {
          if (child.type === "StringLiteral") kinds.push(String(child.value));
        });
      }
      if (n.type !== "CallExpression" && n.type !== "OptionalCallExpression") return;
      const callee = node(n.callee);
      const call = spelling(callee) ?? spelling(node(callee?.property));
      if (!call) return;
      const key = `${file}#${owner}`;
      const fn = functions.get(key) ?? { file, name: owner, calls: new Set<string>() };
      if (writeMethods.has(call) || readMethods.has(call)) fn.calls.add(`ledger#${call}`);
      else if (callee?.type === "Identifier") fn.calls.add(imports.get(call) ?? `${file}#${call}`);
      functions.set(key, fn);
      const role =
        writeMethods.has(call) || call === "recordResolved"
          ? "producer"
          : readMethods.has(call)
            ? "consumer"
            : undefined;
      if (role) outcomeSites.push({ ...site(n), call, enclosing: owner, role });
    });
  }
  // Module-qualified imports avoid confusing unrelated methods named `run`/`get`.
  // This remains static candidate reachability, never proof of runtime delivery.
  const reached = new Set([...writeMethods, ...readMethods].map((name) => `ledger#${name}`));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [key, fn] of functions) {
      if (!reached.has(key) && [...fn.calls].some((call) => reached.has(call))) {
        reached.add(key);
        changed = true;
      }
    }
  }
  return {
    environment: [...environment]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, sites]) => ({ name, sites })),
    dynamicEnvironment,
    roomCommands,
    roomCommandBindings,
    everyTick,
    outcomes: {
      kinds,
      sites: outcomeSites,
      imports: outcomeImports,
      sql: outcomeSql,
      reachableCandidates: [...functions]
        .filter(([key]) => reached.has(key))
        .map(([id, f]) => ({ id, ...f, calls: [...f.calls].filter((c) => reached.has(c)) })),
      analysis:
        "Direct ledger calls, raw ledger SQL, outcome-module imports and module-qualified transitive candidates. Dynamic dispatch and re-exports require review; candidates are not a complete semantic call graph.",
    },
  };
}
