import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";

/**
 * Verification codes for linking external adapters (Telegram/Discord) to game accounts.
 * Codes are 6-character alphanumeric strings that expire after 5 minutes.
 */

interface PendingLink {
  code: string;
  userId: string;
  entityName: string;
  createdAt: number;
}

const CODE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars (0/O, 1/I)

function generateCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

// Shared pending links map — accessible by adapters
const pendingLinks = new Map<string, PendingLink>();

/** Verify a code submitted by an external adapter. Returns user info or null. */
export function verifyLinkCode(code: string): { userId: string; entityName: string } | null {
  const upper = code.toUpperCase().trim();
  const pending = pendingLinks.get(upper);
  if (!pending) return null;

  if (Date.now() - pending.createdAt > CODE_EXPIRY_MS) {
    pendingLinks.delete(upper);
    return null;
  }

  pendingLinks.delete(upper);
  return { userId: pending.userId, entityName: pending.entityName };
}

export function linkCommand(deps: {
  getEntity: (id: EntityId) => Entity | undefined;
  db?: MarinaDB;
}): CommandDef {
  return {
    name: "link",
    aliases: [],
    help: "Link an external account (Telegram/Discord). Usage: link | link status | link unlink <adapter>",
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const sub = input.tokens[0]?.toLowerCase();

      if (!sub || sub === "code") {
        // Generate a new link code
        if (!deps.db) {
          ctx.send(input.entity, "Account linking requires a persistent server.");
          return;
        }

        const user = deps.db.getUserByName(entity.name);
        if (!user) {
          ctx.send(input.entity, "You must be a registered user to link accounts.");
          return;
        }

        // Clean expired codes for this user
        for (const [code, pending] of pendingLinks) {
          if (pending.userId === user.id && Date.now() - pending.createdAt > CODE_EXPIRY_MS) {
            pendingLinks.delete(code);
          }
        }

        const code = generateCode();
        pendingLinks.set(code, {
          code,
          userId: user.id,
          entityName: entity.name,
          createdAt: Date.now(),
        });

        const lines = [
          "\x1b[1;36mAccount Link Code\x1b[0m",
          "",
          `  Your code: \x1b[1;33m${code}\x1b[0m`,
          "",
          "  Send this code to the Marina bot on Telegram or Discord",
          "  to link your external account to your game identity.",
          "",
          "  The code expires in 5 minutes.",
        ];
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      if (sub === "status") {
        if (!deps.db) {
          ctx.send(input.entity, "Account linking requires a persistent server.");
          return;
        }
        const user = deps.db.getUserByName(entity.name);
        if (!user) {
          ctx.send(input.entity, "You must be a registered user.");
          return;
        }
        const links = deps.db.getUserLinks(user.id);
        if (links.length === 0) {
          ctx.send(input.entity, 'No linked accounts. Use "link" to generate a code.');
          return;
        }
        const lines = [
          "\x1b[1;36mLinked Accounts\x1b[0m",
          ...links.map((l) => `  \x1b[1m${l.adapter}\x1b[0m — ${l.external_id}`),
        ];
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      if (sub === "unlink") {
        const adapter = input.tokens[1]?.toLowerCase();
        if (!adapter) {
          ctx.send(input.entity, "Usage: link unlink <telegram|discord>");
          return;
        }
        if (!deps.db) {
          ctx.send(input.entity, "Account linking requires a persistent server.");
          return;
        }
        const user = deps.db.getUserByName(entity.name);
        if (!user) {
          ctx.send(input.entity, "You must be a registered user.");
          return;
        }
        const links = deps.db.getUserLinks(user.id);
        const link = links.find((l) => l.adapter === adapter);
        if (!link) {
          ctx.send(input.entity, `No ${adapter} account is linked.`);
          return;
        }
        deps.db.unlinkAdapter(adapter, link.external_id);
        ctx.send(input.entity, `Unlinked ${adapter} account.`);
        return;
      }

      ctx.send(input.entity, "Usage: link | link status | link unlink <adapter>");
    },
  };
}
