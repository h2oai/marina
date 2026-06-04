import type { MacroRow, MarinaDB } from "../persistence/database";
import type { EntityId } from "../types";

export interface Macro {
  id: number;
  name: string;
  authorId: string;
  command: string;
  createdAt: number;
  updatedAt: number;
}

function rowToMacro(row: MacroRow): Macro {
  return {
    id: row.id,
    name: row.name,
    authorId: row.author_id,
    command: row.command,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class MacroManager {
  constructor(
    private db: MarinaDB,
    private processCommand: (entityId: EntityId, raw: string) => void,
  ) {}

  create(name: string, authorId: string, command: string): Macro {
    const id = this.db.createMacro(name, authorId, command);
    return this.get(id)!;
  }

  update(id: number, authorId: string, command: string): boolean {
    const macro = this.get(id);
    if (!macro || macro.authorId !== authorId) return false;
    this.db.updateMacro(id, command);
    return true;
  }

  delete(id: number, authorId: string): boolean {
    const macro = this.get(id);
    if (!macro || macro.authorId !== authorId) return false;
    this.db.deleteMacro(id);
    return true;
  }

  get(id: number): Macro | undefined {
    const row = this.db.getMacro(id);
    return row ? rowToMacro(row) : undefined;
  }

  getByName(name: string, authorId: string): Macro | undefined {
    const row = this.db.getMacroByName(name, authorId);
    return row ? rowToMacro(row) : undefined;
  }

  list(authorId?: string): Macro[] {
    return this.db.listMacros(authorId).map(rowToMacro);
  }

  run(macro: Macro, entityId: EntityId): void {
    this.processCommand(entityId, macro.command);
  }
}
