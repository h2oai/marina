import { header, separator } from "../../net/ansi";
import { validateFetchUrlSync } from "../../net/url-guard";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, RoomContext } from "../../types";
import type { ConnectorRuntime } from "../connector-runtime";
import { getErrorMessage } from "../errors";
import { getRank } from "../permissions";

export function connectCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  db?: MarinaDB;
  connectorRuntime?: ConnectorRuntime;
}): CommandDef {
  return {
    name: "connect",
    aliases: ["conn"],
    minRank: 5,
    gate: "connect.manage",
    help: "Manage external MCP connectors. Usage: connect add <name> <url> | connect add <name> stdio <cmd> [args] | connect remove <name> | connect list | connect tools <name> | connect call <name> <tool> [json] | connect auth <name> bearer <token> | connect auth <name> header <key> <value>",
    handler: async (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const rank = getRank(entity);

      if (!deps.db) {
        ctx.send(input.entity, "Connectors require database support.");
        return;
      }
      const db = deps.db;
      const runtime = deps.connectorRuntime;

      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase();

      if (!sub) {
        ctx.send(input.entity, "Usage: connect add|remove|list|tools|call|auth [args]");
        return;
      }

      switch (sub) {
        case "add": {
          const name = tokens[1];
          if (!name) {
            ctx.send(
              input.entity,
              "Usage: connect add <name> <url> | connect add <name> stdio <command> [args]",
            );
            return;
          }

          if (name.length < 2 || name.length > 40) {
            ctx.send(input.entity, "Connector name must be 2-40 characters.");
            return;
          }

          // Check if already exists
          const existing = db.getConnectorByName(name);
          if (existing) {
            ctx.send(
              input.entity,
              `Connector "${name}" already exists. Use 'connect remove ${name}' first.`,
            );
            return;
          }

          const maybeStdio = tokens[2]?.toLowerCase();

          if (maybeStdio === "stdio") {
            // Stdio transport — sovereign only
            if (rank < 9) {
              ctx.send(
                input.entity,
                "Stdio connectors require sovereign rank (9). They spawn processes.",
              );
              return;
            }
            const cmd = tokens[3];
            if (!cmd) {
              ctx.send(input.entity, "Usage: connect add <name> stdio <command> [args...]");
              return;
            }
            const args = tokens.slice(4);
            const connId = `conn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            db.createConnector({
              id: connId,
              name,
              transport: "stdio",
              command: cmd,
              args: JSON.stringify(args),
              createdBy: entity.name,
            });
            ctx.logEvent?.({
              type: "coordination_change",
              resource: "connector",
              action: "create",
              entity: input.entity,
              name,
              timestamp: Date.now(),
            });

            if (runtime?.isAvailable()) {
              try {
                await runtime.addStdioServer(name, cmd, args);
                ctx.send(
                  input.entity,
                  `Connector "${name}" added (stdio: ${cmd} ${args.join(" ")}).`,
                );
              } catch (err) {
                const msg = getErrorMessage(err);
                ctx.send(input.entity, `Connector "${name}" saved but failed to connect: ${msg}`);
              }
            } else {
              ctx.send(
                input.entity,
                `Connector "${name}" saved. Runtime not available — will load on restart.`,
              );
            }
            return;
          }

          // HTTP transport
          const url = tokens[2];
          if (!url) {
            ctx.send(input.entity, "Usage: connect add <name> <url>");
            return;
          }

          try {
            new URL(url);
          } catch {
            ctx.send(input.entity, `Invalid URL: ${url}`);
            return;
          }

          // SSRF protection: block private/internal URLs
          const urlError = validateFetchUrlSync(url);
          if (urlError) {
            ctx.send(input.entity, `Blocked URL: ${urlError}`);
            return;
          }

          const connId = `conn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          db.createConnector({
            id: connId,
            name,
            transport: "http",
            url,
            createdBy: entity.name,
          });
          ctx.logEvent?.({
            type: "coordination_change",
            resource: "connector",
            action: "create",
            entity: input.entity,
            name,
            timestamp: Date.now(),
          });

          if (runtime?.isAvailable()) {
            try {
              await runtime.addHttpServer(name, url);
              ctx.send(input.entity, `Connector "${name}" added (${url}).`);
            } catch (err) {
              const msg = getErrorMessage(err);
              ctx.send(input.entity, `Connector "${name}" saved but failed to connect: ${msg}`);
            }
          } else {
            ctx.send(
              input.entity,
              `Connector "${name}" saved. Runtime not available — will load on restart.`,
            );
          }
          return;
        }

        case "remove": {
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: connect remove <name>");
            return;
          }

          const conn = db.getConnectorByName(name);
          if (!conn) {
            ctx.send(input.entity, `Connector "${name}" not found.`);
            return;
          }

          // Only owner or sovereign can remove
          if (conn.created_by !== entity.name && rank < 9) {
            ctx.send(input.entity, "You can only remove connectors you created, or be sovereign.");
            return;
          }

          if (runtime?.isAvailable()) {
            await runtime.removeServer(name);
          }
          db.deleteConnector(conn.id);
          ctx.logEvent?.({
            type: "coordination_change",
            resource: "connector",
            action: "delete",
            entity: input.entity,
            name,
            timestamp: Date.now(),
          });
          ctx.send(input.entity, `Connector "${name}" removed.`);
          return;
        }

        case "list": {
          const connectors = db.listConnectors();
          if (connectors.length === 0) {
            ctx.send(
              input.entity,
              "No connectors registered. Use 'connect add <name> <url>' to add one.",
            );
            return;
          }
          const lines = [
            header("Connectors"),
            separator(),
            ...connectors.map((c) => {
              const transport = c.transport === "stdio" ? "[stdio]" : "";
              const status = c.status !== "active" ? ` (${c.status})` : "";
              const target = c.url || c.command || "";
              return `  ${c.name} ${transport}${status} \u2014 ${target}`;
            }),
          ];
          ctx.send(input.entity, lines.join("\n"));
          return;
        }

        case "tools": {
          const name = tokens[1];
          if (!name) {
            ctx.send(input.entity, "Usage: connect tools <name>");
            return;
          }

          if (!runtime?.isAvailable()) {
            ctx.send(input.entity, "Connector runtime not available.");
            return;
          }

          try {
            const tools = await runtime.listTools(name);
            if (tools.length === 0) {
              ctx.send(input.entity, `No tools found on "${name}".`);
              return;
            }
            const lines = [
              header(`Tools on "${name}"`),
              separator(),
              ...tools.map((t) => {
                const desc = t.description ? ` \u2014 ${t.description.slice(0, 60)}` : "";
                return `  ${t.name}${desc}`;
              }),
            ];
            ctx.send(input.entity, lines.join("\n"));
          } catch (err) {
            const msg = getErrorMessage(err);
            ctx.send(input.entity, `Failed to list tools: ${msg}`);
          }
          return;
        }

        case "call": {
          const server = tokens[1];
          const tool = tokens[2];
          if (!server || !tool) {
            ctx.send(input.entity, "Usage: connect call <server> <tool> [json-args]");
            return;
          }

          if (!runtime?.isAvailable()) {
            ctx.send(input.entity, "Connector runtime not available.");
            return;
          }

          let args: Record<string, unknown> = {};
          const jsonStr = tokens.slice(3).join(" ");
          if (jsonStr) {
            try {
              args = JSON.parse(jsonStr) as Record<string, unknown>;
            } catch {
              ctx.send(
                input.entity,
                'Invalid JSON arguments. Use: connect call <server> <tool> {"key":"value"}',
              );
              return;
            }
          }

          try {
            const result = await runtime.callTool(server, tool, args, input.entity);
            const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
            const truncated = text.length > 2000 ? `${text.slice(0, 2000)}... (truncated)` : text;
            ctx.send(input.entity, truncated);
          } catch (err) {
            const msg = getErrorMessage(err);
            ctx.send(input.entity, `Call failed: ${msg}`);
          }
          return;
        }

        case "auth": {
          const name = tokens[1];
          const authType = tokens[2]?.toLowerCase();
          if (!name || !authType) {
            ctx.send(
              input.entity,
              "Usage: connect auth <name> bearer <token> | connect auth <name> header <key> <value>",
            );
            return;
          }

          const conn = db.getConnectorByName(name);
          if (!conn) {
            ctx.send(input.entity, `Connector "${name}" not found.`);
            return;
          }

          if (conn.created_by !== entity.name && rank < 9) {
            ctx.send(
              input.entity,
              "You can only set auth on connectors you created, or be sovereign.",
            );
            return;
          }

          if (authType === "bearer") {
            const token = tokens[3];
            if (!token) {
              ctx.send(input.entity, "Usage: connect auth <name> bearer <token>");
              return;
            }
            const headers = JSON.stringify({ Authorization: `Bearer ${token}` });
            db.updateConnectorAuth(conn.id, "bearer", headers);
            ctx.send(input.entity, `Set bearer auth for "${name}". Reconnect to apply.`);
          } else if (authType === "header") {
            const key = tokens[3];
            const value = tokens.slice(4).join(" ");
            if (!key || !value) {
              ctx.send(input.entity, "Usage: connect auth <name> header <key> <value>");
              return;
            }
            // Merge with existing headers
            const existing = conn.auth_data
              ? (JSON.parse(conn.auth_data) as Record<string, string>)
              : {};
            existing[key] = value;
            db.updateConnectorAuth(conn.id, "header", JSON.stringify(existing));
            ctx.send(input.entity, `Set header "${key}" for "${name}". Reconnect to apply.`);
          } else {
            ctx.send(input.entity, "Unknown auth type. Use: bearer, header");
          }
          return;
        }

        default:
          ctx.send(
            input.entity,
            "Unknown connect action. Use: add, remove, list, tools, call, auth",
          );
      }
    },
  };
}
