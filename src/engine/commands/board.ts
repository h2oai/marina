// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Board, BoardManager, BoardPost } from "../../coordination/board-manager";
import {
  bold,
  dim,
  entity as fmtEntity,
  id as fmtId,
  status as fmtStatus,
  header,
  separator,
} from "../../net/ansi";
import type { CommandDef, EngineEvent, Entity, RoomContext } from "../../types";
import { rankFloorRefusal } from "../rank-floor";

export type BoardOp = "read" | "write" | "pin";

const OP_REFUSAL: Record<BoardOp, string> = {
  read: "You don't have permission to read this board.",
  write: "You don't have permission to post on this board.",
  pin: "You don't have permission to pin posts on this board.",
};

/**
 * The one access rule for every board path. A group board is open to its
 * group's members only, in every trust profile (like group memory pools), and
 * fails closed when membership can't be checked. Rank floors go through
 * `rankFloorRefusal` (lifted under local/`open`, otherwise a challenge).
 * `hidden` marks a refusal that must read as "not found", so post ids can't
 * be used to probe a group's board.
 */
export function boardRefusal(
  entity: Entity,
  board: Board,
  op: BoardOp,
  isGroupMember?: (groupId: string, entityId: string) => boolean,
  refusal: string = OP_REFUSAL[op],
): { message: string; hidden: boolean } | undefined {
  if (
    board.scopeType === "group" &&
    !(board.scopeId && isGroupMember?.(board.scopeId, entity.id))
  ) {
    return { message: `Board "${board.name}" not found.`, hidden: true };
  }
  const floor = op === "read" ? board.readRank : op === "write" ? board.writeRank : board.pinRank;
  const message = rankFloorRefusal(entity, floor, refusal);
  return message ? { message, hidden: false } : undefined;
}

/** True when `entity` may see `board` at all (list and search filters; raises nothing). */
export function boardVisible(
  entity: Entity,
  board: Board,
  isGroupMember?: (groupId: string, entityId: string) => boolean,
): boolean {
  return (
    board.scopeType !== "group" || !!(board.scopeId && isGroupMember?.(board.scopeId, entity.id))
  );
}

export function boardCommand(
  boards: BoardManager,
  getEntity: (id: string) => Entity | undefined,
  logEvent?: (event: EngineEvent) => void,
  isGroupMember?: (groupId: string, entityId: string) => boolean,
): CommandDef {
  /** A post and its board, after the access check; sends the refusal and returns undefined. */
  const postFor = (
    ctx: RoomContext,
    entity: Entity,
    postIdStr: string,
    op: BoardOp,
  ): { post: BoardPost; board: Board } | undefined => {
    const postId = Number.parseInt(postIdStr, 10);
    const post = Number.isNaN(postId) ? undefined : boards.getPost(postId);
    const board = post ? boards.getBoard(post.boardId) : undefined;
    const refusal = post && board ? boardRefusal(entity, board, op, isGroupMember) : undefined;
    if (!post || !board || refusal?.hidden) {
      ctx.send(entity.id, `Post #${postIdStr} not found.`);
      return undefined;
    }
    if (refusal) {
      ctx.send(entity.id, refusal.message);
      return undefined;
    }
    return { post, board };
  };

  return {
    category: "Coordination",
    usage: [
      { syntax: "board archive <postId>", effect: "delete" },
      { syntax: "board create <name>", effect: "write" },
      { syntax: "board list", effect: "read" },
      { syntax: "board list [args]", effect: "read" },
      { syntax: "board pin <postId>", effect: "write" },
      { syntax: "board post <board> <title> | <body>", effect: "write" },
      { syntax: "board read <board> [postId]", effect: "read" },
      { syntax: "board reply <postId> <body>", effect: "write" },
      { syntax: "board scores <postId>", effect: "read" },
      { syntax: "board search <board> <query>", effect: "read" },
      { syntax: "board vote <postId> down [score 1-10]", effect: "write" },
      { syntax: "board vote <postId> up [score 1-10]", effect: "write" },
    ],
    name: "board",
    aliases: [],
    help: "Manage boards for async discussion.\nUsage: board list|read|post|reply|search|vote|scores|pin|archive|create\n\nExamples:\n  board post general Relay Results | Average accuracy was 73%\n  board reply 5 Was that with the training run?\n  board vote 5 up 8\n  board search general relay",
    handler: (ctx: RoomContext, input) => {
      const entity = getEntity(input.entity);
      if (!entity) return;

      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase() ?? "list";

      switch (sub) {
        case "list": {
          const all = boards.getAllBoards().filter((b) => boardVisible(entity, b, isGroupMember));
          if (all.length === 0) {
            ctx.send(input.entity, "No boards exist yet.");
            return;
          }
          const lines = [
            header("Boards"),
            separator(),
            ...all.map((b) => `  ${bold(b.name)} ${dim(`[${b.scopeType}]`)}`),
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "read": {
          const boardName = tokens[1];
          if (!boardName) {
            ctx.send(input.entity, "Usage: board read <board> [postId]");
            return;
          }

          const postId = Number.parseInt(tokens[2] ?? "", 10);
          if (!Number.isNaN(postId) && postId > 0) {
            // Read specific post: it must be on the named board, readable by the caller.
            const found = postFor(ctx, entity, String(postId), "read");
            if (!found) return;
            const { post } = found;
            if (boards.getBoardByName(boardName)?.id !== post.boardId) {
              ctx.send(input.entity, `Post #${postId} not found on ${boardName}.`);
              return;
            }
            const votes = boards.getVoteCount(postId);
            const scores = boards.getScores(postId);
            const scoredVotes = scores.filter((s) => s.score > 0);
            const avgScore =
              scoredVotes.length > 0
                ? (scoredVotes.reduce((sum, s) => sum + s.score, 0) / scoredVotes.length).toFixed(1)
                : null;
            const scorePart = avgScore ? ` | Avg Score: ${avgScore}` : "";
            const badges = [
              post.pinned ? fmtStatus("PINNED", "info") : "",
              post.archived ? fmtStatus("ARCHIVED", "warn") : "",
            ]
              .filter(Boolean)
              .join(" ");
            const lines = [
              header(`${fmtId(post.id)}: ${post.title || "(untitled)"}`),
              `By ${fmtEntity(post.authorName)} | Votes: ${votes}${scorePart} ${badges}`,
              separator(),
              post.body,
            ];
            ctx.send(input.entity, lines.join("\n"));
            return;
          }

          // List posts on board
          const board = boards.getBoardByName(boardName);
          if (!board) {
            ctx.send(input.entity, `Board "${boardName}" not found.`);
            return;
          }
          const readRefusal = boardRefusal(entity, board, "read", isGroupMember);
          if (readRefusal) {
            ctx.send(input.entity, readRefusal.message);
            return;
          }
          const posts = boards.listPosts(board.id);
          if (posts.length === 0) {
            ctx.send(input.entity, `No posts on board "${boardName}".`);
            return;
          }
          const lines = [
            header(`Board: ${boardName}`),
            separator(),
            ...posts.map((p) => {
              const pin = p.pinned ? ` ${fmtStatus("PIN", "info")}` : "";
              return `  ${fmtId(p.id)}: ${p.title || "(untitled)"} — ${fmtEntity(p.authorName)}${pin}`;
            }),
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "post": {
          // board post <board> <title> | <body>
          const boardName = tokens[1];
          if (!boardName || tokens.length < 3) {
            ctx.send(input.entity, "Usage: board post <board> <title> | <body>");
            return;
          }
          const board = boards.getBoardByName(boardName);
          if (!board) {
            ctx.send(input.entity, `Board "${boardName}" not found.`);
            return;
          }
          const writeRefusal = boardRefusal(entity, board, "write", isGroupMember);
          if (writeRefusal) {
            ctx.send(input.entity, writeRefusal.message);
            return;
          }
          const rest = tokens.slice(2).join(" ");
          const pipeIdx = rest.indexOf("|");
          let title: string;
          let body: string;
          if (pipeIdx >= 0) {
            title = rest.slice(0, pipeIdx).trim();
            body = rest.slice(pipeIdx + 1).trim();
          } else {
            title = rest;
            body = "";
          }
          const post = boards.createPost({
            boardId: board.id,
            authorId: input.entity,
            authorName: entity.name,
            title,
            body,
          });
          logEvent?.({
            type: "board_post",
            entity: input.entity,
            postId: post.id,
            boardId: board.id,
            boardName,
            title,
            body,
            timestamp: Date.now(),
          });
          ctx.send(input.entity, `Posted ${fmtId(post.id)}: "${title}" on ${bold(boardName)}.`);
          return;
        }

        case "reply": {
          // board reply <postId> <body>
          const postIdStr = tokens[1];
          if (!postIdStr || tokens.length < 3) {
            ctx.send(input.entity, "Usage: board reply <postId> <body>");
            return;
          }
          const parentId = Number.parseInt(postIdStr, 10);
          // Replying reads the thread and writes to its board.
          const found = postFor(ctx, entity, postIdStr, "read");
          if (!found) return;
          const { post: parent, board } = found;
          const writeRefusal = boardRefusal(entity, board, "write", isGroupMember);
          if (writeRefusal) {
            ctx.send(input.entity, writeRefusal.message);
            return;
          }
          const replyBody = tokens.slice(2).join(" ");
          const reply = boards.createPost({
            boardId: parent.boardId,
            authorId: input.entity,
            authorName: entity.name,
            body: replyBody,
            parentId,
          });
          logEvent?.({
            type: "board_post",
            entity: input.entity,
            postId: reply.id,
            boardId: parent.boardId,
            boardName: board.name,
            title: "",
            body: replyBody,
            parentId,
            timestamp: Date.now(),
          });
          ctx.send(input.entity, `Reply ${fmtId(reply.id)} posted to ${fmtId(parentId)}.`);
          return;
        }

        case "search": {
          const boardName = tokens[1];
          const query = tokens.slice(2).join(" ");
          if (!boardName || !query) {
            ctx.send(input.entity, "Usage: board search <board> <query>");
            return;
          }
          const board = boards.getBoardByName(boardName);
          if (!board) {
            ctx.send(input.entity, `Board "${boardName}" not found.`);
            return;
          }
          const searchRefusal = boardRefusal(entity, board, "read", isGroupMember);
          if (searchRefusal) {
            ctx.send(input.entity, searchRefusal.message);
            return;
          }
          const results = boards.searchPosts(board.id, query);
          if (results.length === 0) {
            ctx.send(input.entity, `No posts matching "${query}" on ${boardName}.`);
            return;
          }
          const lines = [
            header(`Search: "${query}" on ${boardName}`),
            separator(),
            ...results.map(
              (p) => `  ${fmtId(p.id)}: ${p.title || "(untitled)"} — ${fmtEntity(p.authorName)}`,
            ),
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "vote": {
          const postIdStr = tokens[1];
          const direction = tokens[2]?.toLowerCase();
          if (!postIdStr || !direction || !["up", "down"].includes(direction)) {
            ctx.send(input.entity, "Usage: board vote <postId> up|down [score 1-10]");
            return;
          }
          const postId = Number.parseInt(postIdStr, 10);
          if (!postFor(ctx, entity, postIdStr, "read")) return;
          const value = direction === "up" ? 1 : -1;
          let score: number | undefined;
          if (tokens[3]) {
            score = Number.parseInt(tokens[3], 10);
            if (Number.isNaN(score) || score < 1 || score > 10) {
              ctx.send(input.entity, "Score must be between 1 and 10.");
              return;
            }
          }
          boards.vote(postId, input.entity, value as 1 | -1, score);
          const scorePart = score ? ` (score: ${score})` : "";
          const newCount = boards.getVoteCount(postId);
          ctx.send(
            input.entity,
            `Voted ${direction} on #${postId}${scorePart}. Total: ${newCount}`,
          );
          return;
        }

        case "scores": {
          const postIdStr = tokens[1];
          if (!postIdStr) {
            ctx.send(input.entity, "Usage: board scores <postId>");
            return;
          }
          const postId = Number.parseInt(postIdStr, 10);
          const found = postFor(ctx, entity, postIdStr, "read");
          if (!found) return;
          const { post } = found;
          const scores = boards.getScores(postId);
          if (scores.length === 0) {
            ctx.send(input.entity, `No votes on post #${postId}.`);
            return;
          }
          const lines = [
            header(`Scores for #${postId}: ${post.title || "(untitled)"}`),
            separator(),
            ...scores.map((s) => {
              const dir = s.value > 0 ? "up" : "down";
              const scorePart = s.score > 0 ? ` | score: ${s.score}` : "";
              return `  ${s.entityId}: ${dir}${scorePart}`;
            }),
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "pin": {
          const postIdStr = tokens[1];
          if (!postIdStr) {
            ctx.send(input.entity, "Usage: board pin <postId>");
            return;
          }
          const postId = Number.parseInt(postIdStr, 10);
          const found = postFor(ctx, entity, postIdStr, "read");
          if (!found) return;
          const pinRefusal = boardRefusal(entity, found.board, "pin", isGroupMember);
          if (pinRefusal) {
            ctx.send(input.entity, pinRefusal.message);
            return;
          }
          boards.pinPost(postId);
          ctx.send(input.entity, `Pinned post #${postId}.`);
          return;
        }

        case "archive": {
          const postIdStr = tokens[1];
          if (!postIdStr) {
            ctx.send(input.entity, "Usage: board archive <postId>");
            return;
          }
          const postId = Number.parseInt(postIdStr, 10);
          const found = postFor(ctx, entity, postIdStr, "read");
          if (!found) return;
          // Archiving is the author's call, or a moderator's (the board's pin rights).
          if (found.post.authorId !== entity.id) {
            const moderate = boardRefusal(
              entity,
              found.board,
              "pin",
              isGroupMember,
              "Only the author or a board moderator can archive this post.",
            );
            if (moderate) {
              ctx.send(input.entity, moderate.message);
              return;
            }
          }
          boards.archivePost(postId);
          ctx.send(input.entity, `Archived post #${postId}.`);
          return;
        }

        case "create": {
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: board create <name>");
            return;
          }
          const existing = boards.getBoardByName(name);
          if (existing) {
            ctx.send(input.entity, `Board "${name}" already exists.`);
            return;
          }
          boards.createBoard({ name });
          logEvent?.({
            type: "coordination_change",
            resource: "board",
            action: "create",
            entity: input.entity,
            name,
            timestamp: Date.now(),
          });
          ctx.send(input.entity, `Created board "${name}".`);
          return;
        }

        default:
          ctx.send(
            input.entity,
            "Usage: board list|read|post|reply|search|vote|scores|pin|archive|create [args]",
          );
      }
    },
  };
}
