// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// The Rust SDK's typed HTTP models and methods (sdks/rust/src/models.rs), rendered from the
// OpenAPI document. Object schemas become serde structs (snake_case fields, renamed to the
// wire names; optional fields are `Option` and left out when `None`); enums and consts are
// `String` (the server may add values); unions the language cannot say plainly are
// `serde_json::Value`. Each tag gets an API type (`MemoryApi`, `RoutingApi`, ...) with one
// method per operation, which derefs to the generic `HttpApi` for anything newer.

// biome-ignore lint/suspicious/noExplicitAny: JSON Schema is untyped JSON
type Schema = Record<string, any>;

const KEYWORDS = new Set(
  (
    "as async await break const continue crate dyn else enum extern false fn for if impl in let " +
    "loop match mod move mut pub ref return self static struct super trait true type unsafe use " +
    "where while abstract become box do final gen macro override priv try typeof unsized virtual yield"
  ).split(" "),
);
/** Methods `HttpApi` already has: an operation of the same name gets a suffix. */
const TAKEN_METHODS = new Set(["new", "call", "call_with_key", "operations", "http"]);

const pascal = (s: string) =>
  s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join("");

function snake(name: string): string {
  const out = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .toLowerCase();
  const safe = /^[0-9]/.test(out) ? `_${out}` : out || "_";
  return KEYWORDS.has(safe) ? `r#${safe}` : safe;
}

/** One line of documentation (never a code block, never a lazy continuation). */
function doc(text: unknown, indent: string): string[] {
  if (typeof text !== "string") return [];
  const line = text.replace(/\s+/g, " ").trim();
  return line ? [`${indent}/// ${line}`] : [];
}

class Renderer {
  private readonly components: Record<string, Schema>;
  private readonly names = new Set<string>();
  private readonly structs: string[] = [];

  constructor(private readonly openapi: Schema) {
    this.components = (openapi.components?.schemas ?? {}) as Record<string, Schema>;
    for (const name of Object.keys(this.components)) this.names.add(pascal(name));
  }

  private fresh(hint: string): string {
    let name = pascal(hint);
    for (let i = 2; this.names.has(name); i++) name = `${pascal(hint)}${i}`;
    this.names.add(name);
    return name;
  }

  private isStruct(schema: Schema): boolean {
    return (
      schema.type === "object" &&
      (Object.keys(schema.properties ?? {}).length > 0 ||
        (schema.properties !== undefined && schema.additionalProperties === undefined))
    );
  }

  /** The Rust type of `schema`; `nullable` when it allows `null` (the type is then `Option`). */
  type(schema: Schema | undefined, hint: string): { ty: string; nullable: boolean } {
    const plain = (ty: string) => ({ ty, nullable: false });
    if (!schema || typeof schema !== "object") return plain("Value");
    if (typeof schema.$ref === "string") return plain(pascal(schema.$ref.split("/").pop()!));
    const union = (schema.anyOf ?? schema.oneOf) as Schema[] | undefined;
    if (union) {
      const rest = union.filter((v) => v.type !== "null");
      if (rest.length === 1 && rest.length < union.length) {
        const inner = this.type(rest[0], hint);
        return inner.nullable ? inner : { ty: `Option<${inner.ty}>`, nullable: true };
      }
      const stringy = (v: Schema) =>
        typeof v.const === "string" ||
        (Array.isArray(v.enum) && v.enum.every((e: unknown) => typeof e === "string")) ||
        (v.type === "string" && !v.enum);
      return plain(
        rest.length && rest.every(stringy) && rest.length === union.length ? "String" : "Value",
      );
    }
    if (schema.allOf) return plain("Value");
    if (Array.isArray(schema.enum))
      return plain(schema.enum.every((e: unknown) => typeof e === "string") ? "String" : "Value");
    if (schema.const !== undefined) {
      const kind = typeof schema.const;
      return plain(
        kind === "string"
          ? "String"
          : kind === "boolean"
            ? "bool"
            : kind === "number"
              ? "f64"
              : "Value",
      );
    }
    const primitive = (t: string) =>
      t === "string"
        ? "String"
        : t === "number" || t === "integer"
          ? "f64"
          : t === "boolean"
            ? "bool"
            : undefined;
    if (Array.isArray(schema.type)) {
      const rest = (schema.type as string[]).filter((t) => t !== "null");
      const one = rest.length === 1 ? primitive(rest[0]!) : undefined;
      if (one && rest.length < schema.type.length) return { ty: `Option<${one}>`, nullable: true };
      return plain(one ?? "Value");
    }
    const prim = primitive(schema.type);
    if (prim) return plain(prim);
    if (schema.type === "array") {
      const items = this.type(schema.items, `${hint}Item`);
      return plain(`Vec<${schema.items ? items.ty : "Value"}>`);
    }
    if (schema.type === "object") {
      if (this.isStruct(schema)) {
        const name = this.fresh(hint);
        this.struct(name, schema);
        return plain(name);
      }
      const extra = schema.additionalProperties;
      if (extra && typeof extra === "object" && Object.keys(extra).length > 0)
        return plain(`BTreeMap<String, ${this.type(extra, `${hint}Value`).ty}>`);
      return plain("BTreeMap<String, Value>");
    }
    return plain("Value");
  }

  struct(name: string, schema: Schema): void {
    const required = new Set<string>(schema.required ?? []);
    const used = new Set<string>();
    const fields: string[] = [];
    for (const [wire, property] of Object.entries<Schema>(schema.properties ?? {})) {
      let field = snake(wire);
      for (let i = 2; used.has(field); i++) field = `${snake(wire)}_${i}`;
      used.add(field);
      const { ty, nullable } = this.type(property, `${name}${pascal(wire)}`);
      const attrs: string[] = [];
      if (field.replace(/^r#/, "") !== wire) attrs.push(`rename = ${JSON.stringify(wire)}`);
      let rust = ty;
      if (!required.has(wire)) {
        if (!nullable) rust = `Option<${ty}>`;
        attrs.push(`skip_serializing_if = "Option::is_none"`);
      }
      fields.push(...doc(property.description, "    "));
      if (attrs.length) fields.push(`    #[serde(${attrs.join(", ")})]`);
      fields.push(`    pub ${field}: ${rust},`);
    }
    const extra = schema.additionalProperties;
    if (extra !== undefined && extra !== false && Object.keys(schema.properties ?? {}).length) {
      const ty =
        typeof extra === "object" && Object.keys(extra).length
          ? this.type(extra, `${name}Value`).ty
          : "Value";
      fields.push(
        "    /// Every other field.",
        "    #[serde(flatten)]",
        `    pub extra: BTreeMap<String, ${ty}>,`,
      );
    }
    this.structs.push(
      [
        ...doc(schema.description, ""),
        "#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]",
        "#[serde(default)]",
        `pub struct ${name} {`,
        ...fields,
        "}",
        "",
      ].join("\n"),
    );
  }

  component(name: string, schema: Schema): void {
    const rust = pascal(name);
    if (this.isStruct(schema)) this.struct(rust, schema);
    else {
      const { ty } = this.type(schema, rust);
      this.structs.push(
        [...doc(schema.description, ""), `pub type ${rust} = ${ty};`, ""].join("\n"),
      );
    }
  }

  private schemaOf(content: Schema | undefined): Schema | undefined {
    return content?.["application/json"]?.schema;
  }

  apis(): string[] {
    const groups = new Map<string, string[]>();
    const tagDocs = new Map<string, string>(
      ((this.openapi.tags ?? []) as Schema[]).map((t) => [t.name, t.description]),
    );
    for (const [path, item] of Object.entries<Schema>(this.openapi.paths ?? {})) {
      for (const [method, op] of Object.entries<Schema>(item)) {
        if (typeof op !== "object" || !op.operationId) continue;
        const tag: string = op.tags?.[0] ?? "default";
        const methods = groups.get(tag) ?? [];
        groups.set(tag, methods);
        const opName = pascal(op.operationId);
        const args: string[] = ["&self"];
        const pathParams: string[] = [];
        const pushes: string[] = [];
        let key = false;
        for (const parameter of (op.parameters ?? []) as Schema[]) {
          if (parameter.$ref) {
            const resolved = this.openapi.components?.parameters?.[parameter.$ref.split("/").pop()];
            if (resolved?.in === "header" && resolved?.name === "Idempotency-Key") key = true;
            continue;
          }
          const arg = snake(parameter.name);
          const kind = parameter.schema?.type;
          if (parameter.in === "path") {
            args.push(`${arg}: &str`);
            pathParams.push(`(${JSON.stringify(parameter.name)}, Value::from(${arg}))`);
          } else if (parameter.in === "query") {
            const [ty, value] =
              kind === "number" || kind === "integer"
                ? ["Option<f64>", "number(v)"]
                : kind === "boolean"
                  ? ["Option<bool>", "Value::from(v)"]
                  : ["Option<&str>", "Value::from(v)"];
            args.push(`${arg}: ${ty}`);
            pushes.push(
              `        if let Some(v) = ${arg} { params.push((${JSON.stringify(parameter.name)}, ${value})); }`,
            );
          }
        }
        const bodySchema = this.schemaOf(op.requestBody?.content);
        if (op.requestBody) args.push(`body: &${this.type(bodySchema, `${opName}Request`).ty}`);
        if (key) args.push("idempotency_key: Option<&str>");
        const success = Object.entries<Schema>(op.responses ?? {}).find(([code]) =>
          code.startsWith("2"),
        );
        const replySchema = this.schemaOf(success?.[1]?.content);
        const reply = replySchema ? this.type(replySchema, `${opName}Response`).ty : "Value";
        let fn = snake(op.operationId);
        if (TAKEN_METHODS.has(fn.replace(/^r#/, ""))) fn = `${fn.replace(/^r#/, "")}_op`;
        methods.push(
          [
            ...doc(op.summary, "    "),
            ...(op.summary && op.description ? ["    ///"] : []),
            ...doc(op.description, "    "),
            ...(op.summary || op.description ? ["    ///"] : []),
            `    /// \`${method.toUpperCase()} ${path}\` (\`${op.operationId}\`)`,
            `    pub fn ${fn}(${args.join(", ")}) -> Result<${reply}> {`,
            `        ${pushes.length ? "let mut params" : "let params"}: Vec<(&str, Value)> = ${pathParams.length ? `vec![${pathParams.join(", ")}]` : "Vec::new()"};`,
            ...pushes,
            `        let reply = self.http.call_with_key(${JSON.stringify(op.operationId)}, &params, ${op.requestBody ? "Some(to_body(body)?)" : "None"}, ${key ? "idempotency_key" : "None"})?;`,
            "        from_reply(reply)",
            "    }",
          ].join("\n"),
        );
      }
    }
    const out: string[] = [];
    for (const [tag, methods] of groups) {
      const api = `${pascal(tag)}Api`;
      out.push(
        ...doc(tagDocs.get(tag), ""),
        "///",
        `/// The \`${tag}\` operations, typed. Derefs to [\`HttpApi\`] for \`call\` (anything newer).`,
        "#[derive(Clone)]",
        `pub struct ${api} {`,
        "    http: HttpApi,",
        "}",
        "",
        `impl ${api} {`,
        "    /// Wrap an `HttpApi` (normally the SDK does this for you).",
        "    pub fn new(http: HttpApi) -> Self {",
        `        ${api} { http }`,
        "    }",
        "",
        "    /// The untyped API underneath.",
        "    pub fn http(&self) -> &HttpApi {",
        "        &self.http",
        "    }",
        "",
        methods.join("\n\n"),
        "}",
        "",
        `impl std::ops::Deref for ${api} {`,
        "    type Target = HttpApi;",
        "    fn deref(&self) -> &HttpApi {",
        "        &self.http",
        "    }",
        "}",
        "",
      );
    }
    return out;
  }

  render(): string {
    for (const [name, schema] of Object.entries(this.components)) this.component(name, schema);
    const apis = this.apis();
    return [
      "// Copyright 2025-2026 H2O.ai, Inc.",
      "// SPDX-License-Identifier: Apache-2.0",
      "//! Typed marina.http.v1 models and methods. Generated from",
      "//! protocol/marina.http.v1.openapi.json by scripts/sdk-models/rust.ts (`bun run docs:api`);",
      "//! do not edit by hand.",
      "//!",
      "//! Every object schema is a struct with the wire's field names (renamed to snake_case);",
      "//! optional fields are `Option` and left out when `None`. Enum values are `String` (the",
      "//! server may add values), and unions are `serde_json::Value`.",
      "",
      "#![allow(clippy::too_many_arguments, clippy::large_enum_variant, clippy::should_implement_trait)]",
      "",
      "use crate::error::{Error, Result};",
      "use crate::http::HttpApi;",
      "use serde::de::DeserializeOwned;",
      "use serde::{Deserialize, Serialize};",
      "use serde_json::Value;",
      "use std::collections::BTreeMap;",
      "",
      "fn to_body<T: Serialize>(body: &T) -> Result<Value> {",
      '    serde_json::to_value(body).map_err(|e| Error::Invalid(format!("Could not encode the body: {e}")))',
      "}",
      "",
      "fn from_reply<T: DeserializeOwned>(reply: Value) -> Result<T> {",
      '    serde_json::from_value(reply).map_err(|e| Error::Other(format!("Unreadable reply: {e}")))',
      "}",
      "",
      "/// A query number as the server reads it: whole numbers without a decimal point.",
      "fn number(v: f64) -> Value {",
      "    if v.fract() == 0.0 && v.abs() < 9_007_199_254_740_992.0 { Value::from(v as i64) } else { Value::from(v) }",
      "}",
      "",
      ...this.structs,
      ...apis,
    ].join("\n");
  }
}

/** The whole generated module for `openapi`. */
export function renderRustModels(openapi: Record<string, unknown>): string {
  return new Renderer(openapi as Schema).render();
}
