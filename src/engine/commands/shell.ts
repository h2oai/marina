// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { dim, error as fmtError, header, separator, success } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { StorageProvider } from "../../storage/provider";
import type { CommandDef, EngineEvent, Entity, EntityId, RoomContext } from "../../types";
import { getRank } from "../permissions";
import type { ShellRuntime } from "../shell-runtime";
import { requiresPersistence } from "./command-messages";

const HELP = `Shell management and output routing.
Gated capability: earn it via \`witness request shell.exec\` or an operator grant (see \`standing\`).
Usage: shell list | shell allow <binary> | shell deny <binary>
       shell history [n] | shell log [entity] [n]
       shell scratch ls | shell scratch cat <file> | shell scratch rm <file>
       shell save note [importance] [type]
       shell save board <board> <title>
       shell save memory <key>
       shell save canvas <canvas>`;

export interface ShellDeps {
  getEntity: (id: string) => Entity | undefined;
  db?: MarinaDB;
  shellRuntime: ShellRuntime;
  storage?: StorageProvider;
  logEvent?: (event: EngineEvent) => void;
}

export function shellCommand(deps: ShellDeps): CommandDef {
  return {
    name: "shell",
    aliases: ["sh"],
    help: HELP,
    minRank: 5,
    gate: "shell.exec",
    handler: async (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;
      const eid = input.entity;
      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase();

      if (!sub) {
        ctx.send(eid, HELP);
        return;
      }

      switch (sub) {
        case "list":
          handleList(ctx, eid, deps.shellRuntime);
          return;

        case "allow": {
          const rank = getRank(entity);
          if (rank < 7) {
            ctx.send(eid, "Managing the allowlist requires steward rank (7).");
            return;
          }
          const binary = tokens[1];
          if (!binary) {
            ctx.send(eid, "Usage: shell allow <binary>");
            return;
          }
          deps.shellRuntime.allow(binary, entity.name);
          ctx.send(eid, success(`"${binary}" added to shell allowlist.`));
          return;
        }

        case "deny": {
          const rank = getRank(entity);
          if (rank < 7) {
            ctx.send(eid, "Managing the allowlist requires steward rank (7).");
            return;
          }
          const binary = tokens[1];
          if (!binary) {
            ctx.send(eid, "Usage: shell deny <binary>");
            return;
          }
          const removed = deps.shellRuntime.deny(binary);
          if (removed) {
            ctx.send(eid, success(`"${binary}" removed from shell allowlist.`));
          } else {
            ctx.send(eid, `"${binary}" was not in the allowlist.`);
          }
          return;
        }

        case "history":
          handleHistory(ctx, eid, deps.db, tokens.slice(1));
          return;

        case "log": {
          const rank = getRank(entity);
          if (rank < 7) {
            ctx.send(eid, "Viewing other entities' logs requires steward rank (7).");
            return;
          }
          handleLog(ctx, eid, deps.db, tokens.slice(1));
          return;
        }

        case "scratch":
          await handleScratch(ctx, eid, deps.shellRuntime, tokens.slice(1));
          return;

        case "save":
          await handleSave(ctx, eid, entity, deps, tokens.slice(1));
          return;

        default:
          ctx.send(eid, HELP);
      }
    },
  };
}

// ─── Subcommand Handlers ──────────────────────────────────────────────────

function handleList(ctx: RoomContext, eid: EntityId, runtime: ShellRuntime): void {
  const allowed = runtime.getAllowlist();
  if (allowed.length === 0) {
    ctx.send(eid, "No binaries in the shell allowlist.");
    return;
  }
  const lines = [header("Shell Allowlist"), separator(), ...allowed.map((b) => `  ${b}`)];
  ctx.send(eid, lines.join("\n"));
}

function handleHistory(
  ctx: RoomContext,
  eid: EntityId,
  db: MarinaDB | undefined,
  tokens: string[],
): void {
  if (!db) {
    ctx.send(eid, requiresPersistence("shell history"));
    return;
  }
  const limit = Number.parseInt(tokens[0] ?? "10", 10) || 10;
  const entries = db.getShellHistory(eid, limit);
  if (entries.length === 0) {
    ctx.send(eid, "No shell history.");
    return;
  }
  const lines = [
    header("Shell History"),
    separator(),
    ...entries.map((e) => {
      const date = new Date(e.created_at).toISOString().slice(0, 19).replace("T", " ");
      const exit = e.exit_code !== 0 ? fmtError(`[${e.exit_code}]`) : dim("[0]");
      return `  ${date} ${exit} ${e.binary} ${e.args}`;
    }),
  ];
  ctx.send(eid, lines.join("\n"));
}

function handleLog(
  ctx: RoomContext,
  eid: EntityId,
  db: MarinaDB | undefined,
  tokens: string[],
): void {
  if (!db) {
    ctx.send(eid, requiresPersistence("the shell log"));
    return;
  }
  const entityFilter = tokens[0] ?? null;
  const limit = Number.parseInt(tokens[1] ?? tokens[0] ?? "10", 10) || 10;
  const entries = db.getShellLog(entityFilter, limit);
  if (entries.length === 0) {
    ctx.send(eid, "No shell log entries.");
    return;
  }
  const lines = [
    header("Shell Log"),
    separator(),
    ...entries.map((e) => {
      const date = new Date(e.created_at).toISOString().slice(0, 19).replace("T", " ");
      const exit = e.exit_code !== 0 ? fmtError(`[${e.exit_code}]`) : dim("[0]");
      return `  ${date} ${dim(e.entity_id)} ${exit} ${e.binary} ${e.args}`;
    }),
  ];
  ctx.send(eid, lines.join("\n"));
}

async function handleScratch(
  ctx: RoomContext,
  eid: EntityId,
  runtime: ShellRuntime,
  tokens: string[],
): Promise<void> {
  const action = tokens[0]?.toLowerCase() ?? "ls";

  switch (action) {
    case "ls": {
      const files = runtime.listScratch(eid);
      if (files.length === 0) {
        ctx.send(eid, "Scratch directory is empty.");
        return;
      }
      const lines = [header("Scratch Files"), separator(), ...files.map((f) => `  ${f}`)];
      ctx.send(eid, lines.join("\n"));
      return;
    }
    case "cat": {
      const filename = tokens[1];
      if (!filename) {
        ctx.send(eid, "Usage: shell scratch cat <filename>");
        return;
      }
      const content = await runtime.readScratchFile(eid, filename);
      if (content === null) {
        ctx.send(eid, `File not found or path invalid: ${filename}`);
        return;
      }
      // Truncate for display
      const lines = content.split("\n");
      if (lines.length > 200) {
        ctx.send(eid, `${lines.slice(0, 200).join("\n")}\n... ${lines.length - 200} more lines`);
      } else if (content.length > 4096) {
        ctx.send(eid, `${content.slice(0, 4096)}\n[truncated]`);
      } else {
        ctx.send(eid, content);
      }
      return;
    }
    case "rm": {
      const filename = tokens[1];
      if (!filename) {
        ctx.send(eid, "Usage: shell scratch rm <filename>");
        return;
      }
      const deleted = runtime.deleteScratchFile(eid, filename);
      if (deleted) {
        ctx.send(eid, success(`Deleted ${filename}`));
      } else {
        ctx.send(eid, `File not found or path invalid: ${filename}`);
      }
      return;
    }
    default:
      ctx.send(eid, "Usage: shell scratch ls | shell scratch cat <file> | shell scratch rm <file>");
  }
}

async function handleSave(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: ShellDeps,
  tokens: string[],
): Promise<void> {
  const target = tokens[0]?.toLowerCase();
  const runtime = deps.shellRuntime;
  const db = deps.db;

  const lastExec = runtime.getLastExec(eid);
  if (!lastExec) {
    ctx.send(eid, "No recent shell execution to save. Run a command first.");
    return;
  }

  // Read the full output file
  const fullOutput = await runtime.readScratchFile(eid, lastExec.outputFile);
  if (fullOutput === null) {
    ctx.send(eid, "Output file not found.");
    return;
  }

  switch (target) {
    case "note": {
      if (!db) {
        ctx.send(eid, requiresPersistence("notes"));
        return;
      }
      const importance = Number.parseInt(tokens[1] ?? "5", 10) || 5;
      const noteType = tokens[2] ?? "observation";
      const noteId = db.createNote(entity.name, fullOutput, entity.room, {
        importance,
        noteType,
      });
      deps.logEvent?.({
        type: "note_created",
        entity: eid,
        noteId,
        authorName: entity.name,
        content: fullOutput,
        importance,
        noteType,
        roomId: entity.room,
        timestamp: Date.now(),
      });
      ctx.send(
        eid,
        success(`Output saved as note #${noteId} (importance: ${importance}, type: ${noteType})`),
      );
      return;
    }

    case "board": {
      if (!db) {
        ctx.send(eid, requiresPersistence("boards"));
        return;
      }
      const boardName = tokens[1];
      const title = tokens.slice(2).join(" ") || "Shell output";
      if (!boardName) {
        ctx.send(eid, "Usage: shell save board <board_name> [title]");
        return;
      }
      const board = db.getBoard(boardName);
      if (!board) {
        ctx.send(eid, `Board "${boardName}" not found.`);
        return;
      }
      const postId = db.createBoardPost({
        boardId: board.id,
        authorId: eid,
        authorName: entity.name,
        title,
        body: fullOutput,
      });
      ctx.send(eid, success(`Output posted to board "${boardName}" as "${title}" (#${postId})`));
      return;
    }

    case "memory": {
      if (!db) {
        ctx.send(eid, requiresPersistence("memory"));
        return;
      }
      const key = tokens[1];
      if (!key) {
        ctx.send(eid, "Usage: shell save memory <key>");
        return;
      }
      db.setCoreMemory(entity.name, key, fullOutput);
      ctx.send(eid, success(`Output saved to core memory key "${key}"`));
      return;
    }

    case "canvas": {
      if (!db) {
        ctx.send(eid, requiresPersistence("canvas"));
        return;
      }
      const canvasName = tokens[1] ?? "global";
      const storage = deps.storage;
      if (!storage) {
        ctx.send(eid, "Asset storage not configured.");
        return;
      }

      // Find files to upload (new files from last execution)
      const filesToUpload =
        lastExec.newFiles.length > 0 ? lastExec.newFiles : [lastExec.outputFile];

      let published = 0;
      for (const filename of filesToUpload) {
        const fileData = await runtime.readScratchFileBytes(eid, filename);
        if (!fileData) continue;

        const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")) : ".txt";
        const mime = guessMime(ext);
        const nodeType = mimeToNodeType(mime);
        if (!nodeType) continue;

        // Upload to asset storage
        const assetId = crypto.randomUUID();
        const storageKey = `${assetId}${ext}`;
        await storage.put(storageKey, fileData.data, mime);

        db.createAsset({
          id: assetId,
          entityName: entity.name,
          filename,
          mimeType: mime,
          size: fileData.size,
          storageKey,
        });

        // Publish to canvas
        let canvas = db.getCanvasByName(canvasName);
        if (!canvas) {
          const id = crypto.randomUUID();
          db.createCanvas({
            id,
            name: canvasName,
            description: "",
            creatorName: entity.name,
          });
          canvas = db.getCanvas(id)!;
        }

        const existingNodes = db.getNodesByCanvas(canvas.id);
        const maxY = existingNodes.reduce((max, n) => Math.max(max, n.y + n.height), 0);

        const nodeId = crypto.randomUUID();
        db.createNode({
          id: nodeId,
          canvasId: canvas.id,
          type: nodeType,
          x: 0,
          y: maxY + 20,
          assetId,
          data: {
            filename,
            mime,
            url: storage.resolve(storageKey),
          },
          creatorName: entity.name,
        });
        deps.logEvent?.({
          type: "canvas_publish",
          entity: eid,
          canvasId: canvas.id,
          nodeId,
          timestamp: Date.now(),
        });
        published++;
      }

      if (published > 0) {
        ctx.send(eid, success(`Published ${published} file(s) to canvas "${canvasName}"`));
      } else {
        ctx.send(eid, "No publishable files found from last execution.");
      }
      return;
    }

    default:
      ctx.send(eid, "Usage: shell save note|board|memory|canvas [args...]");
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function guessMime(ext: string): string {
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".pdf": "application/pdf",
    ".json": "application/json",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".html": "text/html",
    ".csv": "text/csv",
    ".xml": "text/xml",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".sh": "text/plain",
    ".py": "text/plain",
    ".ts": "text/plain",
    ".js": "text/plain",
  };
  return map[ext.toLowerCase()] ?? "application/octet-stream";
}

function mimeToNodeType(mime: string): string | null {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("text/")) return "text";
  if (mime === "application/json") return "text";
  return "document";
}
