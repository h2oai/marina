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
import { refuseCommand } from "../command-response";
import { restRaw } from "../parse-input";
import { rankFloorRefusal } from "../rank-floor";

export type BoardOp = "read" | "write" | "pin";

const BOARD_SUBS: ReadonlySet<string> = new Set([
  "list",
  "read",
  "post",
  "reply",
  "search",
  "vote",
  "scores",
  "pin",
  "archive",
  "create",
]);
const BOARD_READ_ALIASES: ReadonlySet<string> = new Set(["show", "view", "history"]);
/** Verbs whose first argument is the board: `board <board> <verb> …` means `board <verb> <board> …`. */
const BOARD_FIRST_VERBS: ReadonlySet<string> = new Set(["read", "post", "search"]);
/** Verbs that take a post id, not a board; `board <board> <verb> …` gets their usage. */
const POST_ID_USAGE: Readonly<Record<string, string>> = {
  reply: "board reply <postId> <body>",
  vote: "board vote <postId> up|down [score 1-10]",
  scores: "board scores <postId>",
  pin: "board pin <postId>",
  archive: "board archive <postId>",
};
/** A title longer than this with no `|` is cut at a word, and the whole text kept as the body. */
const TITLE_MAX = 100;

/** Strip one pair of quotes wrapped around the whole text (the tokenizer keeps them). */
function unquote(text: string): string {
  const m = /^(["'“])([\s\S]*)(["'”])$/.exec(text);
  if (!m) return text;
  const [, open, inner, close] = m as unknown as [string, string, string, string];
  const pair = open === close || (open === "“" && close === "”");
  // `"a" and "b"` is two quoted phrases, not one quoted text: leave it.
  return pair && !inner.includes(close) && !inner.includes(open) ? inner.trim() : text;
}

/** A short title for a post written without `|`: the text up to TITLE_MAX, cut at a word. */
function shortTitle(text: string): string {
  if (text.length <= TITLE_MAX) return text;
  const cut = text.slice(0, TITLE_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** One line for a reply in a board listing: it has no title, so show whose post it answers. */
function replyLabel(body: string, parentId: number): string {
  const first = body.split("\n")[0]!.trim();
  return `↳ re ${fmtId(parentId)}: ${shortTitle(first).slice(0, 80)}`;
}

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
      refuseCommand(ctx, entity.id, `Post #${postIdStr} not found.`);
      return undefined;
    }
    if (refusal) {
      refuseCommand(ctx, entity.id, refusal.message);
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

      let tokens = input.tokens;
      let sub = tokens[0]?.toLowerCase() ?? "list";
      // `board show|view|history <board>` reads it; so does a bare board name
      // (`board welcome`, `board welcome 3`).
      if (BOARD_READ_ALIASES.has(sub)) sub = "read";
      else if (!BOARD_SUBS.has(sub) && boards.getBoardByName(tokens[0]!)) {
        // `board <board> <verb> …` — the order `pool <name> add` uses. Run the verb on
        // that board instead of reading it, so a post written this way is not lost.
        const verb = tokens[1]?.toLowerCase();
        const asRead = verb && (BOARD_READ_ALIASES.has(verb) || verb === "list") ? "read" : verb;
        if (asRead && BOARD_FIRST_VERBS.has(asRead)) {
          tokens = [asRead, tokens[0]!, ...tokens.slice(2)];
          sub = asRead;
        } else if (verb && POST_ID_USAGE[verb]) {
          refuseCommand(
            ctx,
            input.entity,
            `Usage: ${POST_ID_USAGE[verb]} (a post id, not the board name — \`board read ${tokens[0]}\` lists them)`,
          );
          return;
        } else if (verb && !/^\d+$/.test(verb)) {
          refuseCommand(
            ctx,
            input.entity,
            `Unknown board command "${tokens[1]}". Usage: board read|post|search ${tokens[0]} …`,
          );
          return;
        } else {
          tokens = ["read", ...tokens];
          sub = "read";
        }
      }

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
            refuseCommand(ctx, input.entity, "Usage: board read <board> [postId]");
            return;
          }

          const postId = Number.parseInt(tokens[2] ?? "", 10);
          if (!Number.isNaN(postId) && postId > 0) {
            // Read specific post: it must be on the named board, readable by the caller.
            const found = postFor(ctx, entity, String(postId), "read");
            if (!found) return;
            const { post } = found;
            if (boards.getBoardByName(boardName)?.id !== post.boardId) {
              refuseCommand(ctx, input.entity, `Post #${postId} not found on ${boardName}.`);
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
            const replies = boards
              .listPosts(post.boardId, { limit: 200 })
              .filter((p) => p.parentId === post.id)
              .reverse();
            const heading = post.parentId
              ? `${fmtId(post.id)}: reply to ${fmtId(post.parentId)}`
              : `${fmtId(post.id)}: ${post.title || "(untitled)"}`;
            const lines = [
              header(heading),
              `By ${fmtEntity(post.authorName)} | Votes: ${votes}${scorePart} ${badges}`,
              separator(),
              post.body,
              ...(replies.length
                ? [
                    "",
                    separator(),
                    `Replies (${replies.length}):`,
                    ...replies.map((r) => `${fmtId(r.id)} ${fmtEntity(r.authorName)}: ${r.body}`),
                  ]
                : []),
            ];
            ctx.send(input.entity, lines.join("\n"));
            return;
          }

          // List posts on board
          const board = boards.getBoardByName(boardName);
          if (!board) {
            refuseCommand(ctx, input.entity, `Board "${boardName}" not found.`);
            return;
          }
          const readRefusal = boardRefusal(entity, board, "read", isGroupMember);
          if (readRefusal) {
            refuseCommand(ctx, input.entity, readRefusal.message);
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
              const label =
                p.parentId && !p.title
                  ? replyLabel(p.body, p.parentId)
                  : shortTitle(p.title || "(untitled)");
              return `  ${fmtId(p.id)}: ${label} — ${fmtEntity(p.authorName)}${pin}`;
            }),
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "post": {
          // board post <board> <title> | <body>
          const boardName = tokens[1];
          if (!boardName || tokens.length < 3) {
            refuseCommand(ctx, input.entity, "Usage: board post <board> <title> | <body>");
            return;
          }
          const board = boards.getBoardByName(boardName);
          if (!board) {
            refuseCommand(ctx, input.entity, `Board "${boardName}" not found.`);
            return;
          }
          const writeRefusal = boardRefusal(entity, board, "write", isGroupMember);
          if (writeRefusal) {
            refuseCommand(ctx, input.entity, writeRefusal.message);
            return;
          }
          // `board post <board> | <title> | <body>`: a leading `|` only separates.
          // The body keeps its line breaks (`restRaw`); `tokens` is
          // `input.tokens` here (only a bare board name prepends `read`).
          const rest = restRaw(input, 2).replace(/^\|\s*/, "");
          const pipeIdx = rest.indexOf("|");
          let title: string;
          let body: string;
          if (pipeIdx >= 0) {
            title = unquote(rest.slice(0, pipeIdx).replace(/\s+/g, " ").trim());
            body = unquote(rest.slice(pipeIdx + 1).trim());
          } else {
            // No `|`: a multi-line post takes its first line as the title; a single
            // long line keeps all of its text as the body under a short title.
            const text = unquote(rest);
            const lineEnd = text.indexOf("\n");
            const first = (lineEnd >= 0 ? text.slice(0, lineEnd) : text).trim();
            if (first.length > TITLE_MAX) {
              title = shortTitle(first);
              body = text;
            } else {
              title = first;
              body = lineEnd >= 0 ? text.slice(lineEnd + 1).trim() : "";
            }
          }
          if (!title && !body) {
            refuseCommand(ctx, input.entity, "Usage: board post <board> <title> | <body>");
            return;
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
            refuseCommand(ctx, input.entity, "Usage: board reply <postId> <body>");
            return;
          }
          const parentId = Number.parseInt(postIdStr, 10);
          // Replying reads the thread and writes to its board.
          const found = postFor(ctx, entity, postIdStr, "read");
          if (!found) return;
          const { post: parent, board } = found;
          const writeRefusal = boardRefusal(entity, board, "write", isGroupMember);
          if (writeRefusal) {
            refuseCommand(ctx, input.entity, writeRefusal.message);
            return;
          }
          const replyBody = restRaw(input, 2);
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
            refuseCommand(ctx, input.entity, "Usage: board search <board> <query>");
            return;
          }
          const board = boards.getBoardByName(boardName);
          if (!board) {
            refuseCommand(ctx, input.entity, `Board "${boardName}" not found.`);
            return;
          }
          const searchRefusal = boardRefusal(entity, board, "read", isGroupMember);
          if (searchRefusal) {
            refuseCommand(ctx, input.entity, searchRefusal.message);
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
            refuseCommand(ctx, input.entity, "Usage: board vote <postId> up|down [score 1-10]");
            return;
          }
          const postId = Number.parseInt(postIdStr, 10);
          if (!postFor(ctx, entity, postIdStr, "read")) return;
          const value = direction === "up" ? 1 : -1;
          let score: number | undefined;
          if (tokens[3]) {
            score = Number.parseInt(tokens[3], 10);
            if (Number.isNaN(score) || score < 1 || score > 10) {
              refuseCommand(ctx, input.entity, "Score must be between 1 and 10.");
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
            refuseCommand(ctx, input.entity, "Usage: board scores <postId>");
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
            refuseCommand(ctx, input.entity, "Usage: board pin <postId>");
            return;
          }
          const postId = Number.parseInt(postIdStr, 10);
          const found = postFor(ctx, entity, postIdStr, "read");
          if (!found) return;
          const pinRefusal = boardRefusal(entity, found.board, "pin", isGroupMember);
          if (pinRefusal) {
            refuseCommand(ctx, input.entity, pinRefusal.message);
            return;
          }
          boards.pinPost(postId);
          ctx.send(input.entity, `Pinned post #${postId}.`);
          return;
        }

        case "archive": {
          const postIdStr = tokens[1];
          if (!postIdStr) {
            refuseCommand(ctx, input.entity, "Usage: board archive <postId>");
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
              refuseCommand(ctx, input.entity, moderate.message);
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
            refuseCommand(ctx, input.entity, "Usage: board create <name>");
            return;
          }
          const existing = boards.getBoardByName(name);
          if (existing) {
            refuseCommand(ctx, input.entity, `Board "${name}" already exists.`);
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
          refuseCommand(
            ctx,
            input.entity,
            `Unknown board subcommand or board "${tokens[0]}" (\`board list\` shows boards). Usage: board list|read|post|reply|search|vote|scores|pin|archive|create [args]`,
          );
      }
    },
  };
}
