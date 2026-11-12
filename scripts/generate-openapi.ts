// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Renders src/protocol/http-api.ts (operations) and the SDK's TypeScript types
// (bodies and replies) to protocol/marina.http.v1.openapi.json. `--check` fails
// when the file is stale (docs:api runs it).

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  HTTP_API_SCHEMA_PATH,
  HTTP_API_VERSION,
  HTTP_OPERATIONS,
  type HttpApiTag,
  memoryNeedsIdempotencyKey,
} from "../src/protocol/http-api";
import { WIRE_SCHEMA_PATH } from "../src/protocol/wire";
import { type JsonSchema, TypeSchemas } from "./ts-json-schema";

const ROOT = resolve(import.meta.dir, "..");
export const OPENAPI_FILE = resolve(ROOT, "protocol/marina.http.v1.openapi.json");
/** The Python SDK's operation table, generated from the same operations. */
export const PYTHON_OPERATIONS_FILE = resolve(ROOT, "sdks/python/src/marina/_operations.py");
/** The Java SDK's operation table. */
export const JAVA_OPERATIONS_FILE = resolve(
  ROOT,
  "sdks/java/src/main/java/ai/h2o/marina/Operations.java",
);

/** The SDK files whose exported types describe HTTP bodies. */
export const OPENAPI_TYPE_SOURCES = [
  "memory-types",
  "memory-transfer",
  "memory-assistance",
  "memory-symbolic",
  "memory-knowledge-graph",
  "memory-workflows",
  "memory-answer",
  "memory-expansion",
  "memory-recipes",
  "routing-types",
  "routing-runtime-types",
  "routing-client",
  "investigation-types",
  "panel-client",
  "panel-document",
  "panel-events",
  "panel-resources",
  "panel-resource-catalog",
].map((name) => resolve(ROOT, `src/sdk/${name}.ts`));

const TAGS: Record<HttpApiTag, { description: string; security: string; error: string }> = {
  memory: {
    description:
      "Durable, versioned, cited memory. Spaces hold records (claims with versions and validity) and sources (raw evidence). Every write except the listed read-like POSTs needs an `Idempotency-Key`; resending the same key replays the first result.",
    security: "memoryCredential",
    error: "MemoryError",
  },
  routing: {
    description:
      "Participant routing: join as a session, publish output, message other sessions, read channels, and supervise native agent runtimes.",
    security: "worldSession",
    error: "ApiError",
  },
  investigations: {
    description:
      "Investigations: a question run as a case with attempts, events, a selected answer, and (for predictions) a scored outcome.",
    security: "worldSession",
    error: "ApiError",
  },
  panels: {
    description:
      "Published panels: A2UI documents on a canvas that people and agents read and press. Live changes arrive on the `/dashboard-ws` WebSocket.",
    security: "worldSession",
    error: "PanelError",
  },
};

const ERRORS: Record<string, JsonSchema> = {
  MemoryError: {
    type: "object",
    description: "Every memory API failure.",
    properties: {
      error: {
        type: "object",
        properties: {
          code: { type: "string", description: "Stable, machine-readable: branch on this." },
          message: { type: "string", description: "For people; wording may change." },
          retry_after_ms: {
            type: "number",
            description:
              "When present, wait this long before retrying (exact; `Retry-After` is whole seconds).",
          },
        },
        required: ["code", "message"],
      },
    },
    required: ["error"],
  },
  ApiError: {
    type: "object",
    description: "A routing or investigations failure.",
    properties: {
      error: { type: "string", description: "For people; wording may change." },
      code: { type: "string", description: "Stable, machine-readable: branch on this." },
    },
    required: ["error"],
  },
  PanelError: {
    type: "object",
    description: "A canvas or panel failure. `code` is present on some failures only.",
    properties: { error: { type: "string" }, code: { type: "string" } },
    required: ["error"],
  },
};

const pascal = (id: string) => id[0]!.toUpperCase() + id.slice(1);

export function openApiDocument(): Record<string, unknown> {
  const types = new TypeSchemas(OPENAPI_TYPE_SOURCES);
  const named: Record<string, JsonSchema> = {};
  /** A plain type name stays a `$ref`; a composed type gets a component of its own. */
  const schemaFor = (source: string, name: string): JsonSchema => {
    if (/^[A-Z]\w*$/.test(source) && types.has(source)) return types.ref(source);
    named[name] = types.expression(source);
    return { $ref: `#/components/schemas/${name}` };
  };

  const paths: Record<string, Record<string, unknown>> = {};
  const ids = new Set<string>();
  for (const op of HTTP_OPERATIONS) {
    if (ids.has(op.id)) throw new Error(`Duplicate operation id ${op.id}`);
    ids.add(op.id);
    const tag = TAGS[op.tag];
    const parameters: Record<string, unknown>[] = [];
    for (const name of op.path.match(/\{(\w+)\}/g) ?? [])
      parameters.push({
        name: name.slice(1, -1),
        in: "path",
        required: true,
        schema: { type: "string" },
      });
    for (const [name, query] of Object.entries(op.query ?? {}))
      parameters.push({
        name,
        in: "query",
        required: query.required ?? false,
        ...(query.description ? { description: query.description } : {}),
        schema: { type: query.type },
      });
    if (op.tag === "memory" && memoryNeedsIdempotencyKey(op.method, op.path))
      parameters.push({ $ref: "#/components/parameters/IdempotencyKey" });
    const statuses = Array.isArray(op.status) ? op.status : [op.status ?? 200];
    const reply = schemaFor(op.response, `${pascal(op.id)}Response`);
    const responses: Record<string, unknown> = {};
    for (const status of statuses)
      responses[String(status)] = {
        description:
          statuses.length > 1
            ? status === 200
              ? "Done (or replayed: the same request was already done)."
              : "Created or accepted."
            : "Done.",
        content: { "application/json": { schema: reply } },
      };
    if (op.tag === "memory" || op.tag === "routing")
      responses["429"] = { $ref: `#/components/responses/RateLimited${pascal(op.tag)}` };
    responses.default = {
      description: "Failure.",
      content: { "application/json": { schema: { $ref: `#/components/schemas/${tag.error}` } } },
    };
    paths[op.path] ??= {};
    paths[op.path]![op.method.toLowerCase()] = {
      operationId: op.id,
      tags: [op.tag],
      summary: op.summary,
      ...(op.description ? { description: op.description } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(op.body
        ? {
            requestBody: {
              required: true,
              content: {
                "application/json": { schema: schemaFor(op.body, `${pascal(op.id)}Request`) },
              },
            },
          }
        : {}),
      responses,
      security: [{ [tag.security]: [] }],
    };
  }

  const schemas = Object.fromEntries(
    [...types.used.entries(), ...Object.entries(named), ...Object.entries(ERRORS)].sort(
      ([a], [b]) => a.localeCompare(b),
    ),
  );
  return {
    openapi: "3.1.0",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: {
      title: "Marina HTTP API",
      version: HTTP_API_VERSION,
      description: [
        "The HTTP APIs of a Marina server: memory, participant routing, investigations and published panels.",
        `Live sessions (commands, coding runs, world events) use the WebSocket protocol instead: \`${WIRE_SCHEMA_PATH}\`.`,
        `A running server serves this document at \`${HTTP_API_SCHEMA_PATH}\`. Guide: protocol/http.md.`,
        "",
        "Replies may gain fields within v1: ignore what you do not know.",
      ].join("\n"),
      license: { name: "Apache-2.0", identifier: "Apache-2.0" },
    },
    servers: [{ url: "http://localhost:3300", description: "A local Marina (`marina start`)" }],
    tags: Object.entries(TAGS).map(([name, tag]) => ({ name, description: tag.description })),
    paths,
    components: {
      schemas,
      parameters: {
        IdempotencyKey: {
          name: "Idempotency-Key",
          in: "header",
          required: true,
          description:
            "1-128 characters, unique per intended write. Resend the same key to retry safely: the first result is replayed.",
          schema: { type: "string", minLength: 1, maxLength: 128 },
        },
      },
      responses: {
        RateLimitedMemory: {
          description:
            "Over the request budget (100 burst, 25/s per principal). Wait `retry_after_ms`.",
          headers: { "Retry-After": { schema: { type: "string" } } },
          content: { "application/json": { schema: { $ref: "#/components/schemas/MemoryError" } } },
        },
        RateLimitedRouting: {
          description: "Too many requests. Wait `Retry-After` seconds.",
          headers: { "Retry-After": { schema: { type: "string" } } },
          content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
        },
      },
      securitySchemes: {
        memoryCredential: {
          type: "http",
          scheme: "bearer",
          description:
            "A scoped memory credential (audience `marina:memory`), not a world session token.",
        },
        worldSession: {
          type: "http",
          scheme: "bearer",
          description:
            "A world session token: the `token` from a WebSocket login, or a supervision credential (routing only).",
        },
      },
    },
  };
}

export function renderOpenApi(): string {
  return `${JSON.stringify(openApiDocument(), null, 2)}\n`;
}

/** snake_case of an operation id: `joinSession` → `join_session`. */
export function snakeCase(id: string): string {
  return id.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/**
 * The Python SDK's table: snake_case name → (operation id, method, path, tag, path params,
 * query params, takes a body, needs an Idempotency-Key).
 */
export function renderPythonOperations(): string {
  const rows = HTTP_OPERATIONS.map((op) => {
    const pathParams = (op.path.match(/\{(\w+)\}/g) ?? []).map((p) => p.slice(1, -1));
    const query = Object.keys(op.query ?? {});
    const key = op.tag === "memory" && memoryNeedsIdempotencyKey(op.method, op.path);
    const tuple = (items: string[]) =>
      items.length ? `(${items.map((i) => JSON.stringify(i)).join(", ")},)` : "()";
    return `    ${JSON.stringify(snakeCase(op.id))}: Operation(${[
      JSON.stringify(op.id),
      JSON.stringify(op.method),
      JSON.stringify(op.path),
      JSON.stringify(op.tag),
      tuple(pathParams),
      tuple(query),
      op.body ? "True" : "False",
      key ? "True" : "False",
    ].join(", ")}),`;
  });
  return [
    "# Copyright 2025-2026 H2O.ai, Inc.",
    "# SPDX-License-Identifier: Apache-2.0",
    `"""Every ${HTTP_API_VERSION} operation. Generated from src/protocol/http-api.ts by`,
    'scripts/generate-openapi.ts (`bun run docs:api`); do not edit by hand."""',
    "",
    "from typing import NamedTuple",
    "",
    "",
    "class Operation(NamedTuple):",
    "    id: str",
    "    method: str",
    "    path: str",
    "    tag: str",
    "    path_params: tuple",
    "    query: tuple",
    "    body: bool",
    "    idempotency_key: bool",
    "",
    "",
    `HTTP_API_VERSION = ${JSON.stringify(HTTP_API_VERSION)}`,
    "",
    "OPERATIONS = {",
    ...rows,
    "}",
    "",
  ].join("\n");
}

/** The Java SDK's table: operation id → Operation(method, path, tag, params, body, key). */
export function renderJavaOperations(): string {
  const list = (items: string[]) => `List.of(${items.map((i) => JSON.stringify(i)).join(", ")})`;
  const rows = HTTP_OPERATIONS.map((op) => {
    const pathParams = (op.path.match(/\{(\w+)\}/g) ?? []).map((p) => p.slice(1, -1));
    const query = Object.keys(op.query ?? {});
    const key = op.tag === "memory" && memoryNeedsIdempotencyKey(op.method, op.path);
    return `    add(new Operation(${[
      JSON.stringify(op.id),
      JSON.stringify(op.method),
      JSON.stringify(op.path),
      JSON.stringify(op.tag),
      list(pathParams),
      list(query),
      String(Boolean(op.body)),
      String(key),
    ].join(", ")}));`;
  });
  return [
    "// Copyright 2025-2026 H2O.ai, Inc.",
    "// SPDX-License-Identifier: Apache-2.0",
    "package ai.h2o.marina;",
    "",
    "import java.util.Collections;",
    "import java.util.LinkedHashMap;",
    "import java.util.List;",
    "import java.util.Map;",
    "",
    "/**",
    ` * Every ${HTTP_API_VERSION} operation, by operation id. Generated from src/protocol/http-api.ts by`,
    " * scripts/generate-openapi.ts ({@code bun run docs:api}); do not edit by hand.",
    " */",
    "public final class Operations {",
    "  private Operations() {}",
    "",
    "  /** One HTTP operation. */",
    "  public record Operation(",
    "      String id,",
    "      String method,",
    "      String path,",
    "      String tag,",
    "      List<String> pathParams,",
    "      List<String> query,",
    "      boolean body,",
    "      boolean idempotencyKey) {}",
    "",
    `  public static final String HTTP_API_VERSION = ${JSON.stringify(HTTP_API_VERSION)};`,
    "",
    "  private static final Map<String, Operation> BY_ID = new LinkedHashMap<>();",
    "",
    "  private static void add(Operation op) {",
    "    BY_ID.put(op.id(), op);",
    "  }",
    "",
    "  static {",
    ...rows,
    "  }",
    "",
    "  /** Every operation, by id, in the order of the OpenAPI document. */",
    "  public static final Map<String, Operation> ALL = Collections.unmodifiableMap(BY_ID);",
    "}",
    "",
  ].join("\n");
}

function writeOrCheck(file: string, output: string, check: boolean, what: string): void {
  if (check) {
    let current = "";
    try {
      current = readFileSync(file, "utf8");
    } catch {
      // allow-empty-catch: a missing file is stale, reported below
    }
    if (current !== output) throw new Error(`${what} is stale; run bun run docs:api.`);
    return;
  }
  writeFileSync(file, output);
}

export function generateOpenApi(check: boolean): void {
  writeOrCheck(OPENAPI_FILE, renderOpenApi(), check, "OpenAPI document");
  writeOrCheck(
    PYTHON_OPERATIONS_FILE,
    renderPythonOperations(),
    check,
    "Python SDK operation table",
  );
  writeOrCheck(JAVA_OPERATIONS_FILE, renderJavaOperations(), check, "Java SDK operation table");
}

if (import.meta.main) generateOpenApi(process.argv.includes("--check"));
