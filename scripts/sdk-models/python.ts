// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// The Python SDK's typed HTTP models and methods (sdks/python/src/marina/models.py), rendered
// from the OpenAPI document: a TypedDict per object schema, a type alias per union or enum, and
// one class per tag whose methods are the tag's operations with typed bodies and replies.
// Standard library only, Python 3.10+: every field annotation is a string, so models may refer
// to each other in any order and `NotRequired` is read only by type checkers.

/** A JSON Schema object as the OpenAPI document writes it. */
type Schema = Record<string, unknown>;

interface Parameter {
  name: string;
  in: string;
  required?: boolean;
  schema?: Schema;
  $ref?: string;
}

interface OperationObject {
  operationId: string;
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: Parameter[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, { content?: Record<string, { schema?: Schema }>; $ref?: string }>;
}

const KEYWORDS = new Set(
  (
    "False None True and as assert async await break class continue def del elif else except " +
    "finally for from global if import in is lambda nonlocal not or pass raise return try while " +
    "with yield"
  ).split(" "),
);
/** Names the generated module (or HttpApi, which its classes extend) already uses. */
const RESERVED_TYPE_NAMES = new Set([
  "Any",
  "HttpApi",
  "Literal",
  "NotRequired",
  "OPERATIONS",
  "Optional",
  "TypedDict",
  "Union",
]);
const RESERVED_METHODS = new Set(["call", "operations", "base_url", "tag", "timeout"]);
const RESERVED_PARAMS = new Set(["self", "body", "idempotency_key"]);
const METHODS = ["get", "put", "post", "delete", "patch"];

const snakeCase = (id: string) => id.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const pascal = (text: string) =>
  text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join("");
/** A Python string literal in single quotes. */
const pyString = (text: string) =>
  `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r")}'`;
const refName = (ref: string) => ref.replace("#/components/schemas/", "");
const isObject = (s: unknown): s is Schema =>
  typeof s === "object" && s !== null && !Array.isArray(s);
const pyParam = (name: string) =>
  KEYWORDS.has(name) || RESERVED_PARAMS.has(name) ? `${name}_` : name;

/** One generated module: its TypedDicts, aliases and API classes, built in document order. */
class Renderer {
  private readonly used = new Set<string>(RESERVED_TYPE_NAMES);
  private readonly dicts: string[] = [];
  private readonly aliases: string[] = [];

  constructor(private readonly schemas: Record<string, Schema>) {
    for (const name of Object.keys(schemas)) {
      if (!/^[A-Za-z_]\w*$/.test(name) || KEYWORDS.has(name))
        throw new Error(`OpenAPI schema ${name} is not a Python name`);
      if (this.used.has(name)) throw new Error(`OpenAPI schema ${name} clashes with a Python name`);
      this.used.add(name);
    }
  }

  /** A fresh type name built from `hint`. */
  private fresh(hint: string): string {
    let name = hint;
    for (let n = 2; this.used.has(name); n++) name = `${hint}${n}`;
    this.used.add(name);
    return name;
  }

  /** Every component schema, in the document's order. */
  renderSchemas(): void {
    for (const [name, schema] of Object.entries(this.schemas)) {
      if (this.isTypedDict(schema)) this.typedDict(name, schema);
      else {
        const doc = typeof schema.description === "string" ? schema.description : undefined;
        this.aliases.push(
          ...(doc ? doc.split("\n").map((l) => `# ${l}`.trimEnd()) : []),
          `${name} = ${this.type(schema, name, true)}`,
          "",
        );
      }
    }
  }

  private isTypedDict(schema: Schema): boolean {
    return (
      isObject(schema.properties) &&
      Object.keys(schema.properties).length > 0 &&
      !schema.anyOf &&
      !schema.allOf
    );
  }

  /** A TypedDict named `name` for an object schema with properties. */
  private typedDict(name: string, schema: Schema): void {
    const properties = schema.properties as Record<string, Schema>;
    const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
    const fields = Object.entries(properties).map(([key, value]) => {
      const type = this.type(value, `${name}${pascal(key)}`, false);
      const annotation = required.has(key) ? type : `NotRequired[${type}]`;
      return `        ${JSON.stringify(key)}: ${JSON.stringify(annotation)},`;
    });
    const doc = typeof schema.description === "string" ? schema.description : undefined;
    this.dicts.push(
      ...(doc ? doc.split("\n").map((l) => `# ${l}`.trimEnd()) : []),
      `${name} = TypedDict(`,
      `    ${JSON.stringify(name)},`,
      "    {",
      ...fields,
      "    },",
      ")",
      "",
    );
  }

  /**
   * The Python type of `schema`. `hint` names an inline object that needs a TypedDict of its
   * own. `quote` writes named types as forward references ("Name"), for expressions evaluated
   * at import time (aliases, method signatures stay unquoted under `from __future__`).
   */
  type(schema: unknown, hint: string, quote: boolean): string {
    if (!isObject(schema)) return schema === false ? "None" : "Any";
    const named = (name: string) => (quote ? JSON.stringify(name) : name);
    if (typeof schema.$ref === "string") return named(refName(schema.$ref));
    if ("const" in schema) return this.literal([schema.const]);
    if (Array.isArray(schema.enum)) return this.literal(schema.enum);
    if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
      const members = (schema.anyOf ?? schema.oneOf) as unknown[];
      const objects = members.filter((m) => isObject(m) && this.isTypedDict(m)).length;
      return this.union(
        members.map((member, i) => {
          if (objects > 1 && isObject(member) && this.isTypedDict(member))
            return this.type(member, `${hint}${this.variantName(member) ?? String(i + 1)}`, quote);
          return this.type(member, hint, quote);
        }),
      );
    }
    if (Array.isArray(schema.allOf)) return "dict[str, Any]";
    if (Array.isArray(schema.type))
      return this.union(
        (schema.type as string[]).map((t) => this.type({ ...schema, type: t }, hint, quote)),
      );
    switch (schema.type) {
      case "string":
        return "str";
      case "number":
        return "float";
      case "integer":
        return "int";
      case "boolean":
        return "bool";
      case "null":
        return "None";
      case "array":
        return `list[${Array.isArray(schema.items) || !isObject(schema.items) ? "Any" : this.type(schema.items, `${hint}Item`, quote)}]`;
      case "object": {
        if (this.isTypedDict(schema)) {
          const name = this.fresh(hint);
          this.typedDict(name, schema);
          return named(name);
        }
        const extra = schema.additionalProperties;
        return `dict[str, ${isObject(extra) && Object.keys(extra).length ? this.type(extra, `${hint}Value`, quote) : "Any"}]`;
      }
      default:
        return "Any";
    }
  }

  /** A discriminating `const` string among a variant's properties, for its name. */
  private variantName(schema: Schema): string | undefined {
    for (const value of Object.values(schema.properties as Record<string, unknown>))
      if (isObject(value) && typeof value.const === "string" && pascal(value.const))
        return pascal(value.const);
    return undefined;
  }

  private literal(values: unknown[]): string {
    const out: string[] = [];
    let nullable = false;
    for (const value of values) {
      if (value === null) nullable = true;
      else if (typeof value === "string") out.push(pyString(value));
      else if (typeof value === "boolean") out.push(value ? "True" : "False");
      else if (typeof value === "number" && Number.isInteger(value)) out.push(String(value));
      else return "Any"; // a float or object literal: Python's Literal cannot say it
    }
    if (!out.length) return "None";
    const literal = `Literal[${out.join(", ")}]`;
    return nullable ? `Optional[${literal}]` : literal;
  }

  private union(types: string[]): string {
    const unique = [...new Set(types)];
    if (unique.includes("Any")) return "Any";
    const nullable = unique.includes("None");
    const rest = unique.filter((t) => t !== "None");
    if (!rest.length) return "None";
    const inner = rest.length === 1 ? rest[0]! : `Union[${rest.join(", ")}]`;
    return nullable ? `Optional[${inner}]` : inner;
  }

  /** One API class per tag; each operation a typed method. */
  renderApis(openapi: Record<string, unknown>): string[] {
    const paths = (openapi.paths ?? {}) as Record<string, Record<string, OperationObject>>;
    const tags = ((openapi.tags ?? []) as { name: string; description?: string }[]).map(
      (t) => t.name,
    );
    const byTag = new Map<string, { path: string; method: string; op: OperationObject }[]>();
    for (const [path, item] of Object.entries(paths))
      for (const method of METHODS) {
        const op = item[method];
        if (!op) continue;
        const tag = op.tags?.[0] ?? "default";
        if (!tags.includes(tag)) tags.push(tag);
        byTag.set(tag, [...(byTag.get(tag) ?? []), { path, method, op }]);
      }
    const out: string[] = [];
    for (const tag of tags) {
      const ops = byTag.get(tag);
      if (!ops?.length) continue;
      const cls = `${pascal(tag)}Api`;
      if (this.used.has(cls)) throw new Error(`API class ${cls} clashes with a schema name`);
      this.used.add(cls);
      out.push(
        "",
        `class ${cls}(HttpApi):`,
        `    """The ${tag} operations of marina.http.v1, typed. Anything newer: \`call(...)\`."""`,
        "",
        "    def __init__(self, base_url: str, token: TokenSource, timeout: float = 35.0) -> None:",
        `        super().__init__(base_url, token, ${JSON.stringify(tag)}, timeout)`,
      );
      for (const { path, method, op } of ops) out.push("", ...this.method(path, method, op));
    }
    return out;
  }

  private method(path: string, method: string, op: OperationObject): string[] {
    const name = snakeCase(op.operationId);
    if (RESERVED_METHODS.has(name) || KEYWORDS.has(name))
      throw new Error(`Operation ${op.operationId} clashes with a Python or HttpApi name`);
    const hint = pascal(op.operationId);
    const params = op.parameters ?? [];
    const pathParams = params.filter((p) => p.in === "path");
    const query = params.filter((p) => p.in === "query");
    const idempotent = params.some((p) => p.$ref?.endsWith("/IdempotencyKey"));
    const json = op.requestBody?.content?.["application/json"]?.schema;
    const bodyRequired = Boolean(op.requestBody?.required);
    const replies = Object.entries(op.responses ?? {})
      .filter(([code]) => /^2\d\d$/.test(code))
      .map(([, response]) => response.content?.["application/json"]?.schema)
      .filter(isObject);
    const reply = replies.length
      ? this.union(replies.map((r) => this.type(r, `${hint}Response`, false)))
      : "None";
    const args = ["self"];
    for (const p of pathParams) args.push(`${pyParam(p.name)}: str`);
    if (json && bodyRequired) args.push(`body: ${this.type(json, `${hint}Body`, false)}`);
    const keywords: string[] = [];
    if (json && !bodyRequired)
      keywords.push(`body: Optional[${this.type(json, `${hint}Body`, false)}] = None`);
    for (const p of query)
      keywords.push(`${pyParam(p.name)}: Optional[${this.type(p.schema, "Any", false)}] = None`);
    if (idempotent) keywords.push("idempotency_key: Optional[str] = None");
    if (keywords.length) args.push("*", ...keywords);
    const pass = [...pathParams, ...query].map((p) => [p.name, pyParam(p.name)] as const);
    const plain = pass.filter(([n, py]) => n === py).map(([n]) => `${n}=${n}`);
    const renamed = pass
      .filter(([n, py]) => n !== py)
      .map(([n, py]) => `${JSON.stringify(n)}: ${py}`);
    const callArgs = [
      `_operation(${JSON.stringify(op.operationId)})`,
      ...(json ? ["body=body"] : []),
      ...(idempotent ? ["idempotency_key=idempotency_key"] : []),
      ...plain,
      ...(renamed.length ? [`**{${renamed.join(", ")}}`] : []),
    ];
    const summary = (op.summary ?? op.operationId).replace(/"""/g, "'''").replace(/\\/g, "\\\\");
    return [
      `    def ${name}(${args.join(", ")}) -> ${reply}:`,
      `        """${summary}. \`${method.toUpperCase()} ${path}\`"""`,
      `        return self._call(${callArgs.join(", ")})`,
    ];
  }

  module(openapi: Record<string, unknown>): string {
    this.renderSchemas();
    const apis = this.renderApis(openapi);
    const info = (openapi.info ?? {}) as { version?: string };
    return [
      "# Copyright 2025-2026 H2O.ai, Inc.",
      "# SPDX-License-Identifier: Apache-2.0",
      `"""Typed models and methods for every marina.http.v1 operation${info.version ? ` (${info.version})` : ""}.`,
      "",
      "Generated from protocol/marina.http.v1.openapi.json by scripts/sdk-models/python.ts",
      "(`bun run docs:api`); do not edit by hand. Each component schema is a TypedDict (objects) or",
      "a type alias (unions, enums); each tag is a class whose methods take path parameters",
      "positionally, query parameters by keyword and the JSON body as `body`.",
      '"""',
      "",
      "from __future__ import annotations",
      "",
      "import sys",
      "from typing import Any, Literal, Optional, TypedDict, Union",
      "",
      "from ._operations import OPERATIONS, Operation",
      "from .http import HttpApi, TokenSource",
      "",
      "if sys.version_info >= (3, 11):",
      "    from typing import NotRequired  # noqa: F401 - read by type checkers in annotations",
      "",
      "_BY_ID = {op.id: op for op in OPERATIONS.values()}",
      "",
      "",
      "def _operation(operation_id: str) -> Operation:",
      "    return _BY_ID[operation_id]",
      "",
      "",
      "# ─── Models ───────────────────────────────────────────────────────────────",
      "",
      ...this.dicts,
      ...this.aliases,
      "# ─── Operations ───────────────────────────────────────────────────────────",
      ...apis,
      "",
    ].join("\n");
  }
}

/** The generated Python module for one OpenAPI document. */
export function renderPythonModels(openapi: Record<string, unknown>): string {
  const components = (openapi.components ?? {}) as { schemas?: Record<string, Schema> };
  return new Renderer(components.schemas ?? {}).module(openapi);
}
