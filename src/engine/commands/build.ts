import { error as fmtError, header, separator, success } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type {
  CommandDef,
  CommandInput,
  Entity,
  EntityId,
  RoomContext,
  RoomId,
  RoomModule,
} from "../../types";
import { getErrorMessage } from "../errors";
import { int, rest, token } from "../parse-input";
import { getRank } from "../permissions";
import {
  compileCommandModule,
  compileRoomModule,
  DEFAULT_COMMAND_SOURCE,
  validateCommandSource,
  validateRoomSource,
} from "../sandbox";

export interface BuildDeps {
  getEntity: (id: string) => Entity | undefined;
  db: MarinaDB;
  getRoom: (id: RoomId) => { id: RoomId; module: RoomModule } | undefined;
  registerRoom: (id: RoomId, module: RoomModule) => void;
  replaceRoom: (id: RoomId, module: RoomModule) => void;
  entitiesInRoom: (room: RoomId) => Entity[];
  registerCommand?: (def: CommandDef) => void;
  unregisterCommand?: (name: string) => boolean;
  isBuiltinCommand?: (name: string) => boolean;
  clearSandboxMetrics?: (roomId: string) => void;
}

type SubHandler = (
  ctx: RoomContext,
  input: CommandInput,
  entity: Entity,
  rank: number,
  deps: BuildDeps,
) => void | Promise<void>;

/** Emit a coordination_change so the dashboard's Commands list refreshes live. */
function emitCommandChange(
  ctx: RoomContext,
  entity: EntityId,
  action: "create" | "update" | "delete",
  name: string,
): void {
  ctx.logEvent?.({
    type: "coordination_change",
    resource: "command",
    action,
    entity,
    name,
    timestamp: Date.now(),
  });
}

// ─── Room subcommands ─────────────────────────────────────────────────────────

function handleRoom(
  ctx: RoomContext,
  input: CommandInput,
  entity: Entity,
  _rank: number,
  deps: BuildDeps,
): void {
  const roomIdStr = token(input, 1);
  if (!roomIdStr) {
    ctx.send(input.entity, "Usage: build room <id> [short description]");
    return;
  }
  const newRoomId = roomIdStr as RoomId;
  if (deps.getRoom(newRoomId)) {
    ctx.send(input.entity, `Room "${roomIdStr}" already exists.`);
    return;
  }

  const short = rest(input, 2) || "An empty room";
  const module: RoomModule = {
    short,
    long: "This room has not been described yet.",
    exits: {},
    items: {},
  };

  deps.registerRoom(newRoomId, module);
  const source = generateRoomSource(module);
  deps.db.saveRoomSource({
    roomId: roomIdStr,
    source,
    authorId: input.entity,
    authorName: entity.name,
    valid: true,
  });
  ctx.send(input.entity, `Created room "${roomIdStr}" with short: "${short}".`);
}

function handleModify(
  ctx: RoomContext,
  input: CommandInput,
  entity: Entity,
  _rank: number,
  deps: BuildDeps,
): void {
  const tokens = input.tokens;
  const FIELDS = ["short", "long", "item"];
  const firstIsField = FIELDS.includes(tokens[1]?.toLowerCase() ?? "");
  const targetRoomId = !firstIsField && tokens.length >= 4 ? tokens[1]! : (entity.room as string);
  const fieldIdx = !firstIsField && tokens.length >= 4 ? 2 : 1;
  const field = tokens[fieldIdx]?.toLowerCase();
  const value = tokens.slice(fieldIdx + 1).join(" ");

  if (!field || !value) {
    ctx.send(
      input.entity,
      "Usage: build modify [room] <short|long|item> <value>\n  build modify short A new description\n  build modify long A longer description...\n  build modify item <key> <description>",
    );
    return;
  }

  const room = deps.getRoom(targetRoomId as RoomId);
  if (!room) {
    ctx.send(input.entity, `Room "${targetRoomId}" not found.`);
    return;
  }

  if (field === "short") {
    room.module.short = value;
  } else if (field === "long") {
    if (typeof room.module.long === "string") {
      room.module.long = value;
    } else {
      ctx.send(input.entity, "Cannot modify a dynamic long description.");
      return;
    }
  } else if (field === "item") {
    const itemKey = tokens[fieldIdx + 1];
    const itemDesc = tokens.slice(fieldIdx + 2).join(" ");
    if (!itemKey || !itemDesc) {
      ctx.send(input.entity, "Usage: build modify item <key> <description>");
      return;
    }
    if (!room.module.items) room.module.items = {};
    room.module.items[itemKey] = itemDesc;
  } else {
    ctx.send(input.entity, `Unknown field "${field}". Use: short, long, item`);
    return;
  }

  const source = generateRoomSource(room.module);
  deps.db.saveRoomSource({
    roomId: targetRoomId,
    source,
    authorId: input.entity,
    authorName: entity.name,
    valid: true,
  });
  ctx.send(input.entity, `Modified ${field} of "${targetRoomId}".`);
}

function handleLink(
  ctx: RoomContext,
  input: CommandInput,
  entity: Entity,
  _rank: number,
  deps: BuildDeps,
): void {
  const tokens = input.tokens;
  if (tokens.length < 3) {
    ctx.send(input.entity, "Usage: build link [from] <exit> <to>");
    return;
  }
  let fromId: string;
  let exitName: string;
  let toId: string;
  if (tokens.length >= 4) {
    fromId = tokens[1]!;
    exitName = tokens[2]!;
    toId = tokens[3]!;
  } else {
    fromId = entity.room as string;
    exitName = tokens[1]!;
    toId = tokens[2]!;
  }

  const fromRoom = deps.getRoom(fromId as RoomId);
  if (!fromRoom) {
    ctx.send(input.entity, `Room "${fromId}" not found.`);
    return;
  }

  if (!fromRoom.module.exits) fromRoom.module.exits = {};
  fromRoom.module.exits[exitName] = toId as RoomId;

  if (!deps.getRoom(toId as RoomId)) {
    ctx.send(
      input.entity,
      `Warning: "${toId}" does not exist yet. Exit will work once the room is built.`,
    );
  }

  const source = generateRoomSource(fromRoom.module);
  deps.db.saveRoomSource({
    roomId: fromId,
    source,
    authorId: input.entity,
    authorName: entity.name,
    valid: true,
  });
  ctx.send(input.entity, `Linked exit "${exitName}" from "${fromId}" to "${toId}".`);
}

function handleUnlink(
  ctx: RoomContext,
  input: CommandInput,
  entity: Entity,
  _rank: number,
  deps: BuildDeps,
): void {
  const tokens = input.tokens;
  if (tokens.length < 2) {
    ctx.send(input.entity, "Usage: build unlink [from] <exit>");
    return;
  }
  let fromId: string;
  let exitName: string;
  if (tokens.length >= 3) {
    fromId = tokens[1]!;
    exitName = tokens[2]!;
  } else {
    fromId = entity.room as string;
    exitName = tokens[1]!;
  }

  const fromRoom = deps.getRoom(fromId as RoomId);
  if (!fromRoom) {
    ctx.send(input.entity, `Room "${fromId}" not found.`);
    return;
  }

  if (!fromRoom.module.exits?.[exitName]) {
    ctx.send(input.entity, `No exit "${exitName}" in "${fromId}".`);
    return;
  }

  delete fromRoom.module.exits[exitName];

  const source = generateRoomSource(fromRoom.module);
  deps.db.saveRoomSource({
    roomId: fromId,
    source,
    authorId: input.entity,
    authorName: entity.name,
    valid: true,
  });
  ctx.send(input.entity, `Removed exit "${exitName}" from "${fromId}".`);
}

function handleCode(
  ctx: RoomContext,
  input: CommandInput,
  entity: Entity,
  rank: number,
  deps: BuildDeps,
): void {
  if (rank < 5) {
    ctx.send(input.entity, "You must be at least an architect (rank 5) to set room code.");
    return;
  }

  const roomIdStr = token(input, 1);
  if (!roomIdStr) {
    ctx.send(input.entity, "Usage: build code <room> <typescript source>");
    return;
  }

  const source = rest(input, 2);
  if (!source) {
    const current = deps.db.getRoomSource(roomIdStr);
    if (current) {
      ctx.send(
        input.entity,
        `${header(`Source for ${roomIdStr} (v${current.version}):`)}\n${current.source}`,
      );
    } else {
      ctx.send(input.entity, `No stored source for "${roomIdStr}".`);
    }
    return;
  }

  const validation = validateRoomSource(source);
  if (!validation.valid) {
    ctx.send(input.entity, `${fmtError("Validation failed:")}\n${validation.errors.join("\n")}`);
    return;
  }

  const version = deps.db.saveRoomSource({
    roomId: roomIdStr,
    source,
    authorId: input.entity,
    authorName: entity.name,
    valid: false,
  });
  ctx.send(
    input.entity,
    `Saved source for "${roomIdStr}" (v${version}). Use "build validate ${roomIdStr}" to check, then "build reload ${roomIdStr}" to apply.`,
  );
}

function handleValidate(
  ctx: RoomContext,
  input: CommandInput,
  entity: Entity,
  _rank: number,
  deps: BuildDeps,
): void {
  const roomIdStr = token(input, 1) ?? (entity.room as string);
  const source = deps.db.getRoomSource(roomIdStr);
  if (!source) {
    ctx.send(input.entity, `No stored source for "${roomIdStr}".`);
    return;
  }

  const validation = validateRoomSource(source.source);
  if (validation.valid) {
    deps.db.markRoomSourceValid(roomIdStr, source.version);
    ctx.send(input.entity, success(`Source for "${roomIdStr}" v${source.version} is valid.`));
  } else {
    ctx.send(
      input.entity,
      `${fmtError(`Validation failed for "${roomIdStr}" v${source.version}:`)}\n${validation.errors.join("\n")}`,
    );
  }
}

async function handleReload(
  ctx: RoomContext,
  input: CommandInput,
  entity: Entity,
  rank: number,
  deps: BuildDeps,
): Promise<void> {
  if (rank < 5) {
    ctx.send(input.entity, "You must be at least an architect (rank 5) to reload rooms.");
    return;
  }

  const roomIdStr = token(input, 1) ?? (entity.room as string);
  const source = deps.db.getRoomSource(roomIdStr);
  if (!source) {
    ctx.send(input.entity, `No stored source for "${roomIdStr}".`);
    return;
  }

  try {
    const module = await compileRoomModule(source.source);
    const rid = roomIdStr as RoomId;
    if (deps.getRoom(rid)) {
      deps.replaceRoom(rid, module);
    } else {
      deps.registerRoom(rid, module);
    }
    deps.db.markRoomSourceValid(roomIdStr, source.version);
    ctx.send(input.entity, success(`Reloaded room "${roomIdStr}" from v${source.version}.`));
  } catch (err) {
    ctx.send(input.entity, `${fmtError("Reload failed:")} ${getErrorMessage(err)}`);
  }
}

function handleDiff(
  ctx: RoomContext,
  input: CommandInput,
  entity: Entity,
  _rank: number,
  deps: BuildDeps,
): void {
  const tokens = input.tokens;
  const roomIdStr = token(input, 1) ?? (entity.room as string);
  const history = deps.db.getRoomSourceHistory(roomIdStr);
  if (history.length < 2) {
    ctx.send(input.entity, `Not enough versions to diff for "${roomIdStr}".`);
    return;
  }

  const latestVer = history[0]!.version;
  const v2Num = int(tokens[2], { min: 1 }) ?? latestVer;
  const v1Num = int(tokens[3], { min: 1 }) ?? v2Num - 1;

  const src1 = deps.db.getRoomSource(roomIdStr, v1Num);
  const src2 = deps.db.getRoomSource(roomIdStr, v2Num);
  if (!src1) {
    ctx.send(input.entity, `Version ${v1Num} not found for "${roomIdStr}".`);
    return;
  }
  if (!src2) {
    ctx.send(input.entity, `Version ${v2Num} not found for "${roomIdStr}".`);
    return;
  }

  const lines1 = src1.source.split("\n");
  const lines2 = src2.source.split("\n");
  const diffLines: string[] = [header(`Diff: ${roomIdStr} v${v1Num} → v${v2Num}`), separator()];
  const maxLen = Math.max(lines1.length, lines2.length);
  let changes = 0;
  for (let i = 0; i < maxLen; i++) {
    const l1 = lines1[i];
    const l2 = lines2[i];
    if (l1 === undefined) {
      diffLines.push(`\x1b[32m+ ${l2}\x1b[0m`);
      changes++;
    } else if (l2 === undefined) {
      diffLines.push(`\x1b[31m- ${l1}\x1b[0m`);
      changes++;
    } else if (l1 !== l2) {
      diffLines.push(`\x1b[31m- ${l1}\x1b[0m`);
      diffLines.push(`\x1b[32m+ ${l2}\x1b[0m`);
      changes++;
    }
  }
  if (changes === 0) {
    diffLines.push("  (no differences)");
  } else {
    diffLines.push(`\n  ${changes} line(s) changed`);
  }
  ctx.send(input.entity, diffLines.join("\n"));
}

function handleAudit(
  ctx: RoomContext,
  input: CommandInput,
  entity: Entity,
  _rank: number,
  deps: BuildDeps,
): void {
  const roomIdStr = token(input, 1) ?? (entity.room as string);
  const history = deps.db.getRoomSourceHistory(roomIdStr);
  if (history.length === 0) {
    ctx.send(input.entity, `No source history for "${roomIdStr}".`);
    return;
  }

  const lines = [
    header(`Source History: ${roomIdStr}`),
    separator(),
    ...history.map((h) => {
      const date = new Date(h.created_at).toISOString().slice(0, 19);
      const valid = h.valid ? success("\u2713") : fmtError("\u2717");
      return `  v${h.version} ${valid} by ${h.author_name} at ${date}`;
    }),
  ];
  ctx.send(input.entity, lines.join("\n"));
}

async function handleRevert(
  ctx: RoomContext,
  input: CommandInput,
  entity: Entity,
  rank: number,
  deps: BuildDeps,
): Promise<void> {
  if (rank < 5) {
    ctx.send(input.entity, "You must be at least an architect (rank 5) to revert rooms.");
    return;
  }

  const roomIdStr = token(input, 1);
  if (!roomIdStr) {
    ctx.send(input.entity, "Usage: build revert <room> [version]");
    return;
  }

  let targetVersion: number;
  const versionNum = int(input.tokens[2], { min: 1 });
  if (versionNum !== null) {
    targetVersion = versionNum;
  } else {
    const latest = deps.db.getLatestRoomSourceVersion(roomIdStr);
    targetVersion = latest - 1;
  }

  if (targetVersion < 1) {
    ctx.send(input.entity, "No previous version to revert to.");
    return;
  }

  const source = deps.db.getRoomSource(roomIdStr, targetVersion);
  if (!source) {
    ctx.send(input.entity, `Version ${targetVersion} not found for "${roomIdStr}".`);
    return;
  }

  try {
    const module = await compileRoomModule(source.source);
    const rid = roomIdStr as RoomId;
    if (deps.getRoom(rid)) {
      deps.replaceRoom(rid, module);
    } else {
      deps.registerRoom(rid, module);
    }

    const newVersion = deps.db.saveRoomSource({
      roomId: roomIdStr,
      source: source.source,
      authorId: input.entity,
      authorName: entity.name,
      valid: true,
    });
    ctx.send(
      input.entity,
      `Reverted "${roomIdStr}" to v${targetVersion} (saved as v${newVersion}).`,
    );
  } catch (err) {
    ctx.send(input.entity, `${fmtError("Revert failed:")} ${getErrorMessage(err)}`);
  }
}

function handleDestroy(
  ctx: RoomContext,
  input: CommandInput,
  _entity: Entity,
  rank: number,
  deps: BuildDeps,
): void {
  if (rank < 5) {
    ctx.send(input.entity, "You must be at least an architect (rank 5) to destroy rooms.");
    return;
  }

  const roomIdStr = token(input, 1);
  if (!roomIdStr) {
    ctx.send(input.entity, "Usage: build destroy <room>");
    return;
  }

  const room = deps.getRoom(roomIdStr as RoomId);
  if (!room) {
    ctx.send(input.entity, `Room "${roomIdStr}" not found.`);
    return;
  }

  const occupants = deps.entitiesInRoom(roomIdStr as RoomId);
  if (occupants.length > 0) {
    ctx.send(
      input.entity,
      `Cannot destroy "${roomIdStr}" — ${occupants.length} entities are inside.`,
    );
    return;
  }

  deps.db.deleteRoomSources(roomIdStr);
  deps.clearSandboxMetrics?.(roomIdStr);
  ctx.send(input.entity, `Destroyed room "${roomIdStr}" and its source history.`);
}

// ─── Template subcommands ─────────────────────────────────────────────────────

function handleTemplateSave(
  ctx: RoomContext,
  input: CommandInput,
  entity: Entity,
  _rank: number,
  deps: BuildDeps,
): void {
  const roomIdStr = input.tokens[2];
  const templateName = input.tokens[3];
  if (!roomIdStr || !templateName) {
    ctx.send(input.entity, "Usage: build template save <room> <name> [description]");
    return;
  }

  const source = deps.db.getRoomSource(roomIdStr);
  const description = input.tokens.slice(4).join(" ");
  if (!source) {
    const room = deps.getRoom(roomIdStr as RoomId);
    if (!room) {
      ctx.send(input.entity, `Room "${roomIdStr}" not found.`);
      return;
    }
    deps.db.saveRoomTemplate({
      name: templateName,
      source: generateRoomSource(room.module),
      authorId: input.entity,
      authorName: entity.name,
      description,
    });
  } else {
    deps.db.saveRoomTemplate({
      name: templateName,
      source: source.source,
      authorId: input.entity,
      authorName: entity.name,
      description,
    });
  }
  ctx.send(input.entity, `Saved template "${templateName}".`);
}

function handleTemplateList(
  ctx: RoomContext,
  input: CommandInput,
  _entity: Entity,
  _rank: number,
  deps: BuildDeps,
): void {
  const templates = deps.db.getAllRoomTemplates();
  if (templates.length === 0) {
    ctx.send(input.entity, "No templates saved.");
    return;
  }
  const lines = [
    header("Room Templates"),
    separator(),
    ...templates.map(
      (t) => `  ${t.name} — by ${t.author_name}${t.description ? ` (${t.description})` : ""}`,
    ),
  ];
  ctx.send(input.entity, lines.join("\n"));
}

async function handleTemplateApply(
  ctx: RoomContext,
  input: CommandInput,
  entity: Entity,
  _rank: number,
  deps: BuildDeps,
): Promise<void> {
  const templateName = input.tokens[2];
  const newRoomIdStr = input.tokens[3];
  if (!templateName || !newRoomIdStr) {
    ctx.send(input.entity, "Usage: build template apply <name> <newRoomId>");
    return;
  }

  const template = deps.db.getRoomTemplate(templateName);
  if (!template) {
    ctx.send(input.entity, `Template "${templateName}" not found.`);
    return;
  }

  if (deps.getRoom(newRoomIdStr as RoomId)) {
    ctx.send(input.entity, `Room "${newRoomIdStr}" already exists.`);
    return;
  }

  try {
    const module = await compileRoomModule(template.source);
    deps.registerRoom(newRoomIdStr as RoomId, module);
    deps.db.saveRoomSource({
      roomId: newRoomIdStr,
      source: template.source,
      authorId: input.entity,
      authorName: entity.name,
      valid: true,
    });
    ctx.send(input.entity, `Applied template "${templateName}" to create room "${newRoomIdStr}".`);
  } catch (err) {
    ctx.send(input.entity, `${fmtError("Template apply failed:")} ${getErrorMessage(err)}`);
  }
}

const TEMPLATE_DISPATCH: Record<string, SubHandler> = {
  save: handleTemplateSave,
  list: handleTemplateList,
  apply: handleTemplateApply,
};

function handleTemplate(
  ctx: RoomContext,
  input: CommandInput,
  entity: Entity,
  rank: number,
  deps: BuildDeps,
): void | Promise<void> {
  const sub = input.tokens[1]?.toLowerCase();
  const handler = sub ? TEMPLATE_DISPATCH[sub] : undefined;
  if (!handler) {
    ctx.send(input.entity, "Usage: build template save|list|apply [args]");
    return;
  }
  return handler(ctx, input, entity, rank, deps);
}

// ─── Command subcommands ──────────────────────────────────────────────────────

function handleCommandCreate(
  ctx: RoomContext,
  input: CommandInput,
  entity: Entity,
  _rank: number,
  deps: BuildDeps,
): void {
  const name = input.tokens[2]?.toLowerCase();
  if (!name) {
    ctx.send(input.entity, "Usage: build command create <name>");
    return;
  }
  if (name.length < 2 || name.length > 30) {
    ctx.send(input.entity, "Command name must be 2-30 characters.");
    return;
  }
  if (deps.db.getCommandByName(name)) {
    ctx.send(
      input.entity,
      `Command "${name}" already exists. Use 'build command code ${name}' to edit.`,
    );
    return;
  }
  if (deps.isBuiltinCommand?.(name)) {
    ctx.send(
      input.entity,
      fmtError(`Cannot create "${name}" — it conflicts with a built-in command.`),
    );
    return;
  }
  const cmdId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  deps.db.saveCommandSource({
    id: cmdId,
    name,
    source: DEFAULT_COMMAND_SOURCE.replace("mycommand", name),
    createdBy: entity.name,
  });
  emitCommandChange(ctx, input.entity, "create", name);
  ctx.send(
    input.entity,
    `Created command "${name}" with default source. Use 'build command code ${name} <source>' to set source, then 'build command reload ${name}'.`,
  );
}

function handleCommandCode(
  ctx: RoomContext,
  input: CommandInput,
  entity: Entity,
  rank: number,
  deps: BuildDeps,
): void {
  if (rank < 5) {
    ctx.send(input.entity, "You must be at least an architect (rank 5) to set command code.");
    return;
  }
  const name = input.tokens[2]?.toLowerCase();
  if (!name) {
    ctx.send(input.entity, "Usage: build command code <name> [source]");
    return;
  }
  const source = input.tokens.slice(3).join(" ");
  if (!source) {
    const current = deps.db.getCommandByName(name);
    if (current) {
      ctx.send(
        input.entity,
        `${header(`Source for command "${name}" (v${current.version}):`)}\n${current.source}`,
      );
    } else {
      ctx.send(input.entity, `Command "${name}" not found.`);
    }
    return;
  }
  const validation = validateCommandSource(source);
  if (!validation.valid) {
    ctx.send(input.entity, `${fmtError("Validation failed:")}\n${validation.errors.join("\n")}`);
    return;
  }
  const existing = deps.db.getCommandByName(name);
  if (existing) {
    deps.db.saveCommandSource({ id: existing.id, name, source, createdBy: entity.name });
  } else {
    const cmdId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    deps.db.saveCommandSource({ id: cmdId, name, source, createdBy: entity.name });
  }
  emitCommandChange(ctx, input.entity, existing ? "update" : "create", name);
  ctx.send(
    input.entity,
    `Saved source for command "${name}". Use 'build command reload ${name}' to compile and register.`,
  );
}

function handleCommandValidate(
  ctx: RoomContext,
  input: CommandInput,
  _entity: Entity,
  _rank: number,
  deps: BuildDeps,
): void {
  const name = input.tokens[2]?.toLowerCase();
  if (!name) {
    ctx.send(input.entity, "Usage: build command validate <name>");
    return;
  }
  const cmd = deps.db.getCommandByName(name);
  if (!cmd) {
    ctx.send(input.entity, `Command "${name}" not found.`);
    return;
  }
  const validation = validateCommandSource(cmd.source);
  if (validation.valid) {
    ctx.send(input.entity, success(`Command "${name}" v${cmd.version} is valid.`));
  } else {
    ctx.send(
      input.entity,
      `${fmtError(`Validation failed for "${name}" v${cmd.version}:`)}\n${validation.errors.join("\n")}`,
    );
  }
}

async function handleCommandReload(
  ctx: RoomContext,
  input: CommandInput,
  _entity: Entity,
  rank: number,
  deps: BuildDeps,
): Promise<void> {
  if (rank < 5) {
    ctx.send(input.entity, "You must be at least an architect (rank 5) to reload commands.");
    return;
  }
  const name = input.tokens[2]?.toLowerCase();
  if (!name) {
    ctx.send(input.entity, "Usage: build command reload <name>");
    return;
  }
  const cmd = deps.db.getCommandByName(name);
  if (!cmd) {
    ctx.send(input.entity, `Command "${name}" not found.`);
    return;
  }
  try {
    const compiled = await compileCommandModule(cmd.source);
    if (compiled.name !== name) {
      ctx.send(
        input.entity,
        fmtError(
          `Source exports name "${compiled.name}" but DB name is "${name}". Fix the source to match.`,
        ),
      );
      return;
    }
    deps.db.markCommandValid(name);
    emitCommandChange(ctx, input.entity, "update", name);
    if (deps.registerCommand) {
      deps.unregisterCommand?.(name);
      deps.registerCommand(compiled);
      ctx.send(input.entity, success(`Command "${name}" reloaded and registered.`));
    } else {
      ctx.send(
        input.entity,
        success(`Command "${name}" compiled successfully but registration not available.`),
      );
    }
  } catch (err) {
    ctx.send(input.entity, `${fmtError("Reload failed:")} ${getErrorMessage(err)}`);
  }
}

function handleCommandList(
  ctx: RoomContext,
  input: CommandInput,
  _entity: Entity,
  _rank: number,
  deps: BuildDeps,
): void {
  const commands = deps.db.listCommands();
  if (commands.length === 0) {
    ctx.send(input.entity, "No dynamic commands. Use 'build command create <name>' to create one.");
    return;
  }
  const lines = [
    header("Dynamic Commands"),
    separator(),
    ...commands.map((c) => {
      const valid = c.valid ? success("\u2713") : fmtError("\u2717");
      return `  ${valid} ${c.name} (v${c.version}) by ${c.created_by}`;
    }),
  ];
  ctx.send(input.entity, lines.join("\n"));
}

function handleCommandAudit(
  ctx: RoomContext,
  input: CommandInput,
  _entity: Entity,
  _rank: number,
  deps: BuildDeps,
): void {
  const name = input.tokens[2]?.toLowerCase();
  if (!name) {
    ctx.send(input.entity, "Usage: build command audit <name>");
    return;
  }
  const history = deps.db.getCommandHistory(name);
  const current = deps.db.getCommandByName(name);
  if (!current && history.length === 0) {
    ctx.send(input.entity, `No history for command "${name}".`);
    return;
  }
  const lines = [header(`Command History: ${name}`), separator()];
  if (current) {
    const valid = current.valid ? success("\u2713") : fmtError("\u2717");
    lines.push(`  v${current.version} ${valid} (current) by ${current.created_by}`);
  }
  for (const h of history) {
    const date = new Date(h.edited_at).toISOString().slice(0, 19);
    lines.push(`  v${h.version} by ${h.edited_by} at ${date}`);
  }
  ctx.send(input.entity, lines.join("\n"));
}

function handleCommandDestroy(
  ctx: RoomContext,
  input: CommandInput,
  _entity: Entity,
  rank: number,
  deps: BuildDeps,
): void {
  if (rank < 5) {
    ctx.send(input.entity, "You must be at least an architect (rank 5) to destroy commands.");
    return;
  }
  const name = input.tokens[2]?.toLowerCase();
  if (!name) {
    ctx.send(input.entity, "Usage: build command destroy <name>");
    return;
  }
  const cmd = deps.db.getCommandByName(name);
  if (!cmd) {
    ctx.send(input.entity, `Command "${name}" not found.`);
    return;
  }
  deps.unregisterCommand?.(name);
  deps.db.deleteCommand(name);
  emitCommandChange(ctx, input.entity, "delete", name);
  ctx.send(input.entity, `Command "${name}" destroyed.`);
}

const COMMAND_DISPATCH: Record<string, SubHandler> = {
  create: handleCommandCreate,
  code: handleCommandCode,
  validate: handleCommandValidate,
  reload: handleCommandReload,
  list: handleCommandList,
  audit: handleCommandAudit,
  destroy: handleCommandDestroy,
};

function handleCommand(
  ctx: RoomContext,
  input: CommandInput,
  entity: Entity,
  rank: number,
  deps: BuildDeps,
): void | Promise<void> {
  const sub = input.tokens[1]?.toLowerCase();
  const handler = sub ? COMMAND_DISPATCH[sub] : undefined;
  if (!handler) {
    ctx.send(
      input.entity,
      "Usage: build command create|code|validate|reload|list|audit|destroy <name>",
    );
    return;
  }
  return handler(ctx, input, entity, rank, deps);
}

// ─── Top-level dispatch ───────────────────────────────────────────────────────

const BUILD_DISPATCH: Record<string, SubHandler> = {
  room: handleRoom,
  modify: handleModify,
  link: handleLink,
  unlink: handleUnlink,
  code: handleCode,
  validate: handleValidate,
  reload: handleReload,
  diff: handleDiff,
  audit: handleAudit,
  revert: handleRevert,
  destroy: handleDestroy,
  template: handleTemplate,
  command: handleCommand,
};

export function buildCommand(deps: BuildDeps): CommandDef {
  return {
    name: "build",
    aliases: [],
    minRank: 4,
    help: "In-game building for rooms, templates, and dynamic commands.\nUsage: build room|modify|link|unlink|code|validate|reload|diff|audit|revert|destroy|template|command\n\nExamples:\n  build room my/garden A Quiet Garden\n  build modify my/garden long Flowers bloom in every direction.\n  build link my/garden north hub/crossroads\n  build command create weather\n  build command reload weather",
    handler: async (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const rank = getRank(entity);
      const sub = input.tokens[0]?.toLowerCase() ?? "help";
      const handler = BUILD_DISPATCH[sub];

      if (!handler) {
        ctx.send(
          input.entity,
          "Usage: build room|modify|link|unlink|code|validate|reload|diff|audit|revert|destroy|template|command [args]",
        );
        return;
      }

      return handler(ctx, input, entity, rank, deps);
    },
  };
}

// ─── Helper: Generate room source from module ────────────────────────────────

function generateRoomSource(module: RoomModule): string {
  const lines: string[] = [];
  lines.push('import type { RoomModule, RoomId } from "../../src/types";');
  lines.push("");
  lines.push("const room: RoomModule = {");
  lines.push(`  short: ${JSON.stringify(module.short)},`);

  if (typeof module.long === "string") {
    lines.push(`  long: ${JSON.stringify(module.long)},`);
  } else {
    lines.push('  long: "(dynamic)",');
  }

  if (module.exits && Object.keys(module.exits).length > 0) {
    lines.push("  exits: {");
    for (const [dir, target] of Object.entries(module.exits)) {
      lines.push(`    ${JSON.stringify(dir)}: ${JSON.stringify(target)} as RoomId,`);
    }
    lines.push("  },");
  } else {
    lines.push("  exits: {},");
  }

  if (module.items && Object.keys(module.items).length > 0) {
    lines.push("  items: {");
    for (const [key, desc] of Object.entries(module.items)) {
      if (typeof desc === "string") {
        lines.push(`    ${JSON.stringify(key)}: ${JSON.stringify(desc)},`);
      }
    }
    lines.push("  },");
  }

  lines.push("};");
  lines.push("");
  lines.push("export default room;");
  lines.push("");

  return lines.join("\n");
}
