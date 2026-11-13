// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// The Java SDK's typed HTTP layer, rendered from the OpenAPI document into one file
// (sdks/java/src/main/java/ai/h2o/marina/Http.java):
// - a record per object schema: boxed, nullable components named in camelCase, with
//   `@Json.Name` where the JSON name differs; `of(required…)` and `withX(…)` to build one;
// - `String` for enums and string constants (the server may add values), `List<T>`,
//   `Map<String, T>`, and `Object` (the raw JSON value) for unions and anything else;
// - a class per tag (`MemoryApi`, `RoutingApi`, …) with one typed method per operation.
// Binding is reflection over the records (`Json.bind` / `Json.unbind`), so the file is data.

import type { SdkModelOutput } from "./index";

type Schema = Record<string, unknown>;

const FILE = "sdks/java/src/main/java/ai/h2o/marina/Http.java";

const KEYWORDS = new Set(
  (
    "abstract assert boolean break byte case catch char class const continue default do double else enum " +
    "extends final finally float for goto if implements import instanceof int interface long native new " +
    "package private protected public return short static strictfp super switch synchronized this throw " +
    "throws transient try void volatile while true false null var yield record sealed permits non-sealed " +
    "_ hashCode toString equals getClass wait notify notifyAll clone finalize"
  ).split(" "),
);

/** Names generated code relies on: a nested record may not take one (it would shadow it). */
const TAKEN = new Set(
  (
    "Http Json HttpApi HttpGroup PanelsGroup Operations Marina List Map LinkedHashMap Supplier Type " +
    "Object String Double Long Integer Boolean Number Record Override SuppressWarnings Deprecated " +
    "Class Enum Iterable Runnable Thread Math System Error Exception RuntimeException Void Character " +
    "Byte Short Float Comparable Module Package Process Runtime StringBuilder FunctionalInterface SafeVarargs Name"
  ).split(" "),
);

const GROUPS: Record<string, { name: string; base: string; signed: string }> = {
  memory: { name: "MemoryApi", base: "HttpGroup", signed: "a memory credential" },
  routing: { name: "RoutingApi", base: "HttpGroup", signed: "the session token" },
  investigations: { name: "InvestigationsApi", base: "HttpGroup", signed: "the session token" },
  panels: { name: "PanelsApi", base: "PanelsGroup", signed: "the session token" },
};

const pascal = (s: string) =>
  s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join("") || "Value";

function camel(json: string): string {
  const words = json.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!words.length) return "value";
  let name =
    words[0]! +
    words
      .slice(1)
      .map((w) => w[0]!.toUpperCase() + w.slice(1))
      .join("");
  if (/^[0-9]/.test(name)) name = `v${name}`;
  name = name[0]!.toLowerCase() + name.slice(1);
  return KEYWORDS.has(name) ? `${name}_` : name;
}

/** Text safe inside a Javadoc comment (javac reads `\u` escapes even there). */
function doc(text: string): string {
  return text
    .replaceAll("\\", "&#92;")
    .replaceAll("*/", "*&#47;")
    .replaceAll("@", "&#64;")
    .replaceAll("{", "&#123;")
    .replaceAll("}", "&#125;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/\s+/g, " ")
    .trim();
}

interface Field {
  json: string;
  java: string;
  type: string;
  required: boolean;
  description?: string;
}

interface RecordDef {
  name: string;
  description?: string;
  fields: Field[];
  nested: RecordDef[];
}

class Renderer {
  private readonly schemas: Record<string, Schema>;
  private readonly topNames = new Set<string>();
  private readonly used = new Set<string>(TAKEN);
  private readonly records: RecordDef[] = [];
  private readonly resolved = new Map<string, string>();

  constructor(private readonly openapi: Record<string, unknown>) {
    this.schemas = ((openapi.components as Schema).schemas ?? {}) as Record<string, Schema>;
    for (const name of Object.keys(this.schemas)) {
      if (TAKEN.has(name) || Object.values(GROUPS).some((g) => g.name === name))
        throw new Error(`OpenAPI schema ${name} collides with a name Http.java uses`);
      this.topNames.add(name);
      this.used.add(name);
    }
    for (const g of Object.values(GROUPS)) this.used.add(g.name);
    for (const name of Object.keys(this.schemas)) this.component(name);
  }

  /** The Java type of a named component, rendering its record once. */
  private component(name: string): string {
    const known = this.resolved.get(name);
    if (known) return known;
    const schema = this.schemas[name]!;
    if (this.isRecord(schema)) {
      this.resolved.set(name, name); // before the fields: schemas may refer to themselves
      this.records.push(this.record(name, schema));
      return name;
    }
    this.resolved.set(name, "Object"); // a cycle through a non-record is raw JSON
    const type = this.type(schema, name, null);
    this.resolved.set(name, type);
    return type;
  }

  private isRecord(schema: Schema): boolean {
    return (
      (schema.type === "object" ||
        (schema.type === undefined && schema.properties !== undefined)) &&
      Object.keys((schema.properties as Schema | undefined) ?? {}).length > 0
    );
  }

  /** A unique name for an inline record: never shadowing another type in the file. */
  private nestedName(hint: string, owner: string): string {
    for (const candidate of [pascal(hint), `${owner}${pascal(hint)}`]) {
      if (!this.used.has(candidate)) {
        this.used.add(candidate);
        return candidate;
      }
    }
    for (let i = 2; ; i++) {
      const candidate = `${owner}${pascal(hint)}${i}`;
      if (!this.used.has(candidate)) {
        this.used.add(candidate);
        return candidate;
      }
    }
  }

  private record(name: string, schema: Schema): RecordDef {
    const def: RecordDef = {
      name,
      description: typeof schema.description === "string" ? schema.description : undefined,
      fields: [],
      nested: [],
    };
    const required = new Set((schema.required as string[] | undefined) ?? []);
    const javaNames = new Set<string>();
    for (const [json, prop] of Object.entries(schema.properties as Record<string, Schema>)) {
      let java = camel(json);
      while (javaNames.has(java)) java = `${java}_`;
      javaNames.add(java);
      def.fields.push({
        json,
        java,
        type: this.type(prop, json, def),
        required: required.has(json),
        description: typeof prop.description === "string" ? prop.description : undefined,
      });
    }
    return def;
  }

  /** The Java type of a schema; inline objects become records nested in `owner` (or top level). */
  type(schema: Schema, hint: string, owner: RecordDef | null): string {
    if (typeof schema.$ref === "string") return this.component(schema.$ref.split("/").pop()!);
    for (const key of ["anyOf", "oneOf"]) {
      const options = schema[key] as Schema[] | undefined;
      if (!options) continue;
      const real = options.filter((o) => o.type !== "null");
      return real.length === 1 ? this.type(real[0]!, hint, owner) : "Object";
    }
    const all = schema.allOf as Schema[] | undefined;
    if (all) return all.length === 1 ? this.type(all[0]!, hint, owner) : "Object";
    if (Array.isArray(schema.enum))
      return schema.enum.every((v) => typeof v === "string") ? "String" : "Object";
    if (schema.const !== undefined) return scalar(typeof schema.const) ?? "Object";
    let type = schema.type;
    if (Array.isArray(type)) {
      const real = type.filter((t) => t !== "null");
      if (real.length !== 1) return "Object";
      type = real[0];
    }
    switch (type) {
      case "string":
        return "String";
      case "number":
        return "Double";
      case "integer":
        return "Long";
      case "boolean":
        return "Boolean";
      case "array": {
        const items = schema.items as Schema | undefined;
        return `List<${items ? this.type(items, `${hint}Item`, owner) : "Object"}>`;
      }
      case "object":
      case undefined: {
        if (this.isRecord(schema)) {
          const name = this.nestedName(hint, owner?.name ?? "");
          const def = this.record(name, schema);
          if (owner) owner.nested.push(def);
          else this.records.push(def);
          return name;
        }
        if (type === undefined && schema.properties === undefined && !schema.additionalProperties)
          return "Object";
        const extra = schema.additionalProperties;
        const value =
          extra && typeof extra === "object" && Object.keys(extra).length
            ? this.type(extra as Schema, `${hint}Value`, owner)
            : "Object";
        return `Map<String, ${value}>`;
      }
      default:
        return "Object";
    }
  }

  renderRecord(def: RecordDef, indent: string): string[] {
    const i1 = `${indent}  `;
    const i2 = `${indent}    `;
    const out: string[] = [];
    const params = def.fields.flatMap((f) =>
      f.description ? [`@param ${f.java} ${doc(f.description)}`] : [],
    );
    const docLines = [
      ...(def.description ? [doc(def.description)] : []),
      ...(def.description && params.length ? [""] : []),
      ...params,
    ];
    if (docLines.length) {
      out.push(`${indent}/**`);
      for (const line of docLines) out.push(line ? `${indent} * ${line}` : `${indent} *`);
      out.push(`${indent} */`);
    }
    const components = def.fields.map(
      (f) =>
        `${f.json !== f.java ? `@Json.Name(${JSON.stringify(f.json)}) ` : ""}${f.type} ${f.java}`,
    );
    out.push(`${indent}public record ${def.name}(`);
    components.forEach((c, n) => {
      out.push(`${i2}${c}${n === components.length - 1 ? ") {" : ","}`);
    });
    const required = def.fields.filter((f) => f.required);
    const names = new Set(def.fields.map((f) => f.java));
    if (!names.has("of")) {
      out.push("");
      out.push(`${i1}/** With its required fields; the rest are null. */`);
      out.push(
        `${i1}public static ${def.name} of(${required.map((f) => `${f.type} ${f.java}`).join(", ")}) {`,
      );
      out.push(
        `${i2}return new ${def.name}(${def.fields.map((f) => (f.required ? f.java : "null")).join(", ")});`,
      );
      out.push(`${i1}}`);
    }
    for (const f of def.fields) {
      const wither = `with${f.java[0]!.toUpperCase()}${f.java.slice(1).replace(/_+$/, "")}`;
      if (names.has(wither)) continue;
      out.push("");
      out.push(`${i1}public ${def.name} ${wither}(${f.type} value) {`);
      out.push(
        `${i2}return new ${def.name}(${def.fields.map((g) => (g === f ? "value" : g.java)).join(", ")});`,
      );
      out.push(`${i1}}`);
    }
    for (const nested of def.nested) {
      out.push("");
      out.push(...this.renderRecord(nested, i1));
    }
    out.push(`${indent}}`);
    return out;
  }

  renderModels(): string[] {
    const out: string[] = [];
    for (const def of this.records) {
      out.push("");
      out.push(...this.renderRecord(def, "  "));
    }
    return out;
  }

  /** A runtime type for `Json.bind`, and whether the cast is unchecked. */
  static typeToken(type: string): { token: string; generic: boolean } {
    const list = /^List<(.*)>$/.exec(type);
    if (list) return { token: `Json.listOf(${Renderer.typeToken(list[1]!).token})`, generic: true };
    const map = /^Map<String, (.*)>$/.exec(type);
    if (map) return { token: `Json.mapOf(${Renderer.typeToken(map[1]!).token})`, generic: true };
    return { token: `${type}.class`, generic: false };
  }

  renderGroups(): string[] {
    const paths = this.openapi.paths as Record<string, Record<string, Schema>>;
    const byTag = new Map<string, string[]>();
    const reserved = new Set(["call", "operations", "http", "baseUrl", "token", "watchChanges"]);
    for (const [path, item] of Object.entries(paths)) {
      for (const [method, op] of Object.entries(item)) {
        const id = op.operationId as string;
        const tag = (op.tags as string[])[0]!;
        if (!GROUPS[tag]) throw new Error(`No Java group for tag ${tag}`);
        if (reserved.has(id) || KEYWORDS.has(id))
          throw new Error(`Operation ${id} cannot be a Java method name`);
        const params = (op.parameters as Schema[] | undefined) ?? [];
        const key = params.some(
          (p) => typeof p.$ref === "string" && p.$ref.endsWith("/IdempotencyKey"),
        );
        const pathParams = params.filter((p) => p.in === "path");
        const query = params.filter((p) => p.in === "query");
        const body = (op.requestBody as Schema | undefined)?.content as
          | Record<string, { schema: Schema }>
          | undefined;
        const bodyType = body
          ? this.type(body["application/json"]!.schema, `${pascal(id)}Body`, null)
          : null;
        const success = Object.entries(op.responses as Record<string, Schema>).find(
          ([code, r]) => code.startsWith("2") && r.content,
        )?.[1];
        const replySchema = (success?.content as Record<string, { schema: Schema }> | undefined)?.[
          "application/json"
        ]?.schema;
        const reply = replySchema ? this.type(replySchema, `${pascal(id)}Reply`, null) : "Object";
        const used = new Set<string>(["params$"]);
        const arg = (name: string) => {
          let java = camel(name);
          while (used.has(java)) java = `${java}_`;
          used.add(java);
          return java;
        };
        const pathArgs = pathParams.map((p) => ({
          json: p.name as string,
          java: arg(p.name as string),
        }));
        const queryArgs = query.map((p) => ({
          json: p.name as string,
          java: arg(p.name as string),
          type: queryType((p.schema as Schema | undefined)?.type),
        }));
        const bodyArg = bodyType ? arg("body") : null;
        const keyArg = key ? arg("idempotencyKey") : null;
        const { token, generic } = Renderer.typeToken(reply);
        const summary = typeof op.summary === "string" ? `${doc(op.summary)}. ` : "";
        const lines: string[] = [];
        const signature = (withQuery: boolean, withKey: boolean, withBody = true) =>
          [
            ...pathArgs.map((a) => `String ${a.java}`),
            ...(withQuery ? queryArgs.map((a) => `${a.type} ${a.java}`) : []),
            ...(bodyArg && withBody ? [`${bodyType} ${bodyArg}`] : []),
            ...(withKey && keyArg ? [`String ${keyArg}`] : []),
          ].join(", ");
        const signatures = new Set<string>();
        const erased = (sig: string) =>
          sig
            .split(", ")
            .map((p) => p.replace(/<.*>/, "").split(" ")[0])
            .join(",");
        signatures.add(erased(signature(true, true)));
        lines.push("");
        lines.push(
          `    /** ${summary}${method.toUpperCase()} ${doc(path)}.${keyArg ? ` The same {@code ${keyArg}} replays the first result; null makes a fresh one.` : ""} */`,
        );
        if (generic) lines.push(`    @SuppressWarnings("unchecked")`);
        lines.push(`    public ${reply} ${id}(${signature(true, true)}) {`);
        lines.push("      Map<String, Object> params$ = new LinkedHashMap<>();");
        for (const a of [...pathArgs, ...queryArgs])
          lines.push(`      params$.put(${JSON.stringify(a.json)}, ${a.java});`);
        const callArgs = [JSON.stringify(id), "params$", bodyArg ?? "null", keyArg ?? "null"].join(
          ", ",
        );
        if (reply === "Object") lines.push(`      return call(${callArgs});`);
        else if (generic)
          lines.push(`      return (${reply}) Json.bind(call(${callArgs}), ${token});`);
        else lines.push(`      return Json.bind(call(${callArgs}), ${token});`);
        lines.push("    }");
        // An empty object body ({}) may be left out.
        const emptyBody =
          bodyType === "Map<String, Object>" &&
          (() => {
            const ref = (body?.["application/json"]?.schema.$ref as string | undefined)
              ?.split("/")
              .pop();
            const schema = ref ? this.schemas[ref] : undefined;
            return Boolean(
              schema &&
                Object.keys((schema.properties as Schema | undefined) ?? {}).length === 0 &&
                !schema.additionalProperties &&
                schema.properties,
            );
          })();
        const shorter = (withQuery: boolean, withKey: boolean, withBody = true) => {
          const sig = signature(withQuery, withKey, withBody);
          if (signatures.has(erased(sig))) return;
          signatures.add(erased(sig));
          const args = [
            ...pathArgs.map((a) => a.java),
            ...queryArgs.map((a) => (withQuery ? a.java : "null")),
            ...(bodyArg ? [withBody ? bodyArg : "Map.of()"] : []),
            ...(keyArg ? [withKey ? keyArg : "null"] : []),
          ].join(", ");
          lines.push("");
          lines.push(`    public ${reply} ${id}(${sig}) {`);
          lines.push(`      return ${id}(${args});`);
          lines.push("    }");
        };
        if (keyArg) shorter(true, false);
        if (queryArgs.length) shorter(false, false);
        if (emptyBody) shorter(false, false, false);
        byTag.set(tag, [...(byTag.get(tag) ?? []), ...lines]);
      }
    }
    const out: string[] = [];
    for (const [tag, group] of Object.entries(GROUPS)) {
      out.push("");
      out.push(
        `  /** The typed {@code ${tag}} operations, signed with ${group.signed}. {@link #call} stays for anything newer. */`,
      );
      out.push(`  public static final class ${group.name} extends ${group.base} {`);
      out.push(`    public ${group.name}(String baseUrl, Supplier<String> token) {`);
      out.push(
        group.base === "HttpGroup"
          ? `      super(baseUrl, token, ${JSON.stringify(tag)});`
          : "      super(baseUrl, token);",
      );
      out.push("    }");
      out.push(...(byTag.get(tag) ?? []));
      out.push("  }");
    }
    return out;
  }
}

function scalar(kind: string): string | undefined {
  return kind === "string"
    ? "String"
    : kind === "boolean"
      ? "Boolean"
      : kind === "number"
        ? "Double"
        : undefined;
}

function queryType(type: unknown): string {
  return type === "number" || type === "integer"
    ? "Long"
    : type === "boolean"
      ? "Boolean"
      : "String";
}

export function renderJavaModels(openapi: Record<string, unknown>): string {
  const renderer = new Renderer(openapi);
  // Groups first: they may hoist inline bodies and replies to top-level records.
  const groups = renderer.renderGroups();
  const models = renderer.renderModels();
  return [
    "// Copyright 2025-2026 H2O.ai, Inc.",
    "// SPDX-License-Identifier: Apache-2.0",
    "package ai.h2o.marina;",
    "",
    "import java.util.LinkedHashMap;",
    "import java.util.List;",
    "import java.util.Map;",
    "import java.util.function.Supplier;",
    "",
    "/**",
    " * marina.http.v1, typed: a record for each request and reply, and a class per group with a",
    " * method per operation. Generated from protocol/marina.http.v1.openapi.json by",
    " * scripts/sdk-models/java.ts ({@code bun run docs:api}); do not edit by hand.",
    " *",
    " * <p>Records have a nullable component per JSON field (camelCase; {@link Json.Name} gives the JSON",
    " * name where it differs). Enums are {@code String} (the server may add values) and unions are",
    " * {@code Object}, the raw JSON value. Build one with {@code of(required...)} and {@code withX(...)}.",
    " */",
    "public final class Http {",
    "  private Http() {}",
    ...groups,
    ...models,
    "}",
    "",
  ].join("\n");
}

export const JAVA_MODELS: SdkModelOutput = { file: FILE, render: renderJavaModels };
