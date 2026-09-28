// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const SECRET_KEY_PARTS = [
  "API_KEY",
  "PASSWORD",
  "SECRET",
  "PRIVATE_KEY",
  "SIGNING_KEY",
  "CREDENTIAL",
];

/**
 * True for keys whose value must never be displayed. `TOKEN` counts only as a
 * whole trailing word (`TOKEN`, `*_TOKEN`), so budgets such as `*_MAX_TOKENS`
 * and ratios such as `*_PER_TOKEN` stay visible. OTLP `*_HEADERS` carry
 * collector credentials.
 */
export function isSecretKey(key: string): boolean {
  if (SECRET_KEY_PARTS.some((part) => key.includes(part))) return true;
  if (key === "TOKEN" || (key.endsWith("_TOKEN") && !key.endsWith("_PER_TOKEN"))) return true;
  return key.endsWith("_HEADERS");
}

export function parseEnvironment(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2]!.trim();
    const quote = value[0];
    if (quote && ["'", '"', "`"].includes(quote)) {
      const quoted = value.match(/^(['"`])(.*?)\1\s*(?:#.*)?$/);
      if (!quoted) throw new Error(`Invalid quoted value for ${match[1]}`);
      value = quoted[2]!.replace(/\\\$/g, "$");
    } else value = value.replace(/\s+#.*$/, "").trim();
    values[match[1]!] = value;
  }
  return values;
}

export function encodeEnvironmentValue(value: string): string {
  if (/\r|\n|\0/.test(value)) throw new Error("Environment values must be a single line");
  if (/^[\w./:@,+-]*$/.test(value)) return value;
  const quote = ["'", '"', "`"].find((candidate) => !value.includes(candidate));
  if (!quote)
    throw new Error(
      "Environment values containing all three quote delimiters must be supplied by the process environment",
    );
  return `${quote}${value.replace(/\$/g, "\\$")}${quote}`;
}

/** Preserve comments and every unrelated setting; replace all occurrences of changed keys. */
export function mergeEnvironment(content: string, changes: Record<string, string | null>): string {
  const remaining = new Set(Object.keys(changes));
  const lines = content
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/);
      if (!match || !Object.hasOwn(changes, match[1]!)) return line;
      remaining.delete(match[1]!);
      if (changes[match[1]!] === null) return undefined;
      return `${match[1]}=${encodeEnvironmentValue(changes[match[1]!]!)}`;
    })
    .filter((line): line is string => line !== undefined);
  for (const key of remaining) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`Invalid environment key: ${key}`);
    if (changes[key] === null) continue;
    lines.push(`${key}=${encodeEnvironmentValue(changes[key]!)}`);
  }
  return `${lines.join("\n").trim()}\n`;
}

export function writeEnvironment(path: string, changes: Record<string, string | null>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const content = existsSync(path)
    ? readFileSync(path, "utf8")
    : "# Marina instance configuration\n";
  const next = mergeEnvironment(content, changes);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, next, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** The complete annotated catalog, relative to the repository/package root. */
export const ENVIRONMENT_REFERENCE_PATH = "config/environment.reference";

/** Read the packaged environment reference, or "" when it is not shipped. */
export function readEnvironmentReference(root: string): string {
  try {
    return readFileSync(join(root, ENVIRONMENT_REFERENCE_PATH), "utf8");
  } catch {
    return "";
  }
}

export interface SettingDescriptor {
  key: string;
  description: string;
  category: string;
  isSecret: boolean;
  type: "string" | "boolean" | "integer";
  /** The documented default or safe example value (text after `=`). */
  example: string;
  /** `@protected`: the dashboard must never write it. */
  protected: boolean;
  /** `@internal`: set by Marina or read only by a client; hidden from the editor. */
  internal: boolean;
  /** `@restart`: read once at startup. */
  restart: boolean;
}

const SETTING_TAGS = new Set(["protected", "internal", "restart"]);

/**
 * Parse the annotated reference. A section is `# ── Title ──` or a
 * `# ────` / `# Title` / `# ────` block (bare rule lines are never a category).
 * A comment block describes every `# KEY=value` line directly below it; a blank
 * line or a bare `#` ends the block. `# @tag` lines inside a block apply to the
 * whole group, and a trailing `# note` on a key line is appended to its
 * description.
 */
export function environmentCatalog(content: string): SettingDescriptor[] {
  const entries = new Map<string, SettingDescriptor>();
  let category = "General";
  let comments: string[] = [];
  let tags = new Set<string>();
  let inGroup = false;
  // Three-line headers: 0 = none, 1 = opening rule seen, 2 = title seen.
  let header = 0;
  const reset = () => {
    comments = [];
    tags = new Set();
    inGroup = false;
  };
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    const text = line.startsWith("#") ? line.replace(/^#\s?/, "").trim() : "";
    const rule = /^#\s*─{3,}\s*$/.test(line);
    const section = line.match(/^#\s*─+\s*([^─\s].*?)\s*─+$/);
    const setting = line.match(/^#?\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (rule) {
      header = header === 2 ? 0 : 1;
      reset();
      continue;
    }
    if (header === 1 && text && !setting) {
      category = text;
      header = 2;
      reset();
      continue;
    }
    header = 0;
    if (section) {
      category = section[1]!;
      reset();
    } else if (setting) {
      inGroup = true;
      const key = setting[1]!;
      const [valuePart, ...note] = setting[2]!.split(/\s+#\s?/);
      const value = valuePart!.trim();
      const inline = note.join(" ").trim();
      if (!entries.has(key))
        entries.set(key, {
          key,
          description: [comments.join(" "), inline].filter(Boolean).join(" — "),
          category,
          isSecret: isSecretKey(key),
          type: /^(true|false)$/.test(value)
            ? "boolean"
            : /^\d+$/.test(value)
              ? "integer"
              : "string",
          example: value,
          protected: tags.has("protected"),
          internal: tags.has("internal"),
          restart: tags.has("restart"),
        });
    } else if (line.startsWith("#")) {
      // A bare `#` ends the block; a comment after a key group starts a new one.
      if (!text || inGroup) reset();
      if (!text) continue;
      const tagLine = text.match(/^@[a-z]+(?:\s+@[a-z]+)*$/);
      if (tagLine) {
        for (const tag of text.split(/\s+/)) {
          const name = tag.slice(1);
          if (SETTING_TAGS.has(name)) tags.add(name);
        }
      } else comments.push(text);
    } else if (!line) reset();
  }
  return [...entries.values()];
}
