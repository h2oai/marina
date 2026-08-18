// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandDef, RoomModule } from "../types";

// ─── Forbidden Globals ──────────────────────────────────────────────────────

/** Globals that must never be accessed — by any syntax (dot, bracket, variable). */
const FORBIDDEN_GLOBALS = [
  "process",
  "globalThis",
  "Bun",
  "Deno",
  "__dirname",
  "__filename",
  "child_process",
  "execSync",
  "spawnSync",
  "XMLHttpRequest",
];

/** Functions that must never be called. */
const FORBIDDEN_CALLS = ["require", "import", "eval", "fetch"];

/** Dangerous property chains and meta-programming primitives. */
const FORBIDDEN_META = [
  "__proto__",
  "constructor",
  "getPrototypeOf",
  "setPrototypeOf",
  "defineProperty",
  "Reflect",
  "Proxy",
  "import.meta",
];

// Patterns checked against RAW source (not stripped) because they exploit
// string-as-code vectors where the dangerous string IS the attack payload.
const RAW_FORBIDDEN_PATTERNS: { pattern: RegExp; reason: string }[] = [
  // Constructor chain: ""["constructor"]["constructor"]("return process")()
  {
    pattern: /\["constructor"\]/,
    reason: 'Property access via ["constructor"] is forbidden',
  },
  // __proto__ manipulation (bracket or dot form)
  { pattern: /\["__proto__"\]/, reason: "__proto__ access is forbidden" },
  { pattern: /\.__proto__\b/, reason: "__proto__ access is forbidden" },
];

// ─── Validation ──────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Strip string literals and comments to avoid false positives.
 * Processes in order: line comments, block comments, then string literals.
 */
function stripLiterals(source: string): string {
  return source
    .replace(/\/\/[^\n]*/g, "") // line comments
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/"(?:[^"\\]|\\.)*"/g, '""') // double-quoted strings
    .replace(/'(?:[^'\\]|\\.)*'/g, "''") // single-quoted strings
    .replace(/`(?:[^`\\]|\\.)*`/g, "``"); // template literals
}

/**
 * Multi-layered static analysis for sandboxed code.
 *
 * Layer 1: Forbidden global/function patterns (word-boundary match)
 * Layer 2: Bracket notation bypass detection (["process"], ["eval"], etc.)
 * Layer 3: Meta-programming primitives (constructor chains, Reflect, __proto__)
 * Layer 4: Dynamic code construction (new Function, Function alias, concatenation heuristics)
 */
function validateSource(source: string, kind: "Room" | "Command"): ValidationResult {
  const errors: string[] = [];
  const stripped = stripLiterals(source);

  // Layer 1: Direct global/function access via word boundary
  for (const name of FORBIDDEN_GLOBALS) {
    if (new RegExp(`\\b${name}\\b`).test(stripped)) {
      errors.push(`Access to '${name}' is forbidden`);
    }
  }

  // require() and import() need \s*\( to match calls
  if (/\brequire\s*\(/.test(stripped)) errors.push("require() is forbidden");
  if (/\bimport\s*\(/.test(stripped)) errors.push("Dynamic import() is forbidden");
  if (/\beval\s*\(/.test(stripped)) errors.push("eval() is forbidden");
  if (/\bfetch\s*\(/.test(stripped)) errors.push("fetch() is forbidden (no network access)");
  if (/\bWebSocket\b/.test(stripped)) errors.push("WebSocket is forbidden (no network access)");
  if (/\bfs\b\.\b(writeFile|unlink|rmdir|rm|mkdir|rename)/.test(stripped)) {
    errors.push("Filesystem writes are forbidden");
  }

  // Check raw-source patterns (these exploit string-as-code vectors)
  for (const { pattern, reason } of RAW_FORBIDDEN_PATTERNS) {
    if (pattern.test(source)) {
      errors.push(reason);
    }
  }

  // Layer 2: Bracket notation bypass detection
  // Catches: global["process"], obj["require"], x["eval"], etc.
  const bracketAccess = stripped.match(/\[\s*["'`]([^"'`]+)["'`]\s*\]/g);
  if (bracketAccess) {
    const allForbidden = [...FORBIDDEN_GLOBALS, ...FORBIDDEN_CALLS, ...FORBIDDEN_META];
    for (const match of bracketAccess) {
      const inner = match.replace(/^\[\s*["'`]|["'`]\s*\]$/g, "");
      if (allForbidden.includes(inner)) {
        errors.push(`Bracket access to '${inner}' is forbidden`);
      }
    }
  }

  // Layer 3: Meta-programming and prototype chain manipulation
  for (const name of FORBIDDEN_META) {
    if (stripped.includes(name)) {
      errors.push(`Access to '${name}' is forbidden (meta-programming not allowed)`);
    }
  }

  // Layer 4: Dynamic code construction
  if (/\bnew\s+Function\b/.test(stripped)) {
    errors.push("new Function() is forbidden");
  }
  // Function aliasing: const F = Function; new F(...)
  if (/\bFunction\b/.test(stripped) && !/\bnew\s+Function\b/.test(stripped)) {
    errors.push("Direct access to 'Function' constructor is forbidden");
  }

  // String concatenation heuristics for forbidden words
  // Catches patterns like: "pro" + "cess", 'ev' + 'al', `req` + `uire`
  for (const name of [...FORBIDDEN_GLOBALS, ...FORBIDDEN_CALLS]) {
    if (name.length < 4) continue; // skip short names (high false positive risk)
    // Check for split-at-any-point concatenation: "pro" + "cess"
    for (let i = 1; i < name.length; i++) {
      const left = name.slice(0, i);
      const right = name.slice(i);
      // Match: "left" + "right" or 'left' + 'right' or `left` + `right`
      const concatPattern = new RegExp(
        `["'\`]${escapeRegex(left)}["'\`]\\s*\\+\\s*["'\`]${escapeRegex(right)}["'\`]`,
      );
      if (concatPattern.test(source)) {
        // Test against original source (not stripped) since literals are removed
        errors.push(`Detected string concatenation forming '${name}' — forbidden`);
        break;
      }
    }
  }

  // Must have a default export
  if (!source.includes("export default") && !source.includes("export =")) {
    errors.push(`${kind} source must have a default export (export default { ... })`);
  }

  return { valid: errors.length === 0, errors };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Validate room source code.
 */
export function validateRoomSource(source: string): ValidationResult {
  return validateSource(source, "Room");
}

/**
 * Validate command source code.
 */
export function validateCommandSource(source: string): ValidationResult {
  return validateSource(source, "Command");
}

// ─── Compilation ─────────────────────────────────────────────────────────────

const COMPILE_TIMEOUT_MS = 10_000; // 10 seconds

export async function compileRoomModule(source: string): Promise<RoomModule> {
  const validation = validateRoomSource(source);
  if (!validation.valid) {
    throw new SandboxError(`Validation failed:\n${validation.errors.join("\n")}`);
  }

  const tempDir = await mkdtemp(join(tmpdir(), "marina-room-"));
  const tempFile = join(tempDir, `room_${Date.now()}.ts`);

  try {
    await Bun.write(tempFile, source);

    const importPromise = import(tempFile);
    const timeoutPromise = Bun.sleep(COMPILE_TIMEOUT_MS).then(() => {
      throw new SandboxError(`Compilation timed out after ${COMPILE_TIMEOUT_MS}ms`);
    });

    const mod = await Promise.race([importPromise, timeoutPromise]);
    const room: RoomModule = mod.default ?? mod;

    validateRoomShape(room);

    return room;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function validateRoomShape(mod: unknown): asserts mod is RoomModule {
  if (!mod || typeof mod !== "object") {
    throw new SandboxError("Room module must export an object");
  }

  const obj = mod as Record<string, unknown>;

  if (typeof obj.short !== "string" || obj.short.length === 0) {
    throw new SandboxError("Room module must have a non-empty 'short' string property");
  }

  if (typeof obj.long !== "string" && typeof obj.long !== "function") {
    throw new SandboxError("Room module must have a 'long' property (string or function)");
  }

  if (obj.exits !== undefined && (typeof obj.exits !== "object" || obj.exits === null)) {
    throw new SandboxError("Room 'exits' must be an object if provided");
  }

  if (obj.items !== undefined && (typeof obj.items !== "object" || obj.items === null)) {
    throw new SandboxError("Room 'items' must be an object if provided");
  }

  if (obj.commands !== undefined && (typeof obj.commands !== "object" || obj.commands === null)) {
    throw new SandboxError("Room 'commands' must be an object if provided");
  }

  for (const fn of ["onEnter", "onLeave", "onTick"] as const) {
    if (obj[fn] !== undefined && typeof obj[fn] !== "function") {
      throw new SandboxError(`Room '${fn}' must be a function if provided`);
    }
  }
}

// ─── Error ───────────────────────────────────────────────────────────────────

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

// ─── Command Validation & Compilation ────────────────────────────────────────

export async function compileCommandModule(source: string): Promise<CommandDef> {
  const validation = validateCommandSource(source);
  if (!validation.valid) {
    throw new SandboxError(`Validation failed:\n${validation.errors.join("\n")}`);
  }

  const tempDir = await mkdtemp(join(tmpdir(), "marina-cmd-"));
  const tempFile = join(tempDir, `cmd_${Date.now()}.ts`);

  try {
    await Bun.write(tempFile, source);

    const importPromise = import(tempFile);
    const timeoutPromise = Bun.sleep(COMPILE_TIMEOUT_MS).then(() => {
      throw new SandboxError(`Compilation timed out after ${COMPILE_TIMEOUT_MS}ms`);
    });

    const mod = await Promise.race([importPromise, timeoutPromise]);
    const cmd = mod.default ?? mod;

    validateCommandShape(cmd);

    return cmd as CommandDef;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function validateCommandShape(mod: unknown): asserts mod is CommandDef {
  if (!mod || typeof mod !== "object") {
    throw new SandboxError("Command module must export an object");
  }

  const obj = mod as Record<string, unknown>;

  if (typeof obj.name !== "string" || obj.name.length === 0) {
    throw new SandboxError("Command module must have a non-empty 'name' string");
  }

  if (typeof obj.help !== "string") {
    throw new SandboxError("Command module must have a 'help' string");
  }

  if (typeof obj.handler !== "function") {
    throw new SandboxError("Command module must have a 'handler' function");
  }

  if (obj.aliases !== undefined) {
    if (!Array.isArray(obj.aliases)) {
      throw new SandboxError("Command 'aliases' must be an array if provided");
    }
  }
}

// ─── Default Command Template Source ─────────────────────────────────────────

export const DEFAULT_COMMAND_SOURCE = `/**
 * CommandContext API — available as 'ctx' in handler:
 *
 * ctx.send(entityId, message)    — send message to one entity
 * ctx.broadcast(message)         — send message to all in room
 * ctx.broadcastExcept(id, msg)   — send to all except one entity
 * ctx.getEntity(entityId)        — get entity by ID (or undefined)
 * ctx.findEntity(name)           — find entity by name (partial match)
 * ctx.entities                   — array of all entities in the room
 * ctx.roomId                     — current room ID (string property, not a function)
 * ctx.store.get(key)/set(key,v)  — room-scoped persistent key-value store
 * ctx.spawn({name,short,long})   — spawn NPC, returns EntityId
 * ctx.despawn(entityId)          — remove NPC from room
 * ctx.caller                     — { id, name, rank } of invoking entity
 * ctx.notes.recall(query)        — scored note retrieval
 * ctx.notes.add(content, importance?) — add a note
 * ctx.memory.get(key)/set(key,v) — core memory key-value
 * ctx.pool.recall(pool, query)   — recall from shared memory pool
 * ctx.pool.add(pool, content)    — add to shared memory pool
 * ctx.http.get(url)/post(url,b)  — rate-limited HTTP
 * ctx.mcp.call(server,tool,args) — call MCP tool
 *
 * input: { entity: EntityId, args: string, tokens: string[] }
 */
export default {
  name: "mycommand",
  help: "A custom command. Usage: mycommand [args]",
  handler(ctx, input) {
    ctx.send(input.entity, "Hello from mycommand! Args: " + input.args);
  },
};
`;

// ─── Default Room Template Source ────────────────────────────────────────────

export const DEFAULT_ROOM_SOURCE = `import type { RoomModule } from "../src/types";

const room: RoomModule = {
  short: "An empty room",
  long: "This room has not been described yet. A builder should use 'build modify' to set it up.",
  exits: {},
  items: {},
};

export default room;
`;
