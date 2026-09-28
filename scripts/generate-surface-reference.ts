// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parse } from "@babel/parser";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RateLimiter } from "../src/auth/rate-limiter";
import { commandManifest } from "../src/engine/command-manifest";
import type { Engine } from "../src/engine/engine";
import { createWorldMcpServer } from "../src/net/mcp-world-tools";

const root = resolve(import.meta.dir, "..");
const inline = (text: string) =>
  `\`${text.replaceAll("`", "'").replaceAll("|", "&#124;").replace(/\s+/g, " ")}\``;
interface Node {
  type: string;
  start?: number | null;
  end?: number | null;
  loc?: { start: { line: number } } | null;
  [key: string]: unknown;
}
function walk(node: unknown, visit: (node: Node, parents: Node[]) => void, parents: Node[] = []) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, parents);
    return;
  }
  const value = node as Node;
  if (typeof value.type !== "string") return;
  visit(value, parents);
  for (const [key, child] of Object.entries(value))
    if (!["loc", "comments", "tokens"].includes(key)) walk(child, visit, [...parents, value]);
}
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}

/** Dispatch selectors are extracted as syntax, not guessed OpenAPI schemas.
 * Preserve regexes and method guards verbatim, including delegated/wildcard routes. */
export function httpDispatchReference(source: string) {
  const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
  const text = (node: Node) => source.slice(node.start ?? 0, node.end ?? 0);
  const entries: { selector: string; line: number; guards: string[]; fields: string[] }[] = [];
  const routeTarget = (node: unknown): boolean => {
    const value = node as Node | undefined;
    if (!value) return false;
    if (value.type === "Identifier")
      return ["path", "pathname", "rest"].includes(String(value.name));
    return value.type === "MemberExpression" && (value.property as Node)?.name === "pathname";
  };
  walk(ast, (node, parents) => {
    const isComparison =
      node.type === "BinaryExpression" &&
      ["===", "=="].includes(String(node.operator)) &&
      routeTarget(node.left) &&
      ["StringLiteral", "TemplateLiteral", "Identifier"].includes((node.right as Node)?.type);
    const callee = node.callee as Node | undefined;
    const isSelector =
      node.type === "CallExpression" &&
      callee?.type === "MemberExpression" &&
      routeTarget(callee.object) &&
      ["match", "startsWith", "endsWith", "split"].includes(
        String((callee.property as Node)?.name),
      );
    if (!isComparison && !isSelector) return;
    const enclosing =
      [...parents]
        .reverse()
        .find((p) => p.type === "IfStatement" || p.type === "VariableDeclaration") ?? node;
    const block = [...parents].reverse().find((p) => p.type === "BlockStatement");
    const guards = parents.filter((p) => p.type === "IfStatement").map((p) => text(p.test as Node));
    // A selector assigned to a match variable is usually consumed by the following if.
    const declaration = [...parents].reverse().find((p) => p.type === "VariableDeclarator");
    const matchName = (declaration?.id as Node | undefined)?.name;
    let target = enclosing;
    if (block && matchName) {
      const following = (block.body as Node[]).find(
        (p) =>
          p.type === "IfStatement" &&
          (p.start ?? 0) > (node.end ?? 0) &&
          text(p.test as Node).match(new RegExp(`\\b${matchName}\\b`)),
      );
      if (following) {
        target = following;
        guards.push(text(following.test as Node));
      }
    }
    const methodGuards: string[] = [];
    const fields = new Set<string>();
    walk(target, (child) => {
      if (
        child.type === "BinaryExpression" &&
        /\b(?:method|req\.method)\s*[!=]==?\s*["'](?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)["']/.test(
          text(child),
        )
      )
        methodGuards.push(text(child));
      if (
        child.type === "MemberExpression" &&
        ["body", "input"].includes(String((child.object as Node)?.name)) &&
        (child.property as Node)?.type === "Identifier"
      )
        fields.add(String((child.property as Node).name));
      if (
        child.type === "CallExpression" &&
        /searchParams\.(?:get|getAll|has)\(["']/.test(text(child))
      )
        fields.add(text(child));
    });
    // Include leading method guards such as `if (method !== "GET") return undefined`.
    const fn = [...parents].reverse().find((p) => /Function/.test(p.type));
    const body = (fn?.body as Node | undefined)?.body as Node[] | undefined;
    for (const statement of body ?? []) {
      if ((statement.start ?? 0) >= (node.start ?? 0)) break;
      if (
        statement.type === "IfStatement" &&
        /\bmethod\b/.test(text(statement.test as Node)) &&
        (statement.consequent as Node)?.type === "ReturnStatement"
      )
        methodGuards.push(text(statement.test as Node));
    }
    entries.push({
      selector: text(node),
      line: node.loc?.start.line ?? 1,
      guards: [...new Set([...guards, ...methodGuards])],
      fields: [...fields].sort(),
    });
  });
  return entries;
}

export async function generateSurfaceReference(engine: Engine, check: boolean) {
  const output = (name: string, content: string) => {
    const path = join(root, "docs/reference", `${name}.md`);
    if (check) {
      if (readFileSync(path, "utf8") !== content)
        throw new Error(`${name} reference is stale; run bun run docs:api`);
    } else {
      mkdirSync(join(root, "docs/reference"), { recursive: true });
      writeFileSync(path, content);
    }
  };
  const server = createWorldMcpServer(engine, new Map(), new RateLimiter());
  const client = new Client({ name: "marina-reference", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const toolReference: { name: string; description?: string; inputSchema: unknown }[] = [];
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    toolReference.push(...tools);
    const lines = [
      "# MCP tool API reference",
      "",
      "Generated from the actual in-process MCP `tools/list` response by `bun run docs:api`.",
      "",
      "The world MCP endpoint is `/mcp`. Initialize a transport, then use `login` or `auth` to bind",
      "a resident. Transport authentication alone grants no world identity. Execution retains",
      "rank, gate, space ACL and rate limits. No credential is embedded in this reference.",
      "",
      "`capabilities` and `invoke` expose the live command forms; `expose` can additionally install",
      "up to twelve selected tools per session. Those deployment-dependent tools are intentionally",
      "absent here. Named compatibility tools retain their established payloads. See",
      "[commands](commands.md), [SDK types](sdk.md) and [protocol checklist](../guides/adding-a-protocol.md).",
      "",
    ];
    for (const tool of tools.sort((a, b) => a.name.localeCompare(b.name)))
      lines.push(
        `## ${tool.name}`,
        "",
        tool.description ?? "",
        "",
        "```json",
        JSON.stringify(tool.inputSchema, null, 2),
        "```",
        "",
      );
    output("mcp", `${lines.join("\n").trimEnd()}\n`);
    if (!check) {
      mkdirSync(join(root, "dist/reference"), { recursive: true });
      writeFileSync(join(root, "dist/reference/mcp.json"), JSON.stringify({ tools }, null, 2));
    }
  } finally {
    await client.close();
    await server.close();
  }

  const compiler = Bun.spawn([process.execPath, "run", "build:sdk"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await compiler.exited) throw new Error("SDK declaration build failed");
  const declarations = join(root, "src/sdk/dist");
  const modules = new Map<string, string>();
  const visit = (name: string) => {
    if (modules.has(name)) return;
    const declaration = readFileSync(join(declarations, `${name}.d.ts`), "utf8");
    modules.set(name, declaration);
    for (const match of declaration.matchAll(/(?:from\s*|import\s*\()["']\.\/([^"']+)\.js["']/g))
      visit(match[1]!);
  };
  for (const name of ["index", "memory", "routing-client"]) visit(name);
  const sdk = [
    "# SDK API reference",
    "",
    "Generated from the TypeScript compiler's published declarations by `bun run docs:api`.",
    "",
    "Entry points: `@marina/agent-sdk`, `@marina/agent-sdk/memory`, `@marina/agent-sdk/routing`.",
    "Only declarations reachable from these entry points are included. Private implementation",
    "bodies are omitted by the compiler. This reference includes request/response types, method",
    "signatures and their source documentation. Use the package exports rather than importing",
    "individual declaration modules as undocumented package subpaths.",
    "",
    "See [HTTP dispatch](http.md), [MCP tools](mcp.md), [builtin commands](commands.md),",
    "and the [SDK quickstart](../../src/sdk/README.md).",
    "",
  ];
  for (const [name, declaration] of [...modules].sort(([a], [b]) => a.localeCompare(b)))
    sdk.push(
      `## ${name}`,
      "",
      `[Source](../../src/sdk/${name}.ts)`,
      "",
      "```typescript",
      declaration.trim(),
      "```",
      "",
    );
  output("sdk", `${sdk.join("\n").trimEnd()}\n`);

  const http = [
    "# HTTP dispatch reference",
    "",
    "Generated from the TypeScript syntax tree of every network adapter by `bun run docs:api`.",
    "",
    "This indexes exact route selectors and method tests, including regex captures and delegated",
    "prefixes. Guards are source predicates: a negative guard can reject a method. Prefix selectors",
    "can delegate to another adapter; they are not promises that every suffix is served. `rest`",
    "in the memory adapter is the suffix after `/v1/memory/spaces/{space_id}/`. Captures and dynamic",
    "subroutes retain their source spelling rather than inventing parameter names or response schemas.",
    "",
    "Typed public client request/response contracts are in the [SDK reference](sdk.md). The",
    "[security architecture](../architecture/security.md) explains authentication: world dashboard",
    "routes require resident/session authority with operator-only restrictions; durable memory uses",
    "scoped credentials and space ACLs; the model API uses its configured keys. Public health/connect",
    "routes do not grant authority. A listed route never bypasses its handler's permission checks.",
    "",
    "Field lists are syntax-derived accesses, not declarations of required fields. Follow the source",
    "link for validation, HTTP statuses, streaming and deployment-specific availability.",
    "",
  ];
  let count = 0;
  const httpReference: (ReturnType<typeof httpDispatchReference>[number] & { source: string })[] =
    [];
  for (const path of files(join(root, "src/net"))
    .filter((path) => path.endsWith(".ts"))
    .sort()) {
    const entries = httpDispatchReference(readFileSync(path, "utf8"));
    httpReference.push(...entries.map((entry) => ({ ...entry, source: relative(root, path) })));
    if (!entries.length) continue;
    http.push(`## ${relative(root, path)}`, "");
    for (const entry of entries) {
      count++;
      http.push(
        `### ${inline(entry.selector)}`,
        "",
        `[Source](../../${relative(root, path)}#L${entry.line})`,
        "",
      );
      if (entry.guards.length)
        http.push(...entry.guards.map((guard) => `- Guard: ${inline(guard)}`), "");
      if (entry.fields.length)
        http.push(`Fields read here: ${entry.fields.map(inline).join(", ")}.`, "");
    }
  }
  output("http", `${http.join("\n").trimEnd()}\n`);
  const explorer = `${JSON.stringify({
    schema: "marina.api.reference.v1",
    commands: commandManifest(engine.commands),
    mcp: toolReference,
    http: httpReference,
    sdk: [...modules]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, declaration]) => ({ name, declaration })),
  })}\n`;
  const explorerPath = join(root, "docs/reference/api.json");
  if (check) {
    if (readFileSync(explorerPath, "utf8") !== explorer)
      throw new Error("API explorer data is stale; run bun run docs:api");
  } else writeFileSync(explorerPath, explorer);
  console.log(
    `API reference ${check ? "verified" : "generated"}: MCP tools, ${modules.size} SDK declaration modules, ${count} HTTP dispatch selectors.`,
  );
}
