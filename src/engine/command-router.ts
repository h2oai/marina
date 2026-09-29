// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { namedFormsForCommand } from "../sdk/named-command-forms";
import type { CommandDef, CommandHandler, CommandInput, EntityId, RoomId } from "../types";

function freezeMetadata(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeMetadata(child, seen);
  Object.freeze(value);
}

export class CommandRouter {
  readonly epoch = crypto.randomUUID();
  private registryRevision = 0;
  get revision(): number {
    return this.registryRevision;
  }
  ownerOf(name: string): string | undefined {
    return this.owners.get(name);
  }
  private builtins = new Map<string, CommandDef>();
  private owners = new Map<string, string>();

  /** Register a built-in command (available in every room) */
  registerBuiltin(def: CommandDef): void {
    this.registerOwned("builtin", { ...def, namedTools: namedFormsForCommand(def.name) }, true);
  }

  /** Validate the complete name/alias set before changing any live registration. */
  registerOwned(owner: string, def: CommandDef, replace = false): void {
    if (typeof def.name !== "string" || (def.aliases !== undefined && !Array.isArray(def.aliases)))
      throw new Error("Invalid command name or aliases");
    const names = [def.name, ...(def.aliases ?? [])];
    if (
      !owner ||
      typeof def.handler !== "function" ||
      typeof def.help !== "string" ||
      !def.help.trim() ||
      new Set(names).size !== names.length ||
      names.some(
        (name) =>
          typeof name !== "string" ||
          (!/^[a-z][a-z0-9_-]*$/.test(name) && !(owner === "builtin" && name === "?")),
      )
    )
      throw new Error("Invalid command definition or duplicate aliases");
    const previous = this.builtins.get(def.name);
    for (const name of names) {
      const existing = this.builtins.get(name);
      if (existing && !(replace && this.owners.get(name) === owner && existing.name === def.name))
        throw new Error(`Command name or alias already registered: ${name}`);
    }
    const usage = def.usage ? structuredClone(def.usage) : undefined;
    if (
      usage &&
      (!Array.isArray(usage) ||
        usage.some((entry) => {
          const syntax = typeof entry === "string" ? entry : entry?.syntax;
          return (
            typeof syntax !== "string" ||
            !(syntax === def.name || syntax.startsWith(`${def.name} `))
          );
        }))
    )
      throw new Error("Command usage must start with its registered name");
    const namedTools = def.namedTools ? structuredClone(def.namedTools) : undefined;
    const owned = {
      ...def,
      usage,
      namedTools,
      aliases: def.aliases ? [...def.aliases] : undefined,
    };
    freezeMetadata(namedTools);
    freezeMetadata(usage);
    if (owned.aliases) Object.freeze(owned.aliases);
    Object.freeze(owned);
    if (previous) this.unregisterOwned(owner, previous.name);
    this.registryRevision++;
    for (const name of names) {
      this.builtins.set(name, owned);
      this.owners.set(name, owner);
    }
  }

  unregisterOwned(owner: string, name: string): boolean {
    if (this.owners.get(name) !== owner) return false;
    const def = this.builtins.get(name)!;
    for (const key of [def.name, ...(def.aliases ?? [])]) {
      this.builtins.delete(key);
      this.owners.delete(key);
    }
    this.registryRevision++;
    return true;
  }

  removeOwner(owner: string): void {
    for (const [name, value] of this.owners) if (value === owner) this.unregisterOwned(owner, name);
  }

  /** Prefix aliases like ' for say — 'hello becomes say hello */
  private prefixAliases = new Map<string, string>();

  registerPrefixAlias(prefix: string, verb: string): void {
    this.prefixAliases.set(prefix, verb);
  }

  /** Parse raw input into a CommandInput */
  parse(raw: string, entity: EntityId, room: RoomId): CommandInput {
    const trimmed = raw.trim();

    // Handle prefix aliases (e.g., 'hello → say hello)
    for (const [prefix, verb] of this.prefixAliases) {
      if (trimmed.startsWith(prefix) && trimmed.length > prefix.length) {
        const args = trimmed.slice(prefix.length).trim();
        const tokens = args ? args.split(/\s+/) : [];
        return { raw: trimmed, verb, args, tokens, entity, room };
      }
    }

    const spaceIdx = trimmed.search(/\s/);
    const verb = spaceIdx === -1 ? trimmed.toLowerCase() : trimmed.slice(0, spaceIdx).toLowerCase();
    const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
    const tokens = args ? args.split(/\s+/) : [];

    return { raw: trimmed, verb, args, tokens, entity, room };
  }

  /** Resolve a verb to a handler. Checks room commands first, then builtins. */
  resolve(verb: string, roomCommands?: Record<string, CommandHandler>): CommandHandler | undefined {
    return this.resolveCommand(verb, roomCommands)?.handler;
  }

  /**
   * Resolve a verb to its handler AND the definition that governs it. A room
   * command shadows a builtin of the same name and carries no builtin
   * definition: the builtin's rank floor and gate belong to the builtin
   * handler, never to the room handler that replaced it. Only a room's OWN
   * keys count (`Object.hasOwn`), so `constructor`/`__proto__` never resolve.
   */
  resolveCommand(
    verb: string,
    roomCommands?: Record<string, CommandHandler>,
  ): { handler: CommandHandler; def?: CommandDef; owner: "room" | "builtin" } | undefined {
    if (roomCommands && Object.hasOwn(roomCommands, verb)) {
      const handler = roomCommands[verb];
      if (typeof handler === "function") return { handler, owner: "room" };
    }
    const def = this.builtins.get(verb);
    return def ? { handler: def.handler, def, owner: "builtin" } : undefined;
  }

  /** Get a command definition by verb */
  getDef(verb: string): CommandDef | undefined {
    return this.builtins.get(verb);
  }

  /** Unregister a command by name (removes name + its aliases) */
  unregisterBuiltin(name: string): boolean {
    return this.unregisterOwned("builtin", name);
  }

  /** Get all built-in command definitions (deduplicated, no aliases) */
  allBuiltins(): CommandDef[] {
    const seen = new Set<string>();
    const result: CommandDef[] = [];
    for (const def of this.builtins.values()) {
      if (!seen.has(def.name)) {
        seen.add(def.name);
        result.push(def);
      }
    }
    return result;
  }
}
