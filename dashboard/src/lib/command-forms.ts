// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { CommandCatalogEntry } from "../../../src/net/discovery-types";
import { COMMAND_USAGE } from "./command-usage";

export interface CommandField {
  id: string;
  label: string;
  placeholder: string;
  optionalGroup?: string;
  kind: "text" | "number" | "json" | "choice";
  choices?: string[];
  multiline: boolean;
  allowNewlines: boolean;
}
interface Part {
  literal?: string;
  field?: string;
  group?: string;
  children?: Part[];
}
export interface CommandForm {
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

function stripProse(value: string): string {
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (char === "<" || char === "[") depth++;
    if (char === ">" || char === "]") depth--;
    if (
      depth === 0 &&
      i > 0 &&
      /\s/.test(value[i - 1]!) &&
      /^[A-Z][a-z]{2,}\b/.test(value.slice(i))
    )
      return value.slice(0, i).trim();
  }
  return value;
}

function variants(source: string, name: string): string[] {
  // A separator between commands is distinct from a literal pipe between fields.
  const split = source.split(new RegExp(`\\s+\\|\\s+(?=${name}(?:\\s|$))`, "g"));
  return split.flatMap((line) => {
    if (/^code edit\b/.test(line)) return ["code edit <path> [all] <old text> <new text>"];
    if (/^code write\b/.test(line)) return ["code write <path> <content>"];
    if (/^code patch\b/.test(line)) return ["code patch [title] <diff>"];
    if (/^code artifacts \[recent\|/.test(line)) return [];
    const syntax = stripProse(
      line
        .split("\n")[0]!
        .trim()
        .replace(/\s{2,}.*$/, "")
        .replace(/\s+\([\s\S]*$/, "")
        .replace(/\s+[—#][\s\S]*$/, "")
        .replace(/(?<!\.)[.;]$/, "")
        .replace(
          /\s+(?:Enter|Show|List|Create|Apply|Start|Stop|Run|View|Open|Close|Set|Get|Delete|Remove|Inspect|Read|Write|Launch|Resume|Switch|Use|Return|Check|Approve|Reject|Manage|Export|Import|Send|Save|Print|Attach|Cancel|Preview|Choose|Display|End|Clear|Delegate|Configure)\b[\s\S]*$/,
          "",
        ),
    ).replace(/[.;]$/, "");
    if (!syntax.startsWith(name) || syntax.includes("${") || !syntax) return [];
    const optionalAction = syntax.match(/^([a-z-]+(?: [a-z-]+)?) \[([a-z-]+(?:\|[a-z-]+)+)\]$/);
    if (optionalAction)
      return [
        optionalAction[1]!,
        ...optionalAction[2]!.split("|").map((action) => `${optionalAction[1]} ${action}`),
      ];
    // Expand literal subcommand choices, including project <name> a|b.
    let result = [syntax];
    const choices = [
      ...syntax.matchAll(/(?<=^|\s)[a-z][a-z0-9_-]*(?:\|[a-z][a-z0-9_-]*)+(?=\s|$)/g),
    ];
    for (const match of choices.reverse()) {
      const prefix = syntax.slice(0, match.index);
      const depth = [...prefix].reduce(
        (n, c) => n + ("<[".includes(c) ? 1 : ">]".includes(c) ? -1 : 0),
        0,
      );
      if (depth !== 0) continue;
      result = result
        .flatMap((line) =>
          match[0]
            .split("|")
            .map(
              (choice) =>
                line.slice(0, match.index) + choice + line.slice(match.index! + match[0].length),
            ),
        )
        .slice(0, 128);
    }
    return result;
  });
}

function helpSyntax(command: Pick<CommandCatalogEntry, "name" | "help">, expand = true): string[] {
  const result: string[] = [];
  let examples = false;
  for (const raw of command.help.split("\n")) {
    if (/^Examples?:/i.test(raw.trim())) {
      examples = true;
      continue;
    }
    if (examples) continue;
    const usage = raw.match(/(?:Usage|Subcommands):\s*(.*)/i)?.[1];
    const line = usage ?? raw.trim();
    if (line === command.name || line.startsWith(`${command.name} `))
      result.push(...(expand ? variants(line, command.name) : [line]));
  }
  return result;
}

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

export function commandForms(command: Pick<CommandCatalogEntry, "name" | "help">): CommandForm[] {
  const supplements = COMMAND_USAGE[command.name] ?? [];
  const syntaxes = [
    ...supplements.flatMap((line) => variants(line, command.name)),
    ...([
      "move",
      "emote",
      "batch",
      "help",
      "brief",
      "readiness",
      "evolve",
      "ls",
      "quest",
      "ops",
      "productivity",
      "provenance",
      "reflect",
      "probe",
      "watch",
      "rank",
    ].includes(command.name)
      ? []
      : helpSyntax(command)),
  ];
  const unique = [...new Set(syntaxes)].filter(
    (line) => !/\.\.\.$/.test(line) || /\[args\.\.\.\]$/.test(line),
  );
  // Summary rows with a generic [args] lose to the detailed handler usage.
  const forms = (unique.length ? unique : [command.name]).map(parseCommandForm);
  const precise = new Set(
    [...supplements, ...helpSyntax(command, false)]
      .filter((line) => !/[a-z]\|[a-z]/.test(line))
      .flatMap((line) => variants(line, command.name)),
  );
  return forms
    .filter((form) => {
      const stem = form.syntax.split(/[<[]/)[0]!.trim();
      if (
        form.fields.some((f) => /^args\.?/.test(f.placeholder)) ||
        (form.fields.length === 0 && !precise.has(form.syntax))
      ) {
        return !forms.some(
          (other) =>
            other !== form &&
            other.fields.length > 0 &&
            !other.fields.some((f) => /^args\.?/.test(f.placeholder)) &&
            other.syntax.split(/[<[]/)[0]!.trim() === stem,
        );
      }
      return true;
    })
    .sort((a, b) => a.syntax.localeCompare(b.syntax));
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
      const raw = values[f.id] ?? "";
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
