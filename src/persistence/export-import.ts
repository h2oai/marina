import { Database } from "bun:sqlite";
import { getErrorMessage } from "../engine/errors";

// ─── Export Format ──────────────────────────────────────────────────────────

export interface MarinaSnapshot {
  format: "marina-snapshot";
  version: 1;
  schema_version: number;
  exported_at: string;
  world_name?: string;
  tables: Record<string, unknown[]>;
}

// Tables in foreign-key-safe insertion order.
// FTS virtual tables (board_posts_fts, notes_fts), sessions, and
// schema_version are excluded — they are rebuilt or irrelevant on import.
const EXPORT_TABLES = [
  "entities",
  "room_store",
  "event_log",
  "users",
  "bans",
  "adapter_links",
  "channels",
  "channel_members",
  "channel_messages",
  "boards",
  "board_posts",
  "board_votes",
  "groups_",
  "group_members",
  "tasks",
  "task_claims",
  "task_votes",
  "macros",
  "room_sources",
  "room_templates",
  "notes",
  "note_links",
  "core_memory",
  "core_memory_history",
  "memory_pools",
  "experiments",
  "experiment_participants",
  "experiment_results",
  "projects",
  "dynamic_commands",
  "dynamic_command_history",
  "connectors",
  "assets",
  "canvases",
  "canvas_nodes",
  "chronicle",
  "entity_activity",
  "meta",
  "shell_allowlist",
  "shell_log",
  "markets",
  "market_positions",
  "market_scores",
  "mem_api_keys",
] as const;

// ─── Export ─────────────────────────────────────────────────────────────────

export interface ExportOptions {
  /** Skip the event_log table (can be very large). Default: false */
  skipEventLog?: boolean;
  /** Skip connectors (may contain auth secrets). Default: false */
  skipConnectors?: boolean;
  /** Skip API key tables (api_keys, mem_api_keys) to avoid leaking secrets. Default: false */
  skipSecrets?: boolean;
  /** World name to include in the snapshot (informational). */
  worldName?: string;
}

export function exportState(dbPath: string, opts?: ExportOptions): MarinaSnapshot {
  const db = new Database(dbPath, { readonly: true });
  db.exec("PRAGMA journal_mode=WAL");

  const schemaVersion = getSchemaVersion(db);
  const tables: Record<string, unknown[]> = {};

  for (const table of EXPORT_TABLES) {
    if (opts?.skipEventLog && table === "event_log") continue;
    if (opts?.skipConnectors && table === "connectors") continue;
    if (opts?.skipSecrets && table === "mem_api_keys") continue;

    // Only export tables that exist (older schemas may lack some)
    if (!tableExists(db, table)) continue;

    const rows = db.query(`SELECT * FROM "${table}"`).all();
    if (rows.length > 0) {
      tables[table] = rows;
    }
  }

  db.close();

  return {
    format: "marina-snapshot",
    version: 1,
    schema_version: schemaVersion,
    exported_at: new Date().toISOString(),
    ...(opts?.worldName ? { world_name: opts.worldName } : {}),
    tables,
  };
}

// ─── Import ─────────────────────────────────────────────────────────────────

export interface ImportOptions {
  /** If true, merges data instead of replacing. Default: false (full replace) */
  merge?: boolean;
  /** Skip the event_log table on import. Default: false */
  skipEventLog?: boolean;
}

export interface ImportResult {
  tablesImported: number;
  rowsImported: number;
  tablesSkipped: string[];
  errors: string[];
}

export function importState(
  dbPath: string,
  snapshot: MarinaSnapshot,
  opts?: ImportOptions,
): ImportResult {
  // Validate snapshot format
  if (snapshot.format !== "marina-snapshot" || snapshot.version !== 1) {
    return {
      tablesImported: 0,
      rowsImported: 0,
      tablesSkipped: [],
      errors: ["Invalid snapshot format. Expected marina-snapshot v1."],
    };
  }

  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("PRAGMA foreign_keys=OFF"); // Disable during bulk import

  const result: ImportResult = {
    tablesImported: 0,
    rowsImported: 0,
    tablesSkipped: [],
    errors: [],
  };

  try {
    db.transaction(() => {
      // Process tables in FK-safe order
      for (const table of EXPORT_TABLES) {
        if (opts?.skipEventLog && table === "event_log") continue;

        const rows = snapshot.tables[table];
        if (!rows || rows.length === 0) continue;

        if (!tableExists(db, table)) {
          result.tablesSkipped.push(table);
          continue;
        }

        // Clear existing data unless merging
        if (!opts?.merge) {
          db.run(`DELETE FROM "${table}"`);
        }

        // Get column names from first row
        const firstRow = rows[0] as Record<string, unknown>;
        const columns = Object.keys(firstRow);

        // Verify columns exist in target table
        const tableColumns = getTableColumns(db, table);
        const validColumns = columns.filter((c) => tableColumns.includes(c));
        if (validColumns.length === 0) {
          result.tablesSkipped.push(table);
          continue;
        }

        const placeholders = validColumns.map(() => "?").join(", ");
        const colList = validColumns.map((c) => `"${c}"`).join(", ");
        const insertOrReplace = opts?.merge ? "INSERT OR REPLACE" : "INSERT";
        const stmt = db.prepare(
          `${insertOrReplace} INTO "${table}" (${colList}) VALUES (${placeholders})`,
        );

        for (const row of rows) {
          const r = row as Record<string, unknown>;
          const values = validColumns.map((c) => {
            const v = r[c];
            if (v === undefined || v === null) return null;
            if (typeof v === "string" || typeof v === "number" || typeof v === "bigint") return v;
            if (typeof v === "boolean") return v ? 1 : 0;
            return String(v);
          });
          try {
            stmt.run(...(values as (string | number | bigint | null)[]));
            result.rowsImported++;
          } catch (err) {
            result.errors.push(`${table}: ${getErrorMessage(err)}`);
          }
        }

        result.tablesImported++;
      }
    })();

    // Rebuild FTS indexes outside the transaction
    rebuildFtsIndexes(db, result);
  } catch (err) {
    result.errors.push(`Transaction failed: ${getErrorMessage(err)}`);
  } finally {
    db.exec("PRAGMA foreign_keys=ON");
    db.close();
  }

  return result;
}

// ─── Validate ───────────────────────────────────────────────────────────────

export function validateSnapshot(
  data: unknown,
): { valid: true; snapshot: MarinaSnapshot } | { valid: false; error: string } {
  if (!data || typeof data !== "object") {
    return { valid: false, error: "Snapshot must be a JSON object." };
  }

  const obj = data as Record<string, unknown>;

  if (obj.format !== "marina-snapshot") {
    return { valid: false, error: "Missing or invalid format field." };
  }

  if (obj.version !== 1) {
    return { valid: false, error: `Unsupported snapshot version: ${obj.version}` };
  }

  if (typeof obj.schema_version !== "number") {
    return { valid: false, error: "Missing schema_version." };
  }

  if (!obj.tables || typeof obj.tables !== "object") {
    return { valid: false, error: "Missing tables object." };
  }

  return { valid: true, snapshot: data as MarinaSnapshot };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getSchemaVersion(db: Database): number {
  try {
    const row = db.query("SELECT MAX(version) as version FROM schema_version").get() as {
      version: number | null;
    } | null;
    return row?.version ?? 0;
  } catch {
    return 0;
  }
}

function tableExists(db: Database, table: string): boolean {
  const row = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  return row !== null;
}

function getTableColumns(db: Database, table: string): string[] {
  const rows = db.query(`PRAGMA table_info("${table}")`).all() as {
    name: string;
  }[];
  return rows.map((r) => r.name);
}

function rebuildFtsIndexes(db: Database, result: ImportResult): void {
  // Rebuild board_posts_fts if board_posts were imported
  if (result.tablesImported > 0) {
    try {
      if (tableExists(db, "board_posts_fts")) {
        db.run("INSERT INTO board_posts_fts(board_posts_fts) VALUES('rebuild')");
      }
    } catch (err) {
      result.errors.push(`FTS rebuild (board_posts): ${getErrorMessage(err)}`);
    }

    try {
      if (tableExists(db, "notes_fts")) {
        db.run("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')");
      }
    } catch (err) {
      result.errors.push(`FTS rebuild (notes): ${getErrorMessage(err)}`);
    }
  }
}
