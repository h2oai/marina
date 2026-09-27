// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { commandInputSchema } from "./command-schema";

export interface CommandField {
  id: string;
  label: string;
  placeholder: string;
  optionalGroup?: string;
  kind: "text" | "number" | "json" | "choice";
  choices?: string[];
  multiline: boolean;
  allowNewlines: boolean;
  min?: number;
  max?: number;
  default?: string;
}
interface Part {
  literal?: string;
  field?: string;
  group?: string;
  children?: Part[];
}
export interface CommandForm {
  /** Input for MCP invoke and any client that consumes JSON Schema. */
  inputSchema?: Record<string, unknown>;
  effect?: "read" | "write" | "delete" | "execute" | "unknown";
  description?: string;
  examples?: string[];
  syntax: string;
  label: string;
  fields: CommandField[];
  groups: Array<{ id: string; label: string; parent?: string }>;
  parts: Part[];
}
const FLAGS = new Set([
  "full",
  "persist",
  "agents",
  "time",
  "quiet",
  "raw",
  "all",
  "recent",
  "important",
  "trusted",
  "explain",
  "evidence",
  "force",
  "dry-run",
  "recursive",
  "yes",
  "bounty",
  "once",
  "discard",
  "archive",
]);
const REST =
  /message|text|body|content|prompt|title|description|desc|reason|summary|topic|query|expression|statements|actions?|goal|commands?|cmds|args|question|evidence|result|json|value|sentence|what |request|direction|notes?|task|req|choice|diff|additional |msg|desire|detail|explanation|instructions|interpretation|hypothesis|natural language|purpose|rationale|semantics|context|method|typescript source|last patch|last failed|\.\.\./i;
// Alternatives that name identifiers or examples are hints, not closed enums.
const ENUMS = new Set([
  "acp|mcp|cursor|zed|vscode|other",
  "completed|interrupted|failed",
  "directed|reciprocal",
  "grid|timeline|feed",
  "helpful|unhelpful|pass|fail|unknown",
  "higher|lower",
  "kalshi|polymarket",
  "map|reduce|synthesis|draft",
  "models|routes",
  "models|routes|autonomous|tools",
  "off|low|medium|high",
  "passed|failed|inconclusive",
  "prompt|auto|off",
  "reference|observe|submit",
  "recent|important|trusted|explain|evidence|all",
  "shell|network|secret|commit|spawn|other",
  "started|intervention|observation|measure|completed|failed|gap",
  "telegram|discord",
  "witnessed|replicated|disputed|unavailable",
  "yes|no",
  "manual|supervised|autonomous",
]);

/** Turn the platform's documented grammar into fields, optional groups and selectors. */
export function parseCommandForm(syntax: string): CommandForm {
  const fields: CommandField[] = [];
  const groups: CommandForm["groups"] = [];
  let cursor = 0;
  const field = (placeholder: string, group?: string, prefix = ""): Part[] => {
    const id = `field-${fields.length}`;
    const alternatives = placeholder.split("|").filter(Boolean);
    const numeric =
      /^(?:n|number|count|limit|offset|width|height|px|fps|duration-ms|version|importance|score|start|end|bytes|n-calls|tokens|frames|level|usd|cost-usd|fraction|amount|our-prob|market-price|limit-price-cents|0\.\.1)$/i.test(
        placeholder,
      );
    fields.push({
      id,
      placeholder,
      label: (prefix.replace(/^--/, "").replace(/[:=]$/, "") || placeholder)
        .replace(/[<>]/g, "")
        .replaceAll("_", " "),
      optionalGroup: group,
      kind: /json/i.test(placeholder)
        ? "json"
        : numeric || (syntax.startsWith("experiment record ") && placeholder === "value")
          ? "number"
          : ENUMS.has(placeholder)
            ? "choice"
            : "text",
      choices: alternatives.length > 1 ? alternatives : undefined,
      allowNewlines:
        /^code (?:write|edit|patch)\b/.test(syntax) &&
        /content|diff|old text|new text/.test(placeholder),
      multiline:
        REST.test(placeholder) &&
        !numeric &&
        !(syntax.startsWith("experiment record ") && placeholder === "value"),
    });
    return prefix ? [{ literal: prefix }, { field: id }] : [{ field: id }];
  };
  const parse = (end?: string, group?: string): Part[] => {
    const parts: Part[] = [];
    while (cursor < syntax.length) {
      const c = syntax[cursor]!;
      if (syntax.startsWith("\\n", cursor)) {
        cursor += 2;
        parts.push({ literal: "\n" });
        continue;
      }
      if (end && c === end) {
        cursor++;
        break;
      }
      if (/\s/.test(c)) {
        cursor++;
        continue;
      }
      if (c === "[") {
        const start = ++cursor;
        const id = `option-${groups.length}`;
        groups.push({ id, label: "", parent: group });
        const children = parse("]", id);
        const text = syntax.slice(start, cursor - 1);
        // Ungarnished [name] means an optional argument; known switches are literals.
        if (
          children.length === 1 &&
          children[0]?.literal &&
          !children[0].literal.startsWith("--") &&
          !FLAGS.has(children[0].literal.replace(/^--/, ""))
        ) {
          children.splice(0, 1, ...field(children[0].literal.replace(/\.\.\.$/, ""), id));
        } else if (children.every((part) => part.literal) && children.length > 1) {
          // Help often writes [arms A,B,...], [model provider/model], [start end].
          if (/^JSON/i.test(text) || text.startsWith("additional "))
            children.splice(0, children.length, ...field(text, id));
          else if (text === "start end")
            children.splice(0, children.length, ...field("start", id), ...field("end", id));
          else {
            const last = children.pop()!;
            children.push(...field(last.literal!, id));
            fields.at(-1)!.label = children[0]?.literal ?? last.literal!;
          }
        }
        groups.find((g) => g.id === id)!.label = text.replace(/[<>[\]]/g, "");
        parts.push({ group: id, children });
      } else if (c === "<") {
        const close = syntax.indexOf(">", cursor);
        const placeholder = syntax.slice(cursor + 1, close < 0 ? syntax.length : close);
        cursor = close < 0 ? syntax.length : close + 1;
        parts.push(...field(placeholder, group));
      } else {
        const start = cursor;
        while (
          cursor < syntax.length &&
          !/[\s<>[\]]/.test(syntax[cursor]!) &&
          !syntax.startsWith("\\n", cursor)
        )
          cursor++;
        if (cursor === start) {
          cursor++;
          continue;
        }
        const token = syntax.slice(start, cursor);
        if (group && /^[\w-]+[:=][^<>]+$/.test(token)) {
          const at = token.search(/[:=]/);
          parts.push(...field(token.slice(at + 1), group, token.slice(0, at + 1)));
        } else if (token.includes("|") && token !== "|") {
          const added = field(token, group);
          const f = fields.at(-1)!;
          f.kind = "choice";
          parts.push(...added);
        } else parts.push({ literal: token });
      }
    }
    return parts;
  };
  let parts = parse();
  if (syntax.startsWith("code write ")) {
    parts.splice(-1, 0, { literal: "\n" });
  } else if (syntax.startsWith("code patch ")) {
    parts.splice(-1, 0, { literal: "\n" });
  } else if (syntax.startsWith("code edit ")) {
    const newText = parts.pop()!;
    const oldText = parts.pop()!;
    parts = [
      ...parts,
      { literal: "\n" },
      { literal: "<<<<<<< OLD" },
      { literal: "\n" },
      oldText,
      { literal: "\n" },
      { literal: "=======" },
      { literal: "\n" },
      newText,
      { literal: "\n" },
      { literal: ">>>>>>> NEW" },
    ];
  }
  // Modifiers such as role:<role> use the literal prefix as the visible field name.
  const annotate = (items: Part[]) =>
    items.forEach((part, i) => {
      if (part.children) annotate(part.children);
      if (!part.field) return;
      const previous = items[i - 1]?.literal;
      if (previous?.match(/[:=]$/))
        fields.find((f) => f.id === part.field)!.label = previous.replace(/^--/, "").slice(0, -1);
    });
  annotate(parts);
  return { syntax, label: syntax, fields, groups, parts };
}

/** Compile the grammar declared beside a command; clients receive these descriptors. */
export type CommandUsage =
  | string
  | {
      syntax: string;
      description?: string;
      effect?: "read" | "write" | "delete" | "execute" | "unknown";
      examples?: string[];
      fields?: Record<string, Partial<CommandField>>;
    };
export function compileCommandForms(usage: readonly CommandUsage[]): CommandForm[] {
  return usage.map((entry) => {
    const spec = typeof entry === "string" ? { syntax: entry } : entry;
    const form = parseCommandForm(spec.syntax);
    form.effect = spec.effect ?? "unknown";
    form.description = spec.description;
    form.examples = spec.examples ?? [];
    form.fields = form.fields.map((field) => ({
      ...field,
      ...spec.fields?.[field.label],
      id: field.id,
    }));
    form.inputSchema = commandInputSchema(form);
    return form;
  });
}

/** Literal command/action prefix, stopping before any value or optional group. */
export function commandFormPrefix(form: CommandForm): string {
  const words: string[] = [];
  for (const part of form.parts) {
    if (!part.literal?.trim()) break;
    words.push(part.literal);
  }
  return words.join(" ");
}

/** Prefer the typed action, then its least restrictive complete form. */
export function matchCommandForm(forms: CommandForm[], input: string): CommandForm | undefined {
  const query = input.trimStart();
  const required = (form: CommandForm) =>
    form.fields.filter((field) => !field.optionalGroup && field.default === undefined).length;
  return forms
    .filter((form) => {
      const prefix = commandFormPrefix(form);
      return query === prefix || query.startsWith(`${prefix} `);
    })
    .sort(
      (a, b) =>
        commandFormPrefix(b).length - commandFormPrefix(a).length ||
        required(a) - required(b) ||
        b.groups.length - a.groups.length,
    )[0];
}

export function composeCommand(
  form: CommandForm,
  values: Record<string, string>,
  enabled: Record<string, boolean>,
): { command: string; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const emit = (parts: Part[]): Array<{ text: string; join: boolean }> =>
    parts.flatMap((part): Array<{ text: string; join: boolean }> => {
      if (part.group) return enabled[part.group] ? emit(part.children ?? []) : [];
      if (part.literal !== undefined)
        return [{ text: part.literal, join: /[:=]$/.test(part.literal) }];
      const f = form.fields.find((field) => field.id === part.field)!;
      const raw = values[f.id] ?? f.default ?? "";
      const value = f.allowNewlines ? raw : raw.trim();
      if (!value) errors[f.id] = "Required";
      else if (/[\r\n]/.test(value) && f.kind !== "json" && !f.allowNewlines)
        errors[f.id] = "Use a single line";
      else if (form.syntax.includes(" | ") && value.includes("|") && f.kind !== "json")
        errors[f.id] = "This field cannot contain a pipe separator";
      else if (!f.multiline && f.kind !== "choice" && /\s/.test(value))
        errors[f.id] = "Use one value without spaces";
      else if (f.kind === "number" && !Number.isFinite(Number(value)))
        errors[f.id] = "Enter a number";
      else if (
        f.kind === "number" &&
        ((f.min !== undefined && Number(value) < f.min) ||
          (f.max !== undefined && Number(value) > f.max))
      )
        errors[f.id] = `Enter a number between ${f.min ?? "−∞"} and ${f.max ?? "∞"}`;
      else if (f.kind === "choice" && !f.choices?.includes(value))
        errors[f.id] = "Choose one of the available values";
      else if (f.kind === "json") {
        try {
          const parsed = JSON.parse(value);
          if (/scalar/i.test(f.placeholder) && parsed !== null && typeof parsed === "object")
            errors[f.id] = "Enter a JSON string, number, boolean, or null";
        } catch {
          errors[f.id] = "Enter valid JSON";
        }
      }
      return [
        {
          text:
            f.kind === "json" && value && !errors[f.id] ? JSON.stringify(JSON.parse(value)) : value,
          join: false,
        },
      ];
    });
  const pieces = emit(form.parts);
  // Modifier prefixes and their fields form one token; ordinary arguments stay separated.
  let command = "";
  let join = true;
  for (const piece of pieces) {
    command += `${join || piece.text === "\n" || piece.text === ":" || piece.text === "=" ? "" : " "}${piece.text}`;
    join = piece.join || piece.text === "\n";
  }
  return { command, errors };
}
