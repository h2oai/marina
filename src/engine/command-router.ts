// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CommandDef, CommandHandler, CommandInput, EntityId, RoomId } from "../types";

export class CommandRouter {
  private builtins = new Map<string, CommandDef>();
  private owners = new Map<string, string>();

  /** Register a built-in command (available in every room) */
  registerBuiltin(def: CommandDef): void {
    this.registerOwned("builtin", def, true);
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
    if (previous) this.unregisterOwned(owner, previous.name);
    const owned = { ...def, aliases: def.aliases ? [...def.aliases] : undefined };
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

    const spaceIdx = trimmed.indexOf(" ");
    const verb = spaceIdx === -1 ? trimmed.toLowerCase() : trimmed.slice(0, spaceIdx).toLowerCase();
    const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
    const tokens = args ? args.split(/\s+/) : [];

    return { raw: trimmed, verb, args, tokens, entity, room };
  }

  /** Resolve a verb to a handler. Checks room commands first, then builtins. */
  resolve(verb: string, roomCommands?: Record<string, CommandHandler>): CommandHandler | undefined {
    // Room-specific commands take priority
    if (roomCommands?.[verb]) {
      return roomCommands[verb];
    }
    // Built-in commands
    const def = this.builtins.get(verb);
    return def?.handler;
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
