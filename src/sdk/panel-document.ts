// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Declarative content only: this contract never imports or executes publisher code. */
import { type PanelOperation, parsePanelOperation } from "./panel-actions";
import {
  isPanelValueBinding,
  PANEL_BINDABLE_PROPERTIES,
  type PanelSource,
  parsePanelSource,
} from "./panel-resources";

export { PANEL_BINDABLE_PROPERTIES };

export const PANEL_SCHEMA = "marina.panel.v1";
export const PANEL_LIMITS = { bytes: 262_144, components: 128, depth: 20, rendered: 512 } as const;
export const PANEL_COMPONENTS = [
  "Text",
  "Button",
  "TextField",
  "CheckBox",
  "DateTimeInput",
  "Row",
  "Column",
  "Card",
  "Surface",
  "DataTable",
  "Timeline",
  "Resource",
] as const;
export type A2UIComponentType = (typeof PANEL_COMPONENTS)[number];
/** A future component's type name: inert here, kept verbatim so a newer reader still has it. */
const UNKNOWN_COMPONENT_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/;
export function isKnownPanelComponent(component: { component?: unknown }): boolean {
  return PANEL_COMPONENTS.includes(component.component as A2UIComponentType);
}
export interface A2UIAction {
  componentId?: string;
  event: { name: string; payload?: Record<string, unknown> };
}
export interface A2UIComponent {
  id: string;
  /** A known type, or (read tolerantly) a newer Marina's type, drawn as a placeholder. */
  component: A2UIComponentType | string;
  child?: string;
  children?: string[];
  [key: string]: unknown;
}
export interface A2UINodeData {
  schema?: typeof PANEL_SCHEMA;
  components: A2UIComponent[];
  rootId?: string;
  dataModel?: Record<string, unknown>;
  sources?: Record<string, PanelSource>;
  title?: string;
  lastAction?: { name: string; payload?: Record<string, unknown>; timestamp: number };
}
export type PanelValidation = { ok: true; document: A2UINodeData } | { ok: false; error: string };
export interface PanelValidationOptions {
  /**
   * `placeholder` (default, readers): a component type this Marina does not know is kept
   * verbatim and inert, so a panel written by a newer Marina still draws everything else.
   * `refuse` (writers): the document is refused, naming the supported types.
   */
  unknownComponents?: "placeholder" | "refuse";
}

export function panelRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Also bounds nested metadata/payloads; JSON supplied by a caller is never trusted. */
function safeJson(value: unknown, seen: Set<object>, depth = 0): boolean {
  if (depth > 32) return false;
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  )
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const valid = Object.entries(value).every(
    ([key, child]) =>
      !["__proto__", "prototype", "constructor"].includes(key) && safeJson(child, seen, depth + 1),
  );
  seen.delete(value);
  return valid;
}

export function validPanelAction(value: unknown): value is A2UIAction {
  return (
    panelRecord(value) &&
    panelRecord(value.event) &&
    typeof value.event.name === "string" &&
    value.event.name.length > 0 &&
    value.event.name.length <= 128 &&
    (value.event.payload === undefined || panelRecord(value.event.payload))
  );
}

/** Normalize the two historically documented aliases; reject malformed documents as a unit. */
export function validatePanelDocument(
  input: unknown,
  options: PanelValidationOptions = {},
): PanelValidation {
  const tolerant = options.unknownComponents !== "refuse";
  const fail = (error: string): PanelValidation => ({ ok: false, error });
  if (!panelRecord(input)) return fail("Panel document must be an object.");
  if (!safeJson(input, new Set())) return fail("Panel contains unsafe or excessively nested data.");
  if (new TextEncoder().encode(JSON.stringify(input)).length > PANEL_LIMITS.bytes)
    return fail("Panel document exceeds 256 KiB.");
  if (input.schema !== undefined && input.schema !== PANEL_SCHEMA)
    return fail("Unsupported panel schema.");
  if (!Array.isArray(input.components) || input.components.length > PANEL_LIMITS.components)
    return fail("Panel requires at most 128 components.");
  if (input.title !== undefined && typeof input.title !== "string")
    return fail("Invalid panel title.");
  if (input.dataModel !== undefined && !panelRecord(input.dataModel))
    return fail("Invalid data model.");
  const sources: Record<string, PanelSource> = {};
  if (input.sources !== undefined) {
    if (!panelRecord(input.sources) || Object.keys(input.sources).length > 8)
      return fail("Panel supports at most eight live sources.");
    for (const [name, value] of Object.entries(input.sources)) {
      const source = parsePanelSource(value);
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name) || !source)
        return fail("Invalid panel source.");
      sources[name] = source;
    }
  }
  const components: A2UIComponent[] = [];
  const ids = new Set<string>();
  for (const source of input.components) {
    if (
      !panelRecord(source) ||
      typeof source.id !== "string" ||
      !source.id ||
      source.id.length > 128
    )
      return fail("Each component needs a nonempty id of at most 128 characters.");
    if (ids.has(source.id)) return fail(`Duplicate component id: ${source.id}`);
    ids.add(source.id);
    if (!isKnownPanelComponent(source)) {
      if (!tolerant || typeof source.component !== "string")
        return fail(
          `Unsupported component: ${String(source.component).slice(0, 128)}. Supported: ${PANEL_COMPONENTS.join(", ")}.`,
        );
      if (!UNKNOWN_COMPONENT_NAME.test(source.component))
        return fail(`Invalid component type in ${source.id}.`);
      // Inert: no renderer draws its fields, no binding writes outside the
      // bindable list, and the interaction route refuses it. Only its place
      // in the tree is checked, so its known children still draw.
      const unknown = { ...source } as A2UIComponent;
      if (unknown.child !== undefined && typeof unknown.child !== "string")
        return fail(`Invalid child in ${unknown.id}.`);
      if (
        unknown.children !== undefined &&
        (!Array.isArray(unknown.children) ||
          unknown.children.length > PANEL_LIMITS.components ||
          unknown.children.some((id) => typeof id !== "string") ||
          new Set(unknown.children).size !== unknown.children.length)
      )
        return fail(`Invalid children in ${unknown.id}.`);
      if (unknown.bindings !== undefined) {
        if (!panelRecord(unknown.bindings) || Object.keys(unknown.bindings).length > 8)
          return fail(`Invalid bindings in ${unknown.id}.`);
        for (const binding of Object.values(unknown.bindings))
          if (
            !isPanelValueBinding(binding) ||
            (binding.source !== "dataModel" && !Object.hasOwn(sources, binding.source))
          )
            return fail(`Invalid binding in ${unknown.id}.`);
      }
      components.push(unknown);
      continue;
    }
    const c = { ...source } as A2UIComponent;
    if (c.component === "Resource" && !parsePanelSource(c.reference))
      return fail(`Invalid resource in ${c.id}.`);
    if (c.bindings !== undefined) {
      if (!panelRecord(c.bindings) || Object.keys(c.bindings).length > 8)
        return fail(`Invalid bindings in ${c.id}.`);
      for (const [property, binding] of Object.entries(c.bindings)) {
        if (
          !(PANEL_BINDABLE_PROPERTIES as readonly string[]).includes(property) ||
          !isPanelValueBinding(binding) ||
          (binding.source !== "dataModel" && !Object.hasOwn(sources, binding.source))
        )
          return fail(`Invalid binding in ${c.id}.`);
      }
    }

    if (c.component === "Text" && c.text === undefined && typeof c.value === "string")
      c.text = c.value;
    if (c.component === "DataTable" && Array.isArray(c.columns))
      c.columns = c.columns.map((col) =>
        typeof col === "string" ? { key: col, label: col } : col,
      );
    for (const key of [
      "text",
      "title",
      "label",
      "placeholder",
      "fieldId",
      "variant",
      "gap",
      "align",
    ])
      if (c[key] !== undefined && typeof c[key] !== "string")
        return fail(`${c.id}.${key} must be text.`);
    if (
      (c.component === "TextField" || c.component === "DateTimeInput") &&
      c.value !== undefined &&
      typeof c.value !== "string"
    )
      return fail(`${c.id}.value must be text.`);
    for (const key of ["disabled", "checked"])
      if (c[key] !== undefined && typeof c[key] !== "boolean")
        return fail(`${c.id}.${key} must be boolean.`);
    if (c.child !== undefined && typeof c.child !== "string")
      return fail(`Invalid child in ${c.id}.`);
    if (
      c.children !== undefined &&
      (!Array.isArray(c.children) ||
        c.children.length > PANEL_LIMITS.components ||
        c.children.some((id) => typeof id !== "string") ||
        new Set(c.children).size !== c.children.length)
    )
      return fail(`Invalid children in ${c.id}.`);
    if (
      c.operation !== undefined &&
      (c.component !== "Button" || !parsePanelOperation(c.operation))
    )
      return fail(`Invalid operation in ${c.id}.`);
    if (c.action !== undefined && !validPanelAction(c.action))
      return fail(`Invalid action in ${c.id}.`);
    if (c.component === "DataTable") {
      if (
        c.columns !== undefined &&
        (!Array.isArray(c.columns) ||
          c.columns.length > 64 ||
          c.columns.some(
            (col) =>
              !panelRecord(col) || typeof col.key !== "string" || typeof col.label !== "string",
          ))
      )
        return fail(`Invalid columns in ${c.id}.`);
      if (
        c.rows !== undefined &&
        (!Array.isArray(c.rows) || c.rows.length > 500 || c.rows.some((row) => !panelRecord(row)))
      )
        return fail(`Invalid rows in ${c.id}.`);
    }
    if (
      c.component === "Timeline" &&
      c.items !== undefined &&
      (!Array.isArray(c.items) ||
        c.items.length > 500 ||
        c.items.some(
          (item) =>
            !panelRecord(item) ||
            typeof item.label !== "string" ||
            ["timestamp", "description"].some(
              (key) => item[key] !== undefined && typeof item[key] !== "string",
            ),
        ))
    )
      return fail(`Invalid timeline in ${c.id}.`);
    components.push(c);
  }
  const resources = new Set(Object.values(sources).map((source) => JSON.stringify(source)));
  for (const c of components)
    if (c.component === "Resource") resources.add(JSON.stringify(parsePanelSource(c.reference)));
  if (resources.size > 8) return fail("Panel supports at most eight distinct live resources.");
  for (const c of components) {
    const operation = c.component === "Button" ? parsePanelOperation(c.operation) : null;
    if (!operation) continue;
    const values =
      operation.kind === "message" ? [operation.message] : Object.values(operation.values ?? {});
    for (const value of values)
      if (
        typeof value === "object" &&
        !components.some(
          (field) =>
            field.id === value.field &&
            (["TextField", "DateTimeInput", "CheckBox"].includes(field.component) ||
              // A newer input type: the action stays visible and fails at the
              // server with a named reason (`panelFieldUnavailable`).
              (tolerant && !isKnownPanelComponent(field))),
        )
      )
        return fail(`Operation ${c.id} refers to an unknown input field.`);
  }
  const rootId = input.rootId ?? components[0]?.id;
  if (rootId !== undefined && (typeof rootId !== "string" || !ids.has(rootId)))
    return fail("Panel root does not identify a component.");
  const map = new Map(components.map((c) => [c.id, c]));
  const costs = new Map<string, { size: number; depth: number }>();
  const visiting = new Set<string>();
  function cost(id: string): { size: number; depth: number } | null {
    if (visiting.has(id)) return null;
    const cached = costs.get(id);
    if (cached) return cached;
    const c = map.get(id);
    if (!c || visiting.size >= PANEL_LIMITS.depth) return null;
    visiting.add(id);
    let size = 1;
    let depth = 1;
    for (const child of [...(c.child ? [c.child] : []), ...(c.children ?? [])]) {
      const next = cost(child);
      if (!next) return null;
      size += next.size;
      depth = Math.max(depth, next.depth + 1);
      if (size > PANEL_LIMITS.rendered || depth > PANEL_LIMITS.depth) return null;
    }
    visiting.delete(id);
    const result = { size, depth };
    costs.set(id, result);
    return result;
  }
  for (const c of components)
    if (!cost(c.id))
      return fail("Panel has a missing child, cycle or excessive rendering expansion.");
  return {
    ok: true,
    document: {
      ...(input.schema ? { schema: PANEL_SCHEMA } : {}),
      components,
      ...(typeof rootId === "string" ? { rootId } : {}),
      ...(typeof input.title === "string" ? { title: input.title } : {}),
      ...(panelRecord(input.dataModel) ? { dataModel: input.dataModel } : {}),
      ...(input.sources !== undefined ? { sources } : {}),
    },
  };
}

/**
 * The type of an input an operation reads that this Marina cannot draw (a
 * newer Marina's component), else null. The action is refused with that name
 * rather than asking for a field the person cannot see.
 */
export function panelFieldUnavailable(
  document: Pick<A2UINodeData, "components">,
  operation: PanelOperation,
): string | null {
  const values =
    operation.kind === "message" ? [operation.message] : Object.values(operation.values ?? {});
  for (const value of values) {
    if (typeof value !== "object") continue;
    const field = document.components.find((c) => c.id === value.field);
    if (field && !isKnownPanelComponent(field)) return String(field.component);
  }
  return null;
}
