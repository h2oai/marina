// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import type { BoardManager } from "../../coordination/board-manager";
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
import { getRank } from "../permissions";

export function boardCommand(
  boards: BoardManager,
  getEntity: (id: string) => Entity | undefined,
  logEvent?: (event: EngineEvent) => void,
): CommandDef {
  return {
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
          const all = boards.getAllBoards();
          if (all.length === 0) {
            ctx.send(input.entity, "No boards exist yet.");
            return;
          }
          const lines = [
            header("Boards"),
            separator(),
            ...all.map((b) => {
              const _posts = boards.listPosts(b.id, { limit: 0 });
              return `  ${bold(b.name)} ${dim(`[${b.scopeType}]`)}`;
            }),
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
            // Read specific post
            const post = boards.getPost(postId);
            if (!post) {
              ctx.send(input.entity, `Post #${postId} not found.`);
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
          if (getRank(entity) < board.readRank) {
            ctx.send(input.entity, "You don't have permission to read this board.");
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
          if (getRank(entity) < board.writeRank) {
            ctx.send(input.entity, "You don't have permission to post on this board.");
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
          const parent = boards.getPost(parentId);
          if (!parent) {
            ctx.send(input.entity, `Post #${postIdStr} not found.`);
            return;
          }
          const replyBody = tokens.slice(2).join(" ");
          const board = boards.getBoard(parent.boardId);
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
            boardName: board?.name ?? parent.boardId,
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
          const post = boards.getPost(postId);
          if (!post) {
            ctx.send(input.entity, `Post #${postIdStr} not found.`);
            return;
          }
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
          const post = boards.getPost(postId);
          if (!post) {
            ctx.send(input.entity, `Post #${postIdStr} not found.`);
            return;
          }
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
          const post = boards.getPost(postId);
          if (!post) {
            ctx.send(input.entity, `Post #${postIdStr} not found.`);
            return;
          }
          const board = boards.getBoard(post.boardId);
          if (board && getRank(entity) < board.pinRank) {
            ctx.send(input.entity, "You don't have permission to pin posts on this board.");
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
          const post = boards.getPost(postId);
          if (!post) {
            ctx.send(input.entity, `Post #${postIdStr} not found.`);
            return;
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
