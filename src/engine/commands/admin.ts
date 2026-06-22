import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import type { MarinaDB } from "../../persistence/database";
import { exportState } from "../../persistence/export-import";
import type { CommandDef, Connection, Entity } from "../../types";
import { getErrorMessage } from "../errors";

const SEEDS_DIR = "seeds";
const SNAPSHOT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function sidecarPath(dbPath: string): string {
  return dbPath.endsWith(".db") ? `${dbPath.slice(0, -3)}.json` : `${dbPath}.json`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

interface AdminDeps {
  db: MarinaDB;
  dbPath?: string;
  worldName?: string;
  getEntity: (id: string) => Entity | undefined;
  findEntity: (name: string) => Entity | undefined;
  getConnections: () => Map<string, Connection>;
  removeConnection: (connId: string, intent?: "transient" | "explicit") => void;
  broadcastAll: (message: string, tag?: string) => void;
  roomCount: () => number;
  entityCount: () => number;
  getUptime: () => number;
  reloadRoom?: (roomId: string) => Promise<string>;
}

export function adminCommand(deps: AdminDeps): CommandDef {
  return {
    name: "admin",
    minRank: 5,
    gate: "admin.destructive",
    help: "Admin commands. Requires rank 9 (sovereign).\nUsage: admin kick|ban|unban|bans|stats|announce|reload|export|snapshot|snapshots\n\nExamples:\n  admin kick Alice\n  admin ban Bob Griefing\n  admin stats\n  admin announce Server restart in 5 minutes\n  admin snapshot default-v1              — clone live DB to seeds/default-v1.db\n  admin snapshot default-v1 --force      — overwrite existing snapshot\n  admin snapshot gen-2 --compact         — clone + prune compaction-chaff before serializing\n  admin snapshots                        — list saved seed snapshots",
    handler(ctx, input) {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const sub = input.tokens[0]?.toLowerCase();
      if (!sub) {
        ctx.send(input.entity, "Usage: admin <kick|ban|unban|stats|announce|reload|export> [args]");
        return;
      }

      switch (sub) {
        case "kick": {
          const targetName = input.tokens[1];
          if (!targetName) {
            ctx.send(input.entity, "Usage: admin kick <entity>");
            return;
          }
          const target = deps.findEntity(targetName);
          if (!target) {
            ctx.send(input.entity, `Entity "${targetName}" not found.`);
            return;
          }
          // Find their connection and disconnect
          const conns = deps.getConnections();
          for (const [connId, conn] of conns) {
            if (conn.entity === target.id) {
              conn.send({
                kind: "system",
                timestamp: Date.now(),
                data: { text: "You have been kicked by an admin." },
              });
              deps.removeConnection(connId, "explicit");
              ctx.send(input.entity, `Kicked ${target.name}.`);
              deps.broadcastAll(`${target.name} has been kicked.`);
              return;
            }
          }
          ctx.send(input.entity, `Could not find connection for ${target.name}.`);
          break;
        }

        case "ban": {
          const targetName = input.tokens[1];
          if (!targetName) {
            ctx.send(input.entity, "Usage: admin ban <entity> [reason]");
            return;
          }
          const reason = input.tokens.slice(2).join(" ") || "No reason given";

          // Kick if online
          const target = deps.findEntity(targetName);
          if (target) {
            const conns = deps.getConnections();
            for (const [connId, conn] of conns) {
              if (conn.entity === target.id) {
                conn.send({
                  kind: "system",
                  timestamp: Date.now(),
                  data: { text: `You have been banned: ${reason}` },
                });
                deps.removeConnection(connId, "explicit");
                break;
              }
            }
          }

          deps.db.addBan(targetName, entity.name, reason);
          ctx.send(input.entity, `Banned ${targetName}: ${reason}`);
          deps.broadcastAll(`${targetName} has been banned.`);
          break;
        }

        case "unban": {
          const targetName = input.tokens[1];
          if (!targetName) {
            ctx.send(input.entity, "Usage: admin unban <entity>");
            return;
          }
          if (deps.db.removeBan(targetName)) {
            ctx.send(input.entity, `Unbanned ${targetName}.`);
          } else {
            ctx.send(input.entity, `${targetName} is not banned.`);
          }
          break;
        }

        case "bans": {
          const bans = deps.db.listBans();
          if (bans.length === 0) {
            ctx.send(input.entity, "No active bans.");
            return;
          }
          const lines = bans.map(
            (b) => `  ${b.name} — by ${b.banned_by}: ${b.reason || "(no reason)"}`,
          );
          ctx.send(input.entity, `Active bans (${bans.length}):\n${lines.join("\n")}`);
          break;
        }

        case "stats": {
          const uptime = deps.getUptime();
          const hours = Math.floor(uptime / 3600000);
          const mins = Math.floor((uptime % 3600000) / 60000);
          const onlineCount = deps.getConnections().size;
          const lines = [
            "Server Stats:",
            `  Rooms: ${deps.roomCount()}`,
            `  Entities: ${deps.entityCount()}`,
            `  Online connections: ${onlineCount}`,
            `  Uptime: ${hours}h ${mins}m`,
          ];
          ctx.send(input.entity, lines.join("\n"));
          break;
        }

        case "announce": {
          const message = input.tokens.slice(1).join(" ");
          if (!message) {
            ctx.send(input.entity, "Usage: admin announce <message>");
            return;
          }
          deps.broadcastAll(`[ADMIN] ${message}`);
          ctx.send(input.entity, "Announcement sent.");
          break;
        }

        case "reload": {
          const roomId = input.tokens[1];
          if (!roomId) {
            ctx.send(input.entity, "Usage: admin reload <room-id>");
            return;
          }
          if (!deps.reloadRoom) {
            ctx.send(input.entity, "Room reloading is not available.");
            return;
          }
          deps.reloadRoom(roomId).then(
            (msg) => ctx.send(input.entity, msg),
            (err) => ctx.send(input.entity, `Reload failed: ${err}`),
          );
          break;
        }

        case "export": {
          const dbPath = deps.dbPath ?? "marina.db";
          const outputPath =
            input.tokens[1] ??
            `marina-export-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`;
          const skipEvents = input.tokens.includes("--skip-events");
          // Secrets (api_keys, mem_api_keys, users, connectors, gateways) are
          // omitted by default so a snapshot is safe to share; opt in explicitly.
          const includeSecrets = input.tokens.includes("--include-secrets");

          try {
            ctx.send(
              input.entity,
              `Exporting state from ${dbPath}...${includeSecrets ? " (including secrets)" : ""}`,
            );
            const snapshot = exportState(dbPath, {
              skipEventLog: skipEvents,
              includeSecrets,
              worldName: deps.worldName,
            });

            const tableNames = Object.keys(snapshot.tables);
            let totalRows = 0;
            for (const name of tableNames) {
              totalRows += snapshot.tables[name]!.length;
            }

            Bun.write(outputPath, JSON.stringify(snapshot, null, 2)).then(
              () => {
                ctx.send(
                  input.entity,
                  `Exported ${totalRows} rows (${tableNames.length} tables) to ${outputPath}`,
                );
              },
              (err) => {
                ctx.send(input.entity, `Export write failed: ${err}`);
              },
            );
          } catch (err) {
            ctx.send(input.entity, `Export failed: ${getErrorMessage(err)}`);
          }
          break;
        }

        case "snapshot": {
          const name = input.tokens[1];
          if (!name) {
            ctx.send(
              input.entity,
              "Usage: admin snapshot <name> [--force] [--compact]\n" +
                "  Clones the live DB into seeds/<name>.db via SQLite VACUUM INTO.\n" +
                "  --compact drops transient compaction-summary notes + stale activity\n" +
                "            before serializing (never touches the live DB).\n" +
                "  Promote by restarting with DB_PATH=seeds/<name>.db.",
            );
            return;
          }
          if (!SNAPSHOT_NAME.test(name)) {
            ctx.send(
              input.entity,
              `Invalid snapshot name "${name}" — use [A-Za-z0-9._-], max 64 chars.`,
            );
            return;
          }
          const force = input.tokens.includes("--force");
          const compact = input.tokens.includes("--compact");
          try {
            mkdirSync(SEEDS_DIR, { recursive: true });
          } catch (err) {
            ctx.send(input.entity, `Could not create ${SEEDS_DIR}/: ${getErrorMessage(err)}`);
            return;
          }
          const targetDb = join(SEEDS_DIR, `${name}.db`);
          const targetMeta = sidecarPath(targetDb);
          const absTarget = resolve(targetDb);
          const absSource = resolve(deps.dbPath ?? "marina.db");
          if (absTarget === absSource) {
            ctx.send(input.entity, "Refusing to snapshot over the live DB.");
            return;
          }
          if (existsSync(targetDb)) {
            if (!force) {
              ctx.send(
                input.entity,
                `Snapshot seeds/${name}.db already exists. Re-run with --force to overwrite.`,
              );
              return;
            }
            try {
              unlinkSync(targetDb);
              if (existsSync(targetMeta)) unlinkSync(targetMeta);
            } catch (err) {
              ctx.send(input.entity, `Could not remove existing snapshot: ${getErrorMessage(err)}`);
              return;
            }
          }
          try {
            if (compact) {
              const stats = deps.db.snapshotCompacted(targetDb);
              const saved = stats.before.bytes - stats.after.bytes;
              const meta = {
                name,
                created_at: new Date().toISOString(),
                world: deps.worldName ?? null,
                source_db: deps.dbPath ?? "marina.db",
                compacted: true,
                counts: {
                  entities: stats.after.entities,
                  notes: stats.after.notes,
                  links: stats.after.links,
                  activity: stats.after.activity,
                },
                compaction: {
                  dropped: stats.dropped,
                  before: stats.before,
                  after: stats.after,
                  bytes_saved: saved,
                },
                bytes: stats.after.bytes,
              };
              writeFileSync(targetMeta, `${JSON.stringify(meta, null, 2)}\n`);
              ctx.send(
                input.entity,
                [
                  `Compacted snapshot written → ${targetDb}`,
                  `  size: ${formatBytes(stats.before.bytes)} → ${formatBytes(stats.after.bytes)} (saved ${formatBytes(saved)})`,
                  `  notes: ${stats.before.notes} → ${stats.after.notes} (dropped ${stats.dropped.compactionSummaries} compaction summaries)`,
                  `  links: ${stats.before.links} → ${stats.after.links} (dropped ${stats.dropped.orphanedLinks} orphans)`,
                  `  activity: ${stats.before.activity} → ${stats.after.activity} (dropped ${stats.dropped.staleActivity} stale)`,
                  `  metadata → ${targetMeta}`,
                  `  promote by restarting with DB_PATH=${targetDb}`,
                ].join("\n"),
              );
            } else {
              const counts = deps.db.snapshot(targetDb);
              const meta = {
                name,
                created_at: new Date().toISOString(),
                world: deps.worldName ?? null,
                source_db: deps.dbPath ?? "marina.db",
                counts: {
                  entities: counts.entities,
                  notes: counts.notes,
                  pools: counts.pools,
                  benchmark_runs: counts.benchmarkRuns,
                },
                bytes: counts.bytes,
              };
              writeFileSync(targetMeta, `${JSON.stringify(meta, null, 2)}\n`);
              ctx.send(
                input.entity,
                [
                  `Snapshot written → ${targetDb} (${formatBytes(counts.bytes)})`,
                  `  entities=${counts.entities}  notes=${counts.notes}  pools=${counts.pools}  benchmark_runs=${counts.benchmarkRuns}`,
                  `  metadata → ${targetMeta}`,
                  `  promote by restarting with DB_PATH=${targetDb}`,
                ].join("\n"),
              );
            }
          } catch (err) {
            ctx.send(input.entity, `Snapshot failed: ${getErrorMessage(err)}`);
          }
          break;
        }

        case "snapshots": {
          if (!existsSync(SEEDS_DIR)) {
            ctx.send(input.entity, "No snapshots yet. Create one with: admin snapshot <name>");
            return;
          }
          let files: string[];
          try {
            files = readdirSync(SEEDS_DIR)
              .filter((f) => f.endsWith(".db"))
              .sort();
          } catch (err) {
            ctx.send(input.entity, `Could not read ${SEEDS_DIR}/: ${getErrorMessage(err)}`);
            return;
          }
          if (files.length === 0) {
            ctx.send(input.entity, "No snapshots yet. Create one with: admin snapshot <name>");
            return;
          }
          const lines = ["Saved snapshots:"];
          for (const f of files) {
            const dbFile = join(SEEDS_DIR, f);
            const metaFile = sidecarPath(dbFile);
            let summary = "";
            try {
              const size = statSync(dbFile).size;
              summary = formatBytes(size);
              if (existsSync(metaFile)) {
                const meta = JSON.parse(readFileSync(metaFile, "utf8"));
                const c = meta.counts ?? {};
                const when = meta.created_at ? ` ${meta.created_at.slice(0, 19)}` : "";
                summary += `${when}  notes=${c.notes ?? "?"} runs=${c.benchmark_runs ?? "?"}`;
              }
            } catch {
              /* best-effort */
            }
            lines.push(`  ${basename(f, ".db").padEnd(24)} ${summary}`);
          }
          ctx.send(input.entity, lines.join("\n"));
          break;
        }

        default:
          ctx.send(input.entity, `Unknown admin command: ${sub}`);
      }
    },
  };
}
