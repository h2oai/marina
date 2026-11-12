// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// TypeScript declarations → JSON Schema (2020-12), for the published HTTP API.
//
// The SDK's interfaces are the one typed source of the HTTP bodies: the server
// imports them too. This reads those declarations from source (no compiler API)
// and emits one schema per named type, `$ref`-linked. It handles what the SDK's
// wire types use — interfaces (with `extends`), aliases, unions, intersections,
// literals, arrays, tuples, Record, Partial/Pick/Omit/Readonly, `keyof`,
// `typeof CONST[number]`, `import("./x").T` — and throws on anything else, so a
// new construct is a loud generator error, never a silently wrong schema.

import { readFileSync } from "node:fs";
import { parse } from "@babel/parser";

// biome-ignore lint/suspicious/noExplicitAny: Babel AST nodes are walked structurally.
type Node = any;
export type JsonSchema = Record<string, unknown>;

interface Declaration {
  name: string;
  file: string;
  node: Node;
  description?: string;
}

interface ObjectShape {
  properties: Record<string, JsonSchema>;
  required: string[];
  additionalProperties?: JsonSchema;
}

function docComment(node: Node): string | undefined {
  const comment = (node?.leadingComments ?? []).at(-1);
  if (comment?.type !== "CommentBlock" || !comment.value.startsWith("*")) return;
  const text = comment.value
    .split("\n")
    .map((line: string) => line.replace(/^\s*\*+ ?/, "").trimEnd())
    .join("\n")
    .trim();
  return text || undefined;
}

/** The named declarations of a set of TypeScript files, converted on demand. */
export class TypeSchemas {
  private readonly declarations = new Map<string, Declaration>();
  private readonly constants = new Map<string, Node>();
  /** Named types reached so far, in the order they were first referenced. */
  readonly used = new Map<string, JsonSchema>();
  private readonly converting = new Set<string>();

  constructor(
    files: string[],
    private readonly refPrefix = "#/components/schemas/",
  ) {
    for (const file of files) this.load(file);
  }

  private load(file: string) {
    const ast = parse(readFileSync(file, "utf8"), {
      sourceType: "module",
      plugins: ["typescript"],
      attachComment: true,
    });
    for (const statement of ast.program.body) {
      const node = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
      if (!node) continue;
      const description = docComment(statement) ?? docComment(node);
      if (node.type === "TSInterfaceDeclaration" || node.type === "TSTypeAliasDeclaration") {
        const name = node.id.name as string;
        const existing = this.declarations.get(name);
        if (existing && existing.file !== file)
          throw new Error(`${name} is declared in both ${existing.file} and ${file}`);
        this.declarations.set(name, { name, file, node, description });
      } else if (node.type === "VariableDeclaration") {
        for (const declarator of node.declarations)
          if (declarator.id.type === "Identifier" && declarator.init)
            this.constants.set(declarator.id.name, declarator.init);
      }
    }
  }

  has(name: string): boolean {
    return this.declarations.has(name);
  }

  /** `$ref` to a named type, converting it (and what it reaches) once. */
  ref(name: string): JsonSchema {
    const declaration = this.declarations.get(name);
    if (!declaration) throw new Error(`Unknown type ${name}`);
    if (!this.used.has(name) && !this.converting.has(name)) {
      this.converting.add(name);
      const node = declaration.node;
      const schema =
        node.type === "TSInterfaceDeclaration"
          ? this.objectSchema(this.interfaceShape(declaration))
          : this.convert(node.typeAnnotation, declaration.file);
      if (node.typeParameters) throw new Error(`${name}: generic types are not supported`);
      this.used.set(
        name,
        declaration.description ? { description: declaration.description, ...schema } : schema,
      );
      this.converting.delete(name);
    }
    return { $ref: `${this.refPrefix}${name}` };
  }

  /** A TypeScript type written as text (e.g. `MemoryReceipt & { removed: boolean }`). */
  expression(source: string): JsonSchema {
    const ast = parse(`type __T = ${source};`, { sourceType: "module", plugins: ["typescript"] });
    return this.convert((ast.program.body[0] as Node).typeAnnotation, `<expression ${source}>`);
  }

  private objectSchema(shape: ObjectShape): JsonSchema {
    return {
      type: "object",
      properties: shape.properties,
      ...(shape.required.length ? { required: shape.required } : {}),
      ...(shape.additionalProperties ? { additionalProperties: shape.additionalProperties } : {}),
    };
  }

  private interfaceShape(declaration: Declaration): ObjectShape {
    const node = declaration.node;
    const shape: ObjectShape = { properties: {}, required: [] };
    for (const heritage of node.extends ?? []) {
      if (
        heritage.expression.type !== "Identifier" ||
        (heritage.typeArguments ?? heritage.typeParameters)
      )
        throw new Error(`${declaration.name}: unsupported extends clause`);
      merge(shape, this.shapeOfNamed(heritage.expression.name, declaration.file));
    }
    merge(shape, this.members(node.body.body, declaration.file, declaration.name));
    return shape;
  }

  private members(members: Node[], file: string, owner: string): ObjectShape {
    const shape: ObjectShape = { properties: {}, required: [] };
    for (const member of members) {
      if (member.type === "TSIndexSignature") {
        shape.additionalProperties = this.convert(member.typeAnnotation.typeAnnotation, file);
        continue;
      }
      if (member.type !== "TSPropertySignature")
        throw new Error(`${owner}: unsupported member ${member.type} in ${file}`);
      const key = member.key.type === "Identifier" ? member.key.name : member.key.value;
      if (typeof key !== "string") throw new Error(`${owner}: computed keys are not supported`);
      let schema = this.convert(member.typeAnnotation.typeAnnotation, file);
      const description = docComment(member);
      if (description) schema = { description, ...schema };
      shape.properties[key] = schema;
      if (!member.optional) shape.required.push(key);
    }
    return shape;
  }

  /** The flat object shape of a named type (for extends, Pick, Omit, Partial). */
  private shapeOfNamed(name: string, file: string): ObjectShape {
    const declaration = this.declarations.get(name);
    if (!declaration) throw new Error(`Unknown type ${name} (from ${file})`);
    if (declaration.node.type === "TSInterfaceDeclaration") return this.interfaceShape(declaration);
    return this.shapeOf(declaration.node.typeAnnotation, declaration.file);
  }

  private shapeOf(node: Node, file: string): ObjectShape {
    switch (node.type) {
      case "TSTypeLiteral":
        return this.members(node.members, file, "<literal>");
      case "TSParenthesizedType":
        return this.shapeOf(node.typeAnnotation, file);
      case "TSIntersectionType": {
        const shape: ObjectShape = { properties: {}, required: [] };
        for (const part of node.types) merge(shape, this.shapeOf(part, file));
        return shape;
      }
      case "TSTypeReference": {
        const name = typeName(node.typeName);
        const args = (node.typeArguments ?? node.typeParameters)?.params ?? [];
        if (name === "Readonly") return this.shapeOf(args[0], file);
        if (name === "Partial") return { ...this.shapeOf(args[0], file), required: [] };
        if (name === "Pick" || name === "Omit") {
          const base = this.shapeOf(args[0], file);
          const keys = new Set(this.literalStrings(args[1], file));
          const keep = (key: string) => (name === "Pick" ? keys.has(key) : !keys.has(key));
          return {
            properties: Object.fromEntries(
              Object.entries(base.properties).filter(([key]) => keep(key)),
            ),
            required: base.required.filter(keep),
          };
        }
        if (name === "Record") {
          const value = this.convert(args[1], file);
          if (this.convert(args[0], file).type !== "string")
            throw new Error(`${file}: Record with literal keys inside an intersection`);
          // Record<string, unknown> adds nothing: objects are open.
          return Object.keys(value).length
            ? { properties: {}, required: [], additionalProperties: value }
            : { properties: {}, required: [] };
        }
        if (name === "Extract")
          return this.shapeOf(this.extractMember(args[0], args[1], file), file);
        if (args.length) throw new Error(`Cannot take the shape of ${name}<…> in ${file}`);
        return this.shapeOfNamed(name, file);
      }
      case "TSImportType":
        return this.shapeOfNamed(importedName(node), file);
    }
    throw new Error(`Cannot take an object shape of ${node.type} in ${file}`);
  }

  /** The type node a reference names, through parentheses and aliases. */
  private resolveNode(node: Node): Node {
    while (true) {
      if (node.type === "TSParenthesizedType") node = node.typeAnnotation;
      else if (
        node.type === "TSTypeReference" &&
        !(node.typeArguments ?? node.typeParameters) &&
        this.declarations.get(typeName(node.typeName))?.node.type === "TSTypeAliasDeclaration"
      )
        node = this.declarations.get(typeName(node.typeName))!.node.typeAnnotation;
      else return node;
    }
  }

  /** `Extract<Union, { kind: "x" }>`: the one member whose discriminant matches. */
  private extractMember(unionNode: Node, filterNode: Node, file: string): Node {
    const union = this.resolveNode(unionNode);
    if (union.type !== "TSUnionType") throw new Error(`${file}: Extract needs a union`);
    const filter = this.shapeOf(filterNode, file).properties;
    const matches = union.types.filter((member: Node) => {
      const properties = this.shapeOf(member, file).properties;
      return Object.entries(filter).every(([key, value]) => properties[key]?.const === value.const);
    });
    if (matches.length !== 1) throw new Error(`${file}: Extract matched ${matches.length} members`);
    return matches[0];
  }

  private literalStrings(node: Node, file: string): string[] {
    const schema = this.convert(this.resolveNode(node), file);
    if (typeof schema.const === "string") return [schema.const];
    if (Array.isArray(schema.enum)) return schema.enum as string[];
    throw new Error(`Expected string literal keys in ${file}`);
  }

  private constantValue(name: string, file: string): unknown {
    let init = this.constants.get(name);
    if (!init) throw new Error(`Unknown constant ${name} (from ${file})`);
    while (init.type === "TSAsExpression" || init.type === "TSSatisfiesExpression")
      init = init.expression;
    const value = (node: Node): unknown => {
      if (node.type === "StringLiteral" || node.type === "NumericLiteral") return node.value;
      if (node.type === "BooleanLiteral") return node.value;
      if (node.type === "ArrayExpression") return node.elements.map(value);
      throw new Error(`Constant ${name}: unsupported initializer ${node.type}`);
    };
    return value(init);
  }

  convert(node: Node, file: string): JsonSchema {
    switch (node.type) {
      case "TSStringKeyword":
        return { type: "string" };
      case "TSNumberKeyword":
        return { type: "number" };
      case "TSBooleanKeyword":
        return { type: "boolean" };
      case "TSNullKeyword":
        return { type: "null" };
      case "TSUnknownKeyword":
      case "TSAnyKeyword":
      case "TSObjectKeyword":
        return node.type === "TSObjectKeyword" ? { type: "object" } : {};
      case "TSNeverKeyword":
        return { not: {} };
      case "TSParenthesizedType":
        return this.convert(node.typeAnnotation, file);
      case "TSLiteralType": {
        const literal = node.literal;
        if (literal.type === "TemplateLiteral") return { type: "string" };
        if (literal.type === "UnaryExpression") return { const: -literal.argument.value };
        return { const: literal.value };
      }
      case "TSTemplateLiteralType":
        return { type: "string" };
      case "TSArrayType":
        return { type: "array", items: this.convert(node.elementType, file) };
      case "TSTupleType":
        return {
          type: "array",
          prefixItems: node.elementTypes.map((element: Node) =>
            this.convert(
              element.type === "TSNamedTupleMember" ? element.elementType : element,
              file,
            ),
          ),
          minItems: node.elementTypes.length,
          maxItems: node.elementTypes.length,
        };
      case "TSTypeOperator":
        if (node.operator === "readonly") return this.convert(node.typeAnnotation, file);
        if (node.operator === "keyof") {
          const shape = this.shapeOf(node.typeAnnotation, file);
          return { type: "string", enum: Object.keys(shape.properties) };
        }
        break;
      case "TSTypeLiteral":
        return this.objectSchema(this.members(node.members, file, "<literal>"));
      case "TSUnionType":
        return union(
          node.types
            .filter((part: Node) => part.type !== "TSUndefinedKeyword")
            .map((part: Node) => this.convert(part, file)),
        );
      case "TSIntersectionType":
        // An intersection with a union (`{ origin } & ({ kind: "a" } | { kind: "b" })`)
        // has no single object shape: each part must hold.
        if (node.types.some((part: Node) => this.resolveNode(part).type === "TSUnionType"))
          return { allOf: node.types.map((part: Node) => this.convert(part, file)) };
        return this.objectSchema(this.shapeOf(node, file));
      case "TSImportType":
        return this.ref(importedName(node));
      case "TSTypeQuery": {
        const value = this.constantValue(typeName(node.exprName), file);
        return { const: value };
      }
      case "TSIndexedAccessType": {
        const index = node.indexType;
        if (index.type === "TSNumberKeyword") {
          const object =
            node.objectType.type === "TSParenthesizedType"
              ? node.objectType.typeAnnotation
              : node.objectType;
          if (object.type === "TSTypeQuery") {
            const values = this.constantValue(typeName(object.exprName), file);
            if (!Array.isArray(values)) throw new Error(`${file}: typeof X[number] needs an array`);
            return { enum: values };
          }
          const element = this.convert(object, file);
          if (element.type === "array" && element.items) return element.items as JsonSchema;
        }
        if (index.type === "TSLiteralType" && typeof index.literal.value === "string") {
          const property = this.shapeOf(node.objectType, file).properties[index.literal.value];
          if (property) return property;
        }
        break;
      }
      case "TSTypeReference": {
        const name = typeName(node.typeName);
        const args = (node.typeArguments ?? node.typeParameters)?.params ?? [];
        switch (name) {
          case "Array":
          case "ReadonlyArray":
            return { type: "array", items: this.convert(args[0], file) };
          case "Record": {
            const value = this.convert(args[1], file);
            const key = this.convert(args[0], file);
            if (key.type === "string") return { type: "object", additionalProperties: value };
            const keys = this.literalStrings(args[0], file);
            return {
              type: "object",
              properties: Object.fromEntries(keys.map((k) => [k, value])),
              required: keys,
            };
          }
          case "Readonly":
            return this.convert(args[0], file);
          case "NonNullable":
            return withoutNull(this.convert(args[0], file));
          case "Partial":
          case "Pick":
          case "Omit":
            return this.objectSchema(this.shapeOf(node, file));
        }
        if (args.length) throw new Error(`${file}: unsupported generic ${name}<…>`);
        return this.ref(name);
      }
    }
    throw new Error(`${file}: unsupported type ${node.type}`);
  }
}

function typeName(node: Node): string {
  if (node.type === "Identifier") return node.name;
  if (node.type === "TSQualifiedName") return `${typeName(node.left)}.${node.right.name}`;
  throw new Error(`Unsupported type name ${node.type}`);
}

function importedName(node: Node): string {
  const qualifier = node.qualifier;
  if (!qualifier || (node.typeArguments ?? node.typeParameters))
    throw new Error("Unsupported import() type");
  return typeName(qualifier);
}

function merge(into: ObjectShape, from: ObjectShape) {
  Object.assign(into.properties, from.properties);
  for (const key of from.required) if (!into.required.includes(key)) into.required.push(key);
  if (from.additionalProperties) into.additionalProperties = from.additionalProperties;
}

function withoutNull(schema: JsonSchema): JsonSchema {
  if (Array.isArray(schema.anyOf)) {
    const rest = (schema.anyOf as JsonSchema[]).filter((part) => part.type !== "null");
    return rest.length === 1 ? rest[0]! : { ...schema, anyOf: rest };
  }
  if (Array.isArray(schema.type)) {
    const rest = (schema.type as string[]).filter((type) => type !== "null");
    return { ...schema, type: rest.length === 1 ? rest[0] : rest };
  }
  return schema;
}

/** A union as compact JSON Schema: literal sets become `enum`, `undefined` drops out. */
function union(parts: JsonSchema[]): JsonSchema {
  const flat = parts.flatMap((part) =>
    part.anyOf && Object.keys(part).length === 1 ? (part.anyOf as JsonSchema[]) : [part],
  );
  const literals = flat.filter((part) => "const" in part && Object.keys(part).length === 1);
  const others = flat.filter((part) => !literals.includes(part));
  const merged: JsonSchema[] = [];
  if (literals.length === 1) merged.push(literals[0]!);
  else if (literals.length > 1) merged.push({ enum: literals.map((part) => part.const) });
  const types = others.filter(
    (part) => typeof part.type === "string" && Object.keys(part).length === 1,
  );
  if (types.length > 1) merged.push({ type: types.map((part) => part.type) });
  else merged.push(...types);
  merged.push(...others.filter((part) => !types.includes(part)));
  return merged.length === 1 ? merged[0]! : { anyOf: merged };
}
