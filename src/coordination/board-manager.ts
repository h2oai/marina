import type { BoardPostRow, BoardRow, MarinaDB } from "../persistence/database";

export interface Board {
  id: string;
  name: string;
  scopeType: string;
  scopeId: string | null;
  readRank: number;
  writeRank: number;
  pinRank: number;
  createdAt: number;
}

export interface BoardPost {
  id: number;
  boardId: string;
  parentId: number | null;
  authorId: string;
  authorName: string;
  title: string;
  body: string;
  tags: string[];
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

function rowToBoard(row: BoardRow): Board {
  return {
    id: row.id,
    name: row.name,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    readRank: row.read_rank,
    writeRank: row.write_rank,
    pinRank: row.pin_rank,
    createdAt: row.created_at,
  };
}

function rowToPost(row: BoardPostRow): BoardPost {
  return {
    id: row.id,
    boardId: row.board_id,
    parentId: row.parent_id,
    authorId: row.author_id,
    authorName: row.author_name,
    title: row.title,
    body: row.body,
    tags: JSON.parse(row.tags) as string[],
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class BoardManager {
  constructor(private db: MarinaDB) {}

  createBoard(opts: {
    name: string;
    scopeType?: string;
    scopeId?: string;
    readRank?: number;
    writeRank?: number;
    pinRank?: number;
  }): Board {
    const id =
      opts.scopeType && opts.scopeId
        ? `${opts.scopeType}:${opts.scopeId}:${opts.name}`
        : `board:${opts.name}`;
    this.db.createBoard({
      id,
      name: opts.name,
      scopeType: opts.scopeType,
      scopeId: opts.scopeId,
      readRank: opts.readRank,
      writeRank: opts.writeRank,
      pinRank: opts.pinRank,
    });
    return {
      id,
      name: opts.name,
      scopeType: opts.scopeType ?? "global",
      scopeId: opts.scopeId ?? null,
      readRank: opts.readRank ?? 0,
      writeRank: opts.writeRank ?? 0,
      pinRank: opts.pinRank ?? 3,
      createdAt: Date.now(),
    };
  }

  deleteBoard(id: string): void {
    this.db.deleteBoard(id);
  }

  getBoard(id: string): Board | undefined {
    const row = this.db.getBoard(id);
    return row ? rowToBoard(row) : undefined;
  }

  getBoardByName(name: string): Board | undefined {
    const row = this.db.getBoardByName(name);
    return row ? rowToBoard(row) : undefined;
  }

  getBoardsForScope(scopeType: string, scopeId: string): Board[] {
    return this.db.getBoardsForScope(scopeType, scopeId).map(rowToBoard);
  }

  getAllBoards(): Board[] {
    return this.db.getAllBoards().map(rowToBoard);
  }

  createPost(opts: {
    boardId: string;
    authorId: string;
    authorName: string;
    title?: string;
    body: string;
    tags?: string[];
    parentId?: number;
  }): BoardPost {
    const id = this.db.createBoardPost({
      boardId: opts.boardId,
      parentId: opts.parentId,
      authorId: opts.authorId,
      authorName: opts.authorName,
      title: opts.title,
      body: opts.body,
      tags: opts.tags,
    });
    return this.getPost(id)!;
  }

  getPost(id: number): BoardPost | undefined {
    const row = this.db.getBoardPost(id);
    return row ? rowToPost(row) : undefined;
  }

  listPosts(
    boardId: string,
    opts?: { offset?: number; limit?: number; archived?: boolean },
  ): BoardPost[] {
    return this.db.listBoardPosts(boardId, opts).map(rowToPost);
  }

  searchPosts(boardId: string, query: string): BoardPost[] {
    return this.db.searchBoardPosts(boardId, query).map(rowToPost);
  }

  pinPost(postId: number): void {
    this.db.pinBoardPost(postId);
  }

  unpinPost(postId: number): void {
    this.db.unpinBoardPost(postId);
  }

  archivePost(postId: number): void {
    this.db.archiveBoardPost(postId);
  }

  vote(postId: number, entityId: string, value: 1 | -1, score?: number): void {
    this.db.voteBoardPost(postId, entityId, value, score ?? 0);
  }

  getVoteCount(postId: number): number {
    return this.db.getBoardPostVoteCount(postId);
  }

  getScores(postId: number): { entityId: string; value: number; score: number }[] {
    return this.db.getBoardPostScores(postId).map((r) => ({
      entityId: r.entity_id,
      value: r.value ?? 0,
      score: r.score,
    }));
  }

  getScoreMatrix(boardId: string): Map<number, Map<string, number>> {
    const rows = this.db.getScoreMatrix(boardId);
    const matrix = new Map<number, Map<string, number>>();
    for (const row of rows) {
      const postId = row.post_id!;
      if (!matrix.has(postId)) {
        matrix.set(postId, new Map());
      }
      matrix.get(postId)!.set(row.entity_id, row.score);
    }
    return matrix;
  }

  autoArchive(daysOld: number, minVotes: number): number {
    return this.db.autoArchiveBoardPosts(daysOld, minVotes);
  }
}
