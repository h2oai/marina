import type { CommandDef, CommandHandler, CommandInput, EntityId, RoomId } from "../types";

export class CommandRouter {
  private builtins = new Map<string, CommandDef>();

  /** Register a built-in command (available in every room) */
  registerBuiltin(def: CommandDef): void {
    this.builtins.set(def.name, def);
    if (def.aliases) {
      for (const alias of def.aliases) {
        this.builtins.set(alias, def);
      }
    }
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
    const def = this.builtins.get(name);
    if (!def) return false;
    this.builtins.delete(def.name);
    if (def.aliases) {
      for (const alias of def.aliases) {
        this.builtins.delete(alias);
      }
    }
    return true;
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
