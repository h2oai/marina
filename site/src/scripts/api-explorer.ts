// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
export {};

interface Schema {
  type?: string;
  const?: unknown;
  enum?: unknown[];
  anyOf?: Schema[];
  oneOf?: Schema[];
  properties?: Record<string, Schema>;
  required?: string[];
  minimum?: number;
  items?: Schema;
  description?: string;
}
interface Entry {
  name: string;
  description: string;
  content: unknown;
  schema?: Schema;
  source?: string;
  template?: string;
}
interface Reference {
  mcp: { name: string; description: string; inputSchema: Schema }[];
  commands: { name: string; help: string; forms?: { syntax: string }[] }[];
  http: { selector: string; source: string; line: number; guards: string[] }[];
  sdk: { name: string; declaration: string }[];
}
const reference = JSON.parse(document.querySelector("#api-data")!.textContent!) as Reference;
const surfaces: Record<string, Entry[]> = {
  mcp: reference.mcp.map((tool) => ({
    name: tool.name,
    description: tool.description,
    content: tool.inputSchema,
    schema: tool.inputSchema,
  })),
  commands: reference.commands.map((command) => ({
    name: command.name,
    description: command.help,
    content: command,
    template: command.forms?.[0]?.syntax,
  })),
  http: reference.http.map((route) => ({
    name: `${route.source}: ${route.selector}`,
    description:
      "Source dispatch conditions. Negative guards can reject a method; these are not complete OpenAPI operations.",
    content: route,
    source: `https://github.com/h2oai/marina/blob/main/${route.source}#L${route.line}`,
  })),
  sdk: reference.sdk.map((module) => ({
    name: module.name,
    description: "Published TypeScript declarations",
    content: module.declaration,
  })),
};
const surface = document.querySelector<HTMLSelectElement>("#surface")!;
const search = document.querySelector<HTMLInputElement>("#search")!;
const results = document.querySelector<HTMLElement>("#results")!;
const detail = document.querySelector<HTMLElement>("#detail")!;
const count = document.querySelector<HTMLElement>("#count")!;
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
};
function example(schema: Schema): unknown {
  if ("const" in schema) return schema.const;
  if (schema.enum) return schema.enum[0];
  if (schema.anyOf || schema.oneOf) return example((schema.anyOf ?? schema.oneOf)![0]!);
  if (schema.type === "object")
    return Object.fromEntries(
      (schema.required ?? []).map((name) => [name, example(schema.properties?.[name] ?? {})]),
    );
  if (schema.type === "array") return [];
  if (schema.type === "boolean") return false;
  if (schema.type === "number" || schema.type === "integer") return schema.minimum ?? 0;
  if (schema.type === "null") return null;
  return "";
}
function select(entry: Entry, button: HTMLButtonElement) {
  for (const item of results.querySelectorAll("button")) item.removeAttribute("aria-current");
  button.setAttribute("aria-current", "true");
  detail.replaceChildren(node("h2", entry.name), node("p", entry.description));
  history.replaceState(null, "", `#${surface.value}:${encodeURIComponent(entry.name)}`);
  if (entry.source) {
    const link = node("a", "Read the source handler");
    link.href = entry.source;
    detail.append(link);
  }
  if (entry.schema?.properties) {
    detail.append(node("h3", "Input fields"));
    for (const [name, field] of Object.entries(entry.schema.properties)) {
      const section = node("details");
      section.append(
        node(
          "summary",
          `${name} · ${entry.schema.required?.includes(name) ? "required" : "optional"}`,
        ),
      );
      if (field.description) section.append(node("p", field.description));
      section.append(node("pre", JSON.stringify(field, null, 2)));
      detail.append(section);
    }
    const label = node("label", "Request template — fill in your values");
    const input = node("textarea");
    input.value = JSON.stringify({ name: entry.name, arguments: example(entry.schema) }, null, 2);
    label.append(input);
    const copy = node("button", "Copy template");
    copy.type = "button";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(input.value);
        copy.textContent = "Copied";
      } catch {
        copy.textContent = "Select the template to copy";
        input.select();
      }
    });
    detail.append(node("h3", "MCP tools/call parameters"), label, copy);
  }
  if (entry.template) detail.append(node("h3", "Usage"), node("pre", entry.template));
  const full = node("details");
  full.append(
    node("summary", "Full contract"),
    node(
      "pre",
      typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content, null, 2),
    ),
  );
  detail.append(full);
}
function filter(preferred?: string) {
  const query = search.value.trim().toLowerCase();
  const entries = surfaces[surface.value]!.filter((entry) =>
    `${entry.name} ${entry.description}`.toLowerCase().includes(query),
  );
  count.textContent = `${entries.length} entries`;
  results.replaceChildren();
  detail.replaceChildren(
    node(
      "p",
      entries.length
        ? "Select an entry to inspect its contract."
        : "No matching entries. Try a broader search.",
    ),
  );
  for (const entry of entries) {
    const button = node("button", entry.name);
    button.type = "button";
    button.addEventListener("click", () => select(entry, button));
    results.append(button);
    if (entry.name === preferred) select(entry, button);
  }
}
search.addEventListener("input", () => filter());
surface.addEventListener("change", () => {
  search.value = "";
  filter();
});
const [initialSurface, ...name] = location.hash.slice(1).split(":");
if (initialSurface && Object.hasOwn(surfaces, initialSurface)) surface.value = initialSurface;
let initialName: string | undefined;
try {
  initialName = decodeURIComponent(name.join(":"));
} catch {
  initialName = undefined;
}
filter(initialName);
