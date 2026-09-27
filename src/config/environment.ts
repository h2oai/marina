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
import { dirname } from "node:path";

export function isSecretKey(key: string): boolean {
  return ["API_KEY", "TOKEN", "PASSWORD", "SECRET", "PRIVATE_KEY", "CREDENTIAL"].some((part) =>
    key.includes(part),
  );
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

export interface SettingDescriptor {
  key: string;
  description: string;
  category: string;
  isSecret: boolean;
  type: "string" | "boolean" | "integer";
}

/** One annotated reference feeds CLI and dashboard discovery, including commented defaults. */
export function environmentCatalog(content: string): SettingDescriptor[] {
  const entries = new Map<string, SettingDescriptor>();
  let category = "General";
  let comments: string[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    const section = line.match(/^#\s*─+\s*(.+?)\s*─+$/);
    const setting = line.match(/^#?\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (section) {
      category = section[1]!;
      comments = [];
    } else if (setting) {
      const key = setting[1]!,
        value = setting[2]!.split(/\s+#/)[0]!.trim();
      if (!entries.has(key))
        entries.set(key, {
          key,
          description: comments.join(" "),
          category,
          isSecret: isSecretKey(key),
          type: /^(true|false)$/.test(value)
            ? "boolean"
            : /^\d+$/.test(value)
              ? "integer"
              : "string",
        });
      comments = [];
    } else if (line.startsWith("#")) comments.push(line.replace(/^#\s?/, ""));
    else if (!line) comments = [];
  }
  return [...entries.values()];
}
